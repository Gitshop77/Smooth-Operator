/**
 * Regression coverage for the deterministic grading gates that fail CLOSED to
 * avoid a silent false PASS:
 *
 *  1. `EvaluatorComb` returns score 0 when a configured kind has no matching
 *     input while some input was supplied (index.ts fail-closed branch).
 *  2. `HTMLContentEvaluator` fails closed on an empty target list.
 *  3. `HTMLContentEvaluator` fails closed on an extraction warning when
 *     `failOpenOnExtractionWarning` is unset.
 *  4. `StringEvaluator` fails closed on an empty / whitespace-only regex ref
 *     (which would otherwise compile to `new RegExp("")` and match anything).
 *
 * A refactor that reopened any of these holes would score a task PASS with no
 * real evidence; these assertions pin the blocked (score 0) outcome.
 */

import { describe, test, expect, vi } from "vitest";
import {
  EvaluatorComb,
  HTMLContentEvaluator,
  StringEvaluator,
} from "../src/lib/agent/evaluators";

describe("evaluator fail-closed grading gates", () => {
  test("EvaluatorComb: configured kind with no matching input fails closed (score 0)", async () => {
    const comb = new EvaluatorComb(["url_match"]);
    const res = await comb.evaluate({
      string: { prediction: "hello", referenceAnswers: [{ type: "exact_match", ref: "hello" }] },
    });
    expect(res.score).toBe(0);
  });

  test("HTMLContentEvaluator: empty target list fails closed (score 0)", async () => {
    const res = await new HTMLContentEvaluator().evaluate({
      pageHtml: "<div>anything</div>",
      targets: [],
    });
    expect(res.score).toBe(0);
  });

  test("HTMLContentEvaluator: extraction warning fails closed when failOpen unset (score 0)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await new HTMLContentEvaluator().evaluate({
      pageHtml: "<div>x</div>",
      resolveLocator: () => {
        throw new Error("locator boom");
      },
      targets: [{ locator: "#missing", required_contents: { exact_match: "" } }],
    });
    expect(res.score).toBe(0);
    vi.restoreAllMocks();
  });

  test("StringEvaluator: empty regex ref fails closed (score 0)", () => {
    const res = new StringEvaluator().evaluate({
      prediction: "whatever",
      referenceAnswers: [{ type: "regex", ref: "" }],
    });
    expect(res.score).toBe(0);
  });

  test("StringEvaluator: whitespace-only regex ref fails closed (score 0)", () => {
    const res = new StringEvaluator().evaluate({
      prediction: "whatever",
      referenceAnswers: [{ type: "regex", ref: "   " }],
    });
    expect(res.score).toBe(0);
  });
});
