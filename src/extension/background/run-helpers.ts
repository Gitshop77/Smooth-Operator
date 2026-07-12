/**
 * background/run-helpers.ts — helpers extracted from `startRun` so the
 * top-level run-lifecycle function stays readable.
 *
 * Five concerns live here:
 *
 *   1. Vision-assistant singleton state + lazy init (`ensureVisionAssistantInit`,
 *      `getVisionElementRect`). Owned here so the SW has a single source of
 *      truth for vision-init race handling.
 *   2. `extractStateForRun` — the 125-line callback passed to the orchestrator
 *      as `extractState`. Hydrates the active tab + (optionally) merges local
 *      vision detections into the DOM element list.
 *   3. `wireAbortController` — creates the AbortController used to cancel a
 *      run + the storage-change listener that fires `controller.abort()` when
 *      the side panel writes `abortRequested: true`.
 *   4. `buildLoopDeps` — constructs the `LoopDeps` config object (extractState,
 *      executeActions, navigatorCall, …) passed to `runAgentLoop`.
 *   5. `cleanupRun` — the finally-block teardown (release guard flag, stop
 *      keepalive, persist run record, release vision resources, fire
 *      notifications). Each step is best-effort so one failure can't strand
 *      the run state.
 */

import { runAgentLoop } from "@/lib/agent/loop/orchestrator";
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
  type RunState,
} from "./state-store";
import {
  listTabs,
  ensureContent,
  extractStateFromTab,
  executeActionsInTab,
  waitForTabLoad,
  handleTabAction,
} from "./tab-manager";
import { navigatorCallDirect, plannerCallDirect } from "../llm-direct";
import type { VisionAssistant } from "../vision-assistant";
import { DEFAULT_MODELS } from "../provider-config";
import { getDefaultModelForProvider } from "@/lib/agent/llm/catalog";

// ─── Vision Assistant singleton (lazy, non-blocking init) ───────────────────
//
// The 2.1 GB ONNX model download can take 5+ minutes. Awaiting `init()` in
// `extractState` would block the FIRST navigator step on the full download,
// leaving the side panel silent (no AGENT_EVENT messages) for minutes and
// risking an MV3 service-worker termination. Instead:
//
//   1. `ensureVisionAssistantInit()` is FIRE-AND-FORGET — it kicks off
//      `init()` in the background and returns immediately. The first step
//      (and every subsequent step while init is in-flight) degrades
//      gracefully to DOM-only extraction via `extractStateFromTab(...)`.
//   2. The `visionInitPromise` is shared across concurrent `extractState`
//      calls so two near-simultaneous calls don't double-init (which would
//      download the 2.1 GB model twice and race on Cache Storage writes).
//   3. `visionInitFailed` is a permanent flag — once init fails (WebGPU
//      unavailable, disk full, ONNX compile error, …), we stop retrying
//      every step. The user must toggle the `enableLocalVision` setting
//      off+on (or restart the SW) to retry. Without this flag, every step
//      would re-attempt the doomed download forever.
//   4. Mid-run inference failures are handled separately — `detect()` is
//      wrapped in `.catch(() => [])` so a single bad inference degrades
//      to "no vision detections this step" rather than killing the run.

let globalVisionAssistant: VisionAssistant | null = null;
let visionInitPromise: Promise<void> | null = null;
let visionInitFailed = false;

/**
 * Lazily initialize the vision assistant in the BACKGROUND. Idempotent —
 * concurrent calls share the same init promise. Permanently marks init as
 * failed on error so we don't retry a 2.1 GB download every step.
 *
 * This function is INTENTIONALLY not awaited by `extractState` — it returns
 * immediately so the agent loop can continue with DOM-only state while the
 * model downloads in the background.
 */
function ensureVisionAssistantInit(): void {
  if (globalVisionAssistant || visionInitPromise || visionInitFailed) return;
  visionInitPromise = (async () => {
    try {
      const { VisionAssistant: VA } = await import("../vision-assistant");
      const va = new VA();
      await va.init();
      globalVisionAssistant = va;
    } catch (e) {
      console.warn(
        "[vision-assistant] init failed — disabling Local Vision for this session:",
        e,
      );
      visionInitFailed = true;
      // Emit a one-time LogEvent so the side panel surfaces the failure to the
      // user. Without this, the only signal is a `console.warn` in the service
      // worker (invisible to the user) — the Options page's vision-status
      // badge shows "✓ Ready" because it lives in a SEPARATE context (Options
      // page has its own VisionAssistant instance). The user sees the LLM
      // degrading to text-only with no explanation.
      try {
        chrome.runtime
          .sendMessage({
            type: "AGENT_EVENT",
            event: {
              type: "info",
              message:
                "Local Vision init failed — vision detections disabled for this run.",
            },
            time: new Date().toLocaleTimeString("en-GB", { hour12: false }),
          })
          .catch(() => {
            /* side panel may not be open — non-fatal */
          });
      } catch {
        /* chrome.runtime may be unavailable during SW teardown — non-fatal */
      }
    } finally {
      visionInitPromise = null;
    }
  })();
}

