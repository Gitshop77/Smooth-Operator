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

vi.mock("@/lib/agent/loop/orchestrator", () => ({
  runAgentLoop: vi.fn(async () => {}),
}));

vi.mock("@/lib/agent/run-history", () => ({
  RunBuilder: class {
    addEvent(): void {}
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
  loadAndSetDomainConfig: vi.fn(async () => {}),
  getVisionElementRect: vi.fn(),
}));

vi.mock("../src/extension/background/state-store", () => ({
  saveRunState: vi.fn(async () => {}),
  getRunState: vi.fn(async () => undefined),
  clearRunState: vi.fn(async () => {}),
  loadAndSetDomainConfig: vi.fn(async () => {}),
}));

// ── Imports AFTER mocks ─────────────────────────────────────────────────────

const ab = await import("../src/extension/background/agent-bridge");
const { startRun, consumeDownloadConsentForMode, setRunStarting, isRunStarting } = ab;
const orchestrator = await import("@/lib/agent/loop/orchestrator");
const runHelpers = await import("../src/extension/background/run-helpers");
const stateStore = await import("../src/extension/background/state-store");

const runAgentLoop = orchestrator.runAgentLoop as ReturnType<typeof vi.fn>;
const initRunState = runHelpers.initRunState as ReturnType<typeof vi.fn>;
const wireAbortController = runHelpers.wireAbortController as ReturnType<typeof vi.fn>;
const clearRunState = stateStore.clearRunState as ReturnType<typeof vi.fn>;

let sentEvents: Array<{ type: string; message?: string }>;

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
  sentEvents = [];
  runAgentLoop.mockImplementation(async () => {});
  initRunState.mockImplementation(async () => {});
  wireAbortController.mockImplementation(() => ({
    controller: { signal: { aborted: false } },
    onStorageChanged: vi.fn(),
  }));
  clearRunState.mockImplementation(async () => {});
  setRunStarting(false);
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
    expect(clearRunState).toHaveBeenCalled();
  });

  test("(c) a wireAbortController throw releases the guard + clears state", async () => {
    setRunStarting(true);
    wireAbortController.mockImplementationOnce(() => {
      throw new Error("wire failed");
    });
    await startRun({ task: "do something", maxSteps: 10, mode: "standard" });
    expect(isRunStarting()).toBe(false);
    expect(clearRunState).toHaveBeenCalled();
  });

  test("(d) finally emits a metrics summary when a callback is present", async () => {
    await startRun({ task: "do something", maxSteps: 10, mode: "standard" });
    expect(
      sentEvents.some((e) => e.type === "info" && /Run metrics/.test(e.message ?? "")),
    ).toBe(true);
  });
});
