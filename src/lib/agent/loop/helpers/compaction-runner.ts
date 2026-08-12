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
  COMPACTION_PREAMBLE,
  renderHistoryForSummarization,
} from "../compaction";
import { redactHistoryForPrompt } from "../messages";
import type { LoopDeps } from "../types";
import type { CallbackDispatcher, CallbackContext } from "../../callbacks";
import { estimateCost } from "../../llm/pricing";
import { SECURITY_INSTRUCTION, wrapUntrusted } from "../../security";
import { boundPromptTextV1 } from "../../prompts/bounded-prompt-text";
import {
  PROMPT_BUDGET_PROFILES_V1,
  assertCompiledPromptWithinProfileV1,
  utf8ByteLength,
} from "../../prompts/prompt-token-budget";

/**
 * Normalize a raw usage shape (from the summarize or planner call), compute the
 * cost (preferring any pre-computed `costUsd`), and report it to the caller
 * (`onCost`), emit a `cost` event, and — when a dispatcher is wired — attribute
 * the usage to the planner phase. No-op when cost reporting is disabled or the
 * usage is missing the required `tokensIn`/`tokensOut`/`model`. Shared by the
 * summarize and planner-fallback branches so the reporting sequence can't
 * drift between them.
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
  const usage = {
    tokensIn,
    tokensOut,
    model,
    costUsd: computedCost,
    reasoningTokens,
    cachedInputTokens,
    cachedWriteInputTokens: cw,
  };
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
  const rawRequest = `${SUMMARIZE_PROMPT}\n\n${priorBlock}${renderHistoryForSummarization(redactedToSummarize)}`;
  // Phase 8 budget guard: deterministically bound the summarization request so
  // the SYSTEM prompt + user request together fit the compaction profile's
  // conservative UTF-8-byte input budget before any tokens are spent. The
  // user-request bound reserves the system prompt's bytes; the prefix-bound
  // keeps the summarizer's own instructions and the OLDEST summarized steps
  // (the region this pass is meant to retire) and appends an explicit
  // byte-count marker; the most recent steps are preserved verbatim in
  // `toKeep`, so no context is silently lost.
  const compactionSystemPrompt = `${SECURITY_INSTRUCTION}\n\n${COMPACTION_PREAMBLE}`;
  const compactionMaxBytes = PROMPT_BUDGET_PROFILES_V1.compaction.maxInputTokens;
  const systemBytes = utf8ByteLength(compactionSystemPrompt);
  // Reserve one extra byte for the `\n` separator the conservative combined
  // assertion (`assertCompiledPromptWithinProfileV1`) inserts between messages.
  const userMaxBytes = Math.max(0, compactionMaxBytes - systemBytes - 1);
  const bounded = boundPromptTextV1(rawRequest, { maxBytes: userMaxBytes, label: "compaction history" });
  const request = bounded.text;
  try {
    let summary: string;
    if (deps.summarizeCall) {
      // The system prompt + user request together must fit the compaction
      // profile. The user request was already deterministically bounded to
      // `maxInputTokens - systemBytes` above; this is the fail-closed guard
      // covering the combined outbound input.
      assertCompiledPromptWithinProfileV1("compaction", "compaction", [
        { content: compactionSystemPrompt },
        { content: request },
      ]);
      const res = await deps.summarizeCall({
        systemPrompt: compactionSystemPrompt,
        userPrompt: request,
        signal,
      });
      summary = res.content;
 // Surface the summarize-call cost + tokens to the caller (cost-cap +
 // token totals + live UI cost counter). Mirrors the pattern in
 // `runPlanner` / `callNavigatorWithRetry`.
      await reportUsage(step, res.usage, onCost, deps, dispatcher, ctx);
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
      await reportUsage(step, res, onCost, deps, dispatcher, ctx);
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
