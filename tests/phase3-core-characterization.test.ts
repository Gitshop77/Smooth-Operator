/**
 * Phase 3 characterization — scheduler mutation, recovery history, and
 * credential/session boundaries that must remain true before Phase 4 changes
 * their implementation seams.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeChromeStorageMock } from "./helpers/chrome-storage-mock";
import type { ScheduledTask } from "../src/lib/agent/scheduled-tasks";
import type { RunSnapshotV1 } from "../src/extension/background/run-controller";

const SCHEDULED_TASKS_KEY = "open_cowork_scheduled_tasks";

function task(enabled: boolean): ScheduledTask {
  return {
    id: "same-task",
    task: "use only fake-fixture-value",
    schedule: { type: "interval", intervalMinutes: 30 },
    enabled,
    createdAt: 1_700_000_000_000,
  };
}

describe("Phase 3 scheduler mutation characterization", () => {
  let storage: Record<string, unknown>;
  let activeAlarms: Set<string>;
  let saveScheduledTask: typeof import("../src/lib/agent/scheduled-tasks")["saveScheduledTask"];

  beforeEach(async () => {
    vi.resetModules();
    storage = {};
    activeAlarms = new Set<string>();
    (globalThis as { chrome?: unknown }).chrome = {
      alarms: {
        create: vi.fn(async (name: string) => {
          activeAlarms.add(name);
        }),
        clear: vi.fn(async (name: string) => {
          activeAlarms.delete(name);
          return true;
        }),
        get: vi.fn(async () => undefined),
        getAll: vi.fn(async () => []),
        onAlarm: { addListener: vi.fn() },
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storage, value)),
          remove: vi.fn(async (key: string) => { delete storage[key]; }),
        },
      },
      power: {
        requestKeepAwake: vi.fn(),
        releaseKeepAwake: vi.fn(),
      },
    };
    ({ saveScheduledTask } = await import("../src/lib/agent/scheduled-tasks"));
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  test("same-context enable then disable mutations serialize, leaving neither a live alarm nor nextRunAt", async () => {
    // Hold the first arm inside the module's critical section. The disable
    // must queue behind it, then perform the final durable state + clear.
    let releaseFirstCreate!: () => void;
    let firstCreateStarted!: () => void;
    const firstCreate = new Promise<void>((resolve) => { firstCreateStarted = resolve; });
    const chromeMock = globalThis.chrome as unknown as { alarms: { create: ReturnType<typeof vi.fn> } };
    chromeMock.alarms.create.mockImplementationOnce(async (name: string) => {
      activeAlarms.add(name);
      firstCreateStarted();
      await new Promise<void>((resolve) => { releaseFirstCreate = resolve; });
    });

    const enabling = saveScheduledTask(task(true));
    await firstCreate;
    const disabling = saveScheduledTask(task(false));

    // The queued edit cannot observe or write around the in-flight arm.
    expect((storage[SCHEDULED_TASKS_KEY] as ScheduledTask[])[0]).toMatchObject({ enabled: true });
    releaseFirstCreate();
    await Promise.all([enabling, disabling]);

    expect(storage[SCHEDULED_TASKS_KEY]).toEqual([
      expect.objectContaining({ id: "same-task", enabled: false, nextRunAt: undefined }),
    ]);
    expect(activeAlarms.has("open_cowork_scheduled_same-task")).toBe(false);
  });

  test("startup reconciliation does not re-arm a task disabled by a concurrent mutation", async () => {
    // `initScheduledTasks()` takes a task snapshot outside withTaskMutation.
    // Freeze it after that snapshot reaches its stale alarm-clear operation,
    // let an Options save durably disable + clear the task, then release
    // startup. Today startup creates an alarm from its stale enabled snapshot.
    // Phase 4 clears from the startup snapshot, then re-reads under the
    // mutation authority immediately before any create.
    storage[SCHEDULED_TASKS_KEY] = [task(true)];
    let releaseStartupClear!: () => void;
    let startupClearStarted!: () => void;
    const startupClear = new Promise<void>((resolve) => { startupClearStarted = resolve; });
    const chromeMock = globalThis.chrome as unknown as { alarms: { clear: ReturnType<typeof vi.fn> } };
    chromeMock.alarms.clear.mockImplementation(async (name: string) => {
      if (chromeMock.alarms.clear.mock.calls.length === 1) {
        startupClearStarted();
        await new Promise<void>((resolve) => { releaseStartupClear = resolve; });
      }
      activeAlarms.delete(name);
      return true;
    });

    const { initScheduledTasks } = await import("../src/lib/agent/scheduled-tasks");
    const startup = initScheduledTasks();
    await startupClear;
    await saveScheduledTask(task(false));
    expect((storage[SCHEDULED_TASKS_KEY] as ScheduledTask[])[0]).toMatchObject({ enabled: false });

    releaseStartupClear();
    await startup;

    // A durably disabled task cannot retain/reacquire an alarm.
    expect(activeAlarms.has("open_cowork_scheduled_same-task")).toBe(false);
  });
});

describe("Phase 3 recovery-to-history characterization", () => {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();

  beforeEach(() => {
    local.clear();
    session.clear();
    (globalThis as { chrome?: unknown }).chrome = makeChromeStorageMock(local, session);
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  test("an interrupted recovery snapshot becomes one terminal, failed history record with matching identity and usage", async () => {
    const { persistInterruptedRunHistory } = await import("../src/extension/background/run-snapshot-store");
    const { loadRuns } = await import("../src/lib/agent/run-history");
    const { primeLiveSecretRedaction, resetLiveSecretRedactionForTests } = await import("../src/lib/agent/secrets");
    const startedAt = Date.now() - 100;
    const endedAt = Date.now();
    const snapshot: RunSnapshotV1 = {
      version: 1,
      runId: "recovered-run",
      revision: 4,
      dispatchRevision: 8,
      task: "recover fake task",
      maxSteps: 10,
      mode: "standard",
      status: "interrupted",
      phase: "terminal",
      step: 3,
      startedAt,
      updatedAt: endedAt,
      endedAt,
      terminalReason: "interrupted",
      terminalMessage: "Worker restarted",
      usage: { tokensIn: 12, tokensOut: 34, costUsd: 0.056, model: "fixture-model" },
    };

    await primeLiveSecretRedaction("");
    try {
      await persistInterruptedRunHistory(snapshot);
      const [record] = await loadRuns();

      expect(record).toMatchObject({
        id: "recovered-run",
        task: "recover fake task",
        startedAt,
        endedAt,
        stepCount: 3,
        terminalReason: "interrupted",
        result: { success: false, text: "Worker restarted" },
        totalTokensIn: 12,
        totalTokensOut: 34,
        totalCostUsd: 0.056,
      });
      expect(record.steps).toEqual([
        expect.objectContaining({ type: "done", success: false, text: "Worker restarted" }),
      ]);
    } finally {
      resetLiveSecretRedactionForTests();
    }
  });

  test("persisting the same interrupted snapshot twice is idempotent in run history", async () => {
    const { persistInterruptedRunHistory } = await import("../src/extension/background/run-snapshot-store");
    const { loadRuns } = await import("../src/lib/agent/run-history");
    const { primeLiveSecretRedaction, resetLiveSecretRedactionForTests } = await import("../src/lib/agent/secrets");
    const startedAt = Date.now() - 1000;
    const endedAt = Date.now();
    const snapshot: RunSnapshotV1 = {
      version: 1,
      runId: "recovered-idempotency-fixture",
      revision: 4,
      dispatchRevision: 8,
      task: "recover fake task exactly once",
      maxSteps: 10,
      mode: "standard",
      status: "interrupted",
      phase: "terminal",
      step: 3,
      startedAt,
      updatedAt: endedAt,
      endedAt,
      terminalReason: "interrupted",
      terminalMessage: "Fixture worker restart",
      usage: { tokensIn: 12, tokensOut: 34, costUsd: 0.056, model: "fixture-model" },
    };

    await primeLiveSecretRedaction("");
    try {
      await persistInterruptedRunHistory(snapshot);
      await persistInterruptedRunHistory(snapshot);
      const records = await loadRuns();

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        id: snapshot.runId,
        terminalReason: "interrupted",
        result: { success: false, text: "Fixture worker restart" },
      });
    } finally {
      resetLiveSecretRedactionForTests();
    }
  });
});
