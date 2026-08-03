/**
 * Deterministic-evaluator behavior tests for the grading gates that must fail
 * CLOSED:
 *
 *  - `StringEvaluator.must_include` with an empty / whitespace / `|OR|`-only
 *    ref asserts nothing — it must score 0, never a silent no-evidence PASS.
 *  - A `StringEvaluator` regex ref that is unsafe (nested quantifier,
 *    ambiguous alternation, or over-length) must score 0 with a reason —
 *    never a literal-substring fallback that can PASS.
 *  - An `HTMLContentEvaluator` target with an empty `required_contents`
 *    asserts nothing — it must score 0.
 *  - `EvaluatorComb` with no input at all (even on the legacy `kinds=[]`
 *    path) must fail closed; an input whose kind is not in the configured
 *    kinds is ignored with a warning.
 *  - `evaluateUrl` path-boundary / query-param / `|OR|` branches.
 */

import { describe, test, expect, vi, afterEach } from "vitest";
import { StringEvaluator } from "../src/lib/agent/evaluators/string-evaluator";
import { HTMLContentEvaluator } from "../src/lib/agent/evaluators/html-content-evaluator";
import { EvaluatorComb } from "../src/lib/agent/evaluators";
import { evaluateUrl } from "../src/lib/agent/evaluators/url-evaluator";

describe("StringEvaluator — must_include fail-closed on empty refs", () => {
  const evalString = (ref: string, tokenize = false) =>
    new StringEvaluator().evaluate({
      prediction: "anything at all",
      referenceAnswers: [{ type: "must_include", ref }],
      tokenize,
    });

  test("empty ref scores 0 with a reason", () => {
    const res = evalString("");
    expect(res.score).toBe(0);
    expect(res.reason.length).toBeGreaterThan(0);
  });

  test("whitespace-only ref scores 0", () => {
    expect(evalString("   ").score).toBe(0);
  });

  test("|OR|-only ref scores 0", () => {
    expect(evalString(" |OR| ").score).toBe(0);
    expect(evalString("|OR|").score).toBe(0);
  });

  test("empty ref with tokenize=true scores 0", () => {
    expect(evalString("", true).score).toBe(0);
  });

  test("a real alternative still passes", () => {
    expect(evalString("anything").score).toBe(1);
  });

  test("empty must_include ref is not rescued by a passing sibling entry", () => {
    const res = new StringEvaluator().evaluate({
      prediction: "anything",
      referenceAnswers: [
        { type: "must_include", ref: "anything" },
        { type: "must_include", ref: "" },
      ],
    });
    expect(res.score).toBe(0);
  });
});

describe("StringEvaluator — unsafe regex refs fail closed", () => {
  test("nested-quantifier pattern scores 0 even when the prediction contains the literal text", () => {
    const res = new StringEvaluator().evaluate({
      prediction: "the pattern (a+)+ appears here",
      referenceAnswers: [{ type: "regex", ref: "(a+)+" }],
    });
    expect(res.score).toBe(0);
    expect(res.reason.length).toBeGreaterThan(0);
  });

  test("ambiguous-alternation pattern scores 0 instead of executing", () => {
    const res = new StringEvaluator().evaluate({
      prediction: "contains (a|aa)+ text",
      referenceAnswers: [{ type: "regex", ref: "(a|aa)+" }],
    });
    expect(res.score).toBe(0);
  });

  test("over-length pattern scores 0", () => {
    const res = new StringEvaluator().evaluate({
      prediction: "anything",
      referenceAnswers: [{ type: "regex", ref: "a".repeat(501) }],
    });
    expect(res.score).toBe(0);
  });

  test("a valid matching regex still passes", () => {
    const res = new StringEvaluator().evaluate({
      prediction: "hello world",
      referenceAnswers: [{ type: "regex", ref: "^hello" }],
    });
    expect(res.score).toBe(1);
  });
});

