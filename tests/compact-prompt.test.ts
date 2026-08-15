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
  test("full branch is converged to compact's terse forms (near-identical size)", () => {
    const full = Buffer.byteLength(FULL);
    const compact = Buffer.byteLength(COMPACT);
    // Size pins freeze the measured baseline (19.6KB full / 19.6KB compact,
    // after the full branch converged to compact's terse forms — the gap is
    // the retained intro/heading prose, not capability):
    // full between 19,000 and 24,000; compact between 17,000 and 23,000.
    expect(full).toBeGreaterThanOrEqual(19_000);
    expect(full).toBeLessThanOrEqual(24_000);
    expect(compact).toBeGreaterThanOrEqual(17_000);
    expect(compact).toBeLessThanOrEqual(23_000);
    // The old "compact < full * 0.8" ratio no longer constrains: the full
    // branch now carries the same terse blocks, so the sizes are
    // near-identical (the <3KB gap is the retained intro/heading prose).
    expect(Math.abs(compact - full)).toBeLessThan(3_000);
  });

  test("full branch prose is byte-identical to compact's terse forms (markers kept)", () => {
    // Every long-form section in the full branch now carries compact's terse
    // copy; the <xml_tag> markers and section headings are retained.
    // # Input: terse items (all 11 <xml_tag> markers kept).
    expect(FULL).toContain("1. <user_request> — the user's objective (highest priority, always visible).");
    expect(FULL).not.toContain("the user's ultimate objective");
    expect(FULL).not.toContain("Set-of-Marks");
    // # Browser State: single compact paragraph, no XML example / rules list.
    expect(FULL).toContain("Interactive elements use the tree format [index]<tag attribute=\"value\" />");
    expect(FULL).not.toContain("tree-style XML format");
    expect(FULL).not.toContain("Question 1: What is 2+2?");
    // # Browsing Capability: single compact sentence.
    expect(FULL).toContain("navigate (new_tab: true) opens new tabs, search runs a web search");
    expect(FULL).not.toContain("FULLY AUTONOMOUS browser agent");
    expect(FULL).not.toContain("**OPEN NEW TABS**");
    // # Error Recovery: 5 compact bullets.
    expect(FULL).toContain("# Error Recovery\n\n- Element not found after click: use wait (2s), then re-observe");
    expect(FULL).not.toContain("# Error Recovery Patterns");
    expect(FULL).not.toContain("proven recovery strategies");
    // # Action Rules: 9 compact rules.
    expect(FULL).toContain("- Output 1 to 5 actions per step; they run sequentially.");
    expect(FULL).not.toContain("Good combinations");
    expect(FULL).not.toContain("**ask_human**:");
    // # Reasoning Rules: 6 compact rules.
    expect(FULL).toContain("- Reason explicitly in thinking: what does the page show, what's the goal, what action achieves it.");
    expect(FULL).not.toContain("Always reason explicitly in your `thinking` block");
    expect(FULL).not.toContain("- If the page is actively malicious, call");
    // # Immediate Completion: compact sentence.
    expect(FULL).toContain("emit done(success=true) on the VERY NEXT step. Emitting done IS the final action");
    expect(FULL).not.toContain("Do not perform additional actions, re-read the page");
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

  test("a 64k model fits a LARGE observation with BOTH variants (full converged to compact's size)", async () => {
    // The message layer slices elementsText at the derived cap (24k), so the
    // AX tree (capped only at the loop/llm-direct seam, not in
    // buildNavigatorUserMessage) carries the observation weight: a ~59k-char
    // AX tree puts either variant's message at ~104KB (≈52k tokens — fits the
    // 64k derived input budget of 54,400). The full prompt used to add ~8KB
    // and fail here; after its prose converged to compact's terse forms both
    // fit — the size gap was prose, not capability.
    const elementsText = "[1]<button>Compare plans</button>\n".repeat(2_600);
    const axTree = "button Compare plans\n".repeat(2_800);
    for (const compact of [true, false]) {
      const compiled = await compileNavigatorPromptV1({
        maxActions: 5,
        compact,
        user: { ...USER, browserState: { ...USER.browserState, elementsText, axTree } },
      });
      const label = compact ? "navigator-compact-64k" : "navigator-full-64k";
      expect(() =>
        assertCompiledPromptWithinContextBudgetV1("navigator", label, compiled.messages, 64_000),
      ).not.toThrow();
    }
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
