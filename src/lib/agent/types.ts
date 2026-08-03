/**
 * Core type definitions for the agentic browser engine.
 *
 * Framework-agnostic — consumed by the Next.js API routes, the in-page demo,
 * and bundled into the Chrome extension via esbuild.
 */

import type { Action } from "./tools/schema";

// ─── Browser state ──────────────────────────────────────────────────────────

/** A single open browser tab. */
export interface TabInfo {
  /** Stable full numeric id (extension: chrome.tabs.id; in-page demo: -1). */
  id: number;
  /** Short label shown to the LLM (last 4 digits, collision-checked). */
  label: string;
  /** Full URL of the tab. */
  url: string;
  /** Document title of the tab. */
  title: string;
  /** Whether this tab is currently active. */
  active: boolean;
}

/** Bounding-box rectangle in CSS pixels. */
interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One interactive element extracted from the page. */
export interface ExtractedElement {
  /** 1-based index the LLM uses to reference this element. */
  index: number;
  /** Lowercased HTML tag name. */
  tag: string;
  /** Accessible name or text snippet. */
  text: string;
  /** Selected attributes (id, name, href, type, placeholder, role, aria-label). */
  attributes: Record<string, string>;
  /** Stable hash of the element's branch-path + attrs (for `isNew` tracking). */
  hash: string;
  /** On-screen bounding box. */
  rect: ElementRect;
}

/** Serialized page state handed to the LLM each step. */
export interface BrowserState {
  /** Current URL of the active tab. */
  url: string;
  /** Current document title. */
  title: string;
  /** All open tabs. */
  tabs: TabInfo[];
  /** Interactive elements extracted for this step. */
  elements: ExtractedElement[];
  /** The `[index]<tag attrs />` tree text the LLM reads. */
  elementsText: string;
  /** "0.0 pages above, 2.3 pages below" scroll info. */
  pageInfo: string;
  /** Count of new elements since last step (marked with `*` in elementsText). */
  newElementCount: number;
  /** Current vertical scroll offset in pixels. */
  scrollTop: number;
  /** Total scrollable height in pixels. */
  scrollHeight: number;
  /** Visible viewport height in pixels. */
  viewportHeight: number;
  /** Map of index -> opaque element handle (HTMLElement in content script). */
  selectorMap: Record<number, unknown>;
  /** Optional screenshot (base64 data URL) for vision-capable models. */
  screenshot?: string;
  /** Optional AX tree (semantic accessibility tree) for vision/semantic models. */
  axTree?: string;
  /** Device pixel ratio of the tab (for screenshot/vision coordinate scaling).
 * Sent by content.ts; typed here so call sites don't need `as unknown as`
 * casts. */
  devicePixelRatio?: number;
  /** Element bounding rects (for Set-of-Marks screenshot annotation).
 * Each entry has an element index + a nested `rect` with CSS-pixel coords.
 * Sent by content.ts; used by the screenshot annotator (scaled by devicePixelRatio). */
  elementRects?: Array<{ index: number; rect: ElementRect }>;
}

// ─── Agent output ───────────────────────────────────────────────────────────

/** The structured output the navigator LLM must return each step. */
export interface AgentOutput {
  /** Step-by-step reasoning about the current state and what to do next. */
  thinking: string;
  /** One sentence: did the last action succeed, fail, or is uncertain. */
  evaluation_previous_goal: string;
  /** 1-3 sentences tracking progress (what's done, what's next, counts). */
  memory: string;
  /** One clear sentence stating the immediate goal of this step. */
  next_goal: string;
  /** 1-10 actions to execute sequentially. */
  action: AgentAction[];
}

/** The planner's output — either continue, finish, or answer directly. */
export interface PlannerOutput {
  /** Reasoning about overall progress toward the user's task. */
  thinking: string;
  /** "continue" | "done" | "web_task" (answer without browser). */
  decision: "continue" | "done" | "web_task";
  /** When decision="done", whether the task succeeded. */
  success?: boolean;
  /** When decision="done" or "web_task", the final text for the user. */
  text?: string;
  /** When decision="continue", the updated plan (replaces the old one). */
  plan?: string[];
  /** Index of the current plan item. */
  current_plan_item?: number;
  /** When decision="continue", the next goal to hand to the navigator. */
  next_goal?: string;
}

// ─── Action union ───────────────────────────────────────────────────────────
//
// `AgentAction` is now an ALIAS of the Zod-inferred `Action` type from
// `./tools/schema` (imported at the top of this file). The Zod schema is the
// SINGLE source of truth for the action set — adding a new action (or changing
// a field) to the schema automatically updates `AgentAction` everywhere.
//
// because Zod `.default()` makes a field REQUIRED in the inferred
// *output* type, fields like `clear`, `pages`, `down`, `seconds`, `new_tab`,
// `engine`, `regex`, `case_sensitive`, and `max_results` are REQUIRED on
// constructed `AgentAction` literals (even though the LLM may omit them and
// the parser will fill in the default). Construction sites that build
// `AgentAction` literals must therefore spell out every defaulted field.
//
// `tests/schema-sync.test.ts` enforces that `ACTION_METADATA` (the third
// parallel definition, used to render the system prompt) stays in sync with
// the Zod schema's action set.

