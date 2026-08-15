/**
 * Vision cache fingerprint freshness.
 *
 * `isVisionCacheFresh` compares the current page fingerprint against the
 * fingerprint stored when the cached vision rects were CAPTURED. Both the
 * adaptive warm-cache path and the always-on path in `extractStateForRun`
 * reuse the cached rects ONLY when that freshness check passes (URL +
 * fingerprint), and the adaptive branch re-stamps the stored fingerprint on
 * reuse so the gate stays pinned to the current page. A page whose
 * fingerprint changed since capture (same URL) is therefore rejected: the
 * cache is cleared and vision re-detects instead of serving stale [vN] boxes.
 *
 * Accepted staleness caveat: viewport resize/scroll between steps changes the
 * cached [vN] pixel rects even with an unchanged DOM fingerprint — the click
 * path re-validates via `isVisionCacheFresh` (message-handlers.ts) before any
 * CDP click, so a mislocated rect is rejected and re-detected, not clicked.
 *
 * These tests drive the REAL `extractStateForRun` + `isVisionCacheFresh`
 * (mocking only the tab-manager / catalog / vision-assistant dependencies,
 * mirroring tests/extract-state-for-run.test.ts).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Mock chrome global ──────────────────────────────────────────────────────

const sessionStore: Record<string, unknown> = {};
const localStore: Record<string, unknown> = {};

(globalThis as Record<string, unknown>).chrome = {
  tabs: {
    get: vi.fn(async () => ({ id: 1, url: "https://example.com" })),
  },
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

// ─── Mock all dependencies (mirrors tests/extract-state-for-run.test.ts) ─────

vi.mock("@/lib/agent/llm/catalog", () => ({
  modelSupportsVision: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/extension/provider-config-map", () => ({
  CATALOG_PROVIDER_ID_MAP: {},
}));

vi.mock("@/extension/background/tab-manager", () => ({
  extractStateFromTab: vi.fn(),
  listTabs: vi.fn().mockResolvedValue([]),
  ensureContent: vi.fn().mockResolvedValue(undefined),
  executeActionsInTab: vi.fn().mockResolvedValue([]),
  waitForTabLoad: vi.fn().mockResolvedValue(undefined),
  handleTabAction: vi.fn().mockResolvedValue(undefined),
  getPageFingerprint: vi.fn().mockResolvedValue(""),
  getPageSnapshot: vi.fn().mockResolvedValue({ fingerprint: "", viewport: "" }),
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
  resolveModel: vi.fn(() => "mock-model"),
}));

// NOTE: `@/extension/background/vision` is NOT mocked — the real pure
// `stripUrlFragment` (which keeps `#/...` / `#!` hash-route fragments) is
// loaded so cache-key semantics match production.

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
  // The real index re-exports these from ./merger; the warm branch
  // destructures them from `import("../vision-assistant")`.
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

// ─── Lazy imports (same module instance as the SUT) ──────────────────────────

let extractStateForRun: typeof import("@/extension/background/run-helpers")["extractStateForRun"];
let isVisionCacheFresh: typeof import("@/extension/background/run-helpers")["isVisionCacheFresh"];
let extractStateFromTabMock: ReturnType<typeof vi.fn>;
let getPageSnapshotMock: ReturnType<typeof vi.fn>;
let visionElementsCache: Map<string, { x: number; y: number; width: number; height: number; label: string }>;
let setVisionCacheUrl: (u: string) => void;
let setVisionCacheFingerprint: (fp: string) => void;
let setVisionCacheViewport: (vp: string) => void;

const MOCK_TABS = [{ id: 1, url: "https://example.com", title: "Test" }] as never[];

/** Shared viewport signature used by the default page snapshot. */
const MOCK_VIEWPORT = "0:0:800:600";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDomState(overrides?: { url?: string; elements?: unknown[]; fingerprint?: string; viewport?: string }) {
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
    ...(overrides?.viewport !== undefined ? { viewport: overrides.viewport } : {}),
  };
}

function setVisionSettings(settings: {
  enableLocalVision?: boolean;
  enableScreenshots?: boolean;
  visionMode?: string;
}) {
  Object.assign(localStore, {
    model: "gpt-4",
    provider: "openai",
    enableLocalVision: settings.enableLocalVision ?? false,
    enableScreenshots: settings.enableScreenshots ?? true,
    visionMode: settings.visionMode ?? undefined,
  });
}

