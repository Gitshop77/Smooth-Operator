/**
 * state-store.ts — saveRunState write-failure resilience.
 *
 * `saveRunState` must not let the optimistic cache diverge from storage: if
 * `chrome.storage.session.set` throws, the cache is cleared (so the abort
 * listener — which reads via `getRunState` — never sees state storage never
 * received) and the error propagates to the caller.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { clearRunState, getRunState, saveRunState, RUN_STATE_KEY } from "../src/extension/background/state-store";

interface SessionStub {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

/**
 * Session stub that stores run state under RUN_STATE_KEY (the shape
 * `getRunState` actually reads). `getImpl`/`setImpl` let a test simulate
 * storage failures; a successful set commits the value.
 */
function installSessionStub(opts: {
  initial?: Record<string, unknown>;
  getImpl?: () => Promise<Record<string, unknown>>;
  setImpl?: (value: Record<string, unknown>) => Promise<void>;
}): SessionStub {
  const { initial = {}, getImpl, setImpl } = opts;
  let store = initial;
  const get = vi.fn(async () => {
    if (getImpl) return getImpl();
    return { [RUN_STATE_KEY]: store };
  });
  const set = vi.fn(async (value: Record<string, unknown>) => {
    if (setImpl) await setImpl(value);
    store = (value[RUN_STATE_KEY] as Record<string, unknown> | undefined) ?? {};
  });
  const remove = vi.fn(async () => {
    store = {};
  });
  (globalThis as Record<string, unknown>).chrome = {
    storage: { session: { get, set, remove }, local: { get: vi.fn(async () => ({})) } },
    alarms: { create: vi.fn(), clear: vi.fn() },
    power: { requestKeepAwake: vi.fn(), releaseKeepAwake: vi.fn() },
  };
  return { get, set, remove };
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  // Drop any module-level run-state cache left by a previous test so each
  // test starts from a cold `getRunState` (the stub is reinstalled per test).
  await clearRunState().catch(() => {});
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
  consoleErrorSpy.mockRestore();
});

const validState = {
  task: "t", maxSteps: 10, mode: "standard", startTabId: 1, currentTabId: 1,
  step: 0, active: true, abortRequested: false,
};

describe("saveRunState write-failure resilience", () => {
  test("rejects when storage.set throws", async () => {
    const session = installSessionStub({
      initial: validState,
      setImpl: async () => {
        throw new Error("storage unavailable");
      },
    });
    await expect(saveRunState({ step: 3 })).rejects.toThrow("storage unavailable");
    expect(session.set).toHaveBeenCalled();
  });

  test("clears the optimistic cache on set failure — next getRunState reads storage fresh", async () => {
    const stored = { ...validState, step: 2 };
    const session = installSessionStub({
      initial: stored,
      setImpl: async () => {
        throw new Error("storage unavailable");
      },
    });
    // Prime the cache with a successful read.
    await getRunState();

    await expect(saveRunState({ step: 3 })).rejects.toThrow("storage unavailable");

    // The cache must NOT serve the failed `next` (step 3): the follow-up read
    // re-queries storage and sees the previously persisted value.
    session.get.mockClear();
    const after = await getRunState();
    expect(after?.step).toBe(2);
    expect(session.get).toHaveBeenCalled();
  });

  test("a successful write still populates the cache", async () => {
    const session = installSessionStub({ initial: validState });
    await saveRunState({ step: 5 });
    session.get.mockClear();
    const after = await getRunState();
    expect(after?.step).toBe(5);
    expect(session.get).not.toHaveBeenCalled(); // served from cache
  });

  test("abortRequested survives into the next write (merge is monotonic)", async () => {
    const session = installSessionStub({ initial: validState });
    await saveRunState({ abortRequested: true });
    await saveRunState({ step: 1 });
    expect((session.set.mock.calls[1][0] as Record<string, unknown>)[RUN_STATE_KEY]).toMatchObject({
      abortRequested: true,
      step: 1,
    });
  });

  test("getRunState throws when storage.get is unavailable (no catch)", async () => {
    installSessionStub({
      getImpl: async () => {
        throw new Error("storage unavailable");
      },
    });
    await expect(getRunState()).rejects.toThrow("storage unavailable");
  });
});
