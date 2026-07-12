/**
 * Loop helper — planner + navigator LLM call wrappers.
 *
 * - `runPlanner` calls the planner LLM and parses its output (throws on parse
 * failure or transient LLM errors after retries).
 * - `callNavigatorWithRetry` calls the navigator LLM and retries up to
 * {@link MAX_PARSE_RETRIES} times on parse failure.
 */

import type {
  AgentOutput,
  PlannerOutput,
} from "../../types";
import type { AgentStepRequest, PlannerStepRequest } from "../../types";
import { parseAgentOutput, parsePlannerOutput } from "../../output-parser";
import { estimateCost } from "../../llm/pricing";
import { wrapUntrusted } from "../../security";
import {
  CallbackDispatcher,
  type CallbackContext,
  type LLMUsageInfo,
} from "../../callbacks";
import type { LoopDeps, PlannerCallArgs } from "../types";
import { MAX_PARSE_RETRIES } from "../constants";

/**
 * Sum a list of per-attempt {@link LLMUsageInfo} records into a single
 * record representing the aggregate cost of a (possibly retried) phase.
 *
 * Navigator retries make several LLM calls; the per-phase callback should
 * receive the *total* cost of every attempted call (failed + the final
 * successful one), not just the last attempt's usage. Retries normally use
 * the same model, so the model of the final attempt is used as the aggregate
 * model name. Optional fields are only emitted when at least one attempt
 * carried them, so a clean single-call usage is preserved when no attempt
 * reported reasoning/cache tokens.
 */
function sumUsages(usages: LLMUsageInfo[]): LLMUsageInfo | undefined {
  if (usages.length === 0) return undefined;
  const model = usages[usages.length - 1].model;
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let reasoningTokens = 0;
  let cachedInputTokens = 0;
  let hasReasoning = false;
  let hasCached = false;
  for (const u of usages) {
    tokensIn += u.tokensIn;
    tokensOut += u.tokensOut;
    costUsd += u.costUsd;
    if (u.reasoningTokens) {
      reasoningTokens += u.reasoningTokens;
      hasReasoning = true;
    }
    if (u.cachedInputTokens) {
      cachedInputTokens += u.cachedInputTokens;
      hasCached = true;
    }
  }
  return {
    tokensIn,
    tokensOut,
    model,
    costUsd,
    ...(hasReasoning ? { reasoningTokens } : {}),
    ...(hasCached ? { cachedInputTokens } : {}),
  };
}

/**
 * Call the planner LLM and parse its output. Throws on parse failure or
 * transient LLM errors (after retries). Surfaces cost via `onCost` + `onEvent`.
 */
