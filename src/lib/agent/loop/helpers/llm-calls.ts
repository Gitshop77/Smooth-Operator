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
  let cachedWriteInputTokens = 0;
  let hasReasoning = false;
  let hasCached = false;
  let hasWriteCached = false;
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
    if (u.cachedWriteInputTokens) {
      cachedWriteInputTokens += u.cachedWriteInputTokens;
      hasWriteCached = true;
    }
  }
  return {
    tokensIn,
    tokensOut,
    model,
    costUsd,
    ...(hasReasoning ? { reasoningTokens } : {}),
    ...(hasCached ? { cachedInputTokens } : {}),
    ...(hasWriteCached ? { cachedWriteInputTokens } : {}),
  };
}

/**
 * Build a per-attempt {@link LLMUsageInfo} record (helper for the runPlanner /
 * callNavigatorWithRetry usage literals — both construct the identical shape).
 */
function buildUsage(
  model: string,
  tokensIn: number,
  tokensOut: number,
  costUsd: number,
  reasoningTokens?: number,
  cachedInputTokens?: number,
  cachedWriteInputTokens?: number,
): LLMUsageInfo {
  return {
    model,
    tokensIn,
    tokensOut,
    costUsd,
    reasoningTokens,
    cachedInputTokens,
    cachedWriteInputTokens,
  };
}

/**
 * Read cache-write (creation) tokens off an LLM result via a cast. The
 * upstream result types do not yet carry the field natively, so it is read
 * defensively and defaults to 0 when absent.
 */
function readCachedWriteTokens(u: unknown): number {
  return (u as { cachedWriteInputTokens?: number } | undefined)?.cachedWriteInputTokens ?? 0;
}

/**
 * Shared token→cost→usage accounting used by both {@link runPlanner} and
 * {@link callNavigatorWithRetry}. Returns the finite dollar cost (or
 * `undefined`) and the matching per-attempt {@link LLMUsageInfo} (or
 * `undefined`), or `undefined` entirely when token counts are missing. The
 * caller is responsible for the `onCost` / `onEvent` side-effects and for
 * pushing the usage into the per-phase aggregate.
 */
/**
 * Provider-independent floor cost (USD) accrued for an LLM call that omits token
 * usage while a cost cap is active. When the provider reports no
 * `tokensIn`/`tokensOut` we cannot measure real spend, so instead of silently
 * never enforcing the cap we accrue this small floor. It is conservative (it
 * over-counts unmeasurable steps) so a cost cap is still respected even when the
 * provider does not report usage — `costCapExceeded` then trips once the floors
 * accumulate past the cap. Kept tiny so a single omitted call never trips a
 * sensibly-sized cap on its own.
 */
const MISSING_USAGE_FLOOR_USD = 0.01;

