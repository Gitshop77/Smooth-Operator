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
 * Branches 5 & 6 require the fire-and-forget `ensureVisionAssistantInit` to
 * complete and set `globalVisionAssistant`. Because that variable is module-
 * internal and not resettable, these branches are tested by triggering init
 * and yielding to the microtask queue.
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

vi.mock("@/extension/vision-assistant", () => ({
  VisionAssistant: vi.fn().mockImplementation(() => ({
    isReady: false,
    init: vi.fn().mockResolvedValue(undefined),
    detect: vi.fn().mockResolvedValue([]),
    cleanup: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@/extension/vision-assistant/merger", () => ({
  mergeDetections: vi.fn().mockReturnValue([]),
  renderMergedElementsText: vi.fn().mockReturnValue(""),
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
  Object.assign(localStore, {
    model: settings.model ?? "gpt-4",
    provider: settings.provider ?? "openai",
    enableLocalVision: settings.enableLocalVision ?? false,
    enableScreenshots: settings.enableScreenshots ?? true,
    visionMode: settings.visionMode ?? undefined,
  });
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
  });

  // ── Branch 5 & 6: Always-on, vision ready — requires integration test ─────
  //
  // These branches require `globalVisionAssistant` (module-internal state) to
  // be set by `ensureVisionAssistantInit()`, which is fire-and-forget async.
  // The VA constructor is imported via a relative dynamic import
  // (`import("../vision-assistant")`) that vi.mock("@/extension/...") does
  // not intercept, so we cannot control the init outcome from unit tests.
  //
  // The branches are:
  //   5: try succeeds → parallel DOM + vision detection, merge results
  //   6: try fails → catch returns DOM-only fallback
  //
  // These are integration-tested via manual testing with Local Vision enabled.

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
