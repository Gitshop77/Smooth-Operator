/**
 * Network log ring — SW-side capture via chrome.webRequest + the
 * NETWORK_LOG RPC, and the content-side enable/disable/get/clear/getclear
 * action handlers.
 *
 * Pinned contracts:
 * - entries: `{ type:"request", url, method, resource_type, timestamp }` and
 *   `{ type:"response", url, status, timestamp }` (timestamp = epoch ms).
 * - disabled → nothing is captured (listeners early-return).
 * - ring cap is 500 — the OLDEST entry is dropped first.
 * - getclear snapshots AND clears in one synchronous step (atomic).
 * - listeners register exactly once (idempotent). The NETWORK_LOG RPC is
 *   dispatched through `handleLogRingMessage`, which `message-routing.ts`
 *   owns as the single onMessage dispatch path.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { ActionContext } from "../src/lib/agent/tools/handlers/types";
import { makeState } from "./helpers";
import {
  handleClearNetworkLog,
  handleDisableNetworkLog,
  handleEnableNetworkLog,
  handleGetNetworkLog,
  handleGetclearNetworkLog,
} from "../src/lib/agent/tools/handlers/network-log";
import { swRpc } from "../src/lib/agent/tools/handlers/sw-rpc";

function ctx(signal?: AbortSignal): ActionContext {
  return {
    state: makeState(),
    beforeUrl: "http://localhost:3000/",
    beforeFingerprint: "fp",
    signal,
  };
}

// ─── SW-side ring (real module + fake chrome) ──────────────────────────────

describe("rate-limit-tracker: network log ring", () => {
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

  async function issueEffectCapability(
    token: { runId: string; dispatchRevision: number },
    action: { type: "enable_network_log" | "disable_network_log" | "get_network_log" | "clear_network_log" | "getclear_network_log" },
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
    // Fresh module state (the ring + registered flag are module-level).
    vi.resetModules();
    listeners = installFakeChrome();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function loadTracker(): Promise<typeof import("../src/extension/background/rate-limit-tracker")> {
    return await import("../src/extension/background/rate-limit-tracker");
  }

  /** Fire every onCompleted listener (rate-limit + network-log capture). */
  function completeRequest(details: Record<string, unknown>): void {
    for (const fn of listeners.onCompleted) fn(details);
  }
  /** Fire every onBeforeRequest listener. */
  function startRequest(details: Record<string, unknown>): void {
    for (const fn of listeners.onBeforeRequest) fn(details);
  }

  test("listeners register exactly once (idempotent across calls)", async () => {
    const mod = await loadTracker();
    mod.registerRateLimitListener();
    mod.registerRateLimitListener();
    mod.registerRateLimitListener();
    expect(listeners.onBeforeRequest).toHaveLength(1);
    expect(listeners.onCompleted).toHaveLength(2); // rate-limit + network-log capture
  });

  test("request + response entries are recorded with the pinned shape", async () => {
    const mod = await loadTracker();
    mod.registerRateLimitListener();
    mod.enableNetworkLog();
    startRequest({ url: "https://example.com/api", method: "POST", type: "xmlhttprequest", tabId: 1 });
    completeRequest({ url: "https://example.com/api", statusCode: 200, tabId: 1 });
    const { enabled, entries } = mod.getNetworkLog();
    expect(enabled).toBe(true);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      type: "request",
      url: "https://example.com/api",
      method: "POST",
      resource_type: "xmlhttprequest",
    });
    expect(typeof entries[0].timestamp).toBe("number");
    expect(entries[1]).toMatchObject({
      type: "response",
      url: "https://example.com/api",
      status: 200,
    });
    expect(typeof entries[1].timestamp).toBe("number");
  });

  test("signed query strings / tokens are stripped from captured URLs before the agent can read them", async () => {
    const mod = await loadTracker();
    mod.registerRateLimitListener();
    mod.enableNetworkLog();
    // Secret-shaped query params (signed CDN/blob URLs, OAuth state) must never
    // reach the agent-facing ring: the entries are shipped verbatim to the LLM
    // provider via get_network_log.
    startRequest({
      url: "https://example.com/private/blob?X-Amz-Signature=abc123def456&token=s3cr3t&state=0xdead",
      method: "GET",
      type: "xmlhttprequest",
      tabId: 2,
    });
    completeRequest({
      url: "https://example.com/private/blob?X-Amz-Signature=abc123def456&token=s3cr3t&state=0xdead",
      statusCode: 200,
      tabId: 2,
    });
    const entries = mod.getNetworkLog().entries;
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.url).not.toContain("X-Amz-Signature");
      expect(entry.url).not.toContain("token=");
      expect(entry.url).not.toContain("state=");
      expect(entry.url).not.toContain("s3cr3t");
      expect(entry.url).toBe("https://example.com/private/blob");
    }
  });

  test("disabled → nothing is captured; re-enabling resumes", async () => {
    const mod = await loadTracker();
    mod.registerRateLimitListener();
    startRequest({ url: "https://example.com/1", method: "GET", type: "image" });
    completeRequest({ url: "https://example.com/1", statusCode: 200 });
    expect(mod.getNetworkLog().entries).toHaveLength(0); // never enabled

    mod.enableNetworkLog();
    startRequest({ url: "https://example.com/2", method: "GET", type: "image" });
    expect(mod.getNetworkLog().entries).toHaveLength(1);

    mod.disableNetworkLog();
    startRequest({ url: "https://example.com/3", method: "GET", type: "image" });
    expect(mod.getNetworkLog().entries).toHaveLength(1); // no growth while disabled
  });

  test("ring cap: the OLDEST entry is dropped beyond 500", async () => {
    const mod = await loadTracker();
    mod.registerRateLimitListener();
    mod.enableNetworkLog();
    for (let i = 1; i <= 505; i++) {
      startRequest({ url: `https://example.com/${i}`, method: "GET", type: "image" });
    }
    const entries = mod.getNetworkLog().entries;
    expect(entries).toHaveLength(500);
    expect(entries[0].url).toBe("https://example.com/6"); // 1..5 dropped
    expect(entries[499].url).toBe("https://example.com/505");
  });

  test("clear empties the ring; getclear snapshots AND clears atomically", async () => {
    const mod = await loadTracker();
    mod.registerRateLimitListener();
    mod.enableNetworkLog();
    startRequest({ url: "https://example.com/a", method: "GET", type: "image" });
    startRequest({ url: "https://example.com/b", method: "GET", type: "image" });

    const snapshot = mod.getclearNetworkLog();
    expect(snapshot.entries.map((e) => e.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(mod.getNetworkLog().entries).toHaveLength(0); // already cleared

    startRequest({ url: "https://example.com/c", method: "GET", type: "image" });
    mod.clearNetworkLog();
    expect(mod.getNetworkLog().entries).toHaveLength(0);
  });

  test("NETWORK_LOG message RPC drives the verbs", async () => {
    const mod = await loadTracker();
    const controllers = await import("../src/extension/background/run-controller");
    const controller = controllers.beginRunController({ runId: "network-rpc", task: "inspect", maxSteps: 1, mode: "standard" });
    controller.markRunning();
    const token = controller.dispatchToken;
    mod.registerRateLimitListener();
    const rpc = mod.handleLogRingMessage;
    const respond = (res?: unknown) => res;

    // unknown verb → error
    rpc({ type: "NETWORK_LOG", verb: "bogus", token }, { id: "test-ext" }, respond);
    await Promise.resolve();

    rpc({ type: "NETWORK_LOG", verb: "enable", token, effectCapability: await issueEffectCapability(token, { type: "enable_network_log" }) }, { id: "test-ext" }, respond);
    await vi.waitFor(() => expect(mod.isNetworkLogEnabled()).toBe(true));
    startRequest({ url: "https://example.com/x", method: "GET", type: "image" });

    const getRes = { ok: false } as { ok: boolean; enabled?: boolean; entries?: unknown[] };
    rpc({ type: "NETWORK_LOG", verb: "get", token, effectCapability: await issueEffectCapability(token, { type: "get_network_log" }) }, { id: "test-ext" }, (res) => {
      Object.assign(getRes, res);
    });
    await vi.waitFor(() => expect(getRes.ok).toBe(true));
    expect(getRes.ok).toBe(true);
    expect(getRes.enabled).toBe(true);
    expect((getRes.entries ?? []) as Array<{ url: string }>).toHaveLength(1);
    expect((getRes.entries as Array<{ url: string }>)[0].url).toBe("https://example.com/x");

    rpc({ type: "NETWORK_LOG", verb: "getclear", token, effectCapability: await issueEffectCapability(token, { type: "getclear_network_log" }) }, { id: "test-ext" }, respond);
    await vi.waitFor(() => expect(mod.getNetworkLog().entries).toHaveLength(0));
    const afterGetclear = mod.getNetworkLog();
    expect(afterGetclear.entries).toHaveLength(0);

    rpc({ type: "NETWORK_LOG", verb: "disable", token, effectCapability: await issueEffectCapability(token, { type: "disable_network_log" }) }, { id: "test-ext" }, respond);
    await vi.waitFor(() => expect(mod.isNetworkLogEnabled()).toBe(false));
    startRequest({ url: "https://example.com/y", method: "GET", type: "image" });
    expect(mod.getNetworkLog().entries).toHaveLength(0);

    rpc({ type: "NETWORK_LOG", verb: "clear", token, effectCapability: await issueEffectCapability(token, { type: "clear_network_log" }) }, { id: "test-ext" }, respond);
    controllers.resetRunControllerForTests();
  });

  test("NETWORK_LOG from an unauthorized sender is ignored", async () => {
    const mod = await loadTracker();
    mod.registerRateLimitListener();
    const rpc = mod.handleLogRingMessage;
    const spy = vi.fn();
    const ret = rpc({ type: "NETWORK_LOG", verb: "enable" }, { id: "other-ext" }, spy);
    expect(ret).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(mod.isNetworkLogEnabled()).toBe(false);
  });

  test("NETWORK_LOG rejects a missing run token while controller authority is active", async () => {
    const tracker = await import("../src/extension/background/rate-limit-tracker");
    const controllers = await import("../src/extension/background/run-controller");
    controllers.resetRunControllerForTests();
    tracker.registerRateLimitListener();
    const controller = controllers.beginRunController({
      runId: "network-run",
      task: "inspect network",
      maxSteps: 1,
      mode: "standard",
    });
    controller.markRunning();
    const rpc = tracker.handleLogRingMessage;
    const response = vi.fn();
    try {
      expect(rpc({ type: "NETWORK_LOG", verb: "enable" }, { id: "test-ext" }, response)).toBe(true);
      await vi.waitFor(() => expect(response).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: "run is not authorized to dispatch actions" })));
    } finally {
      controllers.resetRunControllerForTests();
    }
  });

  test("NETWORK_LOG rejects missing, wrong-action, and replayed capabilities", async () => {
    const tracker = await import("../src/extension/background/rate-limit-tracker");
    const controllers = await import("../src/extension/background/run-controller");
    const policy = await import("../src/extension/background/privileged-action-policy");
    controllers.resetRunControllerForTests();
    policy.resetPrivilegedActionPolicyForTests();
    tracker.registerRateLimitListener();
    const controller = controllers.beginRunController({ runId: "network-effects", task: "inspect", maxSteps: 1, mode: "standard" });
    controller.markRunning();
    const rpc = tracker.handleLogRingMessage;
    const call = (message: Record<string, unknown>) => new Promise<unknown>((resolve) => rpc(message, { id: "test-ext" }, resolve));
    try {
      await expect(call({ type: "NETWORK_LOG", verb: "enable", token: controller.dispatchToken }))
        .resolves.toEqual(expect.objectContaining({ ok: false, error: expect.stringMatching(/effect capability/i) }));
      const wrong = policy.authorizeAndIssueEffectCapability(controller.dispatchToken, "standard", { type: "get_network_log" });
      if (!wrong.ok) throw new Error(wrong.error);
      await expect(call({ type: "NETWORK_LOG", verb: "enable", token: controller.dispatchToken, effectCapability: wrong.effectCapability }))
        .resolves.toEqual(expect.objectContaining({ ok: false, error: expect.stringMatching(/effect capability/i) }));
      const capability = await issueEffectCapability(controller.dispatchToken, { type: "enable_network_log" });
      await expect(call({ type: "NETWORK_LOG", verb: "enable", token: controller.dispatchToken, effectCapability: capability }))
        .resolves.toEqual(expect.objectContaining({ ok: true }));
      await expect(call({ type: "NETWORK_LOG", verb: "enable", token: controller.dispatchToken, effectCapability: capability }))
        .resolves.toEqual(expect.objectContaining({ ok: false, error: expect.stringMatching(/effect capability/i) }));
    } finally {
      policy.resetPrivilegedActionPolicyForTests();
      controllers.resetRunControllerForTests();
    }
  });

  test("NETWORK_LOG rejects a predecessor token after worker controller loss", async () => {
    const tracker = await import("../src/extension/background/rate-limit-tracker");
    const controllers = await import("../src/extension/background/run-controller");
    controllers.resetRunControllerForTests();
    tracker.registerRateLimitListener();
    const response = vi.fn();
    const rpc = tracker.handleLogRingMessage;
    expect(rpc({
      type: "NETWORK_LOG",
      verb: "get",
      token: { runId: "pre-restart", dispatchRevision: 1 },
    }, { id: "test-ext" }, response)).toBe(true);
    await vi.waitFor(() => expect(response).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: expect.stringMatching(/stale/i) }),
    ));
  });
});