function accountUsage(params: {
  precomputedCost?: number;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cachedWriteInputTokens?: number;
  /** Active cost cap (if any). When > 0 and usage is omitted we accrue a floor. */
  costCapUsd?: number;
}): { cost: number | undefined; usage: LLMUsageInfo | undefined } | undefined {
  const { precomputedCost, model, tokensIn, tokensOut, reasoningTokens, cachedInputTokens, cachedWriteInputTokens, costCapUsd } = params;
  if (tokensIn === undefined || tokensOut === undefined) {
    // Provider omitted token usage. If a cost cap is in effect we cannot measure
    // spend, so accrue a provider-independent floor rather than letting the
    // cap become inert. When no cap is set, preserve the historical behavior
    // (return undefined — cost for this call is simply not tracked).
    if (costCapUsd !== undefined && costCapUsd > 0) {
      return {
        cost: MISSING_USAGE_FLOOR_USD,
        usage: { model: model ?? "", tokensIn: 0, tokensOut: 0, costUsd: MISSING_USAGE_FLOOR_USD },
      };
    }
    return undefined;
  }
 // Production planner/navigator calls go through provider-bridge, which
 // already supplies a provider-scoped `costUsd` (precomputedCost) AND passes
 // its config.providerId into estimateCost — so this fallback only runs when a
 // caller supplies a model without a precomputed cost. When that model id is
 // provider-prefixed (e.g. "google/gemini-2.5-pro" from an OpenRouter-style
 // provider), thread the prefix so pricing disambiguates the same bare id
 // across providers. Bare ids (no "/") carry no provider context at the loop
 // layer (AgentConfig doesn't hold providerId), so we leave it undefined and
 // rely on the first-writer-wins bare-id resolution in pricing.ts.
  const costModelProviderId = model?.includes("/") ? model.split("/")[0] : undefined;
  const cost = precomputedCost ?? (model ? estimateCost(model, tokensIn, tokensOut, reasoningTokens, cachedInputTokens, cachedWriteInputTokens, undefined, costModelProviderId) : undefined);
  const usage: LLMUsageInfo | undefined =
    typeof cost === "number" && Number.isFinite(cost)
      ? buildUsage(model ?? "", tokensIn, tokensOut, cost, reasoningTokens, cachedInputTokens, cachedWriteInputTokens)
      : model
        ? buildUsage(model, tokensIn, tokensOut, 0, reasoningTokens, cachedInputTokens, cachedWriteInputTokens)
        : undefined;
  return {
    cost: typeof cost === "number" && Number.isFinite(cost) ? cost : undefined,
    usage,
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
  ctx?: CallbackContext,
  signal?: AbortSignal,
  /** Active cost cap (if any) — enables the missing-usage floor. */
  costCapUsd?: number,
  /** Returns true when the run's cost cap is exceeded (C17) — checked right
   * after cost accrues so a single overshoot call is caught immediately. */
  costCapCheck?: () => boolean
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
    compactedMemory: args.compactedMemory,
  };
  if (dispatcher && ctx) await dispatcher.llmStart(ctx, [plannerRequest]);
 // finally block guarantees `llmEnd` fires on every path after `llmStart`
 // (parse failure, transient LLM error, success). `fired` guards against
 // double-fire on the success path.
  let fired = false;
  let usage: LLMUsageInfo | undefined;
  let raw = "";
  try {
    const result = await deps.plannerCall(plannerRequest, signal);
    raw = result.raw;
    const { tokensIn, tokensOut, reasoningTokens, cachedInputTokens, model, costUsd: precomputedCost } = result;
 // Read cache-write (creation) tokens when the caller threads them through.
 // `cachedWriteInputTokens` is billed at the (higher) cache-write rate, so
 // omitting it under-reports Anthropic cache-creation cost. The field is
 // read via a cast until the upstream result types (loop/types.ts) and
 // the loop-deps wiring (llm-direct.ts) propagate it end-to-end.
    const cachedWriteInputTokens = readCachedWriteTokens(result);
    const accounted = accountUsage({ precomputedCost, model, tokensIn, tokensOut, reasoningTokens, cachedInputTokens, cachedWriteInputTokens, costCapUsd });
    if (accounted) {
      const { cost, usage: u } = accounted;
      if (typeof cost === "number" && u) {
        args.onCost(cost, u.tokensIn, u.tokensOut);
        deps.onEvent({ type: "cost", step: args.step, tokensIn: u.tokensIn, tokensOut: u.tokensOut, costUsd: cost, model: model ?? "" });
      }
      usage = u;
    }
    const parsed = parsePlannerOutput(raw);
    if (!parsed.ok || !parsed.output) {
      throw new Error(`Planner output parse failed: ${parsed.error}`);
    }
    if (dispatcher && ctx) {
 // Set the guard before the awaited dispatcher calls so a throwing
 // dispatcher on the success path does not get re-emitted by the finally
 // block (duplicate llmEnd/cost + masked original error).
      fired = true;
      await dispatcher.llmEnd(ctx, { content: raw, usage });
      if (usage) await dispatcher.cost(ctx, usage);
    // C17: a single overshoot planner call must trip the cap immediately, not
    // only at the next step boundary. Cost has already been accrued via onCost
    // above, so `costCapCheck` (wired to `costCapExceeded(state)`) now reflects
    // the true spend. Throw so the orchestrator finalizes the run as a cost-cap
    // stop rather than looping again.
      if (costCapCheck?.()) throw new Error("Budget exceeded: cost cap reached");
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
  ctx?: CallbackContext,
  signal?: AbortSignal,
  /** Active cost cap (if any) — enables the missing-usage floor. */
  costCapUsd?: number,
  /** Returns true when the run's cost cap is exceeded (C17) — checked right
   * after cost accrues so a single overshoot call is caught immediately. */
  costCapCheck?: () => boolean
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
      const navResult = await deps.navigatorCall(request, signal);
      const { raw, tokensIn, tokensOut, reasoningTokens, cachedInputTokens, model, costUsd: precomputedCost } = navResult;
 // Read cache-write (creation) tokens when the caller threads them through
 // (billed at the higher cache-write rate; omitted, it under-reports
 // Anthropic cache-creation cost). Cast until upstream types/loop-deps
 // wiring propagate it end-to-end.
      const cachedWriteInputTokens = readCachedWriteTokens(navResult);
      lastRaw = raw;
      let usage: LLMUsageInfo | undefined;
 // Prefer pre-computed costUsd; fall back to estimateCost with
 // cachedInputTokens AND cachedWriteInputTokens (billed at the higher
 // cache-write rate) passed through. When only a precomputed cost is
 // supplied (no `model`), report it regardless of model presence.
      const accounted = accountUsage({ precomputedCost, model, tokensIn, tokensOut, reasoningTokens, cachedInputTokens, cachedWriteInputTokens, costCapUsd });
      if (accounted) {
        const { cost, usage: u } = accounted;
        if (typeof cost === "number" && u) {
 // Run-level cost accounting stays per-attempt so the run total (and
 // cost-cap enforcement) stays exact across retries.
          onCost(cost, u.tokensIn, u.tokensOut);
          deps.onEvent({ type: "cost", step, tokensIn: u.tokensIn, tokensOut: u.tokensOut, costUsd: cost, model: model ?? "" });
        }
        usage = u;
      }
      lastUsage = usage;
      if (usage) attemptUsages.push(usage);
      const parsed = parseAgentOutput(raw);
      if (parsed.ok && parsed.output) {
        if (dispatcher && ctx) {
 // Set the guards before the awaited dispatcher calls so a throwing
 // dispatcher on the success path does not get re-emitted by the finally
 // block (duplicate llmEnd/cost + masked original error).
          fired = true;
          await dispatcher.llmEnd(ctx, { content: raw, usage });
 // Per-phase cost attribution: report the SUM of all attempted
 // usages (failed + this successful attempt) so the per-phase
 // callback breakdown is accurate across retries.
          const summed = sumUsages(attemptUsages);
          if (summed) {
            costFired = true;
            await dispatcher.cost(ctx, summed);
          }
 // C17: catch a single overshoot navigator call (including mid-retry) the
 // moment cost is accrued, rather than only at the step boundary. `costCapCheck`
 // is wired to `costCapExceeded(state)` and the spend is already in `state`.
          if (costCapCheck?.()) throw new Error("Budget exceeded: cost cap reached");
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
