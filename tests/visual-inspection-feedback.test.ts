/**
 * Loop-level regression test for the `inspect_visual` one-shot feedback.
 *
 * `inspect_visual` is a *request*: pixels only arrive with the NEXT
 * observation — and may never arrive at all (text-only model, screenshots
 * disabled, capture/budget failure). Historically the model was never told
 * the outcome: the tool returned `success: true` ("Visual inspection
 * requested"), the ⚠ "unavailable" state was only a UI log, so a model that
 * genuinely needed pixels kept re-issuing IDENTICAL requests. Identical
 * `reason` → identical `normalizeAction` hash → the loop detector counted
 * 5+ repeats and fired spurious "LOOP DETECTED: repeated Nx" warnings.
 *
 * These tests drive the REAL `runAgentLoop` with a mock LLM pair and assert
 * the loop injects a trusted `<sys>` nudge into the next navigator request
 * after a visual request:
 *  - delivered → confirms the frame is attached (model stops re-requesting);
 *  - undeliverable → hard "STOP calling inspect_visual" directive (breaks
 *    the silent loop).
 */

import { describe, test, expect, vi } from "vitest";
import { runAgentLoop } from "../src/lib/agent/loop/orchestrator";
import type { LoopDeps } from "../src/lib/agent/loop/types";
import type { AgentStepRequest, LogEvent } from "../src/lib/agent/types";
import { makeState } from "./helpers";

const SCREENSHOT = "data:image/jpeg;base64,AAAA";

/** Shared deps factory: the extractState mock controls screenshot delivery. */
function buildDeps(opts: { deliverScreenshot: boolean }): {
  deps: LoopDeps;
  navReqs: AgentStepRequest[];
  events: LogEvent[];
} {
  const navReqs: AgentStepRequest[] = [];
  const events: LogEvent[] = [];
  const deps: LoopDeps = {
    task: "Read the chart on the current page",
    plannerCall: vi.fn(async () => ({
      raw: JSON.stringify({
        thinking: "x",
        decision: "continue",
        plan: ["inspect the chart"],
        next_goal: "inspect the chart",
      }),
    })),
    navigatorCall: vi.fn(async (req: AgentStepRequest) => {
      navReqs.push(req);
      // First navigator turn: the model decides it needs pixels.
      if (navReqs.length === 1) {
        return {
          raw: JSON.stringify({
            thinking: "x",
            evaluation_previous_goal: "y",
            memory: "z",
            next_goal: "w",
            action: [{ type: "inspect_visual", reason: "read the chart" }],
          }),
        };
      }
      // Subsequent turns: harmless read-only actions.
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
    // The extension's extractStateFromTab honors includeScreenshotOnce:
    // screenshot is captured (and marked one-shot) only when the loop asks.
    extractState: vi.fn(async (_tabs, options) =>
      makeState({
        url: "https://example.com",
        title: "Example",
        elementsText: "chart container [div]",
        pageInfo: "",
        ...(options?.includeScreenshotOnce === true && opts.deliverScreenshot
          ? { screenshot: SCREENSHOT, screenshotIsOneShot: true }
          : {}),
      }),
    ),
    onEvent: (e: LogEvent) => {
      events.push(e);
    },
    settleDelay: 1,
    config: {
      maxSteps: 4,
      maxActionsPerStep: 10,
      plannerInterval: 100,
      maxFailures: 5,
      enableLoopDetection: false,
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

describe("inspect_visual one-shot feedback", () => {
  test("delivered frame: the next navigator request confirms the image is attached", async () => {
    const { deps, navReqs, events } = buildDeps({ deliverScreenshot: true });

    await runAgentLoop(deps);

    // The step AFTER the inspect_visual request must carry the confirmation
    // nudge (the frame is live in that very observation), so the model does
    // not re-request pixels it already received.
    const followUp = navReqs[1];
    expect(followUp).toBeDefined();
    expect(followUp.loopWarning).toContain("is attached to this observation");
    expect(followUp.loopWarning).toContain("do not request pixels again");

    // The UI event contract still holds: requested → captured.
    expect(events).toContainEqual(expect.objectContaining({ type: "visual-inspection", stage: "requested" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "visual-inspection", stage: "captured" }));
    // And the extension-side one-shot marker reached the loop.
    const stateEvent = events.find((e) => e.type === "state");
    expect(stateEvent).toBeDefined();
  });

  test("undeliverable frame: the next navigator request tells the model to STOP re-requesting", async () => {
    const { deps, navReqs, events } = buildDeps({ deliverScreenshot: false });

    await runAgentLoop(deps);

    const followUp = navReqs[1];
    expect(followUp).toBeDefined();
    expect(followUp.loopWarning).toContain("could NOT be delivered");
    expect(followUp.loopWarning).toContain("STOP calling inspect_visual");

    expect(events).toContainEqual(expect.objectContaining({ type: "visual-inspection", stage: "requested" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "visual-inspection", stage: "unavailable" }));
  });
});
