/**
 * Completion-with-evidence + blind-retry elimination tests.
 *
 * Completion-with-evidence: a planner `done(success=true)` finalizes ONLY
 * with positive completion evidence (passing deterministic evaluator or an
 * agreeing LLM judge). An in-run done claim with no deterministic evidence
 * and a disabled judge is routed back (unverified) — never finalized on the
 * bare claim. The old `!finalAttempt && !expectedOutcomes → finalize(true)`
 * shortcut is gone.
 *
 * Blind-retry elimination: `callNavigatorWithRetry` re-invokes the navigator
 * ONLY on genuinely recoverable PARSE failures. Budget/cost-cap/auth/terminal
 * errors short-circuit — a single attempt, then the error propagates.
 */

import { describe, test, expect, vi } from "vitest";
import { maybeJudgeAndFinalize } from "../src/lib/agent/loop/helpers/judges";
import { callNavigatorWithRetry } from "../src/lib/agent/loop/helpers/llm-calls";
import { MAX_PARSE_RETRIES } from "../src/lib/agent/loop/constants";
import { runAgentLoop } from "../src/lib/agent/loop/orchestrator";
import { LoopDetector } from "../src/lib/agent/loop/loop-detector";
import { CallbackDispatcher, type CallbackContext } from "../src/lib/agent/callbacks";
import {
  DEFAULT_CONFIG,
  type AgentConfig,
  type AgentStepRequest,
  type AgentAction,
  type LogEvent,
} from "../src/lib/agent/types";
import type { LoopDeps, LoopState } from "../src/lib/agent/loop/types";
import { makeState } from "./helpers";

// ─── maybeJudgeAndFinalize harness ──────────────────────────────────────────

function makeLoopState(deps: LoopDeps, capturedEvents: LogEvent[], config: AgentConfig): LoopState {
  return {
    deps,
    config,
    task: "test task",
    onEvent: (e: LogEvent) => capturedEvents.push(e),
    settleDelay: 0,
    phase: "init",
    navigatorHistory: [],
    loopDetector: new LoopDetector(),
    plan: undefined,
    currentPlanItem: undefined,
    step: 0,
    navigatorStepsSincePlanner: 0,
    consecutiveFailures: 0,
    consecutiveParseFailures: 0,
    totalCostUsd: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    lastCompactionStep: undefined,
    compactedMemory: undefined,
    pendingLoopWarning: undefined,
    budgetWarningFired: false,
    transitions: [],
    consecutiveJudgeRejections: 0,
    costBudgetWarningFired: false,
    currentGoal: "test",
    dispatcher: new CallbackDispatcher(),
  };
}

function makeDeps(capturedEvents: LogEvent[], overrides: Partial<LoopDeps> = {}): LoopDeps {
  return {
    task: "test",
    navigatorCall: vi.fn(async () => ({ raw: "" })),
    plannerCall: vi.fn(async () => ({ raw: "not json" })),
    getTabs: vi.fn(async () => []),
    onEvent: (e: LogEvent) => capturedEvents.push(e),
    ...overrides,
  };
}

async function runJudge(
  deps: LoopDeps,
  state: LoopState,
  judgeArgsOverrides: Record<string, unknown> = {},
): Promise<boolean> {
  const baseArgs = {
    step: 0,
    success: true,
    text: "agent claims done",
    navigatorHistory: [],
    onCost: () => {},
  };
  const ctx: CallbackContext = { task: "test", step: 0, history: [] };
  return maybeJudgeAndFinalize(
    deps,
    state.config,
    { ...baseArgs, ...judgeArgsOverrides } as Parameters<typeof maybeJudgeAndFinalize>[2],
    state,
    state.dispatcher,
    ctx,
  );
}

const AGREEING_JUDGE = JSON.stringify({
  reasoning: "trajectory complete", verdict: true, failureReason: null,
  impossibleTask: false, reachedCaptcha: false,
});
const DISAGREEING_JUDGE = JSON.stringify({
  reasoning: "incomplete", verdict: false, failureReason: "missing step",
  impossibleTask: false, reachedCaptcha: false,
});

