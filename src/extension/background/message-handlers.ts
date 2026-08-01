import type { AgentMode } from "@/lib/agent/modes";
import type { LogEvent } from "@/lib/agent/types";
import { getRunState, saveRunState } from "./state-store";
import {
  startRun,
  isRunStarting,
  setRunStarting,
  consumeDownloadConsentForMode,
  markDownloadConsentConsumed,
  releaseDownloadConsentReservation,
  DEFAULT_MAX_STEPS,
  DEFAULT_MODE,
} from "./agent-bridge";
import type { CdpClickMessage, CdpPressAndHoldMessage, SaveAsPdfMessage, ScreenshotMessage, DetectVisualMessage, TabActionMessage } from "./message-types";
import { KNOWN_MODES } from "./message-types";
import { sendDebuggerCommandWithTimeout } from "./tab-manager-utils";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Wrap an async message handler so `sendResponse` is ALWAYS called — otherwise
 * the caller's `chrome.runtime.sendMessage` promise hangs until the service
 * worker is killed (the file's own history documents exactly this failure
 * mode). Each handler calls `sendResponse` itself on its success / early-return
 * paths; this wrapper is the safety net that turns any thrown error into an
 * `{ ok: false, error }` response. The message channel is kept open (`return
 * true`) so the async `sendResponse` resolves the caller.
 */
function bindHandler(
  sendResponse: (response?: unknown) => void,
  fn: (sendResponse: (response?: unknown) => void) => Promise<void>,
): boolean {
  (async () => {
    try {
      await fn(sendResponse);
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();
  return true; // keep the message channel open for the async sendResponse
}

/**
 * Defense-in-depth sender check for the PRIVILEGED handlers (CDP_CLICK,
 * CDP_PRESS_AND_HOLD, SAVE_AS_PDF, SCREENSHOT, TAB_ACTION, DETECT_VISUAL).
 *
 * The global `sender.id === chrome.runtime.id` check is necessary but, on its
 * own, trusts ANY first-party context (side panel, options, a potentially
 * script-injected content script) equally. This narrows the trusted set to:
 * 1. extension pages (chrome-extension://<our-id>/...), and
 * 2. content scripts (sender.tab set — first-party, runs in our isolated
 * world on the agent's tab).
 * It is correct ONLY because the manifest declares no `externally_connectable`
 * (so untrusted web pages cannot message us at all). If the manifest ever
 * broadens messaging, this check must be revisited (the sender gate
 * relies solely on sender.id).
 */
export function isPrivilegedSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  const url = sender.url ?? "";
  if (url.startsWith(`chrome-extension://${chrome.runtime.id}`)) return true;
  // Content scripts: sender.tab is populated and sender.id is ours.
  if (sender.tab) return true;
  return false;
}

/** Reject a message from a non-privileged sender. Returns false (after responding) when rejected. */
function requirePrivileged(
  sender: chrome.runtime.MessageSender,
  sendResponse: (r?: unknown) => void,
): boolean {
  if (!isPrivilegedSender(sender)) {
    sendResponse({ ok: false, error: "unauthorized sender" });
    return false;
  }
  return true;
}

/** Resolve the active run's current tab id + mode, responding + returning null when there is none. */
async function requireActiveTabId(
  sendResponse: (r?: unknown) => void,
): Promise<{ tabId: number; mode: string | undefined } | null> {
  const runState = await getRunState();
  const tabId = runState?.currentTabId;
  if (!tabId) {
    sendResponse({ ok: false, error: "no active run" });
    return null;
  }
  return { tabId, mode: runState?.mode };
}

/**
 * Wrap a privileged handler that needs the active run's tab. Runs the same
 * `requirePrivileged` + `requireActiveTabId` + null-guard preamble shared by
 * the CDP_CLICK / CDP_PRESS_AND_HOLD / SAVE_AS_PDF / SCREENSHOT handlers, then
 * calls `fn(tabId, mode, sendResponse)`. Check order and response text mirror
 * the original inline sequence exactly.
 */
function bindPrivilegedTabHandler(
  sendResponse: (r?: unknown) => void,
  sender: chrome.runtime.MessageSender,
  fn: (
    tabId: number,
    mode: string | undefined,
    sendResponse: (r?: unknown) => void,
  ) => Promise<void>,
): boolean {
  return bindHandler(sendResponse, async () => {
    if (!requirePrivileged(sender, sendResponse)) return;
    const tabRes = await requireActiveTabId(sendResponse);
    if (tabRes === null) return;
    await fn(tabRes.tabId, tabRes.mode, sendResponse);
  });
}

/**
 * Shared capture + download path for the `SAVE_AS_PDF` and `SCREENSHOT`
 * handlers. Centralizes the now-duplicated logic (debugger attach/detach,
 * filename sanitization + 120-char cap, and the per-run `saveAs` consent
 * decision) into one place so the two handlers stay in lock-step.
 *
 * `capture` performs the CDP command and returns `{ data?: string }`. The
 * resulting base64 is wrapped in a `data:` URL using `mime` and handed to
 * `chrome.downloads.download`.
 */
async function captureAndDownload(opts: {
  sendResponse: (r?: unknown) => void;
  tabId: number;
  capture: () => Promise<{ data?: string }>;
  mime: string;
  extension: string;
  fallbackTitle: string;
  rawFileName: unknown;
  mode: string | undefined;
}): Promise<void> {
  const { withPageDebugger } = await import("./tab-manager");
  // Route through the refcounted per-tab session so a concurrent per-step
  // screenshot (extractStateForRun) cannot detach this session mid-capture.
  const dataUrl = await withPageDebugger(opts.tabId, async () => {
    const result = await opts.capture();
    if (!result?.data) throw new Error("capture returned no data");
    return `data:${opts.mime};base64,${result.data}`;
  });
  let title: string;
  try {
    const tab = await chrome.tabs.get(opts.tabId);
    title = (tab.title || opts.fallbackTitle).replace(/[^\w.-]+/g, "_").slice(0, 80);
  } catch {
    title = opts.fallbackTitle.replace(/[^\w.-]+/g, "_").slice(0, 80);
  }
  const rawName = (typeof opts.rawFileName === "string" && opts.rawFileName.trim()) ? opts.rawFileName : `${title}.${opts.extension}`;
  const { sanitizeDownloadName } = await import("./message-routing");
  const filename = sanitizeDownloadName(rawName);
  const requireSaveAs = consumeDownloadConsentForMode(opts.mode);
  try {
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: requireSaveAs });
    markDownloadConsentConsumed();
    opts.sendResponse({ ok: true, filename });
  } catch (e) {
    releaseDownloadConsentReservation();
    opts.sendResponse({ ok: false, error: e instanceof Error ? e.message : "download failed" });
  }
}

