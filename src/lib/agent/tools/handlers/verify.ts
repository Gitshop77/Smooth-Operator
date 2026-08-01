/**
 * `verify` action handler — record the expectation in history (via
 * `extractedContent`) so the next navigator step can re-observe the page
 * and check against it. Pure "prompt the LLM to look" action.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import type { ActionContext } from "./types";
import { sanitizeForLog } from "../constants";

export async function handleVerify(
  _ctx: ActionContext,
  action: Extract<Action, { type: "verify" }>,
): Promise<ActionResult> {
  // The executor itself doesn't perform verification — the expectation
  // is recorded in history (via `extractedContent`) so the next
  // navigator step can re-observe the page and check against it. This
  // keeps verify as a pure "prompt the LLM to look" action.
  // Sanitize the agent-supplied expectation (bound length + strip control
  // characters) before it lands in logs/history.
  const exp = sanitizeForLog(action.expectation ?? "");
  return {
    action,
    success: true,
    message: `Verify requested: ${exp}`,
    extractedContent: `Verification expectation: ${exp}`,
  };
}
