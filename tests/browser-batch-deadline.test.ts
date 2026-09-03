import { describe, expect, it, vi } from "vitest";

import { BrowserService } from "@/server/browser/service";
import type { BrowserAction } from "@/server/contracts";
import { Logger } from "@/server/logger";
import { SecurityPolicy } from "@/server/policy";
import { testConfig } from "./helpers";

function fixture(actionTimeoutMs = 1_000) {
  const config = testConfig({ browser: { ...testConfig().browser, actionTimeoutMs } });
  const service = new BrowserService(config, new SecurityPolicy(config), new Logger("error", {}, () => undefined));
  const internal = service as unknown as {
    executeUnlocked(action: BrowserAction, signal?: AbortSignal): Promise<unknown>;
    lifecycleGeneration: number;
  };
  return { service, internal };
}

describe("batch action deadlines", () => {
  it.each(["wait", "press_and_hold"] as const)("allows a requested %s duration longer than the action default", async (action) => {
    vi.useFakeTimers();
    const { service, internal } = fixture(100);
    internal.executeUnlocked = async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { done: true };
    };
    try {
      const pending = service.execute(action === "wait"
        ? { action, milliseconds: 500 }
        : { action, selector: "#control", durationMs: 500 });
      await vi.advanceTimersByTimeAsync(500);
      await expect(pending).resolves.toEqual({ done: true });
    } finally {
      await service.close();
      vi.useRealTimers();
    }
  });

  it("stops at the step deadline and retires uncooperative work before the next request", async () => {
    vi.useFakeTimers();
    const { service, internal } = fixture();
    const calls: string[] = [];
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => { release = resolve; });
    internal.executeUnlocked = async (action) => {
      calls.push(action.action);
      if (action.action === "evaluate") await stalled;
      return { done: action.action };
    };
    try {
      const batch = service.executeBatch([
        { action: "wait", milliseconds: 0 },
        { action: "evaluate", code: "await never()", timeoutMs: 100 },
        { action: "click", selector: "#must-not-run" },
      ], { confirmDestructive: true }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      const next = service.execute({ action: "wait", milliseconds: 0 });
      await vi.advanceTimersByTimeAsync(349);
      expect(calls).toEqual(["wait", "evaluate"]);
      await vi.advanceTimersByTimeAsync(2);
      expect(await batch).toMatchObject({ code: "BROWSER_TIMEOUT", details: { timeoutMs: 100, failedIndex: 1, failedAction: "evaluate", completedActions: 1 } });
      expect(internal.lifecycleGeneration).toBeGreaterThan(0);
      await expect(next).resolves.toEqual({ done: "wait" });
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(["wait", "evaluate", "wait"]);
    } finally {
      release();
      await service.close();
      vi.useRealTimers();
    }
  });

  it("respects an explicit step timeout longer than the server default", async () => {
    vi.useFakeTimers();
    const { service, internal } = fixture(100);
    internal.executeUnlocked = async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { done: true };
    };
    try {
      const batch = service.executeBatch([{ action: "wait", milliseconds: 250, timeoutMs: 1_000 }]);
      await vi.advanceTimersByTimeAsync(250);
      await expect(batch).resolves.toEqual({ results: [{ done: true }] });
    } finally {
      await service.close();
      vi.useRealTimers();
    }
  });

  it("cancels a batch without advancing to its next mutation", async () => {
    vi.useFakeTimers();
    const { service, internal } = fixture();
    const calls: string[] = [];
    internal.executeUnlocked = async (action) => {
      calls.push(action.action);
      return new Promise(() => undefined);
    };
    try {
      const controller = new AbortController();
      const batch = service.executeBatch([
        { action: "wait" }, { action: "click", selector: "#must-not-run" },
      ], {}, controller.signal).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(300);
      expect(await batch).toMatchObject({ code: "CANCELLED" });
      expect(calls).toEqual(["wait"]);
    } finally {
      await service.close();
      vi.useRealTimers();
    }
  });

  it("allows the documented default human-wait timeout to return its result", async () => {
    vi.useFakeTimers();
    const { service, internal } = fixture();
    internal.executeUnlocked = async () => {
      await new Promise((resolve) => setTimeout(resolve, 120_000));
      return { status: "timed_out" };
    };
    try {
      const waiting = service.execute({ action: "wait_for_human" });
      await vi.advanceTimersByTimeAsync(120_000);
      await expect(waiting).resolves.toEqual({ status: "timed_out" });
    } finally {
      await service.close();
      vi.useRealTimers();
    }
  });
});
