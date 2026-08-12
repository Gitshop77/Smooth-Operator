/**
 * Phase 10 — debugger/CDP cleanup reliability.
 *
 * No chrome.debugger session may leak after evaluate / PDF / screenshot /
 * click flows, on success OR on error. Pins:
 * - `withPageDebugger` detaches in a `finally` even when the work function
 *   throws, and rethrows the ORIGINAL error (cleanup never masks it).
 * - a wedged CDP command (`sendDebuggerCommandWithTimeout` timeout) does not
 *   leak the per-tab debugger refcount: the release still detaches exactly
 *   once when the last user leaves.
 * - an attach failure rolls back its own refcount, so a later successful
 *   acquire/release pair still detaches exactly once.
 * - `detachDebugger` is tolerant on the cleanup path (already-detached no-op,
 *   other detach errors warn but never throw).
 * - `captureTabScreenshot` detaches on the ERROR path too (a throwing CDP
 *   capture still releases the refcounted session).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

type DebuggerFn = (...args: unknown[]) => Promise<unknown>;
let attachMock: Mock<DebuggerFn>;
let detachMock: Mock<DebuggerFn>;
let sendCommandMock: Mock<DebuggerFn>;

function installChrome(): void {
  attachMock = vi.fn(async () => {});
  detachMock = vi.fn(async () => {});
  sendCommandMock = vi.fn();
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { id: "cleanup-test" },
    debugger: {
      attach: attachMock,
      detach: detachMock,
      sendCommand: sendCommandMock,
    },
    storage: { onChanged: { addListener: () => {} }, local: { get: vi.fn().mockResolvedValue({}) } },
  };
}

beforeEach(() => {
  installChrome();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).chrome;
});

// ─── withPageDebugger: detach always runs ───────────────────────────────────

describe("withPageDebugger — detach always runs", () => {
  test("detaches on success", async () => {
    const { withPageDebugger } = await import("../src/extension/background/tab-manager");
    const result = await withPageDebugger(41, async () => 42);
    expect(result).toBe(42);
    expect(attachMock).toHaveBeenCalledWith({ tabId: 41 }, "1.3");
    expect(detachMock).toHaveBeenCalledWith({ tabId: 41 });
  });

  test("detaches when the work function throws, and rethrows the ORIGINAL error", async () => {
    const { withPageDebugger } = await import("../src/extension/background/tab-manager");
    const boom = new Error("cdp command failed");
    await expect(withPageDebugger(42, async () => { throw boom; })).rejects.toBe(boom);
    expect(detachMock).toHaveBeenCalledWith({ tabId: 42 });
  });

  test("detaches when the work function rejects asynchronously after a partial CDP flow", async () => {
    const { withPageDebugger } = await import("../src/extension/background/tab-manager");
    await expect(
      withPageDebugger(43, async () => {
        void sendCommandMock("Input.dispatchMouseEvent", { type: "mousePressed" });
        throw new Error("target crashed mid-click");
      }),
    ).rejects.toThrow("target crashed mid-click");
    expect(detachMock).toHaveBeenCalledWith({ tabId: 43 });
  });

  test("a failing detach in cleanup never masks the work error", async () => {
    const { withPageDebugger } = await import("../src/extension/background/tab-manager");
    detachMock.mockRejectedValueOnce(new Error("detach failed"));
    const boom = new Error("work failed");
    // releasePageDebugger swallows detach rejection; the ORIGINAL error must
    // surface unchanged.
    await expect(withPageDebugger(44, async () => { throw boom; })).rejects.toBe(boom);
  });
});

// ─── sendDebuggerCommandWithTimeout: no refcount leak on a wedged session ────

describe("sendDebuggerCommandWithTimeout — no refcount leak on a wedged CDP session", () => {
  test("a timeout rejects but the surrounding withPageDebugger still releases the session exactly once", async () => {
    vi.useFakeTimers();
    const { withPageDebugger } = await import("../src/extension/background/tab-manager");
    const { sendDebuggerCommandWithTimeout } = await import("../src/extension/background/tab-manager-utils");

    const pending = withPageDebugger(50, async () => {
      // The CDP command never settles — a wedged session.
      sendCommandMock.mockReturnValue(new Promise<never>(() => {}));
      return sendDebuggerCommandWithTimeout(50, "Page.captureScreenshot", { format: "jpeg" });
    });
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(10_100);
    await assertion;
    vi.useRealTimers();

    expect(sendCommandMock).toHaveBeenCalledWith({ tabId: 50 }, "Page.captureScreenshot", { format: "jpeg" });
    // The refcounted session was released despite the wedged command.
    expect(detachMock).toHaveBeenCalledTimes(1);
    expect(detachMock).toHaveBeenCalledWith({ tabId: 50 });
  });

  test("a late CDP response after the timeout is dropped (settled flag — no double settle)", async () => {
    vi.useFakeTimers();
    let lateResolve: ((v: unknown) => void) | undefined;
    sendCommandMock.mockReturnValue(new Promise<unknown>((resolve) => { lateResolve = resolve; }));
    const { sendDebuggerCommandWithTimeout } = await import("../src/extension/background/tab-manager-utils");

    const p = sendDebuggerCommandWithTimeout(51, "Page.captureScreenshot", {});
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(10_100);
    await assertion;
    // The response arrives AFTER the timeout: the promise already settled, so
    // nothing can double-resolve or double-clear (no unhandled rejection).
    lateResolve?.({ data: "late" });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  });
});

// ─── attach failure rollback ────────────────────────────────────────────────

describe("attach failure rollback", () => {
  test("a genuine attach failure leaves the refcount clean (later pair detaches once)", async () => {
    const { acquirePageDebugger, releasePageDebugger } = await import("../src/extension/background/tab-manager");
    const badAttach = vi.fn(async () => { throw new Error("permission denied"); });
    await expect(acquirePageDebugger(60, badAttach)).rejects.toThrow("permission denied");

    // A subsequent successful acquire/release must detach exactly once — the
    // failed acquire must not have leaked a +1 refcount.
    const goodAttach = vi.fn(async () => {});
    await acquirePageDebugger(60, goodAttach);
    await releasePageDebugger(60, detachMock);
    expect(detachMock).toHaveBeenCalledTimes(1);
  });
});

// ─── detachDebugger tolerance on the cleanup path ───────────────────────────

describe("detachDebugger tolerance on the cleanup path", () => {
  test("already-detached is a silent no-op", async () => {
    const { detachDebugger } = await import("../src/lib/agent/cdp-controller");
    detachMock.mockRejectedValueOnce(new Error("No target with given id found: already detached"));
    await expect(detachDebugger(70)).resolves.toBeUndefined();
    expect(detachMock).toHaveBeenCalledWith({ tabId: 70 });
  });

  test("other detach errors warn but never throw (finally-safe)", async () => {
    const { detachDebugger } = await import("../src/lib/agent/cdp-controller");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    detachMock.mockRejectedValueOnce(new Error("debugger session errored"));
    await expect(detachDebugger(71)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("detachDebugger(71) failed");
  });

  test("already-attached on acquire is treated as success (idempotent)", async () => {
    const { attachDebugger } = await import("../src/lib/agent/cdp-controller");
    attachMock.mockRejectedValueOnce(new Error("Another debugger is already attached"));
    await expect(attachDebugger(72)).resolves.toBe(true);
  });
});

// ─── captureTabScreenshot: error path still releases the session ────────────

describe("captureTabScreenshot — error path still releases the session", () => {
  test("a throwing Page.captureScreenshot propagates AND the debugger is detached", async () => {
    const { captureTabScreenshot } = await import("../src/extension/background/screenshots");
    sendCommandMock.mockRejectedValueOnce(new Error("Page.captureScreenshot failed: target closed"));

    await expect(captureTabScreenshot(80)).rejects.toThrow("Page.captureScreenshot failed");
    expect(detachMock).toHaveBeenCalledTimes(1);
  });
});
