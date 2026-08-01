import { describe, it, expect } from "vitest";
import { computeNextFire, MIN_FIRE_DELAY_MS } from "../src/lib/agent/scheduled-tasks";

describe("computeNextFire", () => {
  it("rolls weekly schedule to the next occurrence of dayOfWeek", () => {
    // now = Wed 2026-07-15 10:00 (getDay() === 3). Target dayOfWeek = 2 (Tue).
    const now = new Date(2026, 6, 15, 10, 0, 0, 0);
    const schedule = { type: "weekly" as const, hour: 9, minute: 0, dayOfWeek: 2 };
    const next = computeNextFire(schedule, now);
    expect(next.getDay()).toBe(2);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    // First Tuesday at 09:00 after Wed 10:00 is 6 days later (07-21).
    expect(next.getDate()).toBe(21);
    expect(next.getTime()).toBeGreaterThanOrEqual(now.getTime() + MIN_FIRE_DELAY_MS);
  });

  it("rolls daily schedule to the next day when the time already passed today", () => {
    // now = today 10:00, daily target 09:00 — already in the past.
    const now = new Date(2026, 6, 15, 10, 0, 0, 0);
    const schedule = { type: "daily" as const, hour: 9, minute: 0 };
    const next = computeNextFire(schedule, now);
    expect(next.getDate()).toBe(16); // next day
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThanOrEqual(now.getTime() + MIN_FIRE_DELAY_MS);
  });

  it("clamps to at least MIN_FIRE_DELAY_MS when the target is within the min-delay window", () => {
    // now = today 08:59:30, daily target 09:00 — only ~30s away, inside the
    // 60s minimum-delay window. Must not schedule in the immediate past.
    const now = new Date(2026, 6, 15, 8, 59, 30, 0);
    const schedule = { type: "daily" as const, hour: 9, minute: 0 };
    const next = computeNextFire(schedule, now);
    // Within the window → advanced by a full day (next day 09:00).
    expect(next.getDate()).toBe(16);
    expect(next.getTime()).toBeGreaterThanOrEqual(now.getTime() + MIN_FIRE_DELAY_MS);
  });

  it("returns a same-day future time when the target is still ahead today", () => {
    // now = today 08:00, daily target 09:00 — comfortably in the future.
    const now = new Date(2026, 6, 15, 8, 0, 0, 0);
    const schedule = { type: "daily" as const, hour: 9, minute: 0 };
    const next = computeNextFire(schedule, now);
    expect(next.getDate()).toBe(15);
    expect(next.getTime()).toBeGreaterThanOrEqual(now.getTime() + MIN_FIRE_DELAY_MS);
  });

  it("never returns a fire time in the past (anti-regression on the min-delay clamp)", () => {
    // Sample many "now" instants across a day to ensure the clamp holds.
    for (let m = 0; m < 24 * 60; m++) {
      const now = new Date(2026, 6, 15, 0, 0, 0, 0);
      now.setMinutes(m);
      const schedule = { type: "daily" as const, hour: 9, minute: 0 };
      const next = computeNextFire(schedule, now);
      expect(next.getTime()).toBeGreaterThanOrEqual(now.getTime() + MIN_FIRE_DELAY_MS);
    }
  });
});
