/**
 * Judge/planner disagreement bound — after JUDGE_CONSECUTIVE_REJECT_LIMIT
 * consecutive judge rejections (verdict false OR null verdict) the run is
 * FORCED through a planner re-plan instead of a plain re-observe, so a
 * stubborn judge+planner cycle cannot burn the whole step budget on one
 * unverified claim.
 */
import { describe, expect, test, vi } from "vitest";
import { maybeJudgeAndFinalize, JUDGE_CONSECUTIVE_REJECT_LIMIT } from "../src/lib/agent/loop/helpers/judges";
import type { LoopDeps, LoopState } from "../src/lib/agent/loop/types";
import { DEFAULT_CONFIG, type LogEvent } from "../src/lib/agent/types";
import { transitionRunPhase } from "../src/lib/agent/loop/run-state-machine";
import { initState } from "../src/lib/agent/loop/orchestrator-helpers";

function makeDeps(events: LogEvent[] = [], judgeJson: string): LoopDeps {
  return {
    task: "test task",
    navigatorCall: vi.fn(async () => ({ raw: "{}" })),
    plannerCall: vi.fn(async () => ({ raw: judgeJson })),
    getTabs: vi.fn(async () => []),
    onEvent: (e: LogEvent) => events.push(e),
    settleDelay: 0,
  };
}

const DISAGREE_JSON = JSON.stringify({ reasoning: "r", verdict: false, failureReason: "no evidence", impossibleTask: false, reachedCaptcha: false });
const AGREE_JSON = JSON.stringify({ reasoning: "r", verdict: true, failureReason: null, impossibleTask: false, reachedCaptcha: false });

function makeArgs(overrides: Partial<Parameters<typeof maybeJudgeAndFinalize>[2]> = {}) {
  return {
    step: 0,
    success: true,
    text: "done",
    navigatorHistory: [],
    onCost: vi.fn(),
    finalAttempt: true,
    ...overrides,
  };
}

