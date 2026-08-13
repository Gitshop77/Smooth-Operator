import type { LoopDeps } from "@/lib/agent/loop/types";
import type { ActionResult, AgentAction, BrowserState, LogEvent, TabInfo } from "@/lib/agent/types";
import type { AgentMode } from "@/lib/agent/modes";
import { RunBuilder, saveRun } from "@/lib/agent/run-history";
import { stripUrlFragment } from "./vision";
import { makeAntiBotHooks } from "./antibot";
import { captureTabScreenshot } from "./screenshots";
import {
  getRunState,
  startKeepalive,
  stopKeepalive,
  maybeReleaseKeepAwake,
  safeLog,
  type RunState,
} from "./state-store";
import { runSessionState } from "./run-session-state";
import { flushRunSnapshot } from "./run-snapshot-store";
import {
  listTabs,
  ensureContent,
  extractStateFromTab,
  executeActionsInTab,
  waitForTabLoad,
  handleTabAction,
  getPageFingerprint,
  sendMessageWithTimeout,
} from "./tab-manager";
import { navigatorCallDirect, plannerCallDirect, summarizeCallDirect } from "../llm-direct";
import type { VisionAssistant } from "../vision-assistant";
import { broadcastSupplementalRunEvent } from "./run-event-broadcast";
import { resolveModel } from "../provider-config";
import {
  confirmationMessage,
  isTransientVisionError,
  visionElementsCache,
  getVisionElementRect,
  isVisionCacheFresh,
  getVisionCacheUrl,
  setVisionCacheUrl,
  setVisionCacheFingerprint,
  clearVisionCache,
  ADAPTIVE_VISION_IDLE_STEPS,
} from "./run-helpers-utils";
import {
  getCurrentRunController,
  isAuthoritativeRun,
  type RunController,
  type RunDispatchToken,
  type RunSnapshotV1,
} from "./run-controller";

export { getVisionElementRect, isVisionCacheFresh };

let catalogRefs: Promise<{
  modelSupportsVision: typeof import("@/lib/agent/llm/catalog")["modelSupportsVision"];
  CATALOG_PROVIDER_ID_MAP: typeof import("../provider-config-map")["CATALOG_PROVIDER_ID_MAP"];
}> | null = null;
function loadCatalogRefs() {
  if (!catalogRefs) {
    catalogRefs = Promise.all([
      import("@/lib/agent/llm/catalog"),
      import("../provider-config-map"),
    ]).then(([cat, pcm]) => ({
      modelSupportsVision: cat.modelSupportsVision,
      CATALOG_PROVIDER_ID_MAP: pcm.CATALOG_PROVIDER_ID_MAP,
    }));
  }
  return catalogRefs;
}

let visionAssistantMod: Promise<typeof import("../vision-assistant")> | null = null;
function loadVisionAssistant(): Promise<typeof import("../vision-assistant")> {
  return (visionAssistantMod ??= import("../vision-assistant"));
}

interface VisionSettings {
  model: unknown;
  provider: unknown;
  enableLocalVision: unknown;
  enableScreenshots: unknown;
  visionMode: unknown;
}

const VISION_SETTING_KEYS = [
  "model", "provider", "enableLocalVision", "enableScreenshots", "visionMode",
] as const;

let cachedVisionSettings: VisionSettings | null = null;

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (VISION_SETTING_KEYS.some((k) => changes[k])) cachedVisionSettings = null;
  });
}

async function getVisionSettings(): Promise<VisionSettings> {
  if (cachedVisionSettings !== null) return cachedVisionSettings;
  const s = await chrome.storage.local.get([...VISION_SETTING_KEYS]);
  cachedVisionSettings = {
    model: s.model,
    provider: s.provider,
    enableLocalVision: s.enableLocalVision,
    enableScreenshots: s.enableScreenshots,
    visionMode: s.visionMode,
  };
  return cachedVisionSettings;
}

