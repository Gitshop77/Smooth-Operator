/**
 * errors.ts — `classifyError` precedence + bounded-unknown-retry regression
 * tests.
 *
 * The agent loop's retry budget depends on subtle control flow: 5xx is checked
 * before rate_limit, a `fetch` TypeError is transient `network` while a
 * `JSON.parse` SyntaxError is a transient `parse` (retryable), a structured `status`
 * overrides substring guesses, and an `unknown` error is retried exactly once
 * (attempt 0) then becomes fatal (attempt >= 1). A regression here silently
 * over-retries fatal errors or fails-open transient ones, so these tests pin
 * the ordering.
 */
import { describe, test, expect, vi } from "vitest";
import { classifyError, classifyActionError, formatErrorSuffix } from "../src/lib/agent/errors";
import {
  withLLMRetry,
  classifyContextOverflow,
  isGatewayHtmlAuthError,
  isRetryableOpenAI404,
} from "../src/lib/agent/llm/retry";

describe("classifyError — network vs programmer_error", () => {
  test("fetch TypeError → network / retryable (not a code bug)", () => {
    const c = classifyError(new TypeError("Failed to fetch"));
    expect(c.category).toBe("network");
    expect(c.retryable).toBe(true);
    expect(c.fatal).toBe(false);
  });

  test("JSON.parse SyntaxError → transient parse / retryable (not fatal programmer_error)", () => {
    // An unparseable LLM response (a `JSON.parse` SyntaxError) is a transient
    // `parse` error that is retried with a nudge — NOT a fatal `programmer_error`.
    const c = classifyError(new SyntaxError("Unexpected token < in JSON at position 0"));
    expect(c.category).toBe("parse");
    expect(c.fatal).toBe(false);
    expect(c.retryable).toBe(true);
  });
});

describe("classifyError — precedence ordering", () => {
  test("5xx mentioning 'rate limit' stays server_error (5xx before rate_limit)", () => {
    const c = classifyError(new Error("503 service unavailable: rate limit exceeded"));
    expect(c.category).toBe("server_error");
    expect(c.retryable).toBe(true);
  });

  test("bare '429 too many requests' → rate_limit / retryable", () => {
    const c = classifyError(new Error("429 too many requests"));
    expect(c.category).toBe("rate_limit");
    expect(c.retryable).toBe(true);
  });

  test("structured status 400 with 'validation' body → bad_request / fatal (not parse)", () => {
    const err = Object.assign(new Error("validation failed"), { status: 400 });
    const c = classifyError(err);
    expect(c.category).toBe("bad_request");
    expect(c.fatal).toBe(true);
    expect(c.retryable).toBe(false);
  });

  test("structured status 429 → rate_limit / retryable", () => {
    const err = Object.assign(new Error("slow down"), { status: 429 });
    expect(classifyError(err).category).toBe("rate_limit");
  });

  test("structured status 503 → server_error / retryable", () => {
    const err = Object.assign(new Error("provider unavailable"), { status: 503 });
    expect(classifyError(err).category).toBe("server_error");
  });
});

describe("classifyError — bounded unknown retry", () => {
  test("unknown error retried once (attempt 0) then fatal (attempt >= 1)", () => {
    const err = new Error("something totally unfamiliar");
    const first = classifyError(err, 0);
    expect(first.category).toBe("unknown");
    expect(first.retryable).toBe(true);
    expect(first.fatal).toBe(false);

    const repeat = classifyError(err, 1);
    expect(repeat.category).toBe("unknown");
    expect(repeat.retryable).toBe(false);
    expect(repeat.fatal).toBe(true);
  });
});

describe("classifyError — abort wording is not user authority", () => {
  test("the generic taxonomy stays cancelled; the loop separately requires its root signal", () => {
    const classified = classifyError(new Error("upstream connection aborted unexpectedly"));
    expect(classified.category).toBe("cancelled");
    expect(classified.machineCode).toBe("cancelled");
  });
});

