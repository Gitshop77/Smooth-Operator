/**
 * background/index.ts — MV3 service worker entry point.
 *
 * Runs the Planner + Navigator agentic loop across tabs. The loop logic itself
 * lives in `src/lib/agent/loop/orchestrator.ts` (shared with the in-page demo).
 * This module (and its siblings under `background/`) provides the
 * Chrome-specific bindings:
 *
 * - chrome.storage.session for run-state persistence (MV3 resilience)
 * - chrome.alarms keepalive (service workers die after ~30s of inactivity)
 * - chrome.tabs queries + content-script injection
 * - chrome.scripting for programmatic injection
 * - Anti-detection injection (run before the content script)
 * - Tab-level action execution (switch/close/navigate)
 * - Message streaming to the side panel
 *
 * Top-level side effects (run when this module is loaded):
 * - registers `chrome.runtime.onInstalled` (opens side panel on action click)
 * - registers `chrome.alarms.onAlarm` (keepalive + scheduled-task fires)
 * - registers `chrome.runtime.onMessage` (via the message-routing import)
 * - runs the SW-startup check (notifies if a previous run was interrupted)
 *
 * The `background.ts` entry shim at `src/extension/background.ts` is a
 * one-line side-effect import of this file.
 */

import { parseAlarmName, initScheduledTasks } from "@/lib/agent/scheduled-tasks";
import {
  assertStorageVersionSupported,
} from "@/lib/agent/storage-version";
import {
  invalidateLiveSecretRedaction,
  primeLiveSecretRedaction,
} from "@/lib/agent/secrets";
import { ensureApiKeyInSession } from "@/extension/api-key-storage";
import { migrateRememberedCredential } from "@/extension/credential-service";
import { restrictSessionStorageToTrustedContexts } from "@/extension/storage-access";
import { getRunState, clearRunState, stopKeepalive, KEEPALIVE_ALARM, requestKeepAwake, safeLog } from "./state-store";
import {
  getPersistedRunSnapshot,
  persistInterruptedRunHistory,
  persistInterruptedRunSnapshot,
} from "./run-snapshot-store";
import { setRunRecoveryAudit } from "./run-recovery-gate";
import { captureStorageVersionFailure } from "./storage-version-gate";
import { serializeEventTime } from "./run-event-projection";
import { handleScheduledTaskFire } from "./task-queue";
import { registerRateLimitListener } from "./rate-limit-tracker";
import { startSwWatchdog } from "./watchdog";
import { createProviderLifecycleService } from "./provider-lifecycle-service";
import { installDefaultOptionsPlatformConnectionService } from "./options-platform-command";
// Importing `./message-routing` registers the `chrome.runtime.onMessage`
// listener as a top-level side effect. The listener depends on `startRun`
// (from `./agent-bridge`), which depends on `./tab-manager` + `./state-store`.
// ES module evaluation order ensures every handler is wired before the SW
// becomes ready to receive messages.
import "./message-routing";

// Register the network-authoritative 429/503 rate-limit listener. The DOM
// challenge detector refuses to derive a rate-limit from attacker-settable page
// content, so this listener supplies the authoritative signal the anti-bot
// hooks surface as a `rate-limited` challenge kind.
registerRateLimitListener();

// ─── SW watchdog (stalls / leaks) ──────────────────────────────────────────
// Arm the interval watchdog: it surfaces event-loop stalls and vision-model
// memory growth into the side panel via the AGENT_EVENT bus (own interval,
// own guard, own notice path — independent of the pricing boot arm above).
// MV3: the interval dies with the SW and is re-armed on the next load.
startSwWatchdog();
const providerLifecycleService = createProviderLifecycleService();
providerLifecycleService.start();
installDefaultOptionsPlatformConnectionService();

// Legacy plaintext may be written by an older Options page while this worker
// is already alive. Serialize only positive opt-in/source writes; migration's
// own apiKey removal and manifest/journal writes therefore cannot form a
// storage-change loop. Failures intentionally retain the legacy source for a
// later startup/change retry and never include credential bytes in logs.
let credentialMigrationQueue: Promise<void> = Promise.resolve();
function queueLegacyCredentialMigration(): void {
  credentialMigrationQueue = credentialMigrationQueue
    .then(async () => {
      await migrateRememberedCredential();
      await primeLiveSecretRedaction(await ensureApiKeyInSession());
    })
    .catch(async () => {
      // A vault retry may fail while a separately verified session credential
      // remains usable. Prime from that trusted session; if it is unavailable,
      // ensureApiKeyInSession returns empty and the cache contains no API key.
      try {
        await primeLiveSecretRedaction(await ensureApiKeyInSession());
      } catch {
        invalidateLiveSecretRedaction();
      }
      /* verified migration remains resumable */
    });
}
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  const apiKeyWrite = typeof changes.apiKey?.newValue === "string" && changes.apiKey.newValue.length > 0;
  const consentGranted = changes.rememberApiKey?.newValue === true;
  if (apiKeyWrite || consentGranted) queueLegacyCredentialMigration();
});

