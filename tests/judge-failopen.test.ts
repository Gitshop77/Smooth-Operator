/**
 * Regression tests for fail-open correctness.
 *
 * A `null` judge verdict (LLM error / unparseable response) MUST NOT be
 * treated as agreement. `maybeJudgeAndFinalize` must NOT finalize with
 * `success: true`.
 * A judge exception (other than a budget cap) MUST NOT fail open. The
 * catch-all in `maybeJudgeAndFinalize` must NOT finalize with
 * `success: true`.
 *
 * Both paths now route back to the planner (`return false`) — consistent with
 * an explicit `verdict === false` (judge disagrees) — so a missing/broken
 * judge never declares success.
 */

import { describe, test, expect, vi } from "vitest";
import { maybeJudgeAndFinalize } from "../src/lib/agent/loop/helpers/judges";
import { CallbackDispatcher, type CallbackContext } from "../src/lib/agent/callbacks";
import { LoopDetector } from "../src/lib/agent/loop/loop-detector";
import { DEFAULT_CONFIG, type AgentConfig, type LogEvent } from "../src/lib/agent/types";
import type { LoopDeps, LoopState } from "../src/lib/agent/loop/types";

/** Build a minimal LoopState for maybeJudgeAndFinalize. */
function makeLoopState(
  deps: LoopDeps,
  capturedEvents: LogEvent[],
  dispatcher?: CallbackDispatcher,
): LoopState {
  const config: AgentConfig = { ...DEFAULT_CONFIG, enableJudge: true };
  return {
    deps,
    config,
    task: "test task",
    onEvent: (e: LogEvent) => capturedEvents.push(e),
    settleDelay: 0,
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
    costBudgetWarningFired: false,
    currentGoal: "test",
    dispatcher,
  };
}

/** Minimal deps for a judge run; plannerCall drives the judge LLM. */
function makeDeps(
  capturedEvents: LogEvent[],
  overrides: Partial<LoopDeps> = {},
): LoopDeps {
  return {
    task: "test",
    navigatorCall: vi.fn(async () => ({ raw: "" })),
    plannerCall: vi.fn(async () => ({ raw: "not json" })),
    getTabs: vi.fn(async () => []),
    onEvent: (e: LogEvent) => capturedEvents.push(e),
    ...overrides,
  };
}

/** Run `maybeJudgeAndFinalize` with the standard base args, merged with overrides. */
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

// ─── positive control (judge agrees → run finalizes as success) ────────

describe("judge success path finalizes correctly (positive control)", () => {
  test("verdict:true + non-throwing onCost → finalized as success with done event", async () => {
    const events: LogEvent[] = [];
    const judgeJson = JSON.stringify({
      reasoning: "looks complete", verdict: true, failureReason: null,
      impossibleTask: false, reachedCaptcha: false,
    });
    const deps = makeDeps(events, {
 // Valid judge response with an affirmative verdict.
      plannerCall: vi.fn(async () => ({ raw: judgeJson, tokensIn: 10, tokensOut: 10, model: "m" })),
    });
    const state = makeLoopState(deps, events);

    const finalized = await runJudge(deps, state);

 // The judge agreed → the run must finalize as success.
    expect(finalized).toBe(true);
    expect(state.finalResult?.success).toBe(true);
    expect(state.finalResult?.text).toBe("agent claims done");

 // A terminal `done` event with success:true must be emitted.
    const successDone = events.find((e) => e.type === "done" && e.success === true);
    expect(successDone).toBeDefined();
  });
});

// ─── null verdict (unparseable judge response) ─────────────────────────

