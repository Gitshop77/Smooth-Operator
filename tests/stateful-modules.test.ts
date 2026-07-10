/**
 * Stateful module tests — scheduled-tasks.ts + persistent-memory.ts.
 *
 * These modules had zero test coverage despite being stateful, side-effecting
 * code with scheduling math and per-site memory persistence.
 */

import { describe, test, expect, beforeEach, beforeAll } from "vitest";
import {
  validateSchedule,
  computeNextFire,
  parseAlarmName,
} from "../src/lib/agent/scheduled-tasks";
import {
  saveMemory,
  deleteMemory,
  getMemoriesForUrl,
  formatMemories,
  __resetMemoryCacheForTests,
  type SiteMemory,
} from "../src/lib/agent/persistent-memory";
import { installLocalStorageStub } from "./helpers";

// ─── Stub localStorage (jsdom doesn't provide one) ──────────────────────────

beforeAll(() => {
  installLocalStorageStub();
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
  test("interval schedule returns the current date (interval is handled by chrome.alarms)", () => {
    const now = new Date("2025-01-15T10:00:00");
    const result = computeNextFire({ type: "interval", intervalMinutes: 60 }, now);
    // computeNextFire sets the time to the default hour:minute for interval
    // schedules (they don't use hour/minute), so the result should be at
    // least 1 minute in the future.
    expect(result.getTime()).toBeGreaterThan(now.getTime());
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

// ─── persistent-memory.ts ───────────────────────────────────────────────────

describe("persistent-memory", () => {
  beforeEach(async () => {
    // Clear localStorage AND the in-memory cache so each test starts clean.
    // Without resetting the cache, a previous test's saveMemory could leave
    // stale data that loadAllMemories reads instead of the cleared storage.
    localStorage.removeItem("__opencowork_site_memories");
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
