/**
 * Context-adaptive navigator observation caps — the 64k-model survival work.
 *
 * Proves three things:
 *  1. `deriveNavigatorObservationCapsV1` produces the exact current defaults
 *     for unknown context and for ≥128k models (zero behavior change for every
 *     model the current caps were calibrated for), and a FITTING allocation for
 *     sub-128k models (observation shrinks so the prompt fits the derived
 *     input budget instead of tripping the fail-closed assert on every step).
 *  2. `prepareNavigatorRequest` applies the derived caps at every regime: a
 *     64k run truncates the DOM text and the AX tree to their viewport-evidence
 *     budgets and DROPS the screenshot (no screenshot allowance at that
 *     context); a 128k/unknown-context run RESIZES an over-budget screenshot
 *     down to the fitted char budget instead of shipping it whole (only a
 *     wildly-oversized / corrupt capture is dropped by the 3M safety guard).
 *     The loop degrades the OBSERVATION instead of failing the STEP.
 *  3. End-to-end: a realistic navigator prompt built from the 64k-derived caps
 *     fits the 64k-model derived input budget (assert does NOT throw), while
 *     the same page with the fixed 128k caps would throw — the caps are what
 *     makes 64k survival possible, not luck.
 *  4. The HTML summarizer is DEFAULT-ON: a default config on a >10k-char page
 *     yields a ≤30-element navigation observation (the summarizer render),
 *     and the `*` new-element markers stay dropped while `newElementCount`
 *     survives on the request.
 */
import { describe, expect, test, vi } from "vitest";
import {
  deriveNavigatorObservationCapsV1,
  deriveOnDemandScreenshotCapV1,
  assertCompiledPromptWithinContextBudgetV1,
} from "../src/lib/agent/prompts/prompt-token-budget";
import { prepareNavigatorRequest } from "../src/lib/agent/loop/phases/navigator";
import { initState } from "../src/lib/agent/loop/orchestrator-helpers";
import { compileNavigatorPromptV1 } from "../src/lib/agent/prompts/prompt-compiler";
import { DEFAULT_CONFIG } from "../src/lib/agent/types-utils";
import { DEFAULT_MIN_HTML_LENGTH } from "../src/lib/agent/html-summarizer";
import { validateConfig } from "../src/lib/agent/config/schema";
import { makeState } from "./helpers";
import type { LoopDeps, LoopState } from "../src/lib/agent/loop/types";
import type { AgentConfig, BrowserState, ExtractedElement, LogEvent } from "../src/lib/agent/types";

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
    expect(caps).toEqual({ elementsTextChars: 24_000, axTreeChars: 12_000, screenshotChars: 100_000 });
  });

  test("a 128k-context model keeps the exact current text-channel defaults", () => {
    const caps = deriveNavigatorObservationCapsV1(128_000);
    expect(caps.elementsTextChars).toBe(24_000);
    expect(caps.axTreeChars).toBe(12_000);
    // The screenshot cap becomes its FIT budget (72,800 = 85% of 128k
    // − 32k fixed overhead − 2×2k min text observation) — a bounded per-step
    // quality budget; the loop keeps a 3M-char safety cap as the outer drop
    // guard and resizes over-budget frames down to this fitted budget.
    expect(caps.screenshotChars).toBe(108_800 - 32_000 - 2_000 - 2_000);
  });

  test("a 64k-context model gets a fitting observation and no screenshot", () => {
    const caps = deriveNavigatorObservationCapsV1(64_000);
    // 64k derived maxInput = 54,400 (85%). The economical text evidence
    // allowance is economically capped at 24,000 chars, split 75/25
    // DOM/viewport AX.
    const available = 24_000;
    expect(caps.elementsTextChars).toBe(Math.floor(available * 0.75));
    expect(caps.axTreeChars).toBe(available - Math.floor(available * 0.75));
    expect(caps.screenshotChars).toBe(0); // not affordable at 64k
  });

  test("a 64k model has a bounded one-shot visual budget without enabling automatic screenshots", () => {
    expect(deriveNavigatorObservationCapsV1(64_000).screenshotChars).toBe(0);
    expect(deriveOnDemandScreenshotCapV1(64_000)).toBe(56_000);
  });

  test("a 32k-context model is floored but never produces unusable caps", () => {
    const caps = deriveNavigatorObservationCapsV1(32_000);
    expect(caps.elementsTextChars).toBeGreaterThanOrEqual(2_000);
    expect(caps.axTreeChars).toBeGreaterThanOrEqual(0);
    expect(caps.screenshotChars).toBe(0);
  });

  test("caps are monotonic but plateau at the economical ceiling", () => {
    const a = deriveNavigatorObservationCapsV1(64_000);
    const b = deriveNavigatorObservationCapsV1(96_000);
    expect(b.elementsTextChars).toBeGreaterThanOrEqual(a.elementsTextChars);
    expect(b.axTreeChars).toBeGreaterThanOrEqual(a.axTreeChars);
    expect(b.elementsTextChars + b.axTreeChars).toBe(24_000);
  });

  test("caps never exceed the base (128k) defaults", () => {
    for (const ctx of [64_000, 96_000, 128_000, 200_000, 1_000_000]) {
      const caps = deriveNavigatorObservationCapsV1(ctx);
      expect(caps.elementsTextChars).toBeLessThanOrEqual(24_000);
      expect(caps.axTreeChars).toBeLessThanOrEqual(12_000);
      expect(caps.screenshotChars).toBeLessThanOrEqual(100_000);
    }
  });
});

