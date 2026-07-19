/**
 * errors.ts — `classifyError` precedence + bounded-unknown-retry regression
 * tests.
 *
 * The agent loop's retry budget depends on subtle control flow: 5xx is checked
 * before rate_limit, a `fetch` TypeError is transient `network` while a
 * `JSON.parse` SyntaxError is a FATAL `programmer_error`, a structured `status`
 * overrides substring guesses, and an `unknown` error is retried exactly once
 * (attempt 0) then becomes fatal (attempt >= 1). A regression here silently
 * over-retries fatal errors or fails-open transient ones, so these tests pin
 * the ordering.
 */
import { describe, test, expect } from "vitest";
import { classifyError } from "../src/lib/agent/errors";

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
