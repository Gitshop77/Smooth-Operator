/**
 * Tests for the memoized redaction layer (src/lib/agent/redaction-memo.ts).
 *
 * The redaction memo key is the input string PLUS the current secrets-set
 * version: on a static page the same strings are redacted/scan-flagged on
 * every step, so the memo turns that per-step cost into a Map lookup while
 * still re-running the moment the secret set changes.
 *
 * Fail-closed contract: ONLY successful results are cached. A throwing
 * redaction re-runs on the next call and degrades to the
 * `[REDACTED: redaction failed]` placeholder — never a stale success, never
 * the raw secret-bearing text.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

/**
 * Mock the secrets module so the memo's underlying redactor is a countable
 * double whose output reflects the current secrets version. `shouldThrow`
 * lets a test exercise the fail-closed path (a rejecting redaction).
 */
const h = vi.hoisted(() => {
  const state = { version: 1, shouldThrow: false };
  return {
    state,
    redactSecrets: vi.fn(async (text: string) => {
      if (state.shouldThrow) throw new Error("injected redaction failure");
      return `redacted-v${state.version}<${text}>`;
    }),
  };
});

vi.mock("../src/lib/agent/secrets", () => ({
  redactSecrets: h.redactSecrets,
  getSecretSetVersion: () => h.state.version,
}));

import {
  memoizedRedact,
  clearRedactionMemo,
  REDACTION_FAILED,
} from "../src/lib/agent/redaction-memo";

beforeEach(() => {
  clearRedactionMemo();
  h.redactSecrets.mockClear();
  h.state.shouldThrow = false;
});

describe("memoizedRedact caching contract", () => {
  test("two memoizedRedact calls with the same text invoke the underlying redactor once", async () => {
    const first = await memoizedRedact("same page text");
    const second = await memoizedRedact("same page text");

    expect(second).toBe(first);
    expect(h.redactSecrets).toHaveBeenCalledTimes(1);
  });

  test("a secrets-version bump forces re-redaction and picks up the new value", async () => {
    const before = await memoizedRedact("shared text");
    expect(before).toBe("redacted-v1<shared text>");

    h.state.version++; // e.g. a secret registered mid-run

    const after = await memoizedRedact("shared text");
    expect(after).toBe("redacted-v2<shared text>");
    expect(h.redactSecrets).toHaveBeenCalledTimes(2);
  });

  test("a throwing redaction is not cached — the second call throws again and returns the placeholder", async () => {
    h.state.shouldThrow = true;

    const first = await memoizedRedact("boom text");
    expect(first).toBe(REDACTION_FAILED);
    // The failure is NOT cached: the next call must re-run (and fail again)
    // rather than serving a stale success.
    const second = await memoizedRedact("boom text");
    expect(second).toBe(REDACTION_FAILED);
    expect(h.redactSecrets).toHaveBeenCalledTimes(2);
  });

  test("clearRedactionMemo drops cached results (underlying re-invoked)", async () => {
    await memoizedRedact("cleared text");
    clearRedactionMemo();
    await memoizedRedact("cleared text");

    expect(h.redactSecrets).toHaveBeenCalledTimes(2);
  });
});