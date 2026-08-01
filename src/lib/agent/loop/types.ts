/**
 * Loop type definitions.
 *
 * Centralizes every loop-specific type so the phase modules + context builders
 * can share them without a circular import through the main orchestrator.
 */

import type {
  AgentAction,
  AgentConfig,
  ActionResult,
  BrowserState,
  HistoryItem,
  LogEvent,
  TabInfo,
  TokenUsage,
} from "../types";
import type { AgentMode } from "../modes";
import type { CallbackDispatcher, AsyncCallbackHandler } from "../callbacks";
import type { LoopDetector } from "./loop-detector";

// ─── LLM call signatures ────────────────────────────────────────────────────

/** Shared return shape for an LLM call that yields raw text + optional usage. */
type LLMCall<Req> = (req: Req, signal?: AbortSignal) => Promise<{
  raw: string;
  tokensIn?: number;
  tokensOut?: number;
  /** Reasoning/thinking tokens (billed at the model's `reasoning` rate when present). */
  reasoningTokens?: number;
  /** Cached input tokens (Anthropic cache_read+cache_creation, OpenAI cached_tokens). */
  cachedInputTokens?: number;
  /** Cache-write (creation) tokens (Anthropic cache_creation, billed at the higher cache-write rate). */
  cachedWriteInputTokens?: number;
  model?: string;
  /** Pre-computed cost in USD (from provider-bridge, includes cachedInputTokens).
 * When present, callers SHOULD use this instead of recomputing via estimateCost
 * (which may not have cachedInputTokens). */
  costUsd?: number;
}>;

/** Call the navigator LLM API with a structured request. Returns raw text + optional usage. */
type NavigatorLLMCall = LLMCall<import("../types").AgentStepRequest>;

/** Call the planner LLM API with a structured request. Returns raw text + optional usage. */
type PlannerLLMCall = LLMCall<import("../types").PlannerStepRequest>;

/**
 * Optional summarization call used by compaction. Accepts a system + user
 * prompt and optional model hint; returns the summary text + usage. Falls
 * back to {@link LoopDeps.plannerCall} when not provided.
 */
type SummarizeLLMCall = (req: {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
}) => Promise<{ content: string; usage?: TokenUsage }>;

// ─── External dependencies ──────────────────────────────────────────────────

/**
 * External dependencies the orchestrator needs to run a loop.
 */
