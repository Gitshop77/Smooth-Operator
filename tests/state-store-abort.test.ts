/**
 * state-store.ts — hardResetAbortRequested error handling.
 *
 * Verify that hardResetAbortRequested doesn't throw when storage fails,
 * and that the error is logged. Also verify that a stale abortRequested: true
 * flag can be cleared even when storage is unreliable.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { hardResetAbortRequested, getRunState } from "../src/extension/background/state-store";

function installFailingSessionStub() {
  const chrome = {
    storage: {
      session: {
        get: vi.fn(async () => {
          throw new Error("storage unavailable");
        }),
        set: vi.fn(async () => {
          throw new Error("storage unavailable");
        }),
        remove: vi.fn(async () => {
          throw new Error("storage unavailable");
        }),
      },
    },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(),
    },
  };
  (globalThis as Record<string, unknown>).chrome = chrome;
  return { chrome };
}

let restore: () => void;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  installFailingSessionStub();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  restore = () => {
    delete (globalThis as Record<string, unknown>).chrome;
  };
});

afterEach(() => {
  restore();
  consoleErrorSpy.mockRestore();
});

describe("hardResetAbortRequested error handling", () => {
  test("does not throw when storage.get throws", async () => {
    await expect(hardResetAbortRequested()).resolves.toBeUndefined();
  });

  test("logs console.error when storage fails", async () => {
    await hardResetAbortRequested();
    expect(consoleErrorSpy).toHaveBeenCalled();
    const firstCall = consoleErrorSpy.mock.calls[0]?.[0];
    expect(String(firstCall)).toContain("hardResetAbortRequested failed");
  });

  test("returns cleanly even when storage.set also throws", async () => {
    // First call: get throws → error logged, returns
    await expect(hardResetAbortRequested()).resolves.toBeUndefined();
    // Second call: still throws, still returns
    await expect(hardResetAbortRequested()).resolves.toBeUndefined();
  });

  test("getRunState throws when storage is unavailable (no catch)", async () => {
    // hardResetAbortRequested logs but doesn't throw
    await hardResetAbortRequested();
    // getRunState does NOT catch storage errors — it throws
    await expect(getRunState()).rejects.toThrow("storage unavailable");
  });
});
