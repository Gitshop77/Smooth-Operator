/**
 * Stateful module tests — scheduled-tasks.ts + persistent-memory.ts.
 *
 * These modules had zero test coverage despite being stateful, side-effecting
 * code with scheduling math and per-site memory persistence.
 */

import { describe, test, expect, beforeEach, beforeAll, afterAll } from "vitest";
import {
  validateSchedule,
  computeNextFire,
  parseAlarmName,
  saveScheduledTask,
  initScheduledTasks,
  type ScheduledTask,
} from "../src/lib/agent/scheduled-tasks";
import { isValidTaskEntry } from "../src/lib/agent/scheduled-tasks-utils";
import {
  saveMemory,
  deleteMemory,
  getMemoriesForUrl,
  formatMemories,
  __resetMemoryCacheForTests,
  type SiteMemory,
} from "../src/lib/agent/persistent-memory";
import { installLocalStorageStub, restoreLocalStorageStub } from "./helpers";

// ─── Stub localStorage (jsdom doesn't provide one) ──────────────────────────

beforeAll(() => {
  installLocalStorageStub();
});

afterAll(() => {
  restoreLocalStorageStub();
});

// ─── scheduled-tasks.ts ─────────────────────────────────────────────────────

describe("scheduled-tasks — validateSchedule", () => {
  test("validates interval schedule", () => {
    expect(validateSchedule({ type: "interval", intervalMinutes: 60 })).toBeNull();
    expect(validateSchedule({ type: "interval", intervalMinutes: 1 })).toBeNull();
  });

  test("rejects interval < 1", () => {
    expect(validateSchedule({ type: "interval", intervalMinutes: 0 })).toContain("≥ 1");
    expect(validateSchedule({ type: "interval" })).toContain("≥ 1");
  });

  test("validates daily schedule", () => {
    expect(validateSchedule({ type: "daily", hour: 9, minute: 0 })).toBeNull();
    expect(validateSchedule({ type: "daily", hour: 23, minute: 59 })).toBeNull();
  });

  test("rejects daily with invalid hour/minute", () => {
    expect(validateSchedule({ type: "daily", hour: 24, minute: 0 })).toContain("hour");
    expect(validateSchedule({ type: "daily", hour: 9, minute: 60 })).toContain("minute");
  });

  test("validates weekly schedule", () => {
    expect(validateSchedule({ type: "weekly", hour: 9, minute: 0, dayOfWeek: 1 })).toBeNull();
  });

  test("rejects weekly with invalid dayOfWeek", () => {
    expect(validateSchedule({ type: "weekly", hour: 9, minute: 0, dayOfWeek: 7 })).toContain("dayOfWeek");
  });
});

describe("scheduled-tasks — computeNextFire", () => {
  test("interval schedule falls through to the default-hour branch and pins the exact next fire", () => {
 // There is no dedicated interval branch: an interval schedule drops into
 // the default-hour (09:00) logic plus the MIN_FIRE_DELAY_MS bump. Pin the
 // EXACT result so a future dedicated `computeNextIntervalFire` branch that
 // stops exercising this code path fails loudly instead of silently passing
 // the loose `>= 60s` assertion.
    const now = new Date("2025-01-15T10:00:00");
    const result = computeNextFire({ type: "interval", intervalMinutes: 60 }, now);
    // target = today 09:00; minFuture = 10:01; one 24h step → tomorrow 09:00.
    const expected = new Date("2025-01-16T09:00:00");
    expect(result.getTime()).toBe(expected.getTime());
    // The documented minimum delay still holds.
    expect(result.getTime() - now.getTime()).toBeGreaterThanOrEqual(60_000);
  });

  test("daily schedule fires at the specified time today if it hasn't passed yet", () => {
    const now = new Date("2025-01-15T08:00:00");
    const result = computeNextFire({ type: "daily", hour: 9, minute: 0 }, now);
    expect(result.getHours()).toBe(9);
    expect(result.getMinutes()).toBe(0);
    expect(result.getDate()).toBe(15); // same day
  });

  test("daily schedule fires tomorrow if the time has already passed", () => {
    const now = new Date("2025-01-15T10:00:00");
    const result = computeNextFire({ type: "daily", hour: 9, minute: 0 }, now);
    expect(result.getDate()).toBe(16); // next day
  });

  test("weekly schedule fires on the correct day of week", () => {
 // Jan 15, 2025 is a Wednesday (day 3)
    const now = new Date("2025-01-15T10:00:00");
 // Schedule for Monday (day 1) at 9 AM
    const result = computeNextFire({ type: "weekly", hour: 9, minute: 0, dayOfWeek: 1 }, now);
 // Should be the next Monday (Jan 20)
    expect(result.getDay()).toBe(1);
    expect(result.getDate()).toBe(20);
  });

  test("weekly schedule that already passed today rolls forward a full week", () => {
 // 2025-01-13 is a Monday (day 1). Schedule for Monday at 09:00, but now is
 // 10:00 (the target time already passed today) → must roll to the NEXT
 // Monday (Jan 20), not later today.
    const now = new Date("2025-01-13T10:00:00");
    const result = computeNextFire({ type: "weekly", hour: 9, minute: 0, dayOfWeek: 1 }, now);
    expect(result.getDay()).toBe(1);
    expect(result.getDate()).toBe(20);
  });

  test("always returns a date at least 1 minute in the future", () => {
    const now = new Date("2025-01-15T09:00:00");
    const result = computeNextFire({ type: "daily", hour: 9, minute: 0 }, now);
 // 9:00 has already passed (or is now) — should advance to tomorrow
    expect(result.getTime()).toBeGreaterThan(now.getTime());
  });
});

