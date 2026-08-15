/**
 * Navigator system prompt — the SINGLE prompt shared by every model.
 *
 * The former full/compact two-variant machinery is gone: the branches had
 * converged (every security/schema/behavior block byte-identical; only intro
 * prose differed), so the surviving template IS the prompt for all models.
 * No toggle, no selection logic, no per-model variant.
 *
 * Proves:
 *  1. The single prompt's size is pinned (small enough that even a 64k model
 *     keeps ~3× observation headroom over the 128k-profile budget).
 *  2. EVERY security / schema / behavior block is preserved VERBATIM — a
 *     future edit that trims the prompt must not weaken the non-negotiable
 *     content.
 *  3. The 64k model with the single prompt can fit a LARGE observation.
 *  4. The prompt stays grounded in the code: every <marker> it promises in
 *     the Input list, every action it names, and every output field in the
 *     worked example exist in the real schemas / rendering paths.
 */
import { describe, expect, test } from "vitest";
import { buildNavigatorPrompt } from "../src/lib/agent/prompts/navigator-prompt";
import { compileNavigatorPromptV1 } from "../src/lib/agent/prompts/prompt-compiler";
import { assertCompiledPromptWithinContextBudgetV1 } from "../src/lib/agent/prompts/prompt-token-budget";
import { SECURITY_INSTRUCTION } from "../src/lib/agent/security";
import {
  ACTION_STEERING_BLOCK,
  OUTPUT_FORMAT_BLOCK,
  sharedSafetyGuidance,
} from "../src/lib/agent/prompts/navigator-prompt-helpers";
import { actionListForPrompt } from "../src/lib/agent/tools/schema-utils";

const PROMPT = buildNavigatorPrompt(5, undefined, "disabled", "standard");

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

describe("single navigator system prompt", () => {
  test("size is pinned — one prompt for every model, small enough for 64k headroom", () => {
    const bytes = Buffer.byteLength(PROMPT);
    // Size pin freezes the measured baseline (~19.6KB after convergence).
    expect(bytes).toBeGreaterThanOrEqual(17_000);
    expect(bytes).toBeLessThanOrEqual(23_000);
  });

  test("preserves every security / schema / behavior block verbatim", () => {
    // Non-negotiable: security rules, safety guidance, current-page guard,
    // action set (schema contract), output format (JSON contract), action
    // steering, evaluate guidance.
    expect(PROMPT).toContain(SECURITY_INSTRUCTION);
    expect(PROMPT).toContain(sharedSafetyGuidance());
    expect(PROMPT).toContain(OUTPUT_FORMAT_BLOCK);
    expect(PROMPT).toContain(ACTION_STEERING_BLOCK);
    expect(PROMPT).toContain(actionListForPrompt(5, "disabled"));
    expect(PROMPT).toContain("evaluate` runs JavaScript");
    // Injection semantics survive in the input list too.
    expect(PROMPT).toContain("injection");
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

  test("teaches autonomous one-shot visual escalation in adaptive vision mode", () => {
    const adaptive = buildNavigatorPrompt(5, undefined, "adaptive", "standard");
    expect(adaptive).toContain("inspect_visual");
    expect(adaptive).toContain("attaches it ONCE");
    expect(adaptive).toContain("The user never needs to name a tool");
    expect(adaptive).toContain("Do not request pixels routinely");
  });

  test("Input list is grounded in the real message blocks (all 11 markers)", () => {
    // Each <marker> the prompt promises must be rendered by the loop:
    // messages.ts (user_request, current_goal, plan, agent_history,
    // browser_state, accessibility_tree, injection_warnings, available_skills),
    // the structured screenshot part (screenshot), persistent-memory.ts
    // (site_memory), registry-utils.ts (custom_tools + __opencowork_custom_tool).
    for (const marker of [
      "<user_request>",
      "<current_goal>",
      "<plan>",
      "<agent_history>",
      "<browser_state>",
      "<accessibility_tree>",
      "<screenshot>",
      "<available_skills>",
      "<injection_warnings>",
      "<site_memory>",
      "<custom_tools>",
    ]) {
      expect(PROMPT).toContain(marker);
    }
    // The custom-tool invocation contract must match the registry's sanitizer.
    expect(PROMPT).toContain("__opencowork_custom_tool('name')");
    // The screenshot label claim matches the annotator (numbered boxes).
    expect(PROMPT).toContain("Numbered labels match the [index] numbers");
  });

  test("every action it names exists in the executor schema", () => {
    for (const action of [
      "navigate (new_tab: true)",
      "search_page",
      "find_elements",
      "detect_challenge (scroll_into_view: true)",
      "select_dropdown",
      "ask_human",
      "takeover",
      "load_skill",
      "wait (2s)",
      "extract",
      "evaluate",
    ]) {
      expect(PROMPT).toContain(action);
    }
    // The reference semantics must match the executor: clear:true REPLACES.
    expect(PROMPT).toContain("clear:true (default) REPLACES the field");
  });

  test("worked example fields match the AgentOutputSchema contract", () => {
    expect(PROMPT).toContain('"thinking"');
    expect(PROMPT).toContain('"evaluation_previous_goal"');
    expect(PROMPT).toContain('"memory"');
    expect(PROMPT).toContain('"next_goal"');
    expect(PROMPT).toContain('"action"');
    // The worked example itself is present.
    expect(PROMPT).toContain("# Worked Example");
  });

  test("a 64k model fits a LARGE observation with the single prompt", async () => {
    // The message layer slices elementsText at the derived cap (24k), so the
    // AX tree (capped only at the loop/llm-direct seam, not in
    // buildNavigatorUserMessage) carries the observation weight: a ~59k-char
    // AX tree puts the message at ~104KB (≈52k tokens — fits the 64k derived
    // input budget of 54,400).
    const elementsText = "[1]<button>Compare plans</button>\n".repeat(2_600);
    const axTree = "button Compare plans\n".repeat(2_800);
    const compiled = await compileNavigatorPromptV1({
      maxActions: 5,
      user: { ...USER, browserState: { ...USER.browserState, elementsText, axTree } },
    });
    expect(() =>
      assertCompiledPromptWithinContextBudgetV1("navigator", "navigator-64k", compiled.messages, 64_000),
    ).not.toThrow();
  });
});