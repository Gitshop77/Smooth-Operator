/**
 * Contract tests for the browser-agnostic YAML script engine — the port of
 * stealthy-auto-browse's `script_runner.py`. The engine executes validated
 * script steps through an injected dispatch function and returns the exact
 * result envelope. `src/lib/agent/script-runner.ts` is the facade that
 * re-exports the parser (`script-parser.ts`) and validation
 * (`script-validation.ts`) and hosts the execution engine; these tests import
 * the facade surface (`parseScriptYaml`, `validateScript`, `runScript`,
 * `ScriptValidationError`), which is the same surface the executor consumes.
 *
 * The engine is browser-agnostic: every test mocks the dispatch function, so
 * no DOM / chrome APIs are exercised here. The real page-facing wiring (step
 * → `executeAction`, the `javascript` condition reusing the local evaluate
 * handler) lives in `tools/handlers/run-script.ts` + `tools/executor.ts`.
 */

import { describe, test, expect, vi } from "vitest";
import {
  parseScriptYaml,
  validateScript,
  runScript,
  ScriptValidationError,
} from "../src/lib/agent/script-runner";
import type { ScriptRunEnvelope } from "../src/lib/agent/script-runner";

/** Walk every `{step, action, ...}` entry in an envelope, including nested control results. */
function flattenStepResults(
  envelope: ScriptRunEnvelope,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (results: Array<Record<string, unknown>>) => {
    for (const r of results) {
      out.push(r);
      const data = r.data as
        | { step_results?: Array<Record<string, unknown>>; iterations?: Array<{ step_results: Array<Record<string, unknown>> }> }
        | undefined;
      if (data?.step_results) walk(data.step_results);
      if (data?.iterations) for (const it of data.iterations) walk(it.step_results);
    }
  };
  walk(envelope.step_results);
  return out;
}

describe("parseScriptYaml", () => {
  test("parses a JSON script (JSON is valid YAML 1.2)", () => {
    expect(
      parseScriptYaml(JSON.stringify({ steps: [{ action: "click", index: 1 }] })),
    ).toEqual({ steps: [{ action: "click", index: 1 }] });
  });

  test("parses a mapping with a nested list of action steps", () => {
    const text = [
      "name: demo",
      "steps:",
      "  - action: click",
      "    index: 3",
      "  - action: input",
      "    index: 1",
      "    text: hello",
    ].join("\n");
    expect(parseScriptYaml(text)).toEqual({
      name: "demo",
      steps: [
        { action: "click", index: 3 },
        { action: "input", index: 1, text: "hello" },
      ],
    });
  });

  test("parses nested control blocks with indentation", () => {
    const text = [
      "steps:",
      "  - if:",
      "      condition:",
      "        type: text",
      "        text: hello",
      "      then:",
      "        - action: click",
      "          index: 3",
    ].join("\n");
    expect(parseScriptYaml(text)).toEqual({
      steps: [
        {
          if: {
            condition: { type: "text", text: "hello" },
            then: [{ action: "click", index: 3 }],
          },
        },
      ],
    });
  });

  test("parses scalar types (int, float, bool, null, quoted, bare)", () => {
    const text = [
      "name: demo",
      "retries: 3",
      "ratio: 1.5",
      "enabled: true",
      "disabled: false",
      "nothing: null",
      "tilde: ~",
      "quoted: \"hello world\"",
      "single: 'it''s'",
      "bare: hello",
      "empty:",
    ].join("\n");
    expect(parseScriptYaml(text)).toEqual({
      name: "demo",
      retries: 3,
      ratio: 1.5,
      enabled: true,
      disabled: false,
      nothing: null,
      tilde: null,
      quoted: "hello world",
      single: "it's",
      bare: "hello",
      empty: null,
    });
  });

  test("ignores full-line comments and strips trailing inline comments", () => {
    const text = [
      "# top comment",
      "name: demo # trailing",
      "steps:",
      "  - action: click # inline comment",
      "    index: 3",
    ].join("\n");
    expect(parseScriptYaml(text)).toEqual({
      name: "demo",
      steps: [{ action: "click", index: 3 }],
    });
  });

  test("does not strip a # inside a quoted string", () => {
    const text = ["note: \"a # b\"", "steps:", "  - action: wait"].join("\n");
    expect(parseScriptYaml(text)).toEqual({
      note: "a # b",
      steps: [{ action: "wait" }],
    });
  });

  test("returns null for empty / whitespace / comment-only input", () => {
    expect(parseScriptYaml("")).toBeNull();
    expect(parseScriptYaml("   \n  ")).toBeNull();
    expect(parseScriptYaml("# only a comment")).toBeNull();
  });
});

