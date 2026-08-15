/**
 * background/tab-manager.ts — chrome.tabs queries, content-script injection,
 * tab-level action execution (switch/close/navigate/search).
 *
 * Low-level helpers (CDP debugger, screenshot quality, messaging, injection)
 * live in tab-manager-utils.ts and are re-exported here for backwards compat.
 */

import { substituteSecrets, redactSecrets } from "@/lib/agent/secrets";
import type { ActionResult, AgentAction, BrowserState, LogEvent, TabInfo } from "@/lib/agent/types";
import type { AgentMode } from "@/lib/agent/modes";
import { getDomainConfig, type RunState } from "./state-store";
import { resolveScreenshotPolicy } from "./screenshot-policy";
import {
  canCurrentRunDispatch,
  type RunDispatchToken,
  type RunSnapshotV1,
} from "./run-controller";
import {
  ensureContent,
  sendMessageWithTimeout,
  withPageDebugger,
  sendDebuggerCommandWithTimeout,
  throwIfAborted,
} from "./tab-manager-utils";
import {
  createTabActionService,
  type TabActionResult,
} from "./tab-action-service";
import { runSessionState } from "./run-session-state";

export {
  acquirePageDebugger,
  releasePageDebugger,
  withPageDebugger,
  getScreenshotQuality,
  sendMessageWithTimeout,
  getPageFingerprint,
  getPageSnapshot,
  ensureContent,
} from "./tab-manager-utils";

/** Action types whose result payloads may embed untrusted page content and need redaction. */
const READ_ACTION_TYPES: ReadonlySet<string> = new Set([
  "extract",
  "find_elements",
  "dropdown_options",
  "find_text",
  "evaluate",
  "search_page",
  "list_tabs",
]);

export async function listTabs(): Promise<TabInfo[]> {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const labels = new Map<string, number>();
  const result: TabInfo[] = [];
  for (const t of tabs) {
    if (!t.url || t.url.startsWith("chrome://") || t.url.startsWith("chrome-extension://")) continue;
    const label = String(t.id).slice(-4);
    const count = labels.get(label) || 0;
    labels.set(label, count + 1);
    const finalLabel = count === 0 ? label : `${label}#${count}`;
    result.push({
      id: t.id!,
      label: finalLabel,
      url: t.url,
      title: t.title || "",
      active: !!t.active,
    });
  }
  return result;
}

