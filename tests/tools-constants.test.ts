/**
 * sanitizeForLog control-char handling + truncation.
 *
 * CONTROL_CHARS_RE deletes CR/LF/NBSP/soft-hyphen from page-derived
 * text (anti-log-forgery), but deletion MERGES words across a newline
 * ("a\nb" → "ab") and corrupts NBSP-formatted numbers ("1\u00A0234" → "1234").
 * Documented exception: replace with a single space — word/number separation
 * survives while no CR/LF can survive to forge a log line.
 *
 * `.slice(0, maxLen)` can split a UTF-16 surrogate pair, leaving a lone
 * surrogate in the truncated output. Truncation must be code-point-aware.
 */

import { describe, test, expect } from "vitest";
import {
  SEARCH_ENGINE_URLS,
  getSearchEngineUrl,
  sanitizeForLog,
  sleep,
} from "../src/lib/agent/tools/constants";
import { actionListForPrompt } from "../src/lib/agent/tools/schema-utils";

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (!(s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff)) return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      if (!(s.charCodeAt(i - 1) >= 0xd800 && s.charCodeAt(i - 1) <= 0xdbff)) return true;
    }
  }
  return false;
}

describe("sanitizeForLog control-char replacement", () => {
  test("words across a newline stay separated (replace, not delete)", () => {
    expect(sanitizeForLog("foo\nbar")).toBe("foo bar");
    expect(sanitizeForLog("foo\r\nbar")).toBe("foo bar");
  });

  test("NBSP-formatted numbers keep their grouping", () => {
    expect(sanitizeForLog("1\u00A0234")).toBe("1 234");
  });

  test("no CR/LF survives — log-forgery protection intact", () => {
    const out = sanitizeForLog("legit\nerror: injected line");
    expect(out.includes("\n")).toBe(false);
    expect(out.includes("\r")).toBe(false);
  });
});

describe("sanitizeForLog code-point-aware truncation", () => {
  test("truncating at a boundary inside an astral char never yields a lone surrogate", () => {
    // "😀" is a surrogate pair; a slice cut between the two halves leaves a
    // lone surrogate in the output.
    const s = "a".repeat(10) + "😀";
    const out = sanitizeForLog(s, 11);
    expect(out.length).toBeLessThanOrEqual(12); // pair kept or boundary shifted
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  test("truncation never yields a lone surrogate for a mix of BMP + astral text", () => {
    const s = "é😀中😀a😀b😀".repeat(50);
    for (const maxLen of [1, 2, 3, 5, 7, 11, 13, 100]) {
      expect(hasLoneSurrogate(sanitizeForLog(s, maxLen))).toBe(false);
    }
  });
});

describe("SEARCH_ENGINE_URLS / getSearchEngineUrl", () => {
  test("every engine maps to its query URL prefix (sync with the schema enum)", () => {
    for (const [engine, prefix] of Object.entries(SEARCH_ENGINE_URLS)) {
      expect(getSearchEngineUrl(engine)).toBe(prefix);
    }
  });

  test.each([
    ["google", "https://www.google.com/search?q="],
    ["duckduckgo", "https://duckduckgo.com/?q="],
    ["bing", "https://www.bing.com/search?q="],
    ["yahoo", "https://search.yahoo.com/search?p="],
    ["baidu", "https://www.baidu.com/s?wd="],
  ])("getSearchEngineUrl(%s) resolves to the expected prefix", (engine, prefix) => {
    expect(getSearchEngineUrl(engine)).toBe(prefix);
    // Every entry must be usable to build a query URL directly.
    expect(`${prefix}query+terms`).toMatch(/^https:\/\//);
  });

  test("unknown engine → null (never an `undefined?q=...` URL)", () => {
    expect(getSearchEngineUrl("askjeeves")).toBeNull();
    expect(getSearchEngineUrl("")).toBeNull();
  });

  test("the literal map keys and resolver agree for every registered engine", () => {
    const keys = Object.keys(SEARCH_ENGINE_URLS as Record<string, string>);
    expect(keys.length).toBeGreaterThanOrEqual(5);
    for (const key of keys) {
      expect(getSearchEngineUrl(key)).not.toBeNull();
    }
  });
});

describe("sleep abort support", () => {
  test("resolves after the duration when no signal is aborted", async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
  });

  test("rejects with an AbortError when the signal fires before the duration", async () => {
    const ac = new AbortController();
    const promise = sleep(10_000, ac.signal);
    ac.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  test("rejects immediately when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleep(10_000, ac.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("actionListForPrompt vision-mode gating", () => {
  test("detect_visual is listed only in adaptive vision mode", () => {
    const disabled = actionListForPrompt(5, "disabled");
    expect(disabled).not.toContain("detect_visual");
    const always = actionListForPrompt(5, "always");
    expect(always).not.toContain("detect_visual");
    const adaptive = actionListForPrompt(5, "adaptive");
    expect(adaptive).toContain("detect_visual");
  });

  test("the action-count header reflects maxActions", () => {
    expect(actionListForPrompt(8, "disabled")).toContain("1 to 8");
    expect(actionListForPrompt(1, "disabled")).toContain("1 to 1");
  });
});
