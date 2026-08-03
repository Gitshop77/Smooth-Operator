/**
 * background/message-routing.ts — side panel → background message dispatcher.
 *
 * Registers `chrome.runtime.onMessage` and dispatches on `msg.type` to
 * handler functions in `./message-handlers.ts`.
 */

import type { IncomingMessage } from "./message-types";
import {
  handleRun,
  handleStop,
  handleStatus,
  handleCdpClick,
  handleCdpPressAndHold,
  handleSaveAsPdf,
  handleScreenshot,
  handleClearVisionCache,
  handleTabAction,
  handleDetectVisual,
} from "./message-handlers";

export { isPrivilegedSender } from "./message-handlers";

// ─── Helpers (re-exported for tests) ────────────────────────────────────────

/**
 * Truncate a filename to `maxLen` chars WITHOUT cutting off the file
 * extension. The original `slice(0, 120)` could split the extension — e.g.
 * `"super-long-report.pdf"` → `"super-long-report.pd"` — which on some OSes
 * makes the file unopenable or associates it with the wrong app. This helper
 * detects a trailing `.ext` (1–5 alphanumerics) and re-appends it after
 * truncating the base name. If there's no extension (or the extension itself
 * is longer than `maxLen`), falls back to a plain slice.
 */
export function truncateFilename(name: string, maxLen = 120): string {
  if (name.length <= maxLen) return name;
  const extMatch = name.match(/\.([a-z0-9]{1,5})$/i);
  if (!extMatch) return name.slice(0, maxLen);
  const ext = extMatch[0]; // includes the leading dot, e.g. ".pdf"
  const baseMax = maxLen - ext.length;
  if (baseMax <= 0) {
    return ext.slice(0, maxLen);
  }
  return name.slice(0, baseMax) + ext;
}

/**
 * Sanitize a resolved download filename before handing it to
 * `chrome.downloads.download`. Strips any non-path-safe character (turning
 * `/` and `\` into `_`) and collapses runs of two-or-more dots so a crafted
 * `fileName` can't be misinterpreted as a parent-directory traversal by the
 * downloads API, then caps length via `truncateFilename` while preserving the
 * extension.
 */
export function sanitizeDownloadName(rawName: string): string {
  const baseName = rawName.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/\.{2,}/g, "_");
  return truncateFilename(baseName, 120);
}

// ─── Download capture ───────────────────────────────────────────────────────

/** One captured download, stored sanitized + size-bounded. */
export interface DownloadRecord {
  filename: string;
  url: string;
  mime: string;
  sizeBytes: number;
  receivedAt: number;
}

/** Max records kept in the capture ring (matches camofox's per-tab cap). */
export const MAX_DOWNLOAD_RECORDS = 20;

const capturedDownloads: DownloadRecord[] = [];

const EXTENSION_MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

/** Fall back to a mime guessed from the filename extension when the
 *  downloads API didn't report one. */
function guessMimeTypeFromName(filename: string): string {
  const ext = filename.toLowerCase().match(/(\.[a-z0-9]{1,5})$/)?.[1];
  return (ext && EXTENSION_MIME_MAP[ext]) || "application/octet-stream";
}

/**
 * Record a `chrome.downloads.onChanged` delta when the download completes.
 * Non-complete transitions, interrupted downloads, and zero-byte completes
 * are ignored. Returns the record, or null when nothing was captured.
 */
export function recordDownload(delta: chrome.downloads.DownloadDelta): DownloadRecord | null {
  if (delta.state?.current !== "complete") return null;
  const bytes = delta.fileSize?.current ?? delta.totalBytes?.current ?? 0;
  if (bytes <= 0) return null;
  const filename = sanitizeDownloadName(delta.filename?.current || "download.bin");
  const rec: DownloadRecord = {
    filename,
    url: delta.url?.current ?? "",
    mime: delta.mime?.current || guessMimeTypeFromName(filename),
    sizeBytes: bytes,
    receivedAt: Date.now(),
  };
  capturedDownloads.push(rec);
  if (capturedDownloads.length > MAX_DOWNLOAD_RECORDS) {
    capturedDownloads.splice(0, capturedDownloads.length - MAX_DOWNLOAD_RECORDS);
  }
  return rec;
}

/** Copy of the capture ring (newest last). */
export function getCapturedDownloads(): DownloadRecord[] {
  return [...capturedDownloads];
}

/** Reset the capture ring (between runs / tests). */
export function clearCapturedDownloads(): void {
  capturedDownloads.length = 0;
}

if (typeof chrome !== "undefined" && chrome.downloads?.onChanged) {
  chrome.downloads.onChanged.addListener((delta) => {
    recordDownload(delta);
  });
}

// ─── Listener ───────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: IncomingMessage, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: "unauthorized sender" });
    return false;
  }
  if (msg?.type === "RUN") {
    return handleRun(msg, sendResponse);
  }
  if (msg?.type === "STOP") {
    return handleStop(sendResponse);
  }
  if (msg?.type === "STATUS") {
    return handleStatus(sendResponse);
  }
  if (msg?.type === "CDP_CLICK") {
    return handleCdpClick(msg, sender, sendResponse);
  }
  if (msg?.type === "CDP_PRESS_AND_HOLD") {
    return handleCdpPressAndHold(msg, sender, sendResponse);
  }
  if (msg?.type === "SAVE_AS_PDF") {
    return handleSaveAsPdf(msg, sender, sendResponse);
  }
  if (msg?.type === "SCREENSHOT") {
    return handleScreenshot(msg, sender, sendResponse);
  }
  if (msg?.type === "CLEAR_VISION_CACHE") {
    return handleClearVisionCache(sendResponse);
  }
  if (msg?.type === "TAB_ACTION") {
    // list_downloads is answered straight from the capture ring — it needs no
    // active run and no tab-manager delegation.
    if (msg.action?.type === "list_downloads") {
      sendResponse({
        ok: true,
        success: true,
        message: "downloads captured",
        downloads: getCapturedDownloads(),
      });
      return false;
    }
    return handleTabAction(msg, sender, sendResponse);
  }
  if (msg?.type === "DETECT_VISUAL") {
    return handleDetectVisual(msg, sender, sendResponse);
  }
  if ((msg as { type?: string } | null)?.type === "RESUME") {
    const fromExtensionPage = Boolean(
      sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}`),
    );
    sendResponse(fromExtensionPage ? { ok: true } : { ok: false, error: "unauthorized sender" });
    return false;
  }
  return false;
});
