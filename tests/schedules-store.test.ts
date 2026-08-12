/**
 * Phase 12 — schedules store (automation/scheduling Options surface).
 *
 * Covers the explicit command acknowledgement (wait-for-response) lifecycle:
 * list and each mutation move `pending → acked | failed`; a failed mutation
 * keeps the previously acknowledged task list (no silent loss); the mutation
 * summary records the outcome for the status line.
 */

import { describe, expect, test } from "vitest";
import {
  schedulesReducer,
  initialSchedulesState,
  type SchedulesState,
} from "../src/extension/options/stores/schedules-store";
import type { ScheduledTask } from "../src/lib/agent/scheduled-tasks";

function task(id: string): ScheduledTask {
  return {
    id,
    task: `task ${id}`,
    schedule: { type: "daily", hour: 9, minute: 0 },
    enabled: true,
    createdAt: 100,
    revision: 1,
  };
}

describe("schedules store", () => {
  test("list moves pending → acked with the worker task set", () => {
    let s: SchedulesState = schedulesReducer(initialSchedulesState, { type: "SCHEDULES_LIST_START" });
    expect(s.listAck.state).toBe("pending");
    s = schedulesReducer(s, { type: "SCHEDULES_LIST_OK", tasks: [task("a")] });
    expect(s.listAck.state).toBe("acked");
    expect(s.tasks).toHaveLength(1);
  });

  test("a failed list surfaces an explicit error and leaves tasks untouched", () => {
    const loaded = schedulesReducer(initialSchedulesState, {
      type: "SCHEDULES_LIST_OK",
      tasks: [task("a")],
    });
    let s = schedulesReducer(loaded, { type: "SCHEDULES_LIST_START" });
    s = schedulesReducer(s, { type: "SCHEDULES_LIST_FAIL", error: "background unreachable" });
    expect(s.listAck.state).toBe("failed");
    expect(s.listAck.error).toBe("background unreachable");
    expect(s.tasks).toHaveLength(1); // previously acknowledged list retained
  });

  test("a save mutation acks with the worker-confirmed list and records the outcome", () => {
    let s: SchedulesState = schedulesReducer(initialSchedulesState, {
      type: "SCHEDULES_MUTATION_START",
      kind: "save",
    });
    expect(s.mutationAck.state).toBe("pending");
    s = schedulesReducer(s, {
      type: "SCHEDULES_MUTATION_OK",
      kind: "save",
      tasks: [task("a")],
    });
    expect(s.mutationAck.state).toBe("acked");
    expect(s.tasks).toHaveLength(1);
    expect(s.lastMutation).toEqual({ kind: "save", ok: true });
  });

  test("a failed delete acks failed, keeps the list, and records the error", () => {
    const loaded = schedulesReducer(initialSchedulesState, {
      type: "SCHEDULES_LIST_OK",
      tasks: [task("a")],
    });
    let s = schedulesReducer(loaded, {
      type: "SCHEDULES_MUTATION_START",
      kind: "delete",
      taskId: "a",
    });
    s = schedulesReducer(s, {
      type: "SCHEDULES_MUTATION_FAIL",
      kind: "delete",
      taskId: "a",
      error: "SCHEDULED_TASK_REVISION_CONFLICT: changed in another window",
    });
    expect(s.mutationAck.state).toBe("failed");
    expect(s.tasks).toHaveLength(1); // no silent data loss
    expect(s.lastMutation).toEqual({
      kind: "delete",
      ok: false,
      taskId: "a",
      error: "SCHEDULED_TASK_REVISION_CONFLICT: changed in another window",
    });
  });

  test("a delete success replaces the task list with the worker-acknowledged set", () => {
    let s = schedulesReducer(initialSchedulesState, {
      type: "SCHEDULES_LIST_OK",
      tasks: [task("a"), task("b")],
    });
    s = schedulesReducer(s, { type: "SCHEDULES_MUTATION_START", kind: "delete", taskId: "a" });
    s = schedulesReducer(s, {
      type: "SCHEDULES_MUTATION_OK",
      kind: "delete",
      tasks: [task("b")],
      taskId: "a",
    });
    expect(s.tasks.map((t) => t.id)).toEqual(["b"]);
    expect(s.lastMutation).toEqual({ kind: "delete", ok: true, taskId: "a" });
  });

  test("a toggle mutation acks with the worker-confirmed enabled state", () => {
    let s = schedulesReducer(initialSchedulesState, {
      type: "SCHEDULES_LIST_OK",
      tasks: [task("a")],
    });
    s = schedulesReducer(s, { type: "SCHEDULES_MUTATION_START", kind: "toggle", taskId: "a" });
    const disabled = { ...task("a"), enabled: false, revision: 2 };
    s = schedulesReducer(s, {
      type: "SCHEDULES_MUTATION_OK",
      kind: "toggle",
      tasks: [disabled],
      taskId: "a",
    });
    expect(s.tasks[0].enabled).toBe(false);
    expect(s.lastMutation).toEqual({ kind: "toggle", ok: true, taskId: "a" });
  });
});
