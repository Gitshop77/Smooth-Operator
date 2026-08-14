/**
 * Vision download-progress helpers — pure math for the Local Vision model
 * download UX (rolling speed/ETA, monotonic global percent, emission throttle).
 *
 * These helpers live in src/extension/vision-assistant/progress-metrics.ts and
 * are deliberately dependency-free (no chrome, no fetch, no Cache Storage) so
 * the transfer-rate / ETA / percent / throttle math is unit-testable in
 * isolation from the download machinery exercised in vision-assistant.test.ts.
 */
import { describe, expect, test } from "vitest";
import {
  createProgressThrottle,
  createProgressTracker,
  nextGlobalPercent,
} from "../src/extension/vision-assistant/progress-metrics";

describe("createProgressTracker — rolling speed + ETA math", () => {
  test("reports no metrics before two samples exist", () => {
    const t = createProgressTracker(1000);
    expect(t.get()).toEqual({});
    t.record(100, 0);
    expect(t.get()).toEqual({});
  });

  test("computes speed and ETA from the window derivative", () => {
    const t = createProgressTracker(1000);
    t.record(0, 0);
    t.record(500, 1000); // 500 bytes in 1000 ms → 500 B/s; 500 remaining → 1 s
    expect(t.get()).toEqual({ speedBytesPerSec: 500, etaSeconds: 1 });
  });

  test("requires a positive time delta", () => {
    const t = createProgressTracker(1000);
    t.record(0, 0);
    t.record(500, 0); // same timestamp → no derivable rate
    expect(t.get()).toEqual({});
  });

  test("requires positive byte movement", () => {
    const t = createProgressTracker(1000);
    t.record(0, 0);
    t.record(0, 1000); // time passed but no bytes moved
    expect(t.get()).toEqual({});
  });

  test("rolls old samples out of the window (rate reflects the retained window)", () => {
    const t = createProgressTracker(1000, 3);
    t.record(0, 0);
    t.record(100, 1000);
    t.record(400, 1100);
    t.record(900, 1200);
    // Window keeps the last 3: (100,1000) → (900,1200): 800 bytes / 0.2 s.
    expect(t.get().speedBytesPerSec).toBe(4000);
  });

  test("setTotalBytes refines the ETA against an updated bytesTotal estimate", () => {
    const t = createProgressTracker(1000);
    t.record(0, 0);
    t.record(100, 1000); // 100 B/s → ETA (1000-100)/100 = 9 s
    expect(t.get().etaSeconds).toBe(9);
    t.setTotalBytes(2000); // probe revealed a bigger real total
    expect(t.get()).toEqual({ speedBytesPerSec: 100, etaSeconds: 19 });
  });

  test("reports ETA 0 once the set is fully downloaded", () => {
    const t = createProgressTracker(500);
    t.record(0, 0);
    t.record(500, 1000);
    expect(t.get()).toEqual({ speedBytesPerSec: 500, etaSeconds: 0 });
  });
});

describe("nextGlobalPercent — monotonic global percent", () => {
  test("computes the floored percent", () => {
    expect(nextGlobalPercent(50, 200, 0)).toBe(25);
  });

  test("never moves backwards when the bytesTotal estimate grows", () => {
    const p = nextGlobalPercent(500, 1000, 0); // 50%
    expect(p).toBe(50);
    // bytesTotal grows 1000 → 1200; raw floor(500/1200*100) = 41 would dip.
    expect(nextGlobalPercent(500, 1200, p)).toBe(50);
    expect(nextGlobalPercent(600, 1200, p)).toBe(50);
    expect(nextGlobalPercent(900, 1200, p)).toBe(75);
  });

  test("still reaches 100 once the set is complete", () => {
    expect(nextGlobalPercent(1200, 1200, 75)).toBe(100);
  });

  test("keeps the previous percent when bytesTotal is unknown (0)", () => {
    expect(nextGlobalPercent(10, 0, 33)).toBe(33);
  });

  test("clamps at 100", () => {
    expect(nextGlobalPercent(2000, 1000, 50)).toBe(100);
  });
});

describe("createProgressThrottle — ~1 percentage point OR ~400 ms granularity", () => {
  test("emits on the very first call", () => {
    const t = createProgressThrottle();
    expect(t.shouldEmit(0, 0)).toBe(true);
  });

  test("does not re-emit the same percent within the interval", () => {
    const t = createProgressThrottle();
    expect(t.shouldEmit(0, 0)).toBe(true);
    expect(t.shouldEmit(0, 100)).toBe(false);
    expect(t.shouldEmit(0, 399)).toBe(false);
  });

  test("emits as soon as a full percentage point advances", () => {
    const t = createProgressThrottle();
    expect(t.shouldEmit(0, 0)).toBe(true);
    expect(t.shouldEmit(1, 50)).toBe(true); // point rule beats the 400 ms rule
  });

  test("heartbeats the current percent once the interval elapses", () => {
    const t = createProgressThrottle();
    expect(t.shouldEmit(1, 0)).toBe(true);
    expect(t.shouldEmit(1, 500)).toBe(true); // 500 ms ≥ 400 ms with no movement
    expect(t.shouldEmit(1, 600)).toBe(false); // only 100 ms since the heartbeat
  });

  test("a multi-point jump emits exactly once", () => {
    const t = createProgressThrottle();
    expect(t.shouldEmit(0, 0)).toBe(true);
    expect(t.shouldEmit(5, 10)).toBe(true); // +5 points → one emit, not five
    expect(t.shouldEmit(5, 20)).toBe(false); // no new point, 10 ms elapsed
  });

  test("fast downloads emit per point (whichever comes first)", () => {
    const t = createProgressThrottle();
    expect(t.shouldEmit(0, 0)).toBe(true);
    expect(t.shouldEmit(1, 10)).toBe(true);
    expect(t.shouldEmit(2, 20)).toBe(true); // point rule keeps cadence under 400 ms
  });
});
