/**
 * background/state-store-utils.ts — extracted helpers from state-store.
 *
 * Run-state CRUD (persisted to chrome.storage.session), the log-redaction
 * helper, and the system keep-awake lifecycle.  state-store.ts re-exports
 * these so existing consumers don't need import path changes.
 */

import type { AgentMode } from "@/lib/agent/modes";
import { listScheduledTasks } from "@/lib/agent/scheduled-tasks";
import { redactSecrets } from "@/lib/agent/secrets";

// ─── Safe log (redacts secrets before console output) ───────────────────────

export async function safeLog(
  level: "error" | "warn",
  msg: string,
  err?: unknown,
): Promise<void> {
  const raw = err == null ? msg : `${msg} ${err instanceof Error && err.stack ? err.stack : String(err)}`;
  try {
    const redacted = await redactSecrets(raw);
    console[level](redacted);
  } catch {
    console[level]("[redacted log suppressed]");
  }
}

// ─── Run state (persisted to chrome.storage.session for MV3 resilience) ─────

/** Aggregated token/cost totals for a run. */
export interface UsageTotals {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** Reasoning/thinking tokens (Gemini also counts them inside tokensOut). */
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cachedWriteInputTokens?: number;
}

/** Accumulated usage attached to a run, keyed by the last-reported model. */
export interface RunUsage extends UsageTotals {
  model: string;
}

/** Shape of a `cost` LogEvent that feeds the run-usage accumulator. */
export interface CostEventLike {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  model: string;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cachedWriteInputTokens?: number;
}

export function zeroRunUsage(): RunUsage {
  return { tokensIn: 0, tokensOut: 0, costUsd: 0, model: "" };
}

/**
 * Merge one cost event into the run's accumulated usage (immutable). Rich
 * fields are summed when either side carries them; the latest model wins.
 */
export function addCostEvent(usage: RunUsage, event: CostEventLike): RunUsage {
  const reasoning = (usage.reasoningTokens ?? 0) + (event.reasoningTokens ?? 0);
  const cachedInput = (usage.cachedInputTokens ?? 0) + (event.cachedInputTokens ?? 0);
  const cachedWrite = (usage.cachedWriteInputTokens ?? 0) + (event.cachedWriteInputTokens ?? 0);
  return {
    tokensIn: usage.tokensIn + event.tokensIn,
    tokensOut: usage.tokensOut + event.tokensOut,
    costUsd: usage.costUsd + event.costUsd,
    model: event.model,
    ...(usage.reasoningTokens || event.reasoningTokens ? { reasoningTokens: reasoning } : {}),
    ...(usage.cachedInputTokens || event.cachedInputTokens ? { cachedInputTokens: cachedInput } : {}),
    ...(usage.cachedWriteInputTokens || event.cachedWriteInputTokens ? { cachedWriteInputTokens: cachedWrite } : {}),
  };
}

export interface RunState {
  task: string;
  maxSteps: number;
  mode: AgentMode;
  startTabId: number;
  currentTabId: number;
  step: number;
  active: boolean;
  abortRequested: boolean;
  /** Accumulated usage for the current run (see addCostEvent). */
  usage?: RunUsage;
}

export const RUN_STATE_KEY = "open_cowork_run_state";

let cachedRunState: RunState | null | undefined;

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, _area) => {
    if (RUN_STATE_KEY in changes) cachedRunState = undefined;
  });
}

let writeChain: Promise<unknown> = Promise.resolve();

function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task);
  writeChain = run.catch(() => {});
  return run;
}

export async function saveRunState(state: Partial<RunState>): Promise<void> {
  return enqueueWrite(async () => {
    cachedRunState = undefined;
    const cur = (await getRunState()) ?? {};
    const next = { ...cur, ...state } as RunState;
    next.abortRequested = Boolean((cur as RunState).abortRequested) || Boolean(state.abortRequested);
    try {
      await chrome.storage.session.set({ [RUN_STATE_KEY]: next });
    } catch (e) {
      // A failed write must not leave the cache holding state storage never
      // received: the abort listener (and every other consumer) reads via
      // `getRunState`, so a divergent cache would skip the STOP signal.
      cachedRunState = undefined;
      throw e;
    }
    cachedRunState = next;
  });
}

export async function getRunState(): Promise<RunState | null> {
  if (cachedRunState !== undefined) return cachedRunState;
  const res = await chrome.storage.session.get(RUN_STATE_KEY);
  const raw = res[RUN_STATE_KEY];
  const state = (raw && typeof raw === "object" && "active" in raw && "task" in raw) ? raw as RunState : null;
  cachedRunState = state;
  return state;
}

export async function clearRunState(): Promise<void> {
  return enqueueWrite(async () => {
    cachedRunState = undefined;
    await chrome.storage.session.remove(RUN_STATE_KEY);
  });
}

// ─── System keep-awake (chrome.power) ────────────────────────────────────────

export async function requestKeepAwake(): Promise<void> {
  try {
    const tasks = await listScheduledTasks();
    if (!tasks.some((t) => t.enabled)) return;
    void chrome.power.requestKeepAwake("system");
  } catch {
    /* `chrome.power` unavailable (no `power` permission) or non-extension
     * context — non-fatal, scheduled-task reliability degrades gracefully. */
  }
}

export async function maybeReleaseKeepAwake(): Promise<void> {
  try {
    const tasks = await listScheduledTasks();
    if (tasks.some((t) => t.enabled)) return;
    void chrome.power.releaseKeepAwake();
  } catch {
    /* `chrome.power` unavailable or storage read failed — non-fatal. */
  }
}
