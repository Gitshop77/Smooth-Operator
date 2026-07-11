/**
 * Loop helper — judge + deterministic evaluators.
 *
 * - `runDeterministicEvaluators` runs the deterministic evaluators
 *   (string / URL / HTML-content) against the agent's final result + current
 *   page state.
 * - `maybeJudgeAndFinalize` optionally runs the judge LLM to verify the
 *   agent's self-reported success, then emits the terminal `done` event.
 */

import type { HistoryItem } from "../../types";
import { judgeTask } from "../../judge";
import { EvaluatorComb, type EvaluatorKind } from "../../evaluators";
import { estimateCost } from "../../llm/pricing";
import {
  CallbackDispatcher,
  type CallbackContext,
} from "../../callbacks";
import type { LoopDeps, LoopState } from "../types";

/**
 * Run the deterministic evaluators (string / URL / HTML-content) against
 * the agent's final result + current page state.
 */
export async function runDeterministicEvaluators(
  deps: LoopDeps,
  config: import("../../types").AgentConfig,
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
  config: import("../../types").AgentConfig,
  args: {
    step: number;
    success: boolean;
    text: string;
    navigatorHistory: HistoryItem[];
    onCost: (usd: number, tokensIn?: number, tokensOut?: number) => void;
  },
  state: LoopState,
  dispatcher?: CallbackDispatcher,
  ctx?: CallbackContext
): Promise<boolean> {
  const { step, success, text, navigatorHistory, onCost } = args;

  if (!success) {
    deps.onEvent({ type: "done", step, success: false, text });
    state.finalResult = { success: false, text };
    return true;
  }

  if (success && config.expectedOutcomes) {
    try {
      const evaluatorResult = await runDeterministicEvaluators(deps, config, text, state);
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
          message: `Deterministic evaluators scored ${evaluatorResult.score} (${evaluatorResult.reasons.join("; ")}) — falling back to LLM judge.`,
        });
      }
    } catch (e) {
      deps.onEvent({
        type: "error", step,
        message: `Evaluator fast-path failed: ${e instanceof Error ? e.message : String(e)}`,
        recoverable: true,
      });
    }
  }

  if (config.enableJudge === false) {
    deps.onEvent({ type: "done", step, success: true, text });
    state.finalResult = { success: true, text };
    return true;
  }

  try {
    // Capture the model name + reasoning-token count + cached-token count from
    // the LLM call so the judge's cost estimate accounts for reasoning models
    // (o1/o3 bill reasoning tokens at their own rate) AND prompt-cache discounts
    // (Anthropic cache_read billed at 0.1× input). Without these, `estimateCost`
    // undercounts the judge's true cost and delays cost-cap enforcement.
    let judgeModel = "";
    let judgeReasoningTokens = 0;
    let judgeCachedInputTokens = 0;
    let judgeCachedWriteInputTokens = 0;
    const judgeLlmCall = async (systemPrompt: string, userMessage: string): Promise<string> => {
      if (deps.summarizeCall) {
        const res = await deps.summarizeCall({ systemPrompt, userPrompt: userMessage });
        if (res.usage?.model) judgeModel = res.usage.model;
        if (res.usage?.reasoningTokens) judgeReasoningTokens = res.usage.reasoningTokens;
        // Capture cachedInputTokens so the judge's cost recompute applies the
        // cacheRead discount.
        if (res.usage?.cachedInputTokens) judgeCachedInputTokens = res.usage.cachedInputTokens;
        // Capture cache-write (creation) tokens too (billed at the higher
        // cache-write rate). Cast until TokenUsage (types.ts) propagates it.
        if ((res.usage as { cachedWriteInputTokens?: number }).cachedWriteInputTokens)
          judgeCachedWriteInputTokens = (res.usage as { cachedWriteInputTokens?: number }).cachedWriteInputTokens!;
        return res.content;
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
      });
      if (res.model) judgeModel = res.model;
      if (res.reasoningTokens) judgeReasoningTokens = res.reasoningTokens;
      // Capture cachedInputTokens from the planner-fallback path too.
      if (res.cachedInputTokens) judgeCachedInputTokens = res.cachedInputTokens;
      // Capture cache-write (creation) tokens from the planner-fallback path
      // too (billed at the higher cache-write rate). Cast until the
      // PlannerLLMCall result type (loop/types.ts) propagates it.
      if ((res as { cachedWriteInputTokens?: number }).cachedWriteInputTokens)
        judgeCachedWriteInputTokens = (res as { cachedWriteInputTokens?: number }).cachedWriteInputTokens!;
      return res.raw;
    };

    const verdict = await judgeTask({
      task: deps.task,
      history: navigatorHistory,
      agentResult: { success, text },
      llmCall: judgeLlmCall,
      // `onCost` is async so cost tracking + dispatcher fire after the judge
      // LLM call completes. The dispatcher's cost() method internally
      // try/catches handler errors, so no throw propagates — cost-cap
      // enforcement is via the orchestrator's `costCapExceeded(state)` check.
      onCost: async (usage) => {
        // The judge's internal cost estimate uses modelForCost (which is ""
        // because the model name is only known AFTER llmCall returns, and
        // judgeLlmCall sets judgeModel as a side effect). Recompute the cost
        // here with the real model name so the budget tracker gets an
        // accurate number.
        const realCost = judgeModel
          // Pass judgeReasoningTokens + judgeCachedInputTokens +
          // judgeCachedWriteInputTokens (captured as side effects of
          // judgeLlmCall) so the recompute applies the reasoning rate, the
          // cacheRead discount, AND the (higher) cacheWrite rate.
          ? estimateCost(judgeModel, usage.tokensIn, usage.tokensOut, judgeReasoningTokens, judgeCachedInputTokens, judgeCachedWriteInputTokens)
          : usage.costUsd;
        deps.onEvent({
          type: "cost", step,
          tokensIn: usage.tokensIn, tokensOut: usage.tokensOut,
          costUsd: realCost, model: judgeModel || usage.model,
        });
        onCost(realCost, usage.tokensIn, usage.tokensOut);
        if (dispatcher && ctx) {
          // Include reasoningTokens + cachedInputTokens for
          // AgentMetricsCallback per-phase breakdown.
          await dispatcher.cost(ctx, {
            tokensIn: usage.tokensIn,
            tokensOut: usage.tokensOut,
            model: judgeModel || usage.model,
            costUsd: realCost,
            reasoningTokens: judgeReasoningTokens > 0 ? judgeReasoningTokens : undefined,
            cachedInputTokens: judgeCachedInputTokens > 0 ? judgeCachedInputTokens : undefined,
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
