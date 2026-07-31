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
import { EvaluatorComb, type EvaluatorKind } from "../../evaluators";
import {
  CallbackDispatcher,
  type CallbackContext,
} from "../../callbacks";
import type { LoopDeps, LoopState } from "../types";

/**
 * Run the deterministic evaluators (string / URL / HTML-content) against
 * the agent's final result + current page state.
 */
async function runDeterministicEvaluators(
  deps: LoopDeps,
  config: AgentConfig,
  agentText: string,
  state: LoopState,
): Promise<{ score: number; results: { tag: string; score: number; reason: string }[]; reasons: string[] } | null> {
  const eo = config.expectedOutcomes;
  if (!eo) return null;
  const kinds: EvaluatorKind[] = [];
  if (eo.string && eo.string.length > 0) kinds.push("string_match");
  if (eo.url) kinds.push("url_match");
  if (eo.html && eo.html.length > 0) kinds.push("program_html");
  if (kinds.length === 0) return null;
  const comb = new EvaluatorComb(kinds);

  const input: Parameters<EvaluatorComb["evaluate"]>[0] = {};
  if (eo.string) {
    input.string = {
      prediction: agentText,
      referenceAnswers: eo.string.map((s) => ({
        type: s.type,
        ref: s.ref,
      })),
    };
  }
  if (eo.url) {
    let url: string;
    try {
      url = deps.getCurrentUrl ? await deps.getCurrentUrl() : (state.lastObservedUrl ?? "");
    } catch {
      url = state.lastObservedUrl ?? "";
    }
    input.url = {
      prediction: url,
      referenceUrl: eo.url.referenceUrl,
      matchingRule: eo.url.matchingRule,
    };
  }
  if (eo.html) {
    let pageHtml = "";
    if (deps.getPageHtml) {
      try {
        pageHtml = await deps.getPageHtml();
      } catch {
        pageHtml = "";
      }
    }
    input.html = {
      pageHtml,
      targets: eo.html.map((t) => ({
        locator: t.locator,
        required_contents: t.required_contents,
      })),
    };
  }

  const result = await comb.evaluate(input);
  return {
    score: result.score,
    results: result.results.map((r) => ({ tag: r.tag, score: r.score, reason: r.reason })),
    reasons: result.reasons,
  };
}

/**
 * Optionally run the judge LLM to verify the agent's self-reported success,
 * then emit the terminal `done` event. Returns `true` if the run is finalized.
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
 * true, the LLM judge is always run (unless `enableJudge === false`) so the
 * terminal outcome is verified. When false (an intermediate planner/navigator
 * "done" attempt), the judge is SKIPPED for free-form tasks that have no
 * `expectedOutcomes` — those attempts are finalized directly on the planner's
 * own decision, avoiding an extra full-history LLM completion on every
 * in-run "done" attempt. The final run-end `done` always sets this true.
 */
    finalAttempt?: boolean;
  },
  state: LoopState,
  dispatcher?: CallbackDispatcher,
  ctx?: CallbackContext
): Promise<boolean> {
  const { step, success, text, navigatorHistory, onCost } = args;
  const finalAttempt = args.finalAttempt ?? true;

  if (!success) {
    deps.onEvent({ type: "done", step, success: false, text });
    state.finalResult = { success: false, text };
    return true;
  }

 // Cheap pre-check short-circuit: an intermediate "done" attempt on a
 // free-form task (no deterministic evaluators configured) has no fast-path,
 // so the judge would be pure added cost. Skip it and trust the planner's
 // decision for the in-run attempt; the FINAL attempt still runs the judge.
  if (!finalAttempt && !config.expectedOutcomes) {
    deps.onEvent({ type: "done", step, success: true, text });
    state.finalResult = { success: true, text };
    return true;
  }

  let evaluatorResult: Awaited<ReturnType<typeof runDeterministicEvaluators>> = null;
  let evaluatorErrored = false;
  if (success && config.expectedOutcomes) {
    try {
      evaluatorResult = await runDeterministicEvaluators(deps, config, text, state);
      if (evaluatorResult !== null && evaluatorResult.score === 1) {
        deps.onEvent({
          type: "info",
          message: `Deterministic evaluators passed (score 1.0) — skipping LLM judge.`,
        });
        deps.onEvent({ type: "done", step, success: true, text });
        state.finalResult = { success: true, text };
        return true;
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
      deps.onEvent({
        type: "done",
        step,
        success: false,
        text,
      });
      state.finalResult = { success: false, text };
      return true;
    }
 // If the evaluators could not run (threw) we cannot verify the task. Do NOT
 // fail open to success — an unverified gate is not a passing one.
    if (evaluatorErrored) {
      deps.onEvent({ type: "done", step, success: false, text });
      state.finalResult = { success: false, text };
      return true;
    }
    deps.onEvent({ type: "done", step, success: true, text });
    state.finalResult = { success: true, text };
    return true;
  }

  try {
    const judgeLlmCall = async (systemPrompt: string, userMessage: string) => {
      if (deps.summarizeCall) {
        const res = await deps.summarizeCall({ systemPrompt, userPrompt: userMessage });
        return { content: res.content, usage: res.usage };
      }
      const res = await deps.plannerCall({
        task: `${systemPrompt}\n\n${userMessage}`,
        history: navigatorHistory,
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

    const verdict = await judgeTask({
      task: deps.task,
      history: navigatorHistory,
      agentResult: { success, text },
      llmCall: judgeLlmCall,
      modelForCost: undefined,
      onCost: async (usage) => {
        deps.onEvent({
          type: "cost", step,
          tokensIn: usage.tokensIn, tokensOut: usage.tokensOut,
          costUsd: usage.costUsd, model: usage.model,
        });
        onCost(usage.costUsd, usage.tokensIn, usage.tokensOut);
        if (dispatcher && ctx) {
          await dispatcher.cost(ctx, {
            tokensIn: usage.tokensIn,
            tokensOut: usage.tokensOut,
            model: usage.model,
            costUsd: usage.costUsd,
            reasoningTokens: usage.reasoningTokens,
            cachedInputTokens: usage.cachedInputTokens,
            cachedWriteInputTokens: usage.cachedWriteInputTokens,
          });
        }
      },
    });

    if (verdict === null) {
 // The judge could not be reached (LLM error / unparseable response).
 // This is UNVERIFIED — NEVER treat a missing verdict as agreement.
 // Route the run back to the planner for re-evaluation (same as an
 // explicit disagreement) rather than failing open with success:true.
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
        deps.onEvent({
          type: "done",
          step,
          success: false,
          text,
        });
        state.finalResult = { success: false, text };
        return true;
      }
      deps.onEvent({ type: "done", step, success: true, text });
      state.finalResult = { success: true, text };
      return true;
    }

    const reason = verdict.failureReason || "task may not be complete";
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
 // handler), finalize as FAILURE. In the default extension config, the
 // dispatcher's cost() catches all handler errors, so this path only
 // fires if a caller installs a throwing cost handler. Cost-cap
 // enforcement in the default config is via `costCapExceeded(state)`.
    if (/^Budget exceeded:/i.test(msg)) {
      deps.onEvent({ type: "done", step, success: false, text: msg });
      state.finalResult = { success: false, text: msg };
      return true;
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
