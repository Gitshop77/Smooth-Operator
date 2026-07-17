/**
 * Regression coverage for `press_and_hold`'s CDP branch. The handler must
 * NEVER report `success` when the anti-bot hold did not actually happen
 * (the debugger wasn't attached, the SW returned `ok:false`, or it returned
 * nothing) — reporting success there would let the agent believe it passed a
 * verification gate it didn't, and would also mask the dangling `setTimeout`
 * that previously fired an unhandled rejection on the happy path. These tests
 * lock the fail-loud branch and the happy-path success in.
 */

import { describe, test, expect, vi, afterEach } from "vitest";
import type { ActionContext } from "../../src/lib/agent/tools/handlers/types";
import { handlePressAndHold } from "../../src/lib/agent/tools/handlers/press-and-hold";
import { makeState } from "../helpers/make-state";

// Stub the DOM-renderer-dependent helpers so the test exercises only the
// CDP race / success-reporting branch.
vi.mock("../../src/lib/agent/dom/overlay", () => ({
  highlightElement: vi.fn(() => ({ remove: vi.fn() })),
}));
vi.mock("../../src/lib/agent/dom/phantom-cursor", () => ({
  moveCursorToElement: vi.fn(async () => ({ x: 0, y: 0 })),
}));
vi.mock("../../src/lib/agent/tools/helpers", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/lib/agent/tools/helpers")
  >("../../src/lib/agent/tools/helpers");
  return {
    ...actual,
    safeScrollIntoView: vi.fn(),
    domFingerprint: vi.fn(() => "fp"),
  };
});

function installExtensionMock(sendMessage: (msg: unknown) => Promise<unknown>): void {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { id: "ext-id", sendMessage },
  };
}

function makeCtx(): ActionContext {
  const el = document.createElement("button");
  el.id = "press-target";
  document.body.appendChild(el);
  const state = makeState({ selectorMap: { 1: el } as Record<number, unknown> });
  return {
    state,
    beforeUrl: location.href,
    beforeFingerprint: "fp",
  };
}

const ACTION = {
  type: "press_and_hold",
  index: 1,
  hold_ms: 1500,
  delay_ms: 0,
} as const;

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
  document.getElementById("press-target")?.remove();
  vi.restoreAllMocks();
});

describe("handlePressAndHold CDP branch", () => {
  test("reports success when the CDP hold succeeds (ok:true)", async () => {
    installExtensionMock(async () => ({ ok: true }));
    const res = await handlePressAndHold(makeCtx(), ACTION);
    expect(res.success).toBe(true);
    expect(res.message).toContain("CDP");
  });

  test("reports failure (never success) when CDP returns ok:false", async () => {
    installExtensionMock(async () => ({ ok: false, error: "debugger not attached" }));
    const res = await handlePressAndHold(makeCtx(), ACTION);
    expect(res.success).toBe(false);
  });

  test("reports failure (never success) when CDP returns no result", async () => {
    installExtensionMock(async () => undefined);
    const res = await handlePressAndHold(makeCtx(), ACTION);
    expect(res.success).toBe(false);
  });

  test("reports failure (never success) when the CDP call throws", async () => {
    installExtensionMock(async () => {
      throw new Error("messaging error");
    });
    const res = await handlePressAndHold(makeCtx(), ACTION);
    expect(res.success).toBe(false);
  });
});
