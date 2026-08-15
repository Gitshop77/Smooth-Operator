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
 *  4. COMPACT is the DEFAULT for every model: a ≥128k model keeps the FULL
 *     prompt only when the user opts in via `enableVerboseNavigatorPrompt`.
 */
import { describe, expect, it, test } from "vitest";
import { buildNavigatorPrompt } from "../src/lib/agent/prompts/navigator-prompt";
import { compileNavigatorPromptV1 } from "../src/lib/agent/prompts/prompt-compiler";
import { assertCompiledPromptWithinContextBudgetV1 } from "../src/lib/agent/prompts/prompt-token-budget";
import { selectNavigatorCompact } from "../src/extension/llm-direct";
import { SECURITY_INSTRUCTION } from "../src/lib/agent/security";
import {
  ACTION_STEERING_BLOCK,
  OUTPUT_FORMAT_BLOCK,
  sharedSafetyGuidance,
  evaluateGuidance,
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
    const full = Buffer.byteLength(FULL);
    const compact = Buffer.byteLength(COMPACT);
    // Size pins freeze the measured baseline (25.4KB full / 19.6KB compact,
    // after the full branch collapsed to the single worked example):
    // full between 23,000 and 26,500; compact between 17,000 and 23,000.
    expect(full).toBeGreaterThanOrEqual(23_000);
    expect(full).toBeLessThanOrEqual(26_500);
    expect(compact).toBeGreaterThanOrEqual(17_000);
    expect(compact).toBeLessThanOrEqual(23_000);
    expect(compact).toBeLessThan(full * 0.8); // ≥20% smaller
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

  test("safety guidance points at the single <core_invariants> authority instead of restating precedence", () => {
    // The 3-tier precedence hierarchy is defined ONCE in SECURITY_INSTRUCTION's
    // <core_invariants> block; sharedSafetyGuidance only cross-references it.
    // A restated hierarchy here would create a second authority that can drift.
    expect(sharedSafetyGuidance()).toContain(
      "# Critical Rules — see <core_invariants> in SECURITY_INSTRUCTION.",
    );
    expect(sharedSafetyGuidance()).not.toContain("in order of precedence");
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

  test("128k+ models keep the FULL prompt ONLY when enableVerboseNavigatorPrompt is set", () => {
    // Default path (opt-in unset/false): even a 128k+ model gets COMPACT.
    expect(selectNavigatorCompact(128_000, false)).toBe(true);
    // The full branch is opt-in only for a KNOWN ≥128k effective context…
    expect(selectNavigatorCompact(128_000, true)).toBe(false);
    expect(selectNavigatorCompact(200_000, true)).toBe(false);
    // …and never for sub-128k / unknown contexts, even when opted in.
    expect(selectNavigatorCompact(64_000, true)).toBe(true);
    expect(selectNavigatorCompact(undefined, true)).toBe(true);
    expect(buildNavigatorPrompt(5, undefined, "disabled", "standard", false)).toBe(FULL);
    expect(COMPACT).not.toBe(FULL);
  });

  test("a 64k model with the compact prompt fits a LARGE observation that the full prompt cannot", async () => {
    // The message layer slices elementsText at the derived cap (24k), so the
    // AX tree (capped only at the loop/llm-direct seam, not in
    // buildNavigatorUserMessage) carries the observation weight: a ~59k-char
    // AX tree puts the full-prompt message at ~112KB (≈56k tokens — over the
    // 64k derived input budget of 54,400), while the compact prompt stays
    // ~104KB (≈52k tokens — fits).
    const elementsText = "[1]<button>Compare plans</button>\n".repeat(2_600);
    const axTree = "button Compare plans\n".repeat(2_800);
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

describe("full/compact block equality", () => {
  const full = buildNavigatorPrompt(5, undefined, "adaptive", "standard", false);
  const compact = buildNavigatorPrompt(5, undefined, "adaptive", "standard", true);

  it("full and compact embed byte-identical security/schema blocks", () => {
    const blocks = [
      SECURITY_INSTRUCTION,
      sharedSafetyGuidance(),
      OUTPUT_FORMAT_BLOCK,
      ACTION_STEERING_BLOCK,
      evaluateGuidance("standard"),
      actionListForPrompt(5, "adaptive"),
    ];
    for (const block of blocks) {
      expect(full).toContain(block);
      expect(compact).toContain(block);
    }
  });
});
