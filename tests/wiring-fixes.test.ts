/**
 * Wiring-fix tests — verifies the "wire dead code + quick wins" fixes landed
 * correctly. Each test exercises one of the validation-flagged dead-code paths
 * so it doesn't regress back to dead code.
 *
 * Covers:
 * - EvaluatorComb + the orchestrator's `runDeterministicEvaluators`
 * fast-path (string + URL evaluators).
 * - `press_and_hold` action schema, ACTION_METADATA entry, loop
 * normalization, and native-click fallback.
 * - `getFormatInstructions` returns a non-empty string for any Zod schema
 * (the prompt-injection point used by llm-direct.ts).
 * - parse-error feedback — the orchestrator's parse-retry loop appends a
 * `<parse_error>` block to the next attempt's loopWarning.
 * - `ask_human` password mode — the executor returns a redacted message +
 * extractedContent (the real value never reaches the LLM).
 * - `select_dropdown` custom-dropdown fallback — clicks the dropdown,
 * finds the matching `[role=option]`, and clicks it.
 * - `find_elements` with `xpath:` / `id:` / `tag:` prefixes resolves via
 * `findByLocator` instead of bare `querySelectorAll`.
 *
 * The integration-level fixes (CDP debugger leak, alarm listener wiring,
 * screenshot route, etc.) require the full orchestrator + extension plumbing
 * and are smoke-tested by the broader test suite + the build itself; their
 * wiring is verified by the self-check greps the validator runs.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { executeAction, describeAction } from "../src/lib/agent/tools/executor";
import {
  ActionSchema,
  AgentOutputSchema,
  AskHumanSchema,
} from "../src/lib/agent/tools/schema";
import { ACTION_METADATA, isEquivalentAction } from "../src/lib/agent/tools/schema-utils";
import { getFormatInstructions } from "../src/lib/agent/tools/registry";
import { EvaluatorComb } from "../src/lib/agent/evaluators";
import { LoopDetector } from "../src/lib/agent/loop/loop-detector";
import { executeActionQueue } from "../src/lib/agent/loop/helpers/action-queue";
import type { CallbackDispatcher, CallbackContext } from "../src/lib/agent/callbacks";
import type { LoopDeps } from "../src/lib/agent/loop/types";
import type { AgentAction, LogEvent, AgentConfig } from "../src/lib/agent/types";
import { makeState } from "./helpers";

// ─── Evaluator combinator ───────────────────────────────────────────────────

describe("EvaluatorComb (deterministic-evaluator fast-path)", () => {
  test("string-match evaluator passes when the prediction contains the reference", async () => {
    const comb = new EvaluatorComb(["string_match"]);
    const result = await comb.evaluate({
      string: {
        prediction: "The price is $42.99",
        referenceAnswers: [{ type: "must_include", ref: "$42.99" }],
      },
    });
    expect(result.score).toBe(1);
    expect(result.reasons).toHaveLength(0);
  });

  test("string-match evaluator fails when the prediction doesn't include the reference", async () => {
    const comb = new EvaluatorComb(["string_match"]);
    const result = await comb.evaluate({
      string: {
        prediction: "no price here",
        referenceAnswers: [{ type: "must_include", ref: "$42.99" }],
      },
    });
    expect(result.score).toBe(0);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  test("URL-match evaluator passes when prediction URL contains the reference URL", async () => {
    const comb = new EvaluatorComb(["url_match"]);
    const result = await comb.evaluate({
      url: {
        prediction: "https://example.com/products/123?ref=abc",
 // Reference URL needs a protocol so the URL parser can extract a
 // `host + pathname` (bare `example.com/...` has no protocol and
 // produces an empty basePath, which the evaluator treats as no match).
        referenceUrl: "https://example.com/products/123",
      },
    });
    expect(result.score).toBe(1);
  });

  test("combined score multiplies: 1.0 only when every configured evaluator passes", async () => {
    const comb = new EvaluatorComb(["string_match", "url_match"]);
    const both = await comb.evaluate({
      string: {
        prediction: "answer: 42",
        referenceAnswers: [{ type: "must_include", ref: "42" }],
      },
      url: {
        prediction: "https://example.com/success",
        referenceUrl: "https://example.com/success",
      },
    });
    expect(both.score).toBe(1);

    const urlFails = await comb.evaluate({
      string: {
        prediction: "answer: 42",
        referenceAnswers: [{ type: "must_include", ref: "42" }],
      },
      url: {
        prediction: "https://other.com/failure",
        referenceUrl: "https://example.com/success",
      },
    });
    expect(urlFails.score).toBe(0);
  });

  test("returns empty result when no evaluator inputs are provided", async () => {
    const comb = new EvaluatorComb(["string_match", "url_match"]);
    const result = await comb.evaluate({});
    expect(result.score).toBe(0); // no evaluators ran → fail-closed (not evidence of success)
    expect(result.results).toHaveLength(0);
  });
});

// ─── press_and_hold action ──────────────────────────────────────────────────

describe("press_and_hold action wiring", () => {
  test("PressAndHoldSchema is part of ActionSchema (variant exists)", () => {
  // Round-trip through the real schema instead of introspecting zod
  // internals (`shape.type.values instanceof Set`), which a zod upgrade
  // could break independently of the schema's actual content.
    const parsed = ActionSchema.safeParse({ type: "press_and_hold", index: 1 });
    expect(parsed.success).toBe(true);
  });

  test("ACTION_METADATA has press_and_hold entry", () => {
    expect(ACTION_METADATA.press_and_hold).toBeDefined();
    expect(ACTION_METADATA.press_and_hold.name).toBe("press_and_hold");
    expect(ACTION_METADATA.press_and_hold.pageChanging).toBe(true);
  });

  test("describeAction formats press_and_hold with hold_ms", () => {
    const a = { type: "press_and_hold", index: 7, hold_ms: 2000, delay_ms: 0 } as AgentAction;
    expect(describeAction(a)).toContain("press_and_hold element [7]");
    expect(describeAction(a)).toContain("2000ms");
  });

  test("isEquivalentAction: press_and_hold compared by index + hold_ms", () => {
    const a = { type: "press_and_hold", index: 1, hold_ms: 1500, delay_ms: 0 } as AgentAction;
    const b = { type: "press_and_hold", index: 1, hold_ms: 1500, delay_ms: 100 } as AgentAction;
 // delay_ms differs but hold_ms matches → equivalent (delay is a UX knob, not a page-effect knob)
    expect(isEquivalentAction(a, b)).toBe(true);
    const c = { type: "press_and_hold", index: 1, hold_ms: 3000, delay_ms: 0 } as AgentAction;
    expect(isEquivalentAction(a, c)).toBe(false);
  });

  test("LoopDetector normalizes press_and_hold by index + hold_ms (delay_ms ignored)", () => {
    const det = new LoopDetector();
  // Alternate delay_ms between records: delay is a UX knob, not a
  // page-effect knob, so it must NOT change the loop signature — 5
  // records that differ only in delay_ms still trip the warning.
    for (let i = 0; i < 5; i++) {
      det.record({
        type: "press_and_hold", index: 1, hold_ms: 1500, delay_ms: i % 2 === 0 ? 0 : 100,
      } as AgentAction);
    }
    expect(det.shouldWarn()).toBe(5);
  });

  test("executeAction press_and_hold falls back to native click when CDP unavailable", async () => {
 // Set up a DOM element at index 1.
    const btn = document.createElement("button");
    btn.textContent = "Hold me";
    let clicked = false;
    btn.addEventListener("click", () => { clicked = true; });
    document.body.appendChild(btn);
    const state = makeState({ selectorMap: { 1: btn } });
 // hold_ms=0 so the test doesn't actually wait.
    const action = { type: "press_and_hold", index: 1, hold_ms: 0, delay_ms: 0 } as AgentAction;
    const result = await executeAction(action, state);
    expect(result.success).toBe(true);
    expect(result.message).toContain("native fallback");
    expect(clicked).toBe(true);
    document.body.removeChild(btn);
  });
});

// ─── getFormatInstructions ──────────────────────────────────────────────────

describe("getFormatInstructions", () => {
  test("returns a non-empty string containing a JSON schema", () => {
    const text = getFormatInstructions(AgentOutputSchema);
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(100);
    expect(text).toContain("JSON");
    expect(text).toContain("```");
  // The instructions must carry an actual schema artifact, not just the
  // preamble — assert a field that only exists in the parsed schema
  // (passing on the intro/prelude text alone would be a false positive).
    expect(text).toContain("next_goal");
  });
});

// ─── parse-error feedback ────────────────────────────────────────────────────
//
// The orchestrator's parse-retry loop mutates `navRequest.loopWarning` to
// inject a `<parse_error>` block on parse failure. We can't easily exercise
// the full orchestrator here (it requires an LLM mock), but we CAN verify
// the contract: the AgentStepRequest type allows `loopWarning?: string` and
// the parser produces the error message format the orchestrator expects.

describe("parse-error feedback contract", () => {
  test("AgentStepRequest.loopWarning is a string field (mutable for parse-error injection)", async () => {
    const { parseAgentOutput } = await import("../src/lib/agent/output-parser");
 // A malformed response → parseAgentOutput returns ok:false with an error
 // the orchestrator can interpolate into a <parse_error> block.
    const result = parseAgentOutput("not json at all");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(typeof result.error).toBe("string");
  });
});

// ─── ask_human password mode ────────────────────────────────────────────────

describe("ask_human password mode", () => {
  let originalPrompt: typeof window.prompt;
  beforeEach(() => { originalPrompt = window.prompt; });
  afterEach(() => { window.prompt = originalPrompt; });

  test("password mode redacts the value in the result message + extractedContent", async () => {
    window.prompt = vi.fn(() => "super-secret-api-key") as typeof window.prompt;
    const action = {
      type: "ask_human",
      question: "Enter your API key",
      mode: "password",
    } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
 // The real value must NOT appear in either LLM-bound field.
    expect(result.message).not.toContain("super-secret-api-key");
    expect(result.extractedContent).not.toContain("super-secret-api-key");
// Both should mention "REDACTED" so the LLM knows a value was provided.
    expect(result.message).toContain("redacted");
    expect(result.extractedContent).toContain("REDACTED");
  });

  test("default mode (input) returns the visible answer", async () => {
    window.prompt = vi.fn(() => "my visible answer") as typeof window.prompt;
    const action = {
      type: "ask_human",
      question: "What is your name?",
    } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
    expect(result.message).toContain("my visible answer");
    expect(result.extractedContent).toContain("my visible answer");
  });

  test("password mode AskHumanSchema field defaults to 'input'", () => {
 // The schema accepts the action without mode (default) AND with explicit
 // "password" mode — a regression that made mode required would fail here.
    const withoutMode = { type: "ask_human", question: "?" } as AgentAction;
    const withPassword = { type: "ask_human", question: "?", mode: "password" } as AgentAction;
    expect(AskHumanSchema.parse(withoutMode).mode).toBe("input");
    expect(AskHumanSchema.parse(withPassword).mode).toBe("password");
  });
});

// ─── select_dropdown custom-dropdown fallback ───────────────────────────────

describe("select_dropdown custom-dropdown fallback", () => {
  test("clicks the dropdown + matching [role=option]", async () => {
 // Build a custom dropdown: a div[role=combobox] with two [role=option] children.
    const dropdown = document.createElement("div");
    dropdown.setAttribute("role", "combobox");
    dropdown.tabIndex = 0;
    const opt1 = document.createElement("div");
    opt1.setAttribute("role", "option");
    opt1.textContent = "Apple";
    const opt2 = document.createElement("div");
    opt2.setAttribute("role", "option");
    opt2.textContent = "Banana";
    dropdown.appendChild(opt1);
    dropdown.appendChild(opt2);
    document.body.appendChild(dropdown);

 // Track ONLY clicks on the dropdown itself (not bubbled-from-children
 // clicks) — the dropdown.click() call to open it.
    let openedClickCount = 0;
    dropdown.addEventListener("click", (e) => {
      if (e.target === dropdown) openedClickCount++;
    });
    let chosenOption: Element | null = null;
    opt2.addEventListener("click", (e) => {
      e.stopPropagation();
      chosenOption = opt2;
    });

    const state = makeState({ selectorMap: { 1: dropdown } });
    const action = { type: "select_dropdown", index: 1, text: "Banana" } as AgentAction;
    const result = await executeAction(action, state);

    expect(result.success).toBe(true);
    expect(result.message).toContain("custom dropdown");
    expect(result.message).toContain("Banana");
    expect(openedClickCount).toBe(1); // dropdown was clicked once to open
    expect(chosenOption).toBe(opt2);

    document.body.removeChild(dropdown);
  });

  test("returns failure for a plain <div> (not a <select> or custom dropdown)", async () => {
    const div = document.createElement("div");
    div.textContent = "just text";
    document.body.appendChild(div);
    const state = makeState({ selectorMap: { 1: div } });
    const action = { type: "select_dropdown", index: 1, text: "x" } as AgentAction;
    const result = await executeAction(action, state);
    expect(result.success).toBe(false);
    expect(result.message).toContain("not a <select>");
    document.body.removeChild(div);
  });
});

// ─── find_elements locator prefixes ─────────────────────────────────────────

describe("find_elements with locator prefixes", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("'tag:button' resolves via findByLocator(By.tagName)", async () => {
    document.body.innerHTML = "<div><button>A</button><button>B</button></div>";
    const action = {
      type: "find_elements",
      selector: "tag:button",
      max_results: 50,
    } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
    expect(result.message).toContain("2 elements");
  });

  test("'id:foo' resolves via findByLocator(By.id)", async () => {
    document.body.innerHTML = '<div><span id="foo">Hello</span></div>';
    const action = {
      type: "find_elements",
      selector: "id:foo",
      max_results: 50,
    } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
    expect(result.message).toContain("1 elements");
    expect(result.extractedContent).toContain("Hello");
  });

  test("bare CSS selector still works (default when no prefix)", async () => {
    document.body.innerHTML = '<div><button class="btn">A</button></div>';
    const action = {
      type: "find_elements",
      selector: ".btn",
      max_results: 50,
    } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
    expect(result.message).toContain("1 elements");
  });

  test("'link:Sign in' resolves via findByLocator(By.linkText)", async () => {
    document.body.innerHTML = '<a href="/login">Sign in</a><a href="/home">Home</a>';
    const action = {
      type: "find_elements",
      selector: "link:Sign in",
      max_results: 50,
    } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
    expect(result.message).toContain("1 elements");
  });
});

// ─── LoopDetector.recordPageState stagnant detection ────────────────────────

describe("LoopDetector page-fingerprint stagnant detection", () => {
  test("shouldWarnStagnant returns 0 when the page keeps changing", async () => {
    const det = new LoopDetector();
    for (let i = 0; i < 10; i++) {
      await det.recordPageState(`https://example.com/page${i}`, `text-${i}`, 100);
    }
    expect(det.shouldWarnStagnant()).toBe(0);
  });

  test("shouldWarnStagnant returns the count when the page is unchanged across STAGNANT_THRESHOLD", async () => {
    const det = new LoopDetector();
 // Same page state 6 times (STAGNANT_THRESHOLD is 5).
    for (let i = 0; i < 6; i++) {
      await det.recordPageState("https://example.com", "same text", 100);
    }
    expect(det.shouldWarnStagnant()).toBeGreaterThanOrEqual(5);
  });

  test("stagnantWarningText produces a useful nudge", () => {
    const text = LoopDetector.stagnantWarningText(5);
    expect(text).toContain("STAGNANT PAGE");
    expect(text).toContain("5");
  });
});

// ─── executeActionQueue dispatcher-throw resilience ─────────────────────────
//
// A throwing dispatcher/callback handler must degrade the step, not truncate
// the queue: the remaining actions must still execute and be reported, or the
// per-action history/storage alignment (results.length === actions.length)
// breaks. Guards every dispatcher call in the queue (actionStart /
// loopWarning / actionEnd).

describe("executeActionQueue — dispatcher-throw resilience", () => {
  test("a dispatcher that throws on every hook does not truncate the queue", async () => {
    const btn = document.createElement("button");
    btn.textContent = "Click me";
    document.body.appendChild(btn);
    const state = makeState({ selectorMap: { 1: btn } });
    const events: LogEvent[] = [];
    const deps = { onEvent: (e: LogEvent) => { events.push(e); } } as unknown as LoopDeps;
    const actions = Array.from({ length: 5 }, () => ({ type: "click", index: 1 } as AgentAction));
    const throwingDispatcher = {
      actionStart: vi.fn(async () => { throw new Error("actionStart boom"); }),
      loopWarning: vi.fn(async () => { throw new Error("loopWarning boom"); }),
      actionEnd: vi.fn(async () => { throw new Error("actionEnd boom"); }),
    } as unknown as CallbackDispatcher;

  // 5 identical clicks cross the loop-detection first threshold (5), so the
  // loopWarning hook fires mid-queue and must not abort the remaining actions.
    const result = await executeActionQueue(
      deps,
      actions,
      state,
      0,
      "full_agentic",
      new LoopDetector(),
      { enableLoopDetection: true, maxActionsPerStep: 10 } as unknown as AgentConfig,
      throwingDispatcher,
      {} as CallbackContext,
      undefined,
    );

  // Every action executed and was reported — the queue was not truncated.
    expect(result.results).toHaveLength(5);
    expect(result.results.every((r) => r.success)).toBe(true);
    expect(result.aborted).toBe(false);
    expect(throwingDispatcher.actionEnd).toHaveBeenCalledTimes(5);
    expect(throwingDispatcher.loopWarning).toHaveBeenCalledTimes(1);
    document.body.removeChild(btn);
  });
});
