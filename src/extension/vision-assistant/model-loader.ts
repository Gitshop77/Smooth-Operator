/**
 * Vision Assistant — model loader.
 *
 * Downloads the ~2 GB ONNX INT4 model in 48 MB chunks with retry.
 * Caches in the browser Cache Storage API (persists across sessions).
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
import {
  allowUnpinnedWeights,
  fetchBufProgress,
  sha256,
} from "./model-loader-utils";

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
// Filter to only uncached files (must await each match).
// Also verify integrity of cached entries — a corrupted/partially-written
// cache entry (from a previous interrupted download, browser crash, or cache
// rollback) would otherwise pass the match check and fail later in getBuffer.
    const pending: Array<{ url: string; name: string }> = [];
    for (const file of ALL_FILES) {
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
// Download in parallel with a concurrency cap to avoid browser throttling.
    const CONCURRENCY = 3;
    let idx = 0;
    const next = async (): Promise<void> => {
      while (idx < pending.length) {
        const i = idx++;
        const { url, name } = pending[i];
        const buf = await fetchBufProgress(url, name, onProgress);
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
              `quota (the model is ~2 GB). Free space and retry; the downloaded ` +
              `bytes were not saved.`,
          );
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, next));
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
    await this.reverifyAndRecover(url, rawBuf, response);
    return parsed;
  }

  async clearCache(): Promise<void> {
    await caches.delete(CACHE_NAME);
    this.cache = null;
    this.bufferCache.clear();
  }
}
