import { describe, expect, it } from "vitest";

import { AppError } from "@/server/errors";
import { BrowserOperationQueue, MAX_QUEUED_OPERATIONS, combineSignals, throwIfAborted } from "@/server/browser/queue";

function host(overrides: Partial<ConstructorParameters<typeof BrowserOperationQueue>[0]> = {}) {
  return new BrowserOperationQueue({
    shutdownSignal: () => new AbortController().signal,
    recoverAfterAbort: async () => undefined,
    normalizeError: (error) => error,
    ...overrides,
  });
}

describe("browser operation queue", () => {
  it("throws CANCELLED when the signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrowError(/cancelled/i);
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });

  it("combines abort signals without dropping a live one", () => {
    const first = new AbortController();
    const second = new AbortController();
    expect(combineSignals(undefined, undefined)).toBeUndefined();
    expect(combineSignals(first.signal)).toBe(first.signal);
    const combined = combineSignals(undefined, first.signal, second.signal);
    expect(combined).toBeDefined();
    second.abort();
    expect(combined?.aborted).toBe(true);
  });

  it("serializes exclusive operations so a later waiter cannot start until the first releases", async () => {
    const queue = host();
    let firstStarted = false;
    let secondStarted = false;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.run(undefined, async () => {
      firstStarted = true;
      await firstGate;
      return "one";
    }, 5_000, 5_000, "exclusive");
    const second = queue.run(undefined, async () => {
      secondStarted = true;
      return "two";
    }, 5_000, 5_000, "exclusive");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(firstStarted).toBe(true);
    expect(secondStarted).toBe(false);
    releaseFirst();
    await expect(first).resolves.toBe("one");
    await expect(second).resolves.toBe("two");
    expect(secondStarted).toBe(true);
  });

  it("rejects admission when the exclusive lane is already full", async () => {
    const queue = host();
    queue.queuedOperations = MAX_QUEUED_OPERATIONS;
    await expect(queue.run(undefined, async () => "late", 1_000, 1_000, "exclusive")).rejects.toMatchObject({ code: "BROWSER_QUEUE_FULL" });
  });

  it("does not let a timed-out operation release another request's lock early", async () => {
    const recovered: unknown[] = [];
    const queue = host({
      recoverAfterAbort: async (operation) => {
        recovered.push(operation);
        await new Promise((resolve) => setTimeout(resolve, 40));
      },
    });
    let secondStartedAt = 0;
    const first = queue.run(undefined, async (signal) => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
        });
      });
      if (signal.aborted) {
        throw new AppError("CANCELLED", "The browser action was cancelled.");
      }
      return "slow";
    }, 5_000, 20, "exclusive");
    const second = queue.run(undefined, async () => {
      secondStartedAt = Date.now();
      return "next";
    }, 5_000, 5_000, "exclusive");
    const started = Date.now();
    await expect(first).rejects.toMatchObject({ code: "BROWSER_TIMEOUT" });
    await expect(second).resolves.toBe("next");
    expect(recovered).toHaveLength(1);
    expect(secondStartedAt - started).toBeGreaterThanOrEqual(40);
  });

  it("times out a waiter instead of starting it after the queue deadline", async () => {
    const queue = host();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.run(undefined, async () => {
      await firstGate;
      return "one";
    }, 5_000, 5_000, "exclusive");
    const late = queue.run(undefined, async () => "two", 15, 15, "exclusive");
    await expect(late).rejects.toMatchObject({ code: "BROWSER_QUEUE_TIMEOUT" });
    releaseFirst();
    await expect(first).resolves.toBe("one");
  });

  it("fails a queued waiter when the session generation advances", async () => {
    const queue = host();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.run(undefined, async () => {
      await firstGate;
      return "one";
    }, 5_000, 5_000, "exclusive");
    const second = queue.run(undefined, async () => "two", 5_000, 5_000, "exclusive");
    await new Promise((resolve) => setTimeout(resolve, 20));
    queue.bumpSession();
    releaseFirst();
    await expect(first).resolves.toBe("one");
    await expect(second).rejects.toMatchObject({ code: "SESSION_CLOSED" });
  });
});
