/**
 * background/agent-bridge.ts — wires the Chrome-specific runtime bindings into
 * the shared orchestrator (`runAgentLoop`).
 *
 * `startRun()` is the single entry point invoked by the message-routing
 * module's RUN handler (and by the task-queue module when a scheduled task
 * fires). It persists run state, starts the keepalive alarm, builds the
 * `LoopDeps` config (extractState / executeActions / navigatorCall / …), and
 * cleans up state in `finally`.
 *
 * Also owns the `runStarting` synchronous guard flag — set by the RUN handler
 * before the first `await`, cleared in `startRun`'s `finally`.
 *
 * The heavy helpers (`extractStateForRun`, `wireAbortController`,
 * `buildLoopDeps`, `cleanupRun`, vision-assistant singleton) live in
 * `./run-helpers` so this file stays a thin orchestrator.
 */

import { runAgentLoop } from "@/lib/agent/loop/orchestrator";
import type { LogEvent } from "@/lib/agent/types";
import type { AgentMode } from "@/lib/agent/modes";
import { RunBuilder } from "@/lib/agent/run-history";
import {
  saveRunState,
  getRunState,
  clearRunState,
  loadAndSetDomainConfig,
  type RunState,
} from "./state-store";
import {
  buildLoopDeps,
  cleanupRun,
  initRunState,
  resetVisionInitFlagForNewRun,
  clearVisionElementsCacheForNewRun,
  teardownScheduledVision,
  wireAbortController,
  getVisionElementRect,
} from "./run-helpers";

// Re-export so existing importers (message-routing.ts dynamic import) keep
// resolving. The implementation lives in run-helpers.ts.
export { getVisionElementRect };

export const DEFAULT_MAX_STEPS = 100;
const DEFAULT_MAX_ACTIONS = 10;
const DEFAULT_PLANNER_INTERVAL = 5;
const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_COST_CAP = 0;
export const DEFAULT_MODE: AgentMode = "standard";

// Synchronous in-memory guard flag set BEFORE the first `await` in the RUN
// handler. Closes the TOCTOU window where two near-simultaneous RUN messages
// both pass the `existing?.active` check before either writes `active: true`
// to session storage, starting two concurrent loops.
let runStarting = false;

/** Read the synchronous RUN-guard flag (used by the RUN message handler). */
export function isRunStarting(): boolean {
  return runStarting;
}

/** Set the synchronous RUN-guard flag (used by the RUN message handler). */
export function setRunStarting(v: boolean): void {
  runStarting = v;
}

interface StartRunArgs {
  task: string;
  maxSteps: number;
  mode: AgentMode;
  /** True when called from a scheduled-task alarm fire (not a manual user run). */
  isScheduledTaskRun?: boolean;
}

/**
 * Start a full agent run. Persists run state, starts the keepalive alarm,
 * then invokes the orchestrator with Chrome-specific bindings for tab
 * management and navigation waiting. Cleans up state in `finally`.
 *
 * The run-lifecycle helpers (extractStateForRun, wireAbortController,
 * buildLoopDeps, cleanupRun) live in `./run-helpers` so this function is a
 * thin orchestrator — ~80 lines of setup + delegation.
 */
