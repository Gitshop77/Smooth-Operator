/**
 * Phase 9 — explicit run-state machine tests.
 *
 * Covers the typed run-phase machine (`run-state-machine.ts`) and the
 * orchestrator flows that drive it:
 *
 * - the transition table itself (documented edges, illegal edges throw,
 *   terminal stickiness),
 * - a full legal phase walk (init → plan → observe → act → verify →
 *   observe → … → terminal),
 * - adversarial/edge runs through the real `runAgentLoop`: ambiguous goals,
 *   repeated failures, partial writes, stale observations, restart
 *   (pre-aborted LoopDeps signal), and cost caps.
 */

import { describe, test, expect, vi } from "vitest";
import { runAgentLoop } from "../src/lib/agent/loop/orchestrator";
import {
  RUN_TRANSITIONS,
  RUN_PHASE_DESCRIPTIONS,
  assertLegalTransition,
  transitionRunPhase,
} from "../src/lib/agent/loop/run-state-machine";
import { initState } from "../src/lib/agent/loop/orchestrator-helpers";
import { DEFAULT_CONFIG, type AgentAction, type ActionResult, type LogEvent } from "../src/lib/agent/types";
import type { LoopDeps, LoopState, RunPhase } from "../src/lib/agent/loop/types";
import { makeState } from "./helpers";

const ALL_PHASES: readonly RunPhase[] = ["init", "plan", "observe", "act", "verify", "recover", "terminal"];

/** Minimal LoopDeps for `initState` (the machine only needs deps at rest). */
function makeDeps(events: LogEvent[] = []): LoopDeps {
  return {
    task: "test task",
    navigatorCall: vi.fn(async () => ({ raw: "{}" })),
    plannerCall: vi.fn(async () => ({ raw: "{}" })),
    getTabs: vi.fn(async () => []),
    onEvent: (e: LogEvent) => events.push(e),
    settleDelay: 0,
  };
}

// ─── Transition table ───────────────────────────────────────────────────────

describe("RUN_TRANSITIONS (documented transition table)", () => {
  test("declares exactly the documented edges", () => {
    expect(RUN_TRANSITIONS).toEqual({
      init: ["plan", "terminal"],
      plan: ["observe", "terminal"],
      observe: ["act", "recover", "terminal"],
      act: ["verify", "recover", "terminal"],
      verify: ["observe", "terminal"],
      recover: ["observe", "plan", "terminal"],
      terminal: [],
    });
  });

  test("terminal is sticky — no outgoing transitions", () => {
    for (const phase of ALL_PHASES) {
      expect(RUN_TRANSITIONS.terminal).not.toContain(phase);
    }
  });

  test("every phase has a documented description", () => {
    for (const phase of ALL_PHASES) {
      expect(RUN_PHASE_DESCRIPTIONS[phase].length).toBeGreaterThan(10);
    }
  });

  test("every table edge points to a known phase", () => {
    for (const from of ALL_PHASES) {
      for (const to of RUN_TRANSITIONS[from]) {
        expect(ALL_PHASES).toContain(to);
      }
    }
  });
});

describe("assertLegalTransition (fail-closed enforcement)", () => {
  test("accepts every documented edge", () => {
    for (const [from, tos] of Object.entries(RUN_TRANSITIONS)) {
      for (const to of tos) {
        expect(() => assertLegalTransition(from as RunPhase, to as RunPhase)).not.toThrow();
      }
    }
  });

  test("throws on illegal edges (init → act, plan → verify, terminal → observe)", () => {
    expect(() => assertLegalTransition("init", "act")).toThrow(/Illegal run-phase transition: init → act/);
    expect(() => assertLegalTransition("plan", "verify")).toThrow(/Illegal run-phase transition: plan → verify/);
    expect(() => assertLegalTransition("terminal", "observe")).toThrow(/Illegal run-phase transition: terminal → observe/);
    expect(() => assertLegalTransition("verify", "act")).toThrow(/Illegal run-phase transition: verify → act/);
  });
});

