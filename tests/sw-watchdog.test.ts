/**
 * Service-worker watchdog — event-loop stall detection + vision memory
 * correlation, surfaced into the side panel via the AGENT_EVENT bus.
 *
 * MV3 note: the interval dies with the SW and restarts on wake; OS sleep is
 * distinguished from a real stall by the drift magnitude (a huge gap is
 * suppressed and primes a short quiet window).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SwWatchdog,
  runWatchdogCycle,
  startSwWatchdog,
  stopSwWatchdog,
} from "../src/extension/background/watchdog";
import {
  pushMemoryWarning,
  consumeMemoryWarning,
} from "../src/extension/vision-assistant/memory-watchdog";

function drainWarnings(): void {
  while (consumeMemoryWarning()) {
    // drain
  }
}

describe("SwWatchdog tick math", () => {
  test("first tick establishes the baseline, on-schedule ticks never stall", () => {
    const wd = new SwWatchdog({ checkIntervalMs: 1000, stallThresholdMs: 1000 });
    expect(wd.tick(1000)).toBeNull();
    expect(wd.tick(2000)).toBeNull(); // drift 0
    expect(wd.tick(1900)).toBeNull(); // early tick — negative drift
    expect(wd.tick(3000)).toBeNull(); // drift 100
  });

  test("a late tick past the stall threshold reports a stall", () => {
    const wd = new SwWatchdog({ checkIntervalMs: 1000, stallThresholdMs: 1000 });
    wd.tick(1000);
    const notice = wd.tick(12_000); // drift 10_000
    expect(notice).not.toBeNull();
    expect(notice!.kind).toBe("stall");
    expect(notice!.driftMs).toBe(10_000);
    expect(notice!.thresholdMs).toBe(1000);
    expect(notice!.message).toMatch(/10s/);
  });

  test("an OS-sleep gap is suppressed and primes the quiet window", () => {
    const wd = new SwWatchdog({
      checkIntervalMs: 1000,
      stallThresholdMs: 1000,
      maxReportableDriftMs: 60_000,
      suppressTicks: 2,
    });
    wd.tick(1000);
    expect(wd.tick(200_000)).toBeNull(); // drift 198_000 > 60_000 → suppressed
    expect(wd.tick(201_000)).toBeNull(); // quiet tick 1
    expect(wd.tick(202_000)).toBeNull(); // quiet tick 2
    expect(wd.tick(203_000)).toBeNull(); // drift 0 — normal again
  });
});

describe("runWatchdogCycle — what to surface this cycle", () => {
  test("returns null when there is nothing to surface", () => {
    const wd = new SwWatchdog({ checkIntervalMs: 1000, stallThresholdMs: 1000 });
    expect(runWatchdogCycle(wd, 1000)).toBeNull();
    expect(runWatchdogCycle(wd, 2000)).toBeNull();
  });

  test("returns the stall message when the event loop blocked", () => {
    const wd = new SwWatchdog({ checkIntervalMs: 1000, stallThresholdMs: 1000 });
    runWatchdogCycle(wd, 1000);
    const msg = runWatchdogCycle(wd, 12_000);
    expect(msg).toMatch(/stalled/);
  });

  test("drains a pending vision memory warning after the stall check", () => {
    const wd = new SwWatchdog({ checkIntervalMs: 1000, stallThresholdMs: 1000 });
    runWatchdogCycle(wd, 1000);
    pushMemoryWarning({
      kind: "memory-growth",
      message: "Vision model memory grew 400MB above baseline",
      growthMb: 400,
      baselineMb: 100,
      currentMb: 500,
    });
    expect(runWatchdogCycle(wd, 2000)).toMatch(/Vision model memory/);
    expect(runWatchdogCycle(wd, 3000)).toBeNull(); // consumed — no duplicate
  });
});

describe("startSwWatchdog wiring", () => {
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    drainWarnings();
    sendMessage = vi.fn().mockResolvedValue(undefined);
    (globalThis as Record<string, unknown>).chrome = { runtime: { sendMessage } };
  });

  afterEach(() => {
    stopSwWatchdog();
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).chrome;
  });

  test("emits one AGENT_EVENT warn for a pending vision memory warning", () => {
    startSwWatchdog({ checkIntervalMs: 1000, stallThresholdMs: 1000 });
    pushMemoryWarning({
      kind: "memory-growth",
      message: "Vision model memory grew 400MB above baseline",
      growthMb: 400,
      baselineMb: 100,
      currentMb: 500,
    });
    vi.advanceTimersByTime(1000); // baseline tick + drains the warning
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [payload] = sendMessage.mock.calls[0];
    expect(payload.type).toBe("AGENT_EVENT");
    expect(payload.event.type).toBe("warn");
    expect(payload.event.message).toMatch(/Vision model memory/);
    vi.advanceTimersByTime(2000); // two more cycles — nothing pending
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("startSwWatchdog is idempotent — one interval only", () => {
    startSwWatchdog({ checkIntervalMs: 1000, stallThresholdMs: 1000 });
    startSwWatchdog({ checkIntervalMs: 1000, stallThresholdMs: 1000 });
    pushMemoryWarning({
      kind: "memory-growth",
      message: "Vision model memory grew 400MB above baseline",
      growthMb: 400,
      baselineMb: 100,
      currentMb: 500,
    });
    vi.advanceTimersByTime(1000);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("stopSwWatchdog clears the interval", () => {
    startSwWatchdog({ checkIntervalMs: 1000, stallThresholdMs: 1000 });
    stopSwWatchdog();
    pushMemoryWarning({
      kind: "memory-growth",
      message: "Vision model memory grew 400MB above baseline",
      growthMb: 400,
      baselineMb: 100,
      currentMb: 500,
    });
    vi.advanceTimersByTime(5000);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
