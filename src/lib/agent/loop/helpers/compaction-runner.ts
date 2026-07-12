/**
 * Loop helper — `runCompaction`.
 *
 * Run one compaction pass on the navigator history. Returns the new
 * (post-compaction) history items and the compacted-memory text. On any
 * error, returns `null` so the caller can skip the compaction entirely.
 *
 * Cost tracking: after the summarize/planner LLM call returns, if token
 * counts + model are available, `onCost` is invoked with the estimated USD
 * cost + token counts (mirroring `runPlanner`/`callNavigatorWithRetry` in
 * `llm-calls.ts`). The caller wires `onCost` to `addCost(state, usd) +
 * addTokens(state, tokensIn, tokensOut) + onEvent({type:"cost",...})` so
 * the cost cap, totalTokensIn/Out, and the live UI cost counter all
 * reflect the compaction call.
 *
 * The cost is ALSO reported to `dispatcher.cost(ctx, usage)` so the
 * `AgentMetricsCallback` (and any other registered callback) attributes the
 * compaction call's tokens/cost to the correct phase (compaction is a
 * planner-model call, so its cost is lumped with the planner phase).
 */

import type { HistoryItem } from "../../types";
import {
  partitionHistory,
  sanitizeCompactedMemory,
  SUMMARIZE_PROMPT,
  renderHistoryForSummarization,
} from "../compaction";
import type { LoopDeps } from "../types";
import type { CallbackDispatcher, CallbackContext, LLMUsageInfo } from "../../callbacks";
import { estimateCost } from "../../llm/pricing";