// Top-level safety net: rejections thrown outside any try/catch (e.g. an async
// listener body or a late `import()` that rejects) are otherwise silently
// dropped and never redacted. Route them through safeLog so any embedded
// secrets are scrubbed before hitting the SW console.
self.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
  void safeLog("error", "[sw] unhandled rejection:", e.reason);
});
self.addEventListener("error", (e: ErrorEvent) => {
  void safeLog("error", "[sw] uncaught error:", e.error ?? e.message);
});

// ─── Side panel wiring ──────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {
      /* setPanelBehavior can reject on unsupported Chrome versions — non-fatal */
    });

  providerLifecycleService.warm();
});

// ─── Keyboard shortcut: open side panel (Ctrl+E / Cmd+E) ────────────────────
// Extracted from the official Anthropic "Claude in Chrome" extension — a
// keyboard shortcut to bring up the side panel is a major UX improvement.
// Chrome's MV3 sidePanel API doesn't support programmatic closing, so the
// shortcut opens/focuses the panel. The user closes it via the X button.
chrome.commands?.onCommand.addListener(async (command) => {
  if (command === "toggle-side-panel") {
    try {
      await chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
    } catch {
 // sidePanel.open requires a user gesture in some Chrome versions —
 // keyboard shortcut commands DO count as user gestures, so this should
 // work. If it doesn't (older Chrome), the action click fallback still
 // works.
    }
  }
});

// ─── Toolbar action / _execute_action shortcut: open side panel ─────────────
// The manifest declares `_execute_action` (Ctrl+Shift+O / Cmd+Shift+O), which
// fires `chrome.action.onClicked` (not `chrome.commands.onCommand`).
// `openPanelOnActionClick` covers plain toolbar clicks, but the `_execute_action`
// keyboard-shortcut path does not reliably open the panel on its own — mirror
// the toggle-side-panel behavior above so the shortcut works too.
chrome.action?.onClicked.addListener(async () => {
  try {
    await chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
  } catch {
 // sidePanel.open requires a user gesture in some Chrome versions — an
 // action click IS a user gesture, so this should work. If it doesn't
 // (older Chrome), the keyboard shortcut still counts as a gesture.
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
 // Touching the SW keeps it alive. The loop's async work does the rest.
 // Add `.catch` to prevent unhandled rejection if storage fails.
    void getRunState().catch(() => { /* best-effort keepalive touch */ });
    return;
  }
 // Handle scheduled-task alarms. Parse the task ID, look up the stored task,
 // and start a run with its prompt. (`parseAlarmName` and
 // `initScheduledTasks` from scheduled-tasks.ts arm the alarms that fire
 // here — without this listener, alarms would be armed correctly but fire
 // into a void with no handler.)
  const taskId = parseAlarmName(alarm.name);
  if (taskId) {
    void handleScheduledTaskFire(taskId);
  }
});

// Port-based service-worker keepalive
//
// The side panel opens a long-lived `chrome.runtime.connect({ name: "keepalive" })`
// port on load. The mere existence of an open port keeps the SW alive — Chrome
// will not terminate the SW while a port is connected. This is critical for
// long LLM streams (a 60s `await fetch()` from a slow provider is otherwise
// "idle" from Chrome's perspective and risks mid-stream SW termination).
//
// The `chrome.alarms` keepalive above stays as a fallback for when the side
// panel is closed but a scheduled task is running.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "keepalive") {
 // No-op: the port's existence is what keeps the SW alive. We just need
 // to acknowledge the connection. The port will be torn down when the
 // side panel closes (or when the SW is killed — the side panel's
 // `onDisconnect` listener reconnects).
    port.onDisconnect.addListener(() => {
      // side panel closed; SW keeps running on the alarms keepalive fallback
    });
  }
});

// ─── SW startup: notify if a previous run was interrupted ──────────────────

/**
 * On service worker startup, check whether a run was active when the previous
 * SW was killed (notify the side panel so it doesn't hang), re-arm
 * scheduled-task alarms, and (re)acquire the keep-awake lock. Runs after the
 * `onMessage` listener is registered (via the `./message-routing` import) so a
 * pending panel-open STATUS doesn't race the startup logic. Each concern is
 * wrapped in its own try/catch so a transient failure in one — e.g. a
 * `getRunState()` rejection — does not block the others for the whole SW
 * incarnation.
 */
