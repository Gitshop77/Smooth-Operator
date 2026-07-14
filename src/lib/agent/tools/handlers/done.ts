/** `done` action handler — terminal action; respects `params.success`. */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import type { ActionContext } from "./types";

export async function handleDone(
  _ctx: ActionContext,
  action: Extract<Action, { type: "done" }>,
): Promise<ActionResult> {
  return {
    action,
    success: action.success,
    message: action.success ? `Task complete: ${action.text ?? ""}` : `Task incomplete: ${action.text ?? ""}`,
    isDone: true,
  };
}
