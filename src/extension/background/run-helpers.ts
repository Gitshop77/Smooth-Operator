import type { LoopDeps } from "@/lib/agent/loop/types";
import type { ActionResult, AgentAction, BrowserState, LogEvent, TabInfo } from "@/lib/agent/types";
import type { AgentMode } from "@/lib/agent/modes";
import { RunBuilder, saveRun } from "@/lib/agent/run-history";
import { stripUrlFragment } from "./vision";
import { makeAntiBotHooks } from "./antibot";
import { captureTabScreenshot } from "./screenshots";
import {
  saveRunState,
  getRunState,
  clearRunState,
  RUN_STATE_KEY,
  startKeepalive,
  stopKeepalive,
  maybeReleaseKeepAwake,
  safeLog,
  type RunState,
} from "./state-store";
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
import { navigatorCallDirect, plannerCallDirect } from "../llm-direct";
import type { VisionAssistant } from "../vision-assistant";
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

function ensureVisionAssistantInit(): void {
  if (globalVisionAssistant || visionInitPromise || visionInitFailed) return;
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
        try {
          chrome.runtime.sendMessage({
            type: "AGENT_EVENT",
            event: { type: "info", message: "Local Vision init failed — vision detections disabled for this run." },
            time: new Date().toLocaleTimeString("en-GB", { hour12: false }),
          }).catch(() => {});
        } catch { /* chrome.runtime may be unavailable during SW teardown */ }
        return;
      }
    }
  })().finally(() => {
    visionInitPromise = null;
  });
}

let lastKnownDpr = 1;

export function resetVisionInitFlagForNewRun(): void {
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
  if (globalVisionAssistant) {
    await globalVisionAssistant.cleanup();
    globalVisionAssistant = null;
  }
  visionInitPromise = null;
  visionInitFailed = false;
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
    visionInitPromise = null;
    visionInitFailed = false;
    void va.cleanup().catch((e) => void safeLog("warn", "[vision] cleanup failed:", e));
  }
}

