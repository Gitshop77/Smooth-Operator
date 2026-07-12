/**
 * Callback system — the clean abstraction for cross-cutting concerns.
 *
 * Instead of tangling logging, telemetry, and cost tracking into the agent
 * loop, each concern is a separate callback handler. Register as many
 * handlers as you need; the dispatcher fans out each event to every handler
 * that implements the relevant hook.
 *
 * 15 hooks (in lifecycle order):
 * onRunStart / onRunEnd / onPlannerStep
 * onStepStart / onStepEnd / onThinking
 * onLLMStart / onLLMEnd
 * onActionStart / onActionEnd / onScreenshot
 * onLoopWarning / onCompaction / onCost / onError
 *
 * ─── Cost tracking ───────────────────────────────────────────────────────────
 * Cost computation is centralized in `pricing.ts` (`estimateCost`) and is
 * invoked from the protocol/provider-bridge layer, not from this module. This
 * module only surfaces per-call usage through {@link LLMUsageInfo} and the
 * run's aggregate totals through {@link AgentRunResult}.
 */

import type { AgentAction, ActionResult, HistoryItem } from "./types";
// `redactSecrets` is applied to handler errors before logging so a substituted
// secret that surfaces in an error string isn't echoed unredacted to the
// extension console (see finding [28]). It is async (loads the secret map), so
// we log via a fire-and-forget `.then`.
import { redactSecrets } from "./secrets";
// Note: `getPricingForModel` is intentionally not imported here. Cost
// computation lives in `pricing.ts` (`estimateCost`) and is invoked from the
// protocol/provider-bridge layer, not from this module.

/**
 * Per-call token accounting. The four-field split (input / cached / output /
 * reasoning) lets cost trackers bill each component at its own rate — most
 * providers charge differently for cached input vs. fresh input, and
 * reasoning models (o1/o3, deepseek-reasoner) bill reasoning tokens
 * separately from visible output.
 *
 * Cost accounting is centralized in `pricing.ts` (`estimateCost`) and the
 * `LLMUsageInfo` type below. `AgentRunResult` is the only aggregate type
 * still in use from this module.
 */
export interface AgentRunResult {
  /** Whether the task ultimately succeeded. */
  success: boolean;
  /** Final user-facing summary text. */
  text: string;
  /** Total steps executed. */
  stepCount: number;
  /** Total USD cost across all LLM calls. */
  totalCostUsd: number;
  /** Total input tokens across all LLM calls. */
  totalTokensIn: number;
  /** Total output tokens across all LLM calls. */
  totalTokensOut: number;
}

/** Token + cost usage for a single LLM call. */
export interface LLMUsageInfo {
  /** Input tokens billed for this call. */
  tokensIn: number;
  /** Output tokens billed for this call. */
  tokensOut: number;
  /** Model name (used for pricing lookup). */
  model: string;
  /** USD cost of this call. */
  costUsd: number;
  /** Reasoning/thinking tokens (billed at the model's reasoning rate). */
  reasoningTokens?: number;
  /** Cached input tokens (Anthropic cache_read+cache_creation, OpenAI cached_tokens).
 * Surfaced so downstream cost recomputation (judges.ts) can apply the
 * cacheRead discount instead of billing cached tokens at full input rate. */
  cachedInputTokens?: number;
}

/** Ambient context handed to every hook. */
export interface CallbackContext {
  /** The user's original task. */
  task: string;
  /** Current step number (0-indexed). */
  step: number;
  /** The navigator's accumulated step history. */
  history: HistoryItem[];
}

/** LLM response shape passed to {@link AsyncCallbackHandler.onLLMEnd}. */
export interface LLMResponseInfo {
  /** The raw text content returned by the LLM. */
  content: string;
  /** Token + cost usage (when available). */
  usage?: LLMUsageInfo;
}

/**
 * Base callback interface — override only the hooks you need.
 * Every method is optional; the dispatcher skips handlers that don't implement
 * a given hook.
 */
