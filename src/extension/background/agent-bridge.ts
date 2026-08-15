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
import type { AgentMode } from "@/lib/agent/modes";
import { MODE_CONFIGS } from "@/lib/agent/modes";
import { DEFAULT_MAX_ACTIONS, MAX_ACTIONS } from "@/lib/validations";
import { DEFAULT_COST_CAP } from "@/lib/agent/types-utils";
import { RunBuilder, saveRun } from "@/lib/agent/run-history";
import {
  invalidateLiveSecretRedaction,
  primeLiveSecretRedaction,
} from "@/lib/agent/secrets";
import { ensureApiKeyInSession } from "@/extension/api-key-storage";
import { clearPromptMemo } from "@/lib/agent/prompts/prompt-memo";
import { clearRedactionMemo } from "@/lib/agent/redaction-memo";
import { getEffectiveContextTokens } from "../llm-direct";
import {
  stopKeepalive,
  loadAndSetDomainConfig,
  safeLog,
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
  requestRunStartCancellation,
  isRunStartCancellationRequested,
  resetDownloadConsent,
  runDeadlineForProvider,
  LOCAL_RUN_DEADLINE_MS,
  REMOTE_RUN_DEADLINE_MS,
  consumeDownloadConsentForMode,
  markDownloadConsentConsumed,
  releaseDownloadConsentReservation,
} from "./agent-bridge-utils";
import {
  beginRunController,
  type RunController,
} from "./run-controller";
import { persistRunSnapshot, flushRunSnapshot } from "./run-snapshot-store";
import { runSessionState } from "./run-session-state";
import { RunEventService } from "./run-event-service";

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
  requestRunStartCancellation,
  isRunStartCancellationRequested,
  consumeDownloadConsentForMode,
  markDownloadConsentConsumed,
  releaseDownloadConsentReservation,
  resetDownloadConsent,
  runDeadlineForProvider,
  LOCAL_RUN_DEADLINE_MS,
  REMOTE_RUN_DEADLINE_MS,
};

const DEFAULT_PLANNER_INTERVAL = 10;
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
  /** Authority reserved by the admission path before any scheduled side effect. */
  reservation?: RunAuthorityReservation;
  /** Invoked once the run has PASSED every admission gate (recovery audit,
   * existing-run check, domain-config load, pre-loop cancellation check) and is
   * guaranteed to proceed to the loop. Used by the RUN service to ACK the
   * panel only after the run is actually admitted — an early ack would let the
   * panel show a "started" run that never runs. */
  onAdmitted?: () => void;
}

export interface RunAuthorityReservation {
  runBuilder: RunBuilder;
  controller: RunController;
}

// A manual RUN reserves this synchronously before it performs any storage
// read.  That makes STOP authoritative even in the historical RUN → storage
// await → startRun gap.  Scheduled runs intentionally do not reserve early.
let reservedManualRun: RunAuthorityReservation | null = null;

function reserveRunAuthority(args: Pick<StartRunArgs, "task" | "maxSteps" | "mode">): RunAuthorityReservation {
  const runBuilder = new RunBuilder(args.task);
  const controller = beginRunController({
    runId: runBuilder.id,
    task: args.task,
    maxSteps: args.maxSteps,
    mode: args.mode,
    now: runBuilder.startedAt,
  });
  return { runBuilder, controller };
}

export function reserveManualRunAuthority(args: Pick<StartRunArgs, "task" | "maxSteps" | "mode">): void {
  // The caller owns the synchronous run-starting guard. Keeping this check
  // defensive prevents an accidental direct use from replacing authority.
  if (reservedManualRun || !isRunStarting()) {
    throw new Error("a manual run is already reserved or was not guarded");
  }
  reservedManualRun = reserveRunAuthority(args);
  // Do not persist until the service-worker recovery audit has finished. A
  // prior worker may have left an orphan snapshot that recovery still needs
  // to identify and revoke; overwriting it here would lose that identity.
}

/** Finish a reservation that could not be admitted without touching another run's state. */
export async function discardReservedRunAuthority(
  reservation: RunAuthorityReservation,
  message: string,
): Promise<void> {
  const snapshot = reservation.controller.markTerminal("failed", message);
  await persistRunSnapshot(snapshot).catch(() => { /* best-effort */ });
  try {
    await saveRun(reservation.runBuilder.finish({
      success: false,
      text: message,
      terminalReason: "failed",
    }));
  } catch { /* history is best-effort for a rejected start */ }
  setRunStarting(false);
}

export async function discardReservedManualRun(message: string): Promise<void> {
  const reserved = reservedManualRun;
  reservedManualRun = null;
  if (!reserved) return;
  await discardReservedRunAuthority(reserved, message);
}

