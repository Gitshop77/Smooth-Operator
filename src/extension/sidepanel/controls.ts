/**
 * sidepanel/controls.ts — Message input + Stop button handlers + STATUS check.
 *
 * Owns the `running` flag (mutated only by `setRunning`), the stop-debounce
 * timer, and the message input/send button. The STATUS check (run on panel
 * open) restores the run state.
 *
 * NOTE: i18n / localization of these UI strings is currently OUT OF SCOPE —
 * all user-facing text is hardcoded English.
 */

import {
  messageInput,
  sendBtn,
  stopBtn,
  modeSelect,
  currentMode,
  maxSteps,
  setCurrentMode,
  storageReady,
} from "./elements";
import { setLifecycle } from "./lifecycle";
import { hideTakeoverBanner } from "./takeover";
import {
  addUserMessage,
  addSystemMessage,
  removeEmptyState,
} from "./chat-renderer";
import { restoreTotalsFromStorage, clearRunTotals } from "./log-renderer";
import {
  sanitizeLastError,
  storageGet,
  storageSet,
  runtimeSendMessage,
} from "./controls-utils";
import { ensureApiKeyInSession } from "../api-key-storage";

let running = false;
let stopDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let sendDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function clearSendDebounce(): void {
  if (sendDebounceTimer) {
    clearTimeout(sendDebounceTimer);
    sendDebounceTimer = null;
  }
}

// ─── Run/Stop UI ─────────────────────────────────────────────────────────

/** Toggle run/stop button state. */
export function setRunning(v: boolean): void {
  // Idempotent: if the running state isn't changing, don't reset lifecycle/status.
  if (running === v) return;
  running = v;
  sendBtn.disabled = v;
  messageInput.disabled = v;
  stopBtn.disabled = !v;
  // Hide the takeover banner whenever the run stops.
  if (!v) hideTakeoverBanner();
  // Sync the lifecycle icon to the new run state.
  setLifecycle(v ? "thinking" : "idle");
}

// ─── Message input ───────────────────────────────────────────────────────

async function sendMessage(): Promise<void> {
  const text = messageInput.value.trim();
  if (!text || running) return;

  // Debounce rapid-fire sends.
  if (sendDebounceTimer) return;
  sendDebounceTimer = setTimeout(() => { sendDebounceTimer = null; }, 500);

  try {
    // Check if we're in a clarify state — if so, send a CLARIFY message instead.
    const clarifyRes = await storageGet(["open_cowork_clarify"], "session") as Record<string, unknown>;
    const isClarifying = !!clarifyRes?.open_cowork_clarify;

    if (isClarifying) {
      await storageSet({ open_cowork_clarify_response: text }, "session");
      clearSendDebounce();
      addUserMessage(text);
      messageInput.value = "";
      setLifecycle("thinking");
      addSystemMessage("💬", "Clarification received, resuming task…");
      return;
    }

    // Guard: check that an API key is configured before sending. The provider
    // is saved to LOCAL storage; the API key lives in SESSION storage
    // (in-memory — never written to disk unless the user opted into
    // "remember on this device", in which case it is re-hydrated here).
    const localRes = await storageGet(["provider"], "local");
    const provider = (localRes?.provider as string) || "";
    const apiKeyValue = await ensureApiKeyInSession();
    if (!provider || !apiKeyValue) {
      clearSendDebounce();
      addSystemMessage(
        "⚠",
        "No API key configured. Open Settings to add your provider key."
      );
      return;
    }

    // Re-check running guard — a STATUS response may have set running=true
    // while the async storage.get was in flight.
    if (running) {
      clearSendDebounce();
      return;
    }

    removeEmptyState();
    addUserMessage(text);
    messageInput.value = "";

    // Timeout guard — if the service worker never responds, show error after 10s.
    let responded = false;
    const timeout = setTimeout(() => {
      if (responded) return;
      responded = true;
      clearSendDebounce();
      addSystemMessage("❌", "No response from background — try reloading the extension");
      setRunning(false);
    }, 10_000);

    // Send the task to the background service worker.
    const res = await runtimeSendMessage({
      type: "RUN",
      task: text,
      maxSteps,
      mode: currentMode,
    }) as { ok?: boolean; error?: string } | undefined;
    if (responded) return;
    responded = true;
    clearTimeout(timeout);
    if (!res?.ok) {
      clearSendDebounce();
      addSystemMessage("❌", res?.error || "Failed to start");
      return;
    }
    setRunning(true);
    clearRunTotals();
    clearSendDebounce();
  } catch {
    clearSendDebounce();
  }
}

