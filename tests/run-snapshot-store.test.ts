import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/lib/agent/secrets", () => ({
  redactSecrets: async (value: string) => value.replace(/stored-secret-value/g, "[REDACTED:stored]"),
  redactLiveSecretValue: (value: string) => value.replace(/stored-secret-value/g, "[REDACTED:stored]"),
}));

import {
  LAST_RUN_SNAPSHOT_KEY,
  flushRunSnapshot,
  getPersistedRunSnapshot,
  persistInterruptedRunSnapshot,
  persistRunSnapshot,
  resetRunSnapshotWriteChainForTests,
} from "../src/extension/background/run-snapshot-store";
import type { RunSnapshotV1 } from "../src/extension/background/run-controller";

const session: Record<string, unknown> = {};

function snapshot(revision: number): RunSnapshotV1 {
  return {
    version: 1,
    runId: "run-1",
    revision,
    dispatchRevision: 1,
    task: "use stored-secret-value",
    maxSteps: 10,
    mode: "standard",
    status: "running",
    phase: "reasoning",
    step: 1,
    startedAt: 1,
    updatedAt: revision,
  };
}

describe("run snapshot session persistence", () => {
  beforeEach(() => {
    for (const key of Object.keys(session)) delete session[key];
    resetRunSnapshotWriteChainForTests();
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        session: {
          get: vi.fn(async (key: string) => ({ [key]: session[key] })),
          set: vi.fn(async (values: Record<string, unknown>) => Object.assign(session, values)),
        },
      },
    };
  });

  test("serializes revisions in call order and redacts sensitive text", async () => {
    await persistRunSnapshot(snapshot(1));
    await persistRunSnapshot(snapshot(2));
    await flushRunSnapshot();
    expect(session[LAST_RUN_SNAPSHOT_KEY]).toMatchObject({ revision: 2, task: "use [REDACTED:stored]" });
    expect((await getPersistedRunSnapshot())?.revision).toBe(2);
  });

  test("a burst of streaming snapshots coalesces to latest-wins writes", async () => {
    const chromeStub = globalThis.chrome as unknown as {
      storage: { session: { set: ReturnType<typeof vi.fn> } };
    };
    const sessionSet = chromeStub.storage.session.set;
    sessionSet.mockClear();
    // Cold start: the first event writes immediately (panel latency), the
    // remaining burst events coalesce into ONE trailing latest-wins flush —
    // N writes collapse to 2.
    await persistRunSnapshot(snapshot(1));
    await persistRunSnapshot(snapshot(2));
    await persistRunSnapshot(snapshot(3));
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the immediate write land
    expect(sessionSet).toHaveBeenCalledTimes(1);
    expect(session[LAST_RUN_SNAPSHOT_KEY]).toMatchObject({ revision: 1 });
    await flushRunSnapshot();
    expect(sessionSet).toHaveBeenCalledTimes(2);
    expect(session[LAST_RUN_SNAPSHOT_KEY]).toMatchObject({ revision: 3 });
  });

  test("redacts unknown key-shaped provider text that is absent from the secret store", async () => {
    const value = snapshot(1);
    value.status = "failed";
    value.phase = "terminal";
    value.terminalMessage = "Provider rejected sk-proj-SECRET1234567890TOKEN";
    value.resultText = "Bearer abcdefghijklmnopqrstuvwxyz";
    await persistRunSnapshot(value);
    const stored = session[LAST_RUN_SNAPSHOT_KEY] as RunSnapshotV1;
    expect(stored.terminalMessage).not.toContain("SECRET1234567890TOKEN");
    expect(stored.resultText).toBe("Bearer [REDACTED]");
  });

  test("rejects unknown versions and malformed lifecycle fields at the shared V1 boundary", async () => {
    session[LAST_RUN_SNAPSHOT_KEY] = { ...snapshot(1), version: 2 };
    expect(await getPersistedRunSnapshot()).toBeNull();

    session[LAST_RUN_SNAPSHOT_KEY] = { ...snapshot(1), status: "paused" };
    expect(await getPersistedRunSnapshot()).toBeNull();

    session[LAST_RUN_SNAPSHOT_KEY] = { ...snapshot(1), terminalReason: "mystery" };
    expect(await getPersistedRunSnapshot()).toBeNull();
  });

  test("turns a legacy active state into a terminal interrupted snapshot", async () => {
    const interrupted = await persistInterruptedRunSnapshot(
      {
        task: "legacy",
        maxSteps: 10,
        mode: "standard",
        startTabId: 1,
        currentTabId: 1,
        step: 3,
        active: true,
        abortRequested: false,
      },
      "Worker restarted",
      50,
    );
    expect(interrupted).toMatchObject({
      status: "interrupted",
      phase: "terminal",
      terminalReason: "interrupted",
      terminalMessage: "Worker restarted",
      // RunState keeps the loop's zero-based index; RunSnapshotV1 is the
      // user-facing one-based step contract shared with transcript/history.
      step: 4,
      endedAt: 50,
    });
  });
});
