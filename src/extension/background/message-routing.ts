/**
 * background/message-routing.ts — side panel → background message handlers.
 *
 * Registers `chrome.runtime.onMessage` and dispatches on `msg.type`:
 * - RUN / STOP / STATUS / CLEAR_LOG — run-lifecycle messages from the side
 * panel
 * - CDP_CLICK / CDP_PRESS_AND_HOLD — content-script fallbacks that need the
 * chrome.debugger API (only available in the service worker)
 * - SAVE_AS_PDF / SCREENSHOT — file-producing actions that need
 * chrome.downloads (also only in the SW)
 */

import type { AgentMode } from "@/lib/agent/modes";
import type { AgentAction } from "@/lib/agent/types";
import { getRunState, saveRunState } from "./state-store";
import {
  startRun,
  isRunStarting,
  setRunStarting,
  consumeDownloadConsentForMode,
  DEFAULT_MAX_STEPS,
  DEFAULT_MODE,
} from "./agent-bridge";

// ─── Message types ──────────────────────────────────────────────────────────

interface RunMessage {
  type: "RUN";
  task: string;
  maxSteps?: number;
  mode?: AgentMode;
}
interface StopMessage {
  type: "STOP";
}
interface StatusMessage {
  type: "STATUS";
}
interface ClearLogMessage {
  type: "CLEAR_LOG";
}
interface CdpClickMessage {
  type: "CDP_CLICK";
  rect: { x: number; y: number; width: number; height: number };
  /**
 * Optional bare vision id (e.g. `"v1"`, NO brackets). When present, the
 * handler looks up the cached pixel rect from `agent-bridge`'s
 * `visionElementsCache` instead of using `rect`. The content script's
 * `handleVisionClick` (click.ts) sends this for vision-only elements —
 * `rect` is a placeholder `{0,0,1,1}` in that case.
 */
  visionIndex?: string;
}
interface CdpPressAndHoldMessage {
  type: "CDP_PRESS_AND_HOLD";
  x: number;
  y: number;
  holdMs: number;
  delayMs: number;
}
interface SaveAsPdfMessage {
  type: "SAVE_AS_PDF";
  fileName?: string;
}
interface ScreenshotMessage {
  type: "SCREENSHOT";
  fileName?: string;
}
interface TabActionMessage {
  type: "TAB_ACTION";
  action: AgentAction;
}
interface DetectVisualMessage {
  type: "DETECT_VISUAL";
  query: string;
}
interface ClearVisionCacheMessage {
  type: "CLEAR_VISION_CACHE";
}
type IncomingMessage = RunMessage | StopMessage | StatusMessage | ClearLogMessage | CdpClickMessage | CdpPressAndHoldMessage | SaveAsPdfMessage | ScreenshotMessage | TabActionMessage | DetectVisualMessage | ClearVisionCacheMessage;

// ─── Per-run download consent ────────────────────────────────────────────────
//
// The per-run download-consent flag now lives in `agent-bridge.ts` (owned by
// the single `startRun` entry point shared by both manual RUN and scheduled
// runs) so it is reset for EVERY run. We consume it via
// `consumeDownloadConsentForMode(mode)` — see that helper for the rationale.

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Truncate a filename to `maxLen` chars WITHOUT cutting off the file
 * extension. The original `slice(0, 120)` could split the extension — e.g.
 * `"super-long-report.pdf"` → `"super-long-report.pd"` — which on some OSes
 * makes the file unopenable or associates it with the wrong app. This helper
 * detects a trailing `.ext` (1–5 alphanumerics) and re-appends it after
 * truncating the base name. If there's no extension (or the extension itself
 * is longer than `maxLen`), falls back to a plain slice.
 */
function truncateFilename(name: string, maxLen = 120): string {
  if (name.length <= maxLen) return name;
  const extMatch = name.match(/\.([a-z0-9]{1,5})$/i);
  if (!extMatch) return name.slice(0, maxLen);
  const ext = extMatch[0]; // includes the leading dot, e.g. ".pdf"
  const baseMax = maxLen - ext.length;
  if (baseMax <= 0) {
 // Pathological case: maxLen is shorter than the extension itself. Just
 // return the extension truncated — better than truncating to a bare stem
 // that loses the type info entirely.
    return ext.slice(0, maxLen);
  }
  return name.slice(0, baseMax) + ext;
}

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
 * broadens messaging, this check must be revisited (finding: sender gate
 * relies solely on sender.id).
 */
function isPrivilegedSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  const url = sender.url ?? "";
  if (url.startsWith(`chrome-extension://${chrome.runtime.id}`)) return true;
 // Content scripts: sender.tab is populated and sender.id is ours.
  if (sender.tab) return true;
  return false;
}

// ─── Listener ───────────────────────────────────────────────────────────────

/**
 * Shared capture + download path for the `SAVE_AS_PDF` and `SCREENSHOT`
 * handlers. Centralizes the now-duplicated logic (debugger attach/detach,
 * filename sanitization + 120-char cap, and the per-run `saveAs` consent
 * decision) into one place so the two handlers stay in lock-step (finding:
 * ~70 lines duplicated between SAVE_AS_PDF and SCREENSHOT, and the consent
 * logic was copy-pasted in both).
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
  const { attachDebugger, detachDebugger } = await import("@/lib/agent/cdp-controller");
  await attachDebugger(opts.tabId);
  let dataUrl: string;
  try {
    const result = await opts.capture();
    if (!result?.data) throw new Error("capture returned no data");
    dataUrl = `data:${opts.mime};base64,${result.data}`;
  } finally {
 // always detach — even on throw (mirrors CDP_CLICK / CDP_PRESS_AND_HOLD).
    detachDebugger(opts.tabId).catch(() => { /* tab may already be closed */ });
  }
  const tab = await chrome.tabs.get(opts.tabId);
  const title = (tab.title || opts.fallbackTitle).replace(/[^\w.-]+/g, "_").slice(0, 80);
 // Coerce `rawFileName` to a STRING before sanitizing (finding: a non-string
 // `fileName`, e.g. a number, would survive the `||` fallback and then throw
 // on `.replace`, defeating the sanitization).
  const rawName = typeof opts.rawFileName === "string" ? opts.rawFileName : `${title}.${opts.extension}`;
 // Sanitize then collapse any `..` segments (the `[^\w.-]` regex already turns
 // `/` and `\` into `_`, but `..` would survive as literal dots; collapse runs
 // of two-or-more dots so a crafted `fileName` can't be misinterpreted as a
 // parent-directory traversal by the downloads API).
  const baseName = rawName.replace(/[^\w.-]+/g, "_").replace(/\.{2,}/g, "_");
 // use `truncateFilename` so the extension is preserved even when the base
 // name has to be truncated to fit the 120-char cap.
  const filename = truncateFilename(baseName, 120);
 // In `full_agentic` mode the first download of a run forces a `saveAs`
 // confirmation so it can't be silent. Consume the one-time-per-run consent
 // flag (owned by agent-bridge, reset for every run) — it is consumed
 // synchronously so two concurrent messages don't both prompt the user.
  const requireSaveAs = consumeDownloadConsentForMode(opts.mode);
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: requireSaveAs });
  opts.sendResponse({ ok: true, filename });
}

