/**
 * `takeover` action handler — signal intent to pause the loop. The
 * orchestrator intercepts this result and pauses until the user clicks
 * Resume in the side panel.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import type { ActionContext } from "./types";

export async function handleTakeover(
  _ctx: ActionContext,
  action: Extract<Action, { type: "takeover" }>,
): Promise<ActionResult> {
 // Signal intent — the orchestrator intercepts this result and pauses
 // the loop until the user clicks Resume in the side panel. The
 // extractedContent surfaces the reason in the next navigator step's
 // history so the LLM knows why it paused.
  return {
    action,
    success: true,
    message: `Takeover requested: ${action.reason}`,
    extractedContent: `User takeover needed: ${action.reason}`,
  };
}
