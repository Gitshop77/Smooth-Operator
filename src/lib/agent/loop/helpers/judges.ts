/**
 * Loop helper — judge + deterministic evaluators.
 *
 * - `runDeterministicEvaluators` runs the deterministic evaluators
 * (string / URL / HTML-content) against the agent's final result + current
 * page state.
 * - `maybeJudgeAndFinalize` optionally runs the judge LLM to verify the
 * agent's self-reported success, then emits the terminal `done` event.
 */

import type { AgentConfig, HistoryItem } from "../../types";
import { judgeTask } from "../../judge";
import { redactHistoryForPrompt } from "../messages";
import type {
  CallbackDispatcher,
  CallbackContext,
} from "../../callbacks";
import type { LoopDeps, LoopState } from "../types";
import { runDeterministicEvaluators } from "./evaluator-runner";
import { isBudgetExceededError } from "../../errors";
import { reportCostEvent } from "./llm-calls-utils";

/** Bound on consecutive judge rejections (verdict false OR null verdict)
 * before the run FORCES a planner re-plan instead of a plain re-observe —
 * a stubborn judge+planner cycle must not burn the whole step budget on one
 * unverified claim. */
export const JUDGE_CONSECUTIVE_REJECT_LIMIT = 3;

/** Record one judge rejection on the run state; when the bound is exceeded,
 * flag the run to force a planner re-plan. */
function recordJudgeDisagreement(state: LoopState): void {
  state.consecutiveJudgeRejections += 1;
  if (state.consecutiveJudgeRejections >= JUDGE_CONSECUTIVE_REJECT_LIMIT) {
    state.judgeReplanForced = true;
    state.consecutiveJudgeRejections = 0;
    state.deps.onEvent({
      type: "info",
      message: `Judge disagreed ${JUDGE_CONSECUTIVE_REJECT_LIMIT} consecutive times — forcing a planner re-plan instead of continuing to re-observe.`,
    });
  }
}

/**
 * Optionally run the judge LLM to verify the agent's self-reported success,
 * then emit the terminal `done` event. Returns `true` if the run is finalized.
 *
 * Completion-with-evidence: a `done(success=true)` finalizes ONLY
 * with positive completion evidence —
 *   1. a passing deterministic evaluator (expectedOutcomes, score 1), or
 *   2. an agreeing LLM judge.
 * An in-run completion attempt on a free-form task (no deterministic
 * evidence) has no positive evidence; with the judge disabled there is NO
 * verification path, so the bare planner claim is routed back (unverified)
 * instead of finalizing success. This removed the old
 * `!finalAttempt && !config.expectedOutcomes → finalize(true)` shortcut that
 * let an in-run planner `done` skip the judge entirely.
 */
