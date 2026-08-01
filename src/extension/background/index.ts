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
import { getRunState, clearRunState, stopKeepalive, KEEPALIVE_ALARM, requestKeepAwake, safeLog } from "./state-store";
import { handleScheduledTaskFire } from "./task-queue";
import { registerRateLimitListener } from "./rate-limit-tracker";
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

// Warm the models.dev catalog (SDK snapshot + live /api.json refresh) so
// cost tracking uses current rates. pricing.ts no longer has a static table —
// rates come from the catalog. Lazy import keeps the (large) pricing module out
// of the critical path.
// NOTE: the catalog is sourced from @opencode-ai/models/snapshot and used
// offline-first; the live https://models.dev/api.json fetch is only a
// refresh/merge layer, so there is no runtime redistribution concern.
function warmPricingCatalog(): void {
  void import("../../lib/agent/llm/pricing")
    .then((m) => m.refreshPricingFromCatalog())
    .catch((e) => void safeLog("warn", "[pricing] live catalog refresh failed:", e));
}

// ─── Side panel wiring ──────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {
      /* setPanelBehavior can reject on unsupported Chrome versions — non-fatal */
    });

  warmPricingCatalog();
});

// On browser/extension startup (a more reliable trigger than onInstalled for
// resuming service-worker incarnations), also warm the catalog (bundled + live
// refresh).
chrome.runtime.onStartup.addListener(() => {
  warmPricingCatalog();
});

// ─── Live pricing: refresh when provider/model/apiKey/baseUrl changes ────────
// Best-effort: settings changes can alter which model is billable, so re-warm
// the catalog. Guard with a short throttle so a burst of storage writes
// (e.g. multiple key/value updates in one save) doesn't trigger redundant
// refreshes back-to-back.
let lastPricingRefreshAt = 0;
const PRICING_REFRESH_THROTTLE_MS = 2000;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" && area !== "sync") return;
  const relevant = Object.keys(changes).some((key) =>
    /^(?:provider|model|apiKey|api_key|baseUrl|base_url|endpoint)/i.test(key),
  );
  if (!relevant) return;

  const now = Date.now();
  if (now - lastPricingRefreshAt < PRICING_REFRESH_THROTTLE_MS) return;
  lastPricingRefreshAt = now;

  warmPricingCatalog();
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
  try {
    const state = await getRunState();
    if (state?.active) {
      const interruptedMessage =
        "Service worker was restarted mid-run. The previous run cannot be resumed — please start a new one.";
      chrome.runtime
        .sendMessage({
          type: "AGENT_EVENT",
          event: {
            type: "error",
            step: state.step,
            message: interruptedMessage,
            recoverable: false,
          },
          time: new Date().toLocaleTimeString("en-GB", { hour12: false }),
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
      await clearRunState();
    }
  } catch (e) {
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
}

void onServiceWorkerStartup();
