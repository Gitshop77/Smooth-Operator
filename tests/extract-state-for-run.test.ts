/**
 * extractStateForRun — tests for the 6 vision-merge branches.
 *
 * The function hydrates the active tab's DOM state and (when Local Vision is
 * enabled + the main LLM is text-only) merges local vision detections into
 * the element list.
 *
 * Branch map (from source at run-helpers.ts:543):
 *  1. useAlwaysOnVision=false, not adaptive → DOM-only (with/without screenshot)
 *  2. useAlwaysOnVision=false, adaptive, cache fresh → merge cached vision elements
 *  3. useAlwaysOnVision=false, adaptive, cache stale/empty → clear cache, DOM-only
 *  4. useAlwaysOnVision=true, vision assistant not ready → DOM-only (no screenshot)
 *  5. useAlwaysOnVision=true, vision assistant ready, try succeeds → parallel merge
 *  6. useAlwaysOnVision=true, try fails (catch) → DOM-only fallback
 *
 * Branches 5 & 6 need `globalVisionAssistant` to be set. The mock's `isReady`
 * is controllable via the hoisted `visionAssistantState` flag; the first call
 * in a test primes the fire-and-forget `ensureVisionAssistantInit` (the sync
 * guard sees a null global on that first call), and the second call reaches
 * the ready-state merge path.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Mock chrome global ──────────────────────────────────────────────────────

const sessionStore: Record<string, unknown> = {};
const localStore: Record<string, unknown> = {};

(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: vi.fn(async (key: unknown) => {
        if (typeof key === "string") return { [key]: localStore[key] };
        if (Array.isArray(key)) {
          const out: Record<string, unknown> = {};
          for (const k of key) out[k] = localStore[k];
          return out;
        }
        return { ...localStore };
      }),
    },
    session: {
      get: vi.fn(async (key: unknown) => {
        if (typeof key === "string") return { [key]: sessionStore[key] };
        if (Array.isArray(key)) {
          const out: Record<string, unknown> = {};
          for (const k of key) out[k] = sessionStore[k];
          return out;
        }
        return { ...sessionStore };
      }),
    },
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  runtime: {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  },
  tabs: {
    get: vi.fn().mockResolvedValue({ id: 1, url: "https://example.com", title: "Test" }),
  },
};

// ─── Mock all dependencies ───────────────────────────────────────────────────

vi.mock("@/lib/agent/llm/catalog", () => ({
  modelSupportsVision: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/extension/provider-config-map", () => ({
  CATALOG_PROVIDER_ID_MAP: {},
}));

vi.mock("@/extension/background/tab-manager", () => ({
  extractStateFromTab: vi.fn().mockResolvedValue({
    url: "https://example.com",
    title: "Test",
    tabs: [],
    elements: [],
    elementsText: "",
    pageInfo: "0.0 pages above, 0.0 pages below",
    newElementCount: 0,
    scrollTop: 0,
    scrollHeight: 1000,
    viewportHeight: 800,
    selectorMap: {},
    devicePixelRatio: 1,
  }),
  listTabs: vi.fn().mockResolvedValue([]),
  ensureContent: vi.fn().mockResolvedValue(undefined),
  executeActionsInTab: vi.fn().mockResolvedValue([]),
  waitForTabLoad: vi.fn().mockResolvedValue(undefined),
  handleTabAction: vi.fn().mockResolvedValue(undefined),
  getPageFingerprint: vi.fn().mockResolvedValue(""),
  sendMessageWithTimeout: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/extension/background/screenshots", () => ({
  captureTabScreenshot: vi.fn().mockResolvedValue("data:image/png;base64,abc"),
}));

vi.mock("@/extension/llm-direct", () => ({
  navigatorCallDirect: vi.fn(),
  plannerCallDirect: vi.fn(),
}));

vi.mock("@/extension/background/state-store", () => ({
  getRunState: vi.fn().mockResolvedValue({ currentTabId: 1, step: 0 }),
  saveRunState: vi.fn(),
  clearRunState: vi.fn(),
  RUN_STATE_KEY: "open_cowork_run_state",
  startKeepalive: vi.fn(),
  stopKeepalive: vi.fn(),
  maybeReleaseKeepAwake: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("@/extension/provider-config", () => ({
  resolveModel: vi.fn((_c: { provider?: string; model?: string; catalogId?: string }) => "mock-model"),
}));

vi.mock("@/extension/background/vision", () => ({
  stripUrlFragment: vi.fn((u: string) => u.split("#")[0]),
}));

vi.mock("@/extension/background/antibot", () => ({
  makeAntiBotHooks: vi.fn().mockReturnValue({}),
}));

// Hoisted state shared with the vision-assistant mock factory: makes the
// assistant's readiness (and its detect mock) controllable from tests so the
// ready-state merge branches (5 & 6) are reachable. The flag is reset in
// beforeEach; `detect` is rebound per test to a fresh vi.fn.
const visionAssistantState = vi.hoisted(() => ({
  isReady: false,
  detect: undefined as unknown as ReturnType<typeof vi.fn>,
  cleanup: undefined as unknown as ReturnType<typeof vi.fn>,
  mergeDetections: undefined as unknown as ReturnType<typeof vi.fn>,
  renderMergedElementsText: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("@/extension/vision-assistant", () => ({
  // A real class (not `vi.fn(() => ({...}))`): `run-helpers` constructs the
  // assistant with `new VA()`, and vitest's spy is not a constructor for an
  // arrow implementation. `Detect`/`cleanup` are created lazily on first
  // construction and shared with the hoisted state so tests can rebind them.
  VisionAssistant: class {
    isReady: boolean;
    init: ReturnType<typeof vi.fn>;
    detect: ReturnType<typeof vi.fn>;
    cleanup: ReturnType<typeof vi.fn>;

    constructor() {
      this.isReady = visionAssistantState.isReady;
      this.init = vi.fn().mockResolvedValue(undefined);
      this.detect = (visionAssistantState.detect ??= vi.fn().mockResolvedValue([]));
      this.cleanup = (visionAssistantState.cleanup ??= vi.fn().mockResolvedValue(undefined));
    }
  },
  // The real barrel re-exports the merger; `run-helpers` destructures these
  // from `loadVisionAssistant()`. Without them the ready-path merge throws and
  // falls back to DOM-only, hiding the branch under test.
  mergeDetections: (visionAssistantState.mergeDetections ??= vi.fn().mockReturnValue([])),
  renderMergedElementsText: (visionAssistantState.renderMergedElementsText ??= vi.fn().mockReturnValue("")),
}));

vi.mock("@/extension/vision-assistant/merger", () => ({
  mergeDetections: (visionAssistantState.mergeDetections ??= vi.fn().mockReturnValue([])),
  renderMergedElementsText: (visionAssistantState.renderMergedElementsText ??= vi.fn().mockReturnValue("")),
}));

vi.mock("@/lib/agent/run-history", () => ({
  RunBuilder: vi.fn(),
  saveRun: vi.fn(),
}));

vi.mock("@/lib/agent/modes", () => ({
  checkActionAllowed: vi.fn().mockReturnValue({ allowed: true }),
}));

// ─── Lazy imports ────────────────────────────────────────────────────────────

let extractStateForRun: typeof import("@/extension/background/run-helpers")["extractStateForRun"];
let extractStateFromTabMock: ReturnType<typeof vi.fn>;
let captureTabScreenshotMock: ReturnType<typeof vi.fn>;
let modelSupportsVisionMock: ReturnType<typeof vi.fn>;
let mergeDetectionsMock: ReturnType<typeof vi.fn>;
let renderMergedElementsTextMock: ReturnType<typeof vi.fn>;

const MOCK_TABS = [{ id: 1, url: "https://example.com", title: "Test" }] as never[];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Let the fire-and-forget vision init settle. `ensureVisionAssistantInit` runs
 * `(async () => { await import(...); new VA(); await va.init(); ... })()` with
 * no handle for tests, and its module import + microtasks need a macrotask
 * turn to complete — without this, a following call sees a null assistant and
 * the "still loading" fallback instead of the ready state the test is
 * pinning.
 */