describe("transitionRunPhase", () => {
  test("advances state.phase and records the transition with reason + step + timing", () => {
    const state = initState(makeDeps(), DEFAULT_CONFIG);
    expect(state.phase).toBe("init");

    const t = transitionRunPhase(state, "plan", "initial planner phase begins");
    expect(t).toMatchObject({ from: "init", to: "plan", reason: "initial planner phase begins", step: 0 });
    expect(t.ts).toBeGreaterThan(0);
    expect(t.durationMs).toBe(0); // first transition
    expect(state.phase).toBe("plan");
    // The transition log is append-only: the whole phase path is reconstructable.
    expect(state.transitions).toHaveLength(1);
    expect(state.transitions[0]).toEqual(t);
  });

  test("transition log is reconstructable by replay (from→to sequence + durations)", () => {
    const state = initState(makeDeps(), DEFAULT_CONFIG);
    const walk: Array<[RunPhase, string]> = [
      ["plan", "initial planner"],
      ["observe", "step begins"],
      ["act", "navigator call"],
      ["recover", "step rollover"],
      ["plan", "periodic planner"],
      ["terminal", "done"],
    ];
    for (const [to, reason] of walk) {
      transitionRunPhase(state, to, reason);
    }
    expect(state.transitions.map((r) => `${r.from}→${r.to}`)).toEqual([
      "init→plan",
      "plan→observe",
      "observe→act",
      "act→recover",
      "recover→plan",
      "plan→terminal",
    ]);
    // durationMs is monotonic-ish: each subsequent transition measures from the
    // previous one's ts (>= 0) and the last ts is >= all earlier ones.
    for (let i = 1; i < state.transitions.length; i++) {
      expect(state.transitions[i].durationMs).toBeGreaterThanOrEqual(0);
      expect(state.transitions[i].ts).toBeGreaterThanOrEqual(state.transitions[i - 1].ts);
    }
  });

  test("a full legal phase walk (init → plan → observe → act → verify → observe → act → recover → plan → observe → terminal)", () => {
    const state = initState(makeDeps(), DEFAULT_CONFIG);
    const walk: RunPhase[] = [
      "plan", "observe", "act", "verify", "observe", "act",
      "recover", "plan", "observe", "act", "terminal",
    ];
    for (const to of walk) {
      transitionRunPhase(state, to, "walk");
    }
    expect(state.phase).toBe("terminal");
  });

  test("terminal is sticky — re-transitioning to terminal is a no-op, not an error", () => {
    const state = initState(makeDeps(), DEFAULT_CONFIG);
    transitionRunPhase(state, "terminal", "run ended");
    expect(state.phase).toBe("terminal");
    // Multiple terminal paths can fire in one run (e.g. a cost-capped
    // compaction continues the step and a later catch re-finishes) — the
    // second terminal transition must not throw.
    expect(() => transitionRunPhase(state, "terminal", "re-finish")).not.toThrow();
    expect(state.phase).toBe("terminal");
  });

  test("throws on an illegal transition from a live state", () => {
    const state = initState(makeDeps(), DEFAULT_CONFIG);
    transitionRunPhase(state, "plan", "begin");
    expect(() => transitionRunPhase(state, "verify", "skip the loop")).toThrow(/Illegal run-phase transition: plan → verify/);
  });
});

// ─── Orchestrator flows through the machine ─────────────────────────────────

/**
 * Base deps: planner continues with a plan; navigator emits one benign
 * action per step. Override per test.
 */
function makeRunDeps(overrides: Partial<LoopDeps> & { events: LogEvent[] }): LoopDeps {
  return {
    task: "test task",
    navigatorCall: vi.fn(async () => ({
      raw: JSON.stringify({
        thinking: "x",
        evaluation_previous_goal: "y",
        memory: "z",
        next_goal: "w",
        action: [{ type: "scroll", down: true, pages: 1 } as AgentAction],
      }),
    })),
    plannerCall: vi.fn(async () => ({
      raw: JSON.stringify({
        thinking: "x",
        decision: "continue",
        plan: ["a", "b"],
        current_plan_item: 0,
        next_goal: "g",
      }),
    })),
    getTabs: vi.fn(async () => [
      { id: 1, label: "1", url: "https://example.com", title: "t", active: true },
    ]),
    extractState: vi.fn(async () => makeState()),
    executeActions: vi.fn(async (actions: AgentAction[]) =>
      actions.map((action) => ({ action, success: true, message: "ok" } as ActionResult)),
    ),
    onEvent: (e: LogEvent) => overrides.events.push(e),
    settleDelay: 0,
    config: {
      maxSteps: 3,
      maxActionsPerStep: 10,
      plannerInterval: 100,
      maxFailures: 5,
      enableLoopDetection: true,
      enableCompaction: false,
      compactionStepInterval: 1000,
      compactionCharThreshold: 1_000_000,
      enableJudge: false,
      enableEarlyStop: false,
    },
    ...overrides,
  };
}

