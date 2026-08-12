/**
 * Retry classification tests — `withLLMRetry` must classify transient
 * errors from the numeric HTTP status when the transport attaches one;
 * the status wins over any text in the error body, and a plain error
 * carrying no status is only retried when its message matches a known
 * transient signal (429 / 5xx / network) — arbitrary messages never
 * trigger a retry storm. Covers:
 * - a 429 with a numeric status IS retried
 * - a 4xx (non-429) with a numeric status is NOT retried
 * - a 5xx with a numeric status IS retried
 * - a plain Error whose message matches a transient signal IS retried
 * - a plain Error with no transient signal is NOT retried (single attempt)
 * - body text mentioning 429/5xx never overrides the numeric status
 * - a numeric status outside 4xx/5xx blocks message-based network retry
 * - a Retry-After value attached to the error is honored (retry still fires)
 * - Retry-After above the ceiling is capped, abort is never retried, and
 *   the cumulative-delay budget stops the loop
 */

import { describe, test, expect, vi } from "vitest";
import { withLLMRetry } from "../src/lib/agent/llm/retry";
import { MAX_RETRY_AFTER_MS } from "../src/lib/agent/llm/constants";

type StatusError = Error & { status?: number; retryAfter?: number };

/** Build an Error carrying a numeric `status` (as the transport attaches). */
function statusError(status: number, message = `LLM API ${status}: err`, retryAfter?: number): StatusError {
  const e = new Error(message) as StatusError;
  e.status = status;
  if (typeof retryAfter === "number") {
    e.retryAfter = retryAfter;
  }
  return e;
}

/** Run `run` with fake timers installed, guaranteeing real timers are restored. */
async function withFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
}