export async function handleDetectVisualRequest(query: string): Promise<{
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
  try {
    const s = await getRunState();
    const tabId = s?.currentTabId;
    if (!tabId) {
      return { ok: false, error: "no active run — cannot determine agent tab for screenshot" };
    }
    const screenshotDataUrl = await captureTabScreenshot(tabId);
    const visionDetections = await va.detect(screenshotDataUrl).catch((e: unknown) => { void safeLog("warn", "[vision] detect failed:", e); return []; });
    clearVisionCache();
    const { mergeDetections } = await loadVisionAssistant();
    const merged = mergeDetections([], visionDetections, lastKnownDpr);
    for (const m of merged) {
      if (m.source === "vision" && m.pixelRect && m.visionId) {
        visionElementsCache.set(m.visionId, { ...m.pixelRect, label: m.text });
      }
    }
    try {
      const tab = await chrome.tabs.get(tabId);
      setVisionCacheUrl(tab.url ?? "");
    } catch { /* tab may have closed */ }
    try {
      setVisionCacheFingerprint(await getPageFingerprint(tabId));
    } catch {
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
): Promise<BrowserState> {
  const s = await getRunState();
  const tabId = s?.currentTabId ? s.currentTabId : fallbackTabId;
  if (s) trackAdaptiveVisionStep(s.step);
  const vs = await getVisionSettings();
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

  const includeScreenshot = mainModelVision && Boolean(storedEnableScreenshots ?? true);
  const visionMode = (storedVisionMode as string) ||
    (enableLocalVision === true ? "always" : "disabled");
  const effectiveTextOnly = !mainModelVision || !includeScreenshot;
  const useAlwaysOnVision = visionMode === "always" && effectiveTextOnly;
  const useAdaptiveVision = visionMode === "adaptive" && effectiveTextOnly;

  if (!useAlwaysOnVision) {
    if (useAdaptiveVision && visionElementsCache.size > 0) {
      const domState = await extractStateFromTab(tabId, tabs, false);
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
    const domStateNoVision = await extractStateFromTab(tabId, tabs, includeScreenshot);
    lastKnownDpr = domStateNoVision.devicePixelRatio ?? 1;
    return domStateNoVision;
  }

  ensureVisionAssistantInit();
  const va = globalVisionAssistant;
  if (!va?.isReady) {
    return extractStateFromTab(tabId, tabs, false);
  }

  try {
    const { mergeDetections, renderMergedElementsText } = await loadVisionAssistant();
    const screenshotDataUrl = await captureTabScreenshot(tabId);
    const [domState, visionDetections] = await Promise.all([
      extractStateFromTab(tabId, tabs, false),
      va.detect(screenshotDataUrl, signal).catch((e: unknown) => { void safeLog("warn", "[vision] detect failed:", e); return []; }),
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
    void safeLog("warn", "[vision-assistant] failed, falling back to DOM-only:", e);
    return extractStateFromTab(tabId, tabs, false);
  }
}

interface AbortWiring {
  controller: AbortController;
  onStorageChanged: (changes: { [k: string]: chrome.storage.StorageChange }, area: string) => void;
}

export function wireAbortController(): AbortWiring {
  const controller = new AbortController();
  const onStorageChanged = (changes: { [k: string]: chrome.storage.StorageChange }, area: string): void => {
    if (area !== "session") return;
    const c = changes[RUN_STATE_KEY];
    if ((c?.newValue as { abortRequested?: boolean } | undefined)?.abortRequested) controller.abort();
  };
  chrome.storage.onChanged.addListener(onStorageChanged);
  return { controller, onStorageChanged };
}

interface LoopDepsContext {
  tab: chrome.tabs.Tab;
  sendEvent: (event: LogEvent) => void;
  controller: AbortController;
  config: {
    maxSteps: number;
    maxActionsPerStep: number;
    plannerInterval: number;
    maxFailures: number;
    costCapUsd: number;
  };
  task: string;
  mode: AgentMode;
  callbacks?: NonNullable<LoopDeps["callbacks"]>;
}

export function buildLoopDeps(ctx: LoopDepsContext): LoopDeps {
  const { tab, sendEvent, controller, config, task, mode, callbacks } = ctx;
  const fallbackTabId = tab.id!;
  return {
    task,
    mode,
    callbacks,
    config,
    extractState: async (tabs) => extractStateForRun(fallbackTabId, tabs, controller.signal),
    executeActions: async (actions, _state): Promise<ActionResult[]> => {
      const s = await getRunState();
      const tabId = s?.currentTabId ? s.currentTabId : fallbackTabId;
      const agentMode = s?.mode ?? mode;
      const { checkActionAllowed, requiresConfirmation } = await import("@/lib/agent/modes");
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
        const allowed = checkActionAllowed(action.type, agentMode);
        if (!allowed.allowed) {
          results[i] = { action, success: false, message: `BLOCKED: ${allowed.reason}` };
          aborted = true;
          continue;
        }
        if (requiresConfirmation(action.type, agentMode)) {
          try {
            const { askHuman } = await import("@/lib/agent/human-interaction");
            const resp = await askHuman({ mode: "confirm", message: confirmationMessage(action) });
            if (resp.mode !== "confirm" || !resp.confirmed) {
              results[i] = { action, success: false, message: `BLOCKED: user declined confirmation for ${action.type}` };
              aborted = true;
              continue;
            }
          } catch {
            results[i] = { action, success: false, message: `BLOCKED: confirmation request failed for ${action.type}` };
            aborted = true;
            continue;
          }
        }
        if (controller.signal.aborted || (await getRunState())?.abortRequested) {
          results[i] = { action, success: false, message: `BLOCKED: run aborted during confirmation for ${action.type}` };
          aborted = true;
          continue;
        }
        filtered.push({ action, i });
      }
      if (filtered.length === 0) return results;
      const execResults = (await executeActionsInTab(tabId, filtered.map((f) => f.action))) as ActionResult[];
      filtered.forEach((f, k) => { results[f.i] = execResults[k]; });
      for (let i = 0; i < results.length; i++) {
        if (!results[i]) {
          results[i] = { action: actions[i], success: false, message: "BLOCKED: missing result from content script" };
        }
      }
      return results;
    },
    navigatorCall: navigatorCallDirect,
    plannerCall: plannerCallDirect,
    getTabs: listTabs,
    onEvent: sendEvent,
    signal: controller.signal,
    onTabAction: async (action) => {
      const s = await getRunState();
      if (!s) return { handled: false, pageChanged: false };
      return handleTabAction(action, s, sendEvent);
    },
    waitForNavigation: async () => {
      const s = await getRunState();
      if (!s || !s.currentTabId) return;
      await waitForTabLoad(s.currentTabId);
      await ensureContent(s.currentTabId);
    },
    settleDelay: 500,
    requestConfirmation: async (action) => {
      try {
        const { askHuman } = await import("@/lib/agent/human-interaction");
        const resp = await askHuman({ mode: "confirm", message: confirmationMessage(action) });
        if (controller.signal.aborted || (await getRunState())?.abortRequested) return false;
        return resp.mode === "confirm" ? resp.confirmed : false;
      } catch { return false; }
    },
    ...makeAntiBotHooks(),
    checkPaused: async () => {
      try {
        const res = await chrome.storage.session.get("open_cowork_paused");
        return !!res.open_cowork_paused;
      } catch { return false; }
    },
    getPageHtml: async () => {
      try {
        const s = await getRunState();
        if (!s || !s.currentTabId) return "";
        const res = await sendMessageWithTimeout<{ ok: boolean; html?: string }>(s.currentTabId, { type: "EXTRACT_HTML" });
        if (res?.ok && typeof res.html === "string") return res.html;
        return "";
      } catch { return ""; }
    },
    getCurrentUrl: async () => {
      try {
        const s = await getRunState();
        if (!s || !s.currentTabId) return "";
        const t = await chrome.tabs.get(s.currentTabId);
        return t.url ?? "";
      } catch { return ""; }
    },
  };
}

interface CleanupContext {
  runBuilder: RunBuilder;
  task: string;
  isScheduledTaskRun: boolean;
  onStorageChanged: AbortWiring["onStorageChanged"];
  sendEvent: (event: LogEvent) => void;
  runSucceeded: boolean;
  releaseRunGuard: () => void;
  teardownScheduledVision: () => Promise<void>;
}

export async function cleanupRun(ctx: CleanupContext): Promise<void> {
  const { runBuilder, task, isScheduledTaskRun, onStorageChanged, sendEvent, runSucceeded, releaseRunGuard, teardownScheduledVision } = ctx;

  releaseRunGuard();

  try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch { void 0; }
  try { await stopKeepalive(); } catch { void 0; }
  try { await clearRunState(); } catch { void 0; }
  try { void chrome.action.setBadgeText({ text: "" }); } catch { void 0; }
  try { sendEvent({ type: "info", message: "Run finished." }); } catch { void 0; }
  try {
    const record = runBuilder.finish({ success: runSucceeded, text: "Run ended." });
    try { await saveRun(record); } catch {
      try { await saveRun(record); } catch { /* give up after retry */ }
    }
  } catch { void 0; }
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
  try { void import("./task-queue").then((m) => m.fireNotifications(task, runSucceeded)).catch(() => { void 0; }); } catch { void 0; }
}

export async function initRunState(runState: RunState): Promise<void> {
  const existing = await getRunState();
  const state = existing?.abortRequested ? { ...runState, abortRequested: true } : runState;
  await saveRunState(state);
  await startKeepalive();
}
