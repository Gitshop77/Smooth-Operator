import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  RUN_STATE_KEY,
  resetRunStateStoreForTests,
  type RunState,
} from "../src/extension/background/state-store";
import { RunSessionStateService } from "../src/extension/background/run-session-state";

const stateFor = (runId?: string): RunState => ({
  ...(runId ? { runId, dispatchRevision: 1 } : {}),
  task: "task",
  maxSteps: 10,
  mode: "standard",
  startTabId: 1,
  currentTabId: 1,
  step: 0,
  active: true,
  abortRequested: false,
});

let store: Record<string, unknown>;
let storageListener: (
  changes: { [key: string]: chrome.storage.StorageChange },
  area: string,
) => void;

beforeEach(() => {
  store = {};
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(store, values); }),
        remove: vi.fn(async (key: string) => { delete store[key]; }),
      },
      onChanged: {
        addListener: vi.fn((listener: typeof storageListener) => { storageListener = listener; }),
      },
    },
  };
  resetRunStateStoreForTests();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
  vi.clearAllMocks();
});

describe("RunSessionStateService authority", () => {
  test("legacy and mismatched state remain recovery-only", async () => {
    const service = new RunSessionStateService();
    store[RUN_STATE_KEY] = stateFor();
    expect(await service.readForRun({ runId: "current" })).toBeNull();

    resetRunStateStoreForTests();
    store[RUN_STATE_KEY] = stateFor("predecessor");
    expect(await service.readForRun({ runId: "successor" })).toBeNull();
    expect(await service.readForRun({ runId: "predecessor" })).toMatchObject({
      runId: "predecessor",
      version: 1,
    });
  });

  test("a queued predecessor patch cannot alter successor state", async () => {
    const service = new RunSessionStateService();
    store[RUN_STATE_KEY] = stateFor("successor");

    await expect(service.patch({ runId: "predecessor" }, { currentTabId: 99 }))
      .rejects.toThrow("run-state authority mismatch");
    expect(store[RUN_STATE_KEY]).toMatchObject({
      runId: "successor",
      currentTabId: 1,
    });
  });

  test("predecessor cleanup cannot erase successor state", async () => {
    const service = new RunSessionStateService();
    store[RUN_STATE_KEY] = stateFor("successor");

    await expect(service.clear({ runId: "predecessor" }))
      .rejects.toThrow("run-state authority mismatch");
    expect(store[RUN_STATE_KEY]).toMatchObject({ runId: "successor" });
  });

  test("only a matching run abort notification can stop the listener", () => {
    const service = new RunSessionStateService();
    const controller = new AbortController();
    service.wireAbort(controller, { runId: "current" });

    storageListener({
      [RUN_STATE_KEY]: { newValue: { abortRequested: true } },
    }, "session");
    storageListener({
      [RUN_STATE_KEY]: { newValue: { runId: "predecessor", abortRequested: true } },
    }, "session");
    expect(controller.signal.aborted).toBe(false);

    storageListener({
      [RUN_STATE_KEY]: { newValue: { runId: "current", abortRequested: true } },
    }, "session");
    expect(controller.signal.aborted).toBe(true);
  });

  test("initialization preserves only a pre-admission STOP latch", async () => {
    const service = new RunSessionStateService();
    store[RUN_STATE_KEY] = {
      ...stateFor(),
      task: "",
      active: false,
      abortRequested: true,
      currentTabId: 99,
      step: 7,
    };

    await service.initialize({ ...stateFor("current"), runId: "current", currentTabId: 2 });
    expect(store[RUN_STATE_KEY]).toMatchObject({
      runId: "current",
      abortRequested: true,
      currentTabId: 2,
      step: 0,
    });
  });
});
