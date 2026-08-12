/**
 * Console log ring — MAIN-world console.log/error/warn/info capture
 * bridged to the SW ring via a CustomEvent + CONSOLE_LOG_ENTRY message, the
 * CONSOLE_LOG verb RPC, and the content-side enable/disable/get/clear/getclear
 * action handlers.
 *
 * Pinned contracts:
 * - entries: `{ type, message, timestamp }` (timestamp = epoch ms).
 * - exact type mapping: console.log → "log", console.error → "error",
 *   console.warn → "warning", console.info → "info".
 * - console capture is a MAIN-world override of the four console methods that
 *   still calls the original (transparent), is idempotent, and never throws
 *   into the page.
 * - disabled → entries are NOT stored (CONSOLE_LOG_ENTRY is dropped).
 * - ring cap is 500 — the OLDEST entry is dropped first.
 * - getclear snapshots AND clears in one synchronous step (atomic).
 * - listeners register exactly once (idempotent). CONSOLE_LOG /
 *   CONSOLE_LOG_ENTRY are dispatched through `handleLogRingMessage`, which
 *   `message-routing.ts` owns as the single onMessage dispatch path.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { ActionContext } from "../src/lib/agent/tools/handlers/types";
import { makeState } from "./helpers";
import {
  handleClearConsoleLog,
  handleDisableConsoleLog,
  handleEnableConsoleLog,
  handleGetConsoleLog,
  handleGetclearConsoleLog,
} from "../src/lib/agent/tools/handlers/console-log";
import {
  CONSOLE_CAPTURE_EVENT,
  _resetConsoleCaptureForTests,
  installConsoleCapture,
} from "../src/lib/agent/dom/console-capture";

function ctx(signal?: AbortSignal): ActionContext {
  return {
    state: makeState(),
    beforeUrl: "http://localhost:3000/",
    beforeFingerprint: "fp",
    signal,
  };
}

// ─── SW-side ring (real module + fake chrome) ──────────────────────────────

describe("rate-limit-tracker: console log ring", () => {
  interface FakeChromeListeners {
    onBeforeRequest: Array<(d: Record<string, unknown>) => void>;
    onCompleted: Array<(d: Record<string, unknown>) => void>;
    onMessage: Array<
      (
        msg: unknown,
        sender: { id?: string },
        sendResponse: (res?: unknown) => void,
      ) => boolean | undefined
    >;
  }

  let listeners: FakeChromeListeners;

  let trackerModule: Awaited<ReturnType<typeof loadTracker>> | undefined;

  async function issueEffectCapability(
    token: { runId: string; dispatchRevision: number },
    action: { type: "enable_console_log" | "disable_console_log" | "get_console_log" | "clear_console_log" | "getclear_console_log" },
  ): Promise<string> {
    const policy = await import("../src/extension/background/privileged-action-policy");
    const issued = policy.authorizeAndIssueEffectCapability(token, "standard", action);
    if (!issued.ok) throw new Error(issued.error);
    return issued.effectCapability;
  }

  function installFakeChrome(): FakeChromeListeners {
    const ls: FakeChromeListeners = {
      onBeforeRequest: [],
      onCompleted: [],
      onMessage: [],
    };
    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-ext",
        onMessage: { addListener: (fn: FakeChromeListeners["onMessage"][number]) => ls.onMessage.push(fn) },
      },
      webRequest: {
        onBeforeRequest: {
          addListener: (fn: FakeChromeListeners["onBeforeRequest"][number]) => ls.onBeforeRequest.push(fn),
        },
        onCompleted: {
          addListener: (fn: FakeChromeListeners["onCompleted"][number]) => ls.onCompleted.push(fn),
        },
      },
      tabs: { onRemoved: { addListener: vi.fn() } },
    });
    return ls;
  }

  beforeEach(() => {
    // Fresh module state (the rings + registered flag are module-level).
    vi.resetModules();
    trackerModule = undefined;
    listeners = installFakeChrome();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function loadTracker(): Promise<typeof import("../src/extension/background/rate-limit-tracker")> {
    trackerModule = await import("../src/extension/background/rate-limit-tracker");
    return trackerModule;
  }

  /** Push one console entry through the shared log-ring message handler. */
  function pushEntry(entry: unknown): void {
    trackerModule?.handleLogRingMessage({ type: "CONSOLE_LOG_ENTRY", entry }, { id: "test-ext" } as chrome.runtime.MessageSender, () => {});
  }

  test("listeners register exactly once (idempotent across calls)", async () => {
    const mod = await loadTracker();
    mod.registerRateLimitListener();
    mod.registerRateLimitListener();
    mod.registerRateLimitListener();
    expect(listeners.onBeforeRequest).toHaveLength(1);
    expect(listeners.onCompleted).toHaveLength(2); // rate-limit + network-log capture
  });

  test("console entries are recorded with the pinned shape", async () => {
    const mod = await loadTracker();
    mod.registerRateLimitListener();
    mod.enableConsoleLog();
    pushEntry({ type: "warning", message: "something odd", timestamp: 42 });
    pushEntry({ type: "error", message: "boom", timestamp: 43 });
    const { enabled, entries } = mod.getConsoleLog();
    expect(enabled).toBe(true);
    expect(entries).toEqual([
      { type: "warning", message: "something odd", timestamp: 42 },
      { type: "error", message: "boom", timestamp: 43 },
    ]);
  });

  test("disabled → entries are dropped; re-enabling resumes", async () => {
    const mod = await loadTracker();
    mod.registerRateLimitListener();
    pushEntry({ type: "log", message: "before", timestamp: 1 });
    expect(mod.getConsoleLog().entries).toHaveLength(0); // never enabled

    mod.enableConsoleLog();
    pushEntry({ type: "log", message: "during", timestamp: 2 });
    expect(mod.getConsoleLog().entries).toHaveLength(1);

    mod.disableConsoleLog();
    pushEntry({ type: "log", message: "after", timestamp: 3 });
    expect(mod.getConsoleLog().entries).toHaveLength(1); // no growth while disabled
  });

  test("ring cap: the OLDEST entry is dropped beyond 500", async () => {
    const mod = await loadTracker();
    mod.registerRateLimitListener();
    mod.enableConsoleLog();
    for (let i = 1; i <= 505; i++) {
      pushEntry({ type: "log", message: `m${i}`, timestamp: i });
    }
    const entries = mod.getConsoleLog().entries;
    expect(entries).toHaveLength(500);
    expect(entries[0].message).toBe("m6"); // 1..5 dropped
    expect(entries[499].message).toBe("m505");
  });

  test("clear empties the ring; getclear snapshots AND clears atomically", async () => {
    const mod = await loadTracker();
    mod.registerRateLimitListener();
    mod.enableConsoleLog();
    pushEntry({ type: "log", message: "a", timestamp: 1 });
    pushEntry({ type: "log", message: "b", timestamp: 2 });

    const snapshot = mod.getclearConsoleLog();
    expect(snapshot.entries.map((e) => e.message)).toEqual(["a", "b"]);
    expect(mod.getConsoleLog().entries).toHaveLength(0); // already cleared

    pushEntry({ type: "log", message: "c", timestamp: 3 });
    mod.clearConsoleLog();
    expect(mod.getConsoleLog().entries).toHaveLength(0);
  });

  test("CONSOLE_LOG message RPC drives the verbs", async () => {
    const mod = await loadTracker();
    const controllers = await import("../src/extension/background/run-controller");
    const controller = controllers.beginRunController({ runId: "console-rpc", task: "inspect", maxSteps: 1, mode: "standard" });
    controller.markRunning();
    const token = controller.dispatchToken;
    mod.registerRateLimitListener();
    const rpc = mod.handleLogRingMessage;
    const respond = (res?: unknown) => res;

    // unknown verb → error
    const badRes = { ok: true } as { ok: boolean; error?: string };
    rpc({ type: "CONSOLE_LOG", verb: "bogus", token }, { id: "test-ext" }, (res) => {
      Object.assign(badRes, res);
    });
    await vi.waitFor(() => expect(badRes.ok).toBe(false));
    expect(badRes.ok).toBe(false);
    expect(badRes.error).toMatch(/verb/i);

    rpc({ type: "CONSOLE_LOG", verb: "enable", token, effectCapability: await issueEffectCapability(token, { type: "enable_console_log" }) }, { id: "test-ext" }, respond);
    await vi.waitFor(() => expect(mod.isConsoleLogEnabled()).toBe(true));
    pushEntry({ type: "info", message: "hi", timestamp: 1 });

    const getRes = { ok: false } as { ok: boolean; enabled?: boolean; entries?: unknown[] };
    rpc({ type: "CONSOLE_LOG", verb: "get", token, effectCapability: await issueEffectCapability(token, { type: "get_console_log" }) }, { id: "test-ext" }, (res) => {
      Object.assign(getRes, res);
    });
    await vi.waitFor(() => expect(getRes.ok).toBe(true));
    expect(getRes.ok).toBe(true);
    expect(getRes.enabled).toBe(true);
    expect((getRes.entries ?? []) as Array<{ message: string }>).toHaveLength(1);
    expect((getRes.entries as Array<{ message: string }>)[0].message).toBe("hi");

    rpc({ type: "CONSOLE_LOG", verb: "getclear", token, effectCapability: await issueEffectCapability(token, { type: "getclear_console_log" }) }, { id: "test-ext" }, respond);
    await vi.waitFor(() => expect(mod.getConsoleLog().entries).toHaveLength(0));
    expect(mod.getConsoleLog().entries).toHaveLength(0);

    rpc({ type: "CONSOLE_LOG", verb: "disable", token, effectCapability: await issueEffectCapability(token, { type: "disable_console_log" }) }, { id: "test-ext" }, respond);
    await vi.waitFor(() => expect(mod.isConsoleLogEnabled()).toBe(false));
    pushEntry({ type: "log", message: "x", timestamp: 2 });
    expect(mod.getConsoleLog().entries).toHaveLength(0);

    rpc({ type: "CONSOLE_LOG", verb: "clear", token, effectCapability: await issueEffectCapability(token, { type: "clear_console_log" }) }, { id: "test-ext" }, respond);
    controllers.resetRunControllerForTests();
  });

  test("CONSOLE_LOG / CONSOLE_LOG_ENTRY from an unauthorized sender are ignored", async () => {
    const mod = await loadTracker();
    mod.registerRateLimitListener();
    const rpc = mod.handleLogRingMessage;
    const spy = vi.fn();
    const ret = rpc({ type: "CONSOLE_LOG", verb: "enable" }, { id: "other-ext" }, spy);
    expect(ret).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(mod.isConsoleLogEnabled()).toBe(false);

    rpc({ type: "CONSOLE_LOG_ENTRY", entry: { type: "log", message: "x", timestamp: 1 } }, { id: "other-ext" }, spy);
    expect(mod.getConsoleLog().entries).toHaveLength(0);
  });

  test("CONSOLE_LOG rejects a predecessor token after worker controller loss", async () => {
    const mod = await loadTracker();
    const controllers = await import("../src/extension/background/run-controller");
    controllers.resetRunControllerForTests();
    mod.registerRateLimitListener();
    const response = vi.fn();
    const rpc = mod.handleLogRingMessage;
    expect(rpc({
      type: "CONSOLE_LOG",
      verb: "get",
      token: { runId: "pre-restart", dispatchRevision: 1 },
    }, { id: "test-ext" }, response)).toBe(true);
    await vi.waitFor(() => expect(response).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: expect.stringMatching(/stale/i) }),
    ));
  });

  test("CONSOLE_LOG rejects missing, wrong-action, and replayed capabilities", async () => {
    const tracker = await import("../src/extension/background/rate-limit-tracker");
    const controllers = await import("../src/extension/background/run-controller");
    const policy = await import("../src/extension/background/privileged-action-policy");
    controllers.resetRunControllerForTests();
    policy.resetPrivilegedActionPolicyForTests();
    tracker.registerRateLimitListener();
    const controller = controllers.beginRunController({ runId: "console-effects", task: "inspect", maxSteps: 1, mode: "standard" });
    controller.markRunning();
    const rpc = tracker.handleLogRingMessage;
    const call = (message: Record<string, unknown>) => new Promise<unknown>((resolve) => rpc(message, { id: "test-ext" }, resolve));
    try {
      await expect(call({ type: "CONSOLE_LOG", verb: "enable", token: controller.dispatchToken }))
        .resolves.toEqual(expect.objectContaining({ ok: false, error: expect.stringMatching(/effect capability/i) }));
      const wrong = policy.authorizeAndIssueEffectCapability(controller.dispatchToken, "standard", { type: "get_console_log" });
      if (!wrong.ok) throw new Error(wrong.error);
      await expect(call({ type: "CONSOLE_LOG", verb: "enable", token: controller.dispatchToken, effectCapability: wrong.effectCapability }))
        .resolves.toEqual(expect.objectContaining({ ok: false, error: expect.stringMatching(/effect capability/i) }));
      const capability = await issueEffectCapability(controller.dispatchToken, { type: "enable_console_log" });
      await expect(call({ type: "CONSOLE_LOG", verb: "enable", token: controller.dispatchToken, effectCapability: capability }))
        .resolves.toEqual(expect.objectContaining({ ok: true }));
      await expect(call({ type: "CONSOLE_LOG", verb: "enable", token: controller.dispatchToken, effectCapability: capability }))
        .resolves.toEqual(expect.objectContaining({ ok: false, error: expect.stringMatching(/effect capability/i) }));
    } finally {
      policy.resetPrivilegedActionPolicyForTests();
      controllers.resetRunControllerForTests();
    }
  });
});

