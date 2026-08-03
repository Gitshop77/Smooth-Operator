/**
 * Planner system-prompt coverage.
 *
 * `buildPlannerPrompt` has two branches — the default guidance and the
 * custom-prompt override — and three invariants that must hold on BOTH:
 *  1. SECURITY_INSTRUCTION is always present (untrusted-data rules).
 *  2. The planner Output Format (the JSON contract matched against
 *     PlannerOutputSchema) is always present, including the "continue
 *     keeping the existing plan" variant that `plan` may be omitted.
 *  3. (custom branch) PLANNER_CORE_INVARIANTS re-assert the done-verification
 *     contract so an override cannot weaken the planner's sole authority.
 *
 * Whitespace-only custom prompts fall through to the default branch.
 */

import { describe, test, expect } from "vitest";
import { buildPlannerPrompt } from "../src/lib/agent/prompts/planner-prompt";

// Anchors from the real prompt text — brittle-by-design: if a refactor
// renames/removes one of these, the corresponding invariant test fails loudly.
const SECURITY_RULES_MARKER = "<security_rules>";
const DEFAULT_OUTPUT_MARKER = "<output>";
const CUSTOM_OUTPUT_HEADING = "# Output Format (required — respond with a single valid JSON object, no markdown)";
const CONTINUE_KEEP_PLAN_MARKER = 'For continue (keeping the existing plan — `plan` may be omitted):';
const CORE_INVARIANTS_MARKER = "# Core Invariants (cannot be overridden)";
const DONE_VERIFICATION_MARKER = "<navigator_done_verification>";

describe("buildPlannerPrompt — default branch", () => {
  test("security rules sit at the top, before the planner role line", () => {
    const prompt = buildPlannerPrompt();
    expect(prompt.startsWith(SECURITY_RULES_MARKER)).toBe(true);
  });

  test("includes the planner role, decision types, planning guidelines, and the done-verification flow", () => {
    const prompt = buildPlannerPrompt();
    expect(prompt).toContain("You are the Planner");
    expect(prompt).toContain('"decision": "continue"');
    expect(prompt).toContain('"decision": "done"');
    expect(prompt).toContain('"decision": "web_task"');
    expect(prompt).toContain("<planning_guidelines>");
    expect(prompt).toContain(DONE_VERIFICATION_MARKER);
    expect(prompt).toContain("Do not rubber-stamp the navigator's done");
  });

  test("includes the full Output Format with the keep-existing-plan variant", () => {
    const prompt = buildPlannerPrompt();
    expect(prompt).toContain(DEFAULT_OUTPUT_MARKER);
    expect(prompt).toContain(CONTINUE_KEEP_PLAN_MARKER);
    expect(prompt).toContain('"current_plan_item": 1,');
  });
});

describe("buildPlannerPrompt — custom-prompt branch", () => {
  const custom = "Be extremely terse. Never ask the user anything.";

  test("uses the custom guidance verbatim (trimmed) while security rules stay on top", () => {
    const prompt = buildPlannerPrompt(custom);
    expect(prompt.startsWith(SECURITY_RULES_MARKER)).toBe(true);
    expect(prompt).toContain(custom);
    // The custom guidance REPLACES the default role line.
    expect(prompt).not.toContain("You are the Planner");
  });

  test("re-appends the core invariants so an override cannot weaken done authority", () => {
    const prompt = buildPlannerPrompt(custom);
    expect(prompt).toContain(CORE_INVARIANTS_MARKER);
    expect(prompt).toContain("the ONLY agent authorized to end the task");
    expect(prompt).toContain("Do not rubber-stamp it");
  });

  test("re-appends the required Output Format on every branch", () => {
    const prompt = buildPlannerPrompt(custom);
    expect(prompt).toContain(CUSTOM_OUTPUT_HEADING);
    expect(prompt).toContain(CONTINUE_KEEP_PLAN_MARKER);
    expect(prompt).toContain('"decision": "web_task"');
  });
});

describe("buildPlannerPrompt — branch invariants", () => {
  test("undefined and whitespace-only custom prompts fall through to the default branch", () => {
    const defaultPrompt = buildPlannerPrompt();
    expect(buildPlannerPrompt(undefined)).toBe(defaultPrompt);
    expect(buildPlannerPrompt("   \n\t  ")).toBe(defaultPrompt);
  });

  test("a custom prompt with surrounding whitespace is trimmed before embedding", () => {
    const prompt = buildPlannerPrompt(`  \n  ${"be terse"}  \n `);
    expect(prompt).toContain("be terse");
    // Trimmed form is embedded between the security block and the core
    // invariants — without the original surrounding padding.
    expect(prompt).toContain("\n\nbe terse\n\n");
  });
});