describe("vision cache freshness — adaptive warm reuse + always-on reuse", () => {
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("@/extension/background/run-helpers");
    extractStateForRun = mod.extractStateForRun;
    isVisionCacheFresh = mod.isVisionCacheFresh;

    const tabMod = await import("@/extension/background/tab-manager");
    extractStateFromTabMock = tabMod.extractStateFromTab as unknown as ReturnType<typeof vi.fn>;
    getPageSnapshotMock = tabMod.getPageSnapshot as unknown as ReturnType<typeof vi.fn>;

    const utilsMod = await import("@/extension/background/run-helpers-utils");
    visionElementsCache = utilsMod.visionElementsCache;
    setVisionCacheUrl = utilsMod.setVisionCacheUrl;
    setVisionCacheFingerprint = utilsMod.setVisionCacheFingerprint;
    setVisionCacheViewport = utilsMod.setVisionCacheViewport;

    for (const k of Object.keys(localStore)) delete localStore[k];
    for (const k of Object.keys(sessionStore)) delete sessionStore[k];
    setVisionSettings({ enableLocalVision: true, visionMode: "adaptive" });

    extractStateFromTabMock.mockResolvedValue(makeDomState({ viewport: MOCK_VIEWPORT }));
    getPageSnapshotMock.mockResolvedValue({ fingerprint: "FP-NEW", viewport: MOCK_VIEWPORT });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("adaptive reuse branch rejects a changed page (fingerprint check), not just URL", async () => {
    // Capture-time cache state: rects + fingerprint captured when the DOM
    // fingerprint was "FP-OLD".
    visionElementsCache.set("v1", { x: 10, y: 10, width: 100, height: 50, label: "login" });
    setVisionCacheUrl("https://example.com");
    setVisionCacheFingerprint("FP-OLD");
    setVisionCacheViewport(MOCK_VIEWPORT);

    // The page changed since capture (the freshness check AND EXTRACT_STATE
    // both report "FP-NEW") but the URL is unchanged: the adaptive warm
    // branch must NOT reuse the stale rects — it must clear and re-detect.
    getPageSnapshotMock.mockResolvedValue({ fingerprint: "FP-NEW", viewport: MOCK_VIEWPORT });
    extractStateFromTabMock.mockResolvedValue(makeDomState({ fingerprint: "FP-NEW", viewport: MOCK_VIEWPORT }));
    const state = await extractStateForRun(1, MOCK_TABS);

    // No cached rect was merged (fresh detect or empty), the cache was
    // cleared, and the freshness guard still rejects the stale rects.
    expect(state.newElementCount).toBe(0);
    expect(visionElementsCache.size).toBe(0);
    expect(await isVisionCacheFresh(1)).toBe(false);
  });

  test("warm-cache reuse with an unchanged page stays fresh", async () => {
    // Page did NOT change since capture: the freshness-check fingerprint AND
    // the EXTRACT_STATE fingerprint both match the stored one.
    visionElementsCache.set("v1", { x: 10, y: 10, width: 100, height: 50, label: "login" });
    setVisionCacheUrl("https://example.com");
    setVisionCacheFingerprint("FP-OLD");
    setVisionCacheViewport(MOCK_VIEWPORT);

    getPageSnapshotMock.mockResolvedValue({ fingerprint: "FP-OLD", viewport: MOCK_VIEWPORT });
    extractStateFromTabMock.mockResolvedValue(makeDomState({ fingerprint: "FP-OLD", viewport: MOCK_VIEWPORT }));
    await extractStateForRun(1, MOCK_TABS);

    expect(await isVisionCacheFresh(1)).toBe(true);
  });

  test("always-on vision reuses cached rects when the page fingerprint is unchanged", async () => {
    // Prime the cache as if a fresh detect just captured these rects under
    // fingerprint "FP-OLD" on the current page.
    visionElementsCache.set("v1", { x: 10, y: 10, width: 100, height: 50, label: "login" });
    setVisionCacheUrl("https://example.com");
    setVisionCacheFingerprint("FP-OLD");
    setVisionCacheViewport(MOCK_VIEWPORT);
    getPageSnapshotMock.mockResolvedValue({ fingerprint: "FP-OLD", viewport: MOCK_VIEWPORT });
    extractStateFromTabMock.mockResolvedValue(makeDomState({ fingerprint: "FP-OLD", viewport: MOCK_VIEWPORT }));
    setVisionSettings({ enableLocalVision: true, visionMode: "always", enableScreenshots: true });

    const { captureTabScreenshot } = await import("@/extension/background/screenshots");
    const captureMock = captureTabScreenshot as unknown as ReturnType<typeof vi.fn>;
    const { VisionAssistant: VA } = await import("@/extension/vision-assistant");
    const vaCtor = VA as unknown as ReturnType<typeof vi.fn>;

    const state = await extractStateForRun(1, MOCK_TABS);

    // No re-detection: no screenshot capture, no assistant construction —
    // the cached [vN] rects are merged straight into the state.
    expect(captureMock).not.toHaveBeenCalled();
    expect(vaCtor).not.toHaveBeenCalled();
    expect(state.newElementCount).toBe(1);
    expect(state.elements).toContainEqual(expect.objectContaining({ visionId: "v1", indexStr: "[v1]" }));
    // The cache is retained (not cleared) and stays fresh for the click path.
    expect(visionElementsCache.size).toBe(1);
    expect(await isVisionCacheFresh(1)).toBe(true);
  });

  test("isVisionCacheFresh returns false when no cache URL was recorded", async () => {
    // beforeEach leaves the vision cache empty (no URL, no fingerprint).
    await expect(isVisionCacheFresh(1)).resolves.toBe(false);
  });

  test("isVisionCacheFresh returns false when chrome.tabs.get rejects", async () => {
    setVisionCacheUrl("https://example.com");
    const tabsGet = (globalThis as unknown as { chrome: { tabs: { get: ReturnType<typeof vi.fn> } } })
      .chrome.tabs.get;
    tabsGet.mockRejectedValue(new Error("tab gone"));
    await expect(isVisionCacheFresh(1)).resolves.toBe(false);
    // Restore the shared mock so later tests keep the default resolved tab.
    tabsGet.mockResolvedValue({ id: 1, url: "https://example.com" });
  });

  test("isVisionCacheFresh returns false when the tab URL differs from the cache URL", async () => {
    setVisionCacheUrl("https://example.com/cached-page");
    await expect(isVisionCacheFresh(1)).resolves.toBe(false);
  });

  test("isVisionCacheFresh skips the fingerprint check when none was stored", async () => {
    setVisionCacheUrl("https://example.com");
    // No stored fingerprint → URL match alone is enough; the snapshot fetch
    // must not even be consulted.
    getPageSnapshotMock.mockRejectedValue(new Error("should not be consulted"));
    await expect(isVisionCacheFresh(1)).resolves.toBe(true);
    expect(getPageSnapshotMock).not.toHaveBeenCalled();
  });

  test("isVisionCacheFresh returns false when getPageSnapshot rejects", async () => {
    setVisionCacheUrl("https://example.com");
    setVisionCacheFingerprint("FP-OLD");
    getPageSnapshotMock.mockRejectedValueOnce(new Error("fingerprint failed"));
    await expect(isVisionCacheFresh(1)).resolves.toBe(false);
  });

  test("isVisionCacheFresh returns false when the page fingerprint changed since capture", async () => {
    setVisionCacheUrl("https://example.com");
    setVisionCacheFingerprint("FP-OLD");
    setVisionCacheViewport(MOCK_VIEWPORT);
    getPageSnapshotMock.mockResolvedValue({ fingerprint: "FP-NEW", viewport: MOCK_VIEWPORT });
    await expect(isVisionCacheFresh(1)).resolves.toBe(false);
  });

  test("a pure SCROLL since capture invalidates the cache (viewport signature)", async () => {
    // Same URL, same DOM fingerprint — but the page scrolled: every cached
    // [vN] rect is scroll-relative, so the detection set is mislocalized.
    // The DOM fingerprint does NOT move on scroll by design; the viewport
    // signature is what catches it.
    setVisionCacheUrl("https://example.com");
    setVisionCacheFingerprint("FP-OLD");
    setVisionCacheViewport("0:0:800:600");
    getPageSnapshotMock.mockResolvedValue({ fingerprint: "FP-OLD", viewport: "0:480:800:600" });
    await expect(isVisionCacheFresh(1)).resolves.toBe(false);
  });

  test("isVisionCacheFresh returns false when no viewport signature was stored", async () => {
    setVisionCacheUrl("https://example.com");
    setVisionCacheFingerprint("FP-OLD");
    // Stored fingerprint matches, but the viewport was never recorded — the
    // cache cannot prove the rects are current, so it fails closed.
    getPageSnapshotMock.mockResolvedValue({ fingerprint: "FP-OLD", viewport: MOCK_VIEWPORT });
    await expect(isVisionCacheFresh(1)).resolves.toBe(false);
  });

  test("a VIEWPORT RESIZE since capture invalidates the cache (viewport signature)", async () => {
    setVisionCacheUrl("https://example.com");
    setVisionCacheFingerprint("FP-OLD");
    setVisionCacheViewport("0:0:800:600");
    getPageSnapshotMock.mockResolvedValue({ fingerprint: "FP-OLD", viewport: "0:0:1200:800" });
    await expect(isVisionCacheFresh(1)).resolves.toBe(false);
  });

  test("warm branch clears the cache when the URL changed since capture", async () => {
    visionElementsCache.set("v1", { x: 10, y: 10, width: 100, height: 50, label: "login" });
    setVisionCacheUrl("https://old.example.com/page");
    setVisionCacheFingerprint("FP-OLD");

    await extractStateForRun(1, MOCK_TABS);

    expect(visionElementsCache.size).toBe(0);
    await expect(isVisionCacheFresh(1)).resolves.toBe(false);
  });

  test("a plain-anchor fragment difference keeps the cache fresh (real stripUrlFragment)", async () => {
    setVisionCacheUrl("https://example.com#section-2");
    // tabs.get returns "https://example.com" (no fragment) — the anchor is
    // stripped on both sides, so the cache key matches.
    await expect(isVisionCacheFresh(1)).resolves.toBe(true);
  });

  test("a hash-route fragment difference invalidates the cache (real stripUrlFragment)", async () => {
    setVisionCacheUrl("https://example.com/app#/settings");
    const tabsGet = (globalThis as unknown as { chrome: { tabs: { get: ReturnType<typeof vi.fn> } } })
      .chrome.tabs.get;
    tabsGet.mockResolvedValue({ id: 1, url: "https://example.com/app#/billing" });
    await expect(isVisionCacheFresh(1)).resolves.toBe(false);
  });
});