describe("HTMLContentEvaluator — target asserting nothing fails closed", () => {
  test("required_contents {} scores 0 with a reason", async () => {
    const res = await new HTMLContentEvaluator().evaluate({
      pageHtml: "<div>hi</div>",
      targets: [{ required_contents: {} }],
    });
    expect(res.score).toBe(0);
    expect(res.reason.length).toBeGreaterThan(0);
  });

  test("a target with a real requirement still passes", async () => {
    const res = await new HTMLContentEvaluator().evaluate({
      pageHtml: "<div>expected text</div>",
      targets: [{ required_contents: { must_include: ["expected text"] } }],
    });
    expect(res.score).toBe(1);
  });
});

describe("EvaluatorComb — no input fails closed regardless of kinds", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("legacy kinds=[] with no input scores 0 (not a neutral pass)", async () => {
    const res = await new EvaluatorComb([]).evaluate({});
    expect(res.score).toBe(0);
    expect(res.results).toHaveLength(0);
    expect(res.reasons.length).toBeGreaterThan(0);
  });

  test("legacy kinds=[] with an input still runs the present evaluator", async () => {
    const res = await new EvaluatorComb([]).evaluate({
      string: {
        prediction: "answer: 42",
        referenceAnswers: [{ type: "must_include", ref: "42" }],
      },
    });
    expect(res.score).toBe(1);
  });

  test("a supplied input kind absent from the configured kinds warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const comb = new EvaluatorComb(["string_match"]);
    const res = await comb.evaluate({
      string: {
        prediction: "answer: 42",
        referenceAnswers: [{ type: "must_include", ref: "42" }],
      },
      url: { prediction: "https://example.com/x", referenceUrl: "https://example.com/x" },
    });
    expect(res.score).toBe(1); // the configured evaluator still ran
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("url_match"));
  });
});

describe("evaluateUrl — path boundary, query params, |OR| branches", () => {
  test("path boundary: /foo does not match /foobar", () => {
    const res = evaluateUrl({
      prediction: "https://example.com/foobar",
      referenceUrl: "https://example.com/foo",
    });
    expect(res.score).toBe(0);
  });

  test("path boundary: /foo matches /foo/bar, /foo?x=1, /foo#frag", () => {
    for (const pred of [
      "https://example.com/foo/bar",
      "https://example.com/foo?x=1",
      "https://example.com/foo#frag",
      "https://example.com/foo",
    ]) {
      const res = evaluateUrl({ prediction: pred, referenceUrl: "https://example.com/foo" });
      expect(res.score).toBe(1);
    }
  });

  test("query params: reference key/value must be satisfied in the prediction", () => {
    const ref = "https://example.com/search?q=apple";
    expect(evaluateUrl({ prediction: "https://example.com/search?q=apple&page=2", referenceUrl: ref }).score).toBe(1);
    expect(evaluateUrl({ prediction: "https://example.com/search?q=orange", referenceUrl: ref }).score).toBe(0);
    expect(evaluateUrl({ prediction: "https://example.com/search?page=2", referenceUrl: ref }).score).toBe(0);
  });

  test("query params: prediction may carry extra params", () => {
    const ref = "https://example.com/x?q=1";
    expect(evaluateUrl({ prediction: "https://example.com/x?q=1&extra=2", referenceUrl: ref }).score).toBe(1);
  });

  test("|OR| alternatives: any one matching reference passes", () => {
    const ref = "https://a.example.com/first |OR| https://b.example.com/second";
    expect(evaluateUrl({ prediction: "https://b.example.com/second", referenceUrl: ref }).score).toBe(1);
    expect(evaluateUrl({ prediction: "https://c.example.com/third", referenceUrl: ref }).score).toBe(0);
  });

  test("empty referenceUrl scores 0 (nothing to match)", () => {
    expect(evaluateUrl({ prediction: "https://example.com/x", referenceUrl: "" }).score).toBe(0);
  });

  test("reference host may be a subdomain of the prediction host", () => {
    expect(evaluateUrl({ prediction: "https://shop.example.com/items", referenceUrl: "https://example.com/items" }).score).toBe(1);
  });
});