describe("prepareNavigatorRequest applies context-derived caps", () => {
  test("a 64k run truncates DOM text and AX tree but DROPS the screenshot", async () => {
    const { state, events } = makeStateWithContext(64_000);
    const req = await prepareNavigatorRequest(state, BIG_OBSERVATION);

    const caps = deriveNavigatorObservationCapsV1(64_000);
    expect(req.browserState.elementsText.length).toBeLessThanOrEqual(caps.elementsTextChars);
    // The AX tree channel is truncated (not dropped) to its viewport evidence
    // budget, which remains large enough to preserve useful semantics.
    expect((req.browserState.axTree ?? "").length).toBeLessThanOrEqual(caps.axTreeChars);
    // The derived 64k budget has NO screenshot allowance (screenshotChars = 0),
    // so the screenshot is dropped from the main-LLM message instead of being
    // delivered whole (the local-VLM path is unaffected — it is fed upstream).
    expect(req.browserState.screenshot).toBeUndefined();

    const messages = events
      .filter((e): e is LogEvent & { type: "info" } => e.type === "info")
      .map((e) => e.message);
    expect(messages.some((m) => m.includes("Navigator DOM truncated"))).toBe(true);
    // The drop is observable: the existing info event fires.
    expect(messages.some((m) => m.includes("screenshot dropped"))).toBe(true);
    // ...but no visual-inspection DELIVERY event (this was not a one-shot turn).
    expect(events.some((e) => e.type === "visual-inspection" && e.stage === "delivered")).toBe(false);
  });

  test("a requested 64k visual turn keeps one full frame and shrinks duplicate text", async () => {
    const { state, events } = makeStateWithContext(64_000);
    const req = await prepareNavigatorRequest(state, {
      ...BIG_OBSERVATION,
      screenshot: "data:image/jpeg;base64," + "A".repeat(50_000),
      screenshotIsOneShot: true,
    });

    expect(req.browserState.screenshot?.length).toBeLessThanOrEqual(56_000);
    // One-shot inspection no longer guts the duplicate text/AX to 8k/4k — that
    // was sized for a 30k-token image that no longer exists. The frame is kept
    // whole and the text channels keep a useful (16k/8k) share.
    expect(req.browserState.elementsText.length).toBeLessThanOrEqual(16_000);
    expect((req.browserState.axTree ?? "").length).toBeLessThanOrEqual(8_000);
    expect(events).toContainEqual(expect.objectContaining({ type: "visual-inspection", stage: "delivered" }));
  });

  test("a 128k run RESIZES an over-budget screenshot to the fitted cap instead of shipping it whole", async () => {
    const { state, events } = makeStateWithContext(128_000);
    const resized = "data:image/jpeg;base64," + "B".repeat(30_000);
    const overBudget = BIG_OBSERVATION.screenshot ?? "";
    const normalizeCalls: { dataUrl: string; opts: { maxBytes: number } }[] = [];
    state.deps.normalizeScreenshot = vi.fn(async (dataUrl, opts) => {
      normalizeCalls.push({ dataUrl, opts });
      return resized;
    });

    const req = await prepareNavigatorRequest(state, BIG_OBSERVATION);

    // The resize primitive was invoked exactly once with maxBytes =
    // floor(72,800 × 3/4) — base64 is 4/3 chars per byte, so the byte budget
    // corresponds to the fitted 72,800-char cap.
    expect(normalizeCalls).toHaveLength(1);
    expect(normalizeCalls[0].dataUrl).toBe(overBudget);
    expect(normalizeCalls[0].opts.maxBytes).toBe(Math.floor(72_800 * (3 / 4)));
    // The resized frame is what ships to the model.
    expect(req.browserState.screenshot).toBe(resized);

    // A resize event (info) with the before/after sizes fired — not a drop.
    const messages = events
      .filter((e): e is LogEvent & { type: "info" } => e.type === "info")
      .map((e) => e.message);
    const resizeInfo = messages.find((m) => m.includes("resized"));
    expect(resizeInfo).toBeDefined();
    expect(resizeInfo).toContain(String(overBudget.length));
    expect(resizeInfo).toContain(String(resized.length));
    expect(messages.some((m) => m.includes("screenshot dropped"))).toBe(false);
  });

  test("a 128k run drops the screenshot when the resize helper is unavailable", async () => {
    const { state, events } = makeStateWithContext(128_000);
    // No normalizeScreenshot hook (in-page demo mode) — an over-cap screenshot
    // must never be shipped whole: it is dropped, fail-safe.
    const req = await prepareNavigatorRequest(state, BIG_OBSERVATION);

    expect(req.browserState.screenshot).toBeUndefined();
    const messages = events
      .filter((e): e is LogEvent & { type: "info" } => e.type === "info")
      .map((e) => e.message);
    expect(messages.some((m) => m.includes("screenshot dropped"))).toBe(true);
  });

  test("an unknown-context run keeps the 24k elements base cap (no regression)", async () => {
    const { state } = makeStateWithContext(undefined);
    const req = await prepareNavigatorRequest(state, BIG_OBSERVATION);
    expect(req.browserState.elementsText.length).toBe(24_000); // truncated at the economical base cap
  });
});