export interface LoopDeps {
  /** The user's task description. */
  task: string;
  /** Optional config overrides (merged on top of {@link DEFAULT_CONFIG}). */
  config?: Partial<AgentConfig>;
  /** Navigator LLM call (returns raw text + optional token usage). */
  navigatorCall: NavigatorLLMCall;
  /** Planner LLM call (returns raw text + optional token usage). */
  plannerCall: PlannerLLMCall;
  /** Get the currently open tabs (extension: `chrome.tabs.query`; demo: `[current]`). */
  getTabs: () => Promise<TabInfo[]>;
  /** Stream a {@link LogEvent} to the UI / log sink. */
  onEvent: (e: LogEvent) => void;
  /** Optional abort signal (user stop). Honored at step boundaries + inside the action loop. */
  signal?: AbortSignal;
  /** Hook for tab-level actions (switch/close/navigate/search) the content script can't do. */
  onTabAction?: (
    action: AgentAction
  ) => Promise<{ handled: boolean; pageChanged: boolean; success?: boolean; message?: string }>;
  /** Wait for a page load after navigation (extension: `chrome.tabs.onUpdated`). */
  waitForNavigation?: () => Promise<void>;
  /** Wait for the page to settle (network idle + DOM stable). Replaces fixed sleep. */
  waitForSettled?: () => Promise<void>;
  /** Delay between steps (let SPA rerenders settle). Used if `waitForSettled` not provided. */
  settleDelay?: number;
  /** Agent mode: restricted (current tab only), standard (default), full_agentic. */
  mode?: AgentMode;
  /**
 * Optional override for browser-state extraction (extension routes state
 * extraction through a content-script bridge). When absent the orchestrator
 * calls {@link extractBrowserState} directly (in-page demo mode).
 */
  extractState?: (tabs: TabInfo[]) => Promise<BrowserState>;
  /**
 * Optional override for action-queue execution. When absent the orchestrator
 * uses the built-in {@link executeActionQueue}.
 */
  executeActions?: (actions: AgentAction[], state: BrowserState) => Promise<ActionResult[]>;
  /**
 * Optional summarization call used by compaction. When absent the orchestrator
 * routes the summarization request through {@link plannerCall}.
 */
  summarizeCall?: SummarizeLLMCall;
  /**
 * Optional override for the takeover-resume wait.
 */
  requestTakeoverResume?: (reason: string, signal?: AbortSignal) => Promise<void>;
  /**
 * Optional anti-bot challenge detector.
 */
  detectChallenge?: () => Promise<{ kind: string; message: string } | null>;
  /**
 * Optional: wait for an anti-bot challenge to clear on its own.
 */
  waitForChallengeResolution?: () => Promise<boolean>;
  /**
 * Optional pause-check callback.
 */
  checkPaused?: () => Promise<boolean>;
  /**
 * Optional page-HTML extractor for the HTML-content evaluator.
 */
  getPageHtml?: () => Promise<string>;
  /**
 * Optional current-URL fetcher for the URL evaluator.
 */
  getCurrentUrl?: () => Promise<string>;
  /**
 * Optional confirmation gate.
 */
  requestConfirmation?: (action: AgentAction) => Promise<boolean>;
  /**
 * Optional array of {@link AsyncCallbackHandler} instances.
 */
  callbacks?: AsyncCallbackHandler[];
}

// ─── Internal helper types ──────────────────────────────────────────────────

/** Shared args for planner calls (initial + verify + periodic). */
export interface PlannerCallArgs {
  task: string;
  navigatorHistory: HistoryItem[];
  plan: string[] | undefined;
  currentPlanItem: number | undefined;
  url: string;
  tabs: TabInfo[];
  step: number;
  maxSteps: number;
  /** Compacted-memory block from history compaction, forwarded to the planner
   * prompt so completion/replan decisions retain summarized older context. */
  compactedMemory?: string;
  /** Fired after each LLM call with the cost (USD) + optional token counts.
 * The token counts let the caller accumulate `totalTokensIn`/`totalTokensOut`
 * for the `runEnd` callback (without this, token totals were always 0). */
  onCost: (usd: number, tokensIn?: number, tokensOut?: number) => void;
}

// ─── LoopState (threaded through every phase helper) ────────────────────────

/**
 * Mutable state threaded through every phase helper. Bundled into one object
 * so each helper can read + mutate fields (plan, step, currentGoal, …)
 * without a long parameter list. Constructed once at the top of
 * `runAgentLoopInner` and passed by reference.
 */
