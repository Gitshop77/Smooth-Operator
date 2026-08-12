import type { LLMUsageInfo } from "../../callbacks";
import type { LogEvent } from "../../types";
import { estimateCost } from "../../llm/pricing";

/**
 * Provider-independent floor cost (USD) accrued for an LLM call that omits token
 * usage while a cost cap is active.
 */
const MISSING_USAGE_FLOOR_USD = 0.01;

/** Sanitize a numeric usage field: only finite, non-negative numbers pass. */
export function sanitizeUsageNumber(v: number | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Shared cost-event reporter — the single owner of the `cost` LogEvent shape.
 * Includes reasoning/cache tokens (the judge's cost event previously dropped
 * them, under-reporting Anthropic cache-write spend which bills at a higher
 * rate). Every cost path (planner, navigator, compaction, judge) emits through
 * this helper so the event shape can never drift between call sites.
 */
export function reportCostEvent(
  onEvent: (e: LogEvent) => void,
  step: number,
  usage: {
    model: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    cachedWriteInputTokens?: number;
  },
): void {
  onEvent({
    type: "cost", step,
    tokensIn: usage.tokensIn, tokensOut: usage.tokensOut,
    costUsd: usage.costUsd, model: usage.model,
    ...(usage.reasoningTokens ? { reasoningTokens: usage.reasoningTokens } : {}),
    ...(usage.cachedInputTokens ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(usage.cachedWriteInputTokens ? { cachedWriteInputTokens: usage.cachedWriteInputTokens } : {}),
  });
}

/**
 * Sum a list of per-attempt {@link LLMUsageInfo} records into a single
 * record representing the aggregate cost of a (possibly retried) phase.
 * The summed usage is attributed to the FIRST attempt's model — per-phase
 * cost for a retried phase must not be pinned to the final attempt's model,
 * which would corrupt per-model spend analytics.
 */
export function sumUsages(usages: LLMUsageInfo[]): LLMUsageInfo | undefined {
  if (usages.length === 0) return undefined;
  const model = usages[0].model;
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
  const estimated = precomputedCost ?? (model ? estimateCost({ model, tokensIn, tokensOut, reasoningTokens, cachedInputTokens, cachedWriteInputTokens, providerId: costModelProviderId }) : undefined);
  // Always attribute a numeric cost when tokens exist AND a model is known:
  // an unpriced/unknown model reports 0 (never `undefined`) so the caller's
  // `typeof cost === "number"` gate emits a `cost` event instead of silently
  // swallowing the spend — silent under-reporting corrupts the cost-cap check.
  const cost = typeof estimated === "number" && Number.isFinite(estimated)
    ? estimated
    : model
      ? 0
      : undefined;
  const usage: LLMUsageInfo | undefined = cost !== undefined
    ? buildUsage(model ?? "", tokensIn, tokensOut, cost, reasoningTokens, cachedInputTokens, cachedWriteInputTokens)
    : undefined;
  return { cost, usage };
}

// ─── Parse-retry backoff ─────────────────────────────────────────────────────

/** Base delay for parse-retry backoff (doubles per attempt). */
const PARSE_RETRY_BASE_MS = 200;
/** Absolute ceiling on a single parse-retry delay. */
const PARSE_RETRY_CAP_MS = 1500;

/**
 * Bounded full-jitter sleep between navigator parse-retry attempts. Zero-delay
 * lockstep retries re-saturate the exact provider overload that caused the
 * failure; full jitter desynchronizes concurrent clients. Abort-aware: a user
 * Stop during the backoff rejects immediately (no wasted wait before the
 * run's cancellation barrier completes).
 */
export async function sleepParseRetryBackoff(retry: number, signal?: AbortSignal): Promise<void> {
  const cap = Math.min(PARSE_RETRY_CAP_MS, PARSE_RETRY_BASE_MS * 2 ** retry);
  const delay = Math.floor(Math.random() * cap);
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
