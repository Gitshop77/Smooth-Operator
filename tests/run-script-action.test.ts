/**
 * `run_script` as a first-class LLM-addressable action.
 *
 * `run_script` executes a multi-step YAML/JSON script through the script
 * engine (`script-runner.ts`) with each step dispatched as an ordinary
 * executor action. This suite covers the wiring that makes it addressable:
 *
 * - schema union entry + bounds
 * - mode gating (full_agentic only, like `evaluate`)
 * - describe / normalize / isEquivalentAction / ACTION_METADATA rows
 * - executor end-to-end: valid scripts, honest per-step failures,
 *   `ScriptValidationError` on malformed input, and `${env.VAR}`
 *   substitution wired to the executor's env seam.
 */

import { describe, it, expect, afterEach } from "vitest";
import { ActionSchema } from "../src/lib/agent/tools/schema";
import { ACTION_METADATA, isEquivalentAction } from "../src/lib/agent/tools/schema-utils";
import { describeAction } from "../src/lib/agent/tools/describe";
import { normalizeAction } from "../src/lib/agent/loop/normalize-action";
import { checkActionAllowed, requiresConfirmation } from "../src/lib/agent/modes";
import { executeAction, setScriptEnvGetter } from "../src/lib/agent/tools/executor";
import { makeState } from "./helpers";

afterEach(() => {
  setScriptEnvGetter(undefined);
  document.body.innerHTML = "";
});

const VALID_SCRIPT = [
  "name: smoke",
  "steps:",
  "  - action: get_page_info",
  "  - action: wait",
  "    seconds: 0",
].join("\n");

// ─── Schema ────────────────────────────────────────────────────────────────

describe("run_script schema", () => {
  it("accepts a run_script action with a YAML script", () => {
    const parsed = ActionSchema.safeParse({ type: "run_script", script: VALID_SCRIPT });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const action = parsed.data as { type: "run_script"; script: string };
      expect(action.type).toBe("run_script");
      expect(action.script).toBe(VALID_SCRIPT);
    }
  });

  it("rejects a run_script action without a script", () => {
    const parsed = ActionSchema.safeParse({ type: "run_script" });
    expect(parsed.success).toBe(false);
  });

  it("rejects an oversized script (> 64 KiB)", () => {
    const parsed = ActionSchema.safeParse({
      type: "run_script",
      script: `steps:\n  - action: get_page_info\n# ${"x".repeat(64 * 1024)}`,
    });
    expect(parsed.success).toBe(false);
  });
});

// ─── Mode gating ────────────────────────────────────────────────────────────

describe("run_script mode gating", () => {
  it("is blocked in restricted and standard modes (hard-gated via canExecuteJs)", () => {
    expect(checkActionAllowed("run_script", "restricted").allowed).toBe(false);
    expect(checkActionAllowed("run_script", "standard").allowed).toBe(false);
  });

  it("is allowed in full_agentic mode", () => {
    expect(checkActionAllowed("run_script", "full_agentic").allowed).toBe(true);
  });

  it("never requires confirmation (kept out of confirmRequired)", () => {
    expect(requiresConfirmation("run_script", "standard")).toBe(false);
    expect(requiresConfirmation("run_script", "full_agentic")).toBe(false);
  });
});

// ─── describe / normalize / equivalence / metadata ─────────────────────────

describe("run_script wiring rows", () => {
  it("describeAction renders the script", () => {
    expect(describeAction({ type: "run_script", script: VALID_SCRIPT })).toContain("run script");
  });

  it("normalizeAction includes the script text (loop detection distinguishes scripts)", () => {
    const a = normalizeAction({ type: "run_script", script: "steps:\n  - action: wait" });
    const b = normalizeAction({ type: "run_script", script: "steps:\n  - action: hover" });
    expect(a).not.toBe(b);
    expect(a).toContain("run_script");
    expect(a).toContain("script=");
  });

  it("isEquivalentAction compares the script text", () => {
    const x = { type: "run_script", script: VALID_SCRIPT } as const;
    const same = { type: "run_script", script: VALID_SCRIPT } as const;
    const diff = { type: "run_script", script: "steps:\n  - action: hover" } as const;
    expect(isEquivalentAction(x, same)).toBe(true);
    expect(isEquivalentAction(x, diff)).toBe(false);
  });

  it("ACTION_METADATA has a run_script entry (schema-sync enforces the 1:1)", () => {
    const meta = ACTION_METADATA.run_script;
    expect(meta).toBeDefined();
    expect(meta.name).toBe("run_script");
    expect(meta.pageChanging).toBe(true);
  });
});

