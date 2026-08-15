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
import { handleOptionsPlatformCommand } from "./options-platform-command";
import { handleLogRingMessage } from "./rate-limit-tracker";
import { getCapturedDownloads } from "./download-capture";
import { hasActiveTakeoverPause } from "@/lib/agent/loop/helpers/takeover";

export { isPrivilegedSender } from "./message-handlers";
export { sanitizeDownloadName, truncateFilename } from "./download-name";

// ─── Download capture ───────────────────────────────────────────────────────
// The capture ring lives in `./download-capture` (a leaf module) so
// `agent-bridge.startRun` can clear it at the run-start seam WITHOUT importing
// this dispatcher (which imports message-handlers → agent-bridge, forming a
// runtime import cycle). Re-export here so existing importers (message-routing
// consumers, tests) keep resolving the same names.
export {
  recordDownload,
  getCapturedDownloads,
  clearCapturedDownloads,
  MAX_DOWNLOAD_RECORDS,
} from "./download-capture";
export type { DownloadRecord } from "./download-capture";

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