describe("classifyError — unusable model output", () => {
  test("is terminal and preserves its actionable typed vocabulary", () => {
    const error = Object.assign(new Error("The model returned no visible answer."), {
      code: "EMPTY_MODEL_OUTPUT",
      recovery: "Choose another model and retry.",
    });
    const classified = classifyError(error, 0);
    expect(classified).toMatchObject({
      category: "model_output",
      fatal: true,
      retryable: false,
      machineCode: "EMPTY_MODEL_OUTPUT",
      recoveryHint: "Choose another model and retry.",
    });
  });
});

describe("classifyActionError — action-level retryable taxonomy", () => {
  test("timeout errors are transient/retryable with a recovery hint", () => {
    const c = classifyActionError(new Error("TAB_ACTION timeout after 15000ms"));
    expect(c.retryable).toBe(true);
    expect(c.machineCode).toBe("action_timeout");
    expect(c.recoveryHint.length).toBeGreaterThan(0);
  });

  test("stale element references are transient/retryable", () => {
    const c = classifyActionError(new Error("element became detached before click"));
    expect(c.retryable).toBe(true);
    expect(c.machineCode).toBe("element_state_changed");
    expect(c.recoveryHint.length).toBeGreaterThan(0);
  });

  test("navigation-in-flight errors are transient/retryable", () => {
    const c = classifyActionError(new Error("Execution context was destroyed"));
    expect(c.retryable).toBe(true);
    expect(c.machineCode).toBe("navigation_race");
    expect(c.recoveryHint.length).toBeGreaterThan(0);
  });

  test("forbidden/permission errors are permanent/non-retryable", () => {
    const c = classifyActionError(new Error("access denied by evaluate sandbox: window.foo"));
    expect(c.retryable).toBe(false);
    expect(c.machineCode).toBe("action_forbidden");
    expect(c.recoveryHint.length).toBeGreaterThan(0);
  });

  test("invalid-action errors are permanent/non-retryable", () => {
    const c = classifyActionError(new Error("element [1] is not a text input"));
    expect(c.retryable).toBe(false);
    expect(c.machineCode).toBe("action_failed");
    expect(c.recoveryHint.length).toBeGreaterThan(0);
  });

  test("non-Error thrown values still classify", () => {
    const c = classifyActionError("plain string failure");
    expect(c.machineCode).toBe("action_failed");
    expect(c.retryable).toBe(false);
  });
});

describe("formatErrorSuffix — error output vocabulary", () => {
  test("builds a parseable [code; retryable] (recovery) suffix", () => {
    expect(formatErrorSuffix("action_timeout", true, "Wait for the page to settle."))
      .toBe("[code: action_timeout; retryable: yes] (recovery: Wait for the page to settle.)");
  });

  test("marks permanent failures as retryable: no", () => {
    expect(formatErrorSuffix("action_failed", false, "Try a different action."))
      .toBe("[code: action_failed; retryable: no] (recovery: Try a different action.)");
  });
});

describe("classifyError — machine code + recovery vocabulary", () => {
  test("every category carries a stable machine code", () => {
    const cases: Array<[unknown, string]> = [
      [new Error("401 Unauthorized: invalid API key"), "auth_failed"],
      [new Error("403 Forbidden: access denied"), "access_forbidden"],
      [new Error("400 Bad Request: malformed request"), "invalid_request"],
      [new Error("429 Too Many Requests: rate limit exceeded"), "rate_limited"],
      [new Error("503 Service Unavailable"), "server_error"],
      [new Error("fetch failed: ECONNREFUSED"), "network_error"],
      [new DOMException("The operation was aborted", "AbortError"), "cancelled"],
      [new SyntaxError("Unexpected token in JSON"), "parse_error"],
      [new Error("reached max steps"), "max_steps_reached"],
      [new Error("too many consecutive failures"), "max_failures_reached"],
      [new TypeError("Cannot read properties of undefined"), "internal_error"],
      [new Error("mystery failure"), "unknown_error"],
    ];
    for (const [err, code] of cases) {
      const classified = classifyError(err);
      expect(classified.machineCode).toBe(code);
      expect(classified.recoveryHint.length).toBeGreaterThan(10);
    }
  });

  test("fatal categories never advertise retrying", () => {
    for (const err of [
      new Error("401 Unauthorized"),
      new Error("403 Forbidden"),
      new Error("400 Bad Request"),
      new Error("reached max steps"),
      new TypeError("boom"),
    ]) {
      const classified = classifyError(err);
      expect(classified.fatal).toBe(true);
      expect(classified.retryable).toBe(false);
    }
  });
});