describe("validateScript", () => {
  const ok = { success: true, data: 1 };
  const thenBranch: Array<unknown> = [{ action: "wait" }];

  const invalidCases: Array<[unknown, string]> = [
    [null, "Invalid script: expected a YAML mapping"],
    [[], "Invalid script: expected a YAML mapping"],
    [{}, "Invalid script: steps must be a non-empty list"],
    [{ steps: [] }, "Invalid script: steps must be a non-empty list"],
    [{ steps: "x" }, "Invalid script: steps must be a non-empty list"],
    [{ steps: [null] }, "Invalid script: every step must be a mapping"],
    [{ steps: [{}] }, "Invalid script: action step requires a non-empty action"],
    [{ steps: [{ action: "" }] }, "Invalid script: action step requires a non-empty action"],
    [{ steps: [{ action: "click", output_id: "" }] }, "Invalid script: action output_id must be a non-empty string"],
    [{ steps: [{ if: null }] }, "Invalid script: control node must be a mapping"],
    [{ steps: [{ if: { condition: { type: "text", text: "x" }, then: [] }, repeat: { count: 1, steps: thenBranch } }] }, "Invalid script: a step may contain one control node"],
    [{ steps: [{ if: { condition: { type: "text", text: "x" }, then: [] }, action: "click" }] }, "Invalid script: a control node cannot include action"],
    [{ steps: [{ if: { condition: { type: "text", text: "x" }, then: [] }, other: 1 }] }, "Invalid script: control nodes cannot have sibling fields"],
    [{ steps: [{ if: { condition: { type: "text", text: "x" } } }] }, "Invalid script: if requires condition and then"],
    [{ steps: [{ if: { condition: { type: "text", text: "x" }, then: [], extra: 1 } }] }, "Invalid script: if requires condition and then"],
    [{ steps: [{ repeat: { count: 1, steps: thenBranch, extra: 1 } }] }, "Invalid script: repeat requires only count and steps"],
    [{ steps: [{ repeat: { count: 1, steps: [] } }] }, "Invalid script: step block must not be empty"],
    [{ steps: [{ repeat: { count: true, steps: thenBranch } }] }, "Invalid script: repeat count must be an integer"],
    [{ steps: [{ repeat: { count: 2.5, steps: thenBranch } }] }, "Invalid script: repeat count must be an integer"],
    [{ steps: [{ repeat: { count: 0, steps: thenBranch } }] }, "Invalid script: repeat count must be between 1 and 100"],
    [{ steps: [{ repeat: { count: 101, steps: thenBranch } }] }, "Invalid script: repeat count must be between 1 and 100"],
    [{ steps: [{ while: { condition: { type: "text", text: "x" }, max_iterations: 1, steps: thenBranch, extra: 1 } }] }, "Invalid script: while requires condition, max_iterations, and steps"],
    [{ steps: [{ while: { condition: { type: "text", text: "x" }, max_iterations: "3", steps: thenBranch } }] }, "Invalid script: while max_iterations must be an integer"],
    [{ steps: [{ while: { condition: { type: "text", text: "x" }, max_iterations: 101, steps: thenBranch } }] }, "Invalid script: while max_iterations must be between 1 and 100"],
    // condition validation
    [{ steps: [{ if: { condition: null, then: [] } }] }, "Invalid script: condition must be a mapping"],
    [{ steps: [{ if: { condition: { type: "bogus" }, then: [] } }] }, "Invalid script: unsupported condition type"],
    [{ steps: [{ if: { condition: { type: "text", text: "x", extra: 1 }, then: [] } }] }, "Invalid script: unsupported condition field"],
    [{ steps: [{ while: { condition: { type: "all", conditions: [{ type: "text", text: "x", timeout: 1 }] }, max_iterations: 1, steps: thenBranch } }] }, "Invalid script: nested conditions cannot set timeout"],
    [{ steps: [{ if: { condition: { type: "element", selector: "", state: "visible" }, then: [] } }] }, "Invalid script: element selector must be a non-empty string"],
    [{ steps: [{ if: { condition: { type: "element", selector: "x", state: "bogus" }, then: [] } }] }, "Invalid script: unsupported element state"],
    [{ steps: [{ if: { condition: { type: "text", text: "" }, then: [] } }] }, "Invalid script: text condition text must be a non-empty string"],
    [{ steps: [{ if: { condition: { type: "url", matches: "" }, then: [] } }] }, "Invalid script: url condition matches must be a non-empty string"],
    [{ steps: [{ if: { condition: { type: "javascript", expression: "" }, then: [] } }] }, "Invalid script: javascript condition expression must be a non-empty string"],
    [{ steps: [{ if: { condition: { type: "output", output_id: "x" }, then: [] } }] }, "Invalid script: output condition requires exactly one of equals or exists"],
    [{ steps: [{ if: { condition: { type: "output", output_id: "x", equals: "y", exists: true }, then: [] } }] }, "Invalid script: output condition requires exactly one of equals or exists"],
    [{ steps: [{ if: { condition: { type: "output", output_id: "", exists: true }, then: [] } }] }, "Invalid script: output condition output_id must be a non-empty string"],
    [{ steps: [{ if: { condition: { type: "output", output_id: "x", exists: 1 }, then: [] } }] }, "Invalid script: output condition exists must be boolean"],
    [{ steps: [{ if: { condition: { type: "output", output_id: "x", exists: true, path: "a" }, then: [] } }] }, "Invalid script: output condition path must be a list"],
    [{ steps: [{ if: { condition: { type: "output", output_id: "x", exists: true, path: [true] }, then: [] } }] }, "Invalid script: output condition path is invalid"],
    [{ steps: [{ if: { condition: { type: "output", output_id: "x", exists: true, path: [-1] }, then: [] } }] }, "Invalid script: output condition path is invalid"],
    [{ steps: [{ if: { condition: { type: "all", conditions: [] }, then: [] } }] }, "Invalid script: all and any require a non-empty conditions list"],
    [{ steps: [{ if: { condition: { type: "not" }, then: [] } }] }, "Invalid script: not requires condition"],
    [{ steps: [{ if: { condition: { type: "text", text: "x", timeout: "a" }, then: [] } }] }, "Invalid script: condition timeout must be a number"],
    [{ steps: [{ if: { condition: { type: "text", text: "x", timeout: Infinity }, then: [] } }] }, "Invalid script: condition timeout must be finite"],
    [{ steps: [{ if: { condition: { type: "text", text: "x", timeout: 61 }, then: [] } }] }, "Invalid script: condition timeout is outside range"],
    [{ steps: [{ action: "click", index: 1 }], on_error: "bogus" }, "Invalid script: on_error must be 'stop' or 'continue'"],
  ];

  test.each(invalidCases)("rejects %j with the pinned message", (script, message) => {
    expect(() => validateScript(script)).toThrow(ScriptValidationError);
    expect(() => validateScript(script)).toThrow(message);
  });

  test("rejects control-flow nesting beyond 8 levels", () => {
    let inner: unknown = { action: "click", index: 1 };
    for (let i = 0; i < 9; i++) {
      inner = { if: { condition: { type: "text", text: "x" }, then: [inner] } };
    }
    expect(() => validateScript({ steps: [inner] })).toThrow(
      "Invalid script: control-flow nesting limit exceeded",
    );
  });

  test("rejects condition nesting beyond 8 levels", () => {
    let cond: unknown = { type: "text", text: "x" };
    for (let i = 0; i < 9; i++) {
      cond = { type: "all", conditions: [cond] };
    }
    expect(() =>
      validateScript({ steps: [{ if: { condition: cond, then: [] } }] }),
    ).toThrow("Invalid script: condition nesting limit exceeded");
  });

  const validCases: Array<unknown> = [
    { steps: [{ action: "click", index: 1 }] },
    { name: "x", on_error: "continue", steps: [{ action: "click", index: 1 }] },
    { steps: [{ if: { condition: { type: "text", text: "x", timeout: 0.5 }, then: [] } }] },
    { steps: [{ if: { condition: { type: "element", selector: "x" }, then: [], else: [] } }] },
    { steps: [{ repeat: { count: 1, steps: [{ action: "wait" }] } }] },
    { steps: [{ while: { condition: { type: "url", matches: "*" }, max_iterations: 1, steps: [{ action: "wait" }] } }] },
    { steps: [{ if: { condition: { type: "output", output_id: "x", equals: "y" }, then: [] } }] },
    { steps: [{ if: { condition: { type: "output", output_id: "x", exists: false, path: ["a", 0] }, then: [] } }] },
    { steps: [{ if: { condition: { type: "all", conditions: [{ type: "text", text: "x" }] }, then: [] } }] },
    { steps: [{ if: { condition: { type: "not", condition: { type: "text", text: "x" } }, then: [] } }] },
  ];

  test.each(validCases)("accepts a valid script: %j", (script) => {
    expect(() => validateScript(script)).not.toThrow();
  });

  test("runScript re-validates its input and throws the same error", async () => {
    await expect(runScript({ steps: [] }, async () => ok)).rejects.toThrow(
      "Invalid script: steps must be a non-empty list",
    );
  });
});

