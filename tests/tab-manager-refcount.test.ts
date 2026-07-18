/**
 * tab-manager.ts — debugger refcount acquire/release concurrency.
 *
 * Pins the core anti-race control : the refcount is bumped
 * before await, a concurrent "already attached" error is swallowed, and only
 * the last releaser detaches. Also that a genuine attach failure rolls back
 * only its own refcount and that releasing a zero refcount is a no-op.
 */

import { describe, test, expect, vi } from "vitest";
import {
  acquirePageDebugger,
  releasePageDebugger,
} from "../src/extension/background/tab-manager";

describe("debugger refcount", () => {
  test("two concurrent acquires both succeed and only one detach fires", async () => {
    let attachCalls = 0;
    const attach = vi.fn(async (_id: number) => {
      attachCalls += 1;
      if (attachCalls > 1) throw new Error("already attached");
    });
    const detach = vi.fn(async () => {});

    await Promise.all([
      acquirePageDebugger(1, attach),
      acquirePageDebugger(1, attach),
    ]);

    await Promise.all([
      releasePageDebugger(1, detach),
      releasePageDebugger(1, detach),
    ]);

    expect(attachCalls).toBeGreaterThanOrEqual(1);
    expect(detach).toHaveBeenCalledTimes(1);
  });

  test("genuine attach failure rolls back only its own refcount", async () => {
    const badAttach = vi.fn(async () => {
      throw new Error("permission denied");
    });
    await expect(acquirePageDebugger(2, badAttach)).rejects.toThrow("permission denied");

    const goodAttach = vi.fn(async () => {});
    const detach = vi.fn(async () => {});
    await acquirePageDebugger(2, goodAttach);
    expect(goodAttach).toHaveBeenCalledTimes(1);

    await releasePageDebugger(2, detach);
    expect(detach).toHaveBeenCalledTimes(1);
  });

  test("release on a zero refcount is a no-op", async () => {
    const detach = vi.fn(async () => {});
    await releasePageDebugger(9, detach);
    expect(detach).not.toHaveBeenCalled();
  });
});