let globalVisionAssistant: VisionAssistant | null = null;
let visionInitPromise: Promise<void> | null = null;
let visionInitFailed = false;
// Generation counter for the shared vision assistant: a new run claims the
// assistant via `resetVisionInitFlagForNewRun` (bumps the counter), and the
// initialized instance records which generation it belongs to. A stale
// `teardownScheduledVision` from a PREVIOUS run's cleanup must not clean up
// an instance a NEWER run already claimed — the comparison below is checked
// at teardown time, so it covers a claim landing either before OR during the
// teardown's own await.
let visionGeneration = 0;
let visionAssistantGeneration = -1;

function ensureVisionAssistantInit(): void {
  if (globalVisionAssistant || visionInitPromise || visionInitFailed) return;
  const originatingController = getCurrentRunController();
  const MAX_ATTEMPTS = 3;
  const BASE_DELAY_MS = 1000;
  const MAX_DELAY_MS = 8000;
  visionInitPromise = (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const { VisionAssistant: VA } = await import("../vision-assistant");
        const va = new VA();
        await va.init();
        globalVisionAssistant = va;
        // Record which generation owns the initialized instance.
        visionAssistantGeneration = visionGeneration;
        return;
      } catch (e) {
        const transient = isTransientVisionError(e);
        const lastAttempt = attempt >= MAX_ATTEMPTS - 1;
        if (transient && !lastAttempt) {
          const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        void safeLog("warn", "[vision-assistant] init failed:", e);
        visionInitFailed = true;
        broadcastSupplementalRunEvent(
          { type: "info", message: "Local Vision init failed — vision detections disabled for this run." },
          originatingController,
        );
        return;
      }
    }
  })().finally(() => {
    visionInitPromise = null;
  });
}

let lastKnownDpr = 1;

// The active run's abort signal, tracked at module level so the on-demand
// DETECT_VISUAL path (which has no LoopDeps context) can short-circuit a long
// vision decode when the user aborts the run — the always-on extract path
// already threads `controller.signal` directly.
let currentRunAbortSignal: AbortSignal | null = null;

export function setCurrentRunAbortSignal(signal: AbortSignal | null): void {
  currentRunAbortSignal = signal;
}

export function clearCurrentRunAbortSignal(signal: AbortSignal): void {
  if (currentRunAbortSignal === signal) currentRunAbortSignal = null;
}

export function getCurrentRunAbortSignal(): AbortSignal | null {
  return currentRunAbortSignal;
}

export function resetVisionInitFlagForNewRun(): void {
  // Claim ownership of the (possibly still-initialized) shared assistant:
  // any in-flight teardown from a previous run sees the generation change and
  // leaves the instance in place for this run.
  visionGeneration++;
  if (!visionInitPromise) visionInitFailed = false;
  adaptiveVisionLastUsedStep = -1;
  adaptiveVisionCurrentStep = 0;
}

export function clearVisionElementsCacheForNewRun(): void {
  clearVisionCache();
}

export async function teardownScheduledVision(): Promise<void> {
  if (visionInitPromise) {
    await visionInitPromise.catch(() => {});
  }
  // Only clean up an assistant this generation still owns: a newer run
  // claiming it (resetVisionInitFlagForNewRun bumps visionGeneration) means
  // this teardown belongs to a stale run and must leave the instance in place
  // — destroying it would strand the new run without vision.
  if (visionAssistantGeneration !== visionGeneration) return;
  // Null the global BEFORE cleanup so a run starting mid-cleanup initializes
  // a fresh assistant instead of reusing the instance being destroyed.
  const va = globalVisionAssistant;
  globalVisionAssistant = null;
  visionAssistantGeneration = -1;
  visionInitPromise = null;
  visionInitFailed = false;
  if (va) {
    await va.cleanup();
  }
}

let adaptiveVisionLastUsedStep = -1;
let adaptiveVisionCurrentStep = 0;

function trackAdaptiveVisionStep(step: number): void {
  adaptiveVisionCurrentStep = step;
  if (
    globalVisionAssistant &&
    adaptiveVisionLastUsedStep >= 0 &&
    step - adaptiveVisionLastUsedStep > ADAPTIVE_VISION_IDLE_STEPS
  ) {
    const va = globalVisionAssistant;
    globalVisionAssistant = null;
    visionAssistantGeneration = -1;
    visionInitPromise = null;
    visionInitFailed = false;
    void va.cleanup().catch((e) => void safeLog("warn", "[vision] cleanup failed:", e));
  }
}