describe("runScript envelope + dispatch", () => {
  test("executes steps in order and returns the exact envelope", async () => {
    const dispatch = vi.fn(async (step: Record<string, unknown>) => ({
      success: true,
      data: step,
    }));
    const result = await runScript(
      {
        name: "demo",
        steps: [
          { action: "click", index: 3 },
          { action: "wait", seconds: 1 },
        ],
      },
      dispatch,
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0][0]).toEqual({ action: "click", index: 3 });
    expect(dispatch.mock.calls[1][0]).toEqual({ action: "wait", seconds: 1 });
    expect(result.name).toBe("demo");
    expect(result.success).toBe(true);
    expect(result.steps_executed).toBe(2);
    expect(result.steps_total).toBe(2);
    expect(typeof result.duration).toBe("number");
    expect(result.outputs).toBeUndefined();
    expect(result.step_results).toEqual([
      { step: 1, action: "click", duration: expect.any(Number), success: true, data: { action: "click", index: 3 } },
      { step: 2, action: "wait", duration: expect.any(Number), success: true, data: { action: "wait", seconds: 1 } },
    ]);
  });

  test("defaults the script name to 'unnamed'", async () => {
    const result = await runScript(
      { steps: [{ action: "click", index: 1 }] },
      async () => ({ success: true }),
    );
    expect(result.name).toBe("unnamed");
  });

  test("omits outputs when no step used an output_id; includes them when one does", async () => {
    const noOutputs = await runScript(
      { steps: [{ action: "click", index: 1 }] },
      async () => ({ success: true }),
    );
    expect(noOutputs.outputs).toBeUndefined();

    const dispatch = vi.fn(async (step: Record<string, unknown>) =>
      step.action === "screenshot"
        ? { success: true, _binary: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }
        : { success: true, data: { answer: 42 } },
    );
    const withOutputs = await runScript(
      {
        steps: [
          { action: "screenshot", file_name: "x", output_id: "shot" },
          { action: "extract", query: "q", output_id: "ans" },
        ],
      },
      dispatch,
    );
    expect(withOutputs.outputs).toEqual({
      shot: "data:image/png;base64,iVBORw==",
      ans: { answer: 42 },
    });
    // `_binary` never leaks into the step results.
    expect(withOutputs.step_results[0]).not.toHaveProperty("_binary");
  });

  test("captures extractedContent-only results into outputs", async () => {
    const result = await runScript(
      { steps: [{ action: "evaluate", code: "1+1", output_id: "v" }] },
      async () => ({ success: true, extractedContent: "2" }),
    );
    expect(result.outputs).toEqual({ v: "2" });
  });

  test("stores an output only when the step succeeded", async () => {
    let calls = 0;
    const dispatch = vi.fn(async () => {
      calls++;
      return calls === 1 ? { success: true, data: "a" } : { success: false, message: "boom" };
    });
    const result = await runScript(
      {
        steps: [
          { action: "extract", query: "q", output_id: "x" },
          { action: "click", index: 1, output_id: "y" },
        ],
      },
      dispatch,
    );
    expect(result.outputs).toEqual({ x: "a" });
    expect(result.success).toBe(false);
  });

  test("stops on the first failure with the default on_error: stop", async () => {
    const dispatch = vi.fn(async (step: Record<string, unknown>) =>
      step.action === "input" ? { success: false, message: "boom" } : { success: true },
    );
    const result = await runScript(
      {
        steps: [
          { action: "click", index: 1 },
          { action: "input", index: 2, text: "x" },
          { action: "wait" },
        ],
      },
      dispatch,
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.steps_executed).toBe(2);
    expect(result.steps_total).toBe(3);
    expect(result.step_results[1]).toMatchObject({
      step: 2,
      action: "input",
      success: false,
      message: "boom",
    });
  });

  test("continues after a failed step with on_error: continue", async () => {
    const dispatch = vi.fn(async (step: Record<string, unknown>) =>
      step.action === "input" ? { success: false, message: "boom" } : { success: true },
    );
    const result = await runScript(
      {
        on_error: "continue",
        steps: [
          { action: "click", index: 1 },
          { action: "input", index: 2, text: "x" },
          { action: "wait" },
        ],
      },
      dispatch,
    );
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(false);
    expect(result.steps_executed).toBe(3);
  });

  test("wraps a thrown dispatch error as 'action dispatch failed'", async () => {
    const result = await runScript(
      { steps: [{ action: "click", index: 1 }] },
      async () => {
        throw new Error("boom");
      },
    );
    expect(result.success).toBe(false);
    expect(result.step_results[0].error).toBe("action dispatch failed");
  });

  test("wraps a non-object dispatch result as 'action dispatch returned an invalid result'", async () => {
    const result = await runScript(
      { steps: [{ action: "click", index: 1 }] },
      // @ts-expect-error the engine must tolerate a misbehaving dispatch
      async () => "oops",
    );
    expect(result.success).toBe(false);
    expect(result.step_results[0].error).toBe(
      "action dispatch returned an invalid result",
    );
  });
});