export async function extractStateFromTab(
  tabId: number,
  tabs: TabInfo[],
  includeScreenshot = true,
  signal?: AbortSignal,
): Promise<BrowserState> {
  throwIfAborted(signal);
  await ensureContent(tabId, signal);
  const res = await sendMessageWithTimeout<{ ok: boolean; error?: string; state?: BrowserState }>(
    tabId,
    { type: "EXTRACT_STATE", tabs },
    undefined,
    signal,
  );
  if (!res?.ok) throw new Error(`extract failed: ${res?.error || "no response"}`);
  if (typeof res.state !== "object" || res.state === null) {
    throw new Error("extract failed: content script returned no state object");
  }
  if (includeScreenshot) {
    try {
      throwIfAborted(signal);
      // One policy for capture AND annotation: the CDP quality (0-100) that
      // captured the JPEG and the dimension cap the annotator re-encodes at,
      // so a configured quality/maxDimension can't drift between the two.
      const policy = await resolveScreenshotPolicy();
      throwIfAborted(signal);
      const dataUrl = await withPageDebugger(tabId, async () => {
        const result = await sendDebuggerCommandWithTimeout<{ data?: string }>(
          tabId,
          "Page.captureScreenshot",
          { format: "jpeg", quality: policy.quality, captureBeyondViewport: false },
        );
        if (!result?.data) throw new Error("Page.captureScreenshot returned no data");
        return `data:image/jpeg;base64,${result.data}`;
      });
      throwIfAborted(signal);
      res.state.screenshot = dataUrl;

      const elementRects = (res.state as { elementRects?: unknown }).elementRects;
      if (Array.isArray(elementRects) && elementRects.length > 0) {
        try {
          const {
            annotateScreenshot,
            DEFAULT_ANNOTATE_PALETTE,
          } = await import("@/lib/agent/dom/screenshot-annotator");
          const dpr = (res.state as { devicePixelRatio?: number }).devicePixelRatio ?? 1;
          const annotated = await annotateScreenshot(dataUrl, elementRects as never, {
            scaleFactor: dpr,
            // Settings store JPEG quality 0-100; canvasToDataUrl takes 0-1,
            // so divide by 100 here. maxDimension applies the policy cap at
            // annotation time, making any later normalize step a true no-op.
            quality: policy.quality / 100,
            maxDimension: policy.annotateMaxDimension,
            // NO refPrefix: the annotator's default label is the bare element
            // index (`refPrefix + String(el.index)`), which is exactly what the
            // navigator prompt promises — "numbered colored labels ... match the
            // [index] numbers in the elements tree". A prefix like "e" made the
            // drawn labels (`e7`) diverge from the prompt contract and forced
            // every vision model to infer the mapping on every step.
            boxColors: [...DEFAULT_ANNOTATE_PALETTE],
          });
          throwIfAborted(signal);
          res.state.screenshot = annotated;
        } catch {
          throwIfAborted(signal);
          /* Annotation failed — keep the raw screenshot */
        }
      }
    } catch (e) {
      throwIfAborted(signal);
      console.debug(
        "[tab-manager] screenshot capture failed, using DOM-only state:",
        e instanceof Error ? e.message : "",
      );
    }
  }
  return res.state;
}

export async function executeActionsInTab(
  tabId: number,
  actions: AgentAction[],
  agentMode?: AgentMode,
  options?: { token?: RunDispatchToken; signal?: AbortSignal },
): Promise<unknown> {
  const { token, signal } = options ?? {};
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
  if (token && !canCurrentRunDispatch(token)) throw new Error("BLOCKED: stale or cancelled action dispatch");
  await ensureContent(tabId, signal);

  const inputResolvedText = new Map<number, string>();
  const resolvedActions = await Promise.all(
    actions.map(async (a, idx) => {
      if (a.type === "input") {
        const text = await substituteSecrets(a.text ?? "", { trusted: true });
        inputResolvedText.set(idx, text);
        return { ...a, text };
      }
      return a;
    }),
  );

  // This must be the final background-side authorization point. A STOP can
  // occur while content is injected or secrets are substituted; never send a
  // stale batch merely because it passed the earlier check.
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
  if (token && !canCurrentRunDispatch(token)) throw new Error("BLOCKED: stale or cancelled action dispatch");

  const res = await sendMessageWithTimeout<{ ok: boolean; error?: string; results?: unknown }>(
    tabId,
    {
      type: "EXECUTE_ACTIONS",
      actions: resolvedActions,
      domainConfig: getDomainConfig(),
      secretsResolved: true,
      agentMode,
      ...(token ? { token } : {}),
    },
    undefined,
    signal,
  );
  if (!res?.ok) throw new Error(`execute failed: ${res?.error || "no response"}`);
  if (!Array.isArray(res.results)) {
    throw new Error("execute failed: content script returned no results array");
  }
  const results = res.results as ActionResult[];

  return Promise.all(
    results.map(async (r, i) => {
      const orig = actions[i];
      if (!orig) return r;
      if (
        orig.type === "input" &&
        r.success === true &&
        inputResolvedText.has(i) &&
        (orig.text ?? "") !== inputResolvedText.get(i)
      ) {
        // Patch the message only on SUCCESS: a failed input action must keep
        // its honest error message — claiming "Typed …" over a failure is
        // misleading to the user and to the loop's outcome tracking.
        return {
          ...r,
          action: { ...r.action, text: orig.text },
          message: `Typed [REDACTED — secret substituted] into [${orig.index}]`,
        };
      }
      if (READ_ACTION_TYPES.has(orig.type)) {
        const patch: Record<string, unknown> = {};
        if (typeof r.extractedContent === "string") {
          patch.extractedContent = await redactSecrets(r.extractedContent);
        }
        const rAny = r as unknown as Record<string, unknown>;
        if (typeof rAny.value === "string") {
          patch.value = await redactSecrets(rAny.value);
        }
        if (typeof rAny.text === "string") {
          patch.text = await redactSecrets(rAny.text);
        }
        if (typeof r.message === "string") {
          patch.message = await redactSecrets(r.message);
        }
        return { ...r, ...patch };
      }
      return r;
    }),
  );
}

