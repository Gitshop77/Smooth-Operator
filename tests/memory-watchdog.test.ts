/**
 * Vision memory watchdog — sampler math, threshold logic, and notice routing.
 *
 * The watchdog samples Chrome's JS heap (`performance.memory`;
 * `navigator.deviceMemory` is a per-device constant and cannot detect growth)
 * around inference. A warning fires only after sustained growth past the
 * threshold, so one-time GC spikes are not reported.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MemoryWatchdog,
  readMemoryInfo,
  pushMemoryWarning,
  consumeMemoryWarning,
  type MemoryInfo,
} from "../src/extension/vision-assistant/memory-watchdog";
import { VisionAssistant } from "../src/extension/vision-assistant/inference";

const MB = 1048576;

function sample(mb: number): MemoryInfo {
  return { usedJSHeapSize: mb * MB, totalJSHeapSize: (mb + 100) * MB, jsHeapSizeLimit: 4096 * MB };
}

describe("readMemoryInfo", () => {
  test("returns null when performance.memory is absent", () => {
    const desc = Object.getOwnPropertyDescriptor(performance, "memory");
    if (desc) Object.defineProperty(performance, "memory", { value: undefined, configurable: true });
    try {
      expect(readMemoryInfo()).toBeNull();
    } finally {
      if (desc) Object.defineProperty(performance, "memory", desc);
      else delete (performance as unknown as { memory?: unknown }).memory;
    }
  });

  test("parses Chrome's performance.memory when present", () => {
    const desc = Object.getOwnPropertyDescriptor(performance, "memory");
    const info = sample(256);
    Object.defineProperty(performance, "memory", { value: info, configurable: true });
    try {
      expect(readMemoryInfo()).toEqual(info);
    } finally {
      if (desc) Object.defineProperty(performance, "memory", desc);
      else delete (performance as unknown as { memory?: unknown }).memory;
    }
  });

  test("returns null when performance.memory fields are non-finite", () => {
    const desc = Object.getOwnPropertyDescriptor(performance, "memory");
    Object.defineProperty(performance, "memory", { value: { usedJSHeapSize: NaN, totalJSHeapSize: 1, jsHeapSizeLimit: 1 }, configurable: true });
    try {
      expect(readMemoryInfo()).toBeNull();
    } finally {
      if (desc) Object.defineProperty(performance, "memory", desc);
      else delete (performance as unknown as { memory?: unknown }).memory;
    }
  });
});

describe("MemoryWatchdog threshold logic", () => {
  test("growth below threshold never warns", () => {
    const wd = new MemoryWatchdog({ growthThresholdMb: 200, consecutiveRequired: 3 });
    expect(wd.record(sample(100))).toBeNull();
    expect(wd.record(sample(150))).toBeNull();
    expect(wd.record(sample(180))).toBeNull();
  });

  test("sustained growth past the threshold warns with the growth numbers", () => {
    const wd = new MemoryWatchdog({ growthThresholdMb: 200, consecutiveRequired: 3 });
    wd.record(sample(100)); // baseline = 100
    wd.record(sample(250)); // +150, below threshold
    expect(wd.record(sample(500))).toBeNull(); // +400 > 200, consecutive 1 of 3
    expect(wd.record(sample(510))).toBeNull(); // consecutive 2 of 3
    const warning = wd.record(sample(520)); // consecutive 3 of 3
    expect(warning).not.toBeNull();
    expect(warning!.kind).toBe("memory-growth");
    expect(warning!.growthMb).toBe(420);
    expect(warning!.baselineMb).toBe(100);
    expect(warning!.currentMb).toBe(520);
    expect(warning!.message).toMatch(/520/);
  });

  test("a single spike that drops back below threshold resets the streak", () => {
    const wd = new MemoryWatchdog({ growthThresholdMb: 200, consecutiveRequired: 2 });
    wd.record(sample(100));
    wd.record(sample(500)); // consecutive 1
    wd.record(sample(120)); // drops back — streak reset
    expect(wd.record(sample(510))).toBeNull(); // consecutive 1 again
  });

  test("warns once per episode until reset()", () => {
    const wd = new MemoryWatchdog({ growthThresholdMb: 200, consecutiveRequired: 2 });
    wd.record(sample(100));
    wd.record(sample(500));
    expect(wd.record(sample(510))).not.toBeNull();
    // Still above threshold: no second warning in the same episode.
    expect(wd.record(sample(520))).toBeNull();

    wd.reset();
    // Reset rebaselines: the (still-large) heap is the new baseline, and the
    // episode restarts — two more above-threshold samples are needed again.
    expect(wd.record(sample(520))).toBeNull();
    expect(wd.state().baselineMb).toBe(520);
    expect(wd.record(sample(800))).toBeNull(); // consecutive 1 of 2
    expect(wd.record(sample(810))).not.toBeNull();
  });

  test("state() reports growth/baseline/current/warned", () => {
    const wd = new MemoryWatchdog({ growthThresholdMb: 200, consecutiveRequired: 1 });
    wd.record(sample(100));
    wd.record(sample(400));
    expect(wd.state()).toEqual({
      growthMb: 300,
      baselineMb: 100,
      currentMb: 400,
      warned: true,
    });
  });
});

describe("notice registry", () => {
  beforeEach(() => {
    while (consumeMemoryWarning()) {
      // drain
    }
  });

  test("pushMemoryWarning / consumeMemoryWarning round-trip FIFO", () => {
    const w = new MemoryWatchdog({ growthThresholdMb: 1, consecutiveRequired: 1 });
    w.record(sample(100));
    const first = w.record(sample(500));
    expect(first).not.toBeNull();
    pushMemoryWarning(first!);
    const second = { kind: "memory-growth" as const, message: "second", growthMb: 1, baselineMb: 0, currentMb: 1 };
    pushMemoryWarning(second);
    expect(consumeMemoryWarning()).toEqual(first);
    expect(consumeMemoryWarning()).toEqual(second);
    expect(consumeMemoryWarning()).toBeNull();
  });
});

describe("VisionAssistant wiring", () => {
  afterEach(() => {
    while (consumeMemoryWarning()) {
      // drain
    }
  });

  test("sampleMemory records a sample and surfaces a warning via status + registry", () => {
    const va = new VisionAssistant();
    (va as unknown as { memoryWatchdog: MemoryWatchdog }).memoryWatchdog =
      new MemoryWatchdog({ growthThresholdMb: 200, consecutiveRequired: 1 });
    const statusCb = vi.fn();
    va.onStatus(statusCb);

    const sampleMemory = (va as unknown as { sampleMemory: () => void }).sampleMemory;
    sampleMemory.call(va); // first sample — performance.memory absent in jsdom → no-op
    expect(statusCb).not.toHaveBeenCalled();

    // Provide Chrome's heap metric, then feed two samples through the hook.
    const desc = Object.getOwnPropertyDescriptor(performance, "memory");
    Object.defineProperty(performance, "memory", { value: sample(100), configurable: true });
    try {
      sampleMemory.call(va); // baseline = 100
      Object.defineProperty(performance, "memory", { value: sample(500), configurable: true });
      sampleMemory.call(va); // +400 > 200 → warning
    } finally {
      if (desc) Object.defineProperty(performance, "memory", desc);
      else delete (performance as unknown as { memory?: unknown }).memory;
    }

    expect(statusCb).toHaveBeenCalledWith("warning", expect.stringContaining("400"));
    const warning = consumeMemoryWarning();
    expect(warning).not.toBeNull();
    expect(warning!.kind).toBe("memory-growth");
    expect(warning!.growthMb).toBe(400);
  });
});
