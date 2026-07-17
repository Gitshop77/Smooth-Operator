/**
 * Vision Assistant — model loader.
 *
 * Downloads the ~3.4 GB ONNX INT4 model in 48 MB chunks with retry.
 * Caches in the browser Cache Storage API (persists across sessions).
 * Ported from Reza2kn's fetchBufProgress.
 *
 * Integrity guarantees:
 * - Every download is SHA-256 verified against a pinned hash before caching
 * (supply-chain guard). Files whose hash is not yet pinned are still
 * hashed and the computed digest is stored alongside the cached Response.
 * - On every subsequent load (`getBuffer`/`getJSON`) the cached bytes are
 * re-hashed and compared against the stored digest (and the pinned hash,
 * when present) so a corrupted / rolled-back / poisoned cache entry is
 * rejected instead of silently executed as model weights.
 */

import {
  CACHE_NAME,
  DOWNLOAD_CHUNK_SIZE,
  DOWNLOAD_MAX_RETRIES,
  DOWNLOAD_STALL_MS,
  VISION_GRAPH_URL,
  VISION_DATA_URL,
  LANGUAGE_GRAPH_URL,
  LANGUAGE_DATA_URL,
  EMBED_PACKED_URL,
  EMBED_SCALES_URL,
  EMBED_META_URL,
  MODEL_FILE_HASHES,
} from "./constants";
import type { DownloadProgress } from "./types";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Whether an unpinned model file may be cached without a pinned SHA-256.
 *
 * Production must fail closed: shipping with an unpinned hash means the
 * supply-chain guard only protects the first download, not the cache, so an
 * unset pin refuses to download unverified weights instead of silently caching
 * them. Two opt-in escape hatches exist for dev / staged rollout while hashes
 * are being pinned:
 *  - `COWORK_ALLOW_UNPINNED_VISION=1` (env var). Works wherever `process.env`
 *    is injected, but NOT in the MV3 service worker where `process` is
 *    undefined.
 *  - an explicit user opt-in in `chrome.storage.local`
 *    (`coworkAllowUnpinnedVision === true`). This works in the service worker
 *    and is gated behind a deliberate user action, so production stays
 *    fail-closed by default.
 */
async function allowUnpinnedWeights(): Promise<boolean> {
  if (
    typeof process !== "undefined" &&
    !!process.env &&
    process.env.COWORK_ALLOW_UNPINNED_VISION === "1"
  ) {
    return true;
  }
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    try {
      const stored = await chrome.storage.local.get("coworkAllowUnpinnedVision");
      if (stored && stored.coworkAllowUnpinnedVision === true) return true;
    } catch {
      /* storage unavailable — fall through to the fail-closed default */
    }
  }
  return false;
}

