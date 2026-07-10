/**
 * background/state-store.ts — persisted run-state + keepalive alarm + domain config.
 *
 * Owns the `RunState` shape (persisted to `chrome.storage.session` for MV3
 * resilience), the keepalive alarm (which periodically touches the service
 * worker to keep it alive past the ~30s idle deadline), and the synchronous
 * `__openCoworkDomainConfig` global that the executor reads during action
 * execution.
 */

import type { HistoryItem } from "@/lib/agent/types";
import type { AgentMode } from "@/lib/agent/modes";
import type { UrlPolicyConfig } from "@/lib/agent/security";

// ─── Run state (persisted to chrome.storage.session for MV3 resilience) ─────

export interface RunState {
  task: string;
  maxSteps: number;
  mode: AgentMode;
  startTabId: number;
  currentTabId: number;
  step: number;
  history: HistoryItem[];
  active: boolean;
  abortRequested: boolean;
}

export const RUN_STATE_KEY = "open_cowork_run_state";

/** Merge a partial patch into the persisted run state.
 *
 * Preserves `abortRequested` from the current state if the patch doesn't
 * explicitly set it — a STOP arriving between getRunState and set would
 * otherwise be clobbered (the patch's `abortRequested: false` from the
 * orchestrator's normal flow would overwrite the user's `true`). */
export async function saveRunState(state: Partial<RunState>): Promise<void> {
  const cur = (await getRunState()) ?? ({} as RunState);
  // Don't let a normal-flow patch clobber a concurrent STOP request.
  // If `cur.abortRequested` is true and the patch doesn't set it, preserve true.
  const preserveAbort = cur.abortRequested === true && state.abortRequested === undefined;
  const next: RunState = {
    ...cur,
    ...state,
    ...(preserveAbort ? { abortRequested: true } : {}),
  };
  await chrome.storage.session.set({ [RUN_STATE_KEY]: next });
}

/** Read the persisted run state, or null if no active run. */
export async function getRunState(): Promise<RunState | null> {
  const res = await chrome.storage.session.get(RUN_STATE_KEY);
  return (res[RUN_STATE_KEY] as RunState) || null;
}

/** Remove the persisted run state (called at the end of every run). */
export async function clearRunState(): Promise<void> {
  await chrome.storage.session.remove(RUN_STATE_KEY);
}

// ─── Keepalive alarm (MV3 SW lifecycle workaround) ──────────────────────────

export const KEEPALIVE_ALARM = "open_cowork_keepalive";
export const KEEPALIVE_INTERVAL_MIN = 0.25; // 15s — the minimum MV3 alarm period

/** Start a periodic alarm that touches the service worker to keep it alive. */
export async function startKeepalive(): Promise<void> {
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL_MIN });
}

/** Stop the keepalive alarm. */
export async function stopKeepalive(): Promise<void> {
  await chrome.alarms.clear(KEEPALIVE_ALARM);
}

// ─── Domain config (allow/blocklist) ────────────────────────────────────────

/**
 * Load the domain allow/blocklist from chrome.storage.local and
 * set it on `globalThis.__openCoworkDomainConfig` so the executor's
 * `getDomainConfig()` can read it synchronously during action execution.
 * Returns the loaded config so the caller can also use it directly.
 */
export async function loadAndSetDomainConfig(): Promise<UrlPolicyConfig> {
  try {
    const res = await chrome.storage.local.get(["allowedDomains", "blockedDomains"]);
    const allowedDomains = (res.allowedDomains as string[] | undefined) || [];
    const blockedDomains = (res.blockedDomains as string[] | undefined) || [];
    const config: UrlPolicyConfig = {
      allowedDomains: allowedDomains.length > 0 ? allowedDomains : undefined,
      blockedDomains: blockedDomains.length > 0 ? blockedDomains : undefined,
    };
    (globalThis as { __openCoworkDomainConfig?: UrlPolicyConfig }).__openCoworkDomainConfig = config;
    return config;
  } catch (e) {
    // On storage failure, DO NOT cache an empty config — clear the cached value
    // so `getDomainConfig()` returns {} (no policy = allow all), but log the
    // error so the user knows their allow/blocklist was bypassed. We only cache
    // on success; on failure, the stale cached value (if any) remains, and the
    // error is surfaced. This lets callers distinguish "user has no policy"
    // from "storage broke".
    console.error("[Open Cowork] Failed to load domain config — allow/blocklist may be stale:", e);
    throw e;
  }
}

/** Synchronous read of the domain config (set by {@link loadAndSetDomainConfig}). */
export function getDomainConfig(): UrlPolicyConfig {
  try {
    return (globalThis as { __openCoworkDomainConfig?: UrlPolicyConfig }).__openCoworkDomainConfig ?? {};
  } catch {
    return {};
  }
}