export async function runPlanner(
  deps: LoopDeps,
  args: PlannerCallArgs,
  dispatcher?: CallbackDispatcher,
  ctx?: CallbackContext
): Promise<PlannerOutput> {
  const plannerRequest: PlannerStepRequest = {
    task: args.task,
    history: args.navigatorHistory,
    plan: args.plan,
    currentPlanItem: args.currentPlanItem,
    url: args.url,
    tabs: args.tabs,
    step: args.step,
    maxSteps: args.maxSteps,
  };
  if (dispatcher && ctx) await dispatcher.llmStart(ctx, [plannerRequest]);
 // finally block guarantees `llmEnd` fires on every path after `llmStart`
 // (parse failure, transient LLM error, success). `fired` guards against
 // double-fire on the success path.
  let fired = false;
  let usage: LLMUsageInfo | undefined;
  let raw = "";
  try {
    const result = await deps.plannerCall(plannerRequest);
    raw = result.raw;
    const { tokensIn, tokensOut, reasoningTokens, cachedInputTokens, model, costUsd: precomputedCost } = result;
 // Read cache-write (creation) tokens when the caller threads them through.
 // `cachedWriteInputTokens` is billed at the (higher) cache-write rate, so
 // omitting it under-reports Anthropic cache-creation cost. The field is
 // read via a cast until the upstream result types (loop/types.ts) and
 // the loop-deps wiring (llm-direct.ts) propagate it end-to-end.
    const cachedWriteInputTokens = (result as { cachedWriteInputTokens?: number }).cachedWriteInputTokens ?? 0;
    if (tokensIn !== undefined && tokensOut !== undefined && model) {
 // Prefer the provider-bridge's pre-computed costUsd (correctly accounts
 // for cachedInputTokens + cachedWriteInputTokens). Fall back to
 // estimateCost with cachedInputTokens AND cachedWriteInputTokens passed
 // through (dropping either under-reports Anthropic cached-step cost by up
 // to 90%, disabling cost-cap enforcement).
      const cost = precomputedCost ?? estimateCost(model, tokensIn, tokensOut, reasoningTokens, cachedInputTokens, cachedWriteInputTokens);
      args.onCost(cost, tokensIn, tokensOut);
      deps.onEvent({ type: "cost", step: args.step, tokensIn, tokensOut, costUsd: cost, model });
      usage = { tokensIn, tokensOut, model, costUsd: cost, reasoningTokens, cachedInputTokens };
    }
    const parsed = parsePlannerOutput(raw);
    if (!parsed.ok || !parsed.output) {
      throw new Error(`Planner output parse failed: ${parsed.error}`);
    }
    if (dispatcher && ctx) {
      await dispatcher.llmEnd(ctx, { content: raw, usage });
      fired = true;
      if (usage) await dispatcher.cost(ctx, usage);
    }
    return parsed.output;
  } finally {
    if (dispatcher && ctx && !fired) {
      await dispatcher.llmEnd(ctx, { content: raw, usage });
 // Report cost on the parse-failure / transient-error path too —
 // the LLM call DID consume tokens.
      if (usage) await dispatcher.cost(ctx, usage);
    }
  }
}

/**
 * Call the navigator LLM and parse its output. Retries up to
 * {@link MAX_PARSE_RETRIES} times on parse failure.
 */
