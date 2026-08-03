/**
 * Security-sensitive interaction tests — coverage gaps:
 * - `CallbackDispatcher.safeCall`'s throw path (handler error → secret
 *   redaction + throttled re-logging).
 * - `resolveTimeoutMs` fallback for 0/negative/NaN/Infinity.
 * - `cdp-controller` attach/detach/click/press-and-hold with a stubbed
 *   `chrome.debugger` (the module itself is never imported by other tests).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { CallbackDispatcher } from "../src/lib/agent/callbacks";
import { resolveTimeoutMs } from "../src/lib/agent/human-interaction-utils";
import {
  attachDebugger,
  detachDebugger,
  cdpClick,
  cdpMoveMousePath,
  cdpPressAndHold,
} from "../src/lib/agent/cdp-controller";
import type { CallbackContext } from "../src/lib/agent/callbacks-utils";

const ctx: CallbackContext = { task: "test task", step: 0, history: [] };

// ─── CallbackDispatcher.safeCall throw path ─────────────────────────────────

describe("CallbackDispatcher.safeCall throw path", () => {
  let dispatcher: CallbackDispatcher;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dispatcher = new CallbackDispatcher();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test("a throwing handler resolves the hook and logs a secret-redacted error", async () => {
    const handler = {
      onRunStart: () => {
        throw new Error("boom sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456");
      },
    };
    dispatcher.register(handler);

    await expect(dispatcher.runStart(ctx)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls[0].map(String).join(" ");
    // The raw key must never reach the console.
    expect(logged).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456");
    expect(logged).toContain("[REDACTED]");
    expect(logged).toContain("onRunStart");
  });

  test("errors stay masked when the secret store is unavailable (fail-closed marker)", async () => {
    // `redactSecrets` fails closed: when the secret store is broken it returns
    // a marker instead of the raw error. The log must never echo the key even
    // under store failure.
    const handler = {
      onRunStart: () => {
        throw new Error("sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456 leaked");
      },
    };
    dispatcher.register(handler);
    // redactSecrets reads from localStorage; point it at a store that throws.
    const origGetItem = localStorage.getItem;
    localStorage.getItem = () => {
      throw new Error("storage broken");
    };
    try {
      await dispatcher.runStart(ctx);
      const logged = errorSpy.mock.calls[0].map(String).join(" ");
      expect(logged).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456");
      expect(logged).toContain("[REDACTED]");
    } finally {
      localStorage.getItem = origGetItem;
    }
  });

  test("a persistently throwing handler is re-logged on a throttle, not every call", async () => {
    const handler = {
      onRunStart: () => {
        throw new Error("always broken");
      },
    };
    dispatcher.register(handler);

    for (let i = 0; i < 11; i++) {
      await dispatcher.runStart(ctx);
    }

    // First failure logs immediately; then every 10th occurrence re-logs.
    // 11 calls → logs at counts 1 and 10 → 2 log lines.
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  test("a handler that throws on one hook does not affect other hooks or handlers", async () => {
    const bad = { onRunStart: () => { throw new Error("bad hook"); } };
    const good = {
      onRunStart: vi.fn(async () => {}),
    };
    dispatcher.register(bad);
    dispatcher.register(good);

    await dispatcher.runStart(ctx);

    expect(good.onRunStart).toHaveBeenCalledTimes(1);
  });
});

// ─── resolveTimeoutMs fallback ──────────────────────────────────────────────

describe("resolveTimeoutMs", () => {
  const DEFAULT_MS = 5 * 60 * 1000;

  test("accepts a positive finite override", () => {
    expect(resolveTimeoutMs(1234)).toBe(1234);
    expect(resolveTimeoutMs(0.5)).toBe(0.5);
  });

  test("falls back to the default for 0, negative, NaN, Infinity, and undefined", () => {
    expect(resolveTimeoutMs(0)).toBe(DEFAULT_MS);
    expect(resolveTimeoutMs(-1)).toBe(DEFAULT_MS);
    expect(resolveTimeoutMs(Number.NaN)).toBe(DEFAULT_MS);
    expect(resolveTimeoutMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_MS);
    expect(resolveTimeoutMs(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_MS);
    expect(resolveTimeoutMs(undefined)).toBe(DEFAULT_MS);
  });
});

// ─── cdp-controller with stubbed chrome.debugger ───────────────────────────

describe("cdp-controller", () => {
  let attach: ReturnType<typeof vi.fn>;
  let detach: ReturnType<typeof vi.fn>;
  let sendCommand: ReturnType<typeof vi.fn>;
  let originalChrome: unknown;

  function installDebuggerStub(): void {
    attach = vi.fn(async () => {});
    detach = vi.fn(async () => {});
    sendCommand = vi.fn(async () => {});
    (globalThis as unknown as { chrome: unknown }).chrome = {
      debugger: { attach, detach, sendCommand },
    };
  }

  beforeEach(() => {
    originalChrome = (globalThis as unknown as { chrome?: unknown }).chrome;
    installDebuggerStub();
  });

  afterEach(() => {
    if (originalChrome === undefined) {
      delete (globalThis as unknown as { chrome?: unknown }).chrome;
    } else {
      (globalThis as unknown as { chrome: unknown }).chrome = originalChrome;
    }
    vi.useRealTimers();
  });

  describe("attachDebugger", () => {
    test("attaches with the CDP protocol version and reports success", async () => {
      await expect(attachDebugger(42)).resolves.toBe(true);
      expect(attach).toHaveBeenCalledWith({ tabId: 42 }, "1.3");
    });

    test("already-attached errors are treated as success", async () => {
      attach.mockRejectedValue(new Error("Debugger is already attached to the tab"));
      await expect(attachDebugger(42)).resolves.toBe(true);
    });

    test("other attach errors propagate", async () => {
      attach.mockRejectedValue(new Error("Cannot access a chrome:// URL"));
      await expect(attachDebugger(42)).rejects.toThrow("chrome://");
    });
  });

  describe("detachDebugger", () => {
    test("detaches successfully", async () => {
      await expect(detachDebugger(42)).resolves.toBeUndefined();
      expect(detach).toHaveBeenCalledWith({ tabId: 42 });
    });

    test("already-detached errors are benign (no warn, no rethrow)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        detach.mockRejectedValue(new Error("No debugger is already detached from the tab"));
        await expect(detachDebugger(42)).resolves.toBeUndefined();
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("other detach errors are logged, not rethrown (cleanup path)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        detach.mockRejectedValue(new Error("detach exploded"));
        await expect(detachDebugger(42)).resolves.toBeUndefined();
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe("cdpClick", () => {
    test("dispatches move → press → release with default params and a settle delay", async () => {
      vi.useFakeTimers();
      const p = cdpClick(7, 100, 200);
      await vi.advanceTimersByTimeAsync(150);
      await p;

      expect(sendCommand).toHaveBeenCalledTimes(3);
      expect(sendCommand).toHaveBeenNthCalledWith(
        1,
        { tabId: 7 },
        "Input.dispatchMouseEvent",
        { type: "mouseMoved", x: 100, y: 200, modifiers: 0 },
      );
      expect(sendCommand).toHaveBeenNthCalledWith(
        2,
        { tabId: 7 },
        "Input.dispatchMouseEvent",
        { type: "mousePressed", x: 100, y: 200, button: "left", buttons: 1, clickCount: 1, modifiers: 0 },
      );
      expect(sendCommand).toHaveBeenNthCalledWith(
        3,
        { tabId: 7 },
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", x: 100, y: 200, button: "left", buttons: 0, clickCount: 1, modifiers: 0 },
      );
    });

    test("honors button, clickCount, and modifier options", async () => {
      vi.useFakeTimers();
      const p = cdpClick(7, 10, 20, { button: "right", clickCount: 2, modifiers: "Shift+Ctrl" });
      await vi.advanceTimersByTimeAsync(150);
      await p;

      const pressed = sendCommand.mock.calls[1][2] as Record<string, unknown>;
      expect(pressed.button).toBe("right");
      expect(pressed.buttons).toBe(2); // right-button mask
      expect(pressed.clickCount).toBe(2);
      expect(pressed.modifiers).toBe(10); // SHIFT(8) | CTRL(2)

      const released = sendCommand.mock.calls[2][2] as Record<string, unknown>;
      expect(released.buttons).toBe(0);
      expect(released.modifiers).toBe(10);
    });
  });

  describe("cdpPressAndHold", () => {
    test("dispatches move → press → release with the hold timing between press and release", async () => {
      vi.useFakeTimers();
      const p = cdpPressAndHold(7, 50, 60, { delay: 50, holdMs: 200 });
      await vi.advanceTimersByTimeAsync(400);
      await p;

      expect(sendCommand).toHaveBeenCalledTimes(3);
      expect(sendCommand).toHaveBeenNthCalledWith(
        1,
        { tabId: 7 },
        "Input.dispatchMouseEvent",
        { type: "mouseMoved", x: 50, y: 60, button: "none" },
      );
      expect(sendCommand).toHaveBeenNthCalledWith(
        2,
        { tabId: 7 },
        "Input.dispatchMouseEvent",
        { type: "mousePressed", x: 50, y: 60, button: "left", buttons: 1, clickCount: 1 },
      );
      // The release is the LAST command — it must not dispatch before the
      // hold delay elapses (a premature release would break the gesture).
      expect(sendCommand).toHaveBeenNthCalledWith(
        3,
        { tabId: 7 },
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", x: 50, y: 60, button: "left", buttons: 0, clickCount: 1 },
      );
    });
  });

  describe("cdpMoveMousePath", () => {
    function mouseEvents(): Array<{ type: string; x: number; y: number }> {
      return sendCommand.mock.calls
        .filter((c) => c[1] === "Input.dispatchMouseEvent")
        .map((c) => c[2] as { type: string; x: number; y: number });
    }

    test("moves through ≥2 interpolated steps with monotonic ease-out easing", async () => {
      vi.useFakeTimers();
      const p = cdpMoveMousePath(7, 0, 0, 500, 0, { durationMs: 500 });
      await vi.advanceTimersByTimeAsync(1000);
      await p;

      const moved = mouseEvents().filter((e) => e.type === "mouseMoved");
      // distance 500 → steps = max(floor(500/50), 10) = 10
      expect(moved.length).toBe(10);
      const xs = moved.map((e) => e.x);
      // Strictly non-decreasing travel with room for the ±1px step noise.
      for (let i = 1; i < xs.length; i++) {
        expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1] - 1.01);
      }
      // Ease-out: the early step covers visibly more ground than the final
      // step (fast start, slow landing).
      expect(xs[1] - xs[0]).toBeGreaterThan(xs[xs.length - 1] - xs[xs.length - 2] + 5);
      // The final event lands within the ±3px target jitter of (500, 0).
      expect(Math.abs(xs[xs.length - 1] - 500)).toBeLessThanOrEqual(3);
      const ys = moved.map((e) => e.y);
      expect(Math.abs(ys[ys.length - 1] - 0)).toBeLessThanOrEqual(3);
    });

    test("short distances still produce the 10-step minimum", async () => {
      vi.useFakeTimers();
      const p = cdpMoveMousePath(7, 0, 0, 30, 0, { durationMs: 300 });
      await vi.advanceTimersByTimeAsync(1000);
      await p;
      expect(mouseEvents().filter((e) => e.type === "mouseMoved").length).toBe(10);
    });

    test("default randomized duration stays within human bounds", async () => {
      vi.useFakeTimers();
      const timerSpy = vi.spyOn(globalThis, "setTimeout");
      const p = cdpMoveMousePath(7, 0, 0, 500, 0);
      await vi.advanceTimersByTimeAsync(1000);
      await p;
      const delays = timerSpy.mock.calls.map((c) => c[1] as number);
      // 10 steps, each sleeping durationMs/10 with durationMs ∈ [200, 600).
      expect(delays.length).toBe(10);
      for (const d of delays) {
        expect(d).toBeGreaterThanOrEqual(20);
        expect(d).toBeLessThanOrEqual(60);
      }
    });
  });

  describe("cdpClick with the path option", () => {
    function mouseEvents(): Array<{ type: string; x: number; y: number }> {
      return sendCommand.mock.calls
        .filter((c) => c[1] === "Input.dispatchMouseEvent")
        .map((c) => c[2] as { type: string; x: number; y: number });
    }

    test("approaches the target through a multi-step path and presses at the landing point", async () => {
      vi.useFakeTimers();
      const p = cdpClick(7, 100, 200, { path: true });
      await vi.advanceTimersByTimeAsync(2000);
      await p;

      const events = mouseEvents();
      const moved = events.filter((e) => e.type === "mouseMoved");
      const pressed = events.find((e) => e.type === "mousePressed");
      expect(moved.length).toBeGreaterThanOrEqual(2);
      expect(pressed).toBeDefined();
      // The press follows the path's final (jittered) position — within ±3px.
      expect(Math.abs((pressed as { x: number }).x - 100)).toBeLessThanOrEqual(3);
      expect(Math.abs((pressed as { y: number }).y - 200)).toBeLessThanOrEqual(3);
    });

    test("a subsequent path click starts from the previous cursor position", async () => {
      vi.useFakeTimers();
      const p1 = cdpClick(7, 100, 200, { path: true });
      await vi.advanceTimersByTimeAsync(2000);
      await p1;
      sendCommand.mockClear();

      const p2 = cdpClick(7, 500, 200, { path: true });
      await vi.advanceTimersByTimeAsync(2000);
      await p2;

      const moved = mouseEvents().filter((e) => e.type === "mouseMoved");
      // First step travels ~19% of the 400px distance from (100,200) — well
      // past the 95px a path from the origin would have reached.
      expect(moved[0].x).toBeGreaterThan(150);
    });
  });
});