// ─── System keep-awake (chrome.power) ────────────────────────────────────────
//
// Scheduled tasks only fire while Chrome is running. If the laptop
// sleeps (or the display turns off + OS suspends), `chrome.alarms.onAlarm`
// never fires — the scheduled task is silently skipped. To bridge this gap,
// `requestKeepAwake()` calls `chrome.power.requestKeepAwake("system")` whenever
// at least one enabled scheduled task exists, and `releaseKeepAwake()` calls
// `chrome.power.releaseKeepAwake()` when an in-flight run completes.
//
// This cannot wake a CLOSED laptop — Chrome itself must be running for the
// service worker to receive the alarm. The "system" level prevents the OS
// from sleeping while Chrome is open; "display" would also keep the screen
// lit (overly aggressive for unattended runs).

/**
 * R9-A: Request the OS to keep the system awake IF at least one enabled
 * scheduled task is currently armed. Idempotent — repeated calls don't stack
 * (Chrome coalesces multiple `requestKeepAwake` calls into a single lock).
 * Safe to call outside the extension context (`chrome.power` missing → silent
 * no-op).
 *
 * The scheduled-tasks check is what makes this safe to call from contexts
 * where the caller doesn't know whether tasks are armed (e.g. service-worker
 * startup). Callers that JUST armed an alarm will redundantly re-confirm the
 * check — that's harmless.
 *
 * Uses a dynamic import of `@/lib/agent/scheduled-tasks` to avoid a circular
 * dependency (scheduled-tasks.ts statically imports this module's
 * `releaseKeepAwake`).
 */
export async function requestKeepAwake(): Promise<void> {
  try {
    const { listScheduledTasks } = await import("@/lib/agent/scheduled-tasks");
    const tasks = await listScheduledTasks();
    if (!tasks.some((t) => t.enabled)) return; // no pending scheduled tasks
    chrome.power.requestKeepAwake("system");
  } catch {
    /* `chrome.power` unavailable (no `power` permission) or non-extension
     * context — non-fatal, scheduled-task reliability degrades gracefully. */
  }
}

/**
 * R9-A: Release the system keep-awake lock unconditionally. The caller is
 * responsible for deciding whether releasing is appropriate — if other
 * scheduled tasks remain armed, the caller should check `listScheduledTasks`
 * first and skip the release (so the OS stays awake pending the next alarm).
 *
 * Called from:
 *   - `scheduled-tasks.ts` disable path + `options/scheduled-tasks.ts` delete
 *     path (after an inline `listScheduledTasks` check confirms no other
 *     enabled tasks remain)
 *
 * NOTE: `agent-bridge.ts`'s `finally` block uses {@link maybeReleaseKeepAwake}
 * (conditional) instead of this unconditional release — releasing after every
 * run would drop the lock between scheduled-task fires, allowing the system to
 * sleep through the next alarm. Use this function ONLY when the caller has
 * already confirmed no other enabled tasks remain.
 */
export function releaseKeepAwake(): void {
  try {
    chrome.power.releaseKeepAwake();
  } catch {
    /* `chrome.power` unavailable or non-extension context — non-fatal. */
  }
}

/**
 * R9-B: Release the system keep-awake lock IF AND ONLY IF no enabled
 * scheduled tasks remain armed. Used by `agent-bridge.ts`'s `finally` block
 * after a run completes — covers both "user clicked Stop after a manual run"
 * (no scheduled tasks → release) and "scheduled run finished naturally"
 * (other tasks still armed → keep the lock so the system doesn't sleep
 * through the next alarm).
 *
 * Without this conditional check, the unconditional `releaseKeepAwake()` in
 * the `finally` block would release the lock after every scheduled-task run,
 * defeating the purpose of `requestKeepAwake("system")` — the system could
 * sleep between fires and miss subsequent alarms entirely (alarms only fire
 * while Chrome is running, and Chrome can't run if the OS is asleep).
 *
 * Uses a dynamic import of `@/lib/agent/scheduled-tasks` to avoid a circular
 * dependency (scheduled-tasks.ts statically imports this module).
 */
export async function maybeReleaseKeepAwake(): Promise<void> {
  try {
    const { listScheduledTasks } = await import("@/lib/agent/scheduled-tasks");
    const tasks = await listScheduledTasks();
    if (tasks.some((t) => t.enabled)) return; // other scheduled tasks still pending
    chrome.power.releaseKeepAwake();
  } catch {
    /* `chrome.power` unavailable or storage read failed — non-fatal. */
  }
}
