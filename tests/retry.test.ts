/**
 * Retry classification tests (F-22) — `withLLMRetry` must classify transient
 * errors from the numeric HTTP status carried on the error, not by
 * string-matching the response body. Covers:
 *   - a 429 with a numeric status IS retried
 *   - a 4xx (non-429) with a numeric status is NOT retried
 *   - a Retry-After value attached to the error is honored (retry still fires)
 */

import { describe, test, expect, vi } from "vitest";
import { withLLMRetry } from "../src/lib/agent/llm/retry";

/** Build an Error carrying a numeric `status` (as the transport attaches). */
function statusError(status: number, message = `LLM API ${status}: err`, retryAfter?: number): Error {
  const e = new Error(message);
  (e as Error & { status?: number }).status = status;
  if (typeof retryAfter === "number") {
    (e as Error & { retryAfter?: number }).retryAfter = retryAfter;
  }
  return e;
}

describe("withLLMRetry — numeric-status classification (F-22)", () => {
  test("a 429 with a numeric status is retried until it succeeds", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fn = vi.fn(async () => {
        calls++;
        if (calls < 3) throw statusError(429);
        return "ok";
      });
      const p = withLLMRetry(fn);
      await vi.runAllTimersAsync();
      const result = await p;
      expect(result).toBe("ok");
      // 2 failures + 1 success = 3 calls.
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a 4xx without 429 is NOT retried (single attempt)", async () => {
    const fn = vi.fn(async () => {
      throw statusError(400);
    });
    await expect(withLLMRetry(fn)).rejects.toThrow(/400/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("a 4xx whose body text mentions a 5xx code is NOT retried (classified by numeric status, not body)", async () => {
    // Regression for the OLD substring classifier: a 400 whose error body
    // contains "500" (e.g. "upstream returned 500") would have been wrongly
    // retried because `/\b5\d\d\b/.test(msg)` matched. The numeric `status`
    // field must win, so this is non-retryable.
    const fn = vi.fn(async () => {
      throw statusError(400, "LLM API 400: upstream service returned 500 internal error");
    });
    await expect(withLLMRetry(fn)).rejects.toThrow(/400/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("a 4xx whose body text mentions 429 is NOT retried", async () => {
    // Same regression for the 429 substring: a 400 body mentioning a 429 rate
    // limit must NOT be retried — only an actual 429 status is retryable.
    const fn = vi.fn(async () => {
      throw statusError(400, "LLM API 400: nested 429 Too Many Requests from upstream");
    });
    await expect(withLLMRetry(fn)).rejects.toThrow(/400/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("a 5xx with a numeric status is retried", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fn = vi.fn(async () => {
        calls++;
        if (calls < 2) throw statusError(503);
        return "ok";
      });
      const p = withLLMRetry(fn);
      await vi.runAllTimersAsync();
      const result = await p;
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a Retry-After value on the error is honored (retry still fires)", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fn = vi.fn(async () => {
        calls++;
        if (calls < 2) throw statusError(429, "LLM API 429: rate", 1000);
        return "ok";
      });
      const p = withLLMRetry(fn);
      await vi.runAllTimersAsync();
      const result = await p;
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
