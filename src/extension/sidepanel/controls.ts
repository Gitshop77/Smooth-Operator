/**
 * sidepanel/controls.ts — Run/Stop/Pause button handlers + STATUS check.
 *
 * Owns the `running` flag (mutated only by `setRunning`), the stop-debounce
 * timer, the pause flag, and the model-switch input/button. The STATUS check
 * (run on panel open) restores the run state + persisted totals via
 * `restoreTotalsFromStorage` (in `./log-renderer`).
 */

import {
  taskInput,
  runBtn,
  stopBtn,
  pauseBtn,
  stepLabel,
  barFill,
  logEl,
  liveDot,
  modelSwitchInput,
  modelSwitchBtn,
  currentMode,
  maxSteps,
} from "./elements";
import { setTaskStatus, setLifecycle, clearThinkingPanel } from "./lifecycle";
import { hideTakeoverBanner } from "./takeover";
import { addLogRow, clearRunTotals, restoreTotalsFromStorage } from "./log-renderer";

let running = false;
let stopDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let isPaused = false;

// ─── Run / Stop UI ─────────────────────────────────────────────────────────

/** Toggle run/stop button state and the live activity indicator. */
export function setRunning(v: boolean): void {
 // Idempotent: if the running state isn't changing, don't reset
 // lifecycle/status — this prevents the "Run finished." info event
 // from clobbering a done/error state set by the done/error handler.
  if (running === v) return;
  running = v;
  runBtn.disabled = v;
  stopBtn.disabled = !v;
 // Pause button is enabled only while running.
  if (pauseBtn) pauseBtn.disabled = !v;
  runBtn.textContent = v
    ? (chrome.i18n?.getMessage("running") || "Running…")
    : (chrome.i18n?.getMessage("run") || "Run");
  liveDot.classList.toggle("live", v);
 // enable the model switch input only while running
  if (modelSwitchInput) modelSwitchInput.disabled = !v;
  if (modelSwitchBtn) modelSwitchBtn.disabled = !v;
 // Hide the takeover banner whenever the run stops — a paused run that ends
 // (via done / error / user-stop) shouldn't keep the banner visible.
  if (!v) hideTakeoverBanner();
 // Reset the pause button + the local isPaused flag when the run stops OR
 // starts. Without resetting isPaused on new-run, the first Pause click on
 // a fresh run would toggle the stale `true` → `false` (no-op write) and the
 // agent wouldn't actually pause — the user had to click twice.
  if (pauseBtn) {
    pauseBtn.textContent = chrome.i18n?.getMessage("pause") || "Pause";
 // Keep the accessible name in lockstep with the visible label (finding:
 // pause button's accessible name never updates with its state). Localize
 // from the same i18n bundle as the visible label so screen-reader users
 // hear the label in their locale, not hardcoded English.
    pauseBtn.setAttribute(
      "aria-label",
      chrome.i18n?.getMessage("pause_agent") || "Pause agent"
    );
    pauseBtn.classList.remove("paused");
  }
  isPaused = false;
  if (!v) {
    chrome.storage.session.set({ open_cowork_paused: false }).catch(() => { /* best-effort */ });
  }
 // Sync the lifecycle icon + task badge to the new run state.
  setLifecycle(v ? "thinking" : "idle");
  setTaskStatus(v ? "running" : "pending");
 // NOTE: the reasoning (thinking) panel is intentionally NOT cleared here when
 // the run stops — clearing it would discard the reviewable reasoning history
 // after completion. The panel is cleared explicitly when a NEW run starts
 // (see the runBtn handler), so this only preserves history between a finished
 // run and the next one.
}

// ─── Mid-run model switching (S5) ───────────────────────────────────────────

modelSwitchBtn?.addEventListener("click", () => {
  const newModel = modelSwitchInput?.value.trim();
  if (!newModel) return;
  chrome.storage.local.set({ model: newModel }, () => {
    addLogRow({ type: "info", message: `Switched model to ${newModel} — takes effect next step.` }, "");
    if (modelSwitchInput) modelSwitchInput.value = "";
  });
});

// ─── Run / Stop buttons ────────────────────────────────────────────────────

interface RunResponse {
  ok: boolean;
  error?: string;
}