describe("runAgentLoop — ambiguous goal falls back to the plan item", () => {
  test("planner continue without next_goal hands the plan item to the navigator", async () => {
    const events: LogEvent[] = [];
    const deps = makeRunDeps({ events });
    // Initial planner omits next_goal entirely.
    (deps.plannerCall as ReturnType<typeof vi.fn>).mockResolvedValue({
      raw: JSON.stringify({
        thinking: "x",
        decision: "continue",
        plan: ["first plan item", "second plan item"],
        current_plan_item: 0,
      }),
    });

    await runAgentLoop(deps);

    // The planner-step event must carry the fallback goal (plan[0]), never
    // an empty/undefined goal.
    const plannerStep = events.find((e) => e.type === "planner-step") as
      | Extract<LogEvent, { type: "planner-step" }>
      | undefined;
    expect(plannerStep).toBeDefined();
    expect(plannerStep!.goal).toBe("first plan item");
    expect(plannerStep!.goal?.length).toBeGreaterThan(0);
  });
});

describe("runAgentLoop — repeated failures abort via maxFailures (recover → terminal)", () => {
  test("transient network failures after the planner trip maxFailures, not the parse-retry loop", async () => {
    const events: LogEvent[] = [];
    const deps = makeRunDeps({ events });
    // Every navigator call throws a RETRYABLE (network) error — never a
    // parse failure, so the parse-retry loop must not fire; the step-level
    // failure ladder must reach maxFailures (5) and abort BEFORE the step
    // cap (20).
    (deps.navigatorCall as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fetch failed: ECONNREFUSED"));
    deps.config = { ...deps.config!, maxSteps: 20 };

    await runAgentLoop(deps);

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]).toMatchObject({ type: "done", success: false });
    expect((doneEvents[0] as Extract<LogEvent, { type: "done" }>).text).toMatch(/consecutive failures/i);
    // maxFailures=5 → exactly 5 navigator attempts (one per step), no retry
    // amplification.
    expect(deps.navigatorCall).toHaveBeenCalledTimes(5);
  });
});

describe("runAgentLoop — executeActions override failure transitions to recover", () => {
  test("a recoverable throwing executeActions override retries to maxFailures instead of throwing an illegal transition", async () => {
    const events: LogEvent[] = [];
    const deps = makeRunDeps({ events });
    // Every executeActions call throws a recoverable (non-abort) adapter error.
    (deps.executeActions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom: transient adapter failure"));
    deps.config = { ...deps.config!, maxFailures: 3 };

    await runAgentLoop(deps);

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]).toMatchObject({ type: "done", success: false });
    const text = (doneEvents[0] as Extract<LogEvent, { type: "done" }>).text;
    // The failure ladder must be honored: the run ends with the intended
    // "consecutive failures" text, NOT an internal "Illegal run-phase
    // transition" error (which previously bypassed the ladder on the first
    // recoverable override failure).
    expect(text).toMatch(/consecutive failures/i);
    expect(text).not.toMatch(/Illegal run-phase transition/i);
    // maxFailures=3 → exactly 3 executeActions attempts (one per step).
    expect(deps.executeActions).toHaveBeenCalledTimes(3);
  });
});


