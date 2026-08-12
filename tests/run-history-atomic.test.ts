/**
 * run-history atomic-commit hardening — the data list and the revision counter
 * must land in ONE storage write (no lost-update window), oversized lists are
 * quota-trimmed BEFORE the commit (oldest entries dropped, never a swallowed
 * QUOTA_BYTES rejection), the byte accounting is real UTF-8 measurement, and
 * the age-filtered read prunes expired entries back to storage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeChromeStorageMock } from "./helpers/chrome-storage-mock";
import {
  saveRun,
  replaceAllRuns,
  clearAllRuns,
  loadRuns,
} from "../src/lib/agent/run-history";
import { STORAGE_KEY, HISTORY_REVISION_KEY, serializedByteSize } from "../src/lib/agent/run-history-utils";
import type { RunRecord } from "../src/lib/agent/run-history-utils";

let localStore: Map<string, unknown>;
let setSpy: ReturnType<typeof vi.fn>;

function installChrome(local: Map<string, unknown> = new Map()): void {
  localStore = local;
  const mock = makeChromeStorageMock(local, new Map()) as unknown as {
    storage: { local: { set: (...args: unknown[]) => unknown } };
  };
  (globalThis as Record<string, unknown>).chrome = mock as unknown as typeof chrome;
  setSpy = vi.spyOn(mock.storage.local, "set");
}

function makeRun(id: string, startedAt = Date.now(), steps: unknown[] = []): RunRecord {
  return {
    id,
    task: `task-${id}`,
    startedAt,
    endedAt: startedAt + 1000,
    steps: steps as RunRecord["steps"],
    logs: [],
    result: { success: true, text: "done" },
    totalTokensIn: 1,
    totalTokensOut: 1,
    totalCostUsd: 0.01,
    stepCount: 1,
    overflowCount: 0,
  };
}

beforeEach(() => {
  installChrome();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).chrome;
});

describe("atomic history commits", () => {
  it("writes data + revision in a single storage.set", async () => {
    await saveRun(makeRun("r1"));
    expect(setSpy).toHaveBeenCalledTimes(1);
    const payload = setSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload[STORAGE_KEY]).toEqual([expect.objectContaining({ id: "r1" })]);
    expect(payload[HISTORY_REVISION_KEY]).toBe(1);
    // The revision counter is already committed — no follow-up read-modify-write.
    expect(localStore.get(HISTORY_REVISION_KEY)).toBe(1);
  });

  it("monotonic revisions across saves and a clear", async () => {
    await saveRun(makeRun("r1"));
    await saveRun(makeRun("r2"));
    expect(localStore.get(HISTORY_REVISION_KEY)).toBe(2);
    await clearAllRuns();
    expect(localStore.get(HISTORY_REVISION_KEY)).toBe(3);
    expect(localStore.get(STORAGE_KEY)).toEqual([]);
  });
});

describe("quota guard", () => {
  it("drops oldest entries before commit when the list exceeds the budget", async () => {
    // Two runs whose serialized size (as a pair) exceeds the 8 MiB budget.
    // Save the older run first; the newer save sits at the list head.
    const big = "x".repeat(5 * 1024 * 1024);
    await saveRun(makeRun("older", Date.now() - 1000, [{ type: "info", message: big }]));
    await saveRun(makeRun("new", Date.now(), [{ type: "info", message: big }]));
    const stored = localStore.get(STORAGE_KEY) as RunRecord[];
    // The quota trim kept only the newest-saved run (oldest dropped before set).
    expect(stored.length).toBe(1);
    expect(stored[0].id).toBe("new");
  });

  it("never commits an empty list (single oversized run survives)", async () => {
    const big = "x".repeat(9 * 1024 * 1024);
    await saveRun(makeRun("only", Date.now(), [{ type: "info", message: big }]));
    const stored = localStore.get(STORAGE_KEY) as RunRecord[];
    expect(stored.length).toBe(1);
    expect(stored[0].id).toBe("only");
  });
});

describe("real byte measurement", () => {
  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    const ascii = serializedByteSize("x".repeat(100));
    const multiByte = serializedByteSize("é".repeat(100)); // 2 bytes/char in UTF-8
    expect(multiByte).toBeGreaterThan(ascii);
    expect(serializedByteSize({})).toBe(2); // "{}"
  });
});

describe("retention prune write-back", () => {
  it("persists the age-filtered list back to storage when entries expired", async () => {
    const now = Date.now();
    await replaceAllRuns([
      makeRun("fresh", now),
      makeRun("expired", now - 31 * 24 * 60 * 60 * 1000),
    ]);
    const fresh = await loadRuns();
    expect(fresh.map((r) => r.id)).toEqual(["fresh"]);
    // The lazy prune wrote the expired entry out of storage.
    const stored = localStore.get(STORAGE_KEY) as RunRecord[];
    expect(stored.map((r) => r.id)).toEqual(["fresh"]);
  });

  it("does not write back when nothing expired", async () => {
    const now = Date.now();
    await replaceAllRuns([makeRun("a", now), makeRun("b", now - 1000)]);
    const before = setSpy.mock.calls.length;
    await loadRuns();
    expect(setSpy.mock.calls.length).toBe(before);
  });
});
