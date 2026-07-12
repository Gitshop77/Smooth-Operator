/**
 * `ask_human` action handler — call `askHuman()` and wait for the user's
 * response. Password-mode responses are redacted so the real value never
 * reaches the LLM via `extractedContent` or `message`.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { LIMITS } from "../constants";
import type { ActionContext } from "./types";

export async function handleAskHuman(
  _ctx: ActionContext,
  action: Extract<Action, { type: "ask_human" }>,
): Promise<ActionResult> {
  // Call askHuman() and wait for the user's response. askHuman() auto-detects
  // context (extension: side-panel message; demo: window.prompt) and pauses
  // until the user responds or the 5-minute timeout fires.
  //
  // The `mode` field routes between visible input and masked password input.
  // For `password` mode, the executor returns a redacted message — the real
  // value never reaches the LLM via `extractedContent`. (Callers that want
  // the value typed into a field should pair `ask_human` with `password`
  // mode + an `input` action whose `text` is a `%secret_name%` placeholder,
  // so the secret crosses the ask_human channel and is substituted at
  // input-type time.)
  try {
    const { askHuman } = await import("../../human-interaction");
    const isPassword = (action.mode ?? "input") === "password";
    const response = await askHuman({
      mode: isPassword ? "password" : "input",
      message: action.question,
    });
    if (response.mode === "cancelled") {
      return {
        action,
        success: false,
        message: `User dismissed the question: ${action.question.slice(0, LIMITS.askHumanQuestionChars)}`,
        extractedContent: `User dismissed the question. No answer provided.`,
      };
    }
    const answer = "value" in response ? response.value : "(no text response)";
    if (isPassword) {
      // Never surface the password VALUE in the message or extractedContent —
      // both fields are replayed into subsequent LLM prompts and persisted to
      // disk via run-history.ts. The agent should pair this with an `input`
      // action using a %secret% placeholder. We report only the *length* (so
      // downstream tooling knows a value was captured) — the actual characters
      // are never included, keeping the secret redacted.
      return {
        action,
        success: true,
        message: `User provided a password (redacted, ${answer.length} chars)`,
        extractedContent: `[REDACTED password response — ${answer.length} chars]`,
      };
    }
    return {
      action,
      success: true,
      message: `User answered: ${answer.slice(0, LIMITS.askHumanAnswerChars)}`,
      extractedContent: `User's answer to "${action.question}": ${answer}`,
    };
  } catch (e) {
    return {
      action,
      success: false,
      message: `ask_human failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
