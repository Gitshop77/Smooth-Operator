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

import type { AgentAction, ActionResult } from "./types";
// `redactSecrets` is applied to handler errors before logging so a substituted
// secret that surfaces in an error string isn't echoed unredacted to the
// extension console. It is async (loads the secret map), so
// we log via a fire-and-forget `.then`.
import { redactSecrets } from "./secrets";
// `redactKeyLeak` (from the extension shared module) is the canonical
// API-key masker — used as a defense-in-depth safety net on every log line
// (including the redaction-failure fallback) so a key can never be echoed.
import { redactKeyLeak } from "@/extension/shared";
import type {
  AgentRunResult,
  LLMUsageInfo,
  CallbackContext,
  LLMResponseInfo,
  AsyncCallbackHandler,
} from "./callbacks-utils";

// Re-export all types so existing import paths ("./callbacks") keep working.
export type {
  AgentRunResult,
  LLMUsageInfo,
  CallbackContext,
  AsyncCallbackHandler,
} from "./callbacks-utils";

/**
 * Callback dispatcher — runs all registered handlers for each hook in
 * registration order. Awaits each handler before invoking the next so
 * side-effects (logging, persistence) stay ordered.
 */
export class CallbackDispatcher {
  private readonly handlers: AsyncCallbackHandler[] = [];
  /**
   * Tracks how many times each hook method has failed, so we can log the FIRST
   * failure (as before) and then re-log on a throttle (see {@link WARN_THROTTLE})
   * instead of suppressing every later error. A buggy handler that throws on
   * every event across a long run would otherwise go silent after the first
   * occurrence, hiding a persistent failure (and any secret-laden detail it
   * carries) for the rest of the run.
   */
  private readonly warnCounts = new Map<string, number>();
  /** Re-log a handler failure every Nth occurrence after the first (trailing-edge visibility). */
  private static readonly WARN_THROTTLE = 10;
  /** Stable per-instance identity so one handler's failures don't suppress another's. */
  private readonly handlerIds = new WeakMap<object, string>();
  private handlerSeq = 0;

  /** Register a handler. Hooks the handler doesn't implement are no-ops. */
  register(handler: AsyncCallbackHandler): void {
    if (this.handlers.includes(handler)) return;
    this.handlers.push(handler);
    if (!this.handlerIds.has(handler)) {
      const name = (handler as { constructor?: { name?: string } }).constructor?.name ?? "handler";
      this.handlerIds.set(handler, `${name}#${++this.handlerSeq}`);
    }
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
  // `this.nextPhase = ...` / `this.totalSteps++`.
      if (fn) await fn.apply(handler, args);
    } catch (e) {
  // A single buggy handler can throw on every event across a long run; throttle
  // the (possibly secret-laden) error logging to the first failure per hook
  // method so the console stays readable. Successful dispatch is unaffected.
      const hid = this.handlerIds.get(handler) ?? "handler";
      const k = `${hid}:${String(method)}`;
      const count = (this.warnCounts.get(k) ?? 0) + 1;
      this.warnCounts.set(k, count);
      // Log the first failure (for an immediate signal) and then re-log every
      // Nth occurrence so a handler that keeps throwing stays visible instead of
      // going silent after the first error. The redaction + fallback below are
      // unchanged.
      if (count !== 1 && count % CallbackDispatcher.WARN_THROTTLE !== 0) return;
  // Redact any substituted secrets that leaked into the error string before
  // logging to the extension console (defense-in-depth). Await the redaction so the secret-laden raw error string
  // never reaches the console ahead of masking, and wrap it in try/catch so a
  // redaction failure can NEVER echo secrets: the fallback masks any API keys
  // in the raw error before logging it.
      try {
        const safe = await redactSecrets(String(e));
        console.error(`[callbacks] ${String(method)} handler failed:`, redactKeyLeak(safe));
      } catch {
        console.error(
          `[callbacks] ${String(method)} handler failed (secret redaction unavailable):`,
          redactKeyLeak(String(e)),
        );
      }
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