runBtn.addEventListener("click", () => {
  const task = taskInput.value.trim();
  if (!task) {
    taskInput.focus();
    return;
  }
 // Clear UI state + persisted counters (cost / tokens / log). Also resets
 // the in-memory logHistory so a fresh run starts from zero — the previous
 // run's persisted values in chrome.storage.local are overwritten.
  logEl.innerHTML = "";
  clearRunTotals();
  stepLabel.textContent = `step 0 / ${maxSteps}`;
  barFill.style.width = "0%";
  hideTakeoverBanner();
  clearThinkingPanel();
  setTaskStatus("pending");
 // clear any stale `open_cowork_paused` flag left over from a
 // previous run that was paused when the SW died (the orchestrator reads
 // this from chrome.storage.session between steps — a stale `true` would
 // start the new run already paused, requiring the user to click Pause
 // twice to actually pause). `setRunning(true)` does NOT clear this flag
 // (the `if (!v)` storage-write branch only fires on `setRunning(false)`),
 // so without this explicit clear here the new run inherits the pause
 // state of the dead run.
  if (typeof chrome !== "undefined" && chrome.storage?.session) {
    chrome.storage.session.set({ open_cowork_paused: false }).catch(() => { /* best-effort */ });
  }
  setRunning(true);
  chrome.runtime.sendMessage(
    {
      type: "RUN",
      task,
 // Send the actual configured maxSteps (was hardcoded to 100 before).
      maxSteps,
      mode: currentMode,
    },
    (res: RunResponse) => {
      if (chrome.runtime.lastError) {
        addLogRow(
          { type: "error", step: 0, message: chrome.runtime.lastError.message || "Failed to start", recoverable: false },
          ""
        );
        setRunning(false);
        return;
      }
      if (!res?.ok) {
        addLogRow(
          { type: "error", step: 0, message: res?.error || "Failed to start", recoverable: false },
          ""
        );
        setRunning(false);
      }
    }
  );
});

stopBtn.addEventListener("click", () => {
 // Debounce so a user double-clicking STOP doesn't fire multiple messages.
  if (stopDebounceTimer) return;
  stopDebounceTimer = setTimeout(() => { stopDebounceTimer = null; }, 1000);
  stopBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "STOP" }, () => {
    if (chrome.runtime.lastError) {
 // The STOP message couldn't be delivered (e.g. the SW crashed or the
 // extension context was invalidated). Re-enable the stop button and show
 // an error row so the user isn't locked out of both controls until the
 // panel is reloaded.
      stopBtn.disabled = false;
      addLogRow(
        {
          type: "error",
          step: 0,
          message: `Stop failed: ${chrome.runtime.lastError.message || "extension context unavailable"}`,
          recoverable: true,
        },
        ""
      );
      return;
    }
    addLogRow({ type: "info", message: "Stopping after current step…" }, "");
  });
});

// ─── Pause button ───────────────────────────────────────────────────────────
//
// Toggles a `paused` flag in chrome.storage.session. The orchestrator (via
// the background worker's `checkPaused` callback) reads this flag between
// steps and pauses the loop when it's true. Clicking Pause again (or clicking
// the existing Resume button on the takeover banner) clears the flag and the
// loop resumes.

pauseBtn?.addEventListener("click", () => {
  isPaused = !isPaused;
  if (pauseBtn) {
    pauseBtn.textContent = isPaused
      ? (chrome.i18n?.getMessage("resume") || "Resume")
      : (chrome.i18n?.getMessage("pause") || "Pause");
 // Update the accessible name in lockstep with the visible label (finding:
 // pause button's accessible name never updates with its state). This also
 // overrides the static aria-label declared in sidepanel.html at runtime.
 // Localize from the same i18n bundle as the visible label.
    pauseBtn.setAttribute(
      "aria-label",
      isPaused
        ? (chrome.i18n?.getMessage("resume_agent") || "Resume agent")
        : (chrome.i18n?.getMessage("pause_agent") || "Pause agent")
    );
    pauseBtn.classList.toggle("paused", isPaused);
  }
  chrome.storage.session.set({ open_cowork_paused: isPaused }, () => {
    if (chrome.runtime.lastError) {
      console.warn("[sidepanel] set paused flag failed:", chrome.runtime.lastError);
    }
  });
  if (isPaused) {
    addLogRow({ type: "info", message: "Pausing after current step…" }, "");
    setLifecycle("waiting");
  } else {
    addLogRow({ type: "info", message: "Resuming agent…" }, "");
    setLifecycle("thinking");
  }
});

// ─── On panel open: STATUS check + restore persisted state ──────────────────

interface StatusResponse {
  running?: boolean;
  state?: unknown;
}

// On panel open, check if a run is already active and restore persisted state.
chrome.runtime.sendMessage({ type: "STATUS" }, (res: StatusResponse) => {
  if (chrome.runtime.lastError) {
    console.warn("[sidepanel] STATUS failed:", chrome.runtime.lastError);
    return;
  }
  if (res?.running) setRunning(true);
 // Restore counters / log history from storage (kept fresh on every event).
  restoreTotalsFromStorage();
 // Restore the persisted pause state. Without this, reopening the panel
 // while the agent is paused shows "⏸ Pause" (resume button) but the agent
 // is actually paused — the user must click twice to resume (first click
 // sets isPaused=true→false, writes false; second click sets false→true).
 // Reading the persisted flag synchronizes the UI button with the actual state.
  chrome.storage.session.get(["open_cowork_paused"], (s) => {
    if (chrome.runtime.lastError) return;
    if (s?.open_cowork_paused === true && res?.running) {
      if (pauseBtn) {
        pauseBtn.textContent = chrome.i18n?.getMessage("resume") || "Resume";
 // Sync the accessible name when restoring a paused run on panel reopen.
        pauseBtn.setAttribute(
          "aria-label",
          chrome.i18n?.getMessage("resume_agent") || "Resume agent"
        );
        pauseBtn.classList.add("paused");
      }
      isPaused = true;
    }
  });
});