async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function makeDomState(overrides?: { url?: string; elements?: unknown[]; fingerprint?: string }) {
  return {
    url: overrides?.url ?? "https://example.com",
    title: "Test",
    tabs: [],
    elements: overrides?.elements ?? [],
    elementsText: "",
    pageInfo: "0.0 pages above, 0.0 pages below",
    newElementCount: 0,
    scrollTop: 0,
    scrollHeight: 1000,
    viewportHeight: 800,
    selectorMap: {},
    devicePixelRatio: 1,
    ...(overrides?.fingerprint !== undefined ? { fingerprint: overrides.fingerprint } : {}),
  };
}

function setVisionSettings(settings: {
  model?: string;
  provider?: string;
  enableLocalVision?: boolean;
  enableScreenshots?: boolean;
  visionMode?: string;
}) {
  // Store RAW values: keys the caller leaves undefined are OMITTED from the
  // fixture so the source's own defaults (`enableScreenshots ?? true`, the
  // visionMode fallback) — not the fixture — are what the tests pin.
  if (settings.model !== undefined) localStore.model = settings.model;
  if (settings.provider !== undefined) localStore.provider = settings.provider;
  if (settings.enableLocalVision !== undefined) localStore.enableLocalVision = settings.enableLocalVision;
  if (settings.enableScreenshots !== undefined) localStore.enableScreenshots = settings.enableScreenshots;
  if (settings.visionMode !== undefined) localStore.visionMode = settings.visionMode;
}