describe("judge disagreement bound", () => {
  test("JUDGE_CONSECUTIVE_REJECT_LIMIT is 3", () => {
    expect(JUDGE_CONSECUTIVE_REJECT_LIMIT).toBe(3);
  });

  test("a judge disagreement increments the counter but does not force a replan below the limit", async () => {
    const events: LogEvent[] = [];
    const deps = makeDeps(events, DISAGREE_JSON);
    const state: LoopState = initState(deps, DEFAULT_CONFIG);

    const finalized = await maybeJudgeAndFinalize(deps, { ...DEFAULT_CONFIG, enableJudge: true, expectedOutcomes: undefined }, makeArgs(), state);
    expect(finalized).toBe(false);
    expect(state.consecutiveJudgeRejections).toBe(1);
    expect(state.judgeReplanForced).toBeFalsy();
  });

  test("the third consecutive rejection forces a planner re-plan (judgeReplanForced) and resets the counter", async () => {
    const events: LogEvent[] = [];
    const deps = makeDeps(events, DISAGREE_JSON);
    const state: LoopState = initState(deps, DEFAULT_CONFIG);
    const args = makeArgs();
    for (let i = 0; i < JUDGE_CONSECUTIVE_REJECT_LIMIT; i++) {
      const finalized = await maybeJudgeAndFinalize(deps, { ...DEFAULT_CONFIG, enableJudge: true }, args, state);
      expect(finalized).toBe(false);
    }
    expect(state.consecutiveJudgeRejections).toBe(0); // reset after forcing
    expect(state.judgeReplanForced).toBe(true);
    expect(events.some((e) => e.type === "info" && e.message.includes("forcing a planner re-plan"))).toBe(true);
  });

  test("an agreeing verdict resets the disagreement streak", async () => {
    const events: LogEvent[] = [];
    const deps = makeDeps(events, AGREE_JSON);
    const state: LoopState = initState(deps, DEFAULT_CONFIG);
    state.consecutiveJudgeRejections = 2;
    const finalized = await maybeJudgeAndFinalize(deps, { ...DEFAULT_CONFIG, enableJudge: true }, makeArgs(), state);
    expect(finalized).toBe(true);
    expect(state.consecutiveJudgeRejections).toBe(0);
    expect(state.judgeReplanForced).toBe(false);
  });

  test("the forced-replan flag keeps the phase machine legal (verify → observe rollover after the inline re-plan)", async () => {
    // The fail-closed transition table has NO verify → recover edge; the
    // forced re-plan runs INLINE from verify, and the step rolls over through
    // the documented verify → observe edge on the next iteration.
    const state = initState(makeDeps([], AGREE_JSON), DEFAULT_CONFIG);
    transitionRunPhase(state, "plan", "initial");
    transitionRunPhase(state, "observe", "step");
    transitionRunPhase(state, "act", "navigator");
    transitionRunPhase(state, "verify", "navigator done");
    state.judgeReplanForced = true;
    // The orchestrator's forced-replan branch does NOT leave verify illegally;
    // the next iteration's runNavigatorStep transitions verify → observe.
    transitionRunPhase(state, "observe", "next step begins");
    expect(state.phase).toBe("observe");
    expect(state.transitions.map((t) => `${t.from}→${t.to}`).slice(-1)).toEqual(["verify→observe"]);
  });

  test("rejections separated by many steps (5, 45, 46) do NOT accumulate toward the replan threshold", async () => {
    // rejections at steps 5, 45, 46 previously tripped the
    // "consecutive" bound even though a gap intervened. Only rejections on the
    // SAME step or the immediately-previous step are consecutive; a wider gap
    // breaks the streak.
    const events: LogEvent[] = [];
    const deps = makeDeps(events, DISAGREE_JSON);
    const state: LoopState = initState(deps, DEFAULT_CONFIG);
    for (const step of [5, 45, 46]) {
      state.step = step;
      const finalized = await maybeJudgeAndFinalize(
        deps,
        { ...DEFAULT_CONFIG, enableJudge: true, expectedOutcomes: undefined },
        makeArgs({ step }),
        state,
      );
      expect(finalized).toBe(false);
    }
    // Steps 45 → 46 are consecutive (2 rejections); the step-5 rejection reset
    // the streak, so the bound (3) must NOT trip.
    expect(state.judgeReplanForced).toBeFalsy();
    expect(state.consecutiveJudgeRejections).toBe(2);
  });

  test("rejections on consecutive steps (45, 46, 47) still force a planner re-plan", async () => {
    const events: LogEvent[] = [];
    const deps = makeDeps(events, DISAGREE_JSON);
    const state: LoopState = initState(deps, DEFAULT_CONFIG);
    for (const step of [45, 46, 47]) {
      state.step = step;
      const finalized = await maybeJudgeAndFinalize(
        deps,
        { ...DEFAULT_CONFIG, enableJudge: true, expectedOutcomes: undefined },
        makeArgs({ step }),
        state,
      );
      expect(finalized).toBe(false);
    }
    expect(state.judgeReplanForced).toBe(true);
    expect(state.consecutiveJudgeRejections).toBe(0); // reset after forcing
    expect(events.some((e) => e.type === "info" && e.message.includes("forcing a planner re-plan"))).toBe(true);
  });

  test("multiple judge invocations within the SAME step still accumulate", async () => {
    // The judge+planner can cycle within one step (planner done → judge →
    // continue → navigator done → judge…). Same-step invocations are a single
    // disagreement episode and must keep counting toward the bound.
    const events: LogEvent[] = [];
    const deps = makeDeps(events, DISAGREE_JSON);
    const state: LoopState = initState(deps, DEFAULT_CONFIG);
    state.step = 42;
    for (let i = 0; i < JUDGE_CONSECUTIVE_REJECT_LIMIT; i++) {
      const finalized = await maybeJudgeAndFinalize(
        deps,
        { ...DEFAULT_CONFIG, enableJudge: true, expectedOutcomes: undefined },
        makeArgs({ step: 42 }),
        state,
      );
      expect(finalized).toBe(false);
    }
    expect(state.judgeReplanForced).toBe(true);
    expect(state.consecutiveJudgeRejections).toBe(0); // reset after forcing
  });
});
