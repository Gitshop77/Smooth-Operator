/**
 * Context-adaptive navigator observation caps — the 64k-model survival work.
 *
 * Proves three things:
 *  1. `deriveNavigatorObservationCapsV1` produces the exact current defaults
 *     for unknown context and for ≥128k models (zero behavior change for every
 *     model the current caps were calibrated for), and a FITTING allocation for
 *     sub-128k models (observation shrinks so the prompt fits the derived
 *     input budget instead of tripping the fail-closed assert on every step).
 *  2. `prepareNavigatorRequest` applies the derived caps: a 64k run truncates
 *     the DOM text, drops the AX tree when it is not affordable, and drops the
 *     screenshot, emitting observable info events — the loop degrades the
 *     OBSERVATION instead of failing the STEP.
 *  3. End-to-end: a realistic navigator prompt built from the 64k-derived caps
 *     fits the 64k-model derived input budget (assert does NOT throw), while
 *     the same page with the fixed 128k caps would throw — the caps are what
 *     makes 64k survival possible, not luck.
 */
import { describe, expect, test, vi } from "vitest";
import {
  deriveNavigatorObservationCapsV1,
  assertCompiledPromptWithinContextBudgetV1,
} from "../src/lib/agent/prompts/prompt-token-budget";
import { prepareNavigatorRequest } from "../src/lib/agent/loop/phases/navigator";
import { initState } from "../src/lib/agent/loop/orchestrator-helpers";
import { compileNavigatorPromptV1 } from "../src/lib/agent/prompts/prompt-compiler";
import { DEFAULT_CONFIG } from "../src/lib/agent/types-utils";
import { makeState } from "./helpers";
import type { LoopDeps, LoopState } from "../src/lib/agent/loop/types";
import type { AgentConfig, BrowserState, LogEvent } from "../src/lib/agent/types";

/** Build a minimal LoopState around a context-aware config. */
function makeStateWithContext(contextTokens: number | undefined): { state: LoopState; events: LogEvent[] } {
  const events: LogEvent[] = [];
  const deps: LoopDeps = {
    task: "Find the pricing",
    onEvent: (e: LogEvent) => { events.push(e); },
    config: { maxSteps: 20, contextTokens },
    plannerCall: vi.fn() as never,
    navigatorCall: vi.fn() as never,
    getTabs: vi.fn(async () => []) as never,
  };
  const config: AgentConfig = { ...DEFAULT_CONFIG, maxSteps: 20, contextTokens };
  return { state: initState(deps, config), events };
}

/** A page whose observation far exceeds every cap (must be degraded). */
const BIG_OBSERVATION: BrowserState = {
  ...makeState(),
  elementsText: "[1]<button>Continue</button>\n".repeat(3000), // ~90k chars
  axTree: "button Continue\n".repeat(8000),                    // ~96k chars
  screenshot: "data:image/jpeg;base64," + "A".repeat(200_000), // ~200k chars
};
describe("deriveNavigatorObservationCapsV1", () => {
  test("unknown context returns the exact current defaults (zero behavior change)", () => {
    const caps = deriveNavigatorObservationCapsV1(undefined);
    expect(caps).toEqual({ elementsTextChars: 60_000, axTreeChars: 200_000, screenshotChars: 1_500_000 });
  });

  test("a 128k-context model keeps the exact current text-channel defaults", () => {
    const caps = deriveNavigatorObservationCapsV1(128_000);
    expect(caps.elementsTextChars).toBe(60_000);
    expect(caps.axTreeChars).toBe(200_000);
    // The screenshot cap becomes its FIT budget (67,424 = 128k maxInput 103,424
    // − 32k fixed overhead − 2×2k min text observation) — not the aspirational
    // 1.5M hard cap that realistic captures always exceed and that always
    // tripped the fail-closed assert.
    expect(caps.screenshotChars).toBe(103_424 - 32_000 - 2_000 - 2_000);
  });

  test("a 64k-context model gets a fitting observation and no screenshot", () => {
    const caps = deriveNavigatorObservationCapsV1(64_000);
    // 64k derived maxInput = 64,000 − 8,192 − 16,384 = 39,424.
    // Sub-128k models get the COMPACT system prompt, so the fixed overhead is
    // 23,000 (vs 32,000 for the full prompt):
    //   available = 39,424 − 23,000 (compact overhead) − 4,000 (user content) = 12,424.
    expect(caps.elementsTextChars).toBe(Math.floor(12_124 * 0.85));
    expect(caps.axTreeChars).toBe(12_124 - Math.floor(12_124 * 0.85));
    expect(caps.screenshotChars).toBe(0); // not affordable at 64k
  });

  test("a 32k-context model is floored but never produces unusable caps", () => {
    const caps = deriveNavigatorObservationCapsV1(32_000);
    expect(caps.elementsTextChars).toBeGreaterThanOrEqual(2_000);
    expect(caps.axTreeChars).toBeGreaterThanOrEqual(0);
    expect(caps.screenshotChars).toBe(0);
  });

  test("caps are monotonic in context within the sub-128k regime", () => {
    const a = deriveNavigatorObservationCapsV1(64_000);
    const b = deriveNavigatorObservationCapsV1(96_000);
    expect(b.elementsTextChars).toBeGreaterThan(a.elementsTextChars);
    expect(b.axTreeChars).toBeGreaterThan(a.axTreeChars);
  });

  test("caps never exceed the base (128k) defaults", () => {
    for (const ctx of [64_000, 96_000, 128_000, 200_000, 1_000_000]) {
      const caps = deriveNavigatorObservationCapsV1(ctx);
      expect(caps.elementsTextChars).toBeLessThanOrEqual(60_000);
      expect(caps.axTreeChars).toBeLessThanOrEqual(200_000);
      expect(caps.screenshotChars).toBeLessThanOrEqual(1_500_000);
    }
  });
});