sendBtn.addEventListener("click", sendMessage);

messageInput.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendMessage();
  }
});

messageInput.addEventListener("input", () => {
  sendBtn.disabled = !storageReady || !messageInput.value.trim() || running;
});

// ─── / keyboard shortcut to focus input ──────────────────────────────────

document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "/" && document.activeElement !== messageInput && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    messageInput.focus();
  }
});

// ─── Stop button ─────────────────────────────────────────────────────────

stopBtn.addEventListener("click", () => {
  // Debounce so a user double-clicking STOP doesn't fire multiple messages.
  if (stopDebounceTimer) return;
  stopDebounceTimer = setTimeout(() => { stopDebounceTimer = null; }, 1000);
  stopBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "STOP" }, () => {
    if (chrome.runtime.lastError) {
      stopDebounceTimer = setTimeout(() => { stopDebounceTimer = null; }, 1000);
      stopBtn.disabled = false;
      addSystemMessage(
        "❌",
        `Stop failed: ${sanitizeLastError((chrome.runtime as { lastError?: { message?: string } }).lastError?.message)}`
      );
      // The service worker is gone, so the run is actually dead. Reset to idle.
      setRunning(false);
      return;
    }
    if (stopDebounceTimer) { clearTimeout(stopDebounceTimer); stopDebounceTimer = null; }
    addSystemMessage("⏹", "Stopping after current step…");
    // Re-enable stop so the user can force-stop if the first was ignored.
    // Re-arm the debounce timer so rapid re-clicks are still throttled.
    if (running) {
      stopDebounceTimer = setTimeout(() => { stopDebounceTimer = null; }, 1000);
      stopBtn.disabled = false;
    }
  });
});

// ─── Mode selector ──────────────────────────────────────────────────────

modeSelect?.addEventListener("change", () => {
  // Guard required: narrowing of the imported binding does not flow into the
  // callback closure, so modeSelect is still typed `HTMLSelectElement | null`.
  if (modeSelect) setCurrentMode(modeSelect.value);
});

// ─── On panel open: STATUS check + restore persisted state ────────────────

interface StatusResponse {
  running?: boolean;
}

let staleCheckTimer: ReturnType<typeof setTimeout> | null = null;

/** Called by log-renderer when any AGENT_EVENT arrives — cancels stale detection. */
export function onAgentEvent(): void {
  if (staleCheckTimer) {
    clearTimeout(staleCheckTimer);
    staleCheckTimer = null;
  }
}

/**
 * Render + remove the persisted interrupted-run notice (written by the
 * service worker's startup handler when it restarted mid-run and the panel
 * was closed, so the live broadcast was dropped). Consumed exactly once —
 * removed from session storage after rendering so it can't resurface.
 */
async function renderInterruptedRunNotice(): Promise<void> {
  try {
    const res = await storageGet(["open_cowork_interrupted_notice"], "session");
    const notice = res?.open_cowork_interrupted_notice;
    if (typeof notice !== "string" || !notice) return;
    addSystemMessage("⚠", notice, "error");
    if (chrome.storage?.session) {
      await chrome.storage.session.remove("open_cowork_interrupted_notice");
    }
  } catch {
    /* storage unavailable — non-fatal */
  }
}

chrome.runtime.sendMessage({ type: "STATUS" }, (res: StatusResponse) => {
  if (chrome.runtime.lastError) {
    console.warn("[sidepanel] STATUS failed:", chrome.runtime.lastError);
    return;
  }
  // Restore the mid-run cost/token snapshot BEFORE anything can reset the
  // counters. (A fresh panel starts at 0 anyway, and run-start clears the
  // totals in addLogRow — never clear the persisted snapshot here, or a
  // panel reopened mid-run loses the accumulated totals.)
  restoreTotalsFromStorage();
  // Render + consume any persisted "service worker was restarted mid-run"
  // notice. The notice is written to session storage when the SW restarts
  // while the panel is closed (the live broadcast is dropped without a
  // listener), so the first log line after a restart is not lost.
  void renderInterruptedRunNotice();
  if (res?.running) {
    setRunning(true);
    // If no AGENT_EVENT arrives within 8s, the run is likely stale
    // (service worker died, left active:true in session storage).
    if (staleCheckTimer) clearTimeout(staleCheckTimer);
    staleCheckTimer = setTimeout(() => {
      staleCheckTimer = null;
      if (running) {
        addSystemMessage("⚠", "No response from agent — run may be stale. Resetting to idle.");
        setRunning(false);
      }
    }, 8_000);
  }
});