describe("scheduled-tasks — parseAlarmName", () => {
  test("extracts the task ID from a valid alarm name", () => {
    expect(parseAlarmName("open_cowork_scheduled_abc123")).toBe("abc123");
  });

  test("returns null for non-scheduled alarm names", () => {
    expect(parseAlarmName("open_cowork_keepalive")).toBeNull();
    expect(parseAlarmName("some_other_alarm")).toBeNull();
  });
});

// ─── scheduled-tasks.ts — chrome.alarms MV3 wiring (brief §3) ────────────────
//
// These are the side-effecting assertions the pure-helper tests above miss:
// that an enabled task actually arms a chrome.alarm (the MV3-correct mechanism
// — not a setInterval), that the alarm name carries the parseAlarmName prefix,
// and that initScheduledTasks re-arms every persisted task on service-worker
// start. A regression that silently reverted to setInterval, or dropped the
// chrome.alarms.create call, would break MV3 teardown/restart semantics.

type AlarmSpec = { name: string; spec?: chrome.alarms.AlarmCreateInfo };

function installChromeAlarmsStub() {
  const created: AlarmSpec[] = [];
  const cleared: string[] = [];
  const storageData: Record<string, unknown> = {};
  const chromeStub = {
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
    },
    power: {
      requestKeepAwake: (() => {}) as typeof chrome.power.requestKeepAwake,
      releaseKeepAwake: (() => {}) as typeof chrome.power.releaseKeepAwake,
    },
  };
  const prev = (globalThis as { chrome?: unknown }).chrome;
  (globalThis as { chrome?: unknown }).chrome = chromeStub;
  return {
    created,
    cleared,
    storageData,
    restore: () => {
      (globalThis as { chrome?: unknown }).chrome = prev;
    },
  };
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

