/**
 * `takeover` action handler — signal intent to pause the loop. The
 * orchestrator intercepts this result and pauses until the user clicks
 * Resume in the side panel.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import type { ActionContext } from "./types";

/** Control characters stripped from the takeover reason. */
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F\u0085\u2028\u2029]/g;

export async function handleTakeover(
  _ctx: ActionContext,
  action: Extract<Action, { type: "takeover" }>,
): Promise<ActionResult> {
 // Signal intent — the orchestrator intercepts this result and pauses
 // the loop until the user clicks Resume in the side panel. The
 // extractedContent surfaces the reason in the next navigator step's
 // history so the LLM knows why it paused.
 // Sanitize the agent-supplied reason before it lands in logs/history:
 // bound its length and strip control characters (CR/LF etc.) to prevent
 // log-line forging / prompt-parsing disruption.
  let reason = String(action.reason ?? "(no reason provided)");
  if (reason.length > 8192) reason = reason.slice(0, 8192);
  reason = reason.replace(CONTROL_CHARS_RE, "");
  return {
    action,
    success: true,
    message: `Takeover requested: ${reason}`,
    extractedContent: `User takeover needed: ${reason}`,
  };
}
