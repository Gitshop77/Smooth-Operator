import { beforeEach, describe, expect, test } from "vitest";
import type { RunSnapshotV1 } from "../src/extension/background/run-controller";
import {
  applyRunEvent,
  beginLocalRun,
  getRunViewState,
  hydrateRunSnapshot,
  resetRunStoreForTests,
} from "../src/extension/sidepanel/run-store";

function snapshot(overrides: Partial<RunSnapshotV1> = {}): RunSnapshotV1 {
  return {
    version: 1,
    runId: "run-a",
    revision: 4,
    dispatchRevision: 1,
    task: "summarize this page",
    maxSteps: 10,
    mode: "standard",
    status: "running",
    phase: "reasoning",
    step: 2,
    startedAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

describe("side-panel run snapshot store", () => {
  beforeEach(() => resetRunStoreForTests());

  test("hydrates a running snapshot after remount", () => {
    expect(hydrateRunSnapshot(snapshot())).toBe(true);
    expect(getRunViewState()).toMatchObject({
      task: "summarize this page", status: "running", phase: "reasoning", step: 2,
    });
  });

  test("rejects malformed and unknown-version snapshots through the shared decoder", () => {
    expect(hydrateRunSnapshot({ ...snapshot(), version: 2 })).toBe(false);
    expect(hydrateRunSnapshot({ ...snapshot(), phase: "paused" })).toBe(false);
    expect(hydrateRunSnapshot({ ...snapshot(), terminalReason: "mystery" })).toBe(false);
    expect(getRunViewState()).toEqual({ task: "", status: "idle" });
  });

  test("hydrates a terminal result and permits a second run without reload", () => {
    hydrateRunSnapshot(snapshot({
      status: "succeeded", phase: "terminal", revision: 7,
      terminalMessage: "Completed", resultText: "Three bullet summary", endedAt: 300,
    }));
    expect(getRunViewState()).toMatchObject({
      status: "succeeded", resultText: "Three bullet summary", terminalMessage: "Completed",
    });

    beginLocalRun("follow-up");
    expect(getRunViewState()).toMatchObject({ task: "follow-up", status: "starting", phase: "starting" });
    expect(getRunViewState().terminalMessage).toBeUndefined();
  });

  test("admits the matching transcript event after snapshot hydration and dedupes event order separately", () => {
    hydrateRunSnapshot(snapshot());
    const event = {
      type: "thinking", step: 2, text: "current", evaluation: "", memory: "", nextGoal: "current",
    } as const;
    // Storage snapshot revision 4 may arrive before AGENT_EVENT revision 4.
    // It must not consume that transcript envelope's independent cursor.
    expect(applyRunEvent(event, { runId: "run-a", revision: 4 })).toBe(true);
    expect(applyRunEvent(event, { runId: "run-a", revision: 4 })).toBe(false);
    expect(applyRunEvent(event, { runId: "run-a", revision: 3 })).toBe(false);
    expect(applyRunEvent(event, { runId: "run-b", revision: 5 })).toBe(false);
    expect(applyRunEvent(event, { runId: "run-a", revision: 5 })).toBe(true);
    expect(applyRunEvent(event, { runId: "run-a", revision: 5 })).toBe(false);
  });

  test("a second panel can reconcile a successor run after a terminal predecessor", () => {
    hydrateRunSnapshot(snapshot({ status: "succeeded", phase: "terminal", revision: 40, endedAt: 250 }));
    const event = {
      type: "thinking", step: 0, text: "Choosing the next action.", evaluation: "", memory: "", nextGoal: "Choosing the next action.",
    } as const;

    // Before STATUS returns, the panel deliberately refuses to render a
    // cross-run transcript event. The event still causes controls to request
    // STATUS; the returned successor snapshot must reset its event revision.
    expect(applyRunEvent(event, { runId: "run-b", revision: 1 })).toBe(false);
    expect(hydrateRunSnapshot(snapshot({
      runId: "run-b", revision: 1, dispatchRevision: 1, task: "follow-up",
      status: "running", phase: "reasoning", step: 0, startedAt: 300,
    }))).toBe(true);
    expect(applyRunEvent(event, { runId: "run-b", revision: 2 })).toBe(true);
    expect(getRunViewState()).toMatchObject({ task: "follow-up", status: "running" });
  });

  test("rejects delayed predecessor cancellation transcript envelopes after successor hydration", () => {
    const cancellationInfo = { type: "info", message: "Agent stopped by user." } as const;
    const cancellationDone = {
      type: "done", step: 0, success: false, text: "Agent stopped by user.",
    } as const;
    hydrateRunSnapshot(snapshot({
      runId: "run-old", status: "cancelled", phase: "terminal", revision: 8, endedAt: 250,
    }));
    hydrateRunSnapshot(snapshot({
      runId: "run-new", task: "successor", revision: 1, startedAt: 300, updatedAt: 300,
    }));

    expect(applyRunEvent(cancellationInfo, { runId: "run-old", revision: 9 })).toBe(false);
    expect(applyRunEvent(cancellationDone, { runId: "run-old", revision: 10 })).toBe(false);
    // Legacy external diagnostics still work after V1 ownership, but the old
    // unversioned cancellation signature is unsafe and deliberately dropped.
    expect(applyRunEvent({ type: "info", message: "legacy diagnostic" })).toBe(true);
    expect(applyRunEvent(cancellationInfo)).toBe(false);
  });

  test("admits the two current cancellation transcript envelopes exactly once", () => {
    const info = { type: "info", message: "Agent stopped by user." } as const;
    const done = { type: "done", step: 2, success: false, text: "Agent stopped by user." } as const;
    hydrateRunSnapshot(snapshot({ runId: "run-a", revision: 10, status: "cancelling", phase: "cancelling" }));

    expect(applyRunEvent(info, { runId: "run-a", revision: 12 })).toBe(true);
    expect(applyRunEvent(done, { runId: "run-a", revision: 13 })).toBe(true);
    expect(applyRunEvent(info, { runId: "run-a", revision: 12 })).toBe(false);
    expect(applyRunEvent(done, { runId: "run-a", revision: 13 })).toBe(false);
  });
});

describe("Events are transcript facts, never lifecycle state (ADR-005)", () => {
  beforeEach(() => resetRunStoreForTests());

  test("an unversioned run-start event no longer drives the lifecycle projection", () => {
    const runStart = { type: "run-start", task: "summarize", maxSteps: 10 } as const;
    // Without any snapshot, the event is admitted for the transcript…
    expect(applyRunEvent(runStart)).toBe(true);
    // …but it must NOT mutate the store: the panel renders strictly from
    // snapshots and reconciles STATUS after each admitted event.
    expect(getRunViewState()).toEqual({ task: "", status: "idle" });
  });

  test("an unversioned terminal event cannot flip the store to a terminal state", () => {
    hydrateRunSnapshot(snapshot({ status: "running", phase: "reasoning", revision: 6 }));
    const done = { type: "done", step: 0, success: true, text: "finished" } as const;
    expect(applyRunEvent(done)).toBe(true); // transcript-only admission
    expect(getRunViewState()).toMatchObject({ status: "running", phase: "reasoning" });
  });

  test("the unsafe unversioned cancellation signature is still dropped", () => {
    expect(applyRunEvent({ type: "info", message: "Agent stopped by user." })).toBe(false);
    expect(getRunViewState()).toEqual({ task: "", status: "idle" });
  });

  test("a late unversioned event after a terminal snapshot cannot regress the projection", () => {
    hydrateRunSnapshot(snapshot({
      status: "succeeded", phase: "terminal", revision: 20,
      terminalMessage: "Done", resultText: "Summary", endedAt: 300,
    }));
    applyRunEvent({ type: "thinking", step: 1, text: "late", evaluation: "", memory: "", nextGoal: "late" });
    expect(getRunViewState()).toMatchObject({ status: "succeeded", resultText: "Summary" });
  });
});

describe("Multi-panel behavior", () => {
  beforeEach(() => resetRunStoreForTests());

  test("a second panel (fresh store) converges to an identical projection from the same inputs", () => {
    // Panel A: hydrate + admit the event stream.
    const running = snapshot({ runId: "run-x", revision: 5, status: "running", phase: "acting", step: 3 });
    hydrateRunSnapshot(running);
    applyRunEvent({ type: "thinking", step: 4, text: "next", evaluation: "", memory: "", nextGoal: "next" }, { runId: "run-x", revision: 6 });
    const panelAState = getRunViewState();

    // Panel B: same run, reopened as a fresh document (module state reset).
    resetRunStoreForTests();
    hydrateRunSnapshot(running);
    applyRunEvent({ type: "thinking", step: 4, text: "next", evaluation: "", memory: "", nextGoal: "next" }, { runId: "run-x", revision: 6 });
    const panelBState = getRunViewState();

    expect(panelBState.snapshot).toEqual(panelAState.snapshot);
    expect(panelBState).toMatchObject({ task: "summarize this page", status: "running", phase: "acting", step: 3 });
    expect(panelBState.snapshot?.runId).toBe("run-x");
  });

  test("reopen/remount hydrates the LATEST snapshot and rejects an older one", () => {
    hydrateRunSnapshot(snapshot({ runId: "run-y", revision: 10, status: "running", phase: "reasoning", step: 2 }));
    // An older snapshot arriving late (storage race) must not regress.
    expect(hydrateRunSnapshot(snapshot({ runId: "run-y", revision: 3, status: "starting", phase: "starting" }))).toBe(false);
    expect(getRunViewState()).toMatchObject({ status: "running", phase: "reasoning", step: 2 });

    // A remount (fresh panel) that reads the persisted snapshot gets the same
    // latest projection.
    resetRunStoreForTests();
    hydrateRunSnapshot(snapshot({ runId: "run-y", revision: 10, status: "running", phase: "reasoning", step: 2 }));
    expect(getRunViewState()).toMatchObject({ task: "summarize this page", status: "running", step: 2 });
    expect(getRunViewState().snapshot?.revision).toBe(10);
    expect(getRunViewState().snapshot?.runId).toBe("run-y");
  });

  test("out-of-order late events never corrupt the store after the latest snapshot", () => {
    hydrateRunSnapshot(snapshot({ runId: "run-z", revision: 30, status: "succeeded", phase: "terminal", resultText: "final", endedAt: 500 }));
    // Late events from earlier revisions of the SAME run are admitted for the
    // transcript only if they advance the event cursor; they cannot change the
    // hydrated lifecycle.
    applyRunEvent({ type: "action", step: 9, index: 0, total: 1, name: "click", description: "late action" }, { runId: "run-z", revision: 31 });
    applyRunEvent({ type: "error", step: 9, message: "late error", recoverable: false }, { runId: "run-z", revision: 32 });
    expect(getRunViewState()).toMatchObject({ status: "succeeded", resultText: "final" });
  });

  test("a successor run on a second panel replaces the terminal predecessor identically", () => {
    hydrateRunSnapshot(snapshot({ runId: "run-prev", status: "failed", phase: "terminal", revision: 9, terminalMessage: "boom", endedAt: 400 }));
    const successor = snapshot({ runId: "run-next", task: "retry", revision: 1, startedAt: 500, updatedAt: 500 });
    expect(hydrateRunSnapshot(successor)).toBe(true);
    expect(getRunViewState()).toMatchObject({ task: "retry", status: "running" });
    expect(getRunViewState().terminalMessage).toBeUndefined();
  });
});
