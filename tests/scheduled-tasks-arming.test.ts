/**
 * scheduled-tasks.ts — alarm phase preservation across SW restarts (part 2).
 *
 * chrome.alarms with only `periodInMinutes` anchors the first fire at
 * (re-)arm time — so `initScheduledTasks` re-arming on EVERY SW startup slides
 * the interval phase by the restart duration. Fixed-time (daily/weekly) tasks
 * already arm with `when = persisted nextRunAt`, which keeps the wall-clock
 * phase exact. Interval tasks must do the same: arm with the persisted
 * `nextRunAt` so the next tick after a restart lands at the original phase,
 * not `restartTime + interval`.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { ScheduledTask } from "../src/lib/agent/scheduled-tasks";

type AlarmSpec = { name: string; spec?: chrome.alarms.AlarmCreateInfo };

function installChromeAlarmsStub(): {
  created: AlarmSpec[];
  cleared: string[];
  storageData: Record<string, unknown>;
} {
  const created: AlarmSpec[] = [];
  const cleared: string[] = [];
  const storageData: Record<string, unknown> = {};
  (globalThis as Record<string, unknown>).chrome = {
    alarms: {
      create: ((name: string, spec: chrome.alarms.AlarmCreateInfo) => {
        created.push({ name, spec });
      }) as unknown as typeof chrome.alarms.create,
      clear: ((name: string) => {
        cleared.push(name);
        return Promise.resolve(true);
      }) as unknown as typeof chrome.alarms.clear,
      get: (() => Promise.resolve(undefined)) as unknown as typeof chrome.alarms.get,
      getAll: (() => Promise.resolve([])) as unknown as typeof chrome.alarms.getAll,
      onAlarm: { addListener: (() => {}) as typeof chrome.alarms.onAlarm.addListener },
    },
    storage: {
      local: {
        get: ((key: string) =>
          Promise.resolve({ [key]: storageData[key] })) as typeof chrome.storage.local.get,
        set: ((obj: Record<string, unknown>) => {
          Object.assign(storageData, obj);
          return Promise.resolve();
        }) as typeof chrome.storage.local.set,
        remove: ((key: string) => {
          delete storageData[key];
          return Promise.resolve();
        }) as typeof chrome.storage.local.remove,
      },
    },
    power: {
      requestKeepAwake: (() => {}) as typeof chrome.power.requestKeepAwake,
      releaseKeepAwake: (() => {}) as typeof chrome.power.releaseKeepAwake,
    },
  };
  return { created, cleared, storageData };
}

function makeTask(id: string, schedule: ScheduledTask["schedule"], enabled = true): ScheduledTask {
  return {
    id,
    task: `prompt for ${id}`,
    schedule,
    enabled,
    createdAt: 1_700_000_000_000,
  };
}

function storedTasks(storageData: Record<string, unknown>): ScheduledTask[] {
  return (storageData["open_cowork_scheduled_tasks"] as ScheduledTask[]) ?? [];
}

describe("scheduled-tasks — interval phase preservation across SW restart", () => {
  let stub: ReturnType<typeof installChromeAlarmsStub>;
  let saveScheduledTask: typeof import("../src/lib/agent/scheduled-tasks")["saveScheduledTask"];
  let initScheduledTasks: typeof import("../src/lib/agent/scheduled-tasks")["initScheduledTasks"];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    vi.resetModules();
    stub = installChromeAlarmsStub();
    const mod = await import("../src/lib/agent/scheduled-tasks");
    saveScheduledTask = mod.saveScheduledTask;
    initScheduledTasks = mod.initScheduledTasks;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).chrome;
  });

  test("interval re-arm after a fire + restart keeps the original phase (no restart-duration drift)", async () => {
    const t0 = 1_700_000_000_000;
    const INTERVAL = 30 * 60_000;
    const task = makeTask("int-1", { type: "interval", intervalMinutes: 30 });

    // Save at t0: nextRunAt anchors the phase at t0 + 30min.
    await saveScheduledTask(task);
    const firstNext = storedTasks(stub.storageData).find((t) => t.id === "int-1")!.nextRunAt;
    expect(firstNext).toBe(t0 + INTERVAL);

    // Alarm fires on schedule; the run completes 2 minutes later (t0+32min).
    vi.setSystemTime(new Date(t0 + 32 * 60_000));
    const fired = storedTasks(stub.storageData).find((t) => t.id === "int-1")!;
    fired.lastRunAt = Date.now();
    await saveScheduledTask(fired);
    const afterFire = storedTasks(stub.storageData).find((t) => t.id === "int-1")!.nextRunAt;
    expect(afterFire).toBe(t0 + 62 * 60_000);

    // SW restarts 10 minutes into the cycle (t0+42min, 20min before the tick).
    vi.setSystemTime(new Date(t0 + 42 * 60_000));
    stub.created.length = 0;
    stub.cleared.length = 0;
    await initScheduledTasks();

    const reArmed = stub.created.find((c) => c.name === "open_cowork_scheduled_int-1");
    expect(reArmed).toBeDefined();
    // The next tick must land at the persisted phase (t0+62min) — NOT be
    // re-anchored at restart time (t0+42min + 30min = t0+72min).
    expect(reArmed!.spec!.when).toBe(afterFire);
    expect(reArmed!.spec!.when).toBe(t0 + 62 * 60_000);
    expect(reArmed!.spec!.when).not.toBe(t0 + 42 * 60_000 + INTERVAL);
    expect(reArmed!.spec!.periodInMinutes).toBe(30);
  });

  test("fixed-time re-arm after a fire + restart lands at the fixed wall-clock time", async () => {
    const t0 = 1_700_000_000_000; // arbitrary epoch day
    const task = makeTask("daily-1", { type: "daily", hour: 9, minute: 0 });

    await saveScheduledTask(task);
    const firstNext = storedTasks(stub.storageData).find((t) => t.id === "daily-1")!.nextRunAt;
    expect(firstNext).toBeTypeOf("number");

    // Simulate the fire + run-completion re-save (nextRunAt recomputed from
    // the schedule, not from a relative delay).
    vi.setSystemTime(new Date(t0 + 60 * 60_000));
    const fired = storedTasks(stub.storageData).find((t) => t.id === "daily-1")!;
    fired.lastRunAt = Date.now();
    await saveScheduledTask(fired);
    const afterFire = storedTasks(stub.storageData).find((t) => t.id === "daily-1")!.nextRunAt;
    expect(afterFire).toBeTypeOf("number");

    // SW restart later in the same cycle must not slide the fire time.
    vi.setSystemTime(new Date(t0 + 90 * 60_000));
    stub.created.length = 0;
    stub.cleared.length = 0;
    await initScheduledTasks();

    const reArmed = stub.created.find((c) => c.name === "open_cowork_scheduled_daily-1");
    expect(reArmed).toBeDefined();
    expect(reArmed!.spec!.when).toBe(afterFire);
  });
});
