/**
 * Cross-boundary validation for the `HUMAN_INTERACT` response payload.
 *
 * `sanitizeResponse` validates a `chrome.runtime` callback payload before the
 * agent loop trusts it. A malformed or cross-talk response must never reach the
 * loop as an unexpected shape, so this guards the boundary rather than relying
 * on the sender to be well-formed.
 */

import { describe, test, expect } from "vitest";
import { sanitizeResponse } from "../src/lib/agent/human-interaction-utils";
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