// Cache of vision-detected elements for the current step (visionId → pixel rect + label)
// Used by the click handler to resolve [v1], [v2] etc. to CDP coordinate clicks.
// The cache key is the BARE vision id (e.g. "v1", no brackets) — this matches
// what the click handler sends in `visionIndex` (the LLM-emitted `index`
// string, also bare).
const visionElementsCache = new Map<string, { x: number; y: number; width: number; height: number; label: string }>();

// The URL the vision cache was populated for. `detect_visual` captures a
// screenshot at one URL; if the page navigates before the LLM clicks [vN],
// the cached pixel rects are stale and a CDP click at those coordinates
// would land on whatever element happens to be at those coordinates on the
// NEW page (could be a delete/payment button). `extractStateForRun` checks
// this against `domState.url` and clears the cache on mismatch.
let visionCacheUrl = "";

// Track the last known DPR for adaptive vision coordinate scaling.
// Updated in extractStateForRun from domState.devicePixelRatio.
let lastKnownDpr = 1;

/**
 * Get a vision-detected element's pixel rect by its BARE vision id
 * (e.g. `"v1"`, NO brackets). The cache is populated by `extractStateForRun`
 * using the bare `visionId` field from each `MergedElement`, and the click
 * handler sends the bare LLM-emitted `index` string (e.g. `"v1"`) — so the
 * lookup key is consistently the bare form, never `"[v1]"`.
 *
 * @returns The cached CSS-pixel rect (viewport-relative) or `undefined` if
 *          no vision element with that id was detected this step.
 */
export function getVisionElementRect(
  visionId: string,
): { x: number; y: number; width: number; height: number; label: string } | undefined {
  return visionElementsCache.get(visionId);
}

/**
 * Reset the SW-side Vision init-failed flag at the start of each new run so
 * the next `ensureVisionAssistantInit()` call retries the (previously-failed)
 * init. The flag is set permanently on init failure to avoid re-attempting a
 * 2.1 GB model download every step within a single run — but it SHOULD be
 * retried on the NEXT run, in case the failure was transient (disk full,
 * WebGPU context exhausted, SW-terminating OOM, …). Only resets if no init
 * is currently in-flight — otherwise the in-flight promise's own finally
 * block will set the flag correctly and we'd race it.
 */
export function resetVisionInitFlagForNewRun(): void {
  if (!visionInitPromise) visionInitFailed = false;
}

/**
 * Clear the vision elements cache at the start of each new run.
 * `cleanupRun` releases the run guard BEFORE it clears the cache, so a new
 * run could start in the gap and read stale `[vN]` entries from the prior
 * run. This clear is the authoritative "clean slate" — idempotent with the
 * cleanupRun clear (double-clear is a no-op).
 */
export function clearVisionElementsCacheForNewRun(): void {
  visionElementsCache.clear();
  visionCacheUrl = "";
}

/**
 * Tear down the vision assistant after a scheduled-task run so it doesn't
 * hold GPU resources while the user is doing other work. The model will
 * re-initialize (fire-and-forget) on the next run that needs it. Resets the
 * init promise + failure flag so the next run retries from scratch.
 */
export async function teardownScheduledVision(): Promise<void> {
  if (globalVisionAssistant) {
    await globalVisionAssistant.cleanup();
    globalVisionAssistant = null;
    visionInitPromise = null;
    visionInitFailed = false; // Reset so next run can retry
  }
}

// ─── Adaptive vision (AI Adaptive mode) ──────────────────────────────────────
//
// In adaptive mode, the vision model loads on the first `detect_visual` call
// and unloads after ADAPTIVE_VISION_IDLE_STEPS consecutive steps without a
// detect_visual call. This saves ~90% of VRAM + inference time compared to
// always-on mode, at the cost of ~100 extra tokens/step for the tool description.

/** Steps without a detect_visual call before adaptive vision unloads. */
const ADAPTIVE_VISION_IDLE_STEPS = 5;

let adaptiveVisionLastUsedStep = -1;
let adaptiveVisionCurrentStep = 0;

/** Track the current step for adaptive idle-unload (called from orchestrator). */
export function trackAdaptiveVisionStep(step: number): void {
  adaptiveVisionCurrentStep = step;
  if (
    globalVisionAssistant &&
    adaptiveVisionLastUsedStep >= 0 &&
    step - adaptiveVisionLastUsedStep > ADAPTIVE_VISION_IDLE_STEPS
  ) {
    // Null synchronously BEFORE cleanup so concurrent detect_visual calls
    // see null and return "loading" instead of calling .detect() on a
    // partially-torn-down instance.
    const va = globalVisionAssistant;
    globalVisionAssistant = null;
    visionInitPromise = null;
    visionInitFailed = false;
    void va.cleanup().catch((e) => console.warn("[vision] cleanup failed (VRAM may leak):", e));
  }
}