export async function maybeJudgeAndFinalize(
  deps: LoopDeps,
  config: AgentConfig,
  args: {
    step: number;
    success: boolean;
    text: string;
    navigatorHistory: HistoryItem[];
    onCost: (usd: number, tokensIn?: number, tokensOut?: number) => void;
    /**
 * Whether this is the FINAL completion attempt (the run is ending). When
 * true and no deterministic evidence is configured, the planner's direct
 * answer is trusted when the judge is disabled (the operator explicitly
 * disabled verification, and at the initial decision point there is no
 * trajectory to verify against). When false (an intermediate planner/
 * navigator "done" attempt) and no deterministic evidence exists, the claim
 * is UNVERIFIED: it is routed back unless the LLM judge runs and agrees.
 */
    finalAttempt?: boolean;
  },
  state: LoopState,
  dispatcher?: CallbackDispatcher,
  ctx?: CallbackContext
): Promise<boolean> {
  const { step, success, text, navigatorHistory, onCost } = args;
  const finalAttempt = args.finalAttempt ?? true;

  const finalize = (ok: boolean, doneText: string): true => {
    // A judge may resolve after the root signal was aborted. Never let that
    // delayed verdict publish a successful terminal result.
    if (state.signal?.aborted) {
      const cancelledText = "Agent stopped by user.";
      deps.onEvent({ type: "done", step, success: false, text: cancelledText });
      state.finalResult = { success: false, text: cancelledText };
      return true;
    }
    // A terminal decision (agreement or a legit failure finalize) ends the
    // current disagreement streak — the next completion claim starts fresh.
    state.consecutiveJudgeRejections = 0;
    state.judgeReplanForced = false;
    deps.onEvent({ type: "done", step, success: ok, text: doneText });
    state.finalResult = { success: ok, text: doneText };
    return true;
  };

  if (!success) {
    return finalize(false, text);
  }

  // Completion-with-evidence: does the config provide a DETERMINISTIC
  // evidence source? (expectedOutcomes with at least one evaluator kind — an
  // empty spec is not evidence.)
  const hasDeterministicEvidence =
    (config.expectedOutcomes?.string?.length ?? 0) > 0 ||
    (config.expectedOutcomes?.url != null) ||
    (config.expectedOutcomes?.html?.length ?? 0) > 0;

  // An in-run `done(success=true)` on a free-form task has NO positive
  // completion evidence and, with the judge disabled, NO verification path
  // exists. The bare planner claim must not finalize success — route the
  // claim back (the run continues; the planner must produce evidence or the
  // run ends as an unverified failure). Keeps fail-closed semantics: a
  // missing evidence path never fails OPEN.
  if (!hasDeterministicEvidence && !finalAttempt && config.enableJudge === false) {
    deps.onEvent({
      type: "info",
      message: "Planner reported done(success=true) without deterministic evidence and the judge is disabled — continuing the run (unverified).",
    });
    return false;
  }

  let evaluatorResult: Awaited<ReturnType<typeof runDeterministicEvaluators>> = null;
  let evaluatorErrored = false;
  if (hasDeterministicEvidence) {
    try {
      evaluatorResult = await runDeterministicEvaluators(deps, config, text, state);
      if (evaluatorResult !== null && evaluatorResult.score === 1) {
        deps.onEvent({
          type: "info",
          message: `Deterministic evaluators passed (score 1.0) — skipping LLM judge.`,
        });
        return finalize(true, text);
      }
      if (evaluatorResult !== null) {
        deps.onEvent({
          type: "info",
          message: `Deterministic evaluators scored ${evaluatorResult.score.toFixed(2)} (${evaluatorResult.reasons.join("; ")}) — falling back to LLM judge.`,
        });
      }
    } catch (e) {
      evaluatorErrored = true;
      deps.onEvent({
        type: "error", step,
        message: `Evaluator fast-path failed: ${e instanceof Error ? e.message : String(e)}`,
        recoverable: true,
      });
    }
  }

  if (config.enableJudge === false) {
    // The LLM judge is disabled, so the deterministic evaluators are the only
    // gate. If they ran and scored < 1, they are authoritative — finalize as
    // FAILURE rather than discarding the failing score and declaring success.
    if (evaluatorResult !== null && evaluatorResult.score < 1) {
      return finalize(false, text);
    }
    // If the evaluators could not run (threw) we cannot verify the task. Do
    // NOT fail open to success — an unverified gate is not a passing one.
    if (evaluatorErrored) {
      return finalize(false, text);
    }
    if (hasDeterministicEvidence) {
      // Deterministic evidence configured but no evaluator verdict was
      // produced — an unproduced verdict is not evidence. Route back.
      deps.onEvent({
        type: "info",
        message: "Deterministic evaluators produced no verdict — continuing the run (unverified).",
      });
      return false;
    }
    // finalAttempt === true (initial planner decision) with the judge
    // disabled and no deterministic evidence: the operator explicitly
    // disabled verification and there is no trajectory to verify against at
    // the initial decision point — trust the planner's direct answer
    // (documented operator choice; the in-run case was routed back above).
    return finalize(true, text);
  }

  try {
  // Redact secret values from the history BEFORE it crosses the network to
  // the judge. The judge prompt renders `message` / `extractedContent` /
  // reasoning fields verbatim (wrapUntrusted only neutralizes injection
  // patterns, not credentials) — mirrors compaction-runner's redaction of
  // the to-summarize slice so the two outbound history sinks cannot drift.
    const redactedHistory = await redactHistoryForPrompt(navigatorHistory);
    const judgeLlmCall = async (systemPrompt: string, userMessage: string) => {
      if (deps.summarizeCall) {
        const res = await deps.summarizeCall({ systemPrompt, userPrompt: userMessage, signal: state.signal });
        return { content: res.content, usage: res.usage };
      }
      const res = await deps.plannerCall({
        task: `${systemPrompt}\n\n${userMessage}`,
        history: redactedHistory,
        plan: undefined,
        currentPlanItem: undefined,
        url: "",
        tabs: [],
        step,
        maxSteps: 0,
      }, state.signal);
      return {
        content: res.raw,
        usage: {
          model: res.model,
          tokensIn: res.tokensIn,
          tokensOut: res.tokensOut,
          reasoningTokens: res.reasoningTokens,
          cachedInputTokens: res.cachedInputTokens,
          cachedWriteInputTokens: res.cachedWriteInputTokens,
        },
      };
    };

    deps.onEvent({
      type: "info",
      message: "Running the LLM judge to verify the completion claim.",
    });
    const verdict = await judgeTask({
      task: deps.task,
      history: redactedHistory,
      agentResult: { success, text },
      llmCall: judgeLlmCall,
      modelForCost: undefined,
      onCost: async (usage) => {
        // Shared cost-event shape: includes reasoning/cache tokens that the
        // old inline event dropped (under-reporting cache-write spend).
        reportCostEvent(deps.onEvent, step, usage);
        onCost(usage.costUsd, usage.tokensIn, usage.tokensOut);
        if (dispatcher && ctx) await dispatcher.cost(ctx, usage);
      },
    });

    if (verdict === null) {
 // The judge could not be reached (LLM error / unparseable response).
 // This is UNVERIFIED — NEVER treat a missing verdict as agreement.
 // Route the run back to the planner for re-evaluation (same as an
 // explicit disagreement) rather than failing open with success:true.
      recordJudgeDisagreement(state);
      deps.onEvent({
        type: "info",
        message: `Judge could not be reached (no verdict) — task left unverified, continuing the run.`,
      });
      return false;
    }

    if (verdict.verdict) {
 // A passing LLM judge must not override a failing deterministic evaluator.
 // The expectedOutcomes gate is the ground-truth acceptance check; if it ran
 // and scored < 1, its verdict is authoritative — finalize as FAILURE rather
 // than letting the (page-content-influenced) judge self-certify completion.
      if (evaluatorResult !== null && evaluatorResult.score < 1) {
        return finalize(false, text);
      }
      return finalize(true, text);
    }

    const reason = verdict.failureReason || "task may not be complete";
    recordJudgeDisagreement(state);
    deps.onEvent({
      type: "info",
      message: `Judge disagrees with success: ${reason}. Continuing the run.`,
    });
    deps.onEvent({
      type: "error", step,
      message: `Judge verdict: not complete. ${reason}`,
      recoverable: true,
    });
    return false;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
 // If the cost callback throws "Budget exceeded" (from a custom budget
 // handler) or the judge's compiled prompt exceeds its V1 budget profile
 // (typed `PromptBudgetExceededError`), finalize as FAILURE. In the default
 // extension config, the dispatcher's cost() catches all handler errors, so
 // this path only fires if a caller installs a throwing cost handler or the
 // prompt genuinely exceeds the conservative budget. Cost-cap enforcement in
 // the default config is via `costCapExceeded(state)`.
    if (isBudgetExceededError(e)) {
      return finalize(false, msg);
    }
    deps.onEvent({
      type: "error", step,
      message: `Judge failed (treating as unverified): ${msg}`,
      recoverable: true,
    });
 // A judge exception other than a budget cap MUST NOT fail open. Route the
 // run back to the planner for re-evaluation (same as a null verdict / an
 // explicit disagreement) rather than declaring success:true.
    return false;
  }
}
