/**
 * E1 — structured JSON-lines logging with run IDs.
 *
 * The logger emits one JSON line per event ({ts, level, msg, runId, ...fields}),
 * keeps a bounded in-memory ring, and the run builder drains the ring into the
 * persisted run record at finish (redacted before storage).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  log,
  LOG_RING_CAPACITY,
  drainLogRing,
  getActiveRunId,
  setActiveRunId,
} from "../src/lib/agent/logging";
import { RunBuilder } from "../src/lib/agent/run-history";
import { redactRunSecrets } from "../src/lib/agent/run-history-utils";

describe("logging helper", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    drainLogRing();
    setActiveRunId(null);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    drainLogRing();
    setActiveRunId(null);
  });

  it("emits one JSON line per event with ts/level/msg/runId", () => {
    setActiveRunId("run-123");
    log("info", "run started", { step: 1 });
    expect(debugSpy).toHaveBeenCalledTimes(1);
    const line = debugSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({
      level: "info",
      msg: "run started",
      runId: "run-123",
      step: 1,
    });
    expect(typeof parsed.ts).toBe("string");
    expect(new Date(parsed.ts).getTime()).not.toBeNaN();
  });

  it("routes error to console.error and warn to console.warn", () => {
    log("error", "boom");
    log("warn", "careful");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(errorSpy.mock.calls[0][0] as string).level).toBe("error");
    expect(JSON.parse(warnSpy.mock.calls[0][0] as string).level).toBe("warn");
  });

  it("routes info and debug to console.debug", () => {
    log("info", "i");
    log("debug", "d");
    expect(debugSpy).toHaveBeenCalledTimes(2);
  });

  it("uses an empty runId when no run is active", () => {
    log("warn", "no run");
    expect(JSON.parse(warnSpy.mock.calls[0][0] as string).runId).toBe("");
  });

  it("keeps the ring bounded to LOG_RING_CAPACITY, dropping the oldest", () => {
    for (let i = 0; i < LOG_RING_CAPACITY + 50; i++) {
      log("info", `msg-${i}`);
    }
    const ring = drainLogRing();
    expect(ring).toHaveLength(LOG_RING_CAPACITY);
    expect(ring[0].msg).toBe("msg-50");
    expect(ring[ring.length - 1].msg).toBe(`msg-${LOG_RING_CAPACITY + 49}`);
  });

  it("drainLogRing returns entries in order and empties the ring", () => {
    log("info", "a");
    log("warn", "b");
    const first = drainLogRing();
    expect(first.map((e) => e.msg)).toEqual(["a", "b"]);
    expect(drainLogRing()).toEqual([]);
  });

  it("getActiveRunId reflects setActiveRunId", () => {
    expect(getActiveRunId()).toBeNull();
    setActiveRunId("r1");
    expect(getActiveRunId()).toBe("r1");
  });

  it("falls back to a primitive-only line when fields cannot be stringified", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => log("error", "circular", { bad: circular })).not.toThrow();
    const line = errorSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.msg).toBe("circular");
  });
});

describe("RunBuilder wiring", () => {
  beforeEach(() => {
    drainLogRing();
    setActiveRunId(null);
  });

  it("threads the run id into the logger while the builder is active", () => {
    const builder = new RunBuilder("task");
    expect(getActiveRunId()).toBe(builder.id);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    log("warn", "mid-run");
    expect(JSON.parse(warnSpy.mock.calls[0][0] as string).runId).toBe(builder.id);
    builder.finish({ success: true, text: "done" });
    expect(getActiveRunId()).toBeNull();
    vi.restoreAllMocks();
  });

  it("drains the ring into the finished run record with the run id", () => {
    const builder = new RunBuilder("task");
    log("warn", "first");
    log("error", "second", { code: "x" });
    const run = builder.finish({ success: true, text: "done" });
    expect(run.logs.map((l) => l.msg)).toEqual(["run started", "first", "second", "run ended"]);
    for (const entry of run.logs) {
      expect(entry.runId).toBe(builder.id);
    }
  });

  it("does not leak a previous run's lines into the next run", () => {
    const a = new RunBuilder("a");
    log("warn", "from-a");
    a.finish({ success: true, text: "done" });

    const b = new RunBuilder("b");
    log("warn", "from-b");
    const runB = b.finish({ success: true, text: "done" });
    expect(runB.logs.map((l) => l.msg)).toEqual(["run started", "from-b", "run ended"]);
  });

  it("persists logs through saveRun with key-shape secrets redacted", async () => {
    const builder = new RunBuilder("task");
    log("error", "key leaked", { key: "sk-1234567890abcdefghijklmnopqrstuvwxyz" });
    const run = builder.finish({ success: true, text: "done" });

    const redacted = await redactRunSecrets(run);
    const leaked = redacted.logs.filter((l) => l.msg === "key leaked");
    expect(leaked).toHaveLength(1);
    expect(leaked[0].key).not.toContain("sk-");
    expect(leaked[0].key).toContain("[redacted]");
    expect(run.logs.find((l) => l.msg === "key leaked")!.key).toContain("sk-");
  });
});