// ─── MAIN-world console capture (jsdom window.console) ─────────────────────

describe("console-capture: MAIN-world override", () => {
  const realConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
  };

  beforeEach(() => {
    _resetConsoleCaptureForTests();
    // Replace the methods BEFORE install so install wraps the spies (keeps
    // output quiet and lets us assert "original still called").
    Object.defineProperty(console, "log", { configurable: true, writable: true, value: vi.fn() });
    Object.defineProperty(console, "error", { configurable: true, writable: true, value: vi.fn() });
    Object.defineProperty(console, "warn", { configurable: true, writable: true, value: vi.fn() });
    Object.defineProperty(console, "info", { configurable: true, writable: true, value: vi.fn() });
  });

  afterEach(() => {
    _resetConsoleCaptureForTests();
    Object.defineProperty(console, "log", { configurable: true, writable: true, value: realConsole.log });
    Object.defineProperty(console, "error", { configurable: true, writable: true, value: realConsole.error });
    Object.defineProperty(console, "warn", { configurable: true, writable: true, value: realConsole.warn });
    Object.defineProperty(console, "info", { configurable: true, writable: true, value: realConsole.info });
    vi.restoreAllMocks();
  });

  function collectEntries(): Array<Record<string, unknown>> {
    const entries: Array<Record<string, unknown>> = [];
    window.addEventListener(CONSOLE_CAPTURE_EVENT, (e) => {
      const detail = (e as CustomEvent<{ entry: Record<string, unknown> }>).detail;
      entries.push(detail.entry);
    });
    return entries;
  }

  test("captures log/error/warn/info with the exact type mapping", () => {
    installConsoleCapture();
    const entries = collectEntries();
    console.log("a");
    console.error("b");
    console.warn("c");
    console.info("d");
    expect(entries.map((e) => e.type)).toEqual(["log", "error", "warning", "info"]);
  });

  test("entries carry the pinned shape: type, message, epoch-ms timestamp", () => {
    installConsoleCapture();
    const entries = collectEntries();
    const before = Date.now();
    console.log("hello", "world");
    const after = Date.now();
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("log");
    expect(entries[0].message).toBe("hello world");
    expect(typeof entries[0].timestamp).toBe("number");
    expect((entries[0].timestamp as number) >= before).toBe(true);
    expect((entries[0].timestamp as number) <= after).toBe(true);
  });

  test("non-string arguments are stringified into the message", () => {
    installConsoleCapture();
    const entries = collectEntries();
    console.error(new Error("boom"));
    console.log("user", { name: "a" });
    expect(entries[0].message).toBe("Error: boom");
    expect(entries[1].message).toBe('user {"name":"a"}');
  });

  test("long messages are capped so a chatty page cannot balloon the SW ring", () => {
    installConsoleCapture();
    const entries = collectEntries();
    console.log("x".repeat(10_000));
    expect(entries).toHaveLength(1);
    expect((entries[0].message as string).length).toBe(2000);
  });

  test("the original console method is still called (transparent override)", () => {
    const spy = console.log as unknown as ReturnType<typeof vi.fn>;
    installConsoleCapture();
    console.log("x", 1);
    expect(spy).toHaveBeenCalledWith("x", 1);
  });

  test("install is idempotent — a second call does not double-capture", () => {
    installConsoleCapture();
    installConsoleCapture();
    const entries = collectEntries();
    console.log("once");
    expect(entries).toHaveLength(1);
  });

  test("a throwing page-side listener is reported as an uncaught error without breaking console.log", () => {
    const spy = console.log as unknown as ReturnType<typeof vi.fn>;
    installConsoleCapture();
    // Browsers report listener exceptions as uncaught errors on the global
    // error path; jsdom does the same (window "error" event). preventDefault
    // stops jsdom from ALSO failing the test via its virtualConsole so we can
    // assert the page-visible behavior: console.log completes and the
    // original method is still called.
    window.addEventListener("error", (e) => e.preventDefault());
    window.addEventListener(CONSOLE_CAPTURE_EVENT, () => {
      throw new Error("listener bug");
    });
    expect(() => console.log("still works")).not.toThrow();
    expect(spy).toHaveBeenCalledWith("still works");
  });

  test("reset restores the pre-install console methods", () => {
    const preInstall = console.log; // the spy set in beforeEach
    installConsoleCapture();
    expect(console.log).not.toBe(preInstall);
    _resetConsoleCaptureForTests();
    expect(console.log).toBe(preInstall);
  });
});

