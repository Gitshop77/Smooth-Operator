import type { AgentAction, ActionResult, HistoryItem } from "./types";

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
  /** Cache-creation (write) input tokens (Anthropic cache_creation_input_tokens),
   * billed at the higher cache-write rate. Surfaced for cost-accounting parity
   * with the estimate produced by `estimateCost`. */
  cachedWriteInputTokens?: number;
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