describe("maybeJudgeAndFinalize — completion-with-evidence", () => {
  test("in-run done(success=true) + judge disabled + no deterministic evidence → ROUTED BACK (never bare-claim success)", async () => {
    const events: LogEvent[] = [];
    const deps = makeDeps(events);
    const state = makeLoopState(deps, events, { ...DEFAULT_CONFIG, enableJudge: false });

    const finalized = await runJudge(deps, state, { finalAttempt: false });

    expect(finalized).toBe(false);
    expect(state.finalResult).toBeUndefined();
    expect(events.find((e) => e.type === "done" && e.success === true)).toBeUndefined();
    // The routing-back is observable.
    expect(events.some((e) => e.type === "info" && e.message.includes("unverified"))).toBe(true);
  });

  test("in-run done(success=true) + agreeing judge → FINALIZED success (the judge is the evidence)", async () => {
    const events: LogEvent[] = [];
    const deps = makeDeps(events, {
      // The judge LLM rides the summarizeCall channel (as in production).
      summarizeCall: vi.fn(async () => ({ content: AGREEING_JUDGE })),
    });
    const state = makeLoopState(deps, events, { ...DEFAULT_CONFIG, enableJudge: true });

    const finalized = await runJudge(deps, state, { finalAttempt: false });

    expect(finalized).toBe(true);
    expect(state.finalResult).toEqual({ success: true, text: "agent claims done" });
    expect(events.find((e) => e.type === "done" && e.success === true)).toBeDefined();
  });

  test("in-run done(success=true) + disagreeing judge → routed back (fail-closed)", async () => {
    const events: LogEvent[] = [];
    const deps = makeDeps(events, {
      summarizeCall: vi.fn(async () => ({ content: DISAGREEING_JUDGE })),
    });
    const state = makeLoopState(deps, events, { ...DEFAULT_CONFIG, enableJudge: true });

    const finalized = await runJudge(deps, state, { finalAttempt: false });

    expect(finalized).toBe(false);
    expect(state.finalResult).toBeUndefined();
  });

  test("in-run done(success=true) + unreachable judge (null verdict) → routed back, NOT success", async () => {
    const events: LogEvent[] = [];
    const deps = makeDeps(events, {
      summarizeCall: vi.fn(async () => ({ content: "not json at all" })),
    });
    const state = makeLoopState(deps, events, { ...DEFAULT_CONFIG, enableJudge: true });

    const finalized = await runJudge(deps, state, { finalAttempt: false });

    expect(finalized).toBe(false);
    expect(state.finalResult).toBeUndefined();
  });

  test("initial-planner done (finalAttempt true) + judge disabled → trusts the direct answer (preserved operator choice)", async () => {
    const events: LogEvent[] = [];
    const deps = makeDeps(events);
    const state = makeLoopState(deps, events, { ...DEFAULT_CONFIG, enableJudge: false });

    const finalized = await runJudge(deps, state, { finalAttempt: true });

    expect(finalized).toBe(true);
    expect(state.finalResult).toEqual({ success: true, text: "agent claims done" });
  });

  test("passing deterministic evaluator is positive evidence — LLM judge skipped", async () => {
    const events: LogEvent[] = [];
    const judgeSpy = vi.fn(async () => ({ content: DISAGREEING_JUDGE }));
    const deps = makeDeps(events, { summarizeCall: judgeSpy });
    const state = makeLoopState(deps, events, {
      ...DEFAULT_CONFIG,
      enableJudge: true,
      // A string evaluator that the claim text satisfies.
      expectedOutcomes: { string: [{ type: "must_include", ref: "done" }] },
    });

    const finalized = await runJudge(deps, state, { finalAttempt: false, text: "task done" });

    expect(finalized).toBe(true);
    expect(state.finalResult?.success).toBe(true);
    // The deterministic pass short-circuits the LLM judge.
    expect(judgeSpy).not.toHaveBeenCalled();
  });

  test("failing deterministic evaluator + disabled judge → finalizes FAILURE (authoritative, unchanged)", async () => {
    const events: LogEvent[] = [];
    const deps = makeDeps(events);
    const state = makeLoopState(deps, events, {
      ...DEFAULT_CONFIG,
      enableJudge: false,
      expectedOutcomes: { string: [{ type: "must_include", ref: "MISSING" }] },
    });

    const finalized = await runJudge(deps, state, { finalAttempt: false, text: "task done" });

    expect(finalized).toBe(true); // finalized…
    expect(state.finalResult?.success).toBe(false); // …but as FAILURE
  });
});


// ─── callNavigatorWithRetry — blind-retry elimination ───────────────────────

const NAV_REQUEST: AgentStepRequest = {
  task: "test",
  history: [],
  browserState: {
    url: "https://example.com", title: "t", tabs: [],
    elementsText: "[x]", pageInfo: "", newElementCount: 0,
  },
  step: 0,
  maxSteps: 10,
};

function makeRetryDeps(navigatorImpl: () => Promise<unknown>): LoopDeps {
  return {
    task: "test",
    navigatorCall: vi.fn(navigatorImpl) as unknown as LoopDeps["navigatorCall"],
    plannerCall: vi.fn(async () => ({ raw: "{}" })),
    getTabs: vi.fn(async () => []),
    onEvent: () => {},
  };
}

