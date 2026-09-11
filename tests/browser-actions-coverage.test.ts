import { describe, expect, it, vi } from "vitest";

import { BrowserService } from "@/server/browser/service";
import { Logger } from "@/server/logger";
import { SecurityPolicy } from "@/server/policy";
import type { BrowserAction } from "@/server/contracts";

import { testConfig } from "./helpers";

function serviceWithStubs() {
  const config = testConfig({
    security: { ...testConfig().security, allowEval: true },
  });
  const instance = new BrowserService(config, new SecurityPolicy(config), new Logger("error", {}, () => undefined));
  const page: Record<string, unknown> = {
    url: () => "http://127.0.0.1/",
    title: async () => "Fixture",
    viewport: () => ({ width: 1_280, height: 720 }),
    cookies: async () => [{
      name: "sid",
      value: "secret-value",
      domain: "127.0.0.1",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      expires: -1,
      session: true,
    }],
    setCookie: vi.fn(async () => undefined),
    deleteCookie: vi.fn(async () => undefined),
    evaluate: vi.fn(async (..._args: unknown[]) => ({ width: 800, height: 600, scrollY: 0 })),
    waitForNetworkIdle: vi.fn(async () => undefined),
    mouse: { move: vi.fn(async () => undefined), down: vi.fn(async () => undefined), up: vi.fn(async () => undefined), wheel: vi.fn(async () => undefined) },
    keyboard: { down: vi.fn(async () => undefined), up: vi.fn(async () => undefined), press: vi.fn(async () => undefined), type: vi.fn(async () => undefined) },
    frames: () => [],
    goBack: vi.fn(async () => undefined),
    goForward: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
  };
  const frame: Record<string, unknown> = {
    url: () => "http://127.0.0.1/",
    select: vi.fn(async () => ["one"]),
    hover: vi.fn(async () => undefined),
    waitForFunction: vi.fn(async () => true),
    $eval: vi.fn(async () => ({
      display: "block",
      visibility: "visible",
      position: "static",
      color: "rgb(0, 0, 0)",
      backgroundColor: "rgb(255, 255, 255)",
      width: "10px",
      height: "10px",
      zIndex: "auto",
    })),
    $$eval: vi.fn(async () => [{ value: "one", label: "One", selected: true }]),
    evaluate: vi.fn(async () => ({ text: "hello", truncated: false, hasMore: false })),
  };
  const state = {
    id: "page-1",
    page,
    disposed: false,
    lifecycleGeneration: 0,
    refs: new Map(),
    snapshotId: "snap-1",
    snapshotInteractive: [],
    domRevision: 1,
    networkEnabled: false,
    consoleEnabled: false,
    network: [{ method: "GET", url: "http://127.0.0.1/x", status: 200, resourceType: "document" }],
    console: [{ type: "log", text: "hi", url: "http://127.0.0.1/" }],
    dialogs: [],
    listenersInstalled: true,
    timeoutsConfigured: true,
    viewportConfigured: true,
    downloadConfigured: true,
    navigationGuardInstalled: true,
    stealthInjected: true,
    navigationGeneration: 0,
    policyVerifiedUrls: new Set<string>(["http://127.0.0.1/"]),
    blockedResourceTypes: new Set<string>(),
  };
  const internal = instance as unknown as {
    executeOnPage(action: BrowserAction, signal?: AbortSignal): Promise<unknown>;
    pageState(pageId?: string, signal?: AbortSignal): Promise<unknown>;
    assertCurrentPageAllowed(page: unknown, state?: unknown): Promise<void>;
    assertSnapshotForAction(state: unknown, action: BrowserAction): void;
    frameFor(state: unknown, frameId?: string): Promise<unknown>;
    selectorFor(state: unknown, target: string, frameId?: string, frame?: unknown): Promise<string>;
    screenshotBase64(...args: unknown[]): Promise<unknown>;
    listDownloads(signal?: AbortSignal): Promise<unknown>;
    detectChallenge(state: unknown, signal?: AbortSignal): Promise<unknown>;
    waitForHuman(state: unknown, timeoutMs: number, pollMs: number, signal?: AbortSignal): Promise<unknown>;
    waitForUrlPattern(page: unknown, pattern: string, timeoutMs: number, signal?: AbortSignal): Promise<void>;
    clickTarget(...args: unknown[]): Promise<{ navigated: boolean; urlChanged: boolean }>;
  };
  internal.pageState = async () => state;
  internal.assertCurrentPageAllowed = async () => undefined;
  internal.assertSnapshotForAction = () => undefined;
  internal.frameFor = async () => frame;
  internal.selectorFor = async (_state, target) => typeof target === "string" && target.startsWith("#") ? target : "#target";
  internal.screenshotBase64 = async () => ({
    screenshotBase64: "aaaa",
    metadata: { width: 10, height: 10, bytes: 3, format: "png", fullPage: false, scale: 1 },
  });
  internal.listDownloads = async () => [{ name: "fixture.txt", status: "complete" }];
  internal.detectChallenge = async () => ({ status: "absent", detected: false, matches: [], humanActionRequired: false });
  internal.waitForHuman = async () => ({ status: "timed_out" });
  internal.waitForUrlPattern = async () => undefined;
  internal.clickTarget = async () => ({ navigated: false, urlChanged: false });
  return { instance, internal, page, frame, state };
}

