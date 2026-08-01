/**
 * `takeover` action handler — signal intent to pause the loop. The
 * orchestrator intercepts this result and pauses until the user clicks
 * Resume in the side panel.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import type { ActionContext } from "./types";
import { sanitizeForLog } from "../constants";

export async function handleTakeover(
  _ctx: ActionContext,
  action: Extract<Action, { type: "takeover" }>,
): Promise<ActionResult> {
  // Signal intent — the orchestrator intercepts this result and pauses
  // the loop until the user clicks Resume in the side panel; the reason
  // is surfaced in extractedContent for the next navigator step. Sanitize
  // it (bound length + strip control characters) before it lands in
  // logs/history to prevent log-line forging / prompt-parsing disruption.
  const reason = sanitizeForLog(action.reason ?? "(no reason provided)");
  return {
    action,
    success: true,
    message: `Takeover requested: ${reason}`,
    extractedContent: `User takeover needed: ${reason}`,
  };
}
