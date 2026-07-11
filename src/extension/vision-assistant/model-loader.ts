/**
 * Vision Assistant — model loader.
 *
 * Downloads the 2.1 GB ONNX INT4 model in 48 MB chunks with retry.
 * Caches in the browser Cache Storage API (persists across sessions).
 * Ported from Reza2kn's fetchBufProgress.
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

/** SHA-256 (lowercase hex) of a buffer, via the Web Crypto API. */
async function sha256(buf: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Fetch with a stall watchdog: aborts if no progress within stallMs. */
async function fetchAbortable(
  url: string,
  opts: RequestInit,
  stallMs: number = DOWNLOAD_STALL_MS,
): Promise<{ buf: Uint8Array; headers: Headers }> {
  const ctrl = new AbortController();
  // Arm the stall watchdog BEFORE the fetch so a hung TCP/TLS handshake —
  // the server accepts the connection but never sends response headers — is
  // also aborted. The timer is reset on every reader.read() below.
  let timer = setTimeout(() => ctrl.abort(), stallMs);
  const r = await fetch(url, { ...opts, signal: ctrl.signal });
  if (!(r.status === 200 || r.status === 206)) throw new Error(`status ${r.status}`);
  if (!r.body) throw new Error(`empty response body for ${url}`);
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  try {
    for (;;) {
      clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(), stallMs);
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
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
  return { buf, headers: r.headers };
}

/** Chunked Range download with retry. */
async function fetchBufProgress(
  url: string,
  label: string,
  onProgress?: (p: DownloadProgress) => void,
  chunkSize: number = DOWNLOAD_CHUNK_SIZE,
): Promise<Uint8Array> {
  let total = 0;
  let first: { buf: Uint8Array; headers: Headers };
  for (let tr = 0; ; tr++) {
    try {
      first = await fetchAbortable(url, {
        headers: { Range: `bytes=0-${chunkSize - 1}` },
      });
      const cr = first.headers.get("content-range");
      total = cr
        ? +cr.split("/")[1]
        : +first.headers.get("content-length")! || first.buf.length;
      break;
    } catch (e) {
      // was a hardcoded `4`. Use `DOWNLOAD_MAX_RETRIES - 1` so this first
      // fetch's retry ceiling matches the chunked-download retry ceiling below
      // (which already uses `tr === DOWNLOAD_MAX_RETRIES - 1`). If the constant
      // ever changes (e.g. to 7 for flakier networks), this loop updates too —
      // no silent drift between the two retry sites.
      if (tr >= DOWNLOAD_MAX_RETRIES - 1) throw e;
      await sleep(1200);
    }
  }

  if (!total || total <= first.buf.length) {
    return first.buf;
  }

  const buf = new Uint8Array(total);
  buf.set(first.buf, 0);
  let off = first.buf.length;
  let lastPct = -1;

  while (off < total) {
    const end = Math.min(off + chunkSize, total) - 1;
    let ok = false;
    for (let tr = 0; tr < DOWNLOAD_MAX_RETRIES && !ok; tr++) {
      try {
        const { buf: part } = await fetchAbortable(url, {
          headers: { Range: `bytes=${off}-${end}` },
        });
        buf.set(part, off);
        off += part.length;
        ok = true;
      } catch (e) {
        if (tr === DOWNLOAD_MAX_RETRIES - 1) throw e;
        await sleep(1000);
      }
    }
    const pct = Math.floor((off / total) * 100);
    if (pct >= lastPct + 10 && onProgress) {
      lastPct = pct;
      onProgress({ file: label, downloaded: off, total, percent: pct });
    }
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

export class ModelLoader {
  private cache: Cache | null = null;

  async init(): Promise<void> {
    this.cache = await caches.open(CACHE_NAME);
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
      await this.verifyIntegrity(url, name, buf);
      const response = new Response(buf as unknown as ArrayBuffer);
      await this.cache!.put(url, response);
    }
  }

  /**
   * Verify a downloaded model file against its pinned SHA-256.
   *
   * - If a hash is pinned for `url` and the computed digest does not match,
   *   throws — tampered/corrupted weights are never cached (supply-chain guard).
   * - If no hash is pinned yet, emits a security warning but still caches the
   *   file so the extension keeps working during rollout. Maintainers MUST pin
   *   every hash in MODEL_FILE_HASHES before shipping.
   */
  private async verifyIntegrity(
    url: string,
    name: string,
    buf: Uint8Array,
  ): Promise<void> {
    const expected = MODEL_FILE_HASHES[url];
    if (!expected) {
      console.warn(
        `[vision-assistant] Integrity check SKIPPED for "${name}" (${url}): ` +
          `no pinned SHA-256 in MODEL_FILE_HASHES. Model weights are unverified ` +
          `— pin the hash before shipping to guard against tampered weights.`,
      );
      return;
    }
    const actual = await sha256(buf);
    if (actual !== expected.toLowerCase()) {
      throw new Error(
        `[vision-assistant] Integrity check FAILED for "${name}" (${url}): ` +
          `expected ${expected.toLowerCase()}, got ${actual}. ` +
          `Refusing to cache potentially tampered or corrupted model weights.`,
      );
    }
  }

  async getBuffer(url: string): Promise<Uint8Array> {
    if (!this.cache) await this.init();
    const response = await this.cache!.match(url);
    if (!response) throw new Error(`Model file not cached: ${url}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async getJSON(url: string): Promise<unknown> {
    if (!this.cache) await this.init();
    const response = await this.cache!.match(url);
    if (!response) throw new Error(`Model file not cached: ${url}`);
    return response.json();
  }

  async clearCache(): Promise<void> {
    await caches.delete(CACHE_NAME);
    this.cache = null;
  }
}