describe("HTML summarizer is DEFAULT-ON for large pages", () => {
  /**
   * 200 interactive elements whose text ALL matches the task keyword
   * ("pricing"): the summarizer does NOT fall back (≥5 non-zero scores), so
   * exactly the top-30 by score survive. The raw `elementsText` (with the
   * extractor's `*` new-element markers) must exceed the summarizer's
   * 10k-char trigger.
   */
  const LARGE_PAGE: BrowserState = (() => {
    const elements: ExtractedElement[] = Array.from({ length: 200 }, (_, i) => ({
      index: i + 1,
      tag: "button",
      text: `pricing option number ${i + 1} with extra details`,
      attributes: { id: `opt-${i + 1}` },
      hash: `h${i + 1}`,
      rect: { x: 0, y: 0, width: 10, height: 10 },
    }));
    return {
      ...makeState(),
      elements,
      elementsText: elements
        .map((el) => `*[${el.index}]<button id="opt-${el.index}" /> ${el.text}`)
        .join("\n"),
      newElementCount: 200,
    };
  })();

  test("the default config enables the HTML summarizer (schema default + DEFAULT_CONFIG)", () => {
    expect(validateConfig({}).enableHtmlSummarizer).toBe(true);
    expect(DEFAULT_CONFIG.enableHtmlSummarizer).toBe(true);
  });

  test("a >10k-char, 200-element page yields a ≤30-element navigation observation by default", async () => {
    expect(LARGE_PAGE.elementsText.length).toBeGreaterThan(DEFAULT_MIN_HTML_LENGTH);
    const { state, events } = makeStateWithContext(undefined);
    const req = await prepareNavigatorRequest(state, LARGE_PAGE);

    const lines = req.browserState.elementsText.split("\n");
    expect(lines.length).toBe(30); // exactly the summarizer's top-30 render
    expect(req.browserState.elementsText.length).toBeLessThan(LARGE_PAGE.elementsText.length);
    // The `*` new-element markers stay dropped in the summary render…
    expect(req.browserState.elementsText).not.toContain("*");
    // …while the count still rides the request for the state event.
    expect(req.browserState.newElementCount).toBe(200);
    const messages = events
      .filter((e): e is LogEvent & { type: "info" } => e.type === "info")
      .map((e) => e.message);
    expect(messages.some((m) => m.includes("HTML summarizer: kept 30/200"))).toBe(true);
  });

  test("disabling the summarizer ships the full DOM instead (hard cap still bounds it)", async () => {
    const events: LogEvent[] = [];
    const deps: LoopDeps = {
      task: "Find the pricing",
      onEvent: (e: LogEvent) => { events.push(e); },
      config: { maxSteps: 20, enableHtmlSummarizer: false },
      plannerCall: vi.fn() as never,
      navigatorCall: vi.fn() as never,
      getTabs: vi.fn(async () => []) as never,
    };
    const state = initState(deps, { ...DEFAULT_CONFIG, maxSteps: 20, enableHtmlSummarizer: false });
    const req = await prepareNavigatorRequest(state, LARGE_PAGE);
    // All 200 elements survive intact (~13.6k chars — under the 24k base cap,
    // so no truncation either): only the flag change flips the observation.
    expect(req.browserState.elementsText).toBe(LARGE_PAGE.elementsText);
    expect(req.browserState.elementsText.split("\n").length).toBe(200);
    expect(events.some((e) => e.type === "info" && e.message.includes("HTML summarizer"))).toBe(false);
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
          axTree: BIG_OBSERVATION.axTree,
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
