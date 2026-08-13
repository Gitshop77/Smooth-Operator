/**
 * tab-manager.ts — `waitForTabLoad` failure semantics.
 *
 * Pins the hardened contract:
 *  - resolves when the tab reports `status: complete` (onUpdated or an
 *    already-complete tabs.get),
 *  - REJECTS with a distinct error when the tab is REMOVED mid-wait (a closed
 *    tab can never finish loading — the caller must not proceed against it),
 *  - REJECTS when tabs.get reports the tab is gone ("No tab with id"),
 *  - keeps the historical RESOLVE on timeout and on transient chrome errors.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

import { waitForTabLoad } from "../src/extension/background/tab-manager";

type UpdateListener = (id: number, info: { status: string }) => void;
type RemoveListener = (id: number) => void;

function installChrome(opts: {
  getStatus?: string;
  getRejects?: Error;
} = {}) {
  const onUpdatedCbs: UpdateListener[] = [];
  const onRemovedCbs: RemoveListener[] = [];
  const chromeMock = {
    tabs: {
      onUpdated: {
        addListener: (cb: UpdateListener) => { onUpdatedCbs.push(cb); },
        removeListener: (cb: UpdateListener) => {
          const i = onUpdatedCbs.indexOf(cb);
          if (i >= 0) onUpdatedCbs.splice(i, 1);
        },
      },
      onRemoved: {
        addListener: (cb: RemoveListener) => { onRemovedCbs.push(cb); },
        removeListener: (cb: RemoveListener) => {
          const i = onRemovedCbs.indexOf(cb);
          if (i >= 0) onRemovedCbs.splice(i, 1);
        },
      },
      get: vi.fn((_id: number) => {
        if (opts.getRejects) return Promise.reject(opts.getRejects);
        return Promise.resolve({ status: opts.getStatus ?? "loading" });
      }),
    },
  };
  (globalThis as Record<string, unknown>).chrome = chromeMock as never;
  return { onUpdatedCbs, onRemovedCbs };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).chrome;
});

describe("waitForTabLoad", () => {
  test("resolves when the tab reports status complete", async () => {
    const { onUpdatedCbs } = installChrome({ getStatus: "loading" });
    const p = waitForTabLoad(7, 8000);
    onUpdatedCbs.forEach((cb) => cb(7, { status: "complete" }));
    await expect(p).resolves.toBeUndefined();
  });

  test("resolves immediately when tabs.get already reports complete", async () => {
    installChrome({ getStatus: "complete" });
    await expect(waitForTabLoad(7, 8000)).resolves.toBeUndefined();
  });

  test("REJECTS with a distinct error when the tab is removed mid-wait", async () => {
    const { onRemovedCbs } = installChrome({ getStatus: "loading" });
    const p = waitForTabLoad(7, 8000);
    onRemovedCbs.forEach((cb) => cb(7));
    await expect(p).rejects.toThrow(/closed before it finished loading/);
  });

  test("REJECTS with a distinct error when tabs.get reports the tab is gone", async () => {
    installChrome({ getRejects: new Error("No tab with id: 7.") });
    await expect(waitForTabLoad(7, 8000)).rejects.toThrow(/closed before it finished loading/);
  });

  test("resolves on timeout (historical behavior — SPA/lazy pages may outlive the wait)", async () => {
    installChrome({ getStatus: "loading" });
    const p = waitForTabLoad(7, 8000);
    await vi.advanceTimersByTimeAsync(8_001);
    await expect(p).resolves.toBeUndefined();
  });

  test("resolves on a transient (non-missing-tab) chrome error", async () => {
    installChrome({ getRejects: new Error("chrome.runtime.lastError: random blip") });
    await expect(waitForTabLoad(7, 8000)).resolves.toBeUndefined();
  });
});
