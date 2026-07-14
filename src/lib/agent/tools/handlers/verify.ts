/**
 * `verify` action handler — record the expectation in history (via
 * `extractedContent`) so the next navigator step can re-observe the page
 * and check against it. Pure "prompt the LLM to look" action.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import type { ActionContext } from "./types";

/** Control characters stripped from the recorded expectation. */
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F\u0085\u2028\u2029]/g;

export async function handleVerify(
  _ctx: ActionContext,
  action: Extract<Action, { type: "verify" }>,
): Promise<ActionResult> {
  // The executor itself doesn't perform verification — the expectation
  // is recorded in history (via `extractedContent`) so the next
  // navigator step can re-observe the page and check against it. This
  // keeps verify as a pure "prompt the LLM to look" action.
  // Sanitize the agent-supplied expectation before it lands in logs/history:
  // bound its length (prevents token/storage amplification from an
  // oversized value) and strip control characters (CR/LF etc.) to prevent
  // log-line forging.
  let exp = String(action.expectation ?? "");
  if (exp.length > 8192) exp = exp.slice(0, 8192);
  exp = exp.replace(CONTROL_CHARS_RE, "");
  return {
    action,
    success: true,
    message: `Verify requested: ${exp}`,
    extractedContent: `Verification expectation: ${exp}`,
  };
}
