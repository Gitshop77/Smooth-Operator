/**
 * Loop-level regression test for no-op action feedback.
 *
 * When the agent clicks (or runs another page-changing action) and the page
 * state does NOT change, the model was never told — it repeated the identical
 * click until early-stop killed the run. The orchestrator now detects the
 * stagnant snapshot (same page fingerprint as the previous observation) and,
 * when the previous step's executed actions included a page-changing action
 * type, appends a trusted `<sys>` nudge to the next navigator request telling
 * the model the action may have no-oped and to switch strategy.
 *
 * These tests drive the REAL `runAgentLoop` with a mock LLM pair + a mock
 * extractState that returns an IDENTICAL page across every step:
 *  - the request after the click carries the no-op nudge;
 *  - the request after a subsequent scroll-only step does NOT (scroll is
 *    exempt — read-only actions legitimately leave the page unchanged).
 */

import { describe, test, expect, vi } from "vitest";
import { runAgentLoop } from "../src/lib/agent/loop/orchestrator";
import type { LoopDeps } from "../src/lib/agent/loop/types";
import type { AgentStepRequest, AgentAction, LogEvent } from "../src/lib/agent/types";
import { makeState } from "./helpers";

/** Exact nudge text pinned by the orchestrator (tests must not drift from it). */
const NOOP_NUDGE =
  "<sys>WARNING: the page state did not change after your last action — it may have been a no-op or the content may be inside an iframe/web-component the DOM walker cannot see. Do NOT repeat the same action. Use verify, extract, scroll, or detect_visual (for canvas/iframe-rendered UI) instead.</sys>";

/** Shared deps factory: extractState returns an IDENTICAL page every step. */
function buildDeps(): {
  deps: LoopDeps;
  navReqs: AgentStepRequest[];
  events: LogEvent[];
} {
  const navReqs: AgentStepRequest[] = [];
  const events: LogEvent[] = [];
  const deps: LoopDeps = {
    task: "Click the submit button",
    plannerCall: vi.fn(async () => ({
      raw: JSON.stringify({
        thinking: "x",
        decision: "continue",
        plan: ["click the button"],
        current_plan_item: 0,
        next_goal: "click the button",
      }),
    })),
    navigatorCall: vi.fn(async (req: AgentStepRequest) => {
      navReqs.push(req);
      // First navigator turn: a page-changing click. Subsequent turns: scroll.
      if (navReqs.length === 1) {
        return {
          raw: JSON.stringify({
            thinking: "x",
            evaluation_previous_goal: "y",
            memory: "z",
            next_goal: "w",
            action: [{ type: "click", index: 1 }],
          }),
        };
      }
      return {
        raw: JSON.stringify({
          thinking: "x",
          evaluation_previous_goal: "y",
          memory: "z",
          next_goal: "w",
          action: [{ type: "scroll", down: true, pages: 1 }],
        }),
      };
    }),
    getTabs: vi.fn(async () => [
      { id: 1, label: "1", url: "https://example.com", title: "t", active: true },
    ]),
    // IDENTICAL page state on every observation → the fingerprint never
    // changes → the stagnant-snapshot condition holds from step 1 onward.
    extractState: vi.fn(async () =>
      makeState({
        url: "https://example.com",
        title: "Example",
        elementsText: "same content [button]",
        pageInfo: "",
      }),
    ),
    // Executed actions never mark the page changed (pageChanged: false) so
    // the loop detector keeps its stagnant snapshot instead of resetting.
    executeActions: vi.fn(async (actions: AgentAction[]) =>
      actions.map((action) => ({ action, success: true, message: "executed", pageChanged: false })),
    ),
    onEvent: (e: LogEvent) => {
      events.push(e);
    },
    settleDelay: 1,
    config: {
      maxSteps: 5,
      maxActionsPerStep: 10,
      plannerInterval: 100,
      maxFailures: 5,
      enableLoopDetection: true,
      enableCompaction: false,
      compactionStepInterval: 1000,
      compactionCharThreshold: 1_000_000,
      enableJudge: false,
      enableEarlyStop: false,
      enableFastPath: false,
    },
  };
  return { deps, navReqs, events };
}

describe("no-op action feedback", () => {
  test("the request after a click on an unchanged page carries the no-op nudge; a scroll-only step does not", async () => {
    const { deps, navReqs } = buildDeps();

    await runAgentLoop(deps);

    // maxSteps 5 → initial planner + 5 navigator turns.
    expect(navReqs.length).toBeGreaterThanOrEqual(3);

    // Step 0: first observation — no prior snapshot, no nudge.
    expect(navReqs[0].loopWarning).toBeUndefined();

    // Step 1: the page did not change after the click → the nudge fires on
    // the very next request (consumed in the same step by
    // prepareNavigatorRequest).
    expect(navReqs[1].loopWarning).toBe(NOOP_NUDGE);

    // Step 2: the page still did not change, but the previous step only
    // scrolled (scroll is exempt) → the nudge is NOT re-added, and since it
    // was consumed by request #1, loopWarning is undefined again.
    expect(navReqs[2].loopWarning).toBeUndefined();
  });
});
