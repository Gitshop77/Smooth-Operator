/**
 * background/download-capture.ts — the SW download capture ring.
 *
 * Extracted from message-routing.ts so `agent-bridge.startRun` can clear the
 * ring at the run-start seam WITHOUT importing message-routing (which imports
 * message-handlers → agent-bridge, forming a runtime import cycle). This
 * module is a leaf: it imports only leaf helpers (download-name, url
 * redaction, agent-bridge-utils), so any module can safely import it.
 *
 * Owns the `chrome.downloads.onChanged` listener registration, the bounded
 * capture ring (sanitized fields only), and the download-consent resolution
 * that rides on terminal deltas.
 */

import { onDownloadConsentDelta } from "./agent-bridge-utils";
import { redactUrlTokens } from "@/lib/agent/dom/extraction/element-info-utils";
import { sanitizeDownloadName } from "./download-name";

/**
 * Sanitize a download's source URL BEFORE it enters the capture ring and can
 * reach the agent via `list_downloads`. Authenticated download URLs carry
 * signed query strings (`?X-Amz-Signature=…`, `?token=…`, signed CDN paths) —
 * the same leak class as the network-log channel (see rate-limit-tracker).
 * `redactUrlTokens` strips the query/fragment, userinfo, secret-shaped path
 * segments, and secret host labels.
 */
function sanitizeDownloadUrl(url: string): string {
  if (!url) return "";
  try {
    return redactUrlTokens(url);
  } catch {
    // Never let a redaction failure leak the raw URL — fail to a marker.
    return "[url redaction failed]";
  }
}

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
    url: sanitizeDownloadUrl(delta.url?.current ?? ""),
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
    // Resolve the one-time download-consent reservation against this delta:
    // "complete" consumes it, "interrupted" releases it. See agent-bridge-utils.
    onDownloadConsentDelta(delta);
  });
}