describe("scheduled-tasks — chrome.alarms MV3 wiring", () => {
  test("saveScheduledTask arms a chrome.alarm named by parseAlarmName prefix + id", async () => {
    const stub = installChromeAlarmsStub();
    try {
      const task = makeTask("task-1", { type: "interval", intervalMinutes: 30 });
      await saveScheduledTask(task);

      // Name must carry the canonical prefix (so parseAlarmName round-trips).
      const expectedName = `open_cowork_scheduled_${task.id}`;
      const armed = stub.created.find((c) => c.name === expectedName);
      expect(armed).toBeDefined();
      // Interval schedules arm with periodInMinutes derived from the schedule.
      expect(armed!.spec!.periodInMinutes).toBe(30);
      // scheduleAlarm clears any prior alarm before arming (MV3 idempotency).
      expect(stub.cleared).toContain(expectedName);
    } finally {
      stub.restore();
    }
  });

  test("initScheduledTasks re-arms every persisted task on SW start (no setInterval)", async () => {
    const stub = installChromeAlarmsStub();
    try {
      const enabled = makeTask("enabled-1", { type: "interval", intervalMinutes: 15 });
      const disabled = makeTask("disabled-1", { type: "daily", hour: 9, minute: 0 }, false);
      await saveScheduledTask(enabled);
      await saveScheduledTask(disabled);

      // Reset tracking, then simulate a service-worker cold start.
      stub.created.length = 0;
      stub.cleared.length = 0;
      await initScheduledTasks();

      // Every persisted task is reconciled: stale alarms are cleared for all,
      // and only the enabled task gets a fresh alarm re-created.
      expect(stub.cleared).toContain(`open_cowork_scheduled_${enabled.id}`);
      expect(stub.cleared).toContain(`open_cowork_scheduled_${disabled.id}`);
      const reCreated = stub.created.map((c) => c.name);
      expect(reCreated).toContain(`open_cowork_scheduled_${enabled.id}`);
      // A disabled task must NOT re-arm a firing alarm.
      expect(reCreated).not.toContain(`open_cowork_scheduled_${disabled.id}`);
    } finally {
      stub.restore();
    }
  });

  test("daily/weekly tasks arm with when = persisted nextRunAt (phase-preserving)", async () => {
    const stub = installChromeAlarmsStub();
    try {
      const task = makeTask("daily-1", { type: "daily", hour: 9, minute: 0 });
      await saveScheduledTask(task);

      const persisted = (stub.storageData["open_cowork_scheduled_tasks"] as ScheduledTask[]).find(
        (t) => t.id === "daily-1",
      );
      expect(persisted?.nextRunAt).toBeTypeOf("number");

      const armed = stub.created.find((c) => c.name === `open_cowork_scheduled_daily-1`);
      // The alarm must fire at the persisted absolute time — NOT at a delay
      // re-derived from `now`, which would shift the wall-clock phase by
      // however late the arm happened.
      expect(armed!.spec!.when).toBe(persisted!.nextRunAt);
      expect(armed!.spec!.periodInMinutes).toBe(1440);
    } finally {
      stub.restore();
    }
  });

  test("initScheduledTasks re-arm preserves the first-fire time (no phase drift)", async () => {
    const stub = installChromeAlarmsStub();
    try {
      const task = makeTask("weekly-1", { type: "weekly", hour: 9, minute: 0, dayOfWeek: 1 });
      await saveScheduledTask(task);
      const persisted = (stub.storageData["open_cowork_scheduled_tasks"] as ScheduledTask[]).find(
        (t) => t.id === "weekly-1",
      );

      // Simulate a service-worker cold start mid-cycle.
      stub.created.length = 0;
      stub.cleared.length = 0;
      await initScheduledTasks();

      const reArmed = stub.created.find((c) => c.name === `open_cowork_scheduled_weekly-1`);
      expect(reArmed!.spec!.when).toBe(persisted!.nextRunAt);
    } finally {
      stub.restore();
    }
  });
});

// ─── scheduled-tasks — corrupt persisted entries ────────────────────────────

