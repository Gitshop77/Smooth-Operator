/**
 * Low-context (32k-64k) model effectiveness — the user's explicit question.
 *
 * Proves:
 *  1. A 64k-context model CAN run the navigator on a bounded large page using
 *     the conservative two-byte/token fallback.
 *  2. A 32k-context model FAILS CLOSED for that large prompt
 *     page: the model-context-aware budget rejects the over-context prompt
 *     (typed PromptBudgetExceededError) instead of shipping it.
 *  3. The model-context-aware budget port clamps `maxInputTokens` from the
 *     known context window using a combined 15% output/reasoning allowance.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildNavigatorUserMessage, ELEMENTS_TEXT_CHAR_CAP } from "../src/lib/agent/loop/messages";
import { compileNavigatorPromptV1 } from "../src/lib/agent/prompts/prompt-compiler";
import {
  PROMPT_BUDGET_PROFILES_V1,
  PromptBudgetExceededError,
  assertCompiledPromptWithinContextBudgetV1,
  estimatePromptTokensFallbackV1,
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
  test("a ~120k-byte page is bounded and admitted for a 64k model without treating bytes as tokens", async () => {
    // The user message caps elementsText at ELEMENTS_TEXT_CHAR_CAP (derived
    // from the observation-budget base) BEFORE the injection scan, so a
    // ~120k-byte page is bounded on arrival.
    const userMessage = await buildNavigatorUserMessage(LARGE_PAGE_USER);
    expect(userMessage.length).toBeLessThan(75_000);
    // Genuinely large: bigger than the elements cap alone, so the cap (not a
    // small page) is what bounded it.
    expect(utf8ByteLength(userMessage)).toBeGreaterThan(ELEMENTS_TEXT_CHAR_CAP);

    const compiled = await compileNavigatorPromptV1({ maxActions: 5, user: LARGE_PAGE_USER });
    expect(compiled.messages).toHaveLength(2);

    // A 64k context allows 85% input and retains 15% for the combined
    // completion/reasoning stream.
    const profile64k = promptBudgetProfileForContextV1("navigator", 64_000);
    expect(profile64k.maxInputTokens).toBe(54_400);
    expect(() =>
      assertCompiledPromptWithinContextBudgetV1("navigator", "navigator-64k", compiled.messages, 64_000),
    ).not.toThrow();
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
    expect(estimatePromptTokensFallbackV1(compiled.messages[0].content + "\n" + compiled.messages[1].content))
      .toBeLessThanOrEqual(promptBudgetProfileForContextV1("navigator", 64_000).maxInputTokens);
    expect(() =>
      assertCompiledPromptWithinContextBudgetV1("navigator", "navigator-64k-shrunk", compiled.messages, 64_000),
    ).not.toThrow();
  });

  test("a 32k-context model fails closed on a large page that fits the message cap", async () => {
    // elementsText at the derived cap alone no longer exceeds the 32k derived
    // input budget (27,200 bytes ≈ cap + framing); a large AX tree — capped
    // only at the loop/llm-direct seam, not in buildNavigatorUserMessage —
    // pushes the bounded message back over it, so the fail-closed assert still
    // fires for a genuinely large page on a 32k model.
    const largeUser = {
      ...LARGE_PAGE_USER,
      browserState: {
        ...LARGE_PAGE_USER.browserState,
        elementsText: "a".repeat(ELEMENTS_TEXT_CHAR_CAP),
        axTree: "button Continue\n".repeat(3_000), // ~30k chars
      },
    };
    const compiled = await compileNavigatorPromptV1({ maxActions: 5, user: largeUser });
    expect(() =>
      assertCompiledPromptWithinContextBudgetV1("navigator", "navigator-32k-large", compiled.messages, 32_000),
    ).toThrow(PromptBudgetExceededError);
  });
});

describe("promptBudgetProfileForContextV1 (model-context-aware budget port)", () => {
  test("derives an 85/15 input/output profile without double-counting reasoning", () => {
    const base = PROMPT_BUDGET_PROFILES_V1.navigator;
    const derived = promptBudgetProfileForContextV1("navigator", 64_000);
    expect(derived.outputReserveTokens).toBe(9_600);
    expect(derived.reasoningReserveTokens).toBe(0);
    expect(derived.maxInputTokens).toBe(54_400);
    expect(derived.maxInputTokens).toBeLessThan(base.maxInputTokens);
  });

  test("clamps to the 8k floor for degenerate context values", () => {
    const derived = promptBudgetProfileForContextV1("judge", 1_000);
    expect(derived.contextTokens).toBe(CONTEXT_CLAMP_FLOOR_TOKENS);
    expect(derived.maxInputTokens).toBe(Math.floor(CONTEXT_CLAMP_FLOOR_TOKENS * 0.85));
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