// ─── Content-side action handlers ──────────────────────────────────────────

describe("network-log action handlers", () => {
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

  test("enable sends the NETWORK_LOG RPC and reports success", async () => {
    sendMessage().mockResolvedValue({ ok: true });
    const result = await handleEnableNetworkLog(ctx(), { type: "enable_network_log" });
    expect(sendMessage()).toHaveBeenCalledWith({ type: "NETWORK_LOG", verb: "enable" });
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/enabled/i);
  });

  test("carries the immutable run token and opaque effect capability to the diagnostic RPC", async () => {
    sendMessage().mockResolvedValue({ ok: true });
    const context = ctx();
    context.dispatchToken = { runId: "run-network", dispatchRevision: 4 };
    context.effectCapability = "network-effect-capability";
    await handleEnableNetworkLog(context, { type: "enable_network_log" });
    expect(sendMessage()).toHaveBeenCalledWith({
      type: "NETWORK_LOG",
      verb: "enable",
      token: { runId: "run-network", dispatchRevision: 4 },
      effectCapability: "network-effect-capability",
    });
  });

  test("disable sends verb disable and reports success", async () => {
    sendMessage().mockResolvedValue({ ok: true });
    const result = await handleDisableNetworkLog(ctx(), { type: "disable_network_log" });
    expect(sendMessage()).toHaveBeenCalledWith({ type: "NETWORK_LOG", verb: "disable" });
    expect(result.success).toBe(true);
  });

  test("get surfaces entries as JSON in extractedContent", async () => {
    sendMessage().mockResolvedValue({
      ok: true,
      enabled: true,
      entries: [
        { type: "request", url: "https://example.com/x", method: "GET", resource_type: "image", timestamp: 1 },
      ],
    });
    const result = await handleGetNetworkLog(ctx(), { type: "get_network_log" });
    expect(sendMessage()).toHaveBeenCalledWith({ type: "NETWORK_LOG", verb: "get" });
    expect(result.success).toBe(true);
    expect(result.extractedContent).toContain('"url":"https://example.com/x"');
    expect(result.message).toContain("1 entries");
    expect(result.message).toContain("enabled");
  });

  test("get surfaces the MOST RECENT entries first (newest-first)", async () => {
    // The ring stores entries oldest-first (pinned by the tracker tests); the
    // agent's inline view of extractedContent is head-truncated by the loop
    // (messages-utils), so the handler must present newest-first or the LLM
    // would only ever see the oldest activity.
    sendMessage().mockResolvedValue({
      ok: true,
      enabled: true,
      entries: [
        { type: "request", url: "https://example.com/old", method: "GET", resource_type: "image", timestamp: 1 },
        { type: "request", url: "https://example.com/new", method: "GET", resource_type: "image", timestamp: 2 },
      ],
    });
    const result = await handleGetNetworkLog(ctx(), { type: "get_network_log" });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.extractedContent ?? "[]") as Array<{ url: string }>;
    expect(parsed.map((e) => e.url)).toEqual([
      "https://example.com/new",
      "https://example.com/old",
    ]);
  });

  test("getclear surfaces the MOST RECENT entries first (newest-first)", async () => {
    sendMessage().mockResolvedValue({
      ok: true,
      enabled: true,
      entries: [
        { type: "request", url: "https://example.com/1", method: "GET", resource_type: "image", timestamp: 1 },
        { type: "request", url: "https://example.com/2", method: "GET", resource_type: "image", timestamp: 2 },
      ],
    });
    const result = await handleGetclearNetworkLog(ctx(), { type: "getclear_network_log" });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.extractedContent ?? "[]") as Array<{ url: string }>;
    expect(parsed.map((e) => e.url)).toEqual([
      "https://example.com/2",
      "https://example.com/1",
    ]);
  });

  test("getclear sends verb getclear", async () => {
    sendMessage().mockResolvedValue({ ok: true, enabled: true, entries: [] });
    const result = await handleGetclearNetworkLog(ctx(), { type: "getclear_network_log" });
    expect(sendMessage()).toHaveBeenCalledWith({ type: "NETWORK_LOG", verb: "getclear" });
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/cleared/i);
  });

  test("clear sends verb clear", async () => {
    sendMessage().mockResolvedValue({ ok: true });
    const result = await handleClearNetworkLog(ctx(), { type: "clear_network_log" });
    expect(sendMessage()).toHaveBeenCalledWith({ type: "NETWORK_LOG", verb: "clear" });
    expect(result.success).toBe(true);
  });

  test("no extension context → failure (demo page / tests without chrome)", async () => {
    vi.unstubAllGlobals();
    const result = await handleGetNetworkLog(ctx(), { type: "get_network_log" });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/extension context/i);
  });

  test("SW error response → failure with the SW message", async () => {
    sendMessage().mockResolvedValue({ ok: false, error: "boom" });
    const result = await handleDisableNetworkLog(ctx(), { type: "disable_network_log" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("boom");
  });

  test("a hung SW (no response) fails fast at the RPC timeout", async () => {
    vi.useFakeTimers();
    sendMessage().mockReturnValue(new Promise(() => {})); // never settles
    const promise = handleClearNetworkLog(ctx(), { type: "clear_network_log" });
    await vi.advanceTimersByTimeAsync(15_001);
    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/timeout/i);
  });
});