// ─── Executor end-to-end ───────────────────────────────────────────────────

describe("executeAction run_script", () => {
  it("runs a valid script and returns the exact envelope", async () => {
    const result = await executeAction({ type: "run_script", script: VALID_SCRIPT }, makeState());
    expect(result.success).toBe(true);
    const envelope = JSON.parse(result.extractedContent ?? "{}") as Record<string, unknown>;
    expect(envelope.name).toBe("smoke");
    expect(envelope.steps_executed).toBe(2);
    expect(envelope.steps_total).toBe(2);
    const stepResults = envelope.step_results as Array<Record<string, unknown>>;
    expect(stepResults).toHaveLength(2);
    expect(stepResults[0].action).toBe("get_page_info");
    expect(stepResults[0].success).toBe(true);
    expect(stepResults[1].action).toBe("wait");
    expect(stepResults[1].success).toBe(true);
  });

  it("reports ScriptValidationError honestly for malformed input", async () => {
    const result = await executeAction(
      { type: "run_script", script: "steps: not-a-list" },
      makeState(),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("Invalid script");
  });

  it("reports a blocked sub-step as a per-step failure (on_error stop)", async () => {
    // `evaluate` is fail-closed without a domain allowlist — the sub-step
    // must be reported as failed, not silently swallowed or wrapped.
    const script = [
      "steps:",
      "  - action: evaluate",
      "    code: 'return 1;'",
      "  - action: get_page_info",
    ].join("\n");
    const result = await executeAction({ type: "run_script", script }, makeState());
    expect(result.success).toBe(false);
    const envelope = JSON.parse(result.extractedContent ?? "{}") as Record<string, unknown>;
    const stepResults = envelope.step_results as Array<Record<string, unknown>>;
    expect(stepResults).toHaveLength(1); // on_error stop halts after the failure
    expect(stepResults[0].action).toBe("evaluate");
    expect(stepResults[0].success).toBe(false);
    expect(typeof stepResults[0].message).toBe("string");
  });

  it("continues past a failed step when on_error is continue", async () => {
    const script = [
      "on_error: continue",
      "steps:",
      "  - action: evaluate",
      "    code: 'return 1;'",
      "  - action: get_page_info",
    ].join("\n");
    const result = await executeAction({ type: "run_script", script }, makeState());
    expect(result.success).toBe(false);
    const envelope = JSON.parse(result.extractedContent ?? "{}") as Record<string, unknown>;
    const stepResults = envelope.step_results as Array<Record<string, unknown>>;
    expect(stepResults).toHaveLength(2);
    expect(stepResults[0].success).toBe(false);
    expect(stepResults[1].action).toBe("get_page_info");
    expect(stepResults[1].success).toBe(true);
  });

  it("substitutes ${env.VAR} from the executor's env seam before dispatch", async () => {
    setScriptEnvGetter((key) => (key === "PATTERN" ? "hello" : ""));
    document.body.innerHTML = "<p>hello world</p>";
    const script = ["steps:", '  - action: search_page', '    pattern: "${env.PATTERN}"'].join("\n");
    const result = await executeAction({ type: "run_script", script }, makeState());
    expect(result.success).toBe(true);
    const envelope = JSON.parse(result.extractedContent ?? "{}") as Record<string, unknown>;
    const stepResults = envelope.step_results as Array<Record<string, unknown>>;
    expect(stepResults[0].extractedContent).toContain('Search results for "hello"');
  });

  it("resolves unknown env keys to the empty string (documented engine default)", async () => {
    document.body.innerHTML = "<p>hello world</p>";
    const script = ["steps:", '  - action: search_page', '    pattern: "${env.MISSING}"'].join("\n");
    const result = await executeAction({ type: "run_script", script }, makeState());
    expect(result.success).toBe(true);
    const envelope = JSON.parse(result.extractedContent ?? "{}") as Record<string, unknown>;
    const stepResults = envelope.step_results as Array<Record<string, unknown>>;
    expect(stepResults[0].extractedContent).toContain('Search results for ""');
  });
});