describe("callNavigatorWithRetry — retries ONLY on recoverable parse errors", () => {
  test("unparseable output IS retried exactly MAX_PARSE_RETRIES times, then throws", async () => {
    const navigatorCall = vi.fn(async () => ({ raw: "this is not the agent output json" }));
    const deps = makeRetryDeps(navigatorCall);

    await expect(callNavigatorWithRetry(deps, NAV_REQUEST, 0, () => {})).rejects.toThrow(/unparseable/);
    // 1 original + MAX_PARSE_RETRIES retries.
    expect(navigatorCall).toHaveBeenCalledTimes(MAX_PARSE_RETRIES + 1);
  });

  test("AUTH error (401) short-circuits — exactly ONE call, no blind retry", async () => {
    const navigatorCall = vi.fn(async () => { throw new Error("401 unauthorized: invalid api key"); });
    const deps = makeRetryDeps(navigatorCall);

    await expect(callNavigatorWithRetry(deps, NAV_REQUEST, 0, () => {})).rejects.toThrow(/401 unauthorized/);
    expect(navigatorCall).toHaveBeenCalledTimes(1);
  });

  test("BUDGET/cost-cap error short-circuits — exactly ONE call, no blind retry", async () => {
    const navigatorCall = vi.fn(async () => ({
      raw: JSON.stringify({
        thinking: "x", evaluation_previous_goal: "y", memory: "z", next_goal: "w",
        action: [{ type: "scroll", down: true, pages: 1 } as AgentAction],
      }),
      costUsd: 5,
      model: "m",
    }));
    const deps = makeRetryDeps(navigatorCall);

    await expect(
      callNavigatorWithRetry(deps, NAV_REQUEST, 0, () => {}, undefined, undefined, undefined, 1, () => true),
    ).rejects.toThrow(/Budget exceeded/);
    expect(navigatorCall).toHaveBeenCalledTimes(1);
  });

  test("rate-limit (429) provider error is NOT parse-retried — one call, propagates", async () => {
    const navigatorCall = vi.fn(async () => { throw new Error("429 too many requests"); });
    const deps = makeRetryDeps(navigatorCall);

    await expect(callNavigatorWithRetry(deps, NAV_REQUEST, 0, () => {})).rejects.toThrow(/429/);
    expect(navigatorCall).toHaveBeenCalledTimes(1);
  });

  test("end-to-end: a fatal auth error terminates the run without re-issuing the navigator call", async () => {
    const events: LogEvent[] = [];
    const navigatorCall = vi.fn(async () => { throw new Error("401 unauthorized"); });
    const deps: LoopDeps = {
      task: "test task",
      navigatorCall,
      plannerCall: vi.fn(async () => ({
        raw: JSON.stringify({
          thinking: "x", decision: "continue", plan: ["a"], next_goal: "g",
        }),
      })),
      getTabs: vi.fn(async () => [
        { id: 1, label: "1", url: "https://example.com", title: "t", active: true },
      ]),
      extractState: vi.fn(async () => makeState()),
      onEvent: (e: LogEvent) => events.push(e),
      settleDelay: 0,
      config: {
        maxSteps: 3,
        maxActionsPerStep: 10,
        plannerInterval: 100,
        maxFailures: 5,
        enableLoopDetection: false,
        enableCompaction: false,
        compactionStepInterval: 1000,
        compactionCharThreshold: 1_000_000,
        enableJudge: false,
        enableEarlyStop: false,
      },
    };

    await runAgentLoop(deps);

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]).toMatchObject({ type: "done", success: false });
    expect((doneEvents[0] as Extract<LogEvent, { type: "done" }>).text).toMatch(/fatal error \(auth\)/i);
    // The auth failure short-circuits: the navigator was attempted exactly
    // once (no parse-retry re-issue, no next step).
    expect(navigatorCall).toHaveBeenCalledTimes(1);
  });
});

// ─── Guard against weakening the judge fail-open semantics ──────────────────

describe("maybeJudgeAndFinalize — fail-open guards (do not weaken)", () => {
  test("a null verdict never finalizes success even on the final attempt", async () => {
    const events: LogEvent[] = [];
    const deps = makeDeps(events, {
      summarizeCall: vi.fn(async () => ({ content: "garbage" })),
    });
    const state = makeLoopState(deps, events, { ...DEFAULT_CONFIG, enableJudge: true });

    const finalized = await runJudge(deps, state, { finalAttempt: true });

    expect(finalized).toBe(false);
    expect(state.finalResult).toBeUndefined();
    const successDone = events.find((e) => e.type === "done" && e.success === true);
    expect(successDone).toBeUndefined();
  });
});

