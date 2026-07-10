/**
 * Loop helper — planner + navigator LLM call wrappers.
 *
 * - `runPlanner` calls the planner LLM and parses its output (throws on parse
 *   failure or transient LLM errors after retries).
 * - `callNavigatorWithRetry` calls the navigator LLM and retries up to
 *   {@link MAX_PARSE_RETRIES} times on parse failure.
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
    if (tokensIn !== undefined && tokensOut !== undefined && model) {
      // Prefer the provider-bridge's pre-computed costUsd (correctly accounts
      // for cachedInputTokens). Fall back to estimateCost with
      // cachedInputTokens passed through (dropping cachedInputTokens would
      // under-report Anthropic cached-step cost by up to 90%, disabling
      // cost-cap enforcement).
      const cost = precomputedCost ?? estimateCost(model, tokensIn, tokensOut, reasoningTokens, cachedInputTokens);
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
  // against double-fire on the success path.
  let fired = false;
  let lastRaw = "";
  let lastUsage: LLMUsageInfo | undefined;
  try {
    let lastError: string | undefined;
    for (let retry = 0; retry <= MAX_PARSE_RETRIES; retry++) {
      const { raw, tokensIn, tokensOut, reasoningTokens, cachedInputTokens, model, costUsd: precomputedCost } = await deps.navigatorCall(navRequest);
      lastRaw = raw;
      let usage: LLMUsageInfo | undefined;
      if (tokensIn !== undefined && tokensOut !== undefined && model) {
        // Prefer pre-computed costUsd; fall back to estimateCost with cachedInputTokens.
        const cost = precomputedCost ?? estimateCost(model, tokensIn, tokensOut, reasoningTokens, cachedInputTokens);
        onCost(cost, tokensIn, tokensOut);
        deps.onEvent({ type: "cost", step, tokensIn, tokensOut, costUsd: cost, model });
        usage = { tokensIn, tokensOut, model, costUsd: cost, reasoningTokens, cachedInputTokens };
      }
      lastUsage = usage;
      if (dispatcher && ctx && usage) {
        await dispatcher.cost(ctx, usage);
      }
      const parsed = parseAgentOutput(raw);
      if (parsed.ok && parsed.output) {
        if (dispatcher && ctx) await dispatcher.llmEnd(ctx, { content: raw, usage });
        fired = true;
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
          `Your previous response failed to parse and was rejected. Error: ${parsed.error}\n` +
          // Wrap the raw LLM output in wrapUntrusted — it may contain echoed
          // page content with injection patterns. Without wrapping, those
          // patterns are re-injected into the retry's loopWarning context.
          `Raw response (truncated): ${wrapUntrusted(raw.slice(0, 400))}\n` +
          `Please re-emit your response as valid JSON matching the AgentOutput schema ` +
          `({thinking, evaluation_previous_goal, memory, next_goal, action:[...]}). ` +
          `Do NOT wrap the JSON in markdown fences. Do NOT add commentary before or after the JSON.\n` +
          `</parse_error>\n</sys>`;
        navRequest.loopWarning = navRequest.loopWarning
          ? `${navRequest.loopWarning}\n${parseErrorBlock}`
          : parseErrorBlock;
      }
    }
    throw new Error(
      `Navigator LLM returned unparseable output after ${MAX_PARSE_RETRIES + 1} attempts: ${lastError}`
    );
  } finally {
    if (dispatcher && ctx && !fired) {
      await dispatcher.llmEnd(ctx, { content: lastRaw, usage: lastUsage });
    }
  }
}
