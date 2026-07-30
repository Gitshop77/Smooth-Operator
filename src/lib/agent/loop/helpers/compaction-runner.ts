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
import { redactHistoryForPrompt } from "../messages";
import type { LoopDeps } from "../types";
import type { CallbackDispatcher, CallbackContext, LLMUsageInfo } from "../../callbacks";
import { estimateCost } from "../../llm/pricing";
import { SECURITY_INSTRUCTION, wrapUntrusted } from "../../security";

/**
 * Report a compaction call's cost + tokens to the caller (`onCost`), emit a
 * `cost` event, and — when a dispatcher is wired — attribute the usage to the
 * planner phase. Shared by the summarize and planner-fallback branches so the
 * three-step reporting sequence can't drift between them.
 */
async function reportCompactionUsage(
  step: number,
  usage: LLMUsageInfo,
  onCost: ((usd: number, tokensIn?: number, tokensOut?: number) => void) | undefined,
  deps: LoopDeps,
  dispatcher: CallbackDispatcher | undefined,
  ctx: CallbackContext | undefined,
): Promise<void> {
  if (!onCost) return;
  onCost(usage.costUsd, usage.tokensIn, usage.tokensOut);
  deps.onEvent({
    type: "cost",
    step,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    costUsd: usage.costUsd,
    model: usage.model,
  });
  if (dispatcher && ctx) await dispatcher.cost(ctx, usage);
}

/**
 * Normalize a raw usage shape (from the summarize or planner call), compute the
 * cost (preferring any pre-computed `costUsd`), and report it via
 * {@link reportCompactionUsage}. Shared by both compaction branches so the
 * token/cost attribution can't drift. No-op when cost reporting is disabled or
 * the usage is missing the required `tokensIn`/`tokensOut`/`model`.
 */
async function reportUsage(
  step: number,
  rawUsage:
    | {
        tokensIn?: number;
        tokensOut?: number;
        model?: string;
        reasoningTokens?: number;
        cachedInputTokens?: number;
        cachedWriteInputTokens?: number;
        costUsd?: number;
      }
    | undefined,
  onCost: ((usd: number, tokensIn?: number, tokensOut?: number) => void) | undefined,
  deps: LoopDeps,
  dispatcher: CallbackDispatcher | undefined,
  ctx: CallbackContext | undefined,
): Promise<void> {
  if (!onCost || !rawUsage) return;
  const {
    tokensIn,
    tokensOut,
    model,
    reasoningTokens,
    cachedInputTokens,
    cachedWriteInputTokens,
    costUsd,
  } = rawUsage;
  // Cache-write (creation) tokens are billed at the higher cache-write rate;
  // default to 0 until the TokenUsage type propagates the field.
  const cw = cachedWriteInputTokens ?? 0;
  if (tokensIn === undefined || tokensOut === undefined || !model) return;
 // Production compaction calls go through a provider bridge that supplies a
 // provider-scoped costUsd when available. When only a bare model id is given,
 // thread a provider-prefixed id (e.g. "google/gemini-2.5-pro") so pricing
 // disambiguates the same bare id across providers. Bare ids (no "/") have no
 // provider context at the compaction layer (AgentConfig doesn't hold
 // providerId), so we leave it undefined and rely on the first-writer-wins
 // bare-id resolution in pricing.ts.
  const compactionProviderId = model.includes("/") ? model.split("/")[0] : undefined;
  const computedCost =
    costUsd ?? estimateCost({ model, tokensIn, tokensOut, reasoningTokens, cachedInputTokens, cachedWriteInputTokens: cw, providerId: compactionProviderId });
  const usage: LLMUsageInfo = {
    tokensIn,
    tokensOut,
    model,
    costUsd: computedCost,
    reasoningTokens,
    cachedInputTokens,
    cachedWriteInputTokens: cw,
  };
  await reportCompactionUsage(step, usage, onCost, deps, dispatcher, ctx);
}

export async function runCompaction(
  deps: LoopDeps,
  navigatorHistory: HistoryItem[],
  step: number,
  onCost?: (usd: number, tokensIn?: number, tokensOut?: number) => void,
  dispatcher?: CallbackDispatcher,
  ctx?: CallbackContext,
  priorCompactedMemory?: string,
  signal?: AbortSignal,
): Promise<{ keptRecent: HistoryItem[]; compactedMemory: string; compactedCount: number } | null> {
  const { toSummarize, toKeep } = partitionHistory(navigatorHistory);
  if (toSummarize.length === 0) return null;
 // Value-based (stored-vault) secret redaction parity with the navigator/planner
 // prompt paths: apply redactHistoryForPrompt (redactSecrets + redactKeyShapes)
 // before this history crosses the network to the summarizer. A substituted
 // vault value that round-tripped into extractedContent/message/memory has no
 // matching key SHAPE, so renderHistoryForSummarization's redactKeyShapes alone
 // would let it pass through — this closes that outbound gap.
  const redactedToSummarize = await redactHistoryForPrompt(toSummarize);
 // Chain successive compactions: prepend the prior compacted summary so the
 // second+ pass carries forward earlier context instead of overwriting it. The
 // prior summary was already sanitized when produced; the final output is
 // re-sanitized via sanitizeCompactedMemory below.
  const priorBlock = priorCompactedMemory
    ? `Prior summary:\n${wrapUntrusted(priorCompactedMemory)}\n\n`
    : "";
 // Inline the request build to avoid calling partitionHistory a second time
 // (buildCompactionRequest calls it internally).
  const request = `${SUMMARIZE_PROMPT}\n\n${priorBlock}${renderHistoryForSummarization(redactedToSummarize)}`;
  try {
    let summary: string;
    if (deps.summarizeCall) {
      const res = await deps.summarizeCall({
        systemPrompt: `${SECURITY_INSTRUCTION}\n\nYou are summarizing agent history.`,
        userPrompt: request,
      });
      summary = res.content;
 // Surface the summarize-call cost + tokens to the caller (cost-cap +
 // token totals + live UI cost counter). Mirrors the pattern in
 // `runPlanner` / `callNavigatorWithRetry`.
      if (onCost && res.usage) {
        await reportUsage(step, res.usage, onCost, deps, dispatcher, ctx);
      }
    } else {
      const res = await deps.plannerCall({
        task: `${SECURITY_INSTRUCTION}\n\nSummarize the agent history below into a compacted memory block.${priorCompactedMemory ? `\n\nPrior summary to carry forward:\n${wrapUntrusted(priorCompactedMemory)}` : ""}`,
        history: redactedToSummarize,
        plan: undefined,
        currentPlanItem: undefined,
        url: "",
        tabs: [],
        step,
        maxSteps: 0,
      }, signal);

 // The planner returns JSON — extract the text field for a clean summary.
      try {
        const parsed = JSON.parse(res.raw);
        summary = typeof parsed.text === "string" ? parsed.text : res.raw;
      } catch {
        summary = res.raw;
      }
 // Surface the planner-fallback cost + tokens to the caller.
      if (onCost && res.tokensIn !== undefined && res.tokensOut !== undefined && res.model) {
        await reportUsage(step, res, onCost, deps, dispatcher, ctx);
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