/** Discriminated union of every action the navigator can emit.
 *
 * Derived from `ActionSchema` in `./tools/schema` — the Zod schema is the
 * single source of truth. See the file-level comment above for caveats about
 * `.default()` fields being required on constructed literals. */
export type AgentAction = Action;

// ─── Execution results ──────────────────────────────────────────────────────

/** The result of executing one AgentAction. */
export interface ActionResult {
  /** The action that was executed. */
  action: AgentAction;
  /** Whether the action succeeded. */
  success: boolean;
  /** Human-readable status / error message. */
  message: string;
  /** Optional extracted text (for `extract`, `search_page`, `find_elements`). */
  extractedContent?: string;
  /** Whether the action likely changed the page (URL or DOM fingerprint). */
  pageChanged?: boolean;
  /** Optional structured payload (tab listings, cookies, storage reads). */
  data?: unknown;
  /** Set true ONLY for the `done` action. */
  isDone?: boolean;
}

// ─── History ────────────────────────────────────────────────────────────────

/** One entry in the agent's step history. */
export interface HistoryItem {
  /** Step number (0-indexed). */
  step: number;
  /** Which agent produced this step. */
  agent: "planner" | "navigator";
  /** Evaluation of the previous goal (one sentence). */
  evaluation: string;
  /** Memory snippet (what's done, what's next). */
  memory: string;
  /** The goal that was being pursued this step. */
  goal: string;
  /** Results of every action executed this step. */
  results: ActionResult[];
}

// ─── Loop events (streamed to the UI) ───────────────────────────────────────

/** Tagged union of all events the agent loop emits to the UI. */
export type LogEvent =
  | { type: "run-start"; task: string; maxSteps: number }
  | { type: "planner-step"; step: number; decision: "continue" | "done" | "web_task"; goal?: string; plan?: string[] }
  | { type: "navigator-step-start"; step: number }
  | { type: "state"; step: number; url: string; elementCount: number; newElementCount: number; pageInfo: string }
  | { type: "thinking"; step: number; text: string; evaluation: string; memory: string; nextGoal: string }
  | { type: "action"; step: number; index: number; total: number; name: string; description: string }
  | { type: "action-result"; step: number; name: string; success: boolean; message: string }
  | { type: "budget-warning"; step: number; pct: number }
  | { type: "loop-warning"; step: number; count: number }
  | { type: "compaction"; step: number; compactedCount: number }
  | { type: "challenge_detected"; step: number; kind: string; message: string }
  | { type: "takeover"; step: number; reason: string }
  | { type: "paused"; step: number }
  | { type: "resumed"; step: number }
  | { type: "done"; step: number; success: boolean; text: string }
  | { type: "error"; step: number; message: string; recoverable: boolean; code?: string; recovery?: string }
  | { type: "info"; message: string }
  | { type: "warn"; step?: number; message: string }
  | { type: "cost"; step: number; tokensIn: number; tokensOut: number; costUsd: number; model: string; reasoningTokens?: number; cachedInputTokens?: number; cachedWriteInputTokens?: number }
  | { type: "heartbeat"; step: number; ts: number };

// ─── API contracts ──────────────────────────────────────────────────────────

/** Browser state subset that crosses the wire to the LLM API. */
interface WireBrowserState {
  url: string;
  title: string;
  tabs: TabInfo[];
  elementsText: string;
  pageInfo: string;
  newElementCount: number;
  /** Optional screenshot (base64 data URL) for vision-capable models. */
  screenshot?: string;
  /** Optional AX-tree (semantic accessibility tree). */
  axTree?: string;
}

/** Request body for the navigator step API. */
export interface AgentStepRequest {
  /** Original user task. */
  task: string;
  /** Accumulated history. */
  history: HistoryItem[];
  /** Current browser state. */
  browserState: WireBrowserState;
  /** The current goal from the planner (drives this navigator step). */
  currentGoal?: string;
  /** Current step plan from the planner. */
  plan?: string[];
  /** Index of the current plan item. */
  currentPlanItem?: number;
  /** Current step number. */
  step: number;
  /** Max steps allowed for the whole run. */
  maxSteps: number;
  /** Provider id override (e.g. "ollama", "openai-compat:gpt-4o"). */
  provider?: string;
  /** Loop-warning text from the previous step's loop detector (prepended to
 * the next nav request so the navigator sees the repetition nudge). */
  loopWarning?: string;
  /** Compacted-memory block from history compaction (replaces older history
 * items with a summarized block when the threshold fires). */
  compactedMemory?: string;
}

/** LLM token usage for a single API call. */
export interface TokenUsage {
  tokensIn: number;
  tokensOut: number;
  model: string;
  /** Reasoning/thinking tokens (billed separately for reasoning models). */
  reasoningTokens?: number;
  /** Cached input tokens (Anthropic cache_read+cache_creation, OpenAI cached_tokens).
 * Surfaced so cost-cap enforcement accounts for prompt-cache discounts. */
  cachedInputTokens?: number;
  /** Cache-write (creation) tokens (Anthropic cache_creation, billed at the higher cache-write rate). */
  cachedWriteInputTokens?: number;
  /** Pre-computed cost in USD (from provider-bridge). When present, callers
 * SHOULD use this instead of recomputing via estimateCost. */
  costUsd?: number;
}

