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
import { sanitizeForLog } from "../src/lib/agent/tools/constants";

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