/**
 * Invalidate a run's content-side dispatches in every normal web tab. This is
 * deliberately best-effort: the RunController is the authority, while a tab
 * that is closed, privileged, or lacks the script cannot delay Stop.
 */
export async function broadcastRunCancellation(
  snapshotOrToken: Pick<RunSnapshotV1, "runId" | "dispatchRevision"> | RunDispatchToken,
): Promise<void> {
  const token: RunDispatchToken = {
    runId: snapshotOrToken.runId,
    dispatchRevision: snapshotOrToken.dispatchRevision,
  };
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(
      tabs
        .filter((tab) => typeof tab.id === "number" && /^https?:/i.test(tab.url ?? ""))
        .map((tab) => sendMessageWithTimeout(tab.id!, { type: "CANCEL_RUN", token }, 1_500)),
    );
  } catch {
    /* Stop remains authoritative even when a tab query/message fails. */
  }
}

export function waitForTabLoad(tabId: number, timeoutMs = 8000, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const listener = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id === tabId && info.status === "complete") finish();
    };
    // A closed tab can never finish loading. Without this, a tab closed right
    // after navigation resolves the wait silently (the `.catch(() => finish())`
    // on tabs.get below), and the caller proceeds against a dead tab — burning
    // agent steps on "extract failed: no such tab" until maxFailures. Reject
    // with a distinct error instead so the step fails fast and the loop can
    // re-plan (switch to a surviving tab).
    const onRemoved = (removedId: number) => {
      if (removedId === tabId) {
        finish(new Error(`waitForTabLoad: tab ${tabId} was closed before it finished loading`));
      }
    };
    const onAbort = () => finish(
      signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"),
    );
    const finish = (error?: unknown) => {
      if (!done) {
        done = true;
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        // Defensive guard: the API is always present in Chrome, but test stubs
        // and degraded environments may omit it — registration must not throw.
        if (chrome.tabs.onRemoved) chrome.tabs.onRemoved.removeListener(onRemoved);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      }
    };
    const timeoutId = setTimeout(finish, timeoutMs);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    chrome.tabs.onUpdated.addListener(listener);
    // Defensive guard: the API is always present in Chrome, but test stubs and
    // degraded environments may omit it — registration must not throw.
    if (chrome.tabs.onRemoved) chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === "complete") finish();
      })
      .catch((e) => {
        // A missing tab is a hard failure (reject); a transient chrome error
        // keeps the historical resolve-on-error behavior (the tab may still
        // load and the onUpdated listener will fire).
        const message = e instanceof Error ? e.message : String(e);
        if (/no tab with id/i.test(message)) {
          finish(new Error(`waitForTabLoad: tab ${tabId} was closed before it finished loading`));
        } else {
          finish();
        }
      });
  });
}

const tabActionService = createTabActionService({ listTabs, waitForTabLoad, sessionState: runSessionState });

/** Compatibility export for existing background callers. */
export async function handleTabAction(
  action: AgentAction,
  runState: RunState,
  notify?: (event: LogEvent) => void,
  signal?: AbortSignal,
  isAuthorized?: () => boolean,
  token?: Pick<RunDispatchToken, "runId">,
): Promise<TabActionResult> {
  return tabActionService.handleTabAction(action, runState, notify, signal, isAuthorized, token);
}