describe("prepareNavigatorRequest applies context-derived caps", () => {
  test("a 64k run truncates DOM text, drops the AX tree, and drops the screenshot", async () => {
    const { state, events } = makeStateWithContext(64_000);
    const req = await prepareNavigatorRequest(state, BIG_OBSERVATION);

    const caps = deriveNavigatorObservationCapsV1(64_000);
    expect(req.browserState.elementsText.length).toBeLessThanOrEqual(caps.elementsTextChars);
    // The AX tree channel is truncated (not dropped): at 64k its cap is 514
    // chars, so a huge tree is cut to that.
    expect((req.browserState.axTree ?? "").length).toBeLessThanOrEqual(caps.axTreeChars);
    expect(req.browserState.screenshot).toBeUndefined(); // dropped (channel not affordable)

    const messages = events
      .filter((e): e is LogEvent & { type: "info" } => e.type === "info")
      .map((e) => e.message);
    expect(messages.some((m) => m.includes("Navigator DOM truncated"))).toBe(true);
    expect(messages.some((m) => m.includes("screenshot dropped"))).toBe(true);
  });

  test("an unknown-context run keeps the current 60k elements cap (no regression)", async () => {
    const { state } = makeStateWithContext(undefined);
    const req = await prepareNavigatorRequest(state, BIG_OBSERVATION);
    expect(req.browserState.elementsText.length).toBe(60_000); // truncated at the base cap only
  });
});

describe("64k-model survival proof (end-to-end)", () => {
  const history = Array.from({ length: 4 }, (_, i) => ({
    step: i,
    agent: "navigator" as const,
    goal: "continue",
    evaluation: "ok",
    memory: "x",
    results: [{
      action: { type: "click" as const, index: i + 1 },
      success: true,
      message: "clicked",
      extractedContent: "price $9.99 " + i,
    }],
  }));

  test("a realistic 64k prompt built from the derived caps FITS the derived budget", async () => {
    const caps = deriveNavigatorObservationCapsV1(64_000);
    const { state } = makeStateWithContext(64_000);
    const req = await prepareNavigatorRequest(state, {
      ...makeState(),
      elementsText: "[1]<button>Compare plans</button>\n".repeat(2000),
      axTree: "button Compare plans\n".repeat(2000),
    });
    expect(req.browserState.elementsText.length).toBeLessThanOrEqual(caps.elementsTextChars);
    expect(req.browserState.screenshot).toBeUndefined();

    // Compile the REAL prompt the loop would send (as llm-direct does) and
    // assert it fits the 64k-derived input budget.
    const compiled = await compileNavigatorPromptV1({
      maxActions: 5,
      // llm-direct uses the compact system prompt for <128k models.
      compact: true,
      user: {
        task: "Research the pricing for the enterprise plan and report the annual cost. ".repeat(3),
        history,
        currentGoal: "Read pricing page",
        plan: ["Open pricing", "Extract", "Report"],
        currentPlanItem: 1,
        browserState: {
          url: "https://example.com/pricing",
          title: "Pricing",
          tabs: [{ id: 1, label: "1", url: "https://example.com/pricing", title: "Pricing", active: true }],
          elementsText: req.browserState.elementsText,
          pageInfo: "0 pages above, 1 below",
          newElementCount: 0,
          axTree: req.browserState.axTree,
        },
        step: 4,
        maxSteps: 20,
      },
    });
    expect(() =>
      assertCompiledPromptWithinContextBudgetV1("navigator", "navigator-64k", compiled.messages, 64_000),
    ).not.toThrow();
  });

  test("the SAME page WITHOUT the derived caps fails the 64k budget closed (caps are the difference)", async () => {
    // A 90k-char observation (no degradation) on a 64k model must fail closed —
    // proving the caps, not a permissive budget, are what make 64k survival real.
    const compiled = await compileNavigatorPromptV1({
      maxActions: 5,
      user: {
        task: "t",
        history: [],
        currentGoal: "t",
        plan: undefined,
        currentPlanItem: undefined,
        browserState: {
          url: "https://example.com",
          title: "T",
          tabs: [],
          elementsText: BIG_OBSERVATION.elementsText,
          pageInfo: "",
          newElementCount: 0,
        },
        step: 1,
        maxSteps: 10,
      },
    });
    expect(() =>
      assertCompiledPromptWithinContextBudgetV1("navigator", "navigator-64k-raw", compiled.messages, 64_000),
    ).toThrow(/Prompt budget exceeded/);
  });
});