/** Reserve the scheduled run before any browser-visible side effect. */
export function reserveScheduledRunAuthority(
  args: Pick<StartRunArgs, "task" | "maxSteps" | "mode">,
): RunAuthorityReservation {
  if (!isRunStarting()) {
    throw new Error("a scheduled run was not guarded before reservation");
  }
  return reserveRunAuthority(args);
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
export async function startRun({ task, maxSteps, mode, isScheduledTaskRun = false, reservation: suppliedReservation, onAdmitted }: StartRunArgs): Promise<void> {
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
 // Create the authoritative controller before the first await. STOP can then
 // synchronously invalidate dispatch even during session-notice cleanup.
  const reserved = suppliedReservation ?? (!isScheduledTaskRun ? reservedManualRun : null);
  if (!suppliedReservation && reserved) reservedManualRun = null;
  const runBuilder = reserved?.runBuilder ?? new RunBuilder(task);
  const runController: RunController = reserved?.controller ?? beginRunController({
    runId: runBuilder.id,
    task,
    maxSteps,
    mode,
    now: runBuilder.startedAt,
  });
  // Exact custom secret values and the configured provider key must be in a
  // synchronous cache before any run event can cross into a transcript or
  // snapshot. If either storage read fails, invalidate so every live string is
  // masked rather than falling back to heuristic-only redaction.
  try {
    await primeLiveSecretRedaction(await ensureApiKeyInSession());
  } catch {
    invalidateLiveSecretRedaction();
  }
  void persistRunSnapshot(runController.snapshot).catch(() => { /* best-effort */ });
  // Clear any unconsumed interrupted-run notice (a panel that was closed
  // during a SW restart never rendered it). Without this, a stale "previous
  // run cannot be resumed" message could surface mid-run or on a later
  // panel open.
  try {
    await chrome.storage.session.remove("open_cowork_interrupted_notice");
  } catch {
    /* best-effort */
  }

  let runState: RunState | null = null;
  const runEvents = new RunEventService(runController, runBuilder);
  const sendEvent = runEvents.emit;

  let deadlineProvider: unknown;
  try {
    deadlineProvider = (await chrome.storage.local.get("provider")).provider;
  } catch {
    deadlineProvider = undefined;
  }
  const totalRunDeadlineMs = runDeadlineForProvider(deadlineProvider);
  const totalRunDeadlineMinutes = Math.round(totalRunDeadlineMs / 60_000);
  const totalRunTimer = setTimeout(() => {
    if (runEvents.isFinished || runController.isTerminal) return;
    sendEvent({
      type: "error",
      step: runEvents.currentStep,
      message: `The run exceeded its ${totalRunDeadlineMinutes}-minute total deadline and was stopped before any later action could begin.`,
      recoverable: false,
      code: "TOTAL_RUN_DEADLINE",
      recovery: "Start a new run with a narrower task or fewer steps.",
    });
    const snapshot = runController.snapshot;
    void import("./tab-manager").then(({ broadcastRunCancellation }) =>
      broadcastRunCancellation(snapshot),
    ).catch(() => { /* best-effort */ });
    void runSessionState.patch(runController.dispatchToken, { abortRequested: true }).catch(() => { /* best-effort */ });
  }, totalRunDeadlineMs);
  if (typeof totalRunTimer === "object" && "unref" in totalRunTimer) totalRunTimer.unref();

  const releaseRunGuard = (): void => {
    clearTimeout(totalRunTimer);
    setRunStarting(false);
  };

  let onStorageChanged: ((changes: { [k: string]: chrome.storage.StorageChange }, area: string) => void) | undefined;
  const finalizeEarly = async (
    reason: "failed" | "cancelled",
    message: string,
  ): Promise<void> => {
    runEvents.terminalize(reason, message);
    await persistRunSnapshot(runController.snapshot).catch(() => { /* best-effort */ });
    // The terminal snapshot must be durable before a successor run can be
    // authorized — never leave it in the coalescing buffer.
    await flushRunSnapshot().catch(() => { /* best-effort */ });
    runEvents.markFinished();
    await cleanupRun({
      runBuilder, task, isScheduledTaskRun, onStorageChanged,
      sendEvent, runSucceeded: runEvents.runSucceeded, releaseRunGuard, teardownScheduledVision,
      abortSignal: runController.signal, terminalSnapshot: runController.snapshot,
    });
    try { await runSessionState.clear(runController.dispatchToken); } catch { /* cleanup already attempted this */ }
    try { await stopKeepalive(); } catch { /* cleanup already attempted this */ }
    // cleanupRun owns this in production; keep this idempotent fallback so a
    // cleanup failure (or an intentionally minimal test adapter) cannot pin
    // the synchronous admission guard forever.
    releaseRunGuard();
  };

  const finishIfCancelledBeforeLoop = async (): Promise<boolean> => {
    if (!runController.signal.aborted) return false;
    runEvents.sendCancellationTranscript();
    await finalizeEarly("cancelled", "Agent stopped by user.");
    return true;
  };

  if (await finishIfCancelledBeforeLoop()) return;

  let tab: chrome.tabs.Tab | undefined;
  try {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch (e) {
    sendEvent({ type: "error", step: 0, message: `Tab query failed: ${errMsg(e)}`, recoverable: false });
    await finalizeEarly("failed", `Tab query failed: ${errMsg(e)}`);
    return;
  }
  if (await finishIfCancelledBeforeLoop()) return;
  if (!tab?.id) {
    sendEvent({ type: "error", step: 0, message: "No active tab", recoverable: false });
    await finalizeEarly("failed", "No active tab");
    return;
  }
 // L23: refuse to attach the agent to a PRIVILEGED tab — browser internals
 // (`chrome://`), extension pages (`chrome-extension://`), the Chrome Web
 // Store, or `about:` pages. The content script + debugger cannot operate
 // there and driving them would be unsafe.
 //
 // Rather than hard-failing the run (which made the extension unusable from
 // the new-tab page — a common "agent ai extension" entry point), AUTO-OPEN
 // a fresh ordinary HTTPS tab and proceed on it. The previous implementation
 // created `about:blank`, but this extension's manifest only injects content
 // scripts into http(s) pages; every initial observation therefore failed and
 // the run aborted after maxFailures. example.com is a stable, script-light
 // bootstrap page that the observer can read before the agent navigates to the
 // user's target. Surfaces an info event so the user understands what happened. The
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
       const newTab = await chrome.tabs.create({ active: true, url: "https://example.com/" });
       if (await finishIfCancelledBeforeLoop()) return;
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
         await finalizeEarly("failed", `Cannot run on a privileged page (${tabUrl}) and opening a new tab failed.`);
         return;
       }
     } catch (e) {
       sendEvent({
         type: "error",
         step: 0,
         message: `Cannot run on a privileged page (${tabUrl}); opening a new tab failed: ${errMsg(e)}. Open a regular web page first.`,
         recoverable: false,
       });
       await finalizeEarly("failed", `Cannot run on a privileged page (${tabUrl}); opening a new tab failed.`);
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
     await finalizeEarly("failed", "No active tab");
     return;
   }

 // Read user-overridable run-time settings from local storage. Falls back to
 // defaults if not set or unreadable.
  let stored: Record<string, unknown>;
  try {
    stored = await chrome.storage.local.get([
      "maxActions", "plannerInterval", "maxFailures", "costCap", "maxSteps",
      "allowedDomains", "blockedDomains",
      "enableVerboseNavigatorPrompt",
    ]);
  } catch (e) {
    sendEvent({ type: "error", step: 0, message: `Settings load failed: ${errMsg(e)}`, recoverable: false });
    await finalizeEarly("failed", `Settings load failed: ${errMsg(e)}`);
    return;
  }
  if (await finishIfCancelledBeforeLoop()) return;
 // When the resolved mode allows JavaScript execution (full_agentic) but no
 // explicit domain allowlist is configured, `evaluate` will FAIL CLOSED — it
 // cannot run on any origin until `allowedDomains` is set. Emit a prominent
 // startup warning so the user knows why execution is refused (and what to
 // configure). We do NOT throw: the run can still proceed for non-JS actions;
 // only the unsandboxed RCE path is gated.
  if (!MODE_CONFIGS[mode]) {
    // The mode string is storage/message-derived and unvalidated on the
    // scheduled-task path — a corrupted value could embed secret-shaped text,
    // so route through safeLog (redacts) instead of console.warn.
    void safeLog("warn", `[agent-bridge] invalid mode — falling back to "${DEFAULT_MODE}" (raw value redacted)`);
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
    await finalizeEarly("failed", `Domain config load failed: ${errMsg(e)}`);
    return;
  }
  if (await finishIfCancelledBeforeLoop()) return;
  // The run is now ADMITTED: recovery audit passed, no active run, domain
  // config loaded, and the pre-loop cancellation check passed. Notify the
  // caller (the RUN service acks the panel here) so the panel never shows a
  // "started" run that was actually rejected at admission.
  onAdmitted?.();
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
  await persistRunSnapshot(
    runController.updateConfiguration({ mode: effectiveMode, maxSteps: cfgMaxSteps }),
  ).catch(() => { /* best-effort */ });

  runState = {
    runId: runController.snapshot.runId,
    dispatchRevision: runController.snapshot.dispatchRevision,
    task,
    maxSteps: cfgMaxSteps,
    mode: effectiveMode,
    startTabId,
    currentTabId: startTabId,
    step: 0,
    active: true,
    abortRequested: false,
  };
  runEvents.setRunState(runState);
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
    await finalizeEarly("failed", `Run state initialization failed: ${errMsg(e)}`);
    return;
  }

  try {
    const wired = wireAbortController(runController.rootAbortController, runController.dispatchToken);
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
    await finalizeEarly("failed", `Abort wiring failed: ${errMsg(e)}`);
    return;
  }

 // Re-check for a STOP that arrived between `initRunState` and
 // `wireAbortController`. The storage.onChanged listener is now registered
 // (so future STOPs are caught immediately), but a STOP that landed in the
 // gap before the listener was wired would be missed. This re-check closes
 // that gap. cleanupRun is called on the early-return so the listener,
 // keepalive alarm, and persisted state are all cleaned up.
  try {
    const afterWire = await runSessionState.readForRun(runController.dispatchToken);
    if (afterWire?.abortRequested) {
      runEvents.sendCancellationTranscript();
      await finalizeEarly("cancelled", "Agent stopped by user.");
      return;
    }
  } catch {
 // Storage read failed — non-fatal, the orchestrator's own signal check
 // will catch a genuine abort on the next step.
  }

 // Wire the AgentMetricsCallback to track detailed run metrics.
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

  // Drop the compiled-prompt memo at run START (run-lifecycle): the memo is
  // module state in the MV3 service worker, so clearing guarantees this run
  // compiles from CURRENT settings even if a storage change landed while the
  // worker was asleep (no onChanged fired). Idempotent and cheap — clearing
  // empty maps is a no-op on SW wake.
    clearPromptMemo();

  // Drop the redaction/injection memo at run START (run-lifecycle): the memo
  // is module state in the MV3 service worker, so clearing guarantees this
  // run redacts from CURRENT settings even if a storage change landed while
  // the worker was asleep (no onChanged fired). Idempotent and cheap —
  // clearing empty maps is a no-op on SW wake.
    clearRedactionMemo();

    try {
      const { AgentMetricsCallback } = await import("@/lib/agent/callbacks/metrics");
      metricsCallback = new AgentMetricsCallback();
    } catch {
      /* callback module unavailable — non-fatal, run without metrics */
    }

    const runningSnapshot = runController.markRunning();
    await persistRunSnapshot(runningSnapshot).catch(() => { /* best-effort */ });
    // Resolve the effective model context window (catalog `limit.context` or the
    // user's `contextTokens` override) once at run start. The loop derives its
    // per-step observation caps from it, so a 64k-class model degrades the
    // observation instead of tripping the fail-closed prompt-budget assert on
    // every step. Best-effort: a resolution failure must never block a run start
    // (the provider layer re-derives the budget per call as its own backstop).
    let contextTokens: number | undefined;
    try {
      contextTokens = await getEffectiveContextTokens();
    } catch (e) {
      void safeLog("warn", "[agent-bridge] context-token resolution failed, using fixed prompt budgets:", e);
    }
    await runAgentLoop(buildLoopDeps({
      tab,
      sendEvent,
      controller: runController,
      task,
      mode: effectiveMode,
      callbacks: metricsCallback ? [metricsCallback] : undefined,
      config: {
        maxSteps: cfgMaxSteps,
        maxActionsPerStep: cfgMaxActions,
        plannerInterval: cfgPlannerInterval,
        maxFailures: cfgMaxFailures,
        costCapUsd: cfgCostCap,
        contextTokens,
      },
    }));
  } catch (e) {
    if (runController.signal.aborted) {
      runEvents.sendCancellationTranscript();
    } else {
      const typed = e as { code?: unknown; recovery?: unknown };
      sendEvent({
        type: "error",
        step: runEvents.currentStep,
        message: errMsg(e),
        recoverable: false,
        ...(typeof typed.code === "string" ? { code: typed.code } : {}),
        ...(typeof typed.recovery === "string" ? { recovery: typed.recovery } : {}),
      });
    }
  } finally {
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
    runEvents.terminalize(
      runController.signal.aborted ? "cancelled" : runEvents.runSucceeded ? "succeeded" : "failed",
      runController.signal.aborted ? "Agent stopped by user." : runEvents.runSucceeded ? "Run completed." : "Run ended without a successful result.",
    );
    await persistRunSnapshot(runController.snapshot).catch(() => { /* best-effort */ });
    runEvents.markFinished();
    await cleanupRun({
      runBuilder,
      task,
      isScheduledTaskRun,
      onStorageChanged,
      sendEvent,
      runSucceeded: runEvents.runSucceeded,
      releaseRunGuard,
      teardownScheduledVision,
      abortSignal: runController.signal,
      terminalSnapshot: runController.snapshot,
    });
  }
}
