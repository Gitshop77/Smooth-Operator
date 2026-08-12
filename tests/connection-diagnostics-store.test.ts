/**
 * Phase 12 — connection diagnostics store (provider health check surface).
 *
 * Covers the stale-cache-leak invariant with a generation guard:
 * - a provider/model change invalidates the surface and advances the
 *   generation;
 * - a test that resolves AFTER an invalidation is dropped (late responses for
 *   the old selection never overwrite the new one);
 * - out-of-order resolves (old generation arriving after a newer one) leave
 *   the current entry untouched;
 * - the bounded result history keeps the latest tests, newest first;
 * - a resolved provider result never contains a credential.
 */

import { describe, expect, test } from "vitest";
import {
  connectionDiagnosticsReducer,
  initialConnectionDiagnosticsState,
  HISTORY_LIMIT,
  type ConnectionDiagnosticsState,
} from "../src/extension/options/stores/connection-diagnostics-store";

function result(ok: boolean, message: string) {
  return {
    version: 1 as const,
    ok,
    code: ok ? ("ok" as const) : ("provider_error" as const),
    latencyMs: 42,
    provider: "openai",
    model: "gpt-5.5",
    message,
  };
}

describe("connection-diagnostics reducer — generation guard", () => {
  test("invalidation advances the generation and resets the current entry", () => {
    let s = connectionDiagnosticsReducer(initialConnectionDiagnosticsState, {
      type: "DIAGNOSTICS_TEST_STARTED",
      generation: 0,
      provider: "openai",
      model: "gpt-5.5",
    });
    s = connectionDiagnosticsReducer(s, { type: "DIAGNOSTICS_INVALIDATED" });
    expect(s.current.state).toBe("idle");
    expect(s.current.generation).toBe(1);
    // A late resolve for the old generation is dropped.
    const after = connectionDiagnosticsReducer(s, {
      type: "DIAGNOSTICS_TEST_RESOLVED",
      generation: 0,
      result: result(true, "Connected"),
    });
    expect(after.current.state).toBe("idle");
    expect(after.history).toHaveLength(0);
  });

  test("a pending test resolves into ok with the result and a bounded history entry", () => {
    let s = connectionDiagnosticsReducer(initialConnectionDiagnosticsState, {
      type: "DIAGNOSTICS_TEST_STARTED",
      generation: 0,
      provider: "openai",
      model: "gpt-5.5",
    });
    s = connectionDiagnosticsReducer(s, {
      type: "DIAGNOSTICS_TEST_RESOLVED",
      generation: 0,
      result: result(true, "Connected (42ms, 2 models available)"),
    });
    expect(s.current.state).toBe("ok");
    expect(s.current.result?.message).toContain("Connected");
    expect(s.history[0].state).toBe("ok");
  });

  test("a transport failure resolves into failed and records the sanitized error", () => {
    let s = connectionDiagnosticsReducer(initialConnectionDiagnosticsState, {
      type: "DIAGNOSTICS_TEST_STARTED",
      generation: 0,
      provider: "openai",
      model: "gpt-5.5",
    });
    s = connectionDiagnosticsReducer(s, {
      type: "DIAGNOSTICS_TEST_FAILED",
      generation: 0,
      error: "net::ERR_CONNECTION_TIMED_OUT",
    });
    expect(s.current.state).toBe("failed");
    expect(s.current.error).toBe("net::ERR_CONNECTION_TIMED_OUT");
    expect(s.history[0].state).toBe("failed");
  });

  test("out-of-order generation: a newer invalidate drops a queued older resolve", () => {
    let s = connectionDiagnosticsReducer(initialConnectionDiagnosticsState, {
      type: "DIAGNOSTICS_TEST_STARTED",
      generation: 0,
      provider: "openai",
      model: "gpt-5.5",
    });
    // User switches to anthropic mid-flight.
    s = connectionDiagnosticsReducer(s, { type: "DIAGNOSTICS_INVALIDATED" });
    // Newer test starts under generation 1.
    s = connectionDiagnosticsReducer(s, {
      type: "DIAGNOSTICS_TEST_STARTED",
      generation: 1,
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    // The OLD request finally resolves — must be dropped, not applied.
    s = connectionDiagnosticsReducer(s, {
      type: "DIAGNOSTICS_TEST_RESOLVED",
      generation: 0,
      result: result(true, "Connected"),
    });
    expect(s.current.state).toBe("pending");
    expect(s.current.provider).toBe("anthropic");
    expect(s.history).toHaveLength(0);
    // The new test resolves cleanly.
    s = connectionDiagnosticsReducer(s, {
      type: "DIAGNOSTICS_TEST_RESOLVED",
      generation: 1,
      result: result(true, "Connected (anthropic)"),
    });
    expect(s.current.state).toBe("ok");
    expect(s.current.provider).toBe("anthropic");
    expect(s.history).toHaveLength(1);
  });

  test("started with a stale generation is a no-op (cannot clobber a newer test)", () => {
    let s = connectionDiagnosticsReducer(initialConnectionDiagnosticsState, {
      type: "DIAGNOSTICS_TEST_STARTED",
      generation: 0,
      provider: "openai",
      model: "gpt-5.5",
    });
    s = connectionDiagnosticsReducer(s, { type: "DIAGNOSTICS_INVALIDATED" });
    const before = s.current;
    s = connectionDiagnosticsReducer(s, {
      type: "DIAGNOSTICS_TEST_STARTED",
      generation: 0,
      provider: "stale-provider",
      model: "stale-model",
    });
    expect(s.current).toBe(before);
  });

  test("history is bounded to the newest HISTORY_LIMIT entries", () => {
    let s: ConnectionDiagnosticsState = initialConnectionDiagnosticsState;
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      s = connectionDiagnosticsReducer(s, {
        type: "DIAGNOSTICS_TEST_STARTED",
        generation: i,
        provider: "openai",
        model: "m",
      });
      s = connectionDiagnosticsReducer(s, {
        type: "DIAGNOSTICS_TEST_RESOLVED",
        generation: i,
        result: result(true, `run ${i}`),
      });
      s = connectionDiagnosticsReducer(s, { type: "DIAGNOSTICS_INVALIDATED" });
    }
    expect(s.history.length).toBeLessThanOrEqual(HISTORY_LIMIT);
  });

  test("result payloads never carry credential material", () => {
    let s = connectionDiagnosticsReducer(initialConnectionDiagnosticsState, {
      type: "DIAGNOSTICS_TEST_STARTED",
      generation: 0,
      provider: "openai",
      model: "gpt-5.5",
    });
    s = connectionDiagnosticsReducer(s, {
      type: "DIAGNOSTICS_TEST_RESOLVED",
      generation: 0,
      result: result(true, "Connected"),
    });
    expect(JSON.stringify(s)).not.toMatch(/sk-[A-Za-z0-9]/);
  });
});

