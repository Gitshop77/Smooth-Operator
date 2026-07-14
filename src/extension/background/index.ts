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
import { getRunState, clearRunState, KEEPALIVE_ALARM, requestKeepAwake } from "./state-store";
import { handleScheduledTaskFire } from "./task-queue";
// Importing `./message-routing` registers the `chrome.runtime.onMessage`
// listener as a top-level side effect. The listener depends on `startRun`
// (from `./agent-bridge`), which depends on `./tab-manager` + `./state-store`.
// ES module evaluation order ensures every handler is wired before the SW
// becomes ready to receive messages.
import "./message-routing";

// Warm the live models.dev catalog so cost tracking uses live rates.
// pricing.ts no longer has a static table — rates come from the catalog.
// Lazy import keeps the (large) pricing module out of the critical path.
// NOTE: the catalog is fetched live at runtime (not bundled), so its current
// attribution/usage terms must be confirmed before any cached copy is
// redistributed (models.dev entry).
function warmPricingCatalog(): void {
  void import("../../lib/agent/llm/pricing")
    .then((m) => m.refreshPricingFromCatalog())
    .catch((e) => console.warn("[pricing] live catalog refresh failed:", e));
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
// resuming service-worker incarnations), also warm the live catalog.
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
  }
});

// ─── SW startup: notify if a previous run was interrupted ──────────────────

/**
 * On service worker startup, check whether a run was active when the previous
 * SW was killed. The async loop itself can't be resumed, but we notify the
 * side panel so it doesn't hang waiting for events. This MUST run AFTER the
 * `onMessage` listener is registered so a pending panel-open STATUS doesn't
 * race the startup logic.
 *
 * The body of this IIFE runs as a microtask after the synchronous module
 * evaluation finishes — by which point the `onMessage` listener (registered
 * by the `./message-routing` import above) is already in place.
 */
// On service worker startup, check whether a run was active when the previous
// SW was killed, re-arm scheduled-task alarms, and (re)acquire the keep-awake
// lock. Each concern is independent and wrapped in its own try/catch so a
// transient failure in one does not block the others.
async function onServiceWorkerStartup(): Promise<void> {
// The run-state notification and the alarm/keep-awake arming are independent
// concerns. A transient `getRunState()` rejection (quota exceeded, SW
// mid-teardown, Chrome bug) must NOT block `initScheduledTasks` /
// `requestKeepAwake` — otherwise scheduled-task alarms stay un-armed for this
// entire SW incarnation (the SW only self-heals on its next restart). So each
// concern is wrapped in its own try/catch.
  try {
    const state = await getRunState();
    if (state?.active) {
      chrome.runtime
        .sendMessage({
          type: "AGENT_EVENT",
          event: {
            type: "error",
            step: state.step,
            message:
              "Service worker was restarted mid-run. The previous run cannot be resumed — please start a new one.",
            recoverable: false,
          },
          time: new Date().toLocaleTimeString("en-GB", { hour12: false }),
        })
        .catch(() => {
          /* side panel may not be open — non-fatal */
        });
      await clearRunState();
    }
  } catch (e) {
    console.error("[sw-startup] run-state check failed (alarms still armed below):", e);
  }
 // re-arm all enabled scheduled-task alarms on SW startup. Alarms
 // persist across SW restarts, but re-arming is idempotent and ensures any
 // alarms that were cleared (e.g. by a browser crash) are restored. Runs
 // independently of the run-state read above.
  try {
    await initScheduledTasks();
  } catch (e) {
    console.error("[sw-startup] failed to arm scheduled tasks:", e);
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
    console.error("[sw-startup] failed to acquire keep-awake lock:", e);
  }
}

void onServiceWorkerStartup();
