/**
 * Run-phase state machine.
 *
 * The orchestrator's control flow is an EXPLICIT typed state machine instead
 * of an implicit while-loop. This module owns:
 *
 * 1. The transition table ({@link RUN_TRANSITIONS}) — the single documented
 *    source of truth for which run-phase transitions are legal.
 * 2. {@link assertLegalTransition} — fail-closed enforcement: an illegal
 *    transition throws instead of silently continuing.
 * 3. {@link transitionRunPhase} — the transition function that advances
 *    `state.phase` and records a {@link RunPhaseTransition}.
 *
 * Every phase transition in the orchestrator goes through
 * {@link transitionRunPhase}; nothing mutates `state.phase` directly.
 *
 * Transition table (real flows, all reachable from the orchestrator):
 *
 * ```
 * init     → plan | terminal
 * plan     → observe | terminal
 * observe  → act | recover | terminal
 * act      → verify | recover | terminal
 * verify   → observe | terminal
 * recover  → observe | plan | terminal
 * terminal → (sticky — no outgoing transitions)
 * ```
 *
 * - `init → plan`: run-start emitted, the initial planner phase begins.
 * - `plan → observe`: the planner returned "continue" (initial or periodic);
 *   the next navigator step's observation begins.
 * - `observe → act`: page state observed, the navigator LLM call begins.
 * - `observe → recover`: a non-fatal observation failure (getTabs /
 *   extractState / challenge re-observe) rolls into the recovery bookkeeping
 *   and the step retries.
 * - `act → verify`: the navigator emitted `done` — the planner verifies and
 *   the judge applies completion-with-evidence.
 * - `act → recover`: a non-fatal navigator LLM / action-execution failure.
 * - `verify → observe`: the judge routed the unverified claim back; the next
 *   step re-observes.
 * - `recover → observe`: plain step rollover continues into the next step.
 * - `recover → plan`: the periodic planner is due after compaction/rollover.
 * - `* → terminal`: every terminal path funnels through the exit helpers
 *   (`finish` / `finishWithRunEnd`), which transition to `terminal`.
 */

import type { LoopState, RunPhase, RunPhaseTransition } from "./types";

/** Every legal outgoing transition per phase (documented above). */
export const RUN_TRANSITIONS: Record<RunPhase, readonly RunPhase[]> = {
  init: ["plan", "terminal"],
  plan: ["observe", "terminal"],
  observe: ["act", "recover", "terminal"],
  act: ["verify", "recover", "terminal"],
  verify: ["observe", "terminal"],
  recover: ["observe", "plan", "terminal"],
  terminal: [],
};

/** Human-readable description of each phase (docs + diagnostics). */
export const RUN_PHASE_DESCRIPTIONS: Record<RunPhase, string> = {
  init: "config validation + state construction + run-start",
  plan: "planner LLM phase (initial call w/ fast-path pre-check, or periodic re-evaluation)",
  observe: "page observation (tabs + state extraction + challenge detection)",
  act: "navigator LLM call + action selection + action execution",
  verify: "planner verification of navigator done + judge (completion-with-evidence)",
  recover: "non-terminal bookkeeping (failure accounting, compaction, rollover)",
  terminal: "terminal done event + runEnd dispatch (sticky)",
};

/**
 * Fail-closed transition check: throws when `from → to` is not in
 * {@link RUN_TRANSITIONS}. An illegal transition is a bug — the run must not
 * silently continue in an undefined phase.
 */
export function assertLegalTransition(from: RunPhase, to: RunPhase): void {
  if (!RUN_TRANSITIONS[from].includes(to)) {
    const allowed = RUN_TRANSITIONS[from].length > 0
      ? RUN_TRANSITIONS[from].join(", ")
      : "(none — terminal is sticky)";
    throw new Error(
      `Illegal run-phase transition: ${from} → ${to} (allowed from ${from}: ${allowed})`,
    );
  }
}

/**
 * Advance the run's phase through the transition table. Records the
 * transition (from → to + reason + step + timing) by APPENDING it to
 * `state.transitions`, so the whole run's phase path is reconstructable by
 * replay (every transition is a checkpoint). Re-transitioning into `terminal`
 * is a no-op (terminal is sticky — multiple terminal paths can fire in one
 * run, e.g. a cost-capped compaction continues the step and a later catch
 * re-finishes, so the second terminal transition must not throw); a sticky
 * no-op is still recorded so the log shows every terminal attempt.
 */
export function transitionRunPhase(
  state: LoopState,
  to: RunPhase,
  reason: string,
): RunPhaseTransition {
  const from = state.phase;
  const now = Date.now();
  // Defensive init: a state object that predates the transition-log field
  // (e.g. a hand-built test fixture) must not crash the machine — the log is
  // an audit aid, never a correctness dependency.
  const transitions = (state.transitions ??= []);
  const previous = transitions[transitions.length - 1];
  const durationMs = previous ? Math.max(0, now - previous.ts) : 0;
  const record: RunPhaseTransition = { from, to, reason, step: state.step, ts: now, durationMs };
  transitions.push(record);
  if (from === "terminal" && to === "terminal") {
    return record;
  }
  assertLegalTransition(from, to);
  state.phase = to;
  return record;
}
