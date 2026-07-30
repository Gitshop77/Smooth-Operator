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
} from "./elements";
import { setLifecycle } from "./lifecycle";
import { hideTakeoverBanner } from "./takeover";
import {
  addUserMessage,
  addSystemMessage,
  removeEmptyState,
} from "./chat-renderer";
import { restoreTotalsFromStorage, clearRunTotals } from "./log-renderer";

let running = false;
let stopDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let sendDebounceTimer: ReturnType<typeof setTimeout> | null = null;

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

function storageGet(keys: string | string[], area: "session" | "local"): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    (chrome.storage[area] as { get: (k: string | string[], cb: (r: Record<string, unknown>) => void) => void }).get(keys, resolve);
  });
}

function storageSet(items: Record<string, unknown>, area: "session" | "local"): Promise<void> {
  return new Promise((resolve) => {
    (chrome.storage[area] as { set: (v: Record<string, unknown>, cb: () => void) => void }).set(items, () => resolve());
  });
}

function runtimeSendMessage(msg: unknown): Promise<unknown> {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

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
      if (sendDebounceTimer) { clearTimeout(sendDebounceTimer); sendDebounceTimer = null; }
      addUserMessage(text);
      messageInput.value = "";
      setLifecycle("thinking");
      addSystemMessage("💬", "Clarification received, resuming task…", undefined);
      return;
    }

    // Guard: check that an API key is configured before sending.
    const localRes = await storageGet(["provider"], "local") as Record<string, unknown>;
    const provider = (localRes?.provider as string) || "";
    const key = provider ? `apiKey_${provider}` : "apiKey";
    const s = await storageGet([key], "local") as Record<string, unknown>;
    if (chrome.runtime.lastError || !s?.[key]) {
      if (sendDebounceTimer) { clearTimeout(sendDebounceTimer); sendDebounceTimer = null; }
      addSystemMessage(
        "⚠",
        "No API key configured. Open Settings to add your provider key."
      );
      return;
    }

    // Re-check running guard — a STATUS response may have set running=true
    // while the async storage.get was in flight.
    if (running) {
      if (sendDebounceTimer) { clearTimeout(sendDebounceTimer); sendDebounceTimer = null; }
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
      if (sendDebounceTimer) { clearTimeout(sendDebounceTimer); sendDebounceTimer = null; }
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
    if (chrome.runtime.lastError) {
      if (sendDebounceTimer) { clearTimeout(sendDebounceTimer); sendDebounceTimer = null; }
      const errMsg = (chrome.runtime as { lastError?: { message?: string } }).lastError?.message;
      addSystemMessage("❌", errMsg || "Failed to start");
      return;
    }
    if (!res?.ok) {
      if (sendDebounceTimer) { clearTimeout(sendDebounceTimer); sendDebounceTimer = null; }
      addSystemMessage("❌", res?.error || "Failed to start");
      return;
    }
    setRunning(true);
    clearRunTotals();
    if (sendDebounceTimer) { clearTimeout(sendDebounceTimer); sendDebounceTimer = null; }
  } catch {
    if (sendDebounceTimer) { clearTimeout(sendDebounceTimer); sendDebounceTimer = null; }
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
  sendBtn.disabled = !messageInput.value.trim() || running;
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
      stopBtn.disabled = false;
      addSystemMessage(
        "❌",
        `Stop failed: ${chrome.runtime.lastError.message || "extension context unavailable"}`
      );
      // The service worker is gone, so the run is actually dead. Reset to idle.
      setRunning(false);
      return;
    }
    if (stopDebounceTimer) { clearTimeout(stopDebounceTimer); stopDebounceTimer = null; }
    addSystemMessage("⏹", "Stopping after current step…");
    // Re-enable stop so the user can force-stop if the first was ignored.
    if (running) stopBtn.disabled = false;
  });
});

// ─── Mode selector ──────────────────────────────────────────────────────

modeSelect?.addEventListener("change", () => {
  if (modeSelect) setCurrentMode(modeSelect.value);
});

// ─── On panel open: STATUS check + restore persisted state ────────────────

interface StatusResponse {
  running?: boolean;
  state?: unknown;
}

let staleCheckTimer: ReturnType<typeof setTimeout> | null = null;

/** Called by log-renderer when any AGENT_EVENT arrives — cancels stale detection. */
export function onAgentEvent(): void {
  if (staleCheckTimer) {
    clearTimeout(staleCheckTimer);
    staleCheckTimer = null;
  }
}

chrome.runtime.sendMessage({ type: "STATUS" }, (res: StatusResponse) => {
  if (chrome.runtime.lastError) {
    console.warn("[sidepanel] STATUS failed:", chrome.runtime.lastError);
    return;
  }
  if (res?.running) {
    setRunning(true);
    clearRunTotals();
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
  restoreTotalsFromStorage();
});
