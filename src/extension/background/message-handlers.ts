import type { AgentMode } from "@/lib/agent/modes";
import type { AgentAction, LogEvent } from "@/lib/agent/types";
import { ActionSchema } from "@/lib/agent/tools/schema";
import {
  consumeDownloadConsentForMode,
  markDownloadConsentConsumed,
  releaseDownloadConsentReservation,
} from "./agent-bridge";
import type { ActionEffectAuthorizationMessage, CdpClickMessage, CdpPressAndHoldMessage, SaveAsPdfMessage, ScreenshotMessage, DetectVisualMessage, TabActionMessage, ClearVisionCacheMessage, PrivilegedDispatchToken } from "./message-types";
import { sendDebuggerCommandWithTimeout } from "./tab-manager-utils";
import {
  canCurrentRunDispatch,
  getCurrentRunController,
  type RunDispatchToken,
} from "./run-controller";
import { authorizeRunScopedDispatch } from "./run-dispatch-authorization";
import { broadcastSupplementalRunEvent } from "./run-event-broadcast";
import { authorizeAndIssueEffectCapability, consumeEffectCapability } from "./privileged-action-policy";
import { runCommandService } from "./run-command-service";
import { sanitizeDownloadName } from "./download-name";
import { runSessionState } from "./run-session-state";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Wrap an async message handler so `sendResponse` is ALWAYS called — otherwise
 * the caller's `chrome.runtime.sendMessage` promise hangs until the service
 * worker is killed (the file's own history documents exactly this failure
 * mode). Each handler calls `sendResponse` itself on its success / early-return
 * paths; this wrapper is the safety net that turns any thrown error into an
 * `{ ok: false, error }` response. The message channel is kept open (`return
 * true`) so the async `sendResponse` resolves the caller.
 *
 * The wrapper ALSO guards against double-response: a handler that calls
 * `sendResponse` and THEN throws (or resolves a second path) would otherwise
 * send a second response into a closed port — the response is silently lost
 * and Chrome logs "The message port closed before a response was received".
 * Only the FIRST response wins.
 */