export async function handleDetectVisualRequest(
  query: string,
  identity: Pick<RunDispatchToken, "runId">,
  signal?: AbortSignal,
  assertAuthorized?: () => void,
): Promise<{
  ok: boolean;
  count?: number;
  description?: string;
  error?: string;
}> {
  ensureVisionAssistantInit();
  if (visionInitFailed) {
    return { ok: false, error: "Vision assistant failed to initialize — try restarting the extension or switching vision modes" };
  }
  const va = globalVisionAssistant;
  if (!va?.isReady) {
    return { ok: false, error: "Vision assistant is still loading — try again on the next step" };
  }
  const isAuthorityCancellation = (error: unknown): boolean => {
    if (signal?.aborted) return true;
    if (error instanceof DOMException && error.name === "AbortError") return true;
    if (!(error instanceof Error)) return false;
    return /abort|cancel|stale\s+(?:run\s+)?token|run\s+(?:state\s+)?authority|dispatch\s+authority|authority\s+expired|invalidated\s+action\s+dispatch/i
      .test(`${error.name}: ${error.message}`);
  };
  const rethrowAuthorityCancellation = (error: unknown): void => {
    if (isAuthorityCancellation(error)) throw error;
  };
  try {
    assertAuthorized?.();
    const s = await runSessionState.readForRun(identity);
    assertAuthorized?.();
    const tabId = s?.currentTabId;
    if (!tabId) {
      return { ok: false, error: "no active run — cannot determine agent tab for screenshot" };
    }
    const screenshotDataUrl = await captureTabScreenshot(tabId, { signal });
    assertAuthorized?.();
    // Prefer the caller-supplied signal; fall back to the active run's signal
    // so a user STOP aborts an in-flight decode even when the request came
    // from the side panel (which has no LoopDeps context).
    const abortSignal = signal ?? getCurrentRunAbortSignal() ?? undefined;
    let visionDetections: Awaited<ReturnType<typeof va.detect>>;
    try {
      visionDetections = await va.detect(screenshotDataUrl, abortSignal);
    } catch (e) {
      rethrowAuthorityCancellation(e);
      void safeLog("warn", "[vision] detect failed:", e);
      visionDetections = [];
    }
    assertAuthorized?.();
    clearVisionCache();
    const { mergeDetections } = await loadVisionAssistant();
    assertAuthorized?.();
    const merged = mergeDetections([], visionDetections, lastKnownDpr);
    for (const m of merged) {
      if (m.source === "vision" && m.pixelRect && m.visionId) {
        visionElementsCache.set(m.visionId, { ...m.pixelRect, label: m.text });
      }
    }
    try {
      const tab = await chrome.tabs.get(tabId);
      assertAuthorized?.();
      setVisionCacheUrl(tab.url ?? "");
    } catch (e) {
      rethrowAuthorityCancellation(e);
      /* tab may have closed */
    }
    try {
      const fingerprint = await getPageFingerprint(tabId);
      assertAuthorized?.();
      setVisionCacheFingerprint(fingerprint);
    } catch (e) {
      rethrowAuthorityCancellation(e);
      setVisionCacheFingerprint("");
    }
    const visionEls = merged.filter((m) => m.source === "vision" && m.visionId && m.pixelRect);
    const descriptions = visionEls.map((m) => {
      const r = m.pixelRect;
      if (!r) return "";
      return `[${m.visionId}] ${m.text} at (${Math.round(r.x)}, ${Math.round(r.y)}) ${Math.round(r.width)}x${Math.round(r.height)}`;
    });
    const description = descriptions.length > 0
      ? `Visual elements detected:\n${descriptions.join("\n")}\n\nUse {"type":"click","index":"v1"} to click them on the next step.`
      : `No visual elements detected for query: "${query}".`;
    // This is the last synchronous boundary before the derived detection and
    // cache state can escape to a caller. It complements the handler's final
    // correlated state/token check across the async message boundary.
    assertAuthorized?.();
    adaptiveVisionLastUsedStep = adaptiveVisionCurrentStep;
    return { ok: true, count: visionDetections.length, description };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function extractStateForRun(
  fallbackTabId: number,
  tabs: TabInfo[],
  signal?: AbortSignal,
  identity?: { runId: string },
  contextTokens?: number,
): Promise<BrowserState> {
  const checkAbort = (): void => {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
    }
  };
  checkAbort();
  const s = identity
    ? await runSessionState.readForRun(identity)
    : await getRunState();
  checkAbort();
  if (identity && !s) {
    throw new DOMException("Run state authority expired", "AbortError");
  }
  const tabId = s?.currentTabId ? s.currentTabId : fallbackTabId;
  if (s) trackAdaptiveVisionStep(s.step);
  const vs = await getVisionSettings();
  checkAbort();
  const model = vs.model;
  const providerId = vs.provider;
  const enableLocalVision = vs.enableLocalVision;
  const storedEnableScreenshots = vs.enableScreenshots;
  const storedVisionMode = vs.visionMode;

  let mainModelVision = false;
  try {
    const { modelSupportsVision, CATALOG_PROVIDER_ID_MAP } = await loadCatalogRefs();
    const catId = CATALOG_PROVIDER_ID_MAP[providerId as string] ?? providerId;
    const resolvedModel = resolveModel({
      provider: providerId as string,
      model: model as string,
      catalogId: catId as string,
    });
    mainModelVision = await modelSupportsVision(resolvedModel, catId as string);
  } catch (e) { void safeLog("warn", "[vision] catalog/model load failed:", e); }
  checkAbort();

  const includeScreenshot = mainModelVision && Boolean(storedEnableScreenshots ?? true);
  const visionMode = (storedVisionMode as string) ||
    (enableLocalVision === true ? "always" : "disabled");
  const effectiveTextOnly = !mainModelVision || !includeScreenshot;
  const useAlwaysOnVision = visionMode === "always" && effectiveTextOnly;
  const useAdaptiveVision = visionMode === "adaptive" && effectiveTextOnly;

  if (!useAlwaysOnVision) {
    if (useAdaptiveVision && visionElementsCache.size > 0) {
      const domState = await extractStateFromTab(tabId, tabs, false, signal);
      const dpr = domState.devicePixelRatio ?? 1;
      lastKnownDpr = dpr;
      if (!getVisionCacheUrl() || (domState.url && stripUrlFragment(domState.url) !== stripUrlFragment(getVisionCacheUrl()))) {
        clearVisionCache();
      } else {
        // NOTE: deliberately does NOT re-stamp the cache fingerprint here.
        // The cached rects were captured when the fingerprint was set (in
        // handleDetectVisualRequest / the always-on path below); `isVisionCacheFresh`
        // compares the CURRENT page fingerprint against that capture-time value.
        // Re-stamping with this extraction's EXTRACT_STATE fingerprint would
        // re-baseline the freshness check to "now" and hide DOM changes since
        // the rects were captured.
        const { mergeDetections, renderMergedElementsText } = await loadVisionAssistant();
        const visionEntries = Array.from(visionElementsCache.entries()).map(([id, data]) => ({
          index: -1,
          tag: "vision_element",
          text: data.label,
          attributes: { "data-vision-label": data.label },
          hash: `vision_${id}`,
          rect: { x: data.x, y: data.y, width: data.width, height: data.height },
          source: "vision" as const,
          pixelRect: { x: data.x, y: data.y, width: data.width, height: data.height },
          indexStr: `[${id}]`,
          visionId: id,
        }));
        const merged = mergeDetections(domState.elements, [], 1);
        for (const entry of visionEntries) {
          if (!merged.some(m => m.visionId === entry.visionId)) {
            merged.push(entry);
          }
        }
        domState.elements = merged as unknown as typeof domState.elements;
        domState.elementsText = renderMergedElementsText(merged);
        domState.newElementCount += visionEntries.length;
      }
      return domState;
    }
    if (useAdaptiveVision) {
      clearVisionCache();
    }
    const domStateNoVision = await extractStateFromTab(tabId, tabs, includeScreenshot, signal);
    lastKnownDpr = domStateNoVision.devicePixelRatio ?? 1;
    // Capture-side screenshot budget: when the run's model context is known,
    // downscale the screenshot so it fits the model's derived screenshot cap
    // (the loop then never has to drop it). Unknown context → unchanged.
    if (domStateNoVision.screenshot && contextTokens !== undefined) {
      try {
        const { deriveNavigatorObservationCapsV1 } = await import("@/lib/agent/prompts/prompt-token-budget");
        const cap = deriveNavigatorObservationCapsV1(contextTokens).screenshotChars;
        if (cap > 0) {
          const { resizeScreenshotToBudget } = await import("./screenshots");
          domStateNoVision.screenshot = await resizeScreenshotToBudget(domStateNoVision.screenshot, cap);
          checkAbort();
        }
      } catch (e) {
        void safeLog("warn", "[run-helpers] screenshot budget resize skipped:", e);
      }
    }
    return domStateNoVision;
  }

  ensureVisionAssistantInit();
  const va = globalVisionAssistant;
  if (!va?.isReady) {
    return extractStateFromTab(tabId, tabs, false, signal);
  }

  try {
    const { mergeDetections, renderMergedElementsText } = await loadVisionAssistant();
    const screenshotDataUrl = await captureTabScreenshot(tabId);
    checkAbort();
    const [domState, visionDetections] = await Promise.all([
      extractStateFromTab(tabId, tabs, false, signal),
      va.detect(screenshotDataUrl, signal).catch((e: unknown) => {
        if (signal?.aborted) throw e;
        void safeLog("warn", "[vision] detect failed:", e);
        return [];
      }),
    ]);
    const dpr = domState.devicePixelRatio ?? 1;
    lastKnownDpr = dpr;
    const merged = mergeDetections(domState.elements, visionDetections, dpr);
    const visionNewCount = merged.filter((m) => m.source === "vision").length;
    domState.elements = merged as unknown as typeof domState.elements;
    domState.elementsText = renderMergedElementsText(merged);
    domState.newElementCount = domState.newElementCount + visionNewCount;
    visionElementsCache.clear();
    setVisionCacheUrl(domState.url);
    setVisionCacheFingerprint((domState as { fingerprint?: string }).fingerprint ?? "");
    for (const m of merged) {
      if (m.source === "vision" && m.pixelRect && m.visionId) {
        visionElementsCache.set(m.visionId, { ...m.pixelRect, label: m.text });
      }
    }
    return domState;
  } catch (e) {
    if (signal?.aborted) throw e;
    void safeLog("warn", "[vision-assistant] failed, falling back to DOM-only:", e);
    return extractStateFromTab(tabId, tabs, false, signal);
  }
}

interface AbortWiring {
  controller: AbortController;
  onStorageChanged: (changes: { [k: string]: chrome.storage.StorageChange }, area: string) => void;
}

export function wireAbortController(
  controller: AbortController,
  identity: { runId: string },
): AbortWiring {
  const { onStorageChanged } = runSessionState.wireAbort(controller, identity);
  return { controller, onStorageChanged };
}

interface LoopDepsContext {
  tab: chrome.tabs.Tab;
  sendEvent: (event: LogEvent) => void;
  controller: RunController;
  config: {
    maxSteps: number;
    maxActionsPerStep: number;
    plannerInterval: number;
    maxFailures: number;
    costCapUsd: number;
    /** Effective model context window (tokens), when known — drives the
     * context-adaptive observation caps in the loop (see
     * `deriveNavigatorObservationCapsV1`). Optional: `undefined` keeps the
     * fixed per-kind prompt budgets / observation caps. */
    contextTokens?: number;
  };
  task: string;
  mode: AgentMode;
  callbacks?: NonNullable<LoopDeps["callbacks"]>;
}

export function buildLoopDeps(ctx: LoopDepsContext): LoopDeps {
  const { tab, sendEvent, controller, config, task, mode, callbacks } = ctx;
  const fallbackTabId = tab.id!;
  const dispatchToken = controller.dispatchToken;
  const isOriginAuthoritative = (): boolean =>
    isAuthoritativeRun(controller) && controller.canDispatch(dispatchToken);
  const throwIfOriginUnauthorized = (): void => {
    if (!isOriginAuthoritative()) {
      throw new DOMException("Run dispatch authority expired", "AbortError");
    }
  };
  const blockedActions = (actions: AgentAction[]): ActionResult[] => actions.map((action) => ({
    action,
    success: false,
    message: "BLOCKED: run dispatch authority expired",
  }));
  // Publish the run's abort signal for the on-demand DETECT_VISUAL path.
  setCurrentRunAbortSignal(controller.signal);
  return {
    task,
    mode,
    callbacks,
    config,
    extractState: async (tabs) => {
      throwIfOriginUnauthorized();
      const state = await extractStateForRun(fallbackTabId, tabs, controller.signal, dispatchToken, config.contextTokens);
      throwIfOriginUnauthorized();
      return state;
    },
    executeActions: async (actions, _state): Promise<ActionResult[]> => {
      if (!isOriginAuthoritative()) return blockedActions(actions);
      const s = await runSessionState.readForRun(dispatchToken);
      if (!s || !isOriginAuthoritative()) return blockedActions(actions);
      const tabId = s?.currentTabId ? s.currentTabId : fallbackTabId;
      const agentMode = s?.mode ?? mode;
      const { currentCapabilityPolicy } = await import("@/lib/agent/capability-policy");
      if (!isOriginAuthoritative()) return blockedActions(actions);
      const results: ActionResult[] = new Array(actions.length);
      const filtered: { action: AgentAction; i: number }[] = [];
      let aborted = false;
      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        if (controller.signal.aborted) {
          aborted = true;
          results[i] = { action, success: false, message: "BLOCKED: run aborted by user" };
          continue;
        }
        if (aborted) {
          results[i] = { action, success: false, message: "BLOCKED: prior action in the queue was blocked or declined" };
          continue;
        }
        const capability = currentCapabilityPolicy.decide({
          actionType: action.type,
          mode: agentMode,
          enforcementPoint: "extension-action-batch",
        });
        if (!capability.allowed) {
          results[i] = { action, success: false, message: `BLOCKED: ${capability.reason}` };
          aborted = true;
          continue;
        }
        if (capability.requiresConfirmation) {
          try {
            const { askHuman } = await import("@/lib/agent/human-interaction");
            if (!isOriginAuthoritative()) return blockedActions(actions);
            const resp = await askHuman(
              { mode: "confirm", message: confirmationMessage(action) },
              controller.signal,
              dispatchToken,
            );
            if (!isOriginAuthoritative()) return blockedActions(actions);
            if (resp.mode !== "confirm" || !resp.confirmed) {
              results[i] = { action, success: false, message: `BLOCKED: user declined confirmation for ${action.type}` };
              aborted = true;
              continue;
            }
            // The content/RPC token identifies this run, but it cannot stand
            // in for a user approval. Record the exact approval in the
            // background so the eventual privileged RPC can consume it.
            const { grantPrivilegedActionConfirmation } = await import("./privileged-action-policy");
            grantPrivilegedActionConfirmation(dispatchToken, action);
          } catch {
            results[i] = { action, success: false, message: `BLOCKED: confirmation request failed for ${action.type}` };
            aborted = true;
            continue;
          }
        }
        const latestState = await runSessionState.readForRun(dispatchToken);
        if (!latestState || !isOriginAuthoritative() || controller.signal.aborted || latestState.abortRequested) {
          results[i] = { action, success: false, message: `BLOCKED: run aborted during confirmation for ${action.type}` };
          aborted = true;
          continue;
        }
        filtered.push({ action, i });
      }
      if (filtered.length === 0) return results;
      if (!isOriginAuthoritative()) {
        filtered.forEach((f) => {
          results[f.i] = {
            action: f.action,
            success: false,
            message: "BLOCKED: run cancellation invalidated action dispatch",
          };
        });
        return results;
      }
      // Mirror of the loop-side safeDispatch guard (action-queue.ts): a
      // throwing content-script round-trip (tab closed mid-step, script
      // unloaded) must not truncate the action queue. Mark every filtered
      // action failed so the loop continues with the remaining steps instead
      // of losing the whole result array to a rejected executeActions.
      let execResults: ActionResult[];
      try {
        execResults = (await executeActionsInTab(
          tabId,
          filtered.map((f) => f.action),
          agentMode,
          { token: dispatchToken, signal: controller.signal },
        )) as ActionResult[];
      } catch (e) {
        void safeLog("warn", "[run-helpers] executeActionsInTab failed:", e);
        filtered.forEach((f) => {
          results[f.i] = {
            action: f.action,
            success: false,
            message: "BLOCKED: content script failed to execute actions",
          };
        });
        return results;
      }
      if (!isOriginAuthoritative()) return blockedActions(actions);
      filtered.forEach((f, k) => { results[f.i] = execResults[k]; });
      for (let i = 0; i < results.length; i++) {
        if (!results[i]) {
          results[i] = { action: actions[i], success: false, message: "BLOCKED: missing result from content script" };
        }
      }
      return results;
    },
    navigatorCall: async (request, signal) => {
      throwIfOriginUnauthorized();
      const response = await navigatorCallDirect(request, signal);
      throwIfOriginUnauthorized();
      return response;
    },
    plannerCall: async (request, signal) => {
      throwIfOriginUnauthorized();
      const response = await plannerCallDirect(request, signal);
      throwIfOriginUnauthorized();
      return response;
    },
    summarizeCall: async (request) => {
      throwIfOriginUnauthorized();
      const response = await summarizeCallDirect(request);
      throwIfOriginUnauthorized();
      return response;
    },
    getTabs: async () => {
      throwIfOriginUnauthorized();
      const tabs = await listTabs();
      throwIfOriginUnauthorized();
      return tabs;
    },
    onEvent: sendEvent,
    signal: controller.signal,
    onTabAction: async (action) => {
      if (!isOriginAuthoritative()) {
        return { handled: true, success: false, message: "BLOCKED: run cancellation invalidated tab action", pageChanged: false };
      }
      const s = await runSessionState.readForRun(dispatchToken);
      if (!s) {
        return { handled: true, success: false, message: "BLOCKED: run state authority expired", pageChanged: false };
      }
      if (!isOriginAuthoritative()) {
        return { handled: true, success: false, message: "BLOCKED: run cancellation invalidated tab action", pageChanged: false };
      }
      return handleTabAction(action, s, sendEvent, controller.signal, isOriginAuthoritative, dispatchToken);
    },
    waitForNavigation: async () => {
      throwIfOriginUnauthorized();
      const s = await runSessionState.readForRun(dispatchToken);
      throwIfOriginUnauthorized();
      if (!s || !s.currentTabId) return;
      await waitForTabLoad(s.currentTabId, 8_000, controller.signal);
      throwIfOriginUnauthorized();
      await ensureContent(s.currentTabId, controller.signal);
      throwIfOriginUnauthorized();
    },
    settleDelay: 500,
    requestConfirmation: async (action) => {
      try {
        throwIfOriginUnauthorized();
        const { askHuman } = await import("@/lib/agent/human-interaction");
        throwIfOriginUnauthorized();
        const resp = await askHuman(
          { mode: "confirm", message: confirmationMessage(action) },
          controller.signal,
          dispatchToken,
        );
        throwIfOriginUnauthorized();
        const latest = await runSessionState.readForRun(dispatchToken);
        if (!latest || !isOriginAuthoritative() || controller.signal.aborted || latest.abortRequested) return false;
        return resp.mode === "confirm" ? resp.confirmed : false;
      } catch { return false; }
    },
    ...makeAntiBotHooks(),
    checkPaused: async () => {
      try {
        throwIfOriginUnauthorized();
        const res = await chrome.storage.session.get("open_cowork_paused");
        throwIfOriginUnauthorized();
        return !!res.open_cowork_paused;
      } catch { return false; }
    },
    getPageHtml: async (signal?: AbortSignal) => {
      try {
        throwIfOriginUnauthorized();
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
        const s = await runSessionState.readForRun(dispatchToken);
        throwIfOriginUnauthorized();
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
        if (!s || !s.currentTabId) return "";
        const res = await sendMessageWithTimeout<{ ok: boolean; html?: string }>(s.currentTabId, { type: "EXTRACT_HTML" }, undefined, signal);
        throwIfOriginUnauthorized();
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
        if (res?.ok && typeof res.html === "string") return res.html;
        return "";
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && (/abort/i.test(error.name) || /abort/i.test(error.message)))) throw error;
        return "";
      }
    },
    getCurrentUrl: async (signal?: AbortSignal) => {
      try {
        throwIfOriginUnauthorized();
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
        const s = await runSessionState.readForRun(dispatchToken);
        throwIfOriginUnauthorized();
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
        if (!s || !s.currentTabId) return "";
        const t = await chrome.tabs.get(s.currentTabId);
        throwIfOriginUnauthorized();
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
        return t.url ?? "";
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && (/abort/i.test(error.name) || /abort/i.test(error.message)))) throw error;
        return "";
      }
    },
  };
}

