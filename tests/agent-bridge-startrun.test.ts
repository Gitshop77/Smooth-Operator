/**
 * agent-bridge.ts — startRun lifecycle guards.
 *
 * startRun is the single shared entry point for BOTH manual RUN and
 * scheduled-task runs. Its most critical invariant is the synchronous
 * `runStarting` guard: it must be RELEASED on every exit path, or a stuck
 * `true` permanently DoSes all future RUN messages until the service worker
 * restarts. These tests lock in:
 *   (a) resetDownloadConsent runs for every run (per-run consent isolation);
 *   (b) an unknown mode falls back to DEFAULT_MODE (still runs, info event);
 *   (c) a thrown initRunState / wireAbortController releases the guard
 *       (isRunStarting()===false) and clears persisted state;
 *   (d) the finally emits a metrics summary when a metrics callback exists.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mocks (hoisted) ──────────────────────────────────────────────────

const runHistorySpy = vi.hoisted(() => ({
  events: [] as Array<unknown[]>,
}));

vi.mock("@/lib/agent/loop/orchestrator", () => ({
  runAgentLoop: vi.fn(async () => {}),
}));

vi.mock("@/lib/agent/run-history", () => ({
  RunBuilder: class {
    private readonly events: unknown[] = [];
    constructor() {
      runHistorySpy.events.push(this.events);
    }
    get id(): string { return `test-run-${runHistorySpy.events.length}`; }
    get startedAt(): number { return 1; }
    addEvent(event: unknown): void { this.events.push(event); }
    finish(fallback: { success: boolean; text: string }) {
      const done = [...this.events].reverse().find((event): event is { type: "done"; success: boolean; text: string } =>
        typeof event === "object" && event !== null && (event as { type?: unknown }).type === "done",
      );
      return { result: done ? { success: done.success, text: done.text } : fallback };
    }
  },
}));

vi.mock("@/lib/agent/callbacks/metrics", () => ({
  AgentMetricsCallback: class {
    getMetrics() {
      return {
        totalSteps: 1,
        totalActions: 2,
        totalTokensIn: 3,
        totalTokensOut: 4,
        totalCostUsd: 0.5,
        errors: { total: 0 },
        loopWarnings: 0,
        compactions: 0,
      };
    }
    reset(): void {}
  },
}));

vi.mock("../src/extension/background/run-helpers", () => ({
  buildLoopDeps: vi.fn((ctx: unknown) => ctx),
  cleanupRun: vi.fn(async () => {}),
  initRunState: vi.fn(async () => {}),
  resetVisionInitFlagForNewRun: vi.fn(),
  clearVisionElementsCacheForNewRun: vi.fn(),
  teardownScheduledVision: vi.fn(),
  wireAbortController: vi.fn(() => ({
    controller: { signal: { aborted: false } },
    onStorageChanged: vi.fn(),
  })),
  getVisionElementRect: vi.fn(),
  isVisionCacheFresh: vi.fn(),
}));

vi.mock("../src/extension/background/state-store", () => ({
  saveRunState: vi.fn(async () => {}),
  saveRunStateForRun: vi.fn(async () => {}),
  initializeRunStateForRun: vi.fn(async () => {}),
  getRunState: vi.fn(async () => undefined),
  clearRunState: vi.fn(async () => {}),
  clearRunStateForRun: vi.fn(async () => {}),
  loadAndSetDomainConfig: vi.fn(async () => {}),
  safeLog: vi.fn(async () => {}),
  stopKeepalive: vi.fn(async () => {}),
}));

// ── Imports AFTER mocks ─────────────────────────────────────────────────────

const ab = await import("../src/extension/background/agent-bridge");
const {
  startRun,
  consumeDownloadConsentForMode,
  resetDownloadConsent,
  setRunStarting,
  isRunStarting,
  reserveManualRunAuthority,
} = ab;
const runController = await import("../src/extension/background/run-controller");
const orchestrator = await import("@/lib/agent/loop/orchestrator");
const runHelpers = await import("../src/extension/background/run-helpers");
const stateStore = await import("../src/extension/background/state-store");

const runAgentLoop = orchestrator.runAgentLoop as ReturnType<typeof vi.fn>;
const initRunState = runHelpers.initRunState as ReturnType<typeof vi.fn>;
const wireAbortController = runHelpers.wireAbortController as ReturnType<typeof vi.fn>;
const cleanupRun = runHelpers.cleanupRun as ReturnType<typeof vi.fn>;
const clearRunStateForRun = stateStore.clearRunStateForRun as ReturnType<typeof vi.fn>;

let sentEvents: Array<{ type: string; message?: string; success?: boolean }>;

function stubChrome(): void {
  (globalThis as Record<string, unknown>).chrome = {
    tabs: {
      query: vi.fn(async () => [{ id: 1 }]),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({
          maxActions: undefined,
          plannerInterval: undefined,
          maxFailures: undefined,
          costCap: undefined,
          maxSteps: undefined,
          allowedDomains: undefined,
          blockedDomains: undefined,
        })),
      },
    },
    runtime: {
      sendMessage: vi.fn((msg: { event?: { type: string; message?: string } }) => {
        if (msg?.event) sentEvents.push(msg.event);
        return Promise.resolve();
      }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  runHistorySpy.events.length = 0;
  sentEvents = [];
  runAgentLoop.mockImplementation(async () => {});
  initRunState.mockImplementation(async () => {});
  wireAbortController.mockImplementation(() => ({
    controller: { signal: { aborted: false } },
    onStorageChanged: vi.fn(),
  }));
  clearRunStateForRun.mockImplementation(async () => {});
  setRunStarting(false);
  // Reset the module-level download-consent flag so test (a) — which asserts
  // a fresh consume succeeds after startRun — is order-independent: a future
  // test consuming consent before (a) without an intervening startRun would
  // otherwise flip the initial expectation.
  resetDownloadConsent();
  stubChrome();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
});

describe("startRun lifecycle", () => {
  test("(a) resetDownloadConsent runs for every run (per-run consent isolation)", async () => {
    // Drive the internal flag true, then confirm it is reset by startRun.
    expect(consumeDownloadConsentForMode("full_agentic")).toBe(true);
    expect(consumeDownloadConsentForMode("full_agentic")).toBe(false);
    await startRun({ task: "do something", maxSteps: 10, mode: "standard" });
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
    // After resetDownloadConsent, a fresh full_agentic consume must succeed again.
    expect(consumeDownloadConsentForMode("full_agentic")).toBe(true);
  });

  test("(b) an unknown mode falls back to DEFAULT_MODE and still runs", async () => {
    await startRun({ task: "do something", maxSteps: 10, mode: "bogus-mode" as never });
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
    const deps = runAgentLoop.mock.calls[0][0] as { mode?: string };
    expect(deps.mode).toBe("standard");
    // The fallback is surfaced to the side panel (not silently swallowed).
    expect(
      sentEvents.some((e) => e.type === "info" && /Invalid mode/.test(e.message ?? "")),
    ).toBe(true);
  });

  test("(c) an initRunState throw releases the guard + clears state", async () => {
    setRunStarting(true);
    initRunState.mockRejectedValueOnce(new Error("init failed"));
    await startRun({ task: "do something", maxSteps: 10, mode: "standard" });
    expect(isRunStarting()).toBe(false);
    expect(clearRunStateForRun).toHaveBeenCalled();
  });

  test("(c) a wireAbortController throw releases the guard + clears state", async () => {
    setRunStarting(true);
    wireAbortController.mockImplementationOnce(() => {
      throw new Error("wire failed");
    });
    await startRun({ task: "do something", maxSteps: 10, mode: "standard" });
    expect(isRunStarting()).toBe(false);
    expect(clearRunStateForRun).toHaveBeenCalled();
  });

  test("(d) finally emits a metrics summary when a callback is present", async () => {
    await startRun({ task: "do something", maxSteps: 10, mode: "standard" });
    expect(
      sentEvents.some((e) => e.type === "info" && /Run metrics/.test(e.message ?? "")),
    ).toBe(true);
  });

  test("(e) never clears abortRequested during init (STOP during init must survive)", async () => {
    // A STOP that lands while startRun is still initializing must not be
    // wiped by any state reset — the post-wire re-check + storage listener
    // depend on the flag surviving. The ONLY places that clear run state are
    // cleanupRun (normal run end) and onServiceWorkerStartup (interrupted-run
    // SW restart), never startRun's init path.
    const clearRunStateMock = stateStore.clearRunState as ReturnType<typeof vi.fn>;
    await startRun({ task: "do something", maxSteps: 10, mode: "standard" });
    expect(clearRunStateMock).not.toHaveBeenCalled();
  });

  test("(f) a STOP persisted during init aborts the run at the post-wire re-check", async () => {
    // Simulate: handleStop's saveRunState({abortRequested:true}) lands during
    // init; the re-check after wireAbortController must see it, emit the
    // stop events, and clean up WITHOUT starting the loop.
    const getRunState = stateStore.getRunState as ReturnType<typeof vi.fn>;
    getRunState.mockResolvedValueOnce({ runId: "test-run-1", abortRequested: true });
    await startRun({ task: "do something", maxSteps: 10, mode: "standard" });
    expect(sentEvents.some((e) => e.type === "info" && /Agent stopped by user/.test(e.message ?? ""))).toBe(true);
    expect(sentEvents.some((e) => e.type === "done" && e.success === false)).toBe(true);
    expect(runAgentLoop).not.toHaveBeenCalled();
    expect(cleanupRun).toHaveBeenCalled();
  });

  test("reserving authority makes an immediate STOP win before the first tab side effect", async () => {
    // Mirrors RUN: reserve synchronously, then STOP arrives while the handler
    // is still awaiting storage. startRun must consume the cancelled
    // reservation and finish without even querying/creating a tab.
    setRunStarting(true);
    reserveManualRunAuthority({ task: "do not act", maxSteps: 10, mode: "standard" });
    runController.requestCurrentRunCancellation("Stop requested by user.");

    await startRun({ task: "do not act", maxSteps: 10, mode: "standard" });

    expect((globalThis.chrome.tabs.query as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(isRunStarting()).toBe(false);
    const cancellationEnvelopes = (
      (globalThis.chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock.calls
        .map(([message]) => message as {
          type?: string;
          runId?: string;
          revision?: number;
          event?: { type?: string; message?: string; text?: string };
        })
        .filter((message) => message.type === "AGENT_EVENT" &&
          (message.event?.message === "Agent stopped by user." ||
            message.event?.text === "Agent stopped by user."))
    );
    expect(cancellationEnvelopes).toHaveLength(2);
    expect(cancellationEnvelopes.map((message) => message.runId)).toEqual([
      cancellationEnvelopes[0].runId,
      cancellationEnvelopes[0].runId,
    ]);
    expect(cancellationEnvelopes[0].runId).toMatch(/^test-run-/);
    expect(cancellationEnvelopes.map((message) => message.revision)).toEqual([
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(cancellationEnvelopes[1].revision).toBeGreaterThan(cancellationEnvelopes[0].revision!);
  });

  test("a late successful done after Stop cannot enter history or make the terminal snapshot succeed", async () => {
    runAgentLoop.mockImplementationOnce(async (deps: { onEvent: (event: unknown) => void }) => {
      runController.requestCurrentRunCancellation("Stop requested by user.");
      deps.onEvent({ type: "done", step: 0, success: true, text: "late success" });
      deps.onEvent({ type: "cost", step: 0, tokensIn: 10, tokensOut: 10, costUsd: 1, model: "late" });
      deps.onEvent({ type: "action", step: 0, index: 1, total: 1, name: "click", description: "late action" });
    });

    await startRun({ task: "do something", maxSteps: 10, mode: "standard" });

    const cleanupContext = cleanupRun.mock.calls[0][0] as {
      runSucceeded: boolean;
      terminalSnapshot: { status: string; terminalReason?: string; usage?: unknown; resultText?: string };
      runBuilder: { finish: (fallback: { success: boolean; text: string }) => { result: { success: boolean } } };
    };
    expect(cleanupContext.runSucceeded).toBe(false);
    expect(cleanupContext.terminalSnapshot).toMatchObject({
      status: "cancelled",
      terminalReason: "cancelled",
    });
    expect(cleanupContext.terminalSnapshot.usage).toBeUndefined();
    expect(cleanupContext.terminalSnapshot.resultText).toBeUndefined();
    expect(runHistorySpy.events.flat()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "done", success: true }),
      expect.objectContaining({ type: "cost" }),
      expect.objectContaining({ type: "action" }),
    ]));
    // cleanupRun persists with this same snapshot-authoritative fallback.
    expect(cleanupContext.runBuilder.finish({
      success: cleanupContext.terminalSnapshot.status === "succeeded",
      text: "Agent stopped by user.",
    }).result.success).toBe(false);
  });
});

// ── privileged active tab → auto-open a fresh tab (regression) ──────────────
//
// Bug surfaced by the user: when the active tab is a privileged page
// (chrome://newtab, chrome-extension://options.html, etc.) startRun
// hard-failed with `recoverable: false`, which made the extension unusable
// from the new-tab page ("agent ai extension" UX). The fix: open a fresh
// `about:blank` tab and proceed with the run on it — the agent then uses
// its `navigate` action to go to the target site.

describe("startRun privileged active tab handling", () => {
  let chromeAny: {
    tabs: { query: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    // Re-stub chrome with overridable per-test tabs.create.
    chromeAny = {
      tabs: {
        query: vi.fn(async () => [{ id: 1, url: "chrome://newtab/" }]),
        create: vi.fn(async () => ({ id: 99, url: "about:blank" })),
      },
    };
    (globalThis as Record<string, unknown>).chrome = {
      tabs: chromeAny.tabs,
      storage: {
        local: {
          get: vi.fn(async () => ({
            maxActions: undefined, plannerInterval: undefined, maxFailures: undefined,
            costCap: undefined, maxSteps: undefined,
            allowedDomains: undefined, blockedDomains: undefined,
          })),
        },
      },
      runtime: {
        sendMessage: vi.fn((msg: { event?: { type: string; message?: string } }) => {
          if (msg?.event) sentEvents.push(msg.event);
          return Promise.resolve();
        }),
      },
    };
  });

  test("auto-opens a fresh tab when active tab is chrome://newtab and proceeds (does not hard-fail)", async () => {
    await startRun({ task: "go to example.com", maxSteps: 10, mode: "standard" });

    // Verify chrome.tabs.create was called with active:true (opens about:blank
    // by default — Chrome's standard canvas for content scripts).
    expect(chromeAny.tabs.create).toHaveBeenCalledWith({ active: true });

    // The run MUST proceed — runAgentLoop was called (no hard-fail).
    expect(runAgentLoop).toHaveBeenCalledTimes(1);

    // An info event surfaces so the user sees what happened (not a silent
    // redirect).
    expect(
      sentEvents.some(
        (e) => e.type === "info" && /privileged|opened a new tab/i.test(e.message ?? ""),
      ),
    ).toBe(true);

    // No recoverable:false error event was emitted for the privileged-page
    // condition.
    expect(
      sentEvents.some(
        (e) => e.type === "error" && /Cannot run on a privileged page/i.test(e.message ?? ""),
      ),
    ).toBe(false);
  });

  test("still hard-fails on query error (not masking real errors)", async () => {
    chromeAny.tabs.query.mockRejectedValueOnce(new Error("disconnected"));
    await startRun({ task: "do something", maxSteps: 10, mode: "standard" });
    expect(runAgentLoop).not.toHaveBeenCalled();
    expect(
      sentEvents.some((e) => e.type === "error" && /Tab query failed/i.test(e.message ?? "")),
    ).toBe(true);
    // The recoverable:false tab-query path did NOT accidentally open a new tab.
    expect(chromeAny.tabs.create).not.toHaveBeenCalled();
  });
});
