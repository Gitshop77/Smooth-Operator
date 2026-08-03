/**
 * Model-loader helper utilities — extracted from model-loader.ts.
 *
 * Contains download primitives (chunked fetch with retry/stall watchdog),
 * SHA-256 hashing, and the unpinned-weights permission check.
 */

import {
  DOWNLOAD_CHUNK_SIZE,
  DOWNLOAD_MAX_RETRIES,
  DOWNLOAD_STALL_MS,
} from "./constants";
import type { DownloadProgress } from "./types";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Pre-allocated hex lookup table — avoids per-byte string allocation in sha256().
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

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
export async function allowUnpinnedWeights(): Promise<boolean> {
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
export async function sha256(buf: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => HEX[b]).join("");
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
    for (;;) {
      clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(), stallMs);
      const { done, value } = await reader.read();
      if (done) break;
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
export async function fetchBufProgress(
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
      await sleep(Math.min(1000 * 2 ** tr, 30_000) + Math.random() * 1000);
    }
  }

  const cr = first.headers.get("content-range");

  const mapProgress = (downloaded: number, total: number): void => {
    onProgress?.({
      file: label,
      downloaded,
      total,
      percent: total ? Math.floor((downloaded / total) * 100) : 0,
    });
  };

  // Resolve the total size (or detect "unknown total").
  if (cr) {
    const crTotal = cr.split("/")[1];
    if (crTotal === "*") {
  // Range-capable but total unknown (`bytes 0-1048575/*`). We MUST NOT
  // return the single probe chunk as the whole file — that would cache a
  // silently-truncated ~48 MB model that then passes the integrity check.
  // Fall back to a single full-file GET (no Range) instead.
      return (await fetchToBuffer(url, {}, mapProgress)).buf;
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
  if (Number.isFinite(cl) && cl > 0) {
    if (cl <= first.buf.length) {
      // Server returned the entire file in the probe (small unranged file such
      // as meta.json). Re-downloading it would just fetch the same bytes again.
      return first.buf;
    }
    return (await fetchToBuffer(url, {}, mapProgress)).buf;
  }

  // No usable size information from either Content-Range or Content-Length —
  // we cannot trust the probe chunk as the whole file. Force a full-file GET
  // (no Range) so we download everything rather than silently caching a
  // truncated partial download as complete. The integrity check still runs
  // afterwards.
  return (await fetchToBuffer(url, {}, mapProgress)).buf;
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
        await sleep(Math.min(1000 * 2 ** tr, 30_000) + Math.random() * 1000);
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

 // Final sanity check: the assembled buffer must have every byte filled up to
 // the declared total, otherwise a misbehaving server truncated us mid-stream
 // (the per-chunk length check above already rejects short chunks, so `off`
 // reaching `total` is the meaningful invariant — `buf.byteLength` is fixed at
 // allocation time and cannot diverge).
  if (off !== total) {
    throw new Error(
      `[vision-assistant] Download of ${label} (${url}) assembled ` +
        `${off} bytes but expected ${total}`,
    );
  }

  return buf;
}
