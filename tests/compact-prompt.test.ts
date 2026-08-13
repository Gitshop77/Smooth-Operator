/**
 * Compact navigator system prompt — the low-context (<128k) model variant.
 *
 * Proves:
 *  1. The compact prompt is meaningfully smaller than the full prompt.
 *  2. EVERY security / schema / behavior block is preserved VERBATIM — a
 *     future edit that trims the compact variant must not weaken the
 *     non-negotiable content.
 *  3. The 64k model with the compact prompt can fit a MUCH larger observation
 *     than with the full prompt (the whole point: quality headroom for
 *     low-context models in long-running tasks).
 *  4. 128k+ models keep the FULL prompt (no behavior change for them).
 */
import { describe, expect, test } from "vitest";
import { buildNavigatorPrompt } from "../src/lib/agent/prompts/navigator-prompt";
import { compileNavigatorPromptV1 } from "../src/lib/agent/prompts/prompt-compiler";
import {
  assertCompiledPromptWithinContextBudgetV1,
  utf8ByteLength,
} from "../src/lib/agent/prompts/prompt-token-budget";
import { SECURITY_INSTRUCTION } from "../src/lib/agent/security";
import {
  ACTION_STEERING_BLOCK,
  OUTPUT_FORMAT_BLOCK,
  sharedSafetyGuidance,
} from "../src/lib/agent/prompts/navigator-prompt-helpers";
import { actionListForPrompt } from "../src/lib/agent/tools/schema-utils";

const FULL = buildNavigatorPrompt(5, undefined, "disabled", "standard", false);
const COMPACT = buildNavigatorPrompt(5, undefined, "disabled", "standard", true);

const USER = {
  task: "Find the enterprise pricing and report it.",
  history: [],
  currentGoal: "Read the pricing page",
  plan: ["Navigate", "Extract", "Report"],
  currentPlanItem: 0,
  browserState: {
    url: "https://example.com/pricing",
    title: "Pricing",
    tabs: [{ id: 1, label: "1", url: "https://example.com/pricing", title: "Pricing", active: true }],
    elementsText: "",
    pageInfo: "",
    newElementCount: 0,
  },
  step: 1,
  maxSteps: 20,
};

describe("compact navigator prompt", () => {
  test("is meaningfully smaller than the full prompt", () => {
    const full = utf8ByteLength(FULL);
    const compact = utf8ByteLength(COMPACT);
    expect(compact).toBeLessThan(full * 0.8); // ≥20% smaller
    expect(compact).toBeLessThan(25_000); // hard ceiling keeps the 64k budget usable
  });

  test("preserves every security / schema / behavior block verbatim", () => {
    // Non-negotiable: security rules, safety guidance, current-page guard,
    // action set (schema contract), output format (JSON contract), action
    // steering, evaluate guidance.
    expect(COMPACT).toContain(SECURITY_INSTRUCTION);
    expect(COMPACT).toContain(sharedSafetyGuidance());
    expect(COMPACT).toContain(OUTPUT_FORMAT_BLOCK);
    expect(COMPACT).toContain(ACTION_STEERING_BLOCK);
    expect(COMPACT).toContain(actionListForPrompt(5, "disabled"));
    expect(COMPACT).toContain("evaluate` runs JavaScript");
    // Injection semantics survive in the compact input list too.
    expect(COMPACT).toContain("injection");
  });

  test("adaptive compact and full prompts teach autonomous one-shot visual escalation", () => {
    for (const compact of [false, true]) {
      const prompt = buildNavigatorPrompt(5, undefined, "adaptive", "standard", compact);
      expect(prompt).toContain("inspect_visual");
      expect(prompt).toContain("attaches it ONCE");
      expect(prompt).toContain("The user never needs to name a tool");
      expect(prompt).toContain("Do not request pixels routinely");
    }
  });

  test("128k+ models keep the FULL prompt (compact is opt-in for <128k)", () => {
    expect(buildNavigatorPrompt(5, undefined, "disabled", "standard", false)).toBe(FULL);
    expect(COMPACT).not.toBe(FULL);
  });

  test("a 64k model with the compact prompt fits a LARGE observation that the full prompt cannot", async () => {
    // ~83k chars: under the corrected fallback allowance with the 22KB compact
    // prompt, but over it with the 30KB full prompt.
    const elementsText = "[1]<button>Compare plans</button>\n".repeat(2_600);
    const axTree = "button Compare plans\n".repeat(1_000);
    const compiled = await compileNavigatorPromptV1({
      maxActions: 5,
      compact: true,
      user: { ...USER, browserState: { ...USER.browserState, elementsText, axTree } },
    });
    expect(() =>
      assertCompiledPromptWithinContextBudgetV1("navigator", "navigator-compact-64k", compiled.messages, 64_000),
    ).not.toThrow();

    // The SAME observation with the FULL prompt fails the 64k budget closed —
    // proving the compact prompt is what buys the headroom.
    const fullCompiled = await compileNavigatorPromptV1({
      maxActions: 5,
      compact: false,
      user: { ...USER, browserState: { ...USER.browserState, elementsText, axTree } },
    });
    expect(() =>
      assertCompiledPromptWithinContextBudgetV1("navigator", "navigator-full-64k", fullCompiled.messages, 64_000),
    ).toThrow(/Prompt budget exceeded/);
  });
});