describe("control flow", () => {
  test("if runs the then branch when the condition matches", async () => {
    const dispatch = vi.fn(async (step: Record<string, unknown>) =>
      step.action === "eval" ? { success: true, extractedContent: "true" } : { success: true },
    );
    const result = await runScript(
      {
        steps: [
          { if: { condition: { type: "text", text: "hello" }, then: [{ action: "click", index: 1 }] } },
        ],
      },
      dispatch,
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0][0]).toEqual({
      action: "eval",
      expression: expect.stringContaining('document.body !== null && document.body.innerText.includes("hello")'),
    });
    expect(result.success).toBe(true);
    expect(result.step_results[0].data).toEqual({
      matched: true,
      branch: "then",
      step_results: [expect.objectContaining({ step: 1, action: "click" })],
    });
  });

  test("if runs the else branch when the condition does not match", async () => {
    const dispatch = vi.fn(async (step: Record<string, unknown>) =>
      step.action === "eval" ? { success: true, extractedContent: "false" } : { success: true },
    );
    const result = await runScript(
      {
        steps: [
          {
            if: {
              condition: { type: "text", text: "hello" },
              then: [{ action: "click", index: 1 }],
              else: [{ action: "wait" }],
            },
          },
        ],
      },
      dispatch,
    );
    expect(result.step_results[0].data).toEqual({
      matched: false,
      branch: "else",
      step_results: [expect.objectContaining({ step: 1, action: "wait" })],
    });
  });

  test("if with no else reports branch 'none' when the condition fails", async () => {
    const result = await runScript(
      {
        steps: [
          { if: { condition: { type: "text", text: "hello" }, then: [{ action: "click", index: 1 }] } },
        ],
      },
      async (step) => (step.action === "eval" ? { success: true, extractedContent: "false" } : { success: true }),
    );
    expect(result.success).toBe(true);
    expect(result.step_results[0].data).toEqual({ matched: false, branch: "none", step_results: [] });
  });

  test("repeat iterates 1-indexed", async () => {
    const dispatch = vi.fn(async () => ({ success: true }));
    const result = await runScript(
      {
        steps: [{ repeat: { count: 2, steps: [{ action: "click", index: 1 }] } }],
      },
      dispatch,
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.step_results[0].data).toEqual({
      iterations: [
        { iteration: 1, step_results: [expect.objectContaining({ step: 1, action: "click" })] },
        { iteration: 2, step_results: [expect.objectContaining({ step: 1, action: "click" })] },
      ],
      count: 2,
    });
  });

  test("repeat keeps iterating after failures with on_error: continue", async () => {
    let calls = 0;
    const dispatch = vi.fn(async () => {
      calls++;
      return { success: calls >= 3 };
    });
    const result = await runScript(
      {
        on_error: "continue",
        steps: [{ repeat: { count: 3, steps: [{ action: "click", index: 1 }] } }],
      },
      dispatch,
    );
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(false);
    expect((result.step_results[0].data as { count: number }).count).toBe(3);
    expect((result.step_results[0].data as { iterations: unknown[] }).iterations).toHaveLength(3);
  });

  test("while pre-tests the condition and exits when it turns false", async () => {
    let evalCalls = 0;
    const dispatch = vi.fn(async (step: Record<string, unknown>) => {
      if (step.action === "eval") {
        evalCalls++;
        return { success: true, extractedContent: evalCalls === 1 ? "true" : "false" };
      }
      return { success: true };
    });
    const result = await runScript(
      {
        steps: [
          { while: { condition: { type: "text", text: "x" }, max_iterations: 5, steps: [{ action: "click", index: 1 }] } },
        ],
      },
      dispatch,
    );
    expect(result.success).toBe(true);
    expect((result.step_results[0].data as { iterations: unknown[] }).iterations).toHaveLength(1);
  });

  test("while fails with 'while loop reached max_iterations' when the condition stays true", async () => {
    const dispatch = vi.fn(async (step: Record<string, unknown>) =>
      step.action === "eval" ? { success: true, extractedContent: "true" } : { success: true },
    );
    const result = await runScript(
      {
        steps: [
          { while: { condition: { type: "text", text: "x" }, max_iterations: 2, steps: [{ action: "click", index: 1 }] } },
        ],
      },
      dispatch,
    );
    expect(result.success).toBe(false);
    expect(result.step_results[0].error).toBe("while loop reached max_iterations");
    expect((result.step_results[0].data as { iterations: unknown[] }).iterations).toHaveLength(2);
  });

  test("halts with 'loop step execution limit exceeded' after 1000 in-loop step executions", async () => {
    const dispatch = vi.fn(async () => ({ success: true }));
    const result = await runScript(
      {
        steps: [
          {
            repeat: {
              count: 100,
              steps: Array.from({ length: 11 }, (_, i) => ({ action: "click", index: i + 1 })),
            },
          },
        ],
      },
      dispatch,
    );
    expect(dispatch).toHaveBeenCalledTimes(1000);
    expect(result.success).toBe(false);
    const flat = flattenStepResults(result);
    expect(
      flat.some((r) => r.action === "loop_limit" && r.error === "loop step execution limit exceeded"),
    ).toBe(true);
  });

  test("a non-boolean condition evaluation surfaces as 'condition evaluation failed'", async () => {
    const dispatch = vi.fn(async (step: Record<string, unknown>) =>
      step.action === "eval" ? { success: true, extractedContent: "1" } : { success: true },
    );
    const result = await runScript(
      {
        steps: [
          { if: { condition: { type: "javascript", expression: "1 + 1" }, then: [{ action: "click", index: 1 }] } },
        ],
      },
      dispatch,
    );
    expect(result.success).toBe(false);
    expect(result.step_results[0].error).toBe("condition evaluation failed");
  });

  test("a failed condition dispatch surfaces as 'condition evaluation failed' (fail-closed)", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("evaluate is blocked on this domain");
    });
    const result = await runScript(
      {
        steps: [
          { if: { condition: { type: "javascript", expression: "true" }, then: [{ action: "click", index: 1 }] } },
        ],
      },
      dispatch,
    );
    expect(result.success).toBe(false);
    expect(result.step_results[0].error).toBe("condition evaluation failed");
  });
});