interface CleanupContext {
  runBuilder: RunBuilder;
  task: string;
  isScheduledTaskRun: boolean;
  onStorageChanged?: AbortWiring["onStorageChanged"];
  sendEvent: (event: LogEvent) => void;
  /** Retained for callers during the migration; terminalSnapshot is authoritative. */
  runSucceeded: boolean;
  releaseRunGuard: () => void;
  teardownScheduledVision: () => Promise<void>;
  abortSignal: AbortSignal;
  terminalSnapshot: RunSnapshotV1;
}

export async function cleanupRun(ctx: CleanupContext): Promise<void> {
  const { runBuilder, task, isScheduledTaskRun, onStorageChanged, sendEvent, releaseRunGuard, teardownScheduledVision, abortSignal, terminalSnapshot } = ctx;

  if (onStorageChanged) {
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch { void 0; }
  }
  try { await stopKeepalive(); } catch { void 0; }
  try { await runSessionState.clear({ runId: terminalSnapshot.runId }); } catch { void 0; }
  try { void chrome.action.setBadgeText({ text: "" }); } catch { void 0; }
  try { sendEvent({ type: "info", message: "Run finished." }); } catch { void 0; }
  try {
    // A nonrecoverable error may terminate through an `error` event rather
    // than a `done` event. Use the authoritative terminal projection as the
    // history fallback so history and panel never disagree about the outcome.
    const record = runBuilder.finish({
      // The terminal snapshot is the sole outcome authority. A stale success
      // callback must never override cancellation/failure in persisted history.
      success: terminalSnapshot.status === "succeeded",
      text: terminalSnapshot.resultText ?? terminalSnapshot.terminalMessage ?? "Run ended.",
      terminalReason: terminalSnapshot.terminalReason,
    });
    try { await saveRun(record); } catch {
      try { await saveRun(record); } catch { /* give up after retry */ }
    }
  } catch { void 0; }
  // Flush any snapshot still in the coalescing buffer so the panel's next
  // open (and any crash recovery) sees the authoritative terminal state.
  try { await flushRunSnapshot(); } catch { void 0; }
  try { void maybeReleaseKeepAwake(); } catch { void 0; }
  clearVisionCache();
  if (isScheduledTaskRun) {
    try { await teardownScheduledVision(); } catch { void 0; }
  } else {
    try {
      const { visionMode, enableLocalVision } = await chrome.storage.local.get(["visionMode", "enableLocalVision"]);
      const mode = (visionMode as string) || (enableLocalVision === true ? "always" : "disabled");
      if (mode !== "always") await teardownScheduledVision();
    } catch { void 0; }
  }
  try {
    void import("./run-notifications")
      .then((m) => m.fireNotifications(task, terminalSnapshot.status === "succeeded"))
      .catch(() => { void 0; });
  } catch { void 0; }
  // The run is over — stop publishing its abort signal so a DETECT_VISUAL
  // arriving between runs doesn't short-circuit against a stale controller.
  clearCurrentRunAbortSignal(abortSignal);
  // A successor run may start only after predecessor teardown can no longer
  // mutate shared vision/signal state.
  releaseRunGuard();
}

export async function initRunState(runState: RunState): Promise<void> {
  if (!runState.runId) throw new Error("run-state initialization requires runId");
  await runSessionState.initialize(runState as RunState & { runId: string });
  await startKeepalive();
}
