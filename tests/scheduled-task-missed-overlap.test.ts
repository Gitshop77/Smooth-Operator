/**
 * scheduled-tasks.ts advanceScheduledTaskPastMissedFire — deterministic
 * missed/overlap policy: a skipped fire (SW asleep past the due time, or a
 * fire that lands while a run is already active) collapses the missed slot to
 * the next future occurrence so the phase stays exact and no catch-up fire
 * loop can form. Also covers DST/wall-clock anchoring of daily/weekly tasks.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { ScheduledTask } from "../src/lib/agent/scheduled-tasks";

type AlarmSpec = { name: string; spec?: chrome.alarms.AlarmCreateInfo };

function installChrome(): { created: AlarmSpec[]; storageData: Record<string, unknown> } {
  const created: AlarmSpec[] = [];
  const storageData: Record<string, unknown> = {};
  (globalThis as Record<string, unknown>).chrome = {
    alarms: {
      create: ((name: string, spec: chrome.alarms.AlarmCreateInfo) => {
        created.push({ name, spec });
      }) as unknown as typeof chrome.alarms.create,
      clear: ((name: string) => {
        void name;
        return Promise.resolve(true);
      }) as unknown as typeof chrome.alarms.clear,
      get: (() => Promise.resolve(undefined)) as unknown as typeof chrome.alarms.get,
      getAll: (() => Promise.resolve([])) as unknown as typeof chrome.alarms.getAll,
      onAlarm: { addListener: (() => {}) as typeof chrome.alarms.onAlarm.addListener },
    },
    storage: {
      local: {
        get: ((key: string) => Promise.resolve({ [key]: storageData[key] })) as typeof chrome.storage.local.get,
        set: ((obj: Record<string, unknown>) => {
          Object.assign(storageData, obj);
          return Promise.resolve();
        }) as typeof chrome.storage.local.set,
        remove: ((key: string) => {
          delete storageData[key];
          return Promise.resolve();
        }) as typeof chrome.storage.local.remove,
      },
      session: {
        get: (() => Promise.resolve({})) as typeof chrome.storage.session.get,
        set: (() => Promise.resolve()) as typeof chrome.storage.session.set,
        remove: (() => Promise.resolve()) as typeof chrome.storage.session.remove,
      },
    },
    power: {
      requestKeepAwake: (() => {}) as typeof chrome.power.requestKeepAwake,
      releaseKeepAwake: (() => {}) as typeof chrome.power.releaseKeepAwake,
    },
    runtime: {
      id: "test",
      lastError: undefined,
      getManifest: () => ({ permissions: [] as string[], host_permissions: [] as string[] }),
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: { addListener: () => {} },
      sendMessage: () => Promise.resolve(),
    },
  };
  return { created, storageData };
}

function storedTasks(storageData: Record<string, unknown>): ScheduledTask[] {
  return (storageData["open_cowork_scheduled_tasks"] as ScheduledTask[]) ?? [];
}

// Fixed wall-clock anchor: Wed 2026-07-15 10:00 local (daily 09:00 has passed).
const WED_1000 = new Date(2026, 6, 15, 10, 0, 0, 0).getTime();

describe("advanceScheduledTaskPastMissedFire", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(WED_1000));
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).chrome;
  });

  test("a daily task whose fire time has passed is advanced to the next wall-clock occurrence", async () => {
    const stub = installChrome();
    const t0 = WED_1000;
    const pastDue = new Date(2026, 6, 15, 9, 0, 0, 0).getTime(); // today 09:00 — already passed at 10:00
    stub.storageData["open_cowork_scheduled_tasks"] = [{
      id: "d1",
      task: "daily",
      schedule: { type: "daily", hour: 9, minute: 0 },
      enabled: true,
      createdAt: t0,
      revision: 2,
      nextRunAt: pastDue,
    }];
    const { advanceScheduledTaskPastMissedFire } = await import("../src/lib/agent/scheduled-tasks");
    const advanced = await advanceScheduledTaskPastMissedFire("d1", t0);
    expect(advanced).toBe(true);
    const stored = storedTasks(stub.storageData).find((t) => t.id === "d1")!;
    // Next occurrence is TOMORROW 09:00 local (deterministic collapse, no replay).
    const next = new Date(stored.nextRunAt!);
    expect(next.getDate()).toBe(16);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    expect(stored.nextRunAt!).toBeGreaterThan(t0);
    // The alarm was re-armed to the new (future) `when`.
    const reArmed = stub.created.find((c) => c.name === "open_cowork_scheduled_d1");
    expect(reArmed).toBeDefined();
    expect(reArmed!.spec!.when).toBe(stored.nextRunAt);
  });

  test("an interval task collapses to now + interval (phase preserved from the missed slot)", async () => {
    const stub = installChrome();
    const t0 = WED_1000;
    stub.storageData["open_cowork_scheduled_tasks"] = [{
      id: "i1",
      task: "interval",
      schedule: { type: "interval", intervalMinutes: 30 },
      enabled: true,
      createdAt: t0,
      revision: 1,
      nextRunAt: t0 - 5 * 60_000, // due 5 minutes ago (missed)
    }];
    const { advanceScheduledTaskPastMissedFire } = await import("../src/lib/agent/scheduled-tasks");
    expect(await advanceScheduledTaskPastMissedFire("i1", t0)).toBe(true);
    const stored = storedTasks(stub.storageData).find((t) => t.id === "i1")!;
    expect(stored.nextRunAt).toBe(t0 + 30 * 60_000);
  });

  test("records durable missed-fire bookkeeping on the task row", async () => {
    const stub = installChrome();
    const t0 = WED_1000;
    stub.storageData["open_cowork_scheduled_tasks"] = [{
      id: "m1",
      task: "interval",
      schedule: { type: "interval", intervalMinutes: 15 },
      enabled: true,
      createdAt: t0,
      revision: 1,
      nextRunAt: t0 - 60_000, // due a minute ago (missed)
    }];
    const { advanceScheduledTaskPastMissedFire } = await import("../src/lib/agent/scheduled-tasks");
    expect(await advanceScheduledTaskPastMissedFire("m1", t0)).toBe(true);
    let stored = storedTasks(stub.storageData).find((t) => t.id === "m1")!;
    expect(stored.lastMissedFireAt).toBe(t0);
    expect(stored.missedFires).toBe(1);

    // A second missed slot (now past the recomputed fire again) increments.
    const t1 = t0 + 16 * 60_000;
    (stub.storageData["open_cowork_scheduled_tasks"] as ScheduledTask[])[0] = stored;
    expect(await advanceScheduledTaskPastMissedFire("m1", t1)).toBe(true);
    stored = storedTasks(stub.storageData).find((t) => t.id === "m1")!;
    expect(stored.missedFires).toBe(2);
    expect(stored.lastMissedFireAt).toBe(t1);
  });

  test("daily fires stay anchored to local wall-clock time across DST transitions", async () => {
    // US DST 2026: spring-forward Mar 8 (02:00→03:00), fall-back Nov 1.
    const before = new Date(2026, 2, 8, 0, 0, 0, 0); // Mar 8 00:00 local
    const { computeNextFire } = await import("../src/lib/agent/scheduled-tasks");
    const next = computeNextFire({ type: "daily", hour: 9, minute: 0 }, before);
    // 09:00 local still exists on the spring-forward day and must be chosen.
    expect(next.getDate()).toBe(8);
    expect(next.getHours()).toBe(9);
    const fallBackDay = new Date(2026, 10, 1, 0, 0, 0, 0); // Nov 1 00:00 local
    const afterFallBack = computeNextFire({ type: "daily", hour: 9, minute: 0 }, fallBackDay);
    expect(afterFallBack.getHours()).toBe(9);
  });

  test("no-op for a task already in the future, disabled, or missing", async () => {
    const stub = installChrome();
    const t0 = WED_1000;
    const future = t0 + 60 * 60_000;
    stub.storageData["open_cowork_scheduled_tasks"] = [
      { id: "future", task: "t", schedule: { type: "daily", hour: 9, minute: 0 }, enabled: true, createdAt: t0, revision: 1, nextRunAt: future },
      { id: "disabled", task: "t", schedule: { type: "daily", hour: 9, minute: 0 }, enabled: false, createdAt: t0, revision: 1, nextRunAt: t0 - 1 },
    ];
    const { advanceScheduledTaskPastMissedFire } = await import("../src/lib/agent/scheduled-tasks");
    expect(await advanceScheduledTaskPastMissedFire("future", t0)).toBe(false);
    expect(await advanceScheduledTaskPastMissedFire("disabled", t0)).toBe(false);
    expect(await advanceScheduledTaskPastMissedFire("missing", t0)).toBe(false);
    expect(stub.created.length).toBe(0); // nothing re-armed
  });

  test("an interval slot far in the past still collapses deterministically to now + interval", async () => {
    const stub = installChrome();
    const t0 = WED_1000;
    stub.storageData["open_cowork_scheduled_tasks"] = [{
      id: "x",
      task: "t",
      schedule: { type: "interval", intervalMinutes: 1 },
      enabled: true,
      createdAt: t0,
      revision: 1,
      nextRunAt: t0 - 1000,
    }];
    const { advanceScheduledTaskPastMissedFire } = await import("../src/lib/agent/scheduled-tasks");
    const later = t0 + 10 * 60 * 60_000;
    expect(await advanceScheduledTaskPastMissedFire("x", later)).toBe(true);
    const stored = storedTasks(stub.storageData).find((t) => t.id === "x")!;
    expect(stored.nextRunAt).toBe(later + 60_000);
  });
});
