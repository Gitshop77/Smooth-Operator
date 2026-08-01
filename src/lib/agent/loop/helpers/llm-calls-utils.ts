import type { LLMUsageInfo } from "../../callbacks";
import { estimateCost } from "../../llm/pricing";

/**
 * Provider-independent floor cost (USD) accrued for an LLM call that omits token
 * usage while a cost cap is active.
 */
const MISSING_USAGE_FLOOR_USD = 0.01;

/**
 * Sum a list of per-attempt {@link LLMUsageInfo} records into a single
 * record representing the aggregate cost of a (possibly retried) phase.
 */
export function sumUsages(usages: LLMUsageInfo[]): LLMUsageInfo | undefined {
  if (usages.length === 0) return undefined;
  const model = usages[usages.length - 1].model;
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let reasoningTokens = 0;
  let cachedInputTokens = 0;
  let cachedWriteInputTokens = 0;
  for (const u of usages) {
    tokensIn += u.tokensIn;
    tokensOut += u.tokensOut;
    costUsd += u.costUsd;
    if (u.reasoningTokens) reasoningTokens += u.reasoningTokens;
    if (u.cachedInputTokens) cachedInputTokens += u.cachedInputTokens;
    if (u.cachedWriteInputTokens) cachedWriteInputTokens += u.cachedWriteInputTokens;
  }
  return {
    tokensIn,
    tokensOut,
    model,
    costUsd,
    ...(reasoningTokens ? { reasoningTokens } : {}),
    ...(cachedInputTokens ? { cachedInputTokens } : {}),
    ...(cachedWriteInputTokens ? { cachedWriteInputTokens } : {}),
  };
}

/**
 * Build a per-attempt {@link LLMUsageInfo} record.
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
 * Shared token→cost→usage accounting used by both `runPlanner` and
 * `callNavigatorWithRetry`.
 */
export function accountUsage(params: {
  precomputedCost?: number;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cachedWriteInputTokens?: number;
  costCapUsd?: number;
}): { cost: number | undefined; usage: LLMUsageInfo | undefined } | undefined {
  const { precomputedCost, model, tokensIn, tokensOut, reasoningTokens, cachedInputTokens, cachedWriteInputTokens, costCapUsd } = params;
  if (tokensIn === undefined || tokensOut === undefined) {
    const fallbackCost =
      typeof precomputedCost === "number" && Number.isFinite(precomputedCost)
        ? precomputedCost
        : costCapUsd !== undefined && costCapUsd > 0
          ? MISSING_USAGE_FLOOR_USD
          : undefined;
    if (fallbackCost === undefined) return undefined;
    return {
      cost: fallbackCost,
      usage: { model: model ?? "", tokensIn: 0, tokensOut: 0, costUsd: fallbackCost },
    };
  }
  const costModelProviderId = model?.includes("/") ? model.split("/")[0] : undefined;
  const cost = precomputedCost ?? (model ? estimateCost({ model, tokensIn, tokensOut, reasoningTokens, cachedInputTokens, cachedWriteInputTokens, providerId: costModelProviderId }) : undefined);
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
