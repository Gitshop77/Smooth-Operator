/**
 * `createMutex` serializes async read-modify-write sequences.
 *
 * Regression: the internal release chain used `void run.finally(() => release())`.
 * When `fn` rejected, the discarded `run.finally(...)` side-promise ALSO
 * rejected with the original error and was never awaited or caught — an
 * unhandled rejection on every failed critical section, even when the caller
 * catches the returned promise. The release must run on BOTH paths without
 * leaking a rejection.
 */
import { describe, test, expect } from "vitest";
import { createMutex } from "../src/lib/agent/mutex";

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("createMutex", () => {
  test("does not leak an unhandled rejection when a critical section throws", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
    const mutex = createMutex<string>();
      await mutex(async () => {
        throw new Error("boom");
      }).catch(() => {
        /* caller handles the rejection */
      });
      // Drain the microtask + timer queue so a leaked side-promise rejection
      // would have fired by now.
      await tick();
      await Promise.resolve();
      expect(unhandled).toHaveLength(0);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  test("still serializes callers, and the lock is released after a failure", async () => {
    const mutex = createMutex<string>();
    const order: string[] = [];
    const p1 = mutex(async () => {
      order.push("a-start");
      await tick();
      order.push("a-end");
      return "A";
    }).catch(() => "A-failed");
    const p2 = mutex(async () => {
      order.push("b");
      return "B";
    }).catch(() => "B-failed");
    const p3 = mutex(async () => {
      throw new Error("boom");
    }).catch(() => "C-failed");
    // The failed critical section must not deadlock the chain: a caller
    // queued after it still runs.
    const p4 = mutex(async () => {
      order.push("d");
      return "D";
    }).catch(() => "D-failed");

    const results = await Promise.all([p1, p2, p3, p4]);
    expect(order).toEqual(["a-start", "a-end", "b", "d"]);
    expect(results).toEqual(["A", "B", "C-failed", "D"]);
  });
});