// ─── Handlers ───────────────────────────────────────────────────────────────

export function handleRun(
  msg: { task: string; maxSteps?: number; mode?: AgentMode },
  sendResponse: (response?: unknown) => void,
): boolean {
  if (isRunStarting()) {
    sendResponse({ ok: false, error: "already starting" });
    return false;
  }
  setRunStarting(true);
  let responded = false;
  (async () => {
    try {
      if (typeof msg.task !== "string" || msg.task.trim().length === 0) {
        setRunStarting(false);
        sendResponse({ ok: false, error: "task required" });
        responded = true;
        return;
      }
      const MAX_TASK_LENGTH = 10_000;
      if (msg.task.length > MAX_TASK_LENGTH) {
        setRunStarting(false);
        sendResponse({ ok: false, error: `Task too long (${msg.task.length} chars, max ${MAX_TASK_LENGTH})` });
        responded = true;
        return;
      }
      const existing = await getRunState();
      if (existing?.active) {
        setRunStarting(false);
        sendResponse({ ok: false, error: "already running" });
        responded = true;
        return;
      }
      sendResponse({ ok: true });
      responded = true;
      const reqMaxSteps = (typeof msg.maxSteps === "number" && Number.isFinite(msg.maxSteps) && msg.maxSteps >= 1)
        ? Math.max(1, Math.min(Math.floor(msg.maxSteps), 1000))
        : DEFAULT_MAX_STEPS;
      await startRun({
        task: msg.task,
        maxSteps: reqMaxSteps,
        mode:
          typeof msg.mode === "string" && KNOWN_MODES.has(msg.mode as AgentMode)
            ? msg.mode
            : DEFAULT_MODE,
      });
    } catch (e) {
      setRunStarting(false);
      if (!responded) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  })();
  return true;
}

export function handleStop(
  sendResponse: (response?: unknown) => void,
): boolean {
  return bindHandler(sendResponse, async () => {
    const state = await getRunState();
    if (state?.active || isRunStarting()) {
      await saveRunState({ abortRequested: true });
    }
    sendResponse({ ok: true });
  });
}

export function handleStatus(
  sendResponse: (response?: unknown) => void,
): boolean {
  return bindHandler(sendResponse, async () => {
    const state = await getRunState();
    sendResponse({ running: !!state?.active, state });
  });
}

export function handleCdpClick(
  msg: CdpClickMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  return bindPrivilegedTabHandler(sendResponse, sender, async (tabId) => {
    const { withPageDebugger } = await import("./tab-manager");
    await withPageDebugger(tabId, async () => {
      const { cdpClick } = await import("@/lib/agent/cdp-controller");
      let cx: number, cy: number;
      if (msg.visionIndex) {
        const { getVisionElementRect, isVisionCacheFresh } = await import("./agent-bridge");
        if (!(await isVisionCacheFresh(tabId))) {
          sendResponse({ ok: false, error: "vision cache stale, re-detect" });
          return;
        }
        const rect = getVisionElementRect(msg.visionIndex);
        if (!rect) {
          sendResponse({ ok: false, error: `vision element ${msg.visionIndex} not found in cache` });
          return;
        }
        cx = rect.x + rect.width / 2;
        cy = rect.y + rect.height / 2;
      } else {
        const rect = msg.rect;
        if (
          !rect ||
          typeof rect.x !== "number" || !Number.isFinite(rect.x) ||
          typeof rect.y !== "number" || !Number.isFinite(rect.y) ||
          typeof rect.width !== "number" || !Number.isFinite(rect.width) ||
          typeof rect.height !== "number" || !Number.isFinite(rect.height)
        ) {
          sendResponse({ ok: false, error: "invalid CDP_CLICK rect payload" });
          return;
        }
        cx = rect.x + rect.width / 2;
        cy = rect.y + rect.height / 2;
      }

      await cdpClick(tabId, cx, cy);
      sendResponse({ ok: true });
    });
  });
}

export function handleCdpPressAndHold(
  msg: CdpPressAndHoldMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  return bindPrivilegedTabHandler(sendResponse, sender, async (tabId) => {
    const { withPageDebugger } = await import("./tab-manager");
    await withPageDebugger(tabId, async () => {
      const { cdpPressAndHold } = await import("@/lib/agent/cdp-controller");
      if (
        typeof msg.x !== "number" || !Number.isFinite(msg.x) ||
        typeof msg.y !== "number" || !Number.isFinite(msg.y) ||
        typeof msg.holdMs !== "number" || !Number.isFinite(msg.holdMs) ||
        typeof msg.delayMs !== "number" || !Number.isFinite(msg.delayMs)
      ) {
        sendResponse({ ok: false, error: "invalid CDP_PRESS_AND_HOLD payload" });
        return;
      }
      await cdpPressAndHold(tabId, msg.x, msg.y, { holdMs: msg.holdMs, delay: msg.delayMs });
      sendResponse({ ok: true });
    });
  });
}

export function handleSaveAsPdf(
  msg: SaveAsPdfMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  return bindPrivilegedTabHandler(sendResponse, sender, async (tabId, mode) => {
    await captureAndDownload({
      sendResponse,
      tabId,
      capture: () =>
        sendDebuggerCommandWithTimeout<{ data?: string }>(tabId, "Page.printToPDF", {
          printBackground: true,
          preferCSSPageSize: true,
        }),
      mime: "application/pdf",
      extension: "pdf",
      fallbackTitle: "page",
      rawFileName: msg.fileName,
      mode,
    });
  });
}

export function handleScreenshot(
  msg: ScreenshotMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  return bindPrivilegedTabHandler(sendResponse, sender, async (tabId, mode) => {
    const { getScreenshotQuality } = await import("./tab-manager");
    const screenshotQuality = await getScreenshotQuality();
    await captureAndDownload({
      sendResponse,
      tabId,
      capture: () =>
        sendDebuggerCommandWithTimeout<{ data?: string }>(tabId, "Page.captureScreenshot", {
          format: "jpeg",
          quality: screenshotQuality,
        }),
      mime: "image/jpeg",
      extension: "jpg",
      fallbackTitle: "screenshot",
      rawFileName: msg.fileName,
      mode,
    });
  });
}

export function handleClearVisionCache(
  sendResponse: (response?: unknown) => void,
): boolean {
  return bindHandler(sendResponse, async () => {
    const { clearVisionElementsCacheForNewRun } = await import("./run-helpers");
    clearVisionElementsCacheForNewRun();
    sendResponse({ ok: true });
  });
}

export function handleTabAction(
  msg: TabActionMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  return bindHandler(sendResponse, async () => {
    if (!requirePrivileged(sender, sendResponse)) return;
    const runState = await getRunState();
    if (!runState) { sendResponse({ ok: false, error: "no active run" }); return; }
    const { handleTabAction: doTabAction } = await import("./tab-manager");
    const notify = (event: LogEvent): void => {
      chrome.runtime
        .sendMessage({
          type: "AGENT_EVENT",
          event,
          time: new Date().toLocaleTimeString("en-GB", { hour12: false }),
        })
        .catch(() => {
          /* side panel may not be open — non-fatal */
        });
    };
    const result = await doTabAction(msg.action, runState, notify);
    sendResponse({
      ok: true,
      handled: result.handled,
      pageChanged: result.pageChanged,
      success: result.success,
      message: result.message,
    });
  });
}

export function handleDetectVisual(
  msg: DetectVisualMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  return bindHandler(sendResponse, async () => {
    if (!requirePrivileged(sender, sendResponse)) return;
    const query = typeof msg.query === "string" ? msg.query : "";
    const { handleDetectVisualRequest } = await import("./run-helpers");
    const result = await handleDetectVisualRequest(query);
    sendResponse(result);
  });
}
