/**
 * Vision Assistant — model loader.
 *
 * Downloads the ~649 MB LFM2.5-VL-450M Q4 ONNX model in 48 MB chunks with retry.
 * Caches in the browser Cache Storage API (persists across browser restarts
 * AND extension updates — the cache is scoped to the extension origin).
 *
 * Integrity guarantees:
 * - Every download is SHA-256 verified against a pinned hash before caching
 * (supply-chain guard). Files whose hash is not yet pinned but whose SIZE is
 * pinned (`MODEL_FILE_SIZES`) are size-verified, their computed digest is
 * stored alongside the cached Response, and a loud warning is emitted
 * (record-mode: first-download integrity is size+revision-pinned; every later
 * load re-verifies the recorded digest). Files with NEITHER pin are refused
 * unless the unpinned-weights opt-in is set.
 * - On every subsequent load (`getBuffer`/`getJSON`) the cached bytes are
 * re-hashed and compared against the stored digest (and the pinned hash, when
 * present) so a corrupted / rolled-back / poisoned cache entry is rejected
 * instead of silently executed as model weights.
 */

import {
  CACHE_NAME,
  MODEL_DOWNLOAD_SIZE_LABEL,
  MODEL_FILE_HASHES,
  MODEL_FILE_SIZES,
  modelFileEntries,
  type ModelFile,
} from "./constants";
import type { DownloadProgress } from "./types";
import { createProgressTracker, nextGlobalPercent, nowMs } from "./progress-metrics";
import {
  allowUnpinnedWeights,
  fetchBufProgress,
  sha256,
} from "./model-loader-utils";

/** Header we stamp on every cached Response with the computed SHA-256. */
const DIGEST_HEADER = "x-model-sha256";

/** Cadence of the aggregate "3/7 files · 58% · 8.2 MB/s · ETA 1m 12s" log line. */
const PERIODIC_LOG_MS = 5_000;

// ── Download-progress formatting helpers (pure; the math lives in progress-metrics.ts) ──

/** Human-readable byte count: "512 MB", "2.1 GB". */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 MB";
  const mb = n / (1024 * 1024);
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** Human-readable transfer rate: "8.2 MB/s", "1.20 GB/s". */
function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "—";
  const mbps = bytesPerSec / (1024 * 1024);
  if (mbps >= 1024) return `${(mbps / 1024).toFixed(2)} GB/s`;
  return `${mbps >= 1 ? mbps.toFixed(1) : mbps.toFixed(2)} MB/s`;
}