export async function runCompaction(
  deps: LoopDeps,
  navigatorHistory: HistoryItem[],
  step: number,
  onCost?: (usd: number, tokensIn?: number, tokensOut?: number) => void,
  dispatcher?: CallbackDispatcher,
  ctx?: CallbackContext,
): Promise<{ keptRecent: HistoryItem[]; compactedMemory: string; compactedCount: number } | null> {
  const { toSummarize, toKeep } = partitionHistory(navigatorHistory);
  if (toSummarize.length === 0) return null;
 // Inline the request build to avoid calling partitionHistory a second time
 // (buildCompactionRequest calls it internally).
 // Use the static import (line 31-36) instead of a dynamic import — same
 // module, no circular dependency, avoids a microtask for no benefit.
  const request = `${SUMMARIZE_PROMPT}\n\n${renderHistoryForSummarization(toSummarize)}`;
  try {
    let summary: string;
    if (deps.summarizeCall) {
      const res = await deps.summarizeCall({
        systemPrompt: "You are summarizing agent history.",
        userPrompt: request,
      });
      summary = res.content;
 // Surface the summarize-call cost + tokens to the caller (cost-cap +
 // token totals + live UI cost counter). Mirrors the pattern in
 // `runPlanner` / `callNavigatorWithRetry`.
      if (onCost && res.usage) {
        const { tokensIn, tokensOut, model, reasoningTokens, cachedInputTokens, costUsd: precomputedCost } = res.usage;
 // Read cache-write (creation) tokens when threaded through (billed at
 // the higher cache-write rate; omitted, it under-reports Anthropic
 // cache-creation cost). Cast until TokenUsage (types.ts) propagates it.
        const cachedWriteInputTokens = (res.usage as { cachedWriteInputTokens?: number }).cachedWriteInputTokens ?? 0;
        if (tokensIn !== undefined && tokensOut !== undefined && model) {
 // Prefer pre-computed costUsd; fall back to estimateCost with
 // cachedInputTokens AND cachedWriteInputTokens passed through.
          const cost = precomputedCost ?? estimateCost(model, tokensIn, tokensOut, reasoningTokens, cachedInputTokens, cachedWriteInputTokens);
          onCost(cost, tokensIn, tokensOut);
          deps.onEvent({ type: "cost", step, tokensIn, tokensOut, costUsd: cost, model });
 // Also report to the dispatcher so AgentMetricsCallback attributes
 // the compaction call's tokens/cost to the planner phase. The
 // dispatcher's cost() method internally try/catches handler errors,
 // so no throw propagates — cost-cap enforcement is handled by the
 // orchestrator's `costCapExceeded(state)` check, not by callback
 // throws.
          if (dispatcher && ctx) {
 // Include reasoningTokens + cachedInputTokens so
 // AgentMetricsCallback's per-phase breakdown is accurate.
            const usage: LLMUsageInfo = { tokensIn, tokensOut, model, costUsd: cost, reasoningTokens, cachedInputTokens };
            await dispatcher.cost(ctx, usage);
          }
        }
      }
    } else {
      const res = await deps.plannerCall({
        task: "Summarize the agent history below into a compacted memory block.",
        history: toSummarize,
        plan: undefined,
        currentPlanItem: undefined,
        url: "",
        tabs: [],
        step,
        maxSteps: 0,
      });
 // The planner returns JSON — extract the text field for a clean summary.
      try {
        const parsed = JSON.parse(res.raw);
        summary = typeof parsed.text === "string" ? parsed.text : res.raw;
      } catch {
        summary = res.raw;
      }
 // Surface the planner-fallback cost + tokens to the caller.
      if (onCost && res.tokensIn !== undefined && res.tokensOut !== undefined && res.model) {
 // Read cache-write (creation) tokens when threaded through (billed at
 // the higher cache-write rate). Cast until the PlannerLLMCall result
 // type (loop/types.ts) and loop-deps wiring propagate it.
        const cachedWriteInputTokens = (res as { cachedWriteInputTokens?: number }).cachedWriteInputTokens ?? 0;
 // Prefer pre-computed costUsd; fall back to estimateCost with
 // cachedInputTokens AND cachedWriteInputTokens passed through.
        const cost = res.costUsd ?? estimateCost(res.model, res.tokensIn, res.tokensOut, res.reasoningTokens, res.cachedInputTokens, cachedWriteInputTokens);
        onCost(cost, res.tokensIn, res.tokensOut);
        deps.onEvent({ type: "cost", step, tokensIn: res.tokensIn, tokensOut: res.tokensOut, costUsd: cost, model: res.model });
 // same dispatcher reporting as the summarize path above.
 // NO try/catch — same rationale as the summarize path
 // above (let budget-exceeded propagate to the outer catch).
        if (dispatcher && ctx) {
 // Include reasoningTokens + cachedInputTokens so
 // AgentMetricsCallback's per-phase breakdown is accurate.
          const usage: LLMUsageInfo = {
            tokensIn: res.tokensIn,
            tokensOut: res.tokensOut,
            model: res.model,
            costUsd: cost,
            reasoningTokens: res.reasoningTokens,
            cachedInputTokens: res.cachedInputTokens,
          };
          await dispatcher.cost(ctx, usage);
        }
      }
    }
    const safeMemory = sanitizeCompactedMemory(summary);
    return {
      keptRecent: toKeep,
      compactedMemory: safeMemory,
      compactedCount: toSummarize.length,
    };
  } catch (e) {
 // re-throw budget-exceeded errors so the orchestrator can
 // finalize the run as FAILURE. Other
 // errors (LLM failures, parse errors, etc.) are still absorbed —
 // compaction is best-effort and the run can continue without it.
    const msg = e instanceof Error ? e.message : String(e);
 // Match on the canonical "Budget exceeded:" prefix AND on an explicit
 // `budgetExceeded` flag (if a future thrower emits a typed error), so the
 // classification isn't reliant solely on a brittle message substring.
    const isBudgetExceeded =
      /^Budget exceeded:/i.test(msg) ||
      (e != null && (e as { budgetExceeded?: boolean }).budgetExceeded === true);
    if (isBudgetExceeded) throw e;
    return null;
  }
}
