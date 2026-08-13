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
  AgentStepRequest,
  PlannerOutput,
  PlannerStepRequest,
} from "../../types";
import { parseAgentOutput, parsePlannerOutput } from "../../output-parser";
import { wrapUntrusted } from "../../security";
import { redactKeyShapes } from "../../key-shape-redact";
import type {
  CallbackDispatcher,
  CallbackContext,
  LLMUsageInfo,
} from "../../callbacks";
import type { LoopDeps, PlannerCallArgs } from "../types";
import { MAX_PARSE_RETRIES } from "../constants";
import { sumUsages, accountUsage, reportCostEvent, sanitizeUsageNumber, sleepParseRetryBackoff } from "./llm-calls-utils";

let llmCallSequence = 0;

function nextCallId(role: "planner" | "navigator", step: number): string {
  llmCallSequence = (llmCallSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${role}-${step}-${Date.now()}-${llmCallSequence}`;
}

function jsonChars(value: unknown): number {
  try { return JSON.stringify(value).length; } catch { return 0; }
}

function plannerPromptStats(request: PlannerStepRequest) {
  const requestChars = request.task.length + jsonChars(request.history) +
    (request.plan?.reduce((sum, item) => sum + item.length, 0) ?? 0) +
    request.url.length + jsonChars(request.tabs) + (request.compactedMemory?.length ?? 0);
  return {
    historyItems: request.history.length,
    requestChars,
    taskChars: request.task.length,
    planItems: request.plan?.length ?? 0,
    tabCount: request.tabs.length,
    compactedMemoryChars: request.compactedMemory?.length ?? 0,
  };
}

function navigatorPromptStats(request: AgentStepRequest) {
  const browser = request.browserState;
  // Sum the already-present string fields instead of JSON.stringify(request):
  // the latter creates a second full copy of a base64 screenshot just to count
  // it, causing a needless multi-megabyte allocation on vision steps.
  const requestChars = (request.task?.length ?? 0) + jsonChars(request.history ?? []) +
    (request.plan?.reduce((sum, item) => sum + item.length, 0) ?? 0) +
    (request.currentGoal?.length ?? 0) + (request.compactedMemory?.length ?? 0) +
    (request.loopWarning?.length ?? 0) + (browser?.url?.length ?? 0) +
    (browser?.title?.length ?? 0) + jsonChars(browser?.tabs ?? []) +
    (browser?.elementsText?.length ?? 0) + (browser?.pageInfo?.length ?? 0) +
    (browser?.axTree?.length ?? 0) + (browser?.screenshot?.length ?? 0);
  return {
    historyItems: request.history?.length ?? 0,
    requestChars,
    taskChars: request.task?.length ?? 0,
    planItems: request.plan?.length ?? 0,
    tabCount: browser?.tabs?.length ?? 0,
    elementsChars: browser?.elementsText?.length ?? 0,
    axTreeChars: browser?.axTree?.length ?? 0,
    screenshotChars: browser?.screenshot?.length ?? 0,
    compactedMemoryChars: request.compactedMemory?.length ?? 0,
  };
}

function safeErrorText(error: unknown): string {
  return redactKeyShapes(error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

function streamProgressEmitter(
  deps: LoopDeps,
  meta: { step: number; callId: string; role: "planner" | "navigator"; attempt: number; startedAt: number },
) {
  let lastEmissionAt = 0;
  return (progress: { outputChars: number; chunkCount: number; at: number }) => {
    if (progress.outputChars > 0 && (lastEmissionAt === 0 || progress.at - lastEmissionAt >= 500)) {
      lastEmissionAt = progress.at;
      deps.onEvent({
        type: "llm-call-progress", step: meta.step, callId: meta.callId,
        role: meta.role, attempt: meta.attempt, outputChars: progress.outputChars,
        chunkCount: progress.chunkCount, elapsedMs: progress.at - meta.startedAt,
      });
    }
  };
}

/**
 * Account + report a single LLM call's token→cost→usage, shared by
 * `runPlanner` and `callNavigatorWithRetry`. Prefers a pre-computed
 * `precomputedCost`; otherwise falls back to `estimateCost` (passing
 * cachedInputTokens + cachedWriteInputTokens through). When the cost is a
 * number, surfaces it to the caller (`onCost`) + as a `cost` event — per
 * attempt in the navigator, so the run total stays exact across retries.
 * Returns the usage record for `dispatcher.llmEnd`/`cost` attribution.
 */
function accountAndReportUsage(params: {
  step: number;
  onCost: (usd: number, tokensIn?: number, tokensOut?: number) => void;
  deps: LoopDeps;
  precomputedCost?: number;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cachedWriteInputTokens?: number;
  costCapUsd?: number;
}): LLMUsageInfo | undefined {
  const { step, onCost, deps, precomputedCost, model, tokensIn, tokensOut, reasoningTokens, cachedInputTokens, cachedWriteInputTokens, costCapUsd } = params;
  const accounted = accountUsage({ precomputedCost, model, tokensIn, tokensOut, reasoningTokens, cachedInputTokens, cachedWriteInputTokens, costCapUsd });
  if (!accounted) return undefined;
  const { cost, usage: u } = accounted;
  if (typeof cost === "number" && u) {
    onCost(cost, u.tokensIn, u.tokensOut);
    reportCostEvent(deps.onEvent, step, u);
  }
  return u;
}

interface FailedCallUsage {
  tokensIn?: number;
  tokensOut?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cachedWriteInputTokens?: number;
  model?: string;
  costUsd?: number;
}

function getFailedCallUsage(error: unknown): FailedCallUsage | undefined {
  const usage = (error as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const raw = usage as Record<string, unknown>;
  const sanitized: FailedCallUsage = {};
  // Vet every numeric field before it can flow into onCost / dispatcher.cost:
  // a malformed provider-bridge error with costUsd:-100 / tokensIn:NaN would
  // otherwise corrupt the cost-cap ledger and per-run analytics.
  const num = (k: keyof FailedCallUsage): number | undefined =>
    sanitizeUsageNumber(raw[k] as number | undefined);
  const tokensIn = num("tokensIn");
  const tokensOut = num("tokensOut");
  const reasoningTokens = num("reasoningTokens");
  const cachedInputTokens = num("cachedInputTokens");
  const cachedWriteInputTokens = num("cachedWriteInputTokens");
  const costUsd = num("costUsd");
  if (tokensIn !== undefined) sanitized.tokensIn = tokensIn;
  if (tokensOut !== undefined) sanitized.tokensOut = tokensOut;
  if (reasoningTokens !== undefined) sanitized.reasoningTokens = reasoningTokens;
  if (cachedInputTokens !== undefined) sanitized.cachedInputTokens = cachedInputTokens;
  if (cachedWriteInputTokens !== undefined) sanitized.cachedWriteInputTokens = cachedWriteInputTokens;
  if (costUsd !== undefined) sanitized.costUsd = costUsd;
  if (typeof raw.model === "string") sanitized.model = raw.model;
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
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
  const callId = nextCallId("planner", args.step);
  const callStartedAt = Date.now();
  deps.onEvent({
    type: "llm-call-start", step: args.step, callId, role: "planner",
    attempt: 1, startedAt: callStartedAt, prompt: plannerPromptStats(plannerRequest),
  });
  if (dispatcher && ctx) await dispatcher.llmStart(ctx, [plannerRequest]);
 // finally block guarantees `llmEnd` fires on every path after `llmStart`
 // (parse failure, transient LLM error, success). `fired` guards against
 // double-fire on the success path.
  let fired = false;
  let usage: LLMUsageInfo | undefined;
  let raw = "";
  let callEventEnded = false;
  let resultModel: string | undefined;
  try {
    let result: Awaited<ReturnType<LoopDeps["plannerCall"]>>;
    try {
      result = await deps.plannerCall(plannerRequest, signal, streamProgressEmitter(deps, {
        step: args.step, callId, role: "planner", attempt: 1, startedAt: callStartedAt,
      }));
    } catch (error) {
      const failed = getFailedCallUsage(error);
      if (failed) {
        usage = accountAndReportUsage({
          step: args.step,
          onCost: args.onCost,
          deps,
          precomputedCost: failed.costUsd,
          model: failed.model,
          tokensIn: failed.tokensIn,
          tokensOut: failed.tokensOut,
          reasoningTokens: failed.reasoningTokens,
          cachedInputTokens: failed.cachedInputTokens,
          cachedWriteInputTokens: failed.cachedWriteInputTokens,
          costCapUsd,
        });
        if (costCapCheck?.()) throw new Error("Budget exceeded: cost cap reached");
      }
      throw error;
    }
    raw = result.raw;
    resultModel = result.model;
    const { tokensIn, tokensOut, reasoningTokens, cachedInputTokens, model, costUsd: precomputedCost } = result;
 // Read cache-write (creation) tokens when the caller threads them through.
 // `cachedWriteInputTokens` is billed at the (higher) cache-write rate, so
 // omitting it under-reports Anthropic cache-creation cost.
    const cachedWriteInputTokens = result.cachedWriteInputTokens ?? 0;
    usage = accountAndReportUsage({ step: args.step, onCost: args.onCost, deps, precomputedCost, model, tokensIn, tokensOut, reasoningTokens, cachedInputTokens, cachedWriteInputTokens, costCapUsd });
    // A single overshoot planner call must trip the cost cap immediately,
    // right after cost is accrued — NOT only at the next step boundary and NOT
    // only when a dispatcher is wired. Hoisted out of the `if (dispatcher &&
    // ctx)` block so the cap also trips on the parse-failure path and when no
    // dispatcher is present. `costCapCheck` (wired to `costCapExceeded(state)`)
    // now reflects the true spend, so throw and let the orchestrator finalize
    // the run as a cost-cap stop rather than looping again.
    if (costCapCheck?.()) throw new Error("Budget exceeded: cost cap reached");
    const parsed = parsePlannerOutput(raw);
    if (!parsed.ok || !parsed.output) {
      throw new Error(`Planner output parse failed: ${parsed.error}`);
    }
    callEventEnded = true;
    deps.onEvent({
      type: "llm-call-end", step: args.step, callId, role: "planner", attempt: 1,
      status: "success", durationMs: Date.now() - callStartedAt, outputChars: raw.length,
      parseValid: true, model: resultModel, tokensIn: usage?.tokensIn,
      tokensOut: usage?.tokensOut, reasoningTokens: usage?.reasoningTokens,
      cachedInputTokens: usage?.cachedInputTokens,
      cachedWriteInputTokens: usage?.cachedWriteInputTokens,
    });
    if (dispatcher && ctx) {
 // Set the guard before the awaited dispatcher calls so a throwing
 // dispatcher on the success path does not get re-emitted by the finally
 // block (duplicate llmEnd/cost + masked original error).
      fired = true;
      await dispatcher.llmEnd(ctx, { content: raw, usage });
      if (usage) await dispatcher.cost(ctx, usage);
    }
    return parsed.output;
  } catch (error) {
    if (!callEventEnded) {
      callEventEnded = true;
      deps.onEvent({
        type: "llm-call-end", step: args.step, callId, role: "planner", attempt: 1,
        status: "error", durationMs: Date.now() - callStartedAt, outputChars: raw.length,
        parseValid: raw ? false : undefined, model: resultModel,
        tokensIn: usage?.tokensIn, tokensOut: usage?.tokensOut,
        reasoningTokens: usage?.reasoningTokens, cachedInputTokens: usage?.cachedInputTokens,
        cachedWriteInputTokens: usage?.cachedWriteInputTokens, error: safeErrorText(error),
      });
    }
    throw error;
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
      const attempt = retry + 1;
      const callId = nextCallId("navigator", step);
      const callStartedAt = Date.now();
      deps.onEvent({
        type: "llm-call-start", step, callId, role: "navigator", attempt,
        startedAt: callStartedAt, prompt: navigatorPromptStats(request),
      });
      let navResult: Awaited<ReturnType<LoopDeps["navigatorCall"]>>;
      try {
        navResult = await deps.navigatorCall(request, signal, streamProgressEmitter(deps, {
          step, callId, role: "navigator", attempt, startedAt: callStartedAt,
        }));
      } catch (error) {
        let budgetExceeded = false;
        const failed = getFailedCallUsage(error);
        if (failed) {
          const failedUsage = accountAndReportUsage({
            step,
            onCost,
            deps,
            precomputedCost: failed.costUsd,
            model: failed.model,
            tokensIn: failed.tokensIn,
            tokensOut: failed.tokensOut,
            reasoningTokens: failed.reasoningTokens,
            cachedInputTokens: failed.cachedInputTokens,
            cachedWriteInputTokens: failed.cachedWriteInputTokens,
            costCapUsd,
          });
          lastUsage = failedUsage;
          if (failedUsage) attemptUsages.push(failedUsage);
          budgetExceeded = costCapCheck?.() ?? false;
        }
        deps.onEvent({
          type: "llm-call-end", step, callId, role: "navigator", attempt,
          status: "error", durationMs: Date.now() - callStartedAt, outputChars: 0,
          tokensIn: lastUsage?.tokensIn, tokensOut: lastUsage?.tokensOut,
          reasoningTokens: lastUsage?.reasoningTokens,
          cachedInputTokens: lastUsage?.cachedInputTokens,
          cachedWriteInputTokens: lastUsage?.cachedWriteInputTokens,
          error: safeErrorText(error),
        });
        if (budgetExceeded) throw new Error("Budget exceeded: cost cap reached");
        throw error;
      }
      const { raw, tokensIn, tokensOut, reasoningTokens, cachedInputTokens, model, costUsd: precomputedCost } = navResult;
 // Read cache-write (creation) tokens when the caller threads them through
 // (billed at the higher cache-write rate; omitted, it under-reports
 // Anthropic cache-creation cost).
      const cachedWriteInputTokens = navResult.cachedWriteInputTokens ?? 0;
      lastRaw = raw;
      const usage = accountAndReportUsage({ step, onCost, deps, precomputedCost, model, tokensIn, tokensOut, reasoningTokens, cachedInputTokens, cachedWriteInputTokens, costCapUsd });
      lastUsage = usage;
      if (usage) attemptUsages.push(usage);
      // A single overshoot navigator call must trip the cost cap the
      // moment cost is accrued, regardless of whether a dispatcher is wired and
      // even on a parse-failure retry attempt. Hoisted out of the
      // `if (dispatcher && ctx)` block below so the cap cannot be skipped.
      if (costCapCheck?.()) throw new Error("Budget exceeded: cost cap reached");
      const parsed = parseAgentOutput(raw);
      deps.onEvent({
        type: "llm-call-end", step, callId, role: "navigator", attempt,
        status: "success", durationMs: Date.now() - callStartedAt, outputChars: raw.length,
        parseValid: parsed.ok && !!parsed.output, model, tokensIn: usage?.tokensIn,
        tokensOut: usage?.tokensOut, reasoningTokens: usage?.reasoningTokens,
        cachedInputTokens: usage?.cachedInputTokens,
        cachedWriteInputTokens: usage?.cachedWriteInputTokens,
      });
      if (parsed.ok && parsed.output) {
        if (dispatcher && ctx) {
 // Set the guards before the awaited dispatcher calls so a throwing
 // dispatcher on the success path does not get re-emitted by the finally
 // block (duplicate llmEnd/cost + masked original error).
          fired = true;
          await dispatcher.llmEnd(ctx, { content: redactKeyShapes(raw), usage });
 // Per-phase cost attribution: report the SUM of all attempted
 // usages (failed + this successful attempt) so the per-phase
 // callback breakdown is accurate across retries.
          const summed = sumUsages(attemptUsages);
          if (summed) {
            costFired = true;
            await dispatcher.cost(ctx, summed);
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
  // patterns out of the retry's prompt context. Key-shape redaction
  // runs first: a model that echoed a substituted credential would
  // otherwise ship it to the provider a second time inside the retry.
          `Your previous response failed to parse and was rejected. Error: ${wrapUntrusted(redactKeyShapes(parsed.error ?? "unknown parse error"))}\n` +
  // Wrap the raw LLM output in wrapUntrusted — it may contain echoed
  // page content with injection patterns. Without wrapping, those
  // patterns are re-injected into the retry's loopWarning context. The
  // key-shape redaction pass mirrors the one on `parsed.error` above.
          `Raw response (truncated): ${wrapUntrusted(redactKeyShapes(raw.slice(0, 400)))}\n` +
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
        // Space parse-retry attempts with bounded full-jitter backoff: retries
        // are full re-calls, and zero-delay lockstep retries re-saturate the
        // exact provider overload that caused the failure. Abort-aware.
        await sleepParseRetryBackoff(retry, signal);
      }
    }
    throw new Error(
      `Navigator LLM returned unparseable output after ${MAX_PARSE_RETRIES + 1} attempts: ${lastError}`
    );
  } finally {
    if (dispatcher && ctx && !fired) {
      await dispatcher.llmEnd(ctx, { content: redactKeyShapes(lastRaw), usage: lastUsage });
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
