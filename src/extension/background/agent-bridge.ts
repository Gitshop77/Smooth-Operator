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
import { MODE_CONFIGS } from "@/lib/agent/modes";
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

/**
 * Coerce an unknown stored/override value into a finite integer clamped to
 * [min, max] (finding: run-time numeric/string inputs are not validated). A
 * corrupted/NaN/negative/string storage value is normalized instead of being
 * passed straight into the loop config where it could cause degenerate behavior.
 */
function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

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

// ─── Per-run download consent (full_agentic) ──────────────────────────────
//
// In `full_agentic` mode the agent can issue repeated `save_as_pdf` /
// `screenshot` actions; a prompt injection could otherwise silently spam the
// download directory. The first download of each run forces a `saveAs`
// confirmation, after which the rest of the run is treated as consented
// (one-time per-run consent). This flag is owned HERE — the single shared
// entry point for BOTH manual RUN and scheduled-task runs — and reset at the
// top of {@link startRun} so consent can never leak across runs (finding:
// scheduled full_agentic runs inherited a prior run's download-consent flag;
// the flag was previously reset only on the manual RUN path, so a scheduled
// run that began after any prior run kept `consent = true` and silently
// skipped the `saveAs` confirmation).
let fullAgenticDownloadConsent = false;

/** Reset the per-run download-consent flag (called at the start of every run). */
export function resetDownloadConsent(): void {
  fullAgenticDownloadConsent = false;
}

/**
 * Consume the one-time per-run download consent for the given run mode.
 * Returns `true` (meaning a `saveAs` confirmation is required) only for the
 * FIRST download of a `full_agentic` run; subsequent calls return `false`.
 * Consumed synchronously so two concurrent SAVE_AS_PDF/SCREENSHOT messages
 * can't both observe an unconsumed flag and double-prompt the user.
 */