function setRunState(tabId = 1, step = 0) {
  Object.assign(sessionStore, {
    open_cowork_run_state: {
      currentTabId: tabId,
      step,
    },
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("extractStateForRun — vision-merge branches", () => {
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("@/extension/background/run-helpers");
    extractStateForRun = mod.extractStateForRun;

    const tabMod = await import("@/extension/background/tab-manager");
    extractStateFromTabMock = tabMod.extractStateFromTab as unknown as ReturnType<typeof vi.fn>;

    const ssMod = await import("@/extension/background/screenshots");
    captureTabScreenshotMock = ssMod.captureTabScreenshot as unknown as ReturnType<typeof vi.fn>;

    const catMod = await import("@/lib/agent/llm/catalog");
    modelSupportsVisionMock = catMod.modelSupportsVision as unknown as ReturnType<typeof vi.fn>;

    const mergerMod = await import("@/extension/vision-assistant/merger");
    mergeDetectionsMock = mergerMod.mergeDetections as unknown as ReturnType<typeof vi.fn>;
    renderMergedElementsTextMock = mergerMod.renderMergedElementsText as unknown as ReturnType<typeof vi.fn>;

    // Default: empty storage
    for (const k of Object.keys(localStore)) delete localStore[k];
    for (const k of Object.keys(sessionStore)) delete sessionStore[k];
    setRunState();

    // Fresh vision-assistant state: not ready, fresh detect/cleanup mocks.
    visionAssistantState.isReady = false;
    visionAssistantState.detect = vi.fn().mockResolvedValue([]);
    visionAssistantState.cleanup = vi.fn().mockResolvedValue(undefined);
    // Module-level merger refs are captured by the factory on first import;
    // reset them in place so the barrel and the merger subpath stay the same
    // function across tests.
    visionAssistantState.mergeDetections!.mockReset().mockReturnValue([]);
    visionAssistantState.renderMergedElementsText!.mockReset().mockReturnValue("");

    // Default mocks
    extractStateFromTabMock.mockResolvedValue(makeDomState());
    captureTabScreenshotMock.mockResolvedValue("data:image/png;base64,abc");
    modelSupportsVisionMock.mockResolvedValue(false);
    mergeDetectionsMock.mockReturnValue([]);
    renderMergedElementsTextMock.mockReturnValue("");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Branch 1: Not always-on, not adaptive → DOM-only (with screenshot) ────

  test("DOM-only with screenshot: main model has vision, screenshots enabled", async () => {
    modelSupportsVisionMock.mockResolvedValue(true);
    setVisionSettings({
      visionMode: "disabled",
      enableScreenshots: true,
      enableLocalVision: false,
    });

    // mainModelVision=true, includeScreenshot=true → effectiveTextOnly=false
    // useAlwaysOnVision=false, useAdaptiveVision=false → DOM-only with screenshot
    const state = await extractStateForRun(1, MOCK_TABS);
    expect(state.url).toBe("https://example.com");
    expect(extractStateFromTabMock).toHaveBeenCalledWith(1, MOCK_TABS, true);
  });

  // ── Branch 2: Not always-on, not adaptive → DOM-only (no screenshot) ──────

  test("DOM-only without screenshot: main model has no vision", async () => {
    modelSupportsVisionMock.mockResolvedValue(false);
    setVisionSettings({
      enableScreenshots: false,
      enableLocalVision: false,
    });

    // mainModelVision=false → effectiveTextOnly=true, includeScreenshot=false
    const state = await extractStateForRun(1, MOCK_TABS);
    expect(state.url).toBe("https://example.com");
    expect(extractStateFromTabMock).toHaveBeenCalledWith(1, MOCK_TABS, false);
  });

  // ── Branch 3: Adaptive mode, empty cache → clear cache, DOM-only ──────────

  test("adaptive with empty cache: clears cache and returns DOM-only", async () => {
    modelSupportsVisionMock.mockResolvedValue(false);
    setVisionSettings({
      enableLocalVision: true,
      visionMode: "adaptive",
      enableScreenshots: true,
    });

    const state = await extractStateForRun(1, MOCK_TABS);
    expect(state.url).toBe("https://example.com");
    expect(extractStateFromTabMock).toHaveBeenCalledWith(1, MOCK_TABS, false);
  });

  // ── Branch 4: Always-on, vision assistant not ready → DOM-only ─────────────

  test("always-on, vision assistant not ready: falls back to DOM-only", async () => {
    modelSupportsVisionMock.mockResolvedValue(false);
    setVisionSettings({
      enableLocalVision: true,
      visionMode: "always",
      enableScreenshots: true,
    });

    // globalVisionAssistant is null → va?.isReady is falsy → return DOM-only
    const state = await extractStateForRun(1, MOCK_TABS);
    expect(state.url).toBe("https://example.com");
    expect(extractStateFromTabMock).toHaveBeenCalledWith(1, MOCK_TABS, false);
    // `captureTabScreenshot` is only reachable PAST the `!va?.isReady` guard
    // (the always-on merge block). Asserting it was NOT called discriminates
    // this branch from the ready-state merge path — deleting the guard would
    // make this assertion fail (a TypeError at va.detect would be caught and
    // produce the same DOM-only fallback call).
    expect(captureTabScreenshotMock).not.toHaveBeenCalled();
  });

  // ── Branch 5: Always-on, vision assistant ready, try succeeds ──────────────

  test("always-on, vision ready: parallel merge with vision detections", async () => {
    modelSupportsVisionMock.mockResolvedValue(false);
    setVisionSettings({
      enableLocalVision: true,
      visionMode: "always",
      enableScreenshots: true,
    });
    visionAssistantState.isReady = true;
    mergeDetectionsMock.mockReturnValue([
      { source: "vision", visionId: "v1", pixelRect: { x: 1, y: 2, width: 10, height: 10 }, text: "btn" },
    ]);

    // First call primes the fire-and-forget init (the sync guard sees a null
    // global); the second call finds the initialized, ready assistant and
    // reaches the merge block.
    await extractStateForRun(1, MOCK_TABS);
    await flushAsync();
    captureTabScreenshotMock.mockClear();
    const state = await extractStateForRun(1, MOCK_TABS);

    expect(captureTabScreenshotMock).toHaveBeenCalledTimes(1);
    expect(visionAssistantState.detect).toHaveBeenCalled();
    expect(mergeDetectionsMock).toHaveBeenCalled();
    expect(state.url).toBe("https://example.com");
  });

  // ── Branch 6: Always-on, vision ready, detect fails → DOM-only fallback ────

  test("always-on, vision ready, detect rejects: falls back to DOM-only", async () => {
    modelSupportsVisionMock.mockResolvedValue(false);
    setVisionSettings({
      enableLocalVision: true,
      visionMode: "always",
      enableScreenshots: true,
    });
    visionAssistantState.isReady = true;

    await extractStateForRun(1, MOCK_TABS); // prime init
    await flushAsync();
    visionAssistantState.detect.mockRejectedValue(new Error("decode failed"));
    captureTabScreenshotMock.mockClear();
    const state = await extractStateForRun(1, MOCK_TABS);

    expect(state.url).toBe("https://example.com");
    expect(extractStateFromTabMock).toHaveBeenCalledWith(1, MOCK_TABS, false);
  });

  // ── Fallback tab id: used when run state has no currentTabId ───────────────

  test("fallback tab id: used when run state has no currentTabId", async () => {
    const { getRunState } = await import("@/extension/background/state-store");
    (getRunState as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ step: 0 } as never);

    modelSupportsVisionMock.mockResolvedValue(false);
    setVisionSettings({ enableLocalVision: false });

    const state = await extractStateForRun(42, MOCK_TABS);
    expect(state.url).toBe("https://example.com");
    expect(extractStateFromTabMock).toHaveBeenCalledWith(42, MOCK_TABS, false);
  });

  // ── Vision mode resolution ─────────────────────────────────────────────────

  test("vision mode fallback: unset visionMode + enableLocalVision=true → always", async () => {
    modelSupportsVisionMock.mockResolvedValue(false);
    setVisionSettings({
      enableLocalVision: true,
      visionMode: undefined, // unset
      enableScreenshots: true,
    });

    // visionMode resolves to "always" (backward compat), effectiveTextOnly=true
    // → useAlwaysOnVision=true → enters always-on path → not ready → DOM-only
    const state = await extractStateForRun(1, MOCK_TABS);
    expect(state.url).toBe("https://example.com");
    expect(extractStateFromTabMock).toHaveBeenCalledWith(1, MOCK_TABS, false);
  });

  test("vision mode fallback: unset visionMode + enableLocalVision=false → disabled", async () => {
    modelSupportsVisionMock.mockResolvedValue(false);
    setVisionSettings({
      enableLocalVision: false,
      visionMode: undefined, // unset
      enableScreenshots: true,
    });

    // visionMode resolves to "disabled" → useAlwaysOnVision=false → DOM-only
    const state = await extractStateForRun(1, MOCK_TABS);
    expect(state.url).toBe("https://example.com");
    expect(extractStateFromTabMock).toHaveBeenCalledWith(1, MOCK_TABS, false);
  });

  // ── includeScreenshot logic ────────────────────────────────────────────────

  test("includeScreenshot: enableScreenshots defaults to true when unset", async () => {
    modelSupportsVisionMock.mockResolvedValue(true);
    setVisionSettings({
      enableScreenshots: undefined, // unset, defaults to true
      visionMode: "disabled",
      enableLocalVision: false,
    });

    // mainModelVision=true, enableScreenshots=undefined → Boolean(undefined ?? true) = true
    // includeScreenshot=true, effectiveTextOnly=false → DOM-only with screenshot
    await extractStateForRun(1, MOCK_TABS);
    expect(extractStateFromTabMock).toHaveBeenCalledWith(1, MOCK_TABS, true);
  });

  test("includeScreenshot: false when user explicitly disables screenshots", async () => {
    modelSupportsVisionMock.mockResolvedValue(true);
    setVisionSettings({
      enableScreenshots: false,
      visionMode: "disabled",
      enableLocalVision: false,
    });

    // mainModelVision=true, enableScreenshots=false → includeScreenshot=false
    // effectiveTextOnly=true (because !includeScreenshot) → but not always-on/adaptive
    await extractStateForRun(1, MOCK_TABS);
    expect(extractStateFromTabMock).toHaveBeenCalledWith(1, MOCK_TABS, false);
  });

  // ── catalog/model load failure ─────────────────────────────────────────────

  test("catalog load failure: modelSupportsVision throws → mainModelVision stays false", async () => {
    modelSupportsVisionMock.mockRejectedValue(new Error("catalog load failed"));
    setVisionSettings({
      enableLocalVision: false,
      enableScreenshots: true,
    });

    // loadCatalogRefs try/catch swallows the error, mainModelVision stays false
    const state = await extractStateForRun(1, MOCK_TABS);
    expect(state.url).toBe("https://example.com");
    // effectiveTextOnly=true (mainModelVision=false) → DOM-only with screenshot=false
    expect(extractStateFromTabMock).toHaveBeenCalledWith(1, MOCK_TABS, false);
  });
});

describe("handleDetectVisualRequest abort signal", () => {
  beforeEach(async () => {
    vi.resetModules();
    const ssMod = await import("@/extension/background/screenshots");
    captureTabScreenshotMock = ssMod.captureTabScreenshot as unknown as ReturnType<typeof vi.fn>;
    const mergerMod = await import("@/extension/vision-assistant/merger");
    mergeDetectionsMock = mergerMod.mergeDetections as unknown as ReturnType<typeof vi.fn>;
    renderMergedElementsTextMock = mergerMod.renderMergedElementsText as unknown as ReturnType<typeof vi.fn>;
    const catMod = await import("@/lib/agent/llm/catalog");
    modelSupportsVisionMock = catMod.modelSupportsVision as unknown as ReturnType<typeof vi.fn>;

    for (const k of Object.keys(localStore)) delete localStore[k];
    for (const k of Object.keys(sessionStore)) delete sessionStore[k];
    setRunState(1, 0);
    // Restore the default run-state shape: earlier tests (the "fallback tab
    // id" case) call mockResolvedValue on the SAME mock object this describe
    // uses, so re-importing state-store does not reset its implementation — do
    // it explicitly or a stray `{ step: 0 }` makes every DETECT_VISUAL request
    // fail with "no active run".
    const storeMod = await import("@/extension/background/state-store");
    (storeMod.getRunState as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ currentTabId: 1, step: 0 });
    setVisionSettings({
      enableLocalVision: true,
      visionMode: "always",
      enableScreenshots: true,
    });
    visionAssistantState.isReady = true;
    visionAssistantState.detect = vi.fn().mockResolvedValue([]);
    visionAssistantState.cleanup = vi.fn().mockResolvedValue(undefined);
    visionAssistantState.mergeDetections!.mockReset().mockReturnValue([]);
    visionAssistantState.renderMergedElementsText!.mockReset().mockReturnValue("");
    captureTabScreenshotMock.mockResolvedValue("data:image/png;base64,abc");
    modelSupportsVisionMock.mockResolvedValue(false);
    mergeDetectionsMock.mockReturnValue([]);
    renderMergedElementsTextMock.mockReturnValue("");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function primeReadyAssistant(): Promise<typeof import("@/extension/background/run-helpers")> {
    const mod = await import("@/extension/background/run-helpers");
    // First call primes the fire-and-forget init; the ready assistant is then
    // available for handleDetectVisualRequest.
    await mod.extractStateForRun(1, MOCK_TABS);
    await flushAsync();
    visionAssistantState.detect.mockClear();
    return mod;
  }

  test("threads a caller-supplied signal into va.detect", async () => {
    const mod = await primeReadyAssistant();
    const signal = new AbortController().signal;

    const result = await mod.handleDetectVisualRequest("find buttons", signal);

    expect(result.ok).toBe(true);
    expect(visionAssistantState.detect).toHaveBeenCalledTimes(1);
    expect(visionAssistantState.detect.mock.calls[0]?.[1]).toBe(signal);
  });

  test("falls back to the active run's signal (set via buildLoopDeps)", async () => {
    const mod = await primeReadyAssistant();
    const controller = new AbortController();
    mod.buildLoopDeps({
      tab: { id: 1 } as chrome.tabs.Tab,
      sendEvent: vi.fn(),
      controller,
      config: {
        maxSteps: 10,
        maxActionsPerStep: 5,
        plannerInterval: 5,
        maxFailures: 5,
        costCapUsd: 10,
      },
      task: "t",
      mode: "standard",
    });

    const result = await mod.handleDetectVisualRequest("find buttons");

    expect(result.ok).toBe(true);
    expect(visionAssistantState.detect.mock.calls[0]?.[1]).toBe(controller.signal);
  });

  test("with no signal available, detect is called with undefined (no crash)", async () => {
    const mod = await primeReadyAssistant();

    const result = await mod.handleDetectVisualRequest("find buttons");

    expect(result.ok).toBe(true);
    expect(visionAssistantState.detect.mock.calls[0]?.[1]).toBeUndefined();
  });

  test("returns an honest error when no active run/tab exists", async () => {
    const mod = await primeReadyAssistant();
    const { getRunState } = await import("@/extension/background/state-store");
    (getRunState as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await mod.handleDetectVisualRequest("find buttons");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("no active run");
  });
});

describe("vision assistant generation ownership", () => {
  beforeEach(async () => {
    vi.resetModules();
    const ssMod = await import("@/extension/background/screenshots");
    captureTabScreenshotMock = ssMod.captureTabScreenshot as unknown as ReturnType<typeof vi.fn>;
    const catMod = await import("@/lib/agent/llm/catalog");
    modelSupportsVisionMock = catMod.modelSupportsVision as unknown as ReturnType<typeof vi.fn>;

    for (const k of Object.keys(localStore)) delete localStore[k];
    for (const k of Object.keys(sessionStore)) delete sessionStore[k];
    setRunState(1, 0);
    setVisionSettings({
      enableLocalVision: true,
      visionMode: "always",
      enableScreenshots: true,
    });
    visionAssistantState.isReady = true;
    visionAssistantState.detect = vi.fn().mockResolvedValue([]);
    visionAssistantState.cleanup = vi.fn().mockResolvedValue(undefined);
    visionAssistantState.mergeDetections!.mockReset().mockReturnValue([]);
    visionAssistantState.renderMergedElementsText!.mockReset().mockReturnValue("");
    captureTabScreenshotMock.mockResolvedValue("data:image/png;base64,abc");
    modelSupportsVisionMock.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("teardownScheduledVision skips cleanup when a newer run claimed the assistant", async () => {
    const mod = await import("@/extension/background/run-helpers");
    // Prime the fire-and-forget init so the shared assistant is in place.
    await mod.extractStateForRun(1, MOCK_TABS);
    await flushAsync();
    expect(visionAssistantState.cleanup).not.toHaveBeenCalled();

    // A new run claims ownership (bumps the generation).
    mod.resetVisionInitFlagForNewRun();
    // The PREVIOUS run's teardown now runs — it must leave the assistant
    // alone, otherwise the new run's vision silently breaks.
    await mod.teardownScheduledVision();
    expect(visionAssistantState.cleanup).not.toHaveBeenCalled();
  });

  test("teardownScheduledVision cleans up when NO newer run claimed it", async () => {
    const mod = await import("@/extension/background/run-helpers");
    await mod.extractStateForRun(1, MOCK_TABS);
    await flushAsync();

    await mod.teardownScheduledVision();
    expect(visionAssistantState.cleanup).toHaveBeenCalledTimes(1);
  });

  test("a mid-cleanup claim leaves the new run with a functioning fresh assistant", async () => {
    const mod = await import("@/extension/background/run-helpers");
    await mod.extractStateForRun(1, MOCK_TABS);
    await flushAsync();

    // Make cleanup slow so the claim lands mid-teardown.
    visionAssistantState.cleanup.mockImplementation(async () => {
      await Promise.resolve();
    });
    const teardown = mod.teardownScheduledVision();
    mod.resetVisionInitFlagForNewRun();
    await teardown;

    // The new run's next extraction re-initializes fresh (the global was
    // nulled before cleanup) and reaches the ready merge path.
    await mod.extractStateForRun(1, MOCK_TABS); // re-init + DOM-only
    await flushAsync();
    await mod.extractStateForRun(1, MOCK_TABS); // ready path
    expect(visionAssistantState.detect).toHaveBeenCalled();
    // Only the stale teardown cleaned up — nothing else touched the assistant.
    expect(visionAssistantState.cleanup).toHaveBeenCalledTimes(1);
  });
});