/** Request body for the planner step API. */
export interface PlannerStepRequest {
  /** Original user task. */
  task: string;
  /** Accumulated history. */
  history: HistoryItem[];
  /** Current plan (if any). */
  plan?: string[];
  /** Index of the current plan item. */
  currentPlanItem?: number;
  /** Current step number. */
  step: number;
  /** Max steps allowed for the whole run. */
  maxSteps: number;
  /** Provider id override. */
  provider?: string;
  /** Current URL (planner is lightweight — no full DOM). */
  url: string;
  /** Open tabs. */
  tabs: TabInfo[];
  /** Compacted-memory block from history compaction, so the planner retains
   * summarized older context after compaction (mirrors the navigator path). */
  compactedMemory?: string;
}

// ─── Configuration ──────────────────────────────────────────────────────────

/** Tunable knobs for the agent loop. */
export interface AgentConfig {
  /** Hard step cap before forced stop. */
  maxSteps: number;
  /** Max actions the navigator can emit per step. */
  maxActionsPerStep: number;
  /** Run the planner every N navigator steps. */
  plannerInterval: number;
  /** Max consecutive failures before giving up. */
  maxFailures: number;
  /** Whether to enable loop detection. */
  enableLoopDetection: boolean;
  /** Whether to enable history compaction. */
  enableCompaction: boolean;
  /** Run compaction every N steps once threshold is met. */
  compactionStepInterval: number;
  /** Minimum history character length before compaction triggers. */
  compactionCharThreshold: number;
  /** Optional USD cost cap — aborts the run if exceeded. */
  costCapUsd?: number;
  /**
   * Per-call SLA (milliseconds) for cloud LLM / compaction calls. When > 0, a
   * still-pending provider call that exceeds this bound is aborted with a
   * TimeoutError so a hung endpoint (one that accepts the request but never
   * responds) cannot stall the run indefinitely. `0` disables the SLA.
   */
  llmCallTimeoutMs?: number;
  /** Whether to run the judge LLM after the planner reports task success.
 * Default true. When true, the judge double-checks the agent's self-reported
 * success against the action history; if it disagrees, the loop continues. */
  enableJudge: boolean;
  /**
 * Whether to enable early-stop detection. When true, the orchestrator
 * calls {@link earlyStop} after each step and stops the run if the agent
 * is clearly stuck (N consecutive parse failures OR N consecutive
 * equivalent actions). Default `true` (matches `DEFAULT_CONFIG.enableEarlyStop`)
 * — early-stop detection is on unless explicitly disabled.
 */
  enableEarlyStop?: boolean;
  /**
 * Optional thresholds for the early-stop detector. When omitted, the
 * defaults (`parsingFailure: 5`, `repeatingAction: 3`) are used.
 */
  earlyStopThresholds?: { parsingFailure: number; repeatingAction: number };
  /**
 * Whether to run the HTML-summarizer pre-pass before each navigator
 * call. When true, the orchestrator filters the page DOM down to
 * task-relevant elements before sending it to the navigator — this can
 * reduce prompt size 10× on dense pages (forms, tables, dashboards).
 * Default `true` (see `DEFAULT_CONFIG` — the summarizer is the single
 * biggest per-action prompt-size lever).
 */
  enableHtmlSummarizer?: boolean;
  /**
 * Optional expected-outcomes spec. When set, the orchestrator + judge
 * run the deterministic evaluators (string / URL / HTML-content) as a
 * fast-path before the LLM judge. If every evaluator passes, the run is
 * finalized as success without spending tokens on the LLM judge. If any
 * evaluator fails, the LLM judge still runs (the evaluators are a
 * fast-PASS path, not a fast-FAIL path — a single failed evaluator
 * doesn't override the agent's self-reported success, since the
 * evaluator config may be stale or overly strict).
 */
  expectedOutcomes?: ExpectedOutcomes;
}

/**
 * Expected-outcomes spec — the deterministic evaluator inputs. Each field
 * is optional; the orchestrator only runs the evaluators whose input is
 * present. When `expectedOutcomes` is undefined on AgentConfig, no
 * evaluators run (the LLM judge is the only verification path).
 */
interface ExpectedOutcomes {
  /** Optional string-match inputs (the agent's final answer is the prediction). */
  string?: Array<{ type: "exact_match" | "must_include" | "regex"; ref: string }>;
  /** Optional URL-match input (the agent's final page URL is the prediction). */
  url?: { referenceUrl: string; matchingRule?: "GOLD in PRED" };
  /** Optional HTML-content inputs (the agent's final page HTML is the prediction). */
  html?: Array<{
    locator?: string;
    required_contents: { exact_match?: string; must_include?: string[] };
  }>;
}

export { DEFAULT_CONFIG } from "./types-utils";
