/**
 * Snapshot windowing tests — char-capped serialization with offset paging.
 * Covers the pure `windowSnapshot` helper in
 * page-state.ts: truncation boundary, marker text, offset resume, clamping.
 */

import { describe, test, expect } from "vitest";
import {
  windowSnapshot,
  MAX_SNAPSHOT_CHARS,
  SNAPSHOT_TAIL_CHARS,
} from "../src/lib/agent/dom/extraction/page-state";

const CONTENT_BUDGET = MAX_SNAPSHOT_CHARS - SNAPSHOT_TAIL_CHARS - 200;

describe("windowSnapshot", () => {
  test("returns the text unchanged when it fits under the cap", () => {
    const yaml = "a".repeat(500);
    const out = windowSnapshot(yaml);
    expect(out.text).toBe(yaml);
    expect(out.truncated).toBe(false);
    expect(out.totalChars).toBe(500);
    expect(out.offset).toBe(0);
    expect(out.hasMore).toBe(false);
    expect(out.nextOffset).toBe(null);
  });

  test("treats an empty snapshot as not truncated", () => {
    const out = windowSnapshot("");
    expect(out.text).toBe("");
    expect(out.truncated).toBe(false);
    expect(out.totalChars).toBe(0);
    expect(out.nextOffset).toBe(null);
  });

  test("truncates at exactly the cap boundary", () => {
    const yaml = "a".repeat(MAX_SNAPSHOT_CHARS);
    const out = windowSnapshot(yaml);
    expect(out.truncated).toBe(false);
    expect(out.text).toBe(yaml);
  });

  test("windows a large snapshot: marker + tail + head chunk", () => {
    const body = "x".repeat(MAX_SNAPSHOT_CHARS + 10_000);
    const out = windowSnapshot(body);
    expect(out.truncated).toBe(true);
    expect(out.totalChars).toBe(body.length);
    expect(out.offset).toBe(0);
    expect(out.hasMore).toBe(true);
    expect(out.nextOffset).toBe(CONTENT_BUDGET);
    // The marker sits at the head (it must survive the message layer's 60k
    // re-cap), then the preserved tail (same reason — a trailing tail would
    // fall outside the visible budget), then the chunk.
    expect(out.text.startsWith("[... truncated at char")).toBe(true);
    expect(out.text).toContain(body.slice(-SNAPSHOT_TAIL_CHARS));
    expect(out.text).toContain(body.slice(0, CONTENT_BUDGET));
    expect(out.text.indexOf(body.slice(-SNAPSHOT_TAIL_CHARS))).toBeLessThan(
      out.text.indexOf(body.slice(0, CONTENT_BUDGET)),
    );
  });

  test("marker names the page_next action and the resume offset", () => {
    const body = "y".repeat(MAX_SNAPSHOT_CHARS + 10_000);
    const out = windowSnapshot(body);
    expect(out.text).toContain("Call page_next with offset=");
    expect(out.text).toContain(`offset=${CONTENT_BUDGET}`);
  });

  test("offset resume returns the next chunk", () => {
    const body = "z".repeat(MAX_SNAPSHOT_CHARS * 2 + 10_000);
    const first = windowSnapshot(body, 0);
    expect(first.hasMore).toBe(true);
    const second = windowSnapshot(body, first.nextOffset!);
    expect(second.offset).toBe(first.nextOffset!);
    expect(second.text).toContain(body.slice(first.nextOffset!, first.nextOffset! + CONTENT_BUDGET));
    expect(second.text).toContain("Call page_next with offset=");
    if (second.hasMore) {
      const third = windowSnapshot(body, second.nextOffset!);
      expect(third.offset).toBe(second.nextOffset!);
    }
  });

  test("clamps an out-of-range offset to the last readable window", () => {
    const body = "w".repeat(MAX_SNAPSHOT_CHARS + 10_000);
    const out = windowSnapshot(body, Number.MAX_SAFE_INTEGER);
    expect(out.offset).toBe(body.length - SNAPSHOT_TAIL_CHARS);
    expect(out.hasMore).toBe(false);
  });

  test("the final window has no more pages", () => {
    const body = "v".repeat(MAX_SNAPSHOT_CHARS + 10_000);
    // Page far enough that the tail starts before the next budget boundary.
    const last = windowSnapshot(body, body.length - SNAPSHOT_TAIL_CHARS - 1);
    expect(last.hasMore).toBe(false);
    expect(last.nextOffset).toBe(null);
  });
});