/**
 * Handle a `detect_visual` request from the content script. Runs the vision
 * detection on the current screenshot, caches results for the next step's
 * extractStateForRun, and returns a description of detected elements.
 */
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
  if (!globalVisionAssistant?.isReady) {
    return { ok: false, error: "Vision assistant is still loading — try again on the next step" };
  }
  try {
    // Capture the AGENT'S tab (runState.currentTabId), not the user's visible
    // tab. Using `captureVisibleTab(WINDOW_ID_CURRENT)` would capture whichever
    // tab the user was viewing — if they'd switched tabs mid-run, vision
    // detections + cached pixelRects would be for the WRONG page. When the
    // agent later clicked `[vN]`, the CDP_CLICK handler read the cached rect
    // and clicked at those coordinates in the agent's tab → silent misclicks
    // on whatever happened to be at those coordinates (could be a
    // delete/payment button). Same bug class as the SCREENSHOT handler.
    // `detect_visual` is an explicit action (not per-step), so the one-shot
    // CDP attach/detach pattern applies.
    const s = await getRunState();
    const tabId = s?.currentTabId;
    if (!tabId) {
      return { ok: false, error: "no active run — cannot determine agent tab for screenshot" };
    }
    const screenshotDataUrl = await captureTabScreenshot(tabId);
    const visionDetections = await globalVisionAssistant.detect(screenshotDataUrl).catch((e: unknown) => { console.warn("[vision] detect failed (falling back to no detections):", e); return []; });
    // Cache vision elements for the next step's extractStateForRun
    visionElementsCache.clear();
    visionCacheUrl = ""; // reset before re-population (in case tab get fails below)
    const { mergeDetections } = await import("../vision-assistant");
    // Use lastKnownDpr (updated by extractStateForRun) — vision detections
    // from captureVisibleTab are in device pixels; the merger divides by dpr
    // to produce CSS-pixel rects for CDP clicks.
    const merged = mergeDetections([], visionDetections, lastKnownDpr);
    for (const m of merged) {
      if (m.source === "vision" && m.pixelRect && m.visionId) {
        visionElementsCache.set(m.visionId, { ...m.pixelRect, label: m.text });
      }
    }
    // Record the URL the cache was populated for so `extractStateForRun`
    // can detect a stale cache after navigation. Best-effort — if the tab
    // query fails, leave `visionCacheUrl` as "" (which never matches, so
    // the cache is treated as stale and cleared on the next extract).
    try {
      const tab = await chrome.tabs.get(tabId);
      visionCacheUrl = tab.url ?? "";
    } catch {
      /* tab may have closed — leave visionCacheUrl as "" */
    }
    // Build the description from the MERGED vision elements (not the raw
    // `visionDetections` array) so the `[vN]` index printed to the LLM exactly
    // matches the `visionId` key used to populate `visionElementsCache` below
    // (finding: the description used a sequential `i+1` index that could
    // diverge from the cached `visionId`, producing clicks on the wrong
    // element). `merged` is the same array the cache loop iterates.
    const visionEls = merged.filter((m) => m.source === "vision" && m.visionId && m.pixelRect);
    const descriptions = visionEls.map((m) => {
      const r = m.pixelRect as { x: number; y: number; width: number; height: number };
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

// ─── extractStateForRun ─────────────────────────────────────────────────────

/**
 * The 125-line `extractState` callback passed to `runAgentLoop`. Hydrates the
 * active tab's DOM state via `extractStateFromTab`, and (when Local Vision is
 * enabled + the main LLM is text-only) merges local vision detections into
 * the element list so the agent can click vision-only elements.
 *
 * @param fallbackTabId The tab id captured at run start; used when the
 *                      persisted RunState can't be read (e.g. storage race).
 * @param tabs          The orchestrator's tab snapshot (passed by runAgentLoop).
 */
export async function extractStateForRun(
  fallbackTabId: number,
  tabs: TabInfo[],
): Promise<BrowserState> {
  const s = await getRunState();
  const tabId = s?.currentTabId ?? fallbackTabId;
  // Track adaptive vision step for idle-unload (no-op if not adaptive)
  if (s) trackAdaptiveVisionStep(s.step);
  const { model, provider: providerId, enableLocalVision, enableScreenshots: storedEnableScreenshots, visionMode: storedVisionMode } = await chrome.storage.local.get([
    "model", "provider", "enableLocalVision", "enableScreenshots", "visionMode",
  ]);

  // Determine vision capability of the main LLM.
  //
  // IMPORTANT: apply the SAME default-model resolution that `buildProvider()`
  // (provider-config.ts) does — otherwise an empty `model` field would
  // disagree with the LLM-side check in `navigatorCallDirect()` (which uses
  // `provider.supportsVision` after default resolution). That disagreement
  // caused the screenshot gating to flip-flop: extractState thought "no
  // vision" and skipped `captureVisibleTab`, while navigatorCallDirect
  // thought "vision" and tried to embed a non-existent screenshot. Both
  // ended up text-only, but the user lost the vision feature they expected
  // from a default GPT-4o model.
  let mainModelVision = false;
  try {
    const { modelSupportsVision } = await import("@/lib/agent/llm/catalog");
    const { CATALOG_PROVIDER_ID_MAP } = await import("../provider-config-map");
    const catId = CATALOG_PROVIDER_ID_MAP[providerId as string] ?? providerId;
    // Resolve the model: explicit user choice > live catalog default >
    // offline DEFAULT_MODELS fallback. `catId` maps the extension's provider id
    // to the models.dev catalog provider id (e.g. "gemini" -> "google").
    const resolvedModel =
      (model as string) ||
      (await getDefaultModelForProvider(catId as string)) ||
      DEFAULT_MODELS[providerId as string] ||
      "";
    mainModelVision = await modelSupportsVision(resolvedModel, catId as string);
  } catch (e) { console.warn("[vision] catalog/model load failed (vision disabled for this step):", e); }

  const includeScreenshot = mainModelVision && (storedEnableScreenshots ?? true);

  // Resolve the vision mode. Backward compat: if `visionMode` is unset but
  // `enableLocalVision` is true, treat as "always". Otherwise use the stored
  // mode or default to "disabled".
  const visionMode = (storedVisionMode as string) ||
    (enableLocalVision === true ? "always" : "disabled");

  // Local vision is used when the main LLM is effectively text-only — either
  // the model has no vision capability, OR the user disabled screenshots (so
  // even a vision model works as text-only + DOM).
  const effectiveTextOnly = !mainModelVision || !includeScreenshot;
  const useAlwaysOnVision = visionMode === "always" && effectiveTextOnly;
  const useAdaptiveVision = visionMode === "adaptive" && effectiveTextOnly;

  if (!useAlwaysOnVision) {
    // Adaptive mode: DOM-only + cached vision elements from detect_visual
    if (useAdaptiveVision && visionElementsCache.size > 0) {
      const domState = await extractStateFromTab(tabId, tabs, false);
      const dpr = domState.devicePixelRatio ?? 1;
      lastKnownDpr = dpr;
      // Stale-cache guard: if the page navigated since `detect_visual`
      // populated the cache, the cached pixel rects are for the OLD page.
      // Merging them into the new page's DOM state would make a subsequent
      // CDP click on [vN] land at the old coordinates on the new page —
      // potentially a delete/payment button. Clear the cache and fall
      // through to DOM-only state instead. URL comparison is exact; a
      // fragment-only change (#anchor) doesn't invalidate the cache
      // because the viewport layout is unchanged.
      if (visionCacheUrl && domState.url && stripUrlFragment(domState.url) !== stripUrlFragment(visionCacheUrl)) {
        visionElementsCache.clear();
        visionCacheUrl = "";
      } else {
        // Merge cached vision elements into the DOM state
        const { mergeDetections, renderMergedElementsText } = await import("../vision-assistant");
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
        // Add cached vision entries that weren't deduped by the merger
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
    // Clear stale vision cache when adaptive is active but no cached elements
    if (useAdaptiveVision) {
      visionElementsCache.clear();
      visionCacheUrl = "";
    }
    // Read DPR even in the no-cache adaptive branch so `lastKnownDpr` is
    // correct for the FIRST step's detect_visual call. Without this, a
    // detect_visual on step 1 would use lastKnownDpr=1 (default) on a 2× Retina
    // display → vision detections stay in device pixels → CDP clicks at 2×
    // coordinates → silent misclicks.
    const domStateNoVision = await extractStateFromTab(tabId, tabs, includeScreenshot);
    lastKnownDpr = domStateNoVision.devicePixelRatio ?? 1;
    return domStateNoVision;
  }

  // Kick off the (potentially lengthy — 2.1 GB download) vision assistant
  // init in the BACKGROUND. The first step falls back to DOM-only while the
  // model downloads; subsequent steps pick up the ready assistant once
  // `init()` resolves. Non-blocking by design — see `ensureVisionAssistantInit`.
  ensureVisionAssistantInit();

  // Init still pending (or permanently failed) — fall back to DOM-only.
  // We pass `false` for `includeScreenshot` because this branch is only
  // reached when `useLocalVision` is true, which requires `!mainModelVision`
  // — i.e. the main model is text-only and can't consume a screenshot anyway.
  if (!globalVisionAssistant?.isReady) {
    return extractStateFromTab(tabId, tabs, false);
  }

  // PARALLEL: DOM extraction + local vision detection
  try {
    const { mergeDetections, renderMergedElementsText } =
      await import("../vision-assistant");

    // Capture the AGENT'S tab (runState.currentTabId), not the user's visible
    // tab. `chrome.tabs.captureVisibleTab(WINDOW_ID_CURRENT)` would capture
    // whichever tab the user is currently viewing — if they'd switched tabs
    // mid-run, vision detections + cached pixelRects would be for the WRONG
    // page, and the CDP_CLICK handler would then click coordinates in the
    // agent's tab → silent misclicks (the delete/payment-button hazard). Use
    // the dedicated per-tab helper, exactly like handleDetectVisualRequest.
    const screenshotDataUrl = await captureTabScreenshot(tabId);

    // Run DOM extraction + vision detection in parallel. The vision `.detect()`
    // call is wrapped in `.catch(() => [])` so a model inference failure (OOM,
    // ONNX crash, …) degrades to "no vision detections" rather than killing
    // the whole extract — the merger then returns the DOM-only state unchanged.
    const [domState, visionDetections] = await Promise.all([
      extractStateFromTab(tabId, tabs, false),
      globalVisionAssistant.detect(screenshotDataUrl).catch((e: unknown) => { console.warn("[vision] detect failed (falling back to no detections):", e); return []; }),
    ]);

    // The content script stashes the tab's `devicePixelRatio` on the
    // serialized state (see content.ts:EXTRACT_STATE) so we can scale vision
    // detections from device pixels → CSS pixels before merging.
    // `getBoundingClientRect()` rects are CSS pixels; the screenshot is device
    // pixels — without this scale, IoU dedup AND CDP click coordinates would
    // both be off by the DPR factor.
    const dpr = domState.devicePixelRatio ?? 1;
    lastKnownDpr = dpr; // Track for adaptive vision coordinate scaling

    // Merge DOM elements + vision detections. The merged list contains both
    // DOM-source elements (positive `index`) and vision-source elements
    // (`index: -1`, with a `visionId` like "v1"). The cast through `unknown`
    // is necessary because `MergedElement` carries extra fields (`source`,
    // `pixelRect`, `indexStr`, `visionId`) that `ExtractedElement` doesn't
    // have — the merged list is a strict superset, and the orchestrator only
    // reads the standard fields.
    const merged = mergeDetections(domState.elements, visionDetections, dpr);

    // Preserve the DOM extractor's original `newElementCount` (which counts
    // elements with new hashes since the last step) and ADD the vision-only
    // detections — every vision element is "new" by definition (it has no
    // DOM counterpart to have appeared last step).
    const visionNewCount = merged.filter((m) => m.source === "vision").length;
    domState.elements = merged as unknown as typeof domState.elements;
    domState.elementsText = renderMergedElementsText(merged);
    domState.newElementCount = domState.newElementCount + visionNewCount;

    // Cache vision elements for click resolution. The cache key is the BARE
    // vision id (e.g. "v1", no brackets) — this matches what the click
    // handler sends in `visionIndex` (which is the LLM-emitted `index`
    // string, also bare). The cached rect is already in CSS pixels (the
    // merger divided by DPR), so the CDP click handler can pass it straight
    // to `Input.dispatchMouseEvent`.
    visionElementsCache.clear();
    visionCacheUrl = domState.url; // always-on re-detects every step; cache is always fresh
    for (const m of merged) {
      if (m.source === "vision" && m.pixelRect && m.visionId) {
        visionElementsCache.set(m.visionId, { ...m.pixelRect, label: m.text });
      }
    }

    return domState;
  } catch (e) {
    // Vision assistant failed — graceful fallback to DOM-only
    console.warn("[vision-assistant] failed, falling back to DOM-only:", e);
    return extractStateFromTab(tabId, tabs, false);
  }
}

// ─── wireAbortController ────────────────────────────────────────────────────

export interface AbortWiring {
  controller: AbortController;
  onStorageChanged: (changes: { [k: string]: chrome.storage.StorageChange }, area: string) => void;
}

/**
 * Create an AbortController + a `chrome.storage.onChanged` listener that
 * fires `controller.abort()` when the side panel writes
 * `abortRequested: true` to session storage. Listener registration happens
 * on the area-aware `chrome.storage.onChanged` (rather than
 * `chrome.storage.session.onChanged`, whose listener type is single-arg in
 * `@types/chrome`) — the callback filters by `area !== "session"` so the
 * effective behavior is identical.
 *
 * The caller is responsible for `chrome.storage.onChanged.removeListener(
 * wiring.onStorageChanged)` in the finally block (see `cleanupRun`).
 */
export function wireAbortController(): AbortWiring {
  const controller = new AbortController();
  const onStorageChanged = (changes: { [k: string]: chrome.storage.StorageChange }, area: string): void => {
    if (area !== "session") return;
    const c = changes[RUN_STATE_KEY];
    if (c?.newValue?.abortRequested) controller.abort();
  };
  chrome.storage.onChanged.addListener(onStorageChanged);
  return { controller, onStorageChanged };
}

// ─── buildLoopDeps ──────────────────────────────────────────────────────────

export interface LoopDepsContext {
  /** Tab captured at run start — used as a fallback when RunState is unreadable. */
  tab: chrome.tabs.Tab;
  /** Stream a LogEvent to the side panel + RunBuilder. */
  sendEvent: (event: LogEvent) => void;
  /** AbortController wired by `wireAbortController`. */
  controller: AbortController;
  /** Run-time config resolved from chrome.storage.local. */
  config: {
    maxSteps: number;
    maxActionsPerStep: number;
    plannerInterval: number;
    maxFailures: number;
    costCapUsd: number;
  };
  /** Original task + mode (forwarded to runAgentLoop). */
  task: string;
  mode: AgentMode;
  /** Optional metrics callback (Phase 8). */
  callbacks?: NonNullable<Parameters<typeof runAgentLoop>[0]["callbacks"]>;
}

/**
 * Construct the `LoopDeps` config object passed to `runAgentLoop`. Wires the
 * extension-side extract/execute/navigate helpers + the abort signal + the
 * confirmation/challenge/pause hooks. Returns the object literal so `startRun`
 * stays a thin orchestrator.
 */
export function buildLoopDeps(ctx: LoopDepsContext): Parameters<typeof runAgentLoop>[0] {
  const { tab, sendEvent, controller, config, task, mode, callbacks } = ctx;
  const fallbackTabId = tab.id!;
  return {
    task,
    mode,
    callbacks,
    config,
    // Wire extension-side extract/execute helpers into the orchestrator so it
    // doesn't try to call the in-page extractor (which needs DOM access the
    // service worker doesn't have).
    extractState: async (tabs) => extractStateForRun(fallbackTabId, tabs),
    // CRITICAL: route action execution through the content script. The
    // orchestrator's built-in `executeActionQueue` calls `executeAction` in
    // the service worker context, where `document`, `window`, and `history`
    // are undefined and `state.selectorMap` is `{}` (HTMLElement refs don't
    // survive JSON serialization across the message channel). Routing to
    // `executeActionsInTab` ships the actions to the content script, which
    // has a valid selectorMap populated by the most recent EXTRACT_STATE
    // call and DOM access for click/input/scroll/etc.
    executeActions: async (actions, _state): Promise<ActionResult[]> => {
      const s = await getRunState();
      const tabId = s?.currentTabId ?? fallbackTabId;
      const agentMode = s?.mode ?? mode;

      // Enforce mode restrictions + confirmation gates BEFORE forwarding to
      // the content script. The orchestrator's executeActionQueue does this
      // internally, but when deps.executeActions is provided (which it always
      // is in the extension), executeActionQueue is bypassed — so the gate
      // must be applied here to preserve the SECURITY.md trust model.
      const { checkActionAllowed, requiresConfirmation } = await import("@/lib/agent/modes");
      // Build one ActionResult per input action so the orchestrator's history
      // alignment always holds (finding: executeActions returned a misaligned /
      // truncated ActionResult array when an action was blocked or declined —
      // the actions AFTER the block got no result, breaking per-action storage
      // + the success-rate tally). We keep a blocked/declined action (and every
      // subsequent action) as a BLOCKED result, and only the contiguous leading
      // run of allowed+confirmed actions is shipped to the content script.
      const preResults: ActionResult[] = [];
      const filtered: AgentAction[] = [];
      let aborted = false;
      for (const action of actions) {
        if (aborted) {
          // A prior action in the batch was blocked/declined — abort the rest
          // of the queue (the selectorMap context is invalidated) but still
          // emit a result so alignment is preserved.
          preResults.push({
            action, success: false,
            message: "BLOCKED: prior action in the queue was blocked or declined",
          });
          continue;
        }
        const allowed = checkActionAllowed(action.type, agentMode);
        if (!allowed.allowed) {
          preResults.push({
            action, success: false,
            message: `BLOCKED: ${allowed.reason}`,
          });
          // Abort the remaining queue — a blocked action invalidates the
          // selectorMap context for subsequent actions.
          aborted = true;
          continue;
        }
        if (requiresConfirmation(action.type, agentMode)) {
          try {
            const { askHuman } = await import("@/lib/agent/human-interaction");
            const resp = await askHuman({
              mode: "confirm",
              message: `Allow the agent to perform: ${action.type}?`,
            });
            if (resp.mode !== "confirm" || !resp.confirmed) {
              preResults.push({
                action, success: false,
                message: `BLOCKED: user declined confirmation for ${action.type}`,
              });
              aborted = true;
              continue;
            }
          } catch {
            preResults.push({
              action, success: false,
              message: `BLOCKED: confirmation request failed for ${action.type}`,
            });
            aborted = true;
            continue;
          }
        }
        filtered.push(action);
      }

      // If all actions were blocked, return the aligned pre-results without
      // messaging the content script.
      if (filtered.length === 0) {
        return preResults;
      }

      // Execute the filtered actions via the content script. `preResults`
      // already holds one entry for every blocked/declined action, so the
      // concatenation yields exactly one ActionResult per input action.
      const execResults = await executeActionsInTab(tabId, filtered);
      return [...preResults, ...(execResults as ActionResult[])];
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
      if (!s) return;
      await waitForTabLoad(s.currentTabId);
      await ensureContent(s.currentTabId);
    },
    settleDelayMs: 500,
    // Wire the confirmation gate. When the orchestrator encounters an action
    // in the mode's confirmRequired list, it calls this callback. We dispatch
    // to askHumanExtension(), which sends a HUMAN_INTERACT message to the
    // side panel and waits for the user's response.
    requestConfirmation: async (action) => {
      try {
        const { askHuman } = await import("@/lib/agent/human-interaction");
        const resp = await askHuman({
          mode: "confirm",
          message: `Allow the agent to perform: ${action.type}?`,
        });
        return resp.mode === "confirm" ? resp.confirmed : false;
      } catch {
        return false;
      }
    },
    // Anti-bot challenge detection + resolution. Assembled in `antibot.ts` so
    // the logic stays isolated from the rest of the run lifecycle; see that
    // module for the details. The signatures match `LoopDeps` exactly.
    ...makeAntiBotHooks(),
    // Pause check. Reads the `paused` flag from chrome.storage.session (set
    // by the side panel's Pause button). When true, the orchestrator emits a
    // `paused` event + polls this callback until it returns false.
    checkPaused: async () => {
      try {
        const res = await chrome.storage.session.get("open_cowork_paused");
        return !!res.open_cowork_paused;
      } catch {
        return false;
      }
    },
    // Page-HTML extractor for the HTML-content evaluator. Fetches the
    // current tab's outerHTML via the content script's EXTRACT_HTML message
    // (a small content-script handler). Best-effort — returns "" on any
    // failure.
    getPageHtml: async () => {
      try {
        const s = await getRunState();
        if (!s) return "";
        const res = await chrome.tabs.sendMessage(s.currentTabId, { type: "EXTRACT_HTML" });
        if (res?.ok && typeof res.html === "string") return res.html;
        return "";
      } catch {
        return "";
      }
    },
    // Current-URL fetcher for the URL evaluator. Reads the active tab's URL
    // via chrome.tabs (more authoritative than the last-observed URL when
    // the page may have redirected).
    getCurrentUrl: async () => {
      try {
        const s = await getRunState();
        if (!s) return "";
        const t = await chrome.tabs.get(s.currentTabId);
        return t.url ?? "";
      } catch {
        return "";
      }
    },
  };
}

// ─── cleanupRun ─────────────────────────────────────────────────────────────

export interface CleanupContext {
  runBuilder: RunBuilder;
  task: string;
  isScheduledTaskRun: boolean;
  onStorageChanged: AbortWiring["onStorageChanged"];
  sendEvent: (event: LogEvent) => void;
  /** True iff the orchestrator emitted a `done` event with `success: true`. */
  runSucceeded: boolean;
  /** Callback that releases the synchronous RUN-guard flag (set in startRun). */
  releaseRunGuard: () => void;
  /**
   * For scheduled-task runs, tear down the vision assistant (free GPU
   * resources between scheduled runs). For manual runs, leave it loaded so
   * the next user-initiated run has lower latency.
   */
  teardownScheduledVision: () => Promise<void>;
}

/**
 * The finally-block teardown. Each step is wrapped in its own try/catch so
 * one failure doesn't block the others — all are best-effort.
 *
 * Critical ordering: `releaseRunGuard` runs FIRST so a transient storage
 * rejection can't strand the run. If `stopKeepalive`/`clearRunState` ran
 * before the guard release and either threw, the guard would stick `true`
 * and every subsequent RUN message would be rejected with "already starting",
 * permanently DoSing the extension until the SW was restarted.
 */
export async function cleanupRun(ctx: CleanupContext): Promise<void> {
  const { runBuilder, task, isScheduledTaskRun, onStorageChanged, sendEvent, runSucceeded, releaseRunGuard, teardownScheduledVision } = ctx;

  releaseRunGuard();

  // Wrap removeListener in try/catch. If chrome.storage.onChanged throws
  // (rare, but possible during SW teardown), the subsequent cleanup steps
  // (stopKeepalive, clearRunState, saveRun, …) would be skipped — leaving
  // the run state stuck active and the keepalive alarm armed.
  try {
    chrome.storage.onChanged.removeListener(onStorageChanged);
  } catch {
    /* chrome.storage may be unavailable during SW teardown */
  }

  try {
    await stopKeepalive();
  } catch {
    /* alarms API may be unavailable during SW teardown */
  }
  try {
    await clearRunState();
  } catch {
    /* chrome.storage.session may transiently reject during teardown */
  }
  // Clear the "▶" badge that was set when the scheduled-task run started
  // (see task-queue.ts:handleScheduledTaskFire). Without this the badge
  // stays green indefinitely after the run finishes, making it look like a
  // task is still running. Safe to call unconditionally — manual runs
  // (started from the side panel) don't set the badge, so clearing it is a
  // no-op there.
  try {
    chrome.action.setBadgeText({ text: "" });
  } catch {
    /* chrome.action may be unavailable in some test contexts */
  }
  // Emit a `done` event in `finally` so the side panel always resets to the
  // stopped state, even on exceptional exits. Wrap in try/catch — `sendEvent`
  // calls `chrome.runtime.sendMessage` (which can reject if the side panel is
  // closed — handled internally via `.catch(() => {})`) AND `runBuilder.addEvent`
  // (which can throw if the builder is in a bad state). If addEvent throws,
  // the subsequent cleanup steps (saveRun, maybeReleaseKeepAwake, vision
  // cleanup, fireNotifications) would be skipped — leaving the run state
  // stuck active.
  try {
    sendEvent({ type: "info", message: "Run finished." });
  } catch {
    /* sendEvent is best-effort; never crash the run cleanup */
  }
  // Persist the run record to chrome.storage.local for the Options → History
  // tab. RunBuilder.finish() seals the record with the final result. We pass
  // the actual `runSucceeded` flag (captured as `done` events flow through
  // sendEvent) so a successful run shows ✓ in the History tab. finish() is
  // idempotent — the RunBuilder also captures the `done` event internally;
  // both paths agree.
  try {
    const record = runBuilder.finish({ success: runSucceeded, text: "Run ended." });
    void saveRun(record).catch(() => {
      /* best-effort persistence — storage may be unavailable */
    });
  } catch {
    /* saveRun is best-effort; never crash the run cleanup */
  }
  // Release the system keep-awake lock IF no scheduled tasks are still armed.
  // The lock was acquired when the scheduled task's alarm was armed (see
  // scheduled-tasks.ts:scheduleAlarm) and re-acquired when the alarm fired
  // (see task-queue.ts:handleScheduledTaskFire). Releasing here covers "user
  // clicked Stop after a manual run" (no scheduled tasks → release). If
  // other scheduled tasks remain armed, the lock STAYS acquired so the
  // system doesn't sleep through the next alarm — `maybeReleaseKeepAwake`
  // checks the count internally.
  try {
    void maybeReleaseKeepAwake();
  } catch {
    /* best-effort */
  }
  // Clear the vision elements cache so stale [vN] entries don't bleed into
  // the next run (especially important for adaptive mode where detect_visual
  // populates the cache mid-run).
  visionElementsCache.clear();
  visionCacheUrl = "";
  // Clean up the vision assistant after a scheduled-task run OR an adaptive
  // vision run. In adaptive mode, vision unloads at run end (frees VRAM
  // between runs). In always-on mode, vision stays loaded for manual runs
  // (lower latency on next run) but unloads for scheduled runs (the SW
  // will die and release GPU anyway, but explicit cleanup is faster).
  if (isScheduledTaskRun) {
    try {
      await teardownScheduledVision();
    } catch {
      /* cleanup is best-effort */
    }
  } else {
    // For manual runs with adaptive vision, unload at run end.
    try {
      const { visionMode, enableLocalVision } = await chrome.storage.local.get(["visionMode", "enableLocalVision"]);
      const mode = (visionMode as string) || (enableLocalVision === true ? "always" : "disabled");
      if (mode !== "always") {
        await teardownScheduledVision();
      }
    } catch {
      /* storage unavailable — can't determine mode, leave loaded */
    }
  }
  // Fire notification + webhook on run completion. Dynamic import breaks the
  // circular dep with task-queue.ts (which calls startRun from
  // handleScheduledTaskFire).
  try {
    void import("./task-queue").then((m) => m.fireNotifications(task, runSucceeded)).catch(() => { /* non-fatal */ });
  } catch {
    /* dynamic import may fail during SW teardown — non-fatal */
  }
}

// ─── Run-setup helpers (settings + state hydration) ─────────────────────────

/**
 * Persist the initial RunState + arm the keepalive alarm. Wrapped in a
 * single try/catch by the caller — both calls MUST succeed before the run
 * starts so the side panel's STATUS probe sees the run as active.
 */
export async function initRunState(runState: RunState): Promise<void> {
  // Don't clobber an `abortRequested: true` flag that STOP may have set
  // between the RUN handler's `sendResponse` and this call. `saveRunState`
  // does a read-merge-write (`{...cur, ...state}`), and `runState` carries
  // an explicit `abortRequested: false`, so without this guard a STOP that
  // landed during that window would be silently overwritten. The caller
  // (`startRun`) re-reads the state after this returns and bails out if the
  // flag is set, so the run never actually starts.
  const existing = await getRunState();
  const state = existing?.abortRequested
    ? { ...runState, abortRequested: true }
    : runState;
  await saveRunState(state);
  await startKeepalive();
}
