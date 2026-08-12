/**
 * scheduled-tasks.ts export/import — redacted export, background-owned
 * import with recomputed revisions, and TRANSACTIONAL storage+alarm commits:
 * alarms are armed only after the storage commit, and a storage write failure
 * never leaves an armed alarm that would double-fire a run storage does not
 * know about.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { ScheduledTask } from "../src/lib/agent/scheduled-tasks";

type AlarmSpec = { name: string; spec?: chrome.alarms.AlarmCreateInfo };

interface StubOptions {
  /** Throw from storage.local.set when the payload contains this key. */
  failSetOnKey?: string;
  /** Throw from alarms.create once (then recover) to simulate a transient arm failure. */
  failCreateOnce?: boolean;
}

function installChrome(opts: StubOptions = {}): {
  created: AlarmSpec[];
  cleared: string[];
  storageData: Record<string, unknown>;
} {
  const created: AlarmSpec[] = [];
  const cleared: string[] = [];
  const storageData: Record<string, unknown> = {};
  let failCreate = opts.failCreateOnce ?? false;
  (globalThis as Record<string, unknown>).chrome = {
    alarms: {
      create: ((name: string, spec: chrome.alarms.AlarmCreateInfo) => {
        if (failCreate) {
          failCreate = false; // transient: fail once, then recover
          throw new Error("alarms.create failed (transient)");
        }
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
        get: ((key: string) => Promise.resolve({ [key]: storageData[key] })) as typeof chrome.storage.local.get,
        set: ((obj: Record<string, unknown>) => {
          const keys = Object.keys(obj);
          if (opts.failSetOnKey && keys.includes(opts.failSetOnKey)) {
            throw new Error("QUOTA_BYTES exceeded");
          }
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
  return { created, cleared, storageData };
}

function makeTask(id: string, schedule: ScheduledTask["schedule"], task = `prompt for ${id}`): ScheduledTask {
  return { id, task, schedule, enabled: true, createdAt: 1_700_000_000_000 };
}

function storedTasks(storageData: Record<string, unknown>): ScheduledTask[] {
  return (storageData["open_cowork_scheduled_tasks"] as ScheduledTask[]) ?? [];
}

describe("exportScheduledTasks", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).chrome;
  });

  test("export redacts key-shaped tokens from task prompts", async () => {
    const stub = installChrome();
    const ghpToken = "ghp_" + "A".repeat(36);
    stub.storageData["open_cowork_scheduled_tasks"] = [
      makeTask("t1", { type: "interval", intervalMinutes: 30 }, `post to ${ghpToken}`),
    ];
    const { exportScheduledTasks } = await import("../src/lib/agent/scheduled-tasks");
    const exported = await exportScheduledTasks();
    expect(exported.length).toBe(1);
    expect(exported[0].task).not.toContain(ghpToken);
    expect(exported[0].task).toContain("[redacted]");
    // Export never touches storage or alarms.
    expect(stub.created.length).toBe(0);
    expect(stub.storageData["open_cowork_scheduled_tasks"]).toBeDefined();
  });
});

describe("importScheduledTasks — transactional storage + alarms", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).chrome;
  });

  test("imports new rows with background-owned revisions and arms their alarms", async () => {
    const stub = installChrome();
    const { importScheduledTasks } = await import("../src/lib/agent/scheduled-tasks");
    const result = await importScheduledTasks([
      makeTask("a", { type: "interval", intervalMinutes: 15 }),
      makeTask("b", { type: "daily", hour: 9, minute: 0 }),
      { garbage: true }, // invalid → skipped
    ]);
    expect(result.added).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    const stored = storedTasks(stub.storageData);
    expect(stored.map((t) => t.id).sort()).toEqual(["a", "b"]);
    // Client-supplied revisions are never trusted: fresh rows start at 1.
    expect(stored.find((t) => t.id === "a")!.revision).toBe(1);
    expect(stored.find((t) => t.id === "b")!.revision).toBe(1);
    // Alarms armed for exactly the two imported tasks (after the storage commit).
    expect(stub.created.map((c) => c.name).sort()).toEqual([
      "open_cowork_scheduled_a",
      "open_cowork_scheduled_b",
    ]);
  });

  test("updating an existing row bumps its revision and keeps identity", async () => {
    const stub = installChrome();
    stub.storageData["open_cowork_scheduled_tasks"] = [makeTask("a", { type: "interval", intervalMinutes: 15 })];
    (stub.storageData["open_cowork_scheduled_tasks"] as ScheduledTask[])[0].revision = 4;
    const { importScheduledTasks } = await import("../src/lib/agent/scheduled-tasks");
    const result = await importScheduledTasks([
      { ...makeTask("a", { type: "interval", intervalMinutes: 60 }), revision: 999, createdAt: 12345 },
    ]);
    expect(result.updated).toBe(1);
    expect(result.added).toBe(0);
    const stored = storedTasks(stub.storageData);
    expect(stored.length).toBe(1);
    // Identity (id/createdAt) is background-owned; the imported row's are ignored.
    expect(stored[0].createdAt).toBe(1_700_000_000_000);
    expect(stored[0].revision).toBe(5);
    expect(stored[0].schedule.intervalMinutes).toBe(60);
  });

  test("a storage write failure rejects BEFORE any alarm is armed (no double-fire)", async () => {
    const stub = installChrome({ failSetOnKey: "open_cowork_scheduled_tasks" });
    stub.storageData["open_cowork_scheduled_tasks"] = [makeTask("existing", { type: "interval", intervalMinutes: 30 })];
    const { importScheduledTasks } = await import("../src/lib/agent/scheduled-tasks");
    await expect(importScheduledTasks([makeTask("new", { type: "interval", intervalMinutes: 5 })])).rejects.toThrow();
    // Alarm for the NEW task was never armed; the existing row's alarm was
    // also untouched (no clear/create happened) — nothing can double-fire.
    expect(stub.created.length).toBe(0);
    expect(stub.cleared.length).toBe(0);
    expect(storedTasks(stub.storageData).map((t) => t.id)).toEqual(["existing"]);
  });

  test("an alarm arm failure rolls the storage write back and re-arms prior alarms", async () => {
    const stub = installChrome({ failCreateOnce: true });
    stub.storageData["open_cowork_scheduled_tasks"] = [makeTask("existing", { type: "interval", intervalMinutes: 30 })];
    const { importScheduledTasks } = await import("../src/lib/agent/scheduled-tasks");
    await expect(importScheduledTasks([makeTask("new", { type: "interval", intervalMinutes: 5 })])).rejects.toThrow(
      /Failed to reconcile alarms/,
    );
    // Storage rolled back to the pre-import list — the imported row is gone.
    expect(storedTasks(stub.storageData).map((t) => t.id)).toEqual(["existing"]);
    // The prior alarm was re-armed (clear + create for the existing task).
    expect(stub.cleared).toContain("open_cowork_scheduled_existing");
    expect(stub.created.some((c) => c.name === "open_cowork_scheduled_existing")).toBe(true);
    expect(stub.created.some((c) => c.name === "open_cowork_scheduled_new")).toBe(false);
  });
});