describe("null judge verdict must NOT fail open", () => {
  test("non-JSON judge response → run is NOT finalized as success", async () => {
    const events: LogEvent[] = [];
    const deps = makeDeps(events, {
 // Judge LLM returns garbage → judgeTask returns null (UNVERIFIED).
      plannerCall: vi.fn(async () => ({ raw: "this is not json at all" })),
    });
    const state = makeLoopState(deps, events);

    const finalized = await runJudge(deps, state);

 // Key invariant: a null verdict must never finalize as success:true.
    expect(finalized).toBe(false);
    expect(state.finalResult).toBeUndefined();

 // No terminal `done` event with success:true may be emitted.
    const successDone = events.find((e) => e.type === "done" && e.success === true);
    expect(successDone).toBeUndefined();

 // An info event must explain the judge was unverified.
    const infoEvent = events.find((e) => e.type === "info");
    expect(infoEvent).toBeDefined();
    expect((infoEvent as { message: string }).message).toMatch(/judge could not be reached/i);
  });

  test("judge LLM throws → null verdict → run is NOT finalized as success", async () => {
    const events: LogEvent[] = [];
    const deps = makeDeps(events, {
 // Judge LLM call throws → judgeTask catches and returns null.
      plannerCall: vi.fn(async () => { throw new Error("LLM unavailable"); }),
    });
    const state = makeLoopState(deps, events);

    const finalized = await runJudge(deps, state);

    expect(finalized).toBe(false);
    expect(state.finalResult).toBeUndefined();
    const successDone = events.find((e) => e.type === "done" && e.success === true);
    expect(successDone).toBeUndefined();
  });

  test("explicit verdict:false (judge disagrees) → run is NOT finalized as success", async () => {
    const events: LogEvent[] = [];
    const judgeJson = JSON.stringify({
      reasoning: "x", verdict: false, failureReason: "incomplete",
      impossibleTask: false, reachedCaptcha: false,
    });
    const deps = makeDeps(events, {
 // Valid, parseable judge response that explicitly disagrees. This must route
 // back to the planner (return false) — identical to the null-verdict path.
      plannerCall: vi.fn(async () => ({ raw: judgeJson, tokensIn: 10, tokensOut: 10, model: "m" })),
    });
    const state = makeLoopState(deps, events);

    const finalized = await runJudge(deps, state);

 // An explicit disagreement must never finalize as success:true.
    expect(finalized).toBe(false);
    expect(state.finalResult).toBeUndefined();
 // No terminal `done` event with success:true may be emitted.
    const successDone = events.find((e) => e.type === "done" && e.success === true);
    expect(successDone).toBeUndefined();
  });
});

// ─── judge throws a non-budget error ───────────────────────────────────

describe("non-budget judge error must NOT fail open", () => {
  test("judge throws (via onCost) → run is NOT finalized as success", async () => {
    const events: LogEvent[] = [];
    const judgeJson = JSON.stringify({
      reasoning: "x", verdict: true, failureReason: null,
      impossibleTask: false, reachedCaptcha: false,
    });
    const deps = makeDeps(events, {
 // Valid judge response so we get past parse — the throw comes from onCost.
      plannerCall: vi.fn(async () => ({ raw: judgeJson, tokensIn: 10, tokensOut: 10, model: "m" })),
    });
    const state = makeLoopState(deps, events);

    const finalized = await runJudge(deps, state, {
      onCost: () => { throw new Error("judge transport exploded"); },
    });

    expect(finalized).toBe(false);
    expect(state.finalResult).toBeUndefined();

 // No terminal `done` event with success:true.
    const successDone = events.find((e) => e.type === "done" && e.success === true);
    expect(successDone).toBeUndefined();

 // An error event must explain the judge failed (treated as unverified).
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as { message: string }).message).toMatch(/treating as unverified/i);
  });

  test("budget-exceeded error still finalizes as FAILURE (unchanged)", async () => {
    const events: LogEvent[] = [];
    const judgeJson = JSON.stringify({
      reasoning: "x", verdict: true, failureReason: null,
      impossibleTask: false, reachedCaptcha: false,
    });
    const deps = makeDeps(events, {
      plannerCall: vi.fn(async () => ({ raw: judgeJson, tokensIn: 10, tokensOut: 10, model: "m" })),
    });
    const state = makeLoopState(deps, events);

    const finalized = await runJudge(deps, state, {
      onCost: () => { throw new Error("Budget exceeded: $5.00 limit hit"); },
    });

 // Budget cap is a real failure — preserved from the old behavior.
    expect(finalized).toBe(true);
    expect(state.finalResult?.success).toBe(false);
  });
});