describe("conditions", () => {
  test("url condition matches with fnmatch-style globs", async () => {
    const run = async (matches: string, href: string) => {
      const dispatch = vi.fn(async () => ({ success: true, extractedContent: href }));
      const result = await runScript(
        {
          steps: [{ if: { condition: { type: "url", matches }, then: [{ action: "wait" }] } }],
        },
        dispatch,
      );
      return (result.step_results[0].data as { matched: boolean }).matched;
    };
    expect(await run("https://example.com/*", "https://example.com/foo/bar")).toBe(true);
    expect(await run("https://*.example.com/*", "https://a.example.com/x")).toBe(true);
    expect(await run("https://example.com/page?", "https://example.com/pageX")).toBe(true);
    expect(await run("https://example.com/page", "https://example.com/page2")).toBe(false);
  });

  test("element condition dispatches a querySelector expression and respects the state", async () => {
    let seenExpression = "";
    const dispatch = vi.fn(async (step: Record<string, unknown>) => {
      if (step.action === "eval") {
        seenExpression = String(step.expression);
        return { success: true, extractedContent: "true" };
      }
      return { success: true };
    });
    const result = await runScript(
      {
        steps: [
          { if: { condition: { type: "element", selector: ".btn", state: "hidden" }, then: [{ action: "wait" }] } },
        ],
      },
      dispatch,
    );
    expect(seenExpression).toContain('document.querySelector(".btn")');
    expect(seenExpression).toContain("'hidden'");
    expect((result.step_results[0].data as { matched: boolean }).matched).toBe(true);
  });

  test("javascript condition requires a strict boolean", async () => {
    const run = async (extracted: string) => {
      const dispatch = vi.fn(async () => ({ success: true, extractedContent: extracted }));
      const result = await runScript(
        {
          steps: [{ if: { condition: { type: "javascript", expression: "1 < 2" }, then: [{ action: "wait" }] } }],
        },
        dispatch,
      );
      return (result.step_results[0].data as { matched?: boolean }).matched;
    };
    expect(await run("true")).toBe(true);
    expect(await run("false")).toBe(false);
    const nonBool = await runScript(
      { steps: [{ if: { condition: { type: "javascript", expression: "1" }, then: [] } }] },
      async () => ({ success: true, extractedContent: "1" }),
    );
    expect(nonBool.step_results[0].error).toBe("condition evaluation failed");
  });

  test("output condition reads stored outputs with equals / exists / path", async () => {
    const dispatch = vi.fn(async () => ({ success: true, data: { nested: [10, 20] } }));
    const steps = [
      { action: "extract", query: "q", output_id: "o" },
      { if: { condition: { type: "output", output_id: "o", path: ["nested", 1], equals: 20 }, then: [{ action: "click", index: 1 }] } },
    ];
    const matched = await runScript({ steps }, dispatch);
    expect(matched.step_results[1].data).toMatchObject({ matched: true, branch: "then" });

    const stepsNot = [
      { action: "extract", query: "q", output_id: "o" },
      { if: { condition: { type: "output", output_id: "o", path: ["nested", 1], equals: 99 }, then: [{ action: "click", index: 1 }] } },
    ];
    const notMatched = await runScript({ steps: stepsNot }, dispatch);
    expect(notMatched.step_results[1].data).toMatchObject({ matched: false, branch: "none" });

    const missingExistsFalse = await runScript(
      { steps: [{ if: { condition: { type: "output", output_id: "ghost", exists: false }, then: [{ action: "wait" }] } }] },
      async () => ({ success: true }),
    );
    expect(missingExistsFalse.step_results[0].data).toMatchObject({ matched: true, branch: "then" });
  });

  test("all / any / not combine nested conditions", async () => {
    const run = async (condition: unknown, hrefs: string[]) => {
      let i = 0;
      const dispatch = vi.fn(async () => ({ success: true, extractedContent: hrefs[i++] ?? "https://x" }));
      const result = await runScript(
        { steps: [{ if: { condition, then: [{ action: "wait" }] } }] },
        dispatch,
      );
      return (result.step_results[0].data as { matched: boolean }).matched;
    };
    expect(
      await run({ type: "all", conditions: [{ type: "url", matches: "https://*" }, { type: "url", matches: "https://*" }] }, ["https://a", "https://b"]),
    ).toBe(true);
    expect(
      await run({ type: "all", conditions: [{ type: "url", matches: "https://*" }, { type: "url", matches: "https://other" }] }, ["https://a", "https://b"]),
    ).toBe(false);
    expect(
      await run({ type: "any", conditions: [{ type: "url", matches: "https://other" }, { type: "url", matches: "https://*" }] }, ["https://a", "https://b"]),
    ).toBe(true);
    expect(
      await run({ type: "not", condition: { type: "url", matches: "https://other" } }, ["https://a"]),
    ).toBe(true);
  });

  test("polls a condition until the timeout expires", async () => {
    const seq = ["false", "false", "true"];
    let i = 0;
    const dispatch = vi.fn(async () => ({ success: true, extractedContent: seq[i++] ?? "false" }));
    const result = await runScript(
      {
        steps: [{ if: { condition: { type: "text", text: "x", timeout: 0.3 }, then: [{ action: "click", index: 1 }] } }],
      },
      dispatch,
    );
    expect(result.step_results[0].data).toMatchObject({ matched: true, branch: "then" });
    expect(i).toBeGreaterThanOrEqual(3);
  });
});

