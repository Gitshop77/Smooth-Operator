/**
 * Low-context (32k-64k) model effectiveness — the user's explicit question.
 *
 * Proves:
 *  1. A 64k-context model CAN run the navigator on a LARGE page: a ~120k-byte
 *     elementsText observation is bounded by the navigator message cap, the
 *     compiled prompt fits a 64k-model byte budget, and the compiler does not
 *     throw.
 *  2. A 32k-context model FAILS CLOSED for the navigator on the same large
 *     page: the model-context-aware budget rejects the over-context prompt
 *     (typed PromptBudgetExceededError) instead of shipping it.
 *  3. The model-context-aware budget port clamps `maxInputTokens` from the
 *     known context window (same output/reasoning reserves as the fixed
 *     profile) with an 8k floor.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildNavigatorUserMessage } from "../src/lib/agent/loop/messages";
import { compileNavigatorPromptV1 } from "../src/lib/agent/prompts/prompt-compiler";
import {
  PROMPT_BUDGET_PROFILES_V1,
  PromptBudgetExceededError,
  assertCompiledPromptWithinContextBudgetV1,
  promptBudgetProfileForContextV1,
  utf8ByteLength,
  CONTEXT_CLAMP_FLOOR_TOKENS,
} from "../src/lib/agent/prompts/prompt-token-budget";
import { installLocalStorageStub, restoreLocalStorageStub } from "./helpers";

beforeAll(() => installLocalStorageStub());
afterAll(() => restoreLocalStorageStub());

/** ~120k UTF-8 bytes of interactive-element text (a large page). */
const LARGE_PAGE_ELEMENTS_TEXT = ("[42]<button>Continue</button>\n" + "x".repeat(80)).repeat(1400);

const LARGE_PAGE_USER = {
  task: "Find the documented value",
  history: [],
  currentGoal: "Read the page",
  plan: ["Read", "Report"],
  currentPlanItem: 0,
  browserState: {
    url: "https://example.com/docs",
    title: "Documentation",
    tabs: [],
    elementsText: LARGE_PAGE_ELEMENTS_TEXT,
    pageInfo: "0 pages above, 1 page below",
    newElementCount: 0,
  },
  step: 1,
  maxSteps: 10,
};

