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
import { DEFAULT_MAX_ACTIONS, MAX_ACTIONS } from "@/lib/validations";
import { DEFAULT_COST_CAP } from "@/lib/agent/types-utils";
import { RunBuilder } from "@/lib/agent/run-history";
import {
  saveRunState,
  getRunState,
  clearRunState,
  stopKeepalive,
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
  isVisionCacheFresh,
} from "./run-helpers";
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_MODE,
  clampInt,
  clampNumber,
  isRunStarting,
  setRunStarting,
  resetDownloadConsent,
  consumeDownloadConsentForMode,
  markDownloadConsentConsumed,
  releaseDownloadConsentReservation,
} from "./agent-bridge-utils";

// Re-export so existing importers (message-routing.ts dynamic import) keep
// resolving. The implementation lives in run-helpers.ts.
export { getVisionElementRect, isVisionCacheFresh };

// Re-export from utils so existing importers keep resolving.
export {
  DEFAULT_MAX_STEPS,
  DEFAULT_MODE,
  clampInt,
  clampNumber,
  isRunStarting,
  setRunStarting,
  consumeDownloadConsentForMode,
  markDownloadConsentConsumed,
  releaseDownloadConsentReservation,
};

/** No-op catch for fire-and-forget `sendMessage` calls (side panel may be closed). */
const SWALLOW_CLOSED_PORT = (): void => {};
const DEFAULT_PLANNER_INTERVAL = 5;
const DEFAULT_MAX_FAILURES = 5;
// Default cost cap in USD. 0 is still a valid EXPLICIT opt-out (a stored value
// of 0 is preserved by clampNumber); only the unset/undef case adopts this
// default so a first-time user with REAL API keys gets a fail-safe cap.
// Imported as DEFAULT_COST_CAP from @/lib/agent/types-utils.

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
 // Set the synchronous concurrent-run guard at the very top (before any await)
 // so BOTH the manual RUN path and the scheduled-task path are protected
 // against the two-concurrent-loops TOCTOU window. Previously only the manual
 // RUN handler set this flag, so a scheduled-task run left it false and could
 // start a second loop alongside a manual one.
  setRunStarting(true);
 // Local helper to extract a human-readable message from an unknown error,
 // used in every catch site below. Centralized so the two branches can never
 // drift apart if one copy is edited.
  const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
 // Reset the per-run download-consent flag for EVERY run — this is the single
 // shared entry point for both manual RUN and scheduled-task runs, so resetting
 // here guarantees per-run isolation regardless of how the run was started
  // (scheduled full_agentic runs inherited a prior run's consent flag).
  resetDownloadConsent();
  // Clear any unconsumed interrupted-run notice (a panel that was closed
  // during a SW restart never rendered it). Without this, a stale "previous
  // run cannot be resumed" message could surface mid-run or on a later
  // panel open.
  try {
    await chrome.storage.session.remove("open_cowork_interrupted_notice");
  } catch {
    /* best-effort */
  }

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
  // persisted run-state object (a late saveRunState({step}) could
  // resurrect run state after clearRunState). The step-persist in sendEvent
 // below is gated on this flag.
  let runFinished = false;

  // `runState` is declared before the `sendEvent` closure below so the closure
  // can read `runState.step` in its navigator-step-start branch without a TDZ
  // ReferenceError if an early (pre-run-start) event ever touches it.
  let runState: RunState | null = null;
  const sendEvent = (event: LogEvent): void => {
    chrome.runtime
      .sendMessage({
        type: "AGENT_EVENT",
        event,
        time: new Date().toTimeString().slice(0, 8),
      })
      .catch(SWALLOW_CLOSED_PORT);
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
 // (runState.step is never updated in memory; only persisted via
 // delta). Otherwise `handleTabAction`'s notify events report step 0.
 // Gated on `runFinished` so a late step event after cleanup can't
 // resurrect the persisted run-state (late saveRunState). Also
 // guarded by `runState` being assigned, so an early (pre-run) event can
 // never dereference an undefined object.
      if (runState && !runFinished) {
        runState.step = event.step;
        saveRunState({ step: event.step }).catch(() => {
          /* best-effort persistence */
        });
      }
    }
  };

  const releaseRunGuard = (): void => {
    setRunStarting(false);
  };

  let tab: chrome.tabs.Tab | undefined;
  try {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch (e) {
    sendEvent({ type: "error", step: 0, message: `Tab query failed: ${errMsg(e)}`, recoverable: false });
    releaseRunGuard();
    return;
  }
  if (!tab?.id) {
    sendEvent({ type: "error", step: 0, message: "No active tab", recoverable: false });
    releaseRunGuard();
    return;
  }
 // L23: refuse to attach the agent to a PRIVILEGED tab — browser internals
 // (`chrome://`), extension pages (`chrome-extension://`), the Chrome Web
 // Store, or `about:` pages. The content script + debugger cannot operate
 // there and driving them would be unsafe.
 //
 // Rather than hard-failing the run (which made the extension unusable from
 // the new-tab page — a common "agent ai extension" entry point), AUTO-OPEN
 // a fresh `about:blank` tab and proceed on it. `about:blank` is the one URL
 // Chrome universally permits for content scripts across versions, and the
 // agent's `navigate` action can then go to whatever target the user asked
 // for. Surfaces an info event so the user understands what happened. The
 // `chrome://newtab/` "home page" case (the most common miss) is covered by
 // this branch — `chrome://newtab/` matches the `chrome://` rule below.
   const tabUrl = tab.url ?? "";
   const isPrivileged =
     /^chrome:\/\//i.test(tabUrl) ||
     /^chrome-extension:\/\//i.test(tabUrl) ||
     /^about:/i.test(tabUrl) ||
     /chrome\.google\.com\/webstore/i.test(tabUrl) ||
     /chromewebstore\.google\.com/i.test(tabUrl);
   if (isPrivileged) {
     try {
       const newTab = await chrome.tabs.create({ active: true });
       if (newTab?.id) {
         tab = newTab;
         sendEvent({
           type: "info",
           message: `Active tab was a privileged page (${tabUrl}); opened a new tab to run on. The agent can navigate from here.`,
         });
       } else {
         // `tabs.create` returned a tab without an id — extremely unusual
         // (Chrome always assigns one). Fall back to the original hard-fail
         // so we don't proceed on a tab we can't address.
         sendEvent({
           type: "error",
           step: 0,
           message: `Cannot run on a privileged page (${tabUrl}) and opening a new tab failed. Open a regular web page first.`,
           recoverable: false,
         });
         releaseRunGuard();
         return;
       }
     } catch (e) {
       sendEvent({
         type: "error",
         step: 0,
         message: `Cannot run on a privileged page (${tabUrl}); opening a new tab failed: ${errMsg(e)}. Open a regular web page first.`,
         recoverable: false,
       });
       releaseRunGuard();
       return;
     }
   }
  // Re-narrow tab.id after the privileged-page branch — `tab = newTab` above
  // widened the type to `number | undefined` (chrome.tabs.Tab's id is
  // optional in the type defs). The early `if (!tab?.id) return` above is too
  // far above for TS to carry the narrowing across all the intervening
  // awaits and the reassignment. Localize the validated id here so the
  // `startTabId`/`currentTabId` assignments below type-check; the runtime
  // invariant (every path that reaches here has a real tab.id) is preserved
  // by the guards in the privileged-page branch + the early return above.
   const startTabId = tab.id;
   if (startTabId === undefined) {
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
    sendEvent({ type: "error", step: 0, message: `Settings load failed: ${errMsg(e)}`, recoverable: false });
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
 // run with no explanation (invalid mode crash swallowed with no
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
    sendEvent({ type: "error", step: 0, message: `Domain config load failed: ${errMsg(e)}`, recoverable: false });
    releaseRunGuard();
    return;
  }
 // Validate / clamp run-time numeric overrides from storage (run-time
 // numeric/string inputs are not validated). A corrupted value (negative, NaN,
 // non-numeric string) is coerced to a sane bound instead of reaching the loop.
  const cfgMaxActions = clampInt(stored.maxActions, DEFAULT_MAX_ACTIONS, 1, MAX_ACTIONS);
  const cfgPlannerInterval = clampInt(stored.plannerInterval, DEFAULT_PLANNER_INTERVAL, 1, 100);
  const cfgMaxFailures = clampInt(stored.maxFailures, DEFAULT_MAX_FAILURES, 1, 100);
  const cfgCostCap = clampNumber(stored.costCap, DEFAULT_COST_CAP, 0);
 // Clamp the effective step budget to BOTH the absolute safety bound (1..1000,
 // enforced by `clampInt` + the Zod schema) AND the active mode's cap. The
 // per-mode `maxSteps` (e.g. `restricted: 30`, `standard: 100`,
 // `full_agentic: 500` in `modes.ts`) is a documented trust-boundary limit —
 // "restricted" is meant to keep the blast radius small on sensitive sites — so
 // a user-controlled `chrome.storage.local` value (up to 1000) must never
 // override it. Without this `Math.min`, the mode cap is dead: the loop honors
  // only the user value (zombie maxSteps flag).
  const modeCap = MODE_CONFIGS[effectiveMode].maxSteps;
  const cfgMaxSteps = Math.min(clampInt(stored.maxSteps, maxSteps, 1, 1000), modeCap);

  runState = {
    task,
    maxSteps: cfgMaxSteps,
    mode: effectiveMode,
    startTabId,
    currentTabId: startTabId,
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
  // NOTE: there is deliberately NO stale-`abortRequested` reset here. A
  // STOP that lands at ANY point during init (handleStop writes the flag
  // whenever `isRunStarting()` is true) must survive into the post-wire
  // re-check below — wiping it here silently loses the stop.
  // Stale flags from a previous run are covered by the only two state
  // clearers: `cleanupRun`'s `clearRunState` (normal run end) and
  // `onServiceWorkerStartup`'s `clearRunState` (interrupted-run SW
  // restart). A residual stale flag (e.g. a failed `clearRunState`)
  // fail-closes: the re-check aborts the run cleanly and the cleanup then
  // clears it — never a silent run that ignores the user's stop.
  try {
    await initRunState(runState);
  } catch (e) {
    sendEvent({
      type: "error",
      step: 0,
      message: `Run state initialization failed: ${errMsg(e)}`,
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

  let controller: AbortController;
  let onStorageChanged: (changes: { [k: string]: chrome.storage.StorageChange }, area: string) => void;
  try {
    const wired = wireAbortController();
    controller = wired.controller;
    onStorageChanged = wired.onStorageChanged;
  } catch (e) {
 // If wiring the abort controller throws (e.g. chrome.storage API
 // unavailable after SW teardown), release the run guard and clear
 // persisted state so the next RUN isn't rejected with "already starting".
    sendEvent({
      type: "error",
      step: 0,
      message: `Abort wiring failed: ${errMsg(e)}`,
      recoverable: false,
    });
    runFinished = true;
    try { await clearRunState(); } catch { /* best-effort */ }
    try { await stopKeepalive(); } catch { /* best-effort */ }
    releaseRunGuard();
    return;
  }

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
  // `cleanupRun` (in run-helpers.ts) releases the run guard BEFORE it clears
  // the cache — between those two calls, the side panel sees the run as
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
      message: errMsg(e),
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
 // the snapshot was silently discarded.)
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