describe("withLLMRetry — numeric-status classification", () => {
  test("a 429 with a numeric status is retried until it succeeds", async () => {
    await withFakeTimers(async () => {
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
    });
  });

  test("a 4xx without 429 is NOT retried (single attempt)", async () => {
    const fn = vi.fn(async () => {
      throw statusError(400);
    });
    await expect(withLLMRetry(fn)).rejects.toThrow(/400/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("an Error without a numeric status is NOT retried (single attempt)", async () => {
    // Regression guard against a retry storm: only 429/5xx/network errors are
    // retried (classified by the numeric status). A plain Error carrying no
    // status must be attempted exactly once and then rejected.
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(withLLMRetry(fn)).rejects.toThrow(/boom/);
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
    await withFakeTimers(async () => {
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
    });
  });

  test("a Retry-After value on the error is honored (delay is applied)", async () => {
    await withFakeTimers(async () => {
 // Pin jitter to its max (1.0) so the scheduled retry delay equals the
 // Retry-After value exactly under full jitter (delay = floor(1.0 × cap)),
 // making the delay observable and deterministic.
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1.0);
      try {
        let calls = 0;
        const fn = vi.fn(async () => {
          calls++;
          if (calls < 2) throw statusError(429, "LLM API 429: rate", 1000);
          return "ok";
        });
        const p = withLLMRetry(fn);
 // The first attempt fails and schedules the retry after exactly 1000ms
 // (Retry-After honored, jitter = 0). Advancing 999ms must NOT have
 // retried yet — proving the real delay is applied rather than skipped.
        await vi.advanceTimersByTimeAsync(999);
        expect(fn).toHaveBeenCalledTimes(1);
 // Advancing the final 1ms fires the scheduled retry.
        await vi.advanceTimersByTimeAsync(1);
        const result = await p;
        expect(result).toBe("ok");
        expect(fn).toHaveBeenCalledTimes(2);
      } finally {
        randomSpy.mockRestore();
      }
    });
  });
});

describe("withLLMRetry — message-based fallback classification (no numeric status)", () => {
  // Transports that do not attach a numeric `status` rely on the message
  // fallback: "429"/"Too Many Requests", a 5xx pattern, or fetch/network
  // wording must still be retried (positive tests for this branch).
  const transientMessages = [
    "TypeError: Failed to fetch",
    "fetch failed",
    "ECONNRESET: socket hang up",
    "timeout of 10000ms exceeded",
    "LLM API 429: Too Many Requests",
    "upstream returned 502 Bad Gateway",
  ];

  for (const message of transientMessages) {
    test(`plain Error(${JSON.stringify(message)}) is retried and succeeds on the second attempt`, async () => {
      await withFakeTimers(async () => {
        let calls = 0;
        const fn = vi.fn(async () => {
          calls++;
          if (calls < 2) throw new Error(message);
          return "ok";
        });
        const p = withLLMRetry(fn);
        await vi.runAllTimersAsync();
        expect(await p).toBe("ok");
        expect(fn).toHaveBeenCalledTimes(2);
      });
    });
  }

  test("a numeric status outside 4xx/5xx blocks message-based network retry", async () => {
    // `status: 200` (or any non-4xx/5xx number) means the transport
    // HAD a status and chose not to classify it as transient — the message
    // fallback must not second-guess it, or a 200 with "network" in the body
    // would be retried 3×.
    const fn = vi.fn(async () => {
      throw statusError(200, "status 200 but body mentions fetch failed");
    });
    await expect(withLLMRetry(fn)).rejects.toThrow(/status 200/);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("withLLMRetry — abort handling and retry budgets", () => {
  test("a pre-aborted signal throws AbortError without attempting fn", async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => "ok");
    await expect(withLLMRetry(fn, controller.signal)).rejects.toThrow(/aborted/i);
    expect(fn).not.toHaveBeenCalled();
  });

  test("aborting during the backoff sleep aborts the retry (no further attempts)", async () => {
    await withFakeTimers(async () => {
      const controller = new AbortController();
      // Pin jitter to its max so the first backoff is the full 1500ms window
      // (attempt 0: base 1500 → cap 1500) and stays mid-flight at +100ms.
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1.0);
      try {
        const fn = vi.fn(async () => {
          throw statusError(503);
        });
        const p = withLLMRetry(fn, controller.signal);
        // Attach the rejection handler before the timers fire so the
        // mid-backoff abort is not observed as an unhandled rejection.
        const rejection = expect(p).rejects.toThrow(/aborted/i);
        // First attempt fails; the 1500ms backoff is mid-flight…
        await vi.advanceTimersByTimeAsync(100);
        controller.abort();
        // …the next 100ms sleep chunk observes the abort and throws.
        await vi.advanceTimersByTimeAsync(100);
        await rejection;
        expect(fn).toHaveBeenCalledTimes(1);
      } finally {
        randomSpy.mockRestore();
      }
    });
  });

  test("a Retry-After value above MAX_RETRY_AFTER_MS is capped to the ceiling", async () => {
    await withFakeTimers(async () => {
      // Pin jitter to its max so the capped delay equals the 30s ceiling
      // exactly (floor(1.0 × 30000)) — observable and deterministic.
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1.0);
      try {
        let calls = 0;
        const fn = vi.fn(async () => {
          calls++;
          if (calls < 2) throw statusError(429, "LLM API 429: rate", 120_000);
          return "ok";
        });
        const p = withLLMRetry(fn);
        // Delay must be the 30s ceiling, not the hostile 120s header.
        await vi.advanceTimersByTimeAsync(MAX_RETRY_AFTER_MS - 1);
        expect(fn).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await p).toBe("ok");
        expect(fn).toHaveBeenCalledTimes(2);
      } finally {
        randomSpy.mockRestore();
      }
    });
  });

  test("the cumulative-delay budget stops the retry loop before MAX_RETRIES", async () => {
    await withFakeTimers(async () => {
      // Pin jitter to its max so every retry sleeps the full 30s ceiling —
      // two retries exhaust the 60s cumulative budget deterministically.
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1.0);
      try {
        const fn = vi.fn(async () => {
          throw statusError(429, "LLM API 429: rate", 60_000);
        });
        const p = withLLMRetry(fn);
        // Attach the rejection handler first so the budget-exhaustion throw
        // is never observed as an unhandled rejection.
        const rejection = expect(p).rejects.toThrow(/429/);
        // Each retry sleeps the capped 30s; after two retries the cumulative
        // delay hits the 60s budget and the loop throws without a third retry.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(fn).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(30_000);
        await rejection;
        expect(fn).toHaveBeenCalledTimes(2);
      } finally {
        randomSpy.mockRestore();
      }
    });
  });
});