export interface LoopState {
 // ── Immutable ──
  /** The loop's external dependencies (LLM calls, tabs, sink, signal, …). */
  deps: LoopDeps;
  /** Merged config (DEFAULT_CONFIG + deps.config). */
  config: AgentConfig;
  /** The user's task description. */
  task: string;
  /** The SSE/streaming event sink (kept as the primary sink — callbacks are additive). */
  onEvent: (e: LogEvent) => void;
  /** Optional abort signal (user stop). */
  signal?: AbortSignal;
  /** Delay between steps when `deps.waitForSettled` is absent. */
  settleDelay: number;
 // ── Mutable ──
  /** Accumulated navigator history (one entry per navigator step). */
  navigatorHistory: HistoryItem[];
  /** Loop detector (repetition + A,B,A,B alternation). */
  loopDetector: LoopDetector;
  /** Current plan from the planner. */
  plan: string[] | undefined;
  /** Index of the current plan item. */
  currentPlanItem: number | undefined;
  /** Current step number (0-indexed). */
  step: number;
  /** Navigator steps since the last planner call. */
  navigatorStepsSincePlanner: number;
  /** Consecutive failure count (resets on success). */
  consecutiveFailures: number;
  /** Consecutive parse-failure count (resets on any successful navigator step). */
  consecutiveParseFailures: number;
  /** Total USD cost across all LLM calls. */
  totalCostUsd: number;
  /** Total input tokens consumed (for the `runEnd` callback hook). */
  totalTokensIn: number;
  /** Total output tokens consumed (for the `runEnd` callback hook). */
  totalTokensOut: number;
  /** Last step at which compaction ran (used by `shouldCompact`). */
  lastCompactionStep: number | undefined;
  /** Compacted-memory text (replaces older history items when compaction fires). */
  compactedMemory: string | undefined;
  /** Loop-warning text from the previous step (prepended to the next nav request). */
  pendingLoopWarning: string | undefined;
  /** Track whether the step-budget warning has already fired so it doesn't
 * repeat on every step from 75% to maxSteps-2 (context bloat). */
  budgetWarningFired: boolean;
  /** Track whether the cost-budget warning has already fired. */
  costBudgetWarningFired: boolean;
  /** The current goal handed to the navigator. */
  currentGoal: string;
  /** The actual final result (success + text) when the run is finalized. */
  finalResult?: { success: boolean; text: string };
  /** True once the terminal `done` event + `runEnd` dispatch have been
  * emitted. `finish()` / `finishWithRunEnd` short-circuit on this flag so a
  * run can never emit the terminal event twice (multiple finish call sites
  * can fire in one run — e.g. a cost-capped compaction continues the step,
  * and a later navigator/planner catch would otherwise re-emit). */
  terminalEmitted?: boolean;
  /** The last URL observed by `observeState`. */
  lastObservedUrl?: string;
 // ── Optional callback dispatcher ──
  /** The dispatcher (constructed iff `deps.callbacks` was provided). */
  dispatcher?: CallbackDispatcher;
}

// ─── Phase result types ─────────────────────────────────────────────────────

/** Result of executing a step's action queue. */
export interface ActionQueueResult {
  /** Per-action results (in execution order). */
  results: ActionResult[];
  /** True if the queue was aborted early (page change, failure, or done). */
  aborted: boolean;
}

/** Successful observe-state result. */
interface ObserveStateOk {
  status: "ok";
  state: BrowserState;
  tabs: TabInfo[];
}

/** Failed observe-state result (getTabs or extractState threw). */
interface ObserveStateError {
  status: "error";
  /** Which sub-call failed. */
  phase: "getTabs" | "extractState";
  /** The error message. */
  message: string;
}

/** Result of {@link observeState}. */
export type ObserveStateResult = ObserveStateOk | ObserveStateError;

/** Result of {@link callPlannerAndHandleError}. */
export type CallPlannerResult =
  | { status: "ok"; plannerResult: import("../types").PlannerOutput }
  | { status: "abort" }    // fatal / cancelled / maxFailures — caller should `return`
  | { status: "continue" }; // non-fatal — caller should do its post-error mutation + `continue`

/** Result of {@link handlePlannerDecision}. */
export type HandlePlannerDecisionResult =
  | { status: "finalized" }  // Run is done — caller should `return`
  | { status: "continue"; plannerResult: import("../types").PlannerOutput }; // Planner says continue — caller proceeds

/** Result of {@link handleNavigatorDone}. */
export interface HandleNavigatorDoneResult {
  /** True if the run is finalized (caller should `return`). */
  finalized: boolean;
}

/** Result of {@link runPeriodicPlannerCheck}. */
export interface RunPeriodicPlannerCheckResult {
  /** True if the run is finalized (caller should `return`). */
  finalized: boolean;
}

// ─── Step-info (injection points) ───────────────────────────────────────────

/** Step-info bundle handed to the budget + force-done injection points. */
export interface StepInfo {
  /** Current step number (0-indexed). */
  stepNumber: number;
  /** Maximum number of steps allowed for the run. */
  maxSteps: number;
}
