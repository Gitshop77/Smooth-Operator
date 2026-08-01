/**
 * Tests for the `capText` truncation helper in llm-direct-utils.ts. The helper is the
 * single source of truth for the elementsText / axTree caps used on every
 * navigator step, so its limit + marker behavior is pinned here.
 */

import { describe, test, expect } from "vitest";
import { capText } from "../src/extension/llm-direct-utils";

describe("capText", () => {
  test("undefined -> empty string (no crash on missing field)", () => {
    expect(capText(undefined, 100)).toBe("");
  });

  test("under-limit text passes through unchanged", () => {
    expect(capText("hello world", 100)).toBe("hello world");
  });

  test("over-limit text is truncated and gets the marker", () => {
    const out = capText("abcdefghij", 5);
    expect(out.startsWith("abcde")).toBe(true);
    expect(out).toContain("[... truncated at 5 chars ...]");
    expect(out.length).toBeGreaterThan(5);
  });

  test("exact: long string is the prefix + marker, no overflow", () => {
    expect(capText("a".repeat(200), 100)).toBe(
      "a".repeat(100) + "\n[... truncated at 100 chars ...]",
    );
  });
});
