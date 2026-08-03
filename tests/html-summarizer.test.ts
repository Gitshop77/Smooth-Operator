/**
 * html-summarizer tests — keyword extraction, intent detection, element
 * scoring, the 30/50 caps, the <5 fallback trigger, and escape/truncation
 * of attribute and text payloads.
 */

import { describe, test, expect } from "vitest";
import type { ExtractedElement } from "../src/lib/agent/types";
import {
  summarizeDom,
  renderElementsText,
  DEFAULT_MIN_HTML_LENGTH,
} from "../src/lib/agent/html-summarizer";
import {
  extractKeywords,
  escapeAttr,
  stripNewlines,
} from "../src/lib/agent/html-summarizer-utils";

/** Minimal element fixture. */
function el(index: number, tag: string, text = "", attributes: Record<string, string> = {}): ExtractedElement {
  return { index, tag, text, attributes, hash: `h${index}`, rect: { x: 0, y: 0, width: 10, height: 10 } };
}

describe("extractKeywords", () => {
  test("tokenizes, lowercases, drops stop-words and 1-char tokens", () => {
    const kws = extractKeywords("Fill THE login form!");
    expect([...kws].sort()).toEqual(["fill", "form", "login"]);
  });

  test("splits on punctuation", () => {
    const kws = extractKeywords("price,quantity;discount");
    expect([...kws].sort()).toEqual(["discount", "price", "quantity"]);
  });

  test("returns an empty set for empty / stop-word-only input", () => {
    expect(extractKeywords("")).toEqual(new Set());
    expect(extractKeywords("the and or")).toEqual(new Set());
  });

  test("drops 1-char tokens", () => {
    expect([...extractKeywords("a b c xyz")]).toEqual(["xyz"]);
  });
});

describe("summarizeDom — intent detection", () => {
  /** Five matching elements so the summarizer doesn't fall back (keeps intentStr in the summary). */
  const five = (tag: string, text: string): ExtractedElement[] =>
    Array.from({ length: 5 }, (_, i) => el(i + 1, tag, text));

  test("detects form intent from the task", () => {
    const { summary } = summarizeDom({ task: "fill the login form", currentGoal: "", elements: five("input", "login") });
    expect(summary).toContain("form intent");
  });

  test("detects nav intent", () => {
    const { summary } = summarizeDom({ task: "go to the homepage", currentGoal: "", elements: five("a", "homepage") });
    expect(summary).toContain("nav intent");
  });

  test("detects search intent", () => {
    const { summary } = summarizeDom({ task: "search for flights", currentGoal: "", elements: five("input", "flights") });
    expect(summary).toContain("search intent");
  });

  test("detects read intent", () => {
    const { summary } = summarizeDom({ task: "read the article", currentGoal: "", elements: five("p", "article") });
    expect(summary).toContain("read intent");
  });
});