chrome.runtime.onMessage.addListener((msg: IncomingMessage, sender, sendResponse) => {
 // Defense-in-depth: only accept messages from our own extension. This is the
 // SOLE sender check guarding the privileged handlers below (CDP_CLICK,
 // CDP_PRESS_AND_HOLD, SAVE_AS_PDF, SCREENSHOT, TAB_ACTION, DETECT_VISUAL).
 // It is correct ONLY because the manifest declares NO `externally_connectable`
 // (so only first-party extension contexts can message us). This is NOT a real
 // control against a compromised first-party content script — it is an
 // intentional trust boundary that DEPENDS on the absence of
 // `externally_connectable` and should be revisited (validate `sender.url` /
 // `sender.contexts`) if the manifest ever broadens messaging.
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: "unauthorized sender" });
    return false;
  }
  if (msg?.type === "RUN") {
 // set the synchronous guard BEFORE any await. A second RUN
 // message arriving while the first is still checking getRunState() sees
 // this flag and is rejected immediately.
    if (isRunStarting()) {
      sendResponse({ ok: false, error: "already starting" });
      return false;
    }
    setRunStarting(true);
 // Wrap the ENTIRE async handler body in try/catch. Without this, a
 // chrome.storage rejection from `await getRunState()` would leave
 // `sendResponse` uncalled (the side panel's `chrome.runtime.sendMessage`
 // promise hangs until SW death) AND the `runStarting` flag stuck `true`
 // (permanently DoSing all future RUN attempts until the SW is restarted).
 // On any throw we release the guard flag and surface the error to the
 // side panel.
    let responded = false;
    (async () => {
      try {
 // Validate the `task` payload at the boundary (finding: RUN `task` is
 // otherwise passed straight through to `new RunBuilder(task)`; the
 // `RunMessage.task: string` annotation is erased at runtime, so an
 // undefined/empty/non-string task would start a run with a corrupted
 // History record and a confusing empty prompt). Reject early so no
 // run guard is left dangling.
        if (typeof msg.task !== "string" || msg.task.trim().length === 0) {
          setRunStarting(false);
          sendResponse({ ok: false, error: "task required" });
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
 // A fresh run starts with no download consent — reset in `startRun`
 // (which both manual RUN and scheduled runs share), so we no longer
 // need to reset it on this path.
 // Sanitize maxSteps before passing it on (finding: run-time numeric/
 // string inputs are not validated). `msg.maxSteps || DEFAULT_MAX_STEPS`
 // only normalizes 0/empty, not negative numbers, NaN (falsy), or a
 // non-numeric string — clamp to a valid positive integer in [1, 1000].
        const reqMaxSteps = (typeof msg.maxSteps === "number" && Number.isFinite(msg.maxSteps) && msg.maxSteps > 0)
          ? Math.min(Math.floor(msg.maxSteps), 1000)
          : DEFAULT_MAX_STEPS;
        await startRun({
          task: msg.task,
          maxSteps: reqMaxSteps,
          mode: msg.mode || DEFAULT_MODE,
        });
      } catch (e) {
 // Release the guard so the next RUN can start.
        setRunStarting(false);
        if (!responded) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
 // If we already responded (startRun threw after sendResponse), there's
 // nothing else we can signal back to the side panel — startRun's own
 // finally block handles the side-panel-visible error event.
      }
    })();
    return true; // keep the message channel open for the async sendResponse
  }
  if (msg?.type === "STOP") {
 // wrap in try/catch so a chrome.storage failure still calls
 // sendResponse — otherwise the side panel's `chrome.runtime.sendMessage`
 // promise hangs forever (the SW has no other way to signal back).
    return bindHandler(sendResponse, async () => {
 // Use a partial update to avoid racing with concurrent step updates
 // from sendEvent (which does saveRunState({ step: N })).
      await saveRunState({ abortRequested: true });
      sendResponse({ ok: true });
    });
  }
  if (msg?.type === "STATUS") {
 // same as STOP — storage failures must not hang the caller.
    return bindHandler(sendResponse, async () => {
      const state = await getRunState();
      sendResponse({ running: !!state?.active, state });
    });
  }
  if (msg?.type === "CLEAR_LOG") {
 // Intentional no-op: the side panel clears its own log DOM locally on
 // receipt of the user's "clear log" click. This handler just acknowledges
 // the message so the side panel's `chrome.runtime.sendMessage` promise
 // resolves cleanly (and so the message doesn't fall through to the
 // unknown-type branch below).
    sendResponse({ ok: true });
    return false;
  }
 // CDP click fallback — the content script's el.click() didn't cause a
 // page change. Try a CDP-level Input.dispatchMouseEvent at the element's
 // center coordinates.
  if (msg?.type === "CDP_CLICK") {
    return bindHandler(sendResponse, async () => {
      if (!isPrivilegedSender(sender)) {
        sendResponse({ ok: false, error: "unauthorized sender" });
        return;
      }
 // `msg` is already narrowed to `CdpClickMessage` by the type
 // discriminator — no cast needed (finding: redundant `as` casts hid the
 // union narrowing that already guarantees the shape).
      const runState = await getRunState();
      const tabId = runState?.currentTabId;
      if (!tabId) { sendResponse({ ok: false, error: "no active run" }); return; }
      const { attachDebugger, cdpClick, detachDebugger } = await import("@/lib/agent/cdp-controller");
      await attachDebugger(tabId);
      try {
 // If this is a vision-detected element, look up its pixel coordinates
 // from the vision elements cache (populated by agent-bridge.ts extractState)
        let cx: number, cy: number;
        if (msg.visionIndex) {
 // Import the vision elements cache from agent-bridge
          const { getVisionElementRect } = await import("./agent-bridge");
          const rect = getVisionElementRect(msg.visionIndex);
          if (!rect) {
            sendResponse({ ok: false, error: `vision element ${msg.visionIndex} not found in cache` });
            return;
          }
          cx = rect.x + rect.width / 2;
          cy = rect.y + rect.height / 2;
        } else {
          const rect = msg.rect;
 // Validate the rect payload (finding: message payloads are otherwise
 // unvalidated). `rect` flows into arithmetic for CDP mouse coords; a
 // malformed/non-numeric rect would throw with a cryptic error.
          if (
            !rect ||
            typeof rect.x !== "number" || typeof rect.y !== "number" ||
            typeof rect.width !== "number" || typeof rect.height !== "number"
          ) {
            sendResponse({ ok: false, error: "invalid CDP_CLICK rect payload" });
            return;
          }
          cx = rect.x + rect.width / 2;
          cy = rect.y + rect.height / 2;
        }

        await cdpClick(tabId, cx, cy);
        sendResponse({ ok: true });
      } finally {
 // always detach, even on the success path. A `setTimeout(() =>
 // detachDebugger(...), 500)` pattern that only ran on success would
 // leak the debugger session on throw.
        detachDebugger(tabId).catch(() => { /* tab may already be closed */ });
      }
    });
  }
 // Wire `cdpPressAndHold` (the CDP controller method) into the executor's
 // `press_and_hold` action. The executor sends this message when an agent
 // action needs to hold the mouse button down for a duration (anti-bot
 // "press and hold to verify" widgets).
  if (msg?.type === "CDP_PRESS_AND_HOLD") {
    return bindHandler(sendResponse, async () => {
      if (!isPrivilegedSender(sender)) {
        sendResponse({ ok: false, error: "unauthorized sender" });
        return;
      }
      const runState = await getRunState();
      const tabId = runState?.currentTabId;
      if (!tabId) { sendResponse({ ok: false, error: "no active run" }); return; }
      const { attachDebugger, cdpPressAndHold, detachDebugger } = await import("@/lib/agent/cdp-controller");
      await attachDebugger(tabId);
      try {
 // Validate the payload (finding: message payloads are otherwise
 // unvalidated). These values flow into a privileged CDP
 // Input.dispatchMouseEvent via cdpPressAndHold; non-numeric/undefined
 // values would throw with a cryptic error inside the CDP controller.
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
      } finally {
 // always detach, even on the success path.
        detachDebugger(tabId).catch(() => { /* tab may already be closed */ });
      }
    });
  }
 // Save the current page as a PDF via CDP `Page.printToPDF`, then trigger a
 // real download via `chrome.downloads.download`. The content script can't
 // call either API (no `chrome.debugger`, no `chrome.downloads` in content
 // context), so the executor's `save_as_pdf` action sends this message to
 // the background SW, which has both.
  if (msg?.type === "SAVE_AS_PDF") {
    return bindHandler(sendResponse, async () => {
      if (!isPrivilegedSender(sender)) {
        sendResponse({ ok: false, error: "unauthorized sender" });
        return;
      }
      const runState = await getRunState();
      const tabId = runState?.currentTabId;
      if (!tabId) { sendResponse({ ok: false, error: "no active run" }); return; }
      await captureAndDownload({
        sendResponse,
        tabId,
        capture: () =>
          chrome.debugger.sendCommand({ tabId }, "Page.printToPDF", {
            printBackground: true,
            preferCSSPageSize: true,
          }) as Promise<{ data?: string }>,
        mime: "application/pdf",
        extension: "pdf",
        fallbackTitle: "page",
        rawFileName: msg.fileName,
        mode: runState?.mode,
      });
    });
  }
 // Capture a screenshot of the AGENT'S tab (runState.currentTabId) via CDP
 // `Page.captureScreenshot` and persist it as a download. The orchestrator
 // already attaches a screenshot to every `extractState` call (so the LLM
 // sees one per step); this `SCREENSHOT` handler lets the agent explicitly
 // capture + save a standalone screenshot file via the `screenshot` action.
 //
 // Security/correctness: use CDP `Page.captureScreenshot` against the exact
 // agent tabId, not `chrome.tabs.captureVisibleTab(WINDOW_ID_CURRENT, …)`,
 // which would capture whichever tab the USER is currently viewing — NOT the
 // tab the agent is running on. If the user switched tabs mid-run, the saved
 // screenshot would be of the wrong page. CDP `Page.captureScreenshot` targets
 // the exact tabId, matching the CDP_CLICK / SAVE_AS_PDF handlers. The
 // debugger is attached only for the duration of the capture (same
 // attach/detach pattern as SAVE_AS_PDF).
  if (msg?.type === "SCREENSHOT") {
    return bindHandler(sendResponse, async () => {
      if (!isPrivilegedSender(sender)) {
        sendResponse({ ok: false, error: "unauthorized sender" });
        return;
      }
      const runState = await getRunState();
      const tabId = runState?.currentTabId;
      if (!tabId) { sendResponse({ ok: false, error: "no active run" }); return; }
      const { getScreenshotQuality } = await import("./tab-manager");
      const screenshotQuality = await getScreenshotQuality();
      await captureAndDownload({
        sendResponse,
        tabId,
        capture: () =>
          chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
            format: "jpeg",
            quality: screenshotQuality,
          }) as Promise<{ data?: string }>,
        mime: "image/jpeg",
        extension: "jpg",
        fallbackTitle: "screenshot",
        rawFileName: msg.fileName,
        mode: runState?.mode,
      });
    });
  }
 // Clear the vision elements cache when the page scrolls. The cache stores
 // viewport-relative pixel rects; after scrolling, those rects are stale. The
 // content-script scroll handler sends this message fire-and-forget. No async
 // work — just clear + respond.
  if (msg?.type === "CLEAR_VISION_CACHE") {
    return bindHandler(sendResponse, async () => {
      const { clearVisionElementsCacheForNewRun } = await import("./run-helpers");
      clearVisionElementsCacheForNewRun();
      sendResponse({ ok: true });
    });
  }
 // Tab-level actions (switch_tab / close_tab / navigate new_tab) need the
 // chrome.tabs API, which only the service worker has. The content script's
 // handlers delegate these to the SW via TAB_ACTION. Same-tab navigate/search
 // stay in the content script (location.href) — those destroy the content
 // script on navigation, so a round-trip response couldn't get back anyway.
  if (msg?.type === "TAB_ACTION") {
    return bindHandler(sendResponse, async () => {
      if (!isPrivilegedSender(sender)) {
        sendResponse({ ok: false, error: "unauthorized sender" });
        return;
      }
      const runState = await getRunState();
      if (!runState) { sendResponse({ ok: false, error: "no active run" }); return; }
      const { handleTabAction } = await import("./tab-manager");
      const result = await handleTabAction(msg.action, runState);
      sendResponse({
        ok: true,
        handled: result.handled,
        pageChanged: result.pageChanged,
        success: result.success,
        message: result.message,
      });
    });
  }
 // Vision detection: run LocateAnything-3B on the current screenshot. Used by
 // the `detect_visual` action in AI Adaptive mode. The SW owns the vision
 // assistant singleton + captureVisibleTab — the content script forwards the
 // request via this message.
  if (msg?.type === "DETECT_VISUAL") {
    return bindHandler(sendResponse, async () => {
      if (!isPrivilegedSender(sender)) {
        sendResponse({ ok: false, error: "unauthorized sender" });
        return;
      }
 // Validate `query` at the boundary (finding: `DetectVisualMessage.query`
 // type is erased at runtime; a non-string/missing query would flow into
 // the vision prompt and a user-visible string as the literal
 // "undefined"). Coerce defensively, mirroring the validation discipline
 // already applied to CDP_CLICK / CDP_PRESS_AND_HOLD.
      const query = typeof msg.query === "string" ? msg.query : "";
      const { handleDetectVisualRequest } = await import("./run-helpers");
      const result = await handleDetectVisualRequest(query);
      sendResponse(result);
    });
  }
  return false;
});
