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
import { redactKeyLeak } from "@/lib/agent/redact-shared";

// ─── Safe log (redacts secrets before console output) ───────────────────────

export async function safeLog(
  level: "error" | "warn",
  msg: string,
  err?: unknown,
): Promise<void> {
  const raw = err == null ? msg : `${msg} ${err instanceof Error && err.stack ? err.stack : String(err)}`;
  try {
    const redacted = redactKeyLeak(await redactSecrets(raw));
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
  /** Per-call usage from the most recent LLM request. Unlike the accumulated
   * totals above, these fields can be compared with a context window. */
  lastTokensIn?: number;
  lastTokensOut?: number;
  lastReasoningTokens?: number;
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
    lastTokensIn: event.tokensIn,
    lastTokensOut: event.tokensOut,
    ...(event.reasoningTokens !== undefined ? { lastReasoningTokens: event.reasoningTokens } : {}),
    ...(usage.reasoningTokens || event.reasoningTokens ? { reasoningTokens: reasoning } : {}),
    ...(usage.cachedInputTokens || event.cachedInputTokens ? { cachedInputTokens: cachedInput } : {}),
    ...(usage.cachedWriteInputTokens || event.cachedWriteInputTokens ? { cachedWriteInputTokens: cachedWrite } : {}),
  };
}

export interface RunState {
  /** Additive persisted contract version; absent is accepted only by the legacy reader. */
  version?: 1;
  /** Identity of the background authority that created this record (V1 additive). */
  runId?: string;
  /** Dispatch generation persisted with runId for restart cancellation. */
  dispatchRevision?: number;
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

const RUN_STATE_MODES: ReadonlySet<string> = new Set(["restricted", "standard", "full_agentic"]);

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRunUsage(value: unknown): value is RunUsage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  return (
    isFiniteNumber(usage.tokensIn) &&
    isFiniteNumber(usage.tokensOut) &&
    isFiniteNumber(usage.costUsd) &&
    typeof usage.model === "string" &&
    (usage.reasoningTokens === undefined || isFiniteNumber(usage.reasoningTokens)) &&
    (usage.cachedInputTokens === undefined || isFiniteNumber(usage.cachedInputTokens)) &&
    (usage.cachedWriteInputTokens === undefined || isFiniteNumber(usage.cachedWriteInputTokens))
    && (usage.lastTokensIn === undefined || isFiniteNumber(usage.lastTokensIn))
    && (usage.lastTokensOut === undefined || isFiniteNumber(usage.lastTokensOut))
    && (usage.lastReasoningTokens === undefined || isFiniteNumber(usage.lastReasoningTokens))
  );
}

/** Decode legacy unversioned state or V1 into one canonical V1 value. */
function decodeRunState(value: unknown): RunState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Record<string, unknown>;
  if (state.version !== undefined && state.version !== 1) return null;
  if (
    typeof state.task !== "string" ||
    !Number.isSafeInteger(state.maxSteps) || (state.maxSteps as number) < 1 ||
    typeof state.mode !== "string" || !RUN_STATE_MODES.has(state.mode) ||
    !isNonNegativeInteger(state.startTabId) ||
    !isNonNegativeInteger(state.currentTabId) ||
    !isNonNegativeInteger(state.step) ||
    typeof state.active !== "boolean" ||
    typeof state.abortRequested !== "boolean" ||
    (state.runId !== undefined && (typeof state.runId !== "string" || state.runId.length === 0)) ||
    (state.dispatchRevision !== undefined && !isNonNegativeInteger(state.dispatchRevision)) ||
    (state.usage !== undefined && !isRunUsage(state.usage))
  ) return null;
  return { ...(state as unknown as RunState), version: 1 };
}

function abortLatchState(): RunState {
  return {
    version: 1,
    task: "",
    maxSteps: 1,
    mode: "standard",
    startTabId: 0,
    currentTabId: 0,
    step: 0,
    active: false,
    abortRequested: true,
  };
}

function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task);
  writeChain = run.catch(() => {});
  return run;
}

async function persistDecodedRunState(next: RunState): Promise<void> {
  try {
    await chrome.storage.session.set({ [RUN_STATE_KEY]: next });
  } catch (e) {
    cachedRunState = undefined;
    throw e;
  }
  cachedRunState = next;
}

export async function saveRunState(state: Partial<RunState>): Promise<void> {
  return enqueueWrite(async () => {
    if (state.version !== undefined && state.version !== 1) {
      throw new Error("unsupported run-state version");
    }
    cachedRunState = undefined;
    const cur = await getRunState();
    const base = cur ?? (state.abortRequested === true ? abortLatchState() : {});
    const candidate = {
      ...base,
      ...state,
      version: 1,
      abortRequested: Boolean(cur?.abortRequested) || Boolean(state.abortRequested),
    };
    const next = decodeRunState(candidate);
    if (!next) throw new Error("invalid run-state update");
    await persistDecodedRunState(next);
  });
}

/** Atomically patch only the persisted state owned by `runId`. */
export async function saveRunStateForRun(
  runId: string,
  state: Omit<Partial<RunState>, "runId" | "version">,
): Promise<void> {
  return enqueueWrite(async () => {
    cachedRunState = undefined;
    const cur = await getRunState();
    if (!cur?.runId || cur.runId !== runId) {
      throw new Error("run-state authority mismatch");
    }
    const next = decodeRunState({
      ...cur,
      ...state,
      version: 1,
      runId,
      abortRequested: cur.abortRequested || Boolean(state.abortRequested),
    });
    if (!next) throw new Error("invalid run-state update");
    await persistDecodedRunState(next);
  });
}

/** Install one new run without inheriting predecessor fields other than STOP. */
export async function initializeRunStateForRun(state: RunState & { runId: string }): Promise<void> {
  return enqueueWrite(async () => {
    cachedRunState = undefined;
    const cur = await getRunState();
    if (cur?.runId && cur.runId !== state.runId) {
      throw new Error("run-state authority mismatch");
    }
    if (cur?.active && cur.runId !== state.runId) {
      throw new Error("active legacy run-state cannot authorize a new run");
    }
    const next = decodeRunState({
      ...state,
      version: 1,
      abortRequested: Boolean(cur?.abortRequested) || state.abortRequested,
    });
    if (!next) throw new Error("invalid run-state initialization");
    await persistDecodedRunState(next);
  });
}

export async function getRunState(): Promise<RunState | null> {
  if (cachedRunState !== undefined) return cachedRunState;
  const res = await chrome.storage.session.get(RUN_STATE_KEY);
  const raw = res[RUN_STATE_KEY];
  const state = decodeRunState(raw);
  cachedRunState = state;
  return state;
}

export async function clearRunState(): Promise<void> {
  return enqueueWrite(async () => {
    cachedRunState = undefined;
    await chrome.storage.session.remove(RUN_STATE_KEY);
  });
}

/** Clear only the named run; a predecessor cleanup cannot erase a successor. */
export async function clearRunStateForRun(runId: string): Promise<void> {
  return enqueueWrite(async () => {
    cachedRunState = undefined;
    const cur = await getRunState();
    if (cur === null) return;
    if (!cur.runId || cur.runId !== runId) {
      throw new Error("run-state authority mismatch");
    }
    await chrome.storage.session.remove(RUN_STATE_KEY);
    cachedRunState = null;
  });
}

export function resetRunStateStoreForTests(): void {
  cachedRunState = undefined;
  writeChain = Promise.resolve();
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
