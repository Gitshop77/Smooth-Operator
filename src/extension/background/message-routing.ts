/**
 * background/message-routing.ts — side panel → background message dispatcher.
 *
 * Registers `chrome.runtime.onMessage` and dispatches on `msg.type` to
 * handler functions in `./message-handlers.ts`.
 */

import type { IncomingMessage } from "./message-types";
import { authorizeRunScopedDispatch } from "./run-dispatch-authorization";
import { consumeEffectCapability } from "./privileged-action-policy";
import {
  handleHumanInteractCancel,
  handleHumanInteractRequest,
  handleHumanInteractResponse,
} from "./human-interaction-handler";
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
  handleAuthorizeActionEffect,
} from "./message-handlers";
import { handleScheduledTaskCommand } from "./scheduled-task-command";
import { handleHistoryCommand } from "./history-command";
import { sanitizeDownloadName } from "./download-name";
import { handleOptionsPlatformCommand } from "./options-platform-command";
import { handleLogRingMessage } from "./rate-limit-tracker";

export { isPrivilegedSender } from "./message-handlers";
export { sanitizeDownloadName, truncateFilename } from "./download-name";

// ─── Helpers (re-exported for tests) ────────────────────────────────────────

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
  if (msg?.type === "OPTIONS_PLATFORM_COMMAND") {
    return handleOptionsPlatformCommand(msg, sender, sendResponse);
  }
  if (msg?.type === "SCHEDULED_TASK_COMMAND") {
    return handleScheduledTaskCommand(msg, sender, sendResponse);
  }
  if (msg?.type === "HISTORY_COMMAND") {
    return handleHistoryCommand(msg, sender, sendResponse);
  }
  if (msg?.type === "AUTHORIZE_ACTION_EFFECT") {
    return handleAuthorizeActionEffect(msg, sender, sendResponse);
  }
  if (msg?.type === "HUMAN_INTERACT_REQUEST") {
    return handleHumanInteractRequest(msg, sender, sendResponse);
  }
  if (msg?.type === "HUMAN_INTERACT_RESPONSE") {
    return handleHumanInteractResponse(msg, sender, sendResponse);
  }
  if (msg?.type === "HUMAN_INTERACT_CANCEL") {
    return handleHumanInteractCancel(msg, sender, sendResponse);
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
    return handleClearVisionCache(msg, sender, sendResponse);
  }
  if (msg?.type === "TAB_ACTION") {
    // list_downloads is answered straight from the capture ring rather than
    // tab-manager, but it remains an agent action: consume its exact, one-time
    // capability before exposing the run-scoped diagnostic data.
    if (msg.action?.type === "list_downloads") {
      void authorizeRunScopedDispatch(msg.token).then((authorization) => {
        if (!authorization.ok) {
          sendResponse({ ok: false, error: authorization.error });
          return;
        }
        if (!consumeEffectCapability(msg.effectCapability, msg.token!, msg.action)) {
          sendResponse({ ok: false, error: "BLOCKED: missing or invalid action effect capability" });
          return;
        }
        sendResponse({
          ok: true,
          success: true,
          message: "downloads captured",
          downloads: getCapturedDownloads(),
        });
      });
      return true;
    }
    return handleTabAction(msg, sender, sendResponse);
  }
  if (msg?.type === "DETECT_VISUAL") {
    return handleDetectVisual(msg, sender, sendResponse);
  }
  if (msg?.type === "CONSOLE_LOG_ENTRY" || msg?.type === "NETWORK_LOG" || msg?.type === "CONSOLE_LOG") {
    return handleLogRingMessage(msg, sender, sendResponse);
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