async function onServiceWorkerStartup(): Promise<void> {
  // Fail closed before any credential or run-authority read if the browser
  // cannot apply the strongest stable session-storage visibility restriction.
  await restrictSessionStorageToTrustedContexts();

  // Fail closed if persisted data claims a version this build cannot read: a
  // future-version marker means a newer extension wrote incompatible records,
  // and reading/mutating them could emit garbage. Legacy unmarked data (the
  // pre-versioning baseline) passes through the migration window.
  try {
    await Promise.all([
      assertStorageVersionSupported("settings"),
      assertStorageVersionSupported("history"),
      assertStorageVersionSupported("schedules"),
    ]);
  } catch (e) {
    captureStorageVersionFailure(e);
    void safeLog("error", "[sw-startup] storage version gate failed (refusing admission):", e);
    // Do NOT throw: keep the worker responsive so STATUS can surface the
    // failure to the panel. The per-domain gates above still fail closed on
    // every later read/mutation of the affected domain.
  }

  // STATUS and recovery can expose a persisted snapshot before the first run
  // starts. Prime the synchronous exact-value redactor behind the same startup
  // gate those handlers await, so ordinary snapshot text is not fail-closed
  // merely because this is a fresh worker incarnation.
  try {
    try { await migrateRememberedCredential(); } catch { /* retry via listener/next startup */ }
    await primeLiveSecretRedaction(await ensureApiKeyInSession());
  } catch {
    invalidateLiveSecretRedaction();
  }
  let runRecoveryFailed = false;
  let runRecoveryFailure: unknown;
  try {
    // Read both durability projections. A crash can land after the initial
    // snapshot write but before initRunState, leaving no active RunState at
    // all; treating that snapshot as a live run would authorize a zombie.
    const [state, persistedSnapshot] = await Promise.all([
      getRunState(),
      getPersistedRunSnapshot(),
    ]);
    const snapshotActive = persistedSnapshot && (
      persistedSnapshot.status === "starting" ||
      persistedSnapshot.status === "running" ||
      persistedSnapshot.status === "cancelling"
    );
    if (state?.active || snapshotActive) {
      const interruptedMessage =
        "Service worker was restarted mid-run. The previous run cannot be resumed — please start a new one.";
      // Make the terminal projection and content-side cutoff durable before
      // clearing RunState. This ordering closes the SW-restart action leak.
      const interrupted = await persistInterruptedRunSnapshot(state?.active ? state : null, interruptedMessage);
      try {
        const { broadcastRunCancellation } = await import("./tab-manager");
        await broadcastRunCancellation(interrupted);
      } catch {
        // The controller is gone, so failure to reach an individual tab can
        // never reopen background authority; the persisted terminal cutoff is
        // still the fail-closed source for subsequent recovery.
      }
      chrome.runtime
        .sendMessage({
          type: "AGENT_EVENT",
          event: {
            type: "error",
            step: interrupted.step,
            message: interruptedMessage,
            recoverable: false,
          },
          runId: interrupted.runId,
          revision: interrupted.revision,
          time: serializeEventTime(),
        })
        .catch(() => {
          /* side panel may not be open — non-fatal */
        });
      // Persist the notice for a panel that was closed during the restart:
      // the broadcast above is silently dropped when no panel is listening,
      // so the first log line after the restart would otherwise be lost. The
      // side panel renders + removes it on its next STATUS check;
      // `startRun` clears it for per-run isolation.
      try {
        await chrome.storage.session.set({ open_cowork_interrupted_notice: interruptedMessage });
      } catch {
        /* best-effort — the live broadcast still fires */
      }
      try { await persistInterruptedRunHistory(interrupted); } catch { /* best-effort history */ }
      await clearRunState();
    }
  } catch (e) {
    runRecoveryFailed = true;
    runRecoveryFailure = e;
    void safeLog("error", "[sw-startup] run-state check failed (alarms still armed below):", e);
  }
 // A keepalive alarm leaks when the SW dies mid-run: it is armed by
 // `initRunState` but only stopped by the run stop/cleanup paths, which an
 // interrupted run never reaches. chrome.alarms outlive the SW, so the leaked
 // alarm would keep firing (and keep the SW alive) forever. Every startup
 // implies any previous run is dead (its state was cleared above if it was
 // active), so clear the alarm unconditionally; `startRun` re-arms it for the
 // next run. A startRun racing this cleanup re-creates the alarm via
 // `chrome.alarms.create` (last-write-wins), mirroring the existing
 // clearRunState-on-startup pattern.
  try {
    await stopKeepalive();
  } catch (e) {
    void safeLog("error", "[sw-startup] failed to stop keepalive alarm:", e);
  }
 // re-arm all enabled scheduled-task alarms on SW startup. Alarms
 // persist across SW restarts, but re-arming is idempotent and ensures any
 // alarms that were cleared (e.g. by a browser crash) are restored. Runs
 // independently of the run-state read above.
  try {
    await initScheduledTasks();
  } catch (e) {
    void safeLog("error", "[sw-startup] failed to arm scheduled tasks:", e);
  }
 // (re)acquire the system keep-awake lock if any enabled scheduled
 // tasks exist. The lock doesn't persist across SW restarts (chrome.power
 // state is in-process), so a SW restart while scheduled tasks are armed
 // would leave the laptop free to sleep through the next alarm. Calling
 // `requestKeepAwake` here re-acquires the lock; it internally checks that
 // at least one enabled task exists (no-op otherwise). Runs independently of
 // the run-state read above.
  try {
    await requestKeepAwake();
  } catch (e) {
    void safeLog("error", "[sw-startup] failed to acquire keep-awake lock:", e);
  }
  if (runRecoveryFailed) throw runRecoveryFailure;
}

// Install the gate synchronously during module evaluation, before Chrome can
// dispatch RUN/STATUS to the listener registered above.
setRunRecoveryAudit(onServiceWorkerStartup());