/** SHA-256 (lowercase hex) of a buffer, via the Web Crypto API. */
async function sha256(buf: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Fetch a URL to a buffer with a stall watchdog.
 *
 * The watchdog is armed BEFORE `fetch()` so a hung TCP/TLS handshake — the
 * server accepts the connection but never sends response headers — is also
 * aborted. The timer is reset on every `reader.read()` so a slow but live
 * stream is never mistaken for a stall. `onProgress` (when provided) is fed
 * with the running byte count and, if known, the declared Content-Length.
 */
async function fetchToBuffer(
  url: string,
  opts: RequestInit,
  onProgress?: (downloaded: number, total: number) => void,
  stallMs: number = DOWNLOAD_STALL_MS,
  maxBytes?: number,
): Promise<{ buf: Uint8Array; headers: Headers; status: number }> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    timer = setTimeout(() => ctrl.abort(), stallMs);
  const r = await fetch(url, { ...opts, signal: ctrl.signal });
  if (!(r.status === 200 || r.status === 206)) throw new Error(`status ${r.status}`);
  if (!r.body) throw new Error(`empty response body for ${url}`);
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  const clHeader = r.headers.get("content-length");
  const cl = clHeader ? Number(clHeader) : NaN;
  let lastPct = -1;
  try {
    for (;;) {
      clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(), stallMs);
      const { done, value } = await reader.read();
      if (done) break;
 // `maxBytes` caps how much of the body we keep in memory. Used by the probe:
 // if the server IGNORES the Range header and returns the whole (potentially
 // multi-GB) file in a single read, we must not buffer the entire chunk. Bound
 // the accumulation to the remaining budget and stop — keeping only the leading
 // `maxBytes` bytes (or the whole chunk when it already fits) so memory stays
 // capped rather than buffering the full response.
      if (maxBytes !== undefined) {
        const remaining = maxBytes - got;
        if (remaining <= 0) {
          try { await reader.cancel(); } catch { /* ignore */ }
          break;
        }
        const keep = value.length > remaining ? value.slice(0, remaining) : value;
        chunks.push(keep);
        got += keep.length;
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
      chunks.push(value);
      got += value.length;
      if (onProgress && Number.isFinite(cl) && cl > 0) {
        const pct = Math.floor((got / cl) * 100);
        if (pct >= lastPct + 10) {
          lastPct = pct;
          onProgress(got, cl);
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.length;
  }
    return { buf, headers: r.headers, status: r.status };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Chunked Range download with retry. */
async function fetchBufProgress(
  url: string,
  label: string,
  onProgress?: (p: DownloadProgress) => void,
  chunkSize: number = DOWNLOAD_CHUNK_SIZE,
): Promise<Uint8Array> {
 // Probe: request a small leading range to learn whether the server supports
 // Range and what the total size is. Retry the probe with the same ceiling as
 // the chunked loop below so the two retry sites never silently drift.
  let first: { buf: Uint8Array; headers: Headers; status: number };
  for (let tr = 0; ; tr++) {
    try {
 // Cap the probe at `chunkSize` bytes so a server that ignores Range and
 // returns the whole file only costs us one chunk of memory here. The real
 // download proceeds via the logic below.
      first = await fetchToBuffer(
        url,
        { headers: { Range: `bytes=0-${chunkSize - 1}` } },
        undefined,
        DOWNLOAD_STALL_MS,
        chunkSize,
      );
      break;
    } catch (e) {
      if (tr >= DOWNLOAD_MAX_RETRIES - 1) throw e;
      await sleep(1200);
    }
  }

  const cr = first.headers.get("content-range");

 // Resolve the total size (or detect "unknown total").
  if (cr) {
    const crTotal = cr.split("/")[1];
    if (crTotal === "*") {
 // Range-capable but total unknown (`bytes 0-1048575/*`). We MUST NOT
 // return the single probe chunk as the whole file — that would cache a
 // silently-truncated ~48 MB model that then passes the integrity check.
 // Fall back to a single full-file GET (no Range) instead.
      return (
        await fetchToBuffer(url, {}, (d, t) =>
          onProgress?.({ file: label, downloaded: d, total: t, percent: t ? Math.floor((d / t) * 100) : 0 }),
        )
      ).buf;
    }
    const total = Number(crTotal);
    if (!Number.isFinite(total) || total <= 0) {
      throw new Error(
        `[vision-assistant] Bad Content-Range total "${crTotal}" for ${label} (${url})`,
      );
    }
    if (total <= first.buf.length) {
 // Server returned the entire file in the probe (small file / 200).
      return first.buf;
    }
    return downloadChunks(url, label, first.buf, total, onProgress, chunkSize);
  }

 // No Content-Range: either the server does not support Range (200 + whole
 // file) or it omitted a usable total. If a positive Content-Length is
 // present and larger than what we already have, fetch the whole file once.
  const cl = Number(first.headers.get("content-length"));
  if (Number.isFinite(cl) && cl > 0 && cl > first.buf.length) {
    return (
      await fetchToBuffer(url, {}, (d, t) =>
        onProgress?.({ file: label, downloaded: d, total: t, percent: t ? Math.floor((d / t) * 100) : 0 }),
      )
    ).buf;
  }

 // No usable size information from either Content-Range or Content-Length —
 // we cannot trust the probe chunk as the whole file. Force a full-file GET
 // (no Range) so we download everything rather than silently caching a
 // truncated partial (finding: truncated download cached without error / a
 // download with an unknown total was cached as complete). The integrity
 // check still runs afterwards.
  return (
    await fetchToBuffer(url, {}, (d, t) =>
      onProgress?.({ file: label, downloaded: d, total: t, percent: t ? Math.floor((d / t) * 100) : 0 }),
    )
  ).buf;
}

/** Fetch the remaining chunks for a known total size. */
async function downloadChunks(
  url: string,
  label: string,
  firstBuf: Uint8Array,
  total: number,
  onProgress?: (p: DownloadProgress) => void,
  chunkSize: number = DOWNLOAD_CHUNK_SIZE,
): Promise<Uint8Array> {
  const buf = new Uint8Array(total);
  buf.set(firstBuf, 0);
  let off = firstBuf.length;
  let lastPct = -1;

  while (off < total) {
    const end = Math.min(off + chunkSize, total) - 1;
    let ok = false;
    let part: Uint8Array | null = null;
    let status = 0;
    for (let tr = 0; tr < DOWNLOAD_MAX_RETRIES && !ok; tr++) {
      try {
        const res = await fetchToBuffer(url, {
          headers: { Range: `bytes=${off}-${end}` },
        });
        part = res.buf;
        status = res.status;
        ok = true;
      } catch (e) {
        if (tr === DOWNLOAD_MAX_RETRIES - 1) throw e;
        await sleep(1000);
      }
    }
    if (part === null) {
      throw new Error(`[vision-assistant] Internal error fetching ${label} (${url})`);
    }
    if (status === 200) {
 // Server ignored the Range header and returned the whole file.
      return part;
    }
    if (part.length !== end - off + 1) {
      throw new Error(
        `[vision-assistant] Chunk size mismatch for ${label} (${url}): ` +
          `requested bytes ${off}-${end} but received ${part.length} bytes. ` +
          `The server is not honouring Range requests as expected.`,
      );
    }
    buf.set(part, off);
    off += part.length;
    const pct = Math.floor((off / total) * 100);
    if (pct >= lastPct + 10 && onProgress) {
      lastPct = pct;
      onProgress({ file: label, downloaded: off, total, percent: pct });
    }
  }

 // Final sanity check: the assembled buffer must exactly equal the declared
 // total, otherwise a misbehaving server truncated us mid-stream.
  if (buf.byteLength !== total) {
    throw new Error(
      `[vision-assistant] Download of ${label} (${url}) assembled ` +
        `${buf.byteLength} bytes but expected ${total}`,
    );
  }

  return buf;
}

/** All 7 model files to download. */
const ALL_FILES: Array<{ url: string; name: string }> = [
  { url: VISION_GRAPH_URL, name: "vision graph" },
  { url: VISION_DATA_URL, name: "vision data" },
  { url: LANGUAGE_GRAPH_URL, name: "language graph" },
  { url: LANGUAGE_DATA_URL, name: "language data" },
  { url: EMBED_PACKED_URL, name: "embed packed" },
  { url: EMBED_SCALES_URL, name: "embed scales" },
  { url: EMBED_META_URL, name: "embed meta" },
];

/** URL-only view of `ALL_FILES`, for cache probes that don't need names. */
export const ALL_MODEL_FILE_URLS = ALL_FILES.map((f) => f.url);

/** Header we stamp on every cached Response with the computed SHA-256. */
const DIGEST_HEADER = "x-model-sha256";

export class ModelLoader {
  private cache: Cache | null = null;

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
    const unpinned = ALL_FILES.filter(({ url }) => !MODEL_FILE_HASHES[url]).map(
      ({ name }) => name,
    );
    if (unpinned.length > 0) {
 // Loud, not silent: shipping with unpinned weights means the
 // supply-chain guard only protects the first download, not the cache.
      console.error(
        `[vision-assistant] SECURITY: ${unpinned.length}/7 model file hashes are ` +
          `UNPINNED in MODEL_FILE_HASHES (${unpinned.join(", ")}). Weights are ` +
          `downloaded without a pinned integrity check — pin every SHA-256 before ` +
          `shipping to guard against tampered/poisoned weights.`,
      );
    }
  }

  async isCached(): Promise<boolean> {
    if (!this.cache) await this.init();
    for (const { url } of ALL_FILES) {
      const cached = await this.cache!.match(url);
      if (!cached) return false;
    }
    return true;
  }

  async downloadAll(onProgress?: (p: DownloadProgress) => void): Promise<void> {
    if (!this.cache) await this.init();
    for (const { url, name } of ALL_FILES) {
      const existing = await this.cache!.match(url);
      if (existing) continue; // Already cached
      const buf = await fetchBufProgress(url, name, onProgress);
      const digest = await this.verifyIntegrity(url, name, buf);
      const response = new Response(buf as unknown as ArrayBuffer, {
        headers: { [DIGEST_HEADER]: digest },
      });
      try {
        await this.cache!.put(url, response);
      } catch (e) {
 // Caching failed (quota / SW eviction). We deliberately throw instead
 // of swallowing — the already-downloaded buffer is large and we must not
 // silently loop re-downloading it on every call. Surface the cause so
 // the UI can tell the user to free storage.
        throw new Error(
          `[vision-assistant] Failed to persist model file "${name}" (${url}): ` +
            `${(e as Error).message}. Usually caused by insufficient storage ` +
            `quota (the model is ~3.4 GB). Free space and retry; the downloaded ` +
            `bytes were not saved.`,
        );
      }
    }
  }

  /**
 * Verify a downloaded model file against its pinned SHA-256.
 *
 * - If a hash is pinned for `url` and the computed digest does not match,
 * throws — tampered/corrupted weights are never cached (supply-chain guard).
 * - If no hash is pinned yet, the file is still hashed and the digest is
 * stored (see `downloadAll`) so subsequent loads can detect cache
 * corruption. Maintainers MUST pin every hash in MODEL_FILE_HASHES before
 * shipping (also enforced loudly in `init`).
 */
  private async verifyIntegrity(
    url: string,
    name: string,
    buf: Uint8Array,
  ): Promise<string> {
    const expected = MODEL_FILE_HASHES[url];
    if (!expected) {
      if (await allowUnpinnedWeights()) {
        const msg =
          `[vision-assistant] Integrity check SKIPPED for "${name}" (${url}): ` +
          `no pinned SHA-256 in MODEL_FILE_HASHES and the unpinned-weights opt-in is ` +
          `set. Model weights are unverified (dev/rollout only) — pin the hash ` +
          `before shipping to guard against tampered/poisoned weights.`;
        console.warn(msg);
        // Surface a VISIBLE in-product warning (fail-closed default is
        // preserved; this only fires on the deliberate opt-in path).
        this.warningCallback?.(msg);
        this.surfaceUnpinnedWarning(name, url);
        return await sha256(buf);
      }
      throw new Error(
        `[vision-assistant] Integrity check REFUSED for "${name}" (${url}): ` +
          `no pinned SHA-256 in MODEL_FILE_HASHES and unpinned weights are not ` +
          `allowed. Pin every hash before shipping (or set ` +
          `COWORK_ALLOW_UNPINNED_VISION=1 in dev) so tampered/poisoned weights ` +
          `are never cached.`,
      );
    }
    const actual = await sha256(buf);
    if (actual !== expected.toLowerCase()) {
      throw new Error(
        `[vision-assistant] Integrity check FAILED for "${name}" (${url}): ` +
          `expected ${expected.toLowerCase()}, got ${actual}. ` +
          `Refusing to cache potentially tampered or corrupted model weights.`,
      );
    }
    return actual;
  }

  /**
 * Re-verify a cached buffer against the digest stored when it was written
 * (catches cache corruption / rollback / poisoning) and, when a hash is
 * pinned, against that pinned value (catches tampering with the cache).
 */
  private async reverifyIntegrity(
    url: string,
    buf: Uint8Array,
    response: Response,
  ): Promise<void> {
    const stored = response.headers.get(DIGEST_HEADER);
    const expected = MODEL_FILE_HASHES[url];
    if (!stored && !expected) return; // nothing to check against
    const actual = await sha256(buf);
    if (stored && actual !== stored) {
      throw new Error(
        `[vision-assistant] Cached model file ${url} failed re-verification ` +
          `(stored digest ${stored}, recomputed ${actual}). The Cache Storage ` +
          `entry appears corrupted, rolled back, or poisoned — clear the model ` +
          `cache and re-download.`,
      );
    }
    if (expected && actual !== expected.toLowerCase()) {
      throw new Error(
        `[vision-assistant] Cached model file ${url} does not match its pinned ` +
          `SHA-256 (expected ${expected.toLowerCase()}, got ${actual}). ` +
          `Refusing to load potentially tampered weights.`,
      );
    }
  }

  async getBuffer(url: string): Promise<Uint8Array> {
    if (!this.cache) await this.init();
    const response = await this.cache!.match(url);
    if (!response) throw new Error(`Model file not cached: ${url}`);
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength === 0) {
      throw new Error(`[vision-assistant] Cached model file ${url} is empty; refusing to load.`);
    }
 // Defense-in-depth: a cached "model" that is actually an HTML/XML error
 // page (e.g. from a bad CDN redirect) must never reach ONNX Runtime. Genuine
 // model weights are binary; markup begins with '<', so reject it with a
 // descriptive error rather than a generic parse failure (finding: cached
 // file type/content not validated before parsing).
 // Defense-in-depth: a cached "model" that is actually an HTML/XML error
 // page (e.g. from a bad CDN redirect) must never reach ONNX Runtime. Genuine
 // model weights are binary; markup begins with '<', so reject it with a
 // descriptive error rather than a generic parse failure. This check is
 // unconditional: a self-reported x-model-sha256 digest (unpinned-weights
 // mode) or a pinned hash must not let a markup payload through, since real
 // weights never begin with '<'.
    if (buf.byteLength >= 1 && buf[0] === 0x3c /* '<' */) {
      throw new Error(
        `[vision-assistant] Cached model file ${url} looks like markup (starts with '<'), ` +
          `not model weights; refusing to load. The cache entry is likely an error page.`,
      );
    }
    try {
      await this.reverifyIntegrity(url, buf, response);
    } catch (e) {
 // Auto-recover: delete the poisoned / rolled-back / tampered entry so the
 // next load re-downloads a clean copy instead of repeatedly failing
 // (finding: integrity re-verify failure does not auto-recover the poisoned
 // cache entry).
      try { await this.cache!.delete(url); } catch { /* best-effort */ }
      throw e;
    }
    return buf;
  }

  async getJSON(url: string): Promise<unknown> {
    if (!this.cache) await this.init();
    const response = await this.cache!.match(url);
    if (!response) throw new Error(`Model file not cached: ${url}`);
    const rawBuf = new Uint8Array(await response.arrayBuffer());
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
    try {
      await this.reverifyIntegrity(url, rawBuf, response);
    } catch (e) {
 // Auto-recover: delete the poisoned / rolled-back entry so the next load
 // re-downloads a clean copy (finding: integrity re-verify failure does not
 // auto-recover the poisoned cache entry).
      try { await this.cache!.delete(url); } catch { /* best-effort */ }
      throw e;
    }
    return parsed;
  }

  async clearCache(): Promise<void> {
    await caches.delete(CACHE_NAME);
    this.cache = null;
  }
}
