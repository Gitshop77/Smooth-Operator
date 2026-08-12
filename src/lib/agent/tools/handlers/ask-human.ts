/**
 * `ask_human` action handler — call `askHuman()` and wait for the user's
 * response. Password-mode responses are redacted so the real value never
 * reaches the LLM via `extractedContent` or `message`.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { LIMITS } from "../constants";
import type { ActionContext } from "./types";

/**
 * Hard cap on `ask_human` questions per run.
 *
 * A page (via prompt injection) can coax the model into repeatedly asking the
 * user for input — every ask opens a side-panel modal and blocks the loop for
 * up to the interaction timeout. The cap bounds interruption spam to a
 * fixed budget per run; the handler fails CLOSED (no modal, explicit
 * message) once the budget is spent, and a NEW run receives a fresh budget
 * (keyed on the authoritative runId).
 */
export const MAX_ASK_HUMAN_PER_RUN = 8;

/** Per-run ask counts keyed by runId (fallback key for tokenless contexts). */
const ANONYMOUS_ASK_KEY = "__ask_human_anonymous__";
const askCountByRun = new Map<string, number>();

/** Defensive bound so a long-lived content-script instance cannot grow the
 *  map without limit across many runs (each navigation re-injects and resets). */
const MAX_TRACKED_RUNS = 128;

/**
 * Atomically consume one ask from the run's budget. Returns whether the ask
 * is allowed and the remaining budget AFTER this ask.
 */
export function consumeAskHumanBudget(runId: string | undefined): { allowed: boolean; remaining: number } {
  const key = runId ?? ANONYMOUS_ASK_KEY;
  const used = askCountByRun.get(key) ?? 0;
  if (used >= MAX_ASK_HUMAN_PER_RUN) {
    return { allowed: false, remaining: 0 };
  }
  const next = used + 1;
  askCountByRun.set(key, next);
  if (askCountByRun.size > MAX_TRACKED_RUNS) {
    // Overflow guard: drop tracking for every run except the current one.
    for (const k of askCountByRun.keys()) {
      if (k !== key) askCountByRun.delete(k);
    }
  }
  return { allowed: true, remaining: Math.max(0, MAX_ASK_HUMAN_PER_RUN - next) };
}

/** Test-only reset of the per-run ask budget. */
export function resetAskHumanBudgetForTests(): void {
  askCountByRun.clear();
}

export async function handleAskHuman(
  ctx: ActionContext,
  action: Extract<Action, { type: "ask_human" }>,
): Promise<ActionResult> {
  const budget = consumeAskHumanBudget(ctx.dispatchToken?.runId);
  if (!budget.allowed) {
    return {
      action,
      success: false,
      message:
        `ask_human budget exhausted (max ${MAX_ASK_HUMAN_PER_RUN} questions per run) — ` +
        "the run cannot ask the user more questions",
    };
  }
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
    }, ctx.signal, ctx.dispatchToken);
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
      // Password mode: return a generic redacted message with no character count
      // to prevent the length from leaking into LLM context or run-history.
      return {
        action,
        success: true,
        message: `User provided a password (redacted)`,
        extractedContent: `[REDACTED password response]`,
      };
    }
    const answerPreview = answer.slice(0, LIMITS.askHumanAnswerChars);
    return {
      action,
      success: true,
      message: `User answered: ${answerPreview}`,
      extractedContent: `User's answer to "${questionPreview}": ${answerPreview}`,
    };
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    return {
      action,
      success: false,
      message: `ask_human failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