function bindHandler(
  sendResponse: (response?: unknown) => void,
  fn: (sendResponse: (response?: unknown) => void) => Promise<void>,
): boolean {
  let responded = false;
  const once: (response?: unknown) => void = (response) => {
    if (responded) return;
    responded = true;
    sendResponse(response);
  };
  (async () => {
    try {
      await fn(once);
    } catch (e) {
      once({ ok: false, error: e instanceof Error ? e.message : String(e) });
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

interface PrivilegedAuthorization {
  token: RunDispatchToken;
  signal: AbortSignal;
  mode: AgentMode;
}

/**
 * Validate the original content dispatch against the current authority. A
 * Every privileged run-scoped request needs a live controller and token.
 */
async function authorizePrivilegedDispatch(
  supplied: PrivilegedDispatchToken | undefined,
  sendResponse: (r?: unknown) => void,
): Promise<PrivilegedAuthorization | null> {
  const result = await authorizeRunScopedDispatch(supplied);
  if (!result.ok) {
    sendResponse({ ok: false, error: result.error });
    return null;
  }
  if (!result.controller) {
    sendResponse({ ok: false, error: "run controller unavailable" });
    return null;
  }
  return {
    token: supplied as RunDispatchToken,
    signal: result.controller.signal,
    mode: result.controller.snapshot.mode,
  };
}

/** Recheck after each await and immediately before a privileged browser effect. */
function assertPrivilegedDispatch(authorization: PrivilegedAuthorization): void {
  if (!canCurrentRunDispatch(authorization.token)) {
    throw new Error("run cancellation invalidated action dispatch");
  }
  if (authorization.signal?.aborted) {
    throw authorization.signal.reason instanceof Error
      ? authorization.signal.reason
      : new DOMException("Aborted", "AbortError");
  }
}

/** Enforce the controller-owned capability and confirmation policy at the effect boundary. */
function requireEffectCapability(
  authorization: PrivilegedAuthorization,
  action: AgentAction,
  effectCapability: unknown,
  sendResponse: (r?: unknown) => void,
): boolean {
  if (!consumeEffectCapability(effectCapability, authorization.token, action)) {
    sendResponse({ ok: false, error: "BLOCKED: missing or invalid action effect capability" });
    return false;
  }
  return true;
}

/** Content must obtain this background-issued proof immediately before every action effect. */
export function handleAuthorizeActionEffect(
  msg: ActionEffectAuthorizationMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  return bindHandler(sendResponse, async () => {
    if (!requirePrivileged(sender, sendResponse)) return;
    const authorization = await authorizePrivilegedDispatch(msg.token, sendResponse);
    if (!authorization) return;
    assertPrivilegedDispatch(authorization);
    const parsed = ActionSchema.safeParse(msg.action);
    if (!parsed.success) {
      sendResponse({ ok: false, error: "BLOCKED: invalid action effect authorization payload" });
      return;
    }
    const issued = authorizeAndIssueEffectCapability(authorization.token, authorization.mode, parsed.data);
    sendResponse(issued.ok ? { ok: true, effectCapability: issued.effectCapability } : { ok: false, error: issued.error });
  });
}

/** Resolve the active run's current tab id + mode, responding + returning null when there is none. */
async function requireActiveTabId(
  suppliedToken: PrivilegedDispatchToken | undefined,
  sendResponse: (r?: unknown) => void,
): Promise<{ tabId: number; mode: AgentMode; authorization: PrivilegedAuthorization } | null> {
  const authorization = await authorizePrivilegedDispatch(suppliedToken, sendResponse);
  if (!authorization) return null;
  const runState = await runSessionState.readForRun(authorization.token);
  try {
    assertPrivilegedDispatch(authorization);
  } catch {
    sendResponse({ ok: false, error: "run cancellation invalidated action dispatch" });
    return null;
  }
  const tabId = runState?.currentTabId;
  if (!tabId) {
    sendResponse({ ok: false, error: "no active run" });
    return null;
  }
  return { tabId, mode: authorization.mode, authorization };
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
  token: PrivilegedDispatchToken | undefined,
  fn: (
    tabId: number,
    mode: AgentMode,
    authorization: PrivilegedAuthorization,
    sendResponse: (r?: unknown) => void,
  ) => Promise<void>,
): boolean {
  return bindHandler(sendResponse, async () => {
    if (!requirePrivileged(sender, sendResponse)) return;
    const tabRes = await requireActiveTabId(token, sendResponse);
    if (tabRes === null) return;
    await fn(tabRes.tabId, tabRes.mode, tabRes.authorization, sendResponse);
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
  assertAuthorized: () => void;
}): Promise<void> {
  const { withPageDebugger } = await import("./tab-manager");
  opts.assertAuthorized();
  // Route through the refcounted per-tab session so a concurrent per-step
  // screenshot (extractStateForRun) cannot detach this session mid-capture.
  const dataUrl = await withPageDebugger(opts.tabId, async () => {
    opts.assertAuthorized();
    const result = await opts.capture();
    opts.assertAuthorized();
    if (!result?.data) throw new Error("capture returned no data");
    return `data:${opts.mime};base64,${result.data}`;
  });
  let title: string;
  try {
    const tab = await chrome.tabs.get(opts.tabId);
    opts.assertAuthorized();
    title = (tab.title || opts.fallbackTitle).replace(/[^\w.-]+/g, "_").slice(0, 80);
  } catch {
    title = opts.fallbackTitle.replace(/[^\w.-]+/g, "_").slice(0, 80);
  }
  const rawName = (typeof opts.rawFileName === "string" && opts.rawFileName.trim()) ? opts.rawFileName : `${title}.${opts.extension}`;
  opts.assertAuthorized();
  const filename = sanitizeDownloadName(rawName);
  const requireSaveAs = consumeDownloadConsentForMode(opts.mode);
  try {
    opts.assertAuthorized();
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
  return runCommandService.handleRun(msg, sendResponse);
}

export function handleStop(
  sendResponse: (response?: unknown) => void,
): boolean {
  return runCommandService.handleStop(sendResponse);
}

export function handleStatus(
  sendResponse: (response?: unknown) => void,
): boolean {
  return runCommandService.handleStatus(sendResponse);
}

export function handleCdpClick(
  msg: CdpClickMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  return bindPrivilegedTabHandler(sendResponse, sender, msg.token, async (tabId, _mode, authorization) => {
    if (!msg.action) {
      sendResponse({ ok: false, error: "BLOCKED: missing CDP_CLICK action payload" });
      return;
    }
    if (!requireEffectCapability(authorization, msg.action, msg.effectCapability, sendResponse)) return;
    const { withPageDebugger } = await import("./tab-manager");
    assertPrivilegedDispatch(authorization);
    await withPageDebugger(tabId, async () => {
      const { cdpClick } = await import("@/lib/agent/cdp-controller");
      const { rectCenter } = await import("./cdp-rect-utils");
      assertPrivilegedDispatch(authorization);
      let cx: number, cy: number;
      if (msg.visionIndex) {
        const { getVisionElementRect, isVisionCacheFresh } = await import("./agent-bridge");
        if (!(await isVisionCacheFresh(tabId))) {
          sendResponse({ ok: false, error: "vision cache stale, re-detect" });
          return;
        }
        assertPrivilegedDispatch(authorization);
        const rect = getVisionElementRect(msg.visionIndex);
        if (!rect) {
          sendResponse({ ok: false, error: `vision element ${msg.visionIndex} not found in cache` });
          return;
        }
        ({ x: cx, y: cy } = rectCenter(rect));
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
        ({ x: cx, y: cy } = rectCenter(rect));
      }

      assertPrivilegedDispatch(authorization);
      await cdpClick(tabId, cx, cy, { assertAuthorized: () => assertPrivilegedDispatch(authorization) });
      sendResponse({ ok: true });
    });
  });
}

export function handleCdpPressAndHold(
  msg: CdpPressAndHoldMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  return bindPrivilegedTabHandler(sendResponse, sender, msg.token, async (tabId, _mode, authorization) => {
    if (!msg.action) {
      sendResponse({ ok: false, error: "BLOCKED: missing CDP_PRESS_AND_HOLD action payload" });
      return;
    }
    if (!requireEffectCapability(authorization, msg.action, msg.effectCapability, sendResponse)) return;
    const { withPageDebugger } = await import("./tab-manager");
    assertPrivilegedDispatch(authorization);
    await withPageDebugger(tabId, async () => {
      const { cdpPressAndHold } = await import("@/lib/agent/cdp-controller");
      assertPrivilegedDispatch(authorization);
      if (
        typeof msg.x !== "number" || !Number.isFinite(msg.x) ||
        typeof msg.y !== "number" || !Number.isFinite(msg.y) ||
        typeof msg.holdMs !== "number" || !Number.isFinite(msg.holdMs) ||
        typeof msg.delayMs !== "number" || !Number.isFinite(msg.delayMs)
      ) {
        sendResponse({ ok: false, error: "invalid CDP_PRESS_AND_HOLD payload" });
        return;
      }
      assertPrivilegedDispatch(authorization);
      await cdpPressAndHold(tabId, msg.x, msg.y, {
        holdMs: msg.holdMs,
        delay: msg.delayMs,
        assertAuthorized: () => assertPrivilegedDispatch(authorization),
      });
      sendResponse({ ok: true });
    });
  });
}

export function handleSaveAsPdf(
  msg: SaveAsPdfMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  return bindPrivilegedTabHandler(sendResponse, sender, msg.token, async (tabId, mode, authorization) => {
    const action = msg.action ?? { type: "save_as_pdf", file_name: msg.fileName } as AgentAction;
    if (!requireEffectCapability(authorization, action, msg.effectCapability, sendResponse)) return;
    await captureAndDownload({
      sendResponse,
      tabId,
      capture: () => {
        assertPrivilegedDispatch(authorization);
        return sendDebuggerCommandWithTimeout<{ data?: string }>(tabId, "Page.printToPDF", {
          printBackground: true,
          preferCSSPageSize: true,
        });
      },
      mime: "application/pdf",
      extension: "pdf",
      fallbackTitle: "page",
      rawFileName: msg.fileName,
      mode,
      assertAuthorized: () => assertPrivilegedDispatch(authorization),
    });
  });
}

export function handleScreenshot(
  msg: ScreenshotMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  return bindPrivilegedTabHandler(sendResponse, sender, msg.token, async (tabId, mode, authorization) => {
    const action = msg.action ?? { type: "screenshot", file_name: msg.fileName } as AgentAction;
    if (!requireEffectCapability(authorization, action, msg.effectCapability, sendResponse)) return;
    const { getScreenshotQuality } = await import("./tab-manager");
    const screenshotQuality = await getScreenshotQuality();
    assertPrivilegedDispatch(authorization);
    await captureAndDownload({
      sendResponse,
      tabId,
      capture: () => {
        assertPrivilegedDispatch(authorization);
        return sendDebuggerCommandWithTimeout<{ data?: string }>(tabId, "Page.captureScreenshot", {
          format: "jpeg",
          quality: screenshotQuality,
          // Capture only the VISIBLE viewport — CDP defaults
          // `captureBeyondViewport` to true (full scrollable page). This
          // handler's screenshot is a human-facing artifact; keeping it
          // consistent with the agent observation + vision captures avoids an
          // unexpected full-page image for a "screenshot the page" request.
          captureBeyondViewport: false,
        });
      },
      mime: "image/jpeg",
      extension: "jpg",
      fallbackTitle: "screenshot",
      rawFileName: msg.fileName,
      mode,
      assertAuthorized: () => assertPrivilegedDispatch(authorization),
    });
  });
}

export function handleClearVisionCache(
  msg: ClearVisionCacheMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  return bindHandler(sendResponse, async () => {
    if (!requirePrivileged(sender, sendResponse)) return;
    const authorization = await authorizePrivilegedDispatch(msg.token, sendResponse);
    if (!authorization) return;
    const { clearVisionElementsCacheForNewRun } = await import("./run-helpers");
    assertPrivilegedDispatch(authorization);
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
    const authorization = await authorizePrivilegedDispatch(msg.token, sendResponse);
    if (!authorization) return;
    if (!requireEffectCapability(authorization, msg.action, msg.effectCapability, sendResponse)) return;
    const runState = await runSessionState.readForRun(authorization.token);
    if (!runState) { sendResponse({ ok: false, error: "no active run" }); return; }
    const { handleTabAction: doTabAction } = await import("./tab-manager");
    try {
      assertPrivilegedDispatch(authorization);
    } catch {
      sendResponse({ ok: false, error: "run cancellation invalidated action dispatch" });
      return;
    }
    const notify = (event: LogEvent): void => {
      const controller = getCurrentRunController();
      if (!controller || !canCurrentRunDispatch(authorization.token)) return;
      broadcastSupplementalRunEvent(event, controller);
    };
    assertPrivilegedDispatch(authorization);
    const result = await doTabAction(
      msg.action,
      runState,
      notify,
      authorization.signal,
      () => canCurrentRunDispatch(authorization.token),
      authorization.token,
    );
    assertPrivilegedDispatch(authorization);
    sendResponse({
      ok: true,
      handled: result.handled,
      pageChanged: result.pageChanged,
      success: result.success,
      message: result.message,
      // Structured payloads (tab listings, cookies, storage reads) ride along.
      ...(result.data !== undefined ? { data: result.data } : {}),
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
    const authorization = await authorizePrivilegedDispatch(msg.token, sendResponse);
    if (!authorization) return;
    if (!requireEffectCapability(authorization, { type: "detect_visual", query: msg.query } as AgentAction, msg.effectCapability, sendResponse)) return;
    const query = typeof msg.query === "string" ? msg.query : "";
    const { handleDetectVisualRequest, getCurrentRunAbortSignal } = await import("./run-helpers");
    try {
      assertPrivilegedDispatch(authorization);
    } catch {
      sendResponse({ ok: false, error: "run cancellation invalidated action dispatch" });
      return;
    }
    // Thread the active run's abort signal so a user STOP short-circuits an
    // in-flight vision decode instead of letting it run to completion.
    const result = await handleDetectVisualRequest(
      query,
      authorization.token,
      authorization.signal ?? getCurrentRunAbortSignal() ?? undefined,
      () => assertPrivilegedDispatch(authorization),
    );
    if (result.ok) {
      const correlatedState = await runSessionState.readForRun(authorization.token);
      assertPrivilegedDispatch(authorization);
      if (!correlatedState) {
        sendResponse({ ok: false, error: "run state authority expired" });
        return;
      }
    }
    assertPrivilegedDispatch(authorization);
    sendResponse(result);
  });
}