export async function startRun({ task, maxSteps, mode, isScheduledTaskRun = false }: StartRunArgs): Promise<void> {
  // Run-history persistence: a RunBuilder accumulates every LogEvent the
  // orchestrator emits. On run end, saveRun() persists the record to
  // chrome.storage.local so the Options → History tab can replay it.
  const runBuilder = new RunBuilder(task);
  // Track the actual run outcome as `done` events flow through sendEvent.
  // The History tab reads `r.result.success` to render the ✓/✗ badge, so
  // the finally block needs the real value rather than a hardcoded default.
  // RunBuilder also captures `done` events internally as a belt-and-suspenders
  // path; this flag is the explicit, single source of truth passed to finish().
  let runSucceeded = false;

  /** Stream a {@link LogEvent} to the side panel + persist step count.
   * Declared at the top of the function so the early `tab.id` check below can
   * call it before `runState` is constructed. */
  const sendEvent = (event: LogEvent): void => {
    chrome.runtime
      .sendMessage({
        type: "AGENT_EVENT",
        event,
        time: new Date().toLocaleTimeString("en-GB", { hour12: false }),
      })
      .catch(() => {
        /* side panel may not be open — non-fatal */
      });
    // Feed every event into the RunBuilder so the persisted run record has
    // the full transcript for replay in the Options → History tab.
    runBuilder.addEvent(event);
    // Capture the orchestrator's terminal verdict. Only a `done` event with
    // `success: true` flips the flag — every other terminal `done` (abort,
    // failure, max-steps, cost-cap, judge-rejection, …) leaves it false.
    if (event.type === "done" && event.success) {
      runSucceeded = true;
    }
    if (event.type === "navigator-step-start") {
      saveRunState({ step: event.step }).catch(() => {
        /* best-effort persistence */
      });
    }
  };

  const releaseRunGuard = (): void => {
    runStarting = false;
  };

  let tab: chrome.tabs.Tab | undefined;
  try {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch (e) {
    sendEvent({ type: "error", step: 0, message: `Tab query failed: ${e instanceof Error ? e.message : String(e)}`, recoverable: false });
    releaseRunGuard();
    return;
  }
  if (!tab?.id) {
    sendEvent({ type: "error", step: 0, message: "No active tab", recoverable: false });
    releaseRunGuard();
    return;
  }

  // Read user-overridable run-time settings from local storage. Falls back to
  // defaults if not set or unreadable.
  let stored: Record<string, unknown>;
  try {
    stored = await chrome.storage.local.get([
      "maxActions", "plannerInterval", "maxFailures", "costCap", "maxSteps",
      "allowedDomains", "blockedDomains",
    ]);
  } catch (e) {
    sendEvent({ type: "error", step: 0, message: `Settings load failed: ${e instanceof Error ? e.message : String(e)}`, recoverable: false });
    releaseRunGuard();
    return;
  }
  // Populate the domain config global so the executor's getDomainConfig()
  // and handleTabAction's checkUrlAllowed() can read it.
  try {
    await loadAndSetDomainConfig();
  } catch (e) {
    sendEvent({ type: "error", step: 0, message: `Domain config load failed: ${e instanceof Error ? e.message : String(e)}`, recoverable: false });
    releaseRunGuard();
    return;
  }
  const cfgMaxActions = (stored.maxActions as number) ?? DEFAULT_MAX_ACTIONS;
  const cfgPlannerInterval = (stored.plannerInterval as number) ?? DEFAULT_PLANNER_INTERVAL;
  const cfgMaxFailures = (stored.maxFailures as number) ?? DEFAULT_MAX_FAILURES;
  const cfgCostCap = (stored.costCap as number) ?? DEFAULT_COST_CAP;
  const cfgMaxSteps = (stored.maxSteps as number) ?? maxSteps;

  const runState: RunState = {
    task,
    maxSteps: cfgMaxSteps,
    mode,
    startTabId: tab.id,
    currentTabId: tab.id,
    step: 0,
    history: [],
    active: true,
    abortRequested: false,
  };
  // Wrap `saveRunState` + `startKeepalive` in a try/catch — if either
  // throws (chrome.storage quota exceeded, alarms API unavailable in a
  // unit-test harness, SW termination mid-call), the `runStarting` guard
  // flag would stay `true` forever and every subsequent RUN message would
  // be rejected with "already starting". On throw, release the guard,
  // surface an error event, and bail out cleanly so the user can retry.
  try {
    await initRunState(runState);
  } catch (e) {
    sendEvent({
      type: "error",
      step: 0,
      message: `Run state initialization failed: ${e instanceof Error ? e.message : String(e)}`,
      recoverable: false,
    });
    // If saveRunState succeeded but startKeepalive threw inside initRunState,
    // state.active is persisted as true — clear it so future RUN messages
    // aren't rejected with "already running".
    try { await clearRunState(); } catch { /* best-effort */ }
    releaseRunGuard();
    return;
  }

  const { controller, onStorageChanged } = wireAbortController();

  // Re-check for a STOP that arrived between `initRunState` and
  // `wireAbortController`. The storage.onChanged listener is now registered
  // (so future STOPs are caught immediately), but a STOP that landed in the
  // gap before the listener was wired would be missed. This re-check closes
  // that gap. cleanupRun is called on the early-return so the listener,
  // keepalive alarm, and persisted state are all cleaned up.
  try {
    const afterWire = await getRunState();
    if (afterWire?.abortRequested) {
      sendEvent({ type: "info", message: "Agent stopped by user." });
      sendEvent({ type: "done", step: 0, success: false, text: "Agent stopped by user." });
      await cleanupRun({
        runBuilder, task, isScheduledTaskRun, onStorageChanged,
        sendEvent, runSucceeded, releaseRunGuard, teardownScheduledVision,
      });
      return;
    }
  } catch {
    // Storage read failed — non-fatal, the orchestrator's own signal check
    // will catch a genuine abort on the next step.
  }

  try {
    // Reset the SW-side Vision init-failed flag at the start of each new run
    // so a previously-transient init failure (disk full, WebGPU OOM, …) gets
    // retried. Safe no-op if init is currently in-flight.
    resetVisionInitFlagForNewRun();

    // Clear the vision elements cache at run START, not just at run END.
    // `cleanupRun` releases the run guard (line 751) BEFORE it clears the cache
    // (line 827) — between those two lines, the side panel sees the run as
    // finished and a new RUN message could start a new run whose first
    // `extractStateForRun` would read STALE `[vN]` entries from the previous
    // run. Clearing here (before the orchestrator's first observe) guarantees a
    // clean slate regardless of whether the prior run's cleanup finished.
    // Idempotent with the cleanupRun clear — double-clear is a no-op.
    clearVisionElementsCacheForNewRun();

    // Wire the AgentMetricsCallback (Phase 8) to track detailed run metrics.
    // The orchestrator's onEvent stream continues to fire exactly as before —
    // the callback is additive.
    let metricsCallback: import("@/lib/agent/callbacks/metrics").AgentMetricsCallback | undefined;
    try {
      const { AgentMetricsCallback } = await import("@/lib/agent/callbacks/metrics");
      metricsCallback = new AgentMetricsCallback();
    } catch {
      /* callback module unavailable — non-fatal, run without metrics */
    }

    await runAgentLoop(buildLoopDeps({
      tab,
      sendEvent,
      controller,
      task,
      mode,
      callbacks: metricsCallback ? [metricsCallback] : undefined,
      config: {
        maxSteps: cfgMaxSteps,
        maxActionsPerStep: cfgMaxActions,
        plannerInterval: cfgPlannerInterval,
        maxFailures: cfgMaxFailures,
        costCapUsd: cfgCostCap,
      },
    }));
  } catch (e) {
    sendEvent({
      type: "error",
      step: 0,
      message: e instanceof Error ? e.message : String(e),
      recoverable: false,
    });
  } finally {
    await cleanupRun({
      runBuilder,
      task,
      isScheduledTaskRun,
      onStorageChanged,
      sendEvent,
      runSucceeded,
      releaseRunGuard,
      teardownScheduledVision,
    });
  }
}