// ─── LLM retry-layer taxonomy (retry.ts) ────────────────────────────────────
// The HTTP retry layer classifies more than 429/5xx/network: context-overflow
// (three independent triggers), the OpenAI-family 404 quirk, and HTML gateway
// auth pages (401/403 that are never retried). These are transport-level
// retry decisions, distinct from the loop-level error rendering taxonomy above.

describe("classifyContextOverflow — three independent triggers", () => {
  test("HTTP 413 (payload too large) is context overflow", () => {
    const msg = "LLM API 413: Request Entity Too Large";
    expect(classifyContextOverflow(new Error(msg), 413, msg)).toBe(true);
  });

  test("a 413 attached to the error (not the status arg) is context overflow", () => {
    const msg = "payload too large";
    const err = Object.assign(new Error(msg), { status: 413 });
    expect(classifyContextOverflow(err, undefined, msg)).toBe(true);
  });

  test("nested error body code context_length_exceeded is context overflow", () => {
    const msg =
      'LLM API 400: {"error":{"code":"context_length_exceeded","message":"This model\'s maximum context length is 128000 tokens"}}';
    expect(classifyContextOverflow(new Error(msg), 400, msg)).toBe(true);
  });

  test("overflow phrases in the message are context overflow", () => {
    const phrases = [
      "This model's maximum context length is 128000 tokens",
      "The request exceeds the context window of this model",
      "Input is too many tokens for the model",
      "token limit exceeded",
      "the max_tokens parameter exceeds the model limit",
      "prompt is too long",
      "model_context_window_exceeded",
      "Input token count exceeds the maximum",
      "request entity too large",
    ];
    for (const phrase of phrases) {
      expect(classifyContextOverflow(new Error(phrase), undefined, phrase)).toBe(true);
    }
  });

  test("a rate-limit message mentioning tokens is NOT overflow (exclusion wins)", () => {
    const msg = "HTTP 429 Too Many Requests: too many tokens generated this minute";
    expect(classifyContextOverflow(new Error(msg), undefined, msg)).toBe(false);
  });

  test("an unrelated 4xx message is NOT overflow", () => {
    const msg = "LLM API 400: upstream service returned 500 internal error";
    expect(classifyContextOverflow(new Error(msg), 400, msg)).toBe(false);
  });
});

describe("isGatewayHtmlAuthError — HTML gateway 401/403", () => {
  test("401 with a doctype page is a gateway-auth error", () => {
    const msg = "LLM API 401: <!doctype html><html><body>Access denied</body></html>";
    expect(isGatewayHtmlAuthError(new Error(msg), 401, msg)).toBe(true);
  });

  test("403 with an html page is a gateway-auth error", () => {
    const msg = 'LLM API 403: <html lang="en"><head><title>Forbidden</title></head></html>';
    expect(isGatewayHtmlAuthError(new Error(msg), 403, msg)).toBe(true);
  });

  test("a JSON error body is never an HTML gateway page", () => {
    const msg = 'LLM API 401: {"error":{"message":"<html> is not valid input"}}';
    expect(isGatewayHtmlAuthError(new Error(msg), 401, msg)).toBe(false);
  });

  test("401/403 without HTML markers are not gateway-auth", () => {
    expect(isGatewayHtmlAuthError(new Error("LLM API 401: invalid key"), 401, "LLM API 401: invalid key")).toBe(false);
  });

  test("an HTML body under a non-401/403 status is not gateway-auth", () => {
    const msg = "LLM API 404: <!doctype html><html></html>";
    expect(isGatewayHtmlAuthError(new Error(msg), 404, msg)).toBe(false);
  });
});

