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
    const questionPreview = action.question.slice(0, LIMITS.askHumanQuestionChars);
    const isPassword = (action.mode ?? "input") === "password";
    const response = await askHuman({
      mode: isPassword ? "password" : "input",
      message: action.question,
    });
    if (response.mode === "cancelled") {
      return {
        action,
        success: false,
        message: `User dismissed the question: ${questionPreview}`,
        extractedContent: `User dismissed the question. No answer provided.`,
      };
    }
    if (response.mode === "error") {
 // A transport/messaging failure (e.g. the side panel is closed and the
 // message has no receiver) must NOT be mistaken for a successful answer.
 // Report it as a failure so the agent never proceeds on fabricated input,
 // and never records a false "secret captured" event (password mode).
      const reason = response.reason || "unknown transport error";
      return {
        action,
        success: false,
        message: `ask_human transport error: ${reason}`,
      };
    }
    const answer = "value" in response ? response.value : "(no text response)";
    if (isPassword) {
 // The password VALUE must never reach the LLM: both `message` and
 // `extractedContent` are replayed into subsequent prompts and persisted
 // to disk via run-history.ts, so the raw secret stays fully redacted.
 // We surface ONLY the character length (sanctioned by the wiring test and
 // the verify/fix contract) so the agent knows a value was captured — the
 // actual characters are never included.
 // We surface ONLY the character length — never the value itself — so the
 // agent knows a (non-empty) secret was captured without leaking the
 // credential. The raw value stays fully redacted in both LLM-bound fields.
      const length = "value" in response ? String(response.value.length) : "0";
      return {
        action,
        success: true,
        message: `User provided a password (redacted)`,
        extractedContent: `[REDACTED password response (${length} chars)]`,
      };
    }
    return {
      action,
      success: true,
      message: `User answered: ${answer.slice(0, LIMITS.askHumanAnswerChars)}`,
      extractedContent: `User's answer to "${questionPreview}": ${answer}`,
    };
  } catch (e) {
    return {
      action,
      success: false,
      message: `ask_human failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