// ─── Shared SW-RPC race helper (sw-rpc.ts) ──────────────────────────────────

describe("swRpc: shared SW-RPC race helper", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      runtime: { id: "test-ext", sendMessage: vi.fn() },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const sendMessage = () => chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;

  test("resolves with the SW response; passes the message through unchanged", async () => {
    sendMessage().mockResolvedValue({ ok: true, entries: [] });
    const res = await swRpc<{ ok: boolean }>({ type: "CONSOLE_LOG", verb: "get" }, "CONSOLE_LOG");
    expect(sendMessage()).toHaveBeenCalledWith({ type: "CONSOLE_LOG", verb: "get" });
    expect(res.ok).toBe(true);
  });

  test("rejects with the timeout label when the SW never responds", async () => {
    vi.useFakeTimers();
    sendMessage().mockReturnValue(new Promise(() => {})); // never settles
    const promise = swRpc({ type: "CONSOLE_LOG", verb: "clear" }, "CONSOLE_LOG");
    // Attach the rejection handler BEFORE advancing timers so the rejection is
    // observed, not reported as unhandled.
    const assertion = expect(promise).rejects.toThrow(/CONSOLE_LOG timeout/);
    await vi.advanceTimersByTimeAsync(15_001);
    await assertion;
  });

  test("rejects immediately when the signal is already aborted", async () => {
    sendMessage().mockReturnValue(new Promise(() => {})); // SW would respond, but abort wins immediately
    const controller = new AbortController();
    controller.abort();
    const promise = swRpc({ type: "CONSOLE_LOG", verb: "get" }, "CONSOLE_LOG", controller.signal);
    await expect(promise).rejects.toThrow(/Aborted/);
  });

  test("rejects mid-flight when the signal aborts before the SW responds", async () => {
    vi.useFakeTimers();
    sendMessage().mockReturnValue(new Promise(() => {})); // never settles
    const controller = new AbortController();
    // Attach the rejection handler BEFORE abort() so the synchronous rejection
    // is observed, not reported as unhandled.
    const assertion = expect(
      swRpc({ type: "CONSOLE_LOG", verb: "get" }, "CONSOLE_LOG", controller.signal),
    ).rejects.toThrow(/Aborted/);
    controller.abort();
    await assertion;
  });
});