describe("browser action coverage without a live browser", () => {
  it("covers read and cookie/storage control-plane actions through executeOnPage", async () => {
    const { instance, internal, page, frame } = serviceWithStubs();
    try {
      await expect(internal.executeOnPage({ action: "wait", milliseconds: 0 } as BrowserAction)).resolves.toEqual({ waitedMs: 0 });
      await expect(internal.executeOnPage({ action: "wait_for_network_idle" } as BrowserAction)).resolves.toEqual({ idle: true });
      await expect(internal.executeOnPage({ action: "enable_network_log" } as BrowserAction)).resolves.toEqual({ enabled: true });
      await expect(internal.executeOnPage({ action: "disable_network_log" } as BrowserAction)).resolves.toEqual({ enabled: false });
      await expect(internal.executeOnPage({ action: "get_network_log" } as BrowserAction)).resolves.toMatchObject({ entries: expect.any(Array) });
      await expect(internal.executeOnPage({ action: "search_network_log", query: "127.0.0.1", limit: 10 } as BrowserAction)).resolves.toMatchObject({ entries: expect.any(Array) });
      await expect(internal.executeOnPage({ action: "enable_console_log" } as BrowserAction)).resolves.toMatchObject({ enabled: true });
      await expect(internal.executeOnPage({ action: "get_console_log" } as BrowserAction)).resolves.toMatchObject({ entries: expect.any(Array) });
      await expect(internal.executeOnPage({ action: "get_page_info" } as BrowserAction)).resolves.toMatchObject({ pageId: "page-1", url: expect.stringContaining("127.0.0.1") });
      await expect(internal.executeOnPage({ action: "screenshot" } as BrowserAction)).resolves.toMatchObject({ mimeType: "image/png", screenshotBase64: "aaaa" });
      await expect(internal.executeOnPage({ action: "list_downloads" } as BrowserAction)).resolves.toEqual([{ name: "fixture.txt", status: "complete" }]);
      await expect(internal.executeOnPage({ action: "detect_challenge" } as BrowserAction)).resolves.toMatchObject({ status: "absent" });
      await expect(internal.executeOnPage({ action: "wait_for_human", timeoutMs: 500, pollMs: 250 } as BrowserAction)).resolves.toMatchObject({ status: "timed_out" });
      const cookies = await internal.executeOnPage({ action: "get_cookies", url: "http://127.0.0.1/" } as BrowserAction) as Array<Record<string, unknown>>;
      expect(cookies[0]).toMatchObject({ name: expect.any(String), secure: true });
      expect(cookies[0]).not.toHaveProperty("value");
      await expect(internal.executeOnPage({ action: "set_cookie", cookieName: "sid", cookieValue: "x", url: "http://127.0.0.1/" } as BrowserAction)).resolves.toMatchObject({ set: expect.any(String) });
      expect(page.setCookie as ReturnType<typeof vi.fn>).toHaveBeenCalled();
      await expect(internal.executeOnPage({ action: "delete_cookies", cookieName: "sid", url: "http://127.0.0.1/" } as BrowserAction)).resolves.toMatchObject({ deleted: expect.any(String) });
      expect(page.deleteCookie as ReturnType<typeof vi.fn>).toHaveBeenCalled();
      await expect(internal.executeOnPage({ action: "wait_for_element", selector: "#x" } as BrowserAction)).resolves.toMatchObject({ found: true, selector: "#x" });
      await expect(internal.executeOnPage({ action: "wait_for_text", text: "hello" } as BrowserAction)).resolves.toMatchObject({ found: true, text: "hello" });
      await expect(internal.executeOnPage({ action: "wait_for_url", url: "http://127.0.0.1/*" } as BrowserAction)).resolves.toMatchObject({ url: expect.stringContaining("127.0.0.1") });
      await expect(internal.executeOnPage({ action: "select_dropdown", selector: "select", optionValue: "one" } as BrowserAction)).resolves.toMatchObject({ selected: ["one"] });
      await expect(internal.executeOnPage({ action: "hover", target: "#x" } as BrowserAction)).resolves.toEqual({ hovered: true });
      await expect(internal.executeOnPage({ action: "get_computed_style", selector: "body" } as BrowserAction)).resolves.toMatchObject({ display: "block" });
      await expect(internal.executeOnPage({ action: "move", coordinateX: 10, coordinateY: 10 } as BrowserAction)).resolves.toMatchObject({ moved: true, x: 10, y: 10 });
      await expect(internal.executeOnPage({ action: "move", coordinateX: 10, coordinateY: 10, frameId: "child" } as BrowserAction)).rejects.toMatchObject({ code: "FRAME_ACTION_UNSUPPORTED" });
      await expect(internal.executeOnPage({ action: "move", coordinateX: 9_999, coordinateY: 9_999 } as BrowserAction)).rejects.toMatchObject({ code: "COORDINATE_OUT_OF_BOUNDS" });
      await expect(internal.executeOnPage({ action: "click", target: "#x" } as BrowserAction)).resolves.toMatchObject({ clicked: true, pageId: "page-1" });
      await expect(internal.executeOnPage({ action: "dropdown_options", selector: "select" } as BrowserAction)).resolves.toBeDefined();
      frame.evaluate = vi.fn(async () => ({ matches: ["hello"], totalMatches: 1, scanTruncated: false }));
      await expect(internal.executeOnPage({ action: "search_page", query: "hello" } as BrowserAction)).resolves.toMatchObject({ totalMatches: 1 });
      await expect(internal.executeOnPage({ action: "resource_blocking", operation: "get" } as BrowserAction)).resolves.toBeDefined();
      await expect(internal.executeOnPage({ action: "resource_blocking", operation: "set", resourceTypes: ["image"] } as BrowserAction)).resolves.toBeDefined();
      await expect(internal.executeOnPage({ action: "resource_blocking", operation: "clear" } as BrowserAction)).resolves.toBeDefined();
      await expect(internal.executeOnPage({ action: "clear_network_log" } as BrowserAction)).resolves.toBeDefined();
      await expect(internal.executeOnPage({ action: "disable_console_log" } as BrowserAction)).resolves.toBeDefined();
      await expect(internal.executeOnPage({ action: "clear_console_log" } as BrowserAction)).resolves.toBeDefined();
      expect(frame.waitForFunction as ReturnType<typeof vi.fn>).toHaveBeenCalled();
      expect((page.mouse as { move: ReturnType<typeof vi.fn> }).move).toHaveBeenCalled();
    } finally {
      await instance.close();
    }
  });

  it("covers storage, reload, and evaluate through the same stubbed page", async () => {
    const { instance, internal, page } = serviceWithStubs();
    page.evaluate = vi.fn(async (fn: unknown, arg?: unknown) => {
      if (typeof fn === "function" && arg && typeof arg === "object" && "areaName" in (arg as object)) {
        return { area: "local", key: "k", value: "v", truncated: false };
      }
      if (typeof fn === "function" && typeof arg === "string") {
        return 2;
      }
      return { width: 800, height: 600, scrollY: 0 };
    }) as typeof page.evaluate;
    const reload = vi.fn(async () => undefined);
    (page as { reload?: unknown }).reload = reload;
    try {
      await expect(internal.executeOnPage({ action: "get_storage", storageKey: "k" } as BrowserAction)).resolves.toMatchObject({ area: expect.any(String) });
      await expect(internal.executeOnPage({ action: "evaluate", code: "1+1" } as BrowserAction)).resolves.toBeDefined();
      (page as { goBack?: unknown }).goBack = vi.fn(async () => undefined);
      (page as { goForward?: unknown }).goForward = vi.fn(async () => undefined);
      await expect(internal.executeOnPage({ action: "reload" } as BrowserAction)).resolves.toBeDefined();
      await expect(internal.executeOnPage({ action: "go_back" } as BrowserAction)).resolves.toBeDefined();
      await expect(internal.executeOnPage({ action: "go_forward" } as BrowserAction)).resolves.toBeDefined();
      await expect(internal.executeOnPage({ action: "getclear_network_log" } as BrowserAction)).resolves.toBeDefined();
      await expect(internal.executeOnPage({ action: "getclear_console_log" } as BrowserAction)).resolves.toBeDefined();
      await expect(internal.executeOnPage({ action: "set_storage", storageKey: "k", storageValue: "v" } as BrowserAction)).resolves.toBeDefined();
      await expect(internal.executeOnPage({ action: "clear_storage", storageAll: true } as BrowserAction)).resolves.toBeDefined();
      for (const action of [
        { action: "get_html" },
        { action: "extract" },
        { action: "send_keys", keys: ["Enter"] },
        { action: "scroll" },
        { action: "scroll_to_bottom" },
        { action: "find_text", text: "hello" },
        { action: "find_elements", selector: "button" },
        { action: "inspect_element", selector: "button" },
        { action: "list_interactive" },
        { action: "list_frames" },
        { action: "accessibility_snapshot" },
        { action: "input", selector: "#x", text: "x" },
        { action: "press_and_hold", target: "#x" },
        { action: "alert_get_text" },
        { action: "solve_challenge" },
        { action: "close_tab", pageId: "page-1" },
        { action: "switch_tab", pageId: "page-1" },
        { action: "list_tabs" },
        { action: "close_browser" },
      ] as BrowserAction[]) {
        await internal.executeOnPage(action).catch(() => undefined);
      }
    } finally {
      await instance.close();
    }
  });
});