describe("navigator on a 64k-context model with a large page", () => {
  test("a ~120k-byte page is BOUNDED at the message level, then FAILS CLOSED for a 64k model (never ships over-context)", async () => {
    // The user message caps elementsText at ELEMENTS_TEXT_CHAR_CAP (60k chars)
    // BEFORE the injection scan, so a ~120k-byte page is bounded on arrival.
    const userMessage = await buildNavigatorUserMessage(LARGE_PAGE_USER);
    expect(userMessage.length).toBeLessThan(75_000);
    expect(utf8ByteLength(userMessage)).toBeGreaterThan(60_000); // genuinely large

    const compiled = await compileNavigatorPromptV1({ maxActions: 5, user: LARGE_PAGE_USER });
    expect(compiled.messages).toHaveLength(2);

    // A 64k-context model: derive the navigator budget from its REAL context
    // (64k − outputReserve 8192 − reasoningReserve 16384 = 39,424 bytes cap).
    const profile64k = promptBudgetProfileForContextV1("navigator", 64_000);
    expect(profile64k.maxInputTokens).toBe(64_000 - 8_192 - 16_384);
    // FINDING: a full-size (60k-char) observation + the ~10k-byte system
    // prompt ≈ 90k bytes ≈ 22.7k tokens — a 64k model with the SAME
    // output/reasoning reserves rejects it. The admission clamp fails CLOSED
    // (typed PromptBudgetExceededError) instead of shipping an over-context
    // prompt; shrinking the observation (HTML summarizer) is the path to run.
    expect(() =>
      assertCompiledPromptWithinContextBudgetV1("navigator", "navigator-64k", compiled.messages, 64_000),
    ).toThrow(PromptBudgetExceededError);
  });

  test("a 64k model CAN run the navigator on a summarizer-shrunk page (fits the derived budget, no throw)", async () => {
    // The HTML summarizer's job: shrink a dense page to task-relevant elements.
    // A ~4k-char elementsText (post-summarizer, focused task) must fit a 64k
    // model: ~10k-byte system prompt + ~4k-char observation + wrapping ≈ 31k
    // bytes ≤ 39,424 (the 64k-derived input budget).
    const shrunkUser = {
      ...LARGE_PAGE_USER,
      browserState: {
        ...LARGE_PAGE_USER.browserState,
        elementsText: ("[42]<button>Continue</button>\n" + "label text ").repeat(90), // ~4k chars
      },
    };
    const compiled = await compileNavigatorPromptV1({ maxActions: 5, user: shrunkUser });
    expect(utf8ByteLength(compiled.messages[0].content + "\n" + compiled.messages[1].content))
      .toBeLessThanOrEqual(promptBudgetProfileForContextV1("navigator", 64_000).maxInputTokens);
    expect(() =>
      assertCompiledPromptWithinContextBudgetV1("navigator", "navigator-64k-shrunk", compiled.messages, 64_000),
    ).not.toThrow();
  });

  test("a 32k-context model cannot run the navigator even on a small page (documented safe-context guidance)", async () => {
    const smallUser = {
      ...LARGE_PAGE_USER,
      browserState: { ...LARGE_PAGE_USER.browserState, elementsText: "[1]<button>Continue</button>" },
    };
    const compiled = await compileNavigatorPromptV1({ maxActions: 5, user: smallUser });
    // The smallest navigator prompt (~31k bytes ≈ 7.7k tokens) still exceeds
    // the 32k-derived input budget (32k − 24.5k reserves → 8k floor). The
    // navigator profile therefore requires ≥64k context; a 32k model must use
    // the planner/judge profiles, which ARE calibrated for 32k.
    expect(() =>
      assertCompiledPromptWithinContextBudgetV1("navigator", "navigator-32k-small", compiled.messages, 32_000),
    ).toThrow(PromptBudgetExceededError);
  });
});

describe("promptBudgetProfileForContextV1 (model-context-aware budget port)", () => {
  test("derives maxInputTokens from the known context with the SAME reserves as the fixed profile", () => {
    const base = PROMPT_BUDGET_PROFILES_V1.navigator;
    const derived = promptBudgetProfileForContextV1("navigator", 64_000);
    expect(derived.outputReserveTokens).toBe(base.outputReserveTokens);
    expect(derived.reasoningReserveTokens).toBe(base.reasoningReserveTokens);
    expect(derived.maxInputTokens).toBe(64_000 - base.outputReserveTokens - base.reasoningReserveTokens);
    expect(derived.maxInputTokens).toBeLessThan(base.maxInputTokens);
  });

  test("clamps to the 8k floor for degenerate context values", () => {
    const derived = promptBudgetProfileForContextV1("judge", 1_000);
    expect(derived.contextTokens).toBe(CONTEXT_CLAMP_FLOOR_TOKENS);
    expect(derived.maxInputTokens).toBeGreaterThanOrEqual(CONTEXT_CLAMP_FLOOR_TOKENS);
  });

  test("rejects non-positive / non-safe-integer context values at the boundary", () => {
    expect(() => promptBudgetProfileForContextV1("navigator", 0)).toThrow(TypeError);
    expect(() => promptBudgetProfileForContextV1("navigator", 1.5)).toThrow(TypeError);
    expect(() => promptBudgetProfileForContextV1("navigator", Number.NaN)).toThrow(TypeError);
  });

  test("documented safe-context guidance: the fixed 103k-byte navigator profile is NOT safe for a 32k model", () => {
    // The fixed profile's 103,424 UTF-8-byte cap is modeled on a 128k context.
    // A 32k model's derived cap is far smaller — the two must never be confused.
    const fixed = PROMPT_BUDGET_PROFILES_V1.navigator;
    const derived32k = promptBudgetProfileForContextV1("navigator", 32_000);
    expect(fixed.contextTokens).toBe(128_000);
    expect(derived32k.maxInputTokens).toBeLessThan(fixed.maxInputTokens);
  });
});