describe("runAgentLoop — partial writes do not advance consecutiveFailures", () => {
  test("a step where most actions succeed resets the failure counter", async () => {
    const events: LogEvent[] = [];
    const deps = makeRunDeps({ events });
    // Every step: 2 of 3 actions succeed → not a "failed step".
    (deps.executeActions as ReturnType<typeof vi.fn>).mockImplementation(async (actions: AgentAction[]) =>
      actions.map((action, i) => ({ action, success: i < 2, message: i < 2 ? "ok" : "failed" } as ActionResult)),
    );
    (deps.navigatorCall as ReturnType<typeof vi.fn>).mockResolvedValue({
      raw: JSON.stringify({
        thinking: "x",
        evaluation_previous_goal: "y",
        memory: "z",
        next_goal: "w",
        action: [
          { type: "click", index: 1 } as AgentAction,
          { type: "click", index: 2 } as AgentAction,
          { type: "click", index: 3 } as AgentAction,
        ],
      }),
    });

    await runAgentLoop(deps);

    // 3 steps run to the max-steps cap — the failing-step accounting must
    // not poison the run (majority-success steps reset the counter).
    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
    expect((doneEvents[0] as Extract<LogEvent, { type: "done" }>).text).toMatch(/max steps/i);
    expect(events.filter((e) => e.type === "navigator-step-start").length).toBe(3);
  });
});

describe("runAgentLoop — stale observations trigger the stagnation loop-stop", () => {
  test("identical page snapshots across steps abort via the loop detector", async () => {
    const events: LogEvent[] = [];
    const deps = makeRunDeps({ events });
    // The page NEVER changes: same URL, same title, same elementsText, same
    // element count — a stale-observation loop.
    (deps.extractState as ReturnType<typeof vi.fn>).mockResolvedValue(makeState({
      url: "https://stale.example.com",
      title: "stale",
      elementsText: "[unchanged page content]",
    }));
    deps.config = {
      ...deps.config!,
      enableLoopDetection: true,
      enableEarlyStop: true,
      maxSteps: 40, // well above the stagnation threshold (12) so the STOP is what ends the run
    };

    await runAgentLoop(deps);

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]).toMatchObject({ type: "done", success: false });
    expect((doneEvents[0] as Extract<LogEvent, { type: "done" }>).text).toMatch(/stagnant|loop detected/i);
    // The run stopped well before the 40-step budget.
    const stepStarts = events.filter((e) => e.type === "navigator-step-start");
    expect(stepStarts.length).toBeLessThan(40);
    // A loop-warning must have fired on the way.
    expect(events.some((e) => e.type === "loop-warning")).toBe(true);
  });
});

describe("runAgentLoop — restart (pre-aborted LoopDeps signal)", () => {
  test("a pre-aborted run performs ZERO LLM calls and ends with the canonical stop", async () => {
    const events: LogEvent[] = [];
    const controller = new AbortController();
    controller.abort();
    const deps = makeRunDeps({ events });
    deps.signal = controller.signal;

    await runAgentLoop(deps);

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]).toMatchObject({ type: "done", success: false });
    expect((doneEvents[0] as Extract<LogEvent, { type: "done" }>).text).toBe("Agent stopped by user.");
    // No provider work on a dead run.
    expect(deps.plannerCall).not.toHaveBeenCalled();
    expect(deps.navigatorCall).not.toHaveBeenCalled();
  });
});

describe("runAgentLoop — cost cap short-circuits the run (act → terminal)", () => {
  test("a single overshoot navigator call trips the cap; no further calls fire", async () => {
    const events: LogEvent[] = [];
    const deps = makeRunDeps({ events });
    deps.config = { ...deps.config!, costCapUsd: 1, maxSteps: 20 };
    // The navigator's first call reports $5 of cost (the planner accrues 0).
    (deps.navigatorCall as ReturnType<typeof vi.fn>).mockResolvedValue({
      raw: JSON.stringify({
        thinking: "x",
        evaluation_previous_goal: "y",
        memory: "z",
        next_goal: "w",
        action: [{ type: "scroll", down: true, pages: 1 } as AgentAction],
      }),
      costUsd: 5,
      model: "test-model",
    });

    await runAgentLoop(deps);

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]).toMatchObject({ type: "done", success: false });
    expect((doneEvents[0] as Extract<LogEvent, { type: "done" }>).text).toMatch(/cost cap|Budget exceeded/i);
    // The cap trips immediately after the overshoot call — no blind retry,
    // no next step.
    expect(deps.navigatorCall).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === "navigator-step-start").length).toBe(1);
  });
});

// ─── Type-level guards ──────────────────────────────────────────────────────

describe("RunPhase type surface", () => {
  test("LoopState.phase is a RunPhase (initState starts at init)", () => {
    const state: LoopState = initState(makeDeps(), DEFAULT_CONFIG);
    expect(state.phase).toBe("init");
  });
});