export interface AsyncCallbackHandler {
  /** Fired once when the run begins. */
  onRunStart?(ctx: CallbackContext): void | Promise<void>;
  /** Fired once when the run ends (success or failure). */
  onRunEnd?(result: AgentRunResult): void | Promise<void>;
  /** Fired after each planner step (decision + optional goal/plan). */
  onPlannerStep?(ctx: CallbackContext, decision: string, goal?: string, plan?: string[]): void | Promise<void>;
  /** Fired at the start of each navigator step. */
  onStepStart?(ctx: CallbackContext): void | Promise<void>;
  /** Fired at the end of each navigator step with all action results. */
  onStepEnd?(ctx: CallbackContext, actions: ActionResult[]): void | Promise<void>;
  /** Fired when the navigator emits its structured thinking for a step. */
  onThinking?(ctx: CallbackContext, text: string, evaluation: string, memory: string, nextGoal: string): void | Promise<void>;
  /** Fired before the LLM is called with the assembled message list. */
  onLLMStart?(ctx: CallbackContext, messages: unknown[]): void | Promise<void>;
  /** Fired after the LLM returns (success or failure). */
  onLLMEnd?(ctx: CallbackContext, response: LLMResponseInfo): void | Promise<void>;
  /** Fired before each action executes. */
  onActionStart?(ctx: CallbackContext, action: AgentAction): void | Promise<void>;
  /** Fired after each action executes (success or failure). */
  onActionEnd?(ctx: CallbackContext, action: AgentAction, result: ActionResult): void | Promise<void>;
  /** Fired when a screenshot is captured (base64 data URL). */
  onScreenshot?(ctx: CallbackContext, dataUrl: string): void | Promise<void>;
  /** Fired when the loop detector triggers (with the repetition count). */
  onLoopWarning?(ctx: CallbackContext, count: number): void | Promise<void>;
  /** Fired when history compaction runs (with the number of compacted steps). */
  onCompaction?(ctx: CallbackContext, compactedCount: number): void | Promise<void>;
  /** Fired on every LLM call with token + cost usage. */
  onCost?(ctx: CallbackContext, usage: LLMUsageInfo): void | Promise<void>;
  /** Fired on any non-fatal error with a recoverability hint. */
  onError?(ctx: CallbackContext, message: string, recoverable: boolean): void | Promise<void>;
}

/**
 * Callback dispatcher — runs all registered handlers for each hook in
 * registration order. Awaits each handler before invoking the next so
 * side-effects (logging, persistence) stay ordered.
 */
export class CallbackDispatcher {
  private readonly handlers: AsyncCallbackHandler[] = [];

  /** Register a handler. Hooks the handler doesn't implement are no-ops. */
  register(handler: AsyncCallbackHandler): void {
    if (this.handlers.includes(handler)) return;
    this.handlers.push(handler);
  }

  /** Remove all registered handlers. */
  clear(): void {
    this.handlers.length = 0;
  }

  /**
 * Call a handler method safely — errors are logged and skipped so a buggy
 * callback can't crash the run. The rationale (from the original `cost()`
 * wrapper) applies equally to all hooks: callbacks are observational
 * side-channels, never the primary control flow. The orchestrator's own
 * state checks (costCapExceeded, consecutiveFailures, etc.) are the
 * authoritative control flow — callback throws must not propagate.
 */
  private async safeCall<T extends keyof AsyncCallbackHandler>(
    handler: AsyncCallbackHandler,
    method: T,
    ...args: unknown[]
  ): Promise<void> {
    try {
      const fn = handler[method] as ((...a: unknown[]) => Promise<void> | void) | undefined;
 // Invoke via `.apply` to preserve `this` — a bare `fn(...args)` call would
 // detach the method from its handler (strict-mode ES module => `this ===
 // undefined`), breaking stateful hooks like AgentMetricsCallback that do
 // `this.nextPhase = ...` / `this.totalSteps++` (see finding ).
      if (fn) await fn.apply(handler, args);
    } catch (e) {
 // Redact any substituted secrets that leaked into the error string before
 // logging to the extension console (defense-in-depth; mirrors the cockpit
 // redaction path). `redactSecrets` is async, so log via `.then` and fall
 // back to the raw error if redaction itself fails.
      void redactSecrets(String(e))
        .then((safe) => console.error(`[callbacks] ${String(method)} handler failed:`, safe))
        .catch(() => console.error(`[callbacks] ${String(method)} handler failed:`, e));
    }
  }