describe("isRetryableOpenAI404 — provider-scoped 404 retry", () => {
  test("openai / azure / openrouter 404s are retryable", () => {
    for (const providerId of ["openai", "azure", "openrouter"]) {
      expect(isRetryableOpenAI404(404, providerId)).toBe(true);
    }
  });

  test("404s are NOT retryable for other providers (including openai-prefixed aliases)", () => {
    for (const providerId of ["anthropic", "google", "xai", "openai-compatible", "deepseek", "ollama"]) {
      expect(isRetryableOpenAI404(404, providerId)).toBe(false);
    }
  });

  test("404 retry requires BOTH the status and the provider id", () => {
    expect(isRetryableOpenAI404(404, undefined)).toBe(false);
    expect(isRetryableOpenAI404(400, "openai")).toBe(false);
  });
});

describe("withLLMRetry — retry decisions", () => {
  /** Build an Error carrying a numeric `status` (as the transport attaches). */
  function statusError(status: number, message = `LLM API ${status}: err`): Error & { status: number } {
    return Object.assign(new Error(message), { status });
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

  test("an overflow-classified 400 is retried until it succeeds", async () => {
    await withFakeTimers(async () => {
      let calls = 0;
      const fn = vi.fn(async () => {
        calls++;
        if (calls < 3) {
          throw statusError(400, "LLM API 400: This model's maximum context length is 128000 tokens");
        }
        return "ok";
      });
      const p = withLLMRetry(fn);
      await vi.runAllTimersAsync();
      expect(await p).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  test("an overflow body-code error is retried", async () => {
    await withFakeTimers(async () => {
      let calls = 0;
      const fn = vi.fn(async () => {
        calls++;
        if (calls < 2) {
          throw statusError(400, 'LLM API 400: {"error":{"code":"context_length_exceeded"}}');
        }
        return "ok";
      });
      const p = withLLMRetry(fn);
      await vi.runAllTimersAsync();
      expect(await p).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  test("an HTTP 413 is retried", async () => {
    await withFakeTimers(async () => {
      let calls = 0;
      const fn = vi.fn(async () => {
        calls++;
        if (calls < 2) throw statusError(413, "LLM API 413: Request Entity Too Large");
        return "ok";
      });
      const p = withLLMRetry(fn);
      await vi.runAllTimersAsync();
      expect(await p).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  test("a gateway 403 HTML page is NOT retried (single attempt)", async () => {
    const fn = vi.fn(async () => {
      throw statusError(403, "LLM API 403: <!doctype html><html><body>Forbidden</body></html>");
    });
    await expect(withLLMRetry(fn)).rejects.toThrow(/403/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("a gateway 401 page mentioning an overflow phrase is NOT retried (gateway wins)", async () => {
    const fn = vi.fn(async () => {
      throw statusError(401, "LLM API 401: <!doctype html><html><body>Too many tokens — authenticate first</body></html>");
    });
    await expect(withLLMRetry(fn)).rejects.toThrow(/401/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("an openai-family 404 is retried when providerId is passed", async () => {
    await withFakeTimers(async () => {
      let calls = 0;
      const fn = vi.fn(async () => {
        calls++;
        if (calls < 2) throw statusError(404, "LLM API 404: model not found");
        return "ok";
      });
      const p = withLLMRetry(fn, undefined, undefined, "openai");
      await vi.runAllTimersAsync();
      expect(await p).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  test("a non-openai-family 404 is NOT retried", async () => {
    const fn = vi.fn(async () => {
      throw statusError(404, "LLM API 404: model not found");
    });
    await expect(withLLMRetry(fn, undefined, undefined, "anthropic")).rejects.toThrow(/404/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("other 4xx errors are NOT retried (single attempt)", async () => {
    for (const status of [400, 402, 403, 409]) {
      const fn = vi.fn(async () => {
        throw statusError(status);
      });
      await expect(withLLMRetry(fn)).rejects.toThrow(new RegExp(String(status)));
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });
});
