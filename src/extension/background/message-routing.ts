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
import { hasActiveTakeoverPause } from "@/lib/agent/loop/helpers/takeover";
import { redactUrlTokens } from "@/lib/agent/dom/extraction/element-info-utils";

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
    if (!fromExtensionPage) {
      sendResponse({ ok: false, error: "unauthorized sender" });
      return false;
    }
    // Truthful ack: a RESUME with nothing actively paused is a false ack that
    // hides the banner / shows "Resuming agent…" for a resume that never
    // happens. The takeover registry (lib/agent/loop/helpers/takeover.ts) holds
    // the currently-paused waits; this listener runs BEFORE that module's lazy
    // onMessage listener (registered at SW startup vs. on first pause), so the
    // active pause is still visible here when the message is processed.
    // The actual un-pause is done by the takeover registry's own RESUME
    // listener (latest-wins), not by this handler.
    //
    // Also clear the MANUAL-pause flag (`open_cowork_paused`, polled by the
    // loop's runPauseCheck) so a single Resume action continues the agent
    // regardless of which pause mechanism is active.
    void chrome.storage.session.set({ open_cowork_paused: false }).catch(() => {});
    sendResponse(
      hasActiveTakeoverPause()
        ? { ok: true }
        : { ok: false, error: "no active takeover pause to resume" },
    );
    return false;
  }
  return false;
});
