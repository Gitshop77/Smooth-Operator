/**
 * options/stores/schedules-store.ts — authoritative scheduled-task list state
 * for the Options automation surface.
 *
 * The background worker remains the only mutation authority; this store
 * mirrors the acknowledged result of each typed command (list/save/delete/
 * toggle) so the DOM renders only the worker-confirmed task set.  Every
 * mutation carries an explicit ack (`pending → acked | failed`) and a failed
 * command leaves the previous task list intact — never a silently-empty one.
 */

import type { ScheduledTask } from "@/lib/agent/scheduled-tasks";
import {
  beginAck,
  ackOk,
  ackFail,
  IDLE_ACK,
  type CommandAck,
  type CommandOutcome,
} from "./store";

export interface SchedulesState {
  tasks: ScheduledTask[];
  listAck: CommandAck;
  /** Ack of the most recent save/delete/toggle command (wait-for-response). */
  mutationAck: CommandAck;
  /** Bounded summary of the last settled mutation for the status line. */
  lastMutation?: CommandOutcome;
}

export type SchedulesAction =
  | { type: "SCHEDULES_LIST_START" }
  | { type: "SCHEDULES_LIST_OK"; tasks: ScheduledTask[] }
  | { type: "SCHEDULES_LIST_FAIL"; error: string }
  | { type: "SCHEDULES_MUTATION_START"; kind: "save" | "delete" | "toggle"; taskId?: string }
  | { type: "SCHEDULES_MUTATION_OK"; kind: "save" | "delete" | "toggle"; tasks: ScheduledTask[]; taskId?: string }
  | { type: "SCHEDULES_MUTATION_FAIL"; kind: "save" | "delete" | "toggle"; error: string; taskId?: string };

export const initialSchedulesState: SchedulesState = {
  tasks: [],
  listAck: IDLE_ACK,
  mutationAck: IDLE_ACK,
};

export function schedulesReducer(
  state: SchedulesState,
  action: SchedulesAction,
): SchedulesState {
  switch (action.type) {
    case "SCHEDULES_LIST_START":
      return { ...state, listAck: beginAck() };
    case "SCHEDULES_LIST_OK":
      return { ...state, tasks: action.tasks, listAck: ackOk(state.listAck) };
    case "SCHEDULES_LIST_FAIL":
      return { ...state, listAck: ackFail(state.listAck, action.error) };
    case "SCHEDULES_MUTATION_START":
      return {
        ...state,
        mutationAck: beginAck(),
        lastMutation: { kind: action.kind, ok: false, taskId: action.taskId },
      };
    case "SCHEDULES_MUTATION_OK":
      return {
        ...state,
        tasks: action.tasks,
        mutationAck: ackOk(state.mutationAck),
        lastMutation: { kind: action.kind, ok: true, taskId: action.taskId },
      };
    case "SCHEDULES_MUTATION_FAIL":
      return {
        // A failed mutation must not drop the acknowledged task list.
        ...state,
        mutationAck: ackFail(state.mutationAck, action.error),
        lastMutation: { kind: action.kind, ok: false, taskId: action.taskId, error: action.error },
      };
  }
}