// ─── Content-side action handlers ──────────────────────────────────────────

describe("console-log action handlers", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      runtime: { id: "test-ext", sendMessage: vi.fn() },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const sendMessage = () => chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;

  test("enable sends the CONSOLE_LOG RPC and reports success", async () => {
    sendMessage().mockResolvedValue({ ok: true });
    const result = await handleEnableConsoleLog(ctx(), { type: "enable_console_log" });
    expect(sendMessage()).toHaveBeenCalledWith({ type: "CONSOLE_LOG", verb: "enable" });
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/enabled/i);
  });

  test("forwards the immutable run token and opaque effect capability", async () => {
    sendMessage().mockResolvedValue({ ok: true });
    const context = ctx();
    context.dispatchToken = { runId: "run-console", dispatchRevision: 4 };
    context.effectCapability = "console-effect-capability";
    await handleEnableConsoleLog(context, { type: "enable_console_log" });
    expect(sendMessage()).toHaveBeenCalledWith({
      type: "CONSOLE_LOG",
      verb: "enable",
      token: { runId: "run-console", dispatchRevision: 4 },
      effectCapability: "console-effect-capability",
    });
  });

  test("disable sends verb disable and reports success", async () => {
    sendMessage().mockResolvedValue({ ok: true });
    const result = await handleDisableConsoleLog(ctx(), { type: "disable_console_log" });
    expect(sendMessage()).toHaveBeenCalledWith({ type: "CONSOLE_LOG", verb: "disable" });
    expect(result.success).toBe(true);
  });

  test("get surfaces entries as JSON in extractedContent", async () => {
    sendMessage().mockResolvedValue({
      ok: true,
      enabled: true,
      entries: [{ type: "log", message: "hi", timestamp: 1 }],
    });
    const result = await handleGetConsoleLog(ctx(), { type: "get_console_log" });
    expect(sendMessage()).toHaveBeenCalledWith({ type: "CONSOLE_LOG", verb: "get" });
    expect(result.success).toBe(true);
    expect(result.extractedContent).toContain('"message":"hi"');
    expect(result.message).toContain("1 entries");
    expect(result.message).toContain("enabled");
  });

  test("get surfaces the MOST RECENT entries first (newest-first)", async () => {
    // The ring stores entries oldest-first (pinned by the tracker tests); the
    // agent's inline view of extractedContent is head-truncated by the loop
    // (messages-utils), so the handler must present newest-first or the LLM
    // would only ever see the oldest console output.
    sendMessage().mockResolvedValue({
      ok: true,
      enabled: true,
      entries: [
        { type: "log", message: "old", timestamp: 1 },
        { type: "error", message: "new", timestamp: 2 },
      ],
    });
    const result = await handleGetConsoleLog(ctx(), { type: "get_console_log" });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.extractedContent ?? "[]") as Array<{ message: string }>;
    expect(parsed.map((e) => e.message)).toEqual(["new", "old"]);
  });

  test("getclear surfaces the MOST RECENT entries first (newest-first)", async () => {
    sendMessage().mockResolvedValue({
      ok: true,
      enabled: true,
      entries: [
        { type: "log", message: "one", timestamp: 1 },
        { type: "log", message: "two", timestamp: 2 },
      ],
    });
    const result = await handleGetclearConsoleLog(ctx(), { type: "getclear_console_log" });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.extractedContent ?? "[]") as Array<{ message: string }>;
    expect(parsed.map((e) => e.message)).toEqual(["two", "one"]);
  });

  test("getclear sends verb getclear", async () => {
    sendMessage().mockResolvedValue({ ok: true, enabled: true, entries: [] });
    const result = await handleGetclearConsoleLog(ctx(), { type: "getclear_console_log" });
    expect(sendMessage()).toHaveBeenCalledWith({ type: "CONSOLE_LOG", verb: "getclear" });
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/cleared/i);
  });

  test("clear sends verb clear", async () => {
    sendMessage().mockResolvedValue({ ok: true });
    const result = await handleClearConsoleLog(ctx(), { type: "clear_console_log" });
    expect(sendMessage()).toHaveBeenCalledWith({ type: "CONSOLE_LOG", verb: "clear" });
    expect(result.success).toBe(true);
  });

  test("no extension context → failure (demo page / tests without chrome)", async () => {
    vi.unstubAllGlobals();
    const result = await handleGetConsoleLog(ctx(), { type: "get_console_log" });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/extension context/i);
  });

  test("SW error response → failure with the SW message", async () => {
    sendMessage().mockResolvedValue({ ok: false, error: "boom" });
    const result = await handleDisableConsoleLog(ctx(), { type: "disable_console_log" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("boom");
  });

  test("a hung SW (no response) fails fast at the RPC timeout", async () => {
    vi.useFakeTimers();
    sendMessage().mockReturnValue(new Promise(() => {})); // never settles
    const promise = handleClearConsoleLog(ctx(), { type: "clear_console_log" });
    await vi.advanceTimersByTimeAsync(15_001);
    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/timeout/i);
  });
});