describe("env substitution", () => {
  test("substitutes ${env.VAR} recursively from the injected getEnv; missing resolves to ''", async () => {
    const env: Record<string, string> = { USERNAME: "alice", TOKEN: "abc" };
    const dispatch = vi.fn(async (step: Record<string, unknown>) => ({ success: true, data: step }));
    await runScript(
      {
        steps: [{ action: "input", index: 1, text: "Hello ${env.USERNAME} ${env.MISSING}!" }],
      },
      dispatch,
      { getEnv: (k) => env[k] ?? "" },
    );
    expect(dispatch.mock.calls[0][0]).toEqual({
      action: "input",
      index: 1,
      text: "Hello alice !",
    });
  });

  test("env substitution recurses through nested steps and leaves non-strings untouched", async () => {
    const dispatch = vi.fn(async (step: Record<string, unknown>) => ({ success: true, data: step }));
    await runScript(
      {
        steps: [
          {
            repeat: {
              count: 1,
              steps: [
                { action: "input", index: 1, text: "${env.X}", opts: ["${env.Y}", 3] },
              ],
            },
          },
        ],
      },
      dispatch,
      { getEnv: (k) => (k === "X" ? "xval" : "yval") },
    );
    expect(dispatch.mock.calls[0][0]).toEqual({
      action: "input",
      index: 1,
      text: "xval",
      opts: ["yval", 3],
    });
  });

  test("env substitution leaves %secret% placeholders and ${url} alone", async () => {
    const dispatch = vi.fn(async (step: Record<string, unknown>) => ({ success: true, data: step }));
    await runScript(
      {
        steps: [{ action: "input", index: 1, text: "%secret% ${url} ${env.X}" }],
      },
      dispatch,
      { getEnv: () => "alice" },
    );
    expect(dispatch.mock.calls[0][0]).toEqual({
      action: "input",
      index: 1,
      text: "%secret% ${url} alice",
    });
  });
});
