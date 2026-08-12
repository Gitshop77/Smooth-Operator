/**
 * Cross-boundary validation for the `HUMAN_INTERACT` response payload.
 *
 * `sanitizeResponse` validates a `chrome.runtime` callback payload before the
 * agent loop trusts it. A malformed or cross-talk response must never reach the
 * loop as an unexpected shape, so this guards the boundary rather than relying
 * on the sender to be well-formed.
 */

import { afterEach, describe, test, expect, vi } from "vitest";
import { sanitizeResponse, resolveTimeoutMs } from "../src/lib/agent/human-interaction-utils";
import type { HumanInteractionResponse } from "../src/lib/agent/human-interaction";

describe("sanitizeResponse", () => {
  test("undefined payload is treated as cancelled", () => {
    expect(sanitizeResponse(undefined)).toEqual({ mode: "cancelled" });
  });

  test("null payload is treated as cancelled", () => {
    expect(sanitizeResponse(null)).toEqual({ mode: "cancelled" });
  });

  test("non-object payload is an error", () => {
    expect(sanitizeResponse("nope" as unknown as HumanInteractionResponse)).toEqual({
      mode: "error",
      reason: "invalid HUMAN_INTERACT response shape",
    });
  });

  test("object without a mode field is an error", () => {
    expect(sanitizeResponse({} as unknown as HumanInteractionResponse)).toEqual({
      mode: "error",
      reason: "invalid HUMAN_INTERACT response shape",
    });
  });

  test("unknown mode is an error", () => {
    expect(sanitizeResponse({ mode: "bogus" } as unknown as HumanInteractionResponse)).toEqual({
      mode: "error",
      reason: "invalid HUMAN_INTERACT response shape",
    });
  });

  test("confirm without a boolean confirmed is an error", () => {
    expect(sanitizeResponse({ mode: "confirm" } as unknown as HumanInteractionResponse)).toEqual({
      mode: "error",
      reason: "invalid HUMAN_INTERACT response shape",
    });
    expect(
      sanitizeResponse({ mode: "confirm", confirmed: "yes" } as unknown as HumanInteractionResponse),
    ).toEqual({ mode: "error", reason: "invalid HUMAN_INTERACT response shape" });
  });

  test("input without a string value is an error", () => {
    expect(sanitizeResponse({ mode: "input" } as unknown as HumanInteractionResponse)).toEqual({
      mode: "error",
      reason: "invalid HUMAN_INTERACT response shape",
    });
    expect(
      sanitizeResponse({ mode: "input", value: 42 } as unknown as HumanInteractionResponse),
    ).toEqual({ mode: "error", reason: "invalid HUMAN_INTERACT response shape" });
  });

  test("password responses keep the tagged mode and reject non-string values", () => {
    expect(sanitizeResponse({ mode: "password", value: "s3cret" } as unknown as HumanInteractionResponse)).toEqual({
      mode: "password",
      value: "s3cret",
    });
    expect(sanitizeResponse({ mode: "password" } as unknown as HumanInteractionResponse)).toEqual({
      mode: "error",
      reason: "invalid HUMAN_INTERACT response shape",
    });
  });

  test("select without a string value is an error", () => {
    expect(sanitizeResponse({ mode: "select" } as unknown as HumanInteractionResponse)).toEqual({
      mode: "error",
      reason: "invalid HUMAN_INTERACT response shape",
    });
    expect(
      sanitizeResponse({ mode: "select", value: null } as unknown as HumanInteractionResponse),
    ).toEqual({ mode: "error", reason: "invalid HUMAN_INTERACT response shape" });
  });

  test("request_help without a string value is an error", () => {
    expect(
      sanitizeResponse({ mode: "request_help" } as unknown as HumanInteractionResponse),
    ).toEqual({ mode: "error", reason: "invalid HUMAN_INTERACT response shape" });
  });

  test("error without a string reason is an error", () => {
    expect(sanitizeResponse({ mode: "error" } as unknown as HumanInteractionResponse)).toEqual({
      mode: "error",
      reason: "invalid HUMAN_INTERACT response shape",
    });
  });

  test("valid shapes pass through unchanged", () => {
    expect(sanitizeResponse({ mode: "confirm", confirmed: true })).toEqual({
      mode: "confirm",
      confirmed: true,
    });
    expect(sanitizeResponse({ mode: "confirm", confirmed: false })).toEqual({
      mode: "confirm",
      confirmed: false,
    });
    expect(sanitizeResponse({ mode: "input", value: "hello" })).toEqual({
      mode: "input",
      value: "hello",
    });
    expect(sanitizeResponse({ mode: "select", value: "opt-2" })).toEqual({
      mode: "select",
      value: "opt-2",
    });
    expect(sanitizeResponse({ mode: "request_help", value: "stuck" })).toEqual({
      mode: "request_help",
      value: "stuck",
    });
    expect(sanitizeResponse({ mode: "cancelled" })).toEqual({ mode: "cancelled" });
    expect(sanitizeResponse({ mode: "error", reason: "no receiver" })).toEqual({
      mode: "error",
      reason: "no receiver",
    });
  });
});

describe("askHuman cancellation", () => {
  afterEach(() => {
    vi.resetModules();
    delete (globalThis as Record<string, unknown>).chrome;
  });

  test("an extension prompt waiting on sendResponse rejects immediately on run abort", async () => {
    const sendMessage = vi.fn((_message: unknown, _callback: (response: unknown) => void) => undefined);
    (globalThis as Record<string, unknown>).chrome = {
      runtime: { id: "test-extension", sendMessage, lastError: undefined },
    };
    vi.resetModules();
    const { askHuman } = await import("../src/lib/agent/human-interaction");
    const controller = new AbortController();
    const pending = askHuman(
      { mode: "confirm", message: "Continue?", timeoutMs: 300_000 },
      controller.signal,
      { runId: "run-1", dispatchRevision: 1 },
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    controller.abort(new DOMException("Stopped", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "HUMAN_INTERACT_CANCEL",
      interactionId: expect.any(String),
      token: { runId: "run-1", dispatchRevision: 1 },
    }));
  });
});

describe("resolveTimeoutMs", () => {
  test("falls back to the 5-minute default for malformed values", () => {
    expect(resolveTimeoutMs()).toBe(5 * 60 * 1000);
    expect(resolveTimeoutMs(0)).toBe(5 * 60 * 1000);
    expect(resolveTimeoutMs(-1)).toBe(5 * 60 * 1000);
    expect(resolveTimeoutMs(Number.NaN)).toBe(5 * 60 * 1000);
    expect(resolveTimeoutMs(Number.POSITIVE_INFINITY)).toBe(5 * 60 * 1000);
  });

  test("clamps an oversized override to the 24 h ceiling (setTimeout 2^31-1 clamp guard)", () => {
    expect(resolveTimeoutMs(48 * 60 * 60 * 1000)).toBe(24 * 60 * 60 * 1000);
    expect(resolveTimeoutMs(24 * 60 * 60 * 1000)).toBe(24 * 60 * 60 * 1000);
  });

  test("accepts a sane override unchanged", () => {
    expect(resolveTimeoutMs(300_000)).toBe(300_000);
  });
});