/** Human-readable duration: "45s", "1m 12s", "2h 5m". */
function formatEta(etaSeconds: number): string {
  const s = Math.max(0, Math.round(etaSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

export class ModelLoader {
  private cache: Cache | null = null;
  /**
   * The file set to download / verify. Chosen by `VisionAssistant` from the
   * GPU's WebGPU features (`modelFileEntries(embeddingPrecision)`); the fp16
   * variant is the default until `setFiles` is called.
   */
  private files: ModelFile[] = modelFileEntries("fp16");
  // Decoded buffer cache — avoids full ArrayBuffer copy on repeated getBuffer()
  // calls for the same URL (the Cache API's response.arrayBuffer() clones the
  // body each time). Populated on first read, cleared on cache invalidation.
  private bufferCache = new Map<string, Uint8Array>();

  /**
   * Best-effort listener for non-fatal security warnings (currently only the
   * deliberate unpinned-weights opt-in path). This NEVER affects the
   * fail-closed default — it is purely a user-facing visibility hook so an
   * operator relaxing the supply-chain guard sees an in-product warning
   * rather than a silent `console.warn`. Wired by `VisionAssistant` to its
   * status callback; in the service-worker context a `chrome.runtime`
   * message is also sent so an open UI surface (options/sidepanel) can show
   * a banner.
   */
  private warningCallback: ((message: string) => void) | null = null;

  /** Set (or swap) the file set to download / verify. Clears the decoded
   * buffer cache so a precision/version switch can't serve stale bytes. */
  setFiles(files: ModelFile[]): void {
    this.files = files;
    this.bufferCache.clear();
  }

  onWarning(cb: (message: string) => void): void {
    this.warningCallback = cb;
  }

  /** Best-effort cross-context warning (service worker → open UI surface). */
  private surfaceUnpinnedWarning(name: string, url: string): void {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) return;
    try {
      void chrome.runtime.sendMessage({
        type: "vision-unpinned-warning",
        name,
        url,
      });
    } catch {
      /* No listener in this context — the in-page callback / console.warn covers it. */
    }
  }

  async init(): Promise<void> {
    this.cache = await caches.open(CACHE_NAME);
    const unpinned = this.files.filter(({ url }) => !MODEL_FILE_HASHES[url]).map(
      ({ name }) => name,
    );
    if (unpinned.length > 0) {
 // Loud, not silent: shipping with unpinned weights means the
 // supply-chain guard only protects the first download, not the cache.
      console.error(
        `[vision-assistant] SECURITY: ${unpinned.length}/${this.files.length} model file hashes are ` +
          `UNPINNED in MODEL_FILE_HASHES (${unpinned.join(", ")}). Size-pinned files still ` +
          `verify their byte count and record a first-download digest that is re-verified on ` +
          `every load; run scripts/pin-vision-hashes.mjs to pin every SHA-256 before shipping ` +
          `to guard against tampered/poisoned weights.`,
      );
    }
  }

  async isCached(): Promise<boolean> {
    if (!this.cache) await this.init();
    for (const { url } of this.files) {
      const cached = await this.cache!.match(url);
      if (!cached) return false;
    }
    return true;
  }

  async downloadAll(onProgress?: (p: DownloadProgress) => void): Promise<void> {
    if (!this.cache) await this.init();
// Filter to only uncached files (must await each match).
// Also verify integrity of cached entries — a corrupted/partially-written
// cache entry (from a previous interrupted download, browser crash, or cache
// rollback) would otherwise pass the match check and fail later in getBuffer.
    const pending: Array<{ url: string; name: string }> = [];
    for (const file of this.files) {
      const existing = await this.cache!.match(file.url);
      if (existing) {
        const buf = new Uint8Array(await existing.arrayBuffer());
        try {
          await this.reverifyIntegrity(file.url, buf, existing);
          continue;
        } catch {
          await this.cache!.delete(file.url);
        }
      }
      pending.push(file);
    }
    if (pending.length === 0) return;

    // ── Aggregate download-progress state ───────────────────────────────────
    // The UI wants ONE monotonic bar + live logs across ALL pending files,
    // while fetchBufProgress emits per-file primitives that know nothing about
    // the set. We wrap the caller's callback and enrich every event with the
    // global fields below.
    const totalFiles = pending.length;
    // Best-effort per-file size used BEFORE a file's probe reveals its exact
    // total (Content-Range). ~210 MB ≈ the ~649 MB model spread over up to 13 files;
    // the estimate is refined to the average of known totals as soon as each
    // probe returns, and becomes exact once every file has been probed.
    const UNKNOWN_FILE_BYTES = 210 * 1024 * 1024;
    const knownTotals = new Map<string, number>(); // file name → exact total once known
    const fileDone = new Map<string, number>(); // file name → last reported downloaded bytes
    const fileIndexByName = new Map<string, number>();
    pending.forEach((f, i) => fileIndexByName.set(f.name, i + 1));
    let bytesDoneTotal = 0; // aggregate bytes received across ALL files
    let filesCompleted = 0; // files that finished download + SHA-256 verification
    let lastGlobalPercent = 0; // monotonic clamp — the bar never moves backwards
    let lastLogMs = -Infinity; // ~5 s aggregate log-line cadence

    // bytesTotal for the whole set: sum of known per-file totals + an estimate
    // for not-yet-probed files (average of known totals when any are known,
    // else the documented constant fallback).
    const estimateBytesTotal = (): number => {
      let known = 0;
      for (const t of knownTotals.values()) known += t;
      const unknown = totalFiles - knownTotals.size;
      if (unknown <= 0) return known;
      const avg = knownTotals.size > 0 ? known / knownTotals.size : UNKNOWN_FILE_BYTES;
      return known + unknown * avg;
    };

    // Rolling speed/ETA sampler; its total is re-set as probes refine bytesTotal.
    const tracker = createProgressTracker(estimateBytesTotal());
    // Emit a fully-enriched event. `p` is the per-file primitive (or a
    // set-level stub with file ""), `opts.message` a human-readable log line;
    // `withMetrics: false` drops the rolling speed/ETA (start / all-done).
    const emit = (p: DownloadProgress, opts: { message?: string; withMetrics?: boolean } = {}): void => {
      const bytesTotal = estimateBytesTotal();
      const metrics = tracker.get();
      lastGlobalPercent = nextGlobalPercent(bytesDoneTotal, bytesTotal, lastGlobalPercent);
      const includeMetrics = opts.withMetrics !== false;
      const enriched: DownloadProgress = {
        file: p.file,
        downloaded: p.downloaded,
        total: p.total,
        percent: p.percent,
        fileIndex: fileIndexByName.get(p.file) ?? 0,
        totalFiles,
        globalPercent: lastGlobalPercent,
        bytesDone: bytesDoneTotal,
        bytesTotal,
        ...(includeMetrics && metrics.speedBytesPerSec !== undefined
          ? { speedBytesPerSec: metrics.speedBytesPerSec }
          : {}),
        ...(includeMetrics && metrics.etaSeconds !== undefined
          ? { etaSeconds: metrics.etaSeconds }
          : {}),
        ...(opts.message !== undefined ? { message: opts.message } : {}),
      };
      onProgress?.(enriched);
    };

    // ~5 s aggregate log line — only once real bytes have landed (past pure
    // estimation) so we never log a meaningless 0/7 · 0% line before movement.
    const maybeLogAggregate = (): void => {
      const t = nowMs();
      if (t - lastLogMs < PERIODIC_LOG_MS) return;
      if (bytesDoneTotal <= 0 || estimateBytesTotal() <= 0) return;
      lastLogMs = t;
      const metrics = tracker.get();
      let line = `${filesCompleted}/${totalFiles} files · ${lastGlobalPercent}%`;
      if (metrics.speedBytesPerSec !== undefined) line += ` · ${formatSpeed(metrics.speedBytesPerSec)}`;
      if (metrics.etaSeconds !== undefined) line += ` · ETA ${formatEta(metrics.etaSeconds)}`;
      emit(
        { file: "", downloaded: bytesDoneTotal, total: estimateBytesTotal(), percent: lastGlobalPercent },
        { message: line },
      );
    };

    // Wrapper fed to fetchBufProgress: learns each file's total from its FIRST
    // progress event (the Content-Range probe), aggregates bytes with per-file
    // deltas (events from the 3 concurrent downloads interleave, and each
    // file's `downloaded` is monotonic so the delta is safe), then enriches.
    const onFileProgress = (p: DownloadProgress): void => {
      if (!knownTotals.has(p.file)) {
        knownTotals.set(p.file, p.total);
        tracker.setTotalBytes(estimateBytesTotal());
      }
      const prev = fileDone.get(p.file) ?? 0;
      if (p.downloaded > prev) {
        fileDone.set(p.file, p.downloaded);
        bytesDoneTotal += p.downloaded - prev;
      }
      tracker.record(bytesDoneTotal, nowMs());
      emit(p, {});
      maybeLogAggregate();
    };

    // Synthetic start event (set-level, fileIndex 0, globalPercent 0).
    emit(
      { file: "", downloaded: 0, total: 0, percent: 0 },
      {
        message: `Downloading ${totalFiles} model files (est. ${formatBytes(estimateBytesTotal())})…`,
        withMetrics: false,
      },
    );

// Download in parallel with a concurrency cap to avoid browser throttling.
    const CONCURRENCY = 3;
    let idx = 0;
    const next = async (): Promise<void> => {
      while (idx < pending.length) {
        const i = idx++;
        const { url, name } = pending[i];
        const buf = await fetchBufProgress(url, name, onFileProgress);
        const digest = await this.verifyIntegrity(url, name, buf);
        const response = new Response(buf as unknown as ArrayBuffer, {
          headers: { [DIGEST_HEADER]: digest },
        });
        try {
          await this.cache!.put(url, response);
        } catch (e) {
          throw new Error(
            `[vision-assistant] Failed to persist model file "${name}" (${url}): ` +
              `${(e as Error).message}. Usually caused by insufficient storage ` +
              `quota (the model is ${MODEL_DOWNLOAD_SIZE_LABEL}). Free space and retry; the downloaded ` +
              `bytes were not saved.`,
          );
        }
        // File fully downloaded + SHA-256 verified + cached. Reconcile the
        // aggregate to the EXACT byte count (covers probe-returned-whole-file
        // paths that emit no progress events) and log the per-file completion.
        const exact = buf.byteLength;
        knownTotals.set(name, exact);
        const prev = fileDone.get(name) ?? 0;
        if (exact > prev) {
          fileDone.set(name, exact);
          bytesDoneTotal += exact - prev;
        }
        tracker.setTotalBytes(estimateBytesTotal());
        tracker.record(bytesDoneTotal, nowMs());
        filesCompleted++;
        emit(
          { file: name, downloaded: exact, total: exact, percent: 100 },
          {
            message: `✓ File ${i + 1}/${totalFiles} ${name} downloaded + verified (${formatBytes(exact)})`,
          },
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, next));

    // Synthetic completion event (set-level) — bytesTotal is exact now, so
    // globalPercent is 100.
    emit(
      { file: "", downloaded: bytesDoneTotal, total: bytesDoneTotal, percent: 100 },
      {
        message: `All ${totalFiles} model files downloaded + SHA-256 verified (${formatBytes(bytesDoneTotal)})`,
        withMetrics: false,
      },
    );
  }

  /**
   * Verify a downloaded model file against its pinned SHA-256 (and/or size).
   *
   * - If a hash is pinned for `url` and the computed digest does not match,
   * throws — tampered/corrupted weights are never cached (supply-chain guard).
   * - If no hash is pinned but the SIZE is pinned (`MODEL_FILE_SIZES`), the
   * byte count is verified, the digest is computed and recorded (see
   * `downloadAll`), and a loud warning is emitted (record-mode — first-download
   * integrity is size+revision-pinned; every later load re-verifies the
   * recorded digest). Maintainers should promote these to full hashes with
   * `scripts/pin-vision-hashes.mjs`.
   * - If NEITHER is pinned, the unpinned-weights opt-in decides: refuse
   * (fail-closed default) or warn + record (dev/rollout only).
   */
  private async verifyIntegrity(
    url: string,
    name: string,
    buf: Uint8Array,
  ): Promise<string> {
    const expectedHash = MODEL_FILE_HASHES[url];
    if (expectedHash) {
      const actual = await sha256(buf);
      if (actual !== expectedHash.toLowerCase()) {
        throw new Error(
          `[vision-assistant] Integrity check FAILED for "${name}" (${url}): ` +
            `expected ${expectedHash.toLowerCase()}, got ${actual}. ` +
            `Refusing to cache potentially tampered or corrupted model weights.`,
        );
      }
      return actual;
    }
    const expectedSize = MODEL_FILE_SIZES[url];
    if (expectedSize !== undefined) {
      if (buf.byteLength !== expectedSize) {
        throw new Error(
          `[vision-assistant] Integrity check FAILED for "${name}" (${url}): ` +
            `expected ${expectedSize} bytes, got ${buf.byteLength}. ` +
            `Refusing to cache a truncated or unexpected model file.`,
        );
      }
      const actual = await sha256(buf);
      const msg =
        `[vision-assistant] Integrity check is SIZE-PINNED only for "${name}" (${url}): ` +
        `no SHA-256 in MODEL_FILE_HASHES. The first download was verified by size + pinned ` +
        `revision and its digest recorded; every later load re-verifies the recorded digest. ` +
        `Pin the hash (scripts/pin-vision-hashes.mjs) before shipping for full protection.`;
      console.warn(msg);
      // Surface a VISIBLE in-product warning (this is a deliberate dev-stage
      // relaxation — never silent).
      this.warningCallback?.(msg);
      this.surfaceUnpinnedWarning(name, url);
      return actual;
    }
    if (await allowUnpinnedWeights()) {
      const msg =
        `[vision-assistant] Integrity check SKIPPED for "${name}" (${url}): ` +
        `no pinned SHA-256 or size in MODEL_FILE_HASHES/MODEL_FILE_SIZES and the ` +
        `unpinned-weights opt-in is set. Model weights are unverified (dev/rollout only) — ` +
        `pin the hash before shipping to guard against tampered/poisoned weights.`;
      console.warn(msg);
      // Surface a VISIBLE in-product warning (fail-closed default is
      // preserved; this only fires on the deliberate opt-in path).
      this.warningCallback?.(msg);
      this.surfaceUnpinnedWarning(name, url);
      return await sha256(buf);
    }
    throw new Error(
      `[vision-assistant] Integrity check REFUSED for "${name}" (${url}): ` +
        `no pinned SHA-256 or size and unpinned weights are not allowed. Pin every hash ` +
        `before shipping (or set COWORK_ALLOW_UNPINNED_VISION=1 in dev) so tampered/poisoned ` +
        `weights are never cached.`,
    );
  }

  /**
   * Re-verify a cached buffer against the digest stored when it was written
   * (catches cache corruption / rollback / poisoning), the pinned hash when
   * present, and the pinned size when present.
   */
  private async reverifyIntegrity(
    url: string,
    buf: Uint8Array,
    response: Response,
  ): Promise<void> {
    const stored = response.headers.get(DIGEST_HEADER);
    const expectedHash = MODEL_FILE_HASHES[url];
    const expectedSize = MODEL_FILE_SIZES[url];
    if (!stored && !expectedHash && expectedSize === undefined) return; // nothing to check against
    if (expectedSize !== undefined && buf.byteLength !== expectedSize) {
      throw new Error(
        `[vision-assistant] Cached model file ${url} failed size re-verification ` +
          `(expected ${expectedSize} bytes, got ${buf.byteLength}). The Cache Storage ` +
          `entry appears corrupted, rolled back, or poisoned — clear the model cache and ` +
          `re-download.`,
      );
    }
    if (!stored && !expectedHash) return;
    const actual = await sha256(buf);
    if (stored && actual !== stored) {
      throw new Error(
        `[vision-assistant] Cached model file ${url} failed re-verification ` +
          `(stored digest ${stored}, recomputed ${actual}). The Cache Storage ` +
          `entry appears corrupted, rolled back, or poisoned — clear the model ` +
          `cache and re-download.`,
      );
    }
    if (expectedHash && actual !== expectedHash.toLowerCase()) {
      throw new Error(
        `[vision-assistant] Cached model file ${url} does not match its pinned ` +
          `SHA-256 (expected ${expectedHash.toLowerCase()}, got ${actual}). ` +
          `Refusing to load potentially tampered weights.`,
      );
    }
  }

  /**
   * Re-verify a cached entry, and on failure auto-recover by deleting the
   * poisoned / rolled-back / tampered entry so the next load re-downloads a
   * clean copy instead of repeatedly hitting the bad cache entry.
   */
  private async reverifyAndRecover(url: string, buf: Uint8Array, response: Response): Promise<void> {
    try {
      await this.reverifyIntegrity(url, buf, response);
    } catch (e) {
      try { await this.cache!.delete(url); } catch { /* best-effort */ }
      throw e;
    }
  }

  async getBuffer(url: string): Promise<Uint8Array> {
// Return cached buffer if available (avoids ArrayBuffer copy from Cache API).
    const cached = this.bufferCache.get(url);
    if (cached) return cached;

    if (!this.cache) await this.init();
    const response = await this.cache!.match(url);
    if (!response) throw new Error(`Model file not cached: ${url}`);
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength === 0) {
      throw new Error(`[vision-assistant] Cached model file ${url} is empty; refusing to load.`);
    }
 // Integrity is enforced solely by the SHA-256 re-verification below. Binary
 // weights (including ONNX protobufs) can legitimately begin with 0x3c ('<'),
 // so a first-byte markup heuristic must NOT reject valid caches — doing so
 // caused Local Vision to delete and re-download a good entry. A genuine
 // markup error page will fail the digest check against its pinned/stored
 // SHA-256 instead.
    await this.reverifyAndRecover(url, buf, response);
    this.bufferCache.set(url, buf);
    return buf;
  }

  async getJSON(url: string): Promise<unknown> {
    if (!this.cache) await this.init();
    const response = await this.cache!.match(url);
    if (!response) throw new Error(`Model file not cached: ${url}`);
    const rawBuf = new Uint8Array(await response.arrayBuffer());
  // Re-verify integrity BEFORE parsing: a poisoned cache entry (HTML error
  // page from a bad CDN redirect, rollback, tampering) must surface as the
  // integrity error with auto-recovery, not as a confusing "not valid JSON"
  // error that echoes raw cached bytes. It also rejects the poisoned entry
  // before any parse-time allocation.
    await this.reverifyAndRecover(url, rawBuf, response);
    const text = new TextDecoder().decode(rawBuf);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `[vision-assistant] Cached model file ${url} is not valid JSON ` +
          `(likely an HTML error page from a bad CDN redirect). First 200 chars: ` +
          `${text.slice(0, 200)}`,
      );
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(
        `[vision-assistant] Cached model file ${url} did not parse to a JSON ` +
          `object; refusing to use an unexpected payload as model metadata.`,
      );
    }
    return parsed;
  }

  async clearCache(): Promise<void> {
    await caches.delete(CACHE_NAME);
    this.cache = null;
    this.bufferCache.clear();
  }
}