  /** @see AsyncCallbackHandler.onRunStart */
  async runStart(ctx: CallbackContext): Promise<void> {
    for (const h of this.handlers) await this.safeCall(h, "onRunStart", ctx);
  }

  /** @see AsyncCallbackHandler.onRunEnd */
  async runEnd(result: AgentRunResult): Promise<void> {
    for (const h of this.handlers) await this.safeCall(h, "onRunEnd", result);
  }

  /** @see AsyncCallbackHandler.onPlannerStep */
  async plannerStep(ctx: CallbackContext, decision: string, goal?: string, plan?: string[]): Promise<void> {
    for (const h of this.handlers) await this.safeCall(h, "onPlannerStep", ctx, decision, goal, plan);
  }

  /** @see AsyncCallbackHandler.onStepStart */
  async stepStart(ctx: CallbackContext): Promise<void> {
    for (const h of this.handlers) await this.safeCall(h, "onStepStart", ctx);
  }

  /** @see AsyncCallbackHandler.onStepEnd */
  async stepEnd(ctx: CallbackContext, actions: ActionResult[]): Promise<void> {
    for (const h of this.handlers) await this.safeCall(h, "onStepEnd", ctx, actions);
  }

  /** @see AsyncCallbackHandler.onThinking */
  async thinking(ctx: CallbackContext, text: string, evaluation: string, memory: string, nextGoal: string): Promise<void> {
    for (const h of this.handlers) await this.safeCall(h, "onThinking", ctx, text, evaluation, memory, nextGoal);
  }

  /** @see AsyncCallbackHandler.onLLMStart */
  async llmStart(ctx: CallbackContext, messages: unknown[]): Promise<void> {
    for (const h of this.handlers) await this.safeCall(h, "onLLMStart", ctx, messages);
  }

  /** @see AsyncCallbackHandler.onLLMEnd */
  async llmEnd(ctx: CallbackContext, response: LLMResponseInfo): Promise<void> {
    for (const h of this.handlers) await this.safeCall(h, "onLLMEnd", ctx, response);
  }

  /** @see AsyncCallbackHandler.onActionStart */
  async actionStart(ctx: CallbackContext, action: AgentAction): Promise<void> {
    for (const h of this.handlers) await this.safeCall(h, "onActionStart", ctx, action);
  }

  /** @see AsyncCallbackHandler.onActionEnd */
  async actionEnd(ctx: CallbackContext, action: AgentAction, result: ActionResult): Promise<void> {
    for (const h of this.handlers) await this.safeCall(h, "onActionEnd", ctx, action, result);
  }

  /** @see AsyncCallbackHandler.onScreenshot */
  async screenshot(ctx: CallbackContext, dataUrl: string): Promise<void> {
    for (const h of this.handlers) await this.safeCall(h, "onScreenshot", ctx, dataUrl);
  }

  /** @see AsyncCallbackHandler.onLoopWarning */
  async loopWarning(ctx: CallbackContext, count: number): Promise<void> {
    for (const h of this.handlers) await this.safeCall(h, "onLoopWarning", ctx, count);
  }

  /** @see AsyncCallbackHandler.onCompaction */
  async compaction(ctx: CallbackContext, compactedCount: number): Promise<void> {
    for (const h of this.handlers) await this.safeCall(h, "onCompaction", ctx, compactedCount);
  }

  /** @see AsyncCallbackHandler.onCost */
  async cost(ctx: CallbackContext, usage: LLMUsageInfo): Promise<void> {
    for (const h of this.handlers) await this.safeCall(h, "onCost", ctx, usage);
  }

  /** @see AsyncCallbackHandler.onError */
  async error(ctx: CallbackContext, message: string, recoverable: boolean): Promise<void> {
    for (const h of this.handlers) await this.safeCall(h, "onError", ctx, message, recoverable);
  }
}