describe("scheduled-tasks — corrupt persisted entries", () => {
  test("isValidTaskEntry rejects an entry with no/odd-shaped schedule instead of throwing", () => {
    // A corrupt/partial persisted entry (e.g. from an older schema or a torn
    // write) must be filtered out, never crash the load path with a TypeError
    // from `validateSchedule(undefined).type`.
    expect(isValidTaskEntry({ id: "x", task: "t", enabled: true })).toBe(false);
    expect(isValidTaskEntry({ id: "x", task: "t", schedule: null, enabled: true })).toBe(false);
    expect(isValidTaskEntry({ id: "x", task: "t", schedule: undefined, enabled: true })).toBe(false);
    expect(isValidTaskEntry({ id: "x", task: "t", schedule: "daily", enabled: true })).toBe(false);
  });

  test("isValidTaskEntry still accepts a valid entry", () => {
    expect(isValidTaskEntry(makeTask("ok-1", { type: "daily", hour: 9, minute: 0 }))).toBe(true);
  });

  test("isValidTaskEntry rejects entries with a missing/blank id or task", () => {
    // A corrupt/legacy entry with garbage identity would otherwise be re-armed
    // under `open_cowork_scheduled_undefined` with a blank prompt.
    const validSchedule = { type: "interval", intervalMinutes: 15 };
    expect(isValidTaskEntry({ task: "t", schedule: validSchedule })).toBe(false);
    expect(isValidTaskEntry({ id: "", task: "t", schedule: validSchedule })).toBe(false);
    expect(isValidTaskEntry({ id: "   ", task: "t", schedule: validSchedule })).toBe(false);
    expect(isValidTaskEntry({ id: "x", task: "", schedule: validSchedule })).toBe(false);
    expect(isValidTaskEntry({ id: "x", task: "   ", schedule: validSchedule })).toBe(false);
    // The schedule is still validated on top of the identity checks.
    expect(isValidTaskEntry({ id: "x", task: "t", schedule: { type: "interval" } })).toBe(false);
  });

  test("initScheduledTasks skips corrupt entries instead of crashing SW startup", async () => {
    const stub = installChromeAlarmsStub();
    try {
      const valid = makeTask("good-1", { type: "interval", intervalMinutes: 15 });
      await saveScheduledTask(valid);
      // Corrupt a persisted entry (torn write / older schema version).
      (stub.storageData["open_cowork_scheduled_tasks"] as unknown[]).push({
        id: "corrupt-1",
        task: "no schedule",
        enabled: true,
      });

      stub.created.length = 0;
      stub.cleared.length = 0;
      await expect(initScheduledTasks()).resolves.toBeUndefined();

      // The valid task is still reconciled; the corrupt one is skipped.
      expect(stub.cleared).toContain("open_cowork_scheduled_good-1");
      expect(stub.created.map((c) => c.name)).toContain("open_cowork_scheduled_good-1");
      expect(stub.cleared).not.toContain("open_cowork_scheduled_corrupt-1");
      expect(stub.created.map((c) => c.name)).not.toContain("open_cowork_scheduled_corrupt-1");
    } finally {
      stub.restore();
    }
  });
});

// ─── persistent-memory.ts ───────────────────────────────────────────────────

describe("persistent-memory", () => {
  beforeEach(async () => {
 // Clear localStorage AND the in-memory cache so each test starts clean.
 // Without resetting the cache, a previous test's saveMemory could leave
 // stale data that loadAllMemories reads instead of the cleared storage.
    localStorage.removeItem("open_cowork_site_memories");
    __resetMemoryCacheForTests();
  });

  test("saveMemory stores a memory and getMemoriesForUrl retrieves it", async () => {
    await saveMemory("example.com", "username is testuser");
    const memories = await getMemoriesForUrl("https://example.com");
    expect(memories).toHaveLength(1);
    expect(memories[0].domain).toBe("example.com");
    expect(memories[0].notes).toBe("username is testuser");
  });

  test("getMemoriesForUrl matches subdomains", async () => {
    await saveMemory("example.com", "prefer dark mode");
    const memories = await getMemoriesForUrl("https://sub.example.com");
    expect(memories).toHaveLength(1);
    expect(memories[0].domain).toBe("example.com");
  });

  test("getMemoriesForUrl returns empty for non-matching domain", async () => {
    await saveMemory("example.com", "some note");
    const memories = await getMemoriesForUrl("https://other.com");
    expect(memories).toHaveLength(0);
  });

  test("saveMemory with empty notes deletes the entry", async () => {
    await saveMemory("example.com", "some note");
    expect(await getMemoriesForUrl("https://example.com")).toHaveLength(1);
    await saveMemory("example.com", "");
    expect(await getMemoriesForUrl("https://example.com")).toHaveLength(0);
  });

  test("deleteMemory removes a specific entry", async () => {
    await saveMemory("example.com", "note 1");
    await saveMemory("other.com", "note 2");
    await deleteMemory("example.com");
    expect(await getMemoriesForUrl("https://example.com")).toHaveLength(0);
    expect(await getMemoriesForUrl("https://other.com")).toHaveLength(1);
  });

  test("getMemoriesForUrl returns empty for invalid URL", async () => {
    await saveMemory("example.com", "note");
    expect(await getMemoriesForUrl("not-a-url")).toHaveLength(0);
  });

  test("formatMemories renders a <site_memory> block", () => {
    const memories: SiteMemory[] = [
      { domain: "example.com", notes: "username is X", updatedAt: Date.now() },
      { domain: "other.com", notes: "prefer option Y", updatedAt: Date.now() },
    ];
    const result = formatMemories(memories);
    expect(result).toContain("<site_memory>");
    expect(result).toContain("[example.com]: username is X");
    expect(result).toContain("[other.com]: prefer option Y");
  });

  test("formatMemories returns empty string for no memories", () => {
    expect(formatMemories([])).toBe("");
  });
});