export function consumeDownloadConsentForMode(mode: string | undefined): boolean {
  const requireSaveAs = mode === "full_agentic" && !fullAgenticDownloadConsent;
  if (requireSaveAs) fullAgenticDownloadConsent = true;
  return requireSaveAs;
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
 // Reset the per-run download-consent flag for EVERY run — this is the single
 // shared entry point for both manual RUN and scheduled-task runs, so resetting
 // here guarantees per-run isolation regardless of how the run was started
 // (finding: scheduled full_agentic runs inherited a prior run's consent flag).
  resetDownloadConsent();

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
 // Set true once cleanup has started so a transient `navigator-step-start`
 // event emitted after `cleanupRun`/`clearRunState` can't re-create the
 // persisted run-state object (finding: late saveRunState({step}) could
 // resurrect run state after clearRunState). The step-persist in sendEvent
 // below is gated on this flag.
  let runFinished = false;

  /** Stream a {@link LogEvent} to the side panel + persist step count.
 * Declared at the top of the function so the early `tab.id` check below can
 * call it before `runState` is constructed. */
 // Declared UP FRONT (before `sendEvent`) so the TDZ can never bite:
 // `sendEvent` reads `runState.step` in its navigator-step-start branch, but
 // that branch only fires after `runState` is assigned at run start (line
 // below). Hoisting the declaration above the closure removes any chance of a
 // ReferenceError if a future change makes an early (pre-assignment) event
 // touch `runState` (finding: latent TDZ / ordering fragility in sendEvent
 // closure).
 // `runState` is held in a `const` ref so the `sendEvent` closure (declared
 // below, before `runState` is constructed) can read it without risking a
 // TDZ ReferenceError if an early (pre-run-start) event ever touches it. The
 // `const` ref satisfies `prefer-const`; the mutable payload lives on
 // `.current`, which stays `null` until run start assigns it.
  const runStateRef: { current: RunState | null } = { current: null };
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
 // Keep the in-memory `runState.step` in sync with the persisted value
 // (finding: runState.step is never updated in memory; only persisted via
 // delta). Otherwise `handleTabAction`'s notify events report step 0.
 // Gated on `runFinished` so a late step event after cleanup can't
 // resurrect the persisted run-state (finding: late saveRunState). Also
 // guarded by `runState` being assigned, so an early (pre-run) event can
 // never dereference an undefined object.
      if (runStateRef.current && !runFinished) {
        runStateRef.current.step = event.step;
        saveRunState({ step: event.step }).catch(() => {
          /* best-effort persistence */
        });
      }
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
 // When the resolved mode allows JavaScript execution (full_agentic) but no
 // explicit domain allowlist is configured, `evaluate` will FAIL CLOSED — it
 // cannot run on any origin until `allowedDomains` is set. Emit a prominent
 // startup warning so the user knows why execution is refused (and what to
 // configure). We do NOT throw: the run can still proceed for non-JS actions;
 // only the unsandboxed RCE path is gated.
  if (!MODE_CONFIGS[mode]) {
    console.warn(`[agent-bridge] invalid mode "${String(mode)}" — falling back to "${DEFAULT_MODE}"`);
 // Surface the fallback to the side panel so an invalid mode isn't a silent
 // run with no explanation (finding: invalid mode crash swallowed with no
 // user-visible error). The run proceeds in the default mode rather than
 // crashing startRun.
    sendEvent({ type: "info", message: `Invalid mode "${String(mode)}" — using "${DEFAULT_MODE}".` });
  }
  const effectiveMode: AgentMode = MODE_CONFIGS[mode] ? mode : DEFAULT_MODE;
  if (MODE_CONFIGS[effectiveMode].canExecuteJs) {
    const configuredAllowlist = (stored.allowedDomains as string[] | undefined) ?? [];
    if (configuredAllowlist.length === 0) {
      console.warn(
        "[security] evaluate JS execution enabled with NO domain allowlist — failing closed; configure allowedDomains to permit execution.",
      );
 // Surface the reason to the side panel so a user debugging "why do my JS
 // actions silently do nothing?" gets an actionable explanation.
      sendEvent({
        type: "warn",
        step: 0,
        message:
          "JavaScript execution (evaluate) is enabled with NO domain allowlist — failing closed. Configure allowedDomains to permit execution.",
      });
    }
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
 // Validate / clamp run-time numeric overrides from storage (finding: run-time
 // numeric/string inputs are not validated). A corrupted value (negative, NaN,
 // non-numeric string) is coerced to a sane bound instead of reaching the loop.
  const cfgMaxActions = clampInt(stored.maxActions, DEFAULT_MAX_ACTIONS, 1, 50);
  const cfgPlannerInterval = clampInt(stored.plannerInterval, DEFAULT_PLANNER_INTERVAL, 1, 100);
  const cfgMaxFailures = clampInt(stored.maxFailures, DEFAULT_MAX_FAILURES, 1, 100);
  const cfgCostCap = (typeof stored.costCap === "number" && Number.isFinite(stored.costCap) && stored.costCap >= 0)
    ? stored.costCap
    : DEFAULT_COST_CAP;
 // Clamp the effective step budget to BOTH the absolute safety bound (1..1000,
 // enforced by `clampInt` + the Zod schema) AND the active mode's cap. The
 // per-mode `maxSteps` (e.g. `restricted: 30`, `standard: 100`,
 // `full_agentic: 500` in `modes.ts`) is a documented trust-boundary limit —
 // "restricted" is meant to keep the blast radius small on sensitive sites — so
 // a user-controlled `chrome.storage.local` value (up to 1000) must never
 // override it. Without this `Math.min`, the mode cap is dead: the loop honors
 // only the user value (see finding: zombie maxSteps flag).
  const modeCap = MODE_CONFIGS[effectiveMode].maxSteps;
  const cfgMaxSteps = Math.min(clampInt(stored.maxSteps, maxSteps, 1, 1000), modeCap);

  runStateRef.current = {
    task,
    maxSteps: cfgMaxSteps,
    mode: effectiveMode,
    startTabId: tab.id,
    currentTabId: tab.id,
    step: 0,
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
    await initRunState(runStateRef.current);
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
    runFinished = true;
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
      runFinished = true;
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

 // Wire the AgentMetricsCallback (Phase 8) to track detailed run metrics.
 // Declared at function scope (NOT inside the try below) so the `finally`
 // block can read its snapshot after the run ends — a variable declared
 // inside the try would be out of scope in `finally` (broken by the
 // reconcile rewrite). The orchestrator's onEvent stream continues to fire
 // exactly as before — the callback is additive.
  let metricsCallback: import("@/lib/agent/callbacks/metrics").AgentMetricsCallback | undefined;

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
      mode: effectiveMode,
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
    runFinished = true;
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
 // Surface the detailed run metrics so the AgentMetricsCallback is not an
 // orphaned accumulator: emit a concise summary to the side panel + run
 // record after every run. (getMetrics()/reset() had no consumer before —
 // the snapshot was silently discarded. See finding: metrics feature orphaned.)
    if (metricsCallback) {
      try {
        const m = metricsCallback.getMetrics();
        const summary =
          `Run metrics — steps: ${m.totalSteps}, actions: ${m.totalActions}, ` +
          `tokens in/out: ${m.totalTokensIn}/${m.totalTokensOut}, ` +
          `cost: $${m.totalCostUsd.toFixed(4)}, errors: ${m.errors.total}, ` +
          `loop warnings: ${m.loopWarnings}, compactions: ${m.compactions}`;
        sendEvent({ type: "info", message: summary });
      } catch {
        /* metrics snapshot unavailable — non-fatal */
      }
    }
  }
}