export async function callNavigatorWithRetry(
  deps: LoopDeps,
  navRequest: AgentStepRequest,
  step: number,
  onCost: (usd: number, tokensIn?: number, tokensOut?: number) => void,
  dispatcher?: CallbackDispatcher,
  ctx?: CallbackContext
): Promise<AgentOutput> {
  if (dispatcher && ctx) await dispatcher.llmStart(ctx, [navRequest]);
 // finally block guarantees `llmEnd` fires on every path after `llmStart`
 // (unparseable output throw, transient error, success). `fired` guards
 // against double-fire on the success path. Cost attribution mirrors
 // `runPlanner`: it is reported once on the success path AND once in the
 // `finally` block (guarded by `costFired`) so a navigator call that
 // consumed tokens but returned unparseable output or hit a transient error
 // is still costed in the per-phase callback breakdown — not only in the
 // run-level total via `onCost`/`onEvent`.
 //
 // Unlike `runPlanner`, the navigator may retry. `attemptUsages` accumulates
 // the usage of *every* attempt so the per-phase `dispatcher.cost` callback
 // receives the SUM of all attempts (failed + successful) rather than just
 // the last one — otherwise per-phase cost analytics under-report on retry.
  let fired = false;
  let costFired = false;
  let lastRaw = "";
  let lastUsage: LLMUsageInfo | undefined;
  const attemptUsages: LLMUsageInfo[] = [];
 // The request handed to each navigator call. We never mutate the caller's
 // `navRequest`; instead we build a fresh clone carrying the accumulated
 // parse-error history so stale content can never leak back into the
 // caller's object (and the next step's prompt).
  let request: AgentStepRequest = navRequest;
  let accumulatedWarning = navRequest.loopWarning ?? "";
  try {
    let lastError: string | undefined;
    for (let retry = 0; retry <= MAX_PARSE_RETRIES; retry++) {
      const navResult = await deps.navigatorCall(request);
      const { raw, tokensIn, tokensOut, reasoningTokens, cachedInputTokens, model, costUsd: precomputedCost } = navResult;
 // Read cache-write (creation) tokens when the caller threads them through
 // (billed at the higher cache-write rate; omitted, it under-reports
 // Anthropic cache-creation cost). Cast until upstream types/loop-deps
 // wiring propagate it end-to-end.
      const cachedWriteInputTokens = (navResult as { cachedWriteInputTokens?: number }).cachedWriteInputTokens ?? 0;
      lastRaw = raw;
      let usage: LLMUsageInfo | undefined;
      if (tokensIn !== undefined && tokensOut !== undefined && model) {
 // Prefer pre-computed costUsd; fall back to estimateCost with
 // cachedInputTokens AND cachedWriteInputTokens (billed at the higher
 // cache-write rate) passed through.
        const cost = precomputedCost ?? estimateCost(model, tokensIn, tokensOut, reasoningTokens, cachedInputTokens, cachedWriteInputTokens);
 // Run-level cost accounting stays per-attempt so the run total (and
 // cost-cap enforcement) stays exact across retries.
        onCost(cost, tokensIn, tokensOut);
        deps.onEvent({ type: "cost", step, tokensIn, tokensOut, costUsd: cost, model });
        usage = { tokensIn, tokensOut, model, costUsd: cost, reasoningTokens, cachedInputTokens };
        attemptUsages.push(usage);
      }
      lastUsage = usage;
      const parsed = parseAgentOutput(raw);
      if (parsed.ok && parsed.output) {
        if (dispatcher && ctx) {
          await dispatcher.llmEnd(ctx, { content: raw, usage });
          fired = true;
 // Per-phase cost attribution: report the SUM of all attempted
 // usages (failed + this successful attempt) so the per-phase
 // callback breakdown is accurate across retries.
          const summed = sumUsages(attemptUsages);
          if (summed) {
            await dispatcher.cost(ctx, summed);
            costFired = true;
          }
        }
        return parsed.output;
      }
      lastError = parsed.error;
      if (retry < MAX_PARSE_RETRIES) {
        deps.onEvent({
          type: "error",
          step,
          message: `Parse failed (retry ${retry + 1}/${MAX_PARSE_RETRIES}): ${parsed.error}`,
          recoverable: true,
        });
        const parseErrorBlock =
          `<sys>\n<parse_error>\n` +
 // `parsed.error` is produced by the local parser and frequently
 // embeds the offending/raw model snippet, so it is untrusted model
 // output — wrap it exactly like `raw` below to keep injection
 // patterns out of the retry's prompt context.
          `Your previous response failed to parse and was rejected. Error: ${wrapUntrusted(parsed.error ?? "unknown parse error")}\n` +
 // Wrap the raw LLM output in wrapUntrusted — it may contain echoed
 // page content with injection patterns. Without wrapping, those
 // patterns are re-injected into the retry's loopWarning context.
          `Raw response (truncated): ${wrapUntrusted(raw.slice(0, 400))}\n` +
          `Please re-emit your response as valid JSON matching the AgentOutput schema ` +
          `({thinking, evaluation_previous_goal, memory, next_goal, action:[...]}). ` +
          `Do NOT wrap the JSON in markdown fences. Do NOT add commentary before or after the JSON.\n` +
          `</parse_error>\n</sys>`;
 // Accumulate the parse-error history locally and feed it to the next
 // attempt via a CLONE of the request — never mutate the caller's
 // `navRequest`, which would leak prior-step content into later steps.
        accumulatedWarning = accumulatedWarning
          ? `${accumulatedWarning}\n${parseErrorBlock}`
          : parseErrorBlock;
        request = { ...navRequest, loopWarning: accumulatedWarning };
      }
    }
    throw new Error(
      `Navigator LLM returned unparseable output after ${MAX_PARSE_RETRIES + 1} attempts: ${lastError}`
    );
  } finally {
    if (dispatcher && ctx && !fired) {
      await dispatcher.llmEnd(ctx, { content: lastRaw, usage: lastUsage });
 // Attribute cost on the parse-failure / transient-error path too — the
 // LLM call DID consume tokens. Report the SUM of all attempted usages
 // (not just the final attempt) so per-phase analytics stay accurate.
 // `costFired` guards against double-counting the (already-costed)
 // success path.
      if (!costFired) {
        const summed = sumUsages(attemptUsages);
        if (summed) await dispatcher.cost(ctx, summed);
      }
    }
  }
}