describe("summarizeDom — scoring", () => {
  test("keyword text match outranks attribute match, and both beat tag-only elements", () => {
    const elements = [
      el(1, "button", "plain"),
      el(2, "button", "needle"),
      el(3, "button", "plain", { placeholder: "needle" }),
      el(4, "button", "needle"),
      el(5, "button", "needle"),
      el(6, "button", "plain", { placeholder: "needle" }),
    ];
    // Six elements: 3 text matches (score 3) + 2 attr matches (score 2) score
    // non-zero — above the <5 fallback threshold. With cap 2, only the two
    // highest-scored (text matches, lowest indices) survive.
    const { keptIndices } = summarizeDom({
      task: "needle",
      currentGoal: "",
      elements,
      maxElements: 2,
    });
    expect(keptIndices).toEqual([2, 4]);
  });

  test("attribute matches are preferred over tag-only elements when not falling back", () => {
    const elements = [
      el(1, "button", "needle"),
      el(2, "button", "needle"),
      el(3, "button", "needle"),
      el(4, "button", "needle"),
      el(5, "button", "needle"),
      el(6, "button", "plain", { placeholder: "needle" }),
      el(7, "button", "plain", { placeholder: "needle" }),
      el(8, "button", "plain", { placeholder: "needle" }),
      el(9, "button", "plain", { placeholder: "needle" }),
      el(10, "button", "plain"),
    ];
    const { keptIndices } = summarizeDom({ task: "needle", currentGoal: "", elements });
    // All 9 non-zero-scoring elements fit under the default cap; the tag-only
    // element (index 10) is filtered out.
    expect(keptIndices).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("kept elements are re-sorted to DOM order", () => {
    const elements = [
      el(10, "a", "match"),
      el(2, "button", "match"),
      el(5, "button", "match"),
    ];
    const { keptIndices } = summarizeDom({ task: "match", currentGoal: "", elements });
    expect(keptIndices).toEqual([2, 5, 10]);
  });
});

describe("summarizeDom — caps and fallback", () => {
  const many = (n: number): ExtractedElement[] =>
    Array.from({ length: n }, (_, i) => el(i + 1, "button", `keyword ${i}`));

  test("default cap keeps at most 30 elements when enough score non-zero", () => {
    const { keptElements, fellBack } = summarizeDom({ task: "keyword", currentGoal: "", elements: many(40) });
    expect(fellBack).toBe(false);
    expect(keptElements.length).toBe(30);
  });

  test("fewer than 5 non-zero scores triggers the fallback (keeps all when under the cap)", () => {
    const elements = [
      el(1, "button", "needle"),
      el(2, "button", "needle"),
      el(3, "button", "needle"),
      el(4, "a", "zzz"),
      el(5, "a", "zzz"),
      el(6, "a", "zzz"),
      el(7, "a", "zzz"),
      el(8, "a", "zzz"),
      el(9, "a", "zzz"),
      el(10, "a", "zzz"),
    ];
    const { keptElements, fellBack, keptIndices } = summarizeDom({ task: "needle", currentGoal: "", elements });
    expect(fellBack).toBe(true);
    // Fallback keeps everything when the page has fewer than the fallback cap.
    expect(keptElements.length).toBe(10);
    expect(keptIndices).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("fallback is capped at 50 even when the page is large", () => {
    const { keptElements, fellBack } = summarizeDom({ task: "needle", currentGoal: "", elements: many(60) });
    expect(fellBack).toBe(true);
    expect(keptElements.length).toBe(50);
  });

  test("exactly 5 non-zero scores does not trigger the fallback", () => {
    const elements = Array.from({ length: 5 }, (_, i) => el(i + 1, "button", `keyword ${i}`));
    const { fellBack } = summarizeDom({ task: "keyword", currentGoal: "", elements });
    expect(fellBack).toBe(false);
  });

  test("maxElements clamps to [1, 50] — negative values never drop from the end", () => {
    // 3 scored elements with maxElements=-5 would previously return an empty
    // set via slice(0, -5); the clamp must keep at least one element.
    const elements = [el(1, "button", "match"), el(2, "button", "match"), el(3, "button", "match")];
    const { keptIndices } = summarizeDom({ task: "match", currentGoal: "", elements, maxElements: -5 });
    expect(keptIndices.length).toBeGreaterThanOrEqual(1);
  });

  test("maxElements clamps to [1, 50] — huge values are capped", () => {
    const { keptElements } = summarizeDom({ task: "keyword", currentGoal: "", elements: many(60), maxElements: 5000 });
    expect(keptElements.length).toBeLessThanOrEqual(50);
  });

  test("maxElements respects a smaller requested cap when scores are non-zero", () => {
    const { keptElements } = summarizeDom({ task: "keyword", currentGoal: "", elements: many(40), maxElements: 10 });
    expect(keptElements.length).toBe(10);
  });

  test("non-finite maxElements falls back to the default cap", () => {
    const { keptElements } = summarizeDom({ task: "keyword", currentGoal: "", elements: many(40), maxElements: Number.NaN });
    expect(keptElements.length).toBe(30);
  });

  test("zero maxElements clamps to the minimum of 1", () => {
    const { keptElements } = summarizeDom({ task: "keyword", currentGoal: "", elements: many(40), maxElements: 0 });
    expect(keptElements.length).toBe(1);
  });
});

describe("summarizeDom — misc", () => {
  test("DEFAULT_MIN_HTML_LENGTH is exported for callers", () => {
    expect(DEFAULT_MIN_HTML_LENGTH).toBe(10_000);
  });
});

describe("renderElementsText", () => {
  test("renders [index]<tag attr=\"value\" />text per line", () => {
    const out = renderElementsText([el(3, "button", "Submit", { id: "btn" })]);
    expect(out).toBe("[3]<button id=\"btn\" /> Submit");
  });

  test("escapes attribute values and text", () => {
    const out = renderElementsText([
      el(1, "input", '"><script>alert(1)</script>', { placeholder: '"><img src=x onerror=alert(1)>' }),
    ]);
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&quot;");
  });

  test("collapses newlines in text", () => {
    const out = renderElementsText([el(1, "p", "line1\nline2\r\nline3")]);
    expect(out).toContain("line1 line2 line3");
  });

  test("truncates attribute and text payloads to 80 chars", () => {
    const long = "x".repeat(200);
    const out = renderElementsText([el(1, "input", long, { placeholder: long })]);
    // One attribute line + text: each payload capped at 80 chars.
    expect(out.length).toBeLessThan(200);
    expect(out).toContain("x".repeat(80));
  });

  test("empty element list renders an empty string", () => {
    expect(renderElementsText([])).toBe("");
  });
});

describe("escapeAttr / stripNewlines", () => {
  test("escapeAttr escapes & < > \"", () => {
    expect(escapeAttr('a&b<c>d"e')).toBe("a&amp;b&lt;c&gt;d&quot;e");
  });

  test("stripNewlines collapses CR/LF runs into a single space", () => {
    expect(stripNewlines("a\r\nb\n\nc\rd")).toBe("a b c d");
  });
});
