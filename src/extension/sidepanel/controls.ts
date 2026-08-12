/** Side-panel controls and snapshot reconciliation. */

import type { RunSnapshotV1 } from "@/extension/background/run-controller";
import {
  messageInput,
  sendBtn,
  stopBtn,
  modeSelect,
  currentMode,
  maxSteps,
  setCurrentMode,
  storageReady,
  runSummary,
  runTaskLabel,
  runPhaseLabel,
} from "./elements";
import { setLifecycle } from "./lifecycle";
import { announce } from "../accessibility";
import { hideTakeoverBanner } from "./takeover";
import { addUserMessage, addSystemMessage, removeEmptyState } from "./chat-renderer";
import { restoreTotalsFromStorage, clearRunTotals } from "./log-renderer";
import { registerAgentEventReconciler } from "./reconcile-port";
import { sanitizeLastError, storageGet, runtimeSendMessage } from "./controls-utils";
import { ensureApiKeyInSession } from "../api-key-storage";
import { resetKeepaliveBackoff } from "./keepalive";
import {
  beginLocalRun,
  failLocalRun,
  getRunViewState,
  hydrateLegacyStatus,
  hydrateRunSnapshot,
  isActiveStatus,
  isTerminalStatus,
  requestLocalCancellation,
  subscribeRunView,
  type RunViewState,
} from "./run-store";

interface StatusResponse {
  running?: boolean;
  state?: unknown;
  snapshot?: RunSnapshotV1;
}

interface StopResponse {
  ok?: boolean;
  status?: "cancelling" | "idle";
  snapshot?: RunSnapshotV1;
  error?: string;
}

const STOP_POLL_DELAYS_MS = [125, 250, 500, 1_000, 2_000] as const;
const RUN_SNAPSHOT_STORAGE_KEY = "open_cowork_run_snapshot_v1";

let running = false;
let stopPollingGeneration = 0;
let sendDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let staleCheckTimer: ReturnType<typeof setTimeout> | null = null;
let lastTerminalKey: string | null = null;
/** Module-level handle for the in-flight RUN timeout so Stop can cancel it. */
let pendingRunTimeout: ReturnType<typeof setTimeout> | null = null;
/** STATUS reconcile throttle: one round-trip per ~50ms under high event rates. */
let reconcileScheduled = false;
let reconcileAgain = false;

function clearSendDebounce(): void {
  if (sendDebounceTimer) {
    clearTimeout(sendDebounceTimer);
    sendDebounceTimer = null;
  }
}

function clearPendingRunTimeout(): void {
  if (pendingRunTimeout) {
    clearTimeout(pendingRunTimeout);
    pendingRunTimeout = null;
  }
}

function lifecycleFor(view: RunViewState): Parameters<typeof setLifecycle>[0] {
  if (view.status === "cancelling") return "cancelling";
  if (view.status === "cancelled") return "cancelled";
  if (view.status === "succeeded") return "done";
  if (view.status === "failed" || view.status === "interrupted") return "error";
  if (view.status === "starting") return "thinking";
  if (view.status === "running") return view.phase === "acting" ? "acting" : "thinking";
  return "idle";
}

function renderTerminalSnapshot(view: RunViewState): void {
  const snapshot = view.snapshot;
  if (!snapshot || !isTerminalStatus(view.status)) return;
  const message = view.resultText || view.terminalMessage || "Run finished.";
  const key = `${snapshot.runId}:${snapshot.revision}:${message}`;
  if (key === lastTerminalKey) return;
  lastTerminalKey = key;
  if (view.status === "succeeded") addSystemMessage("✅", message);
  else if (view.status === "cancelled") addSystemMessage("⏹", message, "warning");
  else addSystemMessage("❌", message, "error");
}

function renderRunView(view: RunViewState): void {
  running = isActiveStatus(view.status);
  if (view.status !== "idle") removeEmptyState();
  messageInput.disabled = running;
  // Never re-enable a blank Send button after terminal/error reconciliation.
  sendBtn.disabled = !storageReady || !messageInput.value.trim() || running;
  stopBtn.disabled = view.status !== "starting" && view.status !== "running";
  stopBtn.setAttribute("aria-label", view.status === "cancelling" ? "Cancellation in progress" : "Stop agent");
  if (!running) hideTakeoverBanner();
  setLifecycle(lifecycleFor(view));

  if (runSummary) runSummary.hidden = !view.task || view.status === "idle";
  if (runTaskLabel) {
    runTaskLabel.textContent = view.task;
    runTaskLabel.title = view.task;
  }
  if (runPhaseLabel) {
    const phase = view.phase ? `${view.phase} · step ${view.step ?? 0}` : "";
    runPhaseLabel.textContent = phase;
    runPhaseLabel.title = view.activeOperation ?? phase;
  }
  renderTerminalSnapshot(view);
}

subscribeRunView(renderRunView);

/**
 * Reconcile the background's durable projection in every open panel. Runtime
 * events are best-effort and a panel can miss the first event of a successor
 * run; session storage is the authoritative cross-panel recovery channel.
 */
export function handleRunSnapshotStorageChange(
  changes: { [key: string]: chrome.storage.StorageChange },
  areaName: string,
): boolean {
  if (areaName !== "session") return false;
  const change = changes[RUN_SNAPSHOT_STORAGE_KEY];
  return change ? hydrateRunSnapshot(change.newValue) : false;
}

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  handleRunSnapshotStorageChange(changes, areaName);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reconcileStatus(): Promise<StatusResponse | undefined> {
  // A resolved STATUS proves the worker is awake — keep the keepalive
  // backoff at its baseline.
  resetKeepaliveBackoff();
  const response = await runtimeSendMessage({ type: "STATUS" }) as StatusResponse | undefined;
  if (!response) return undefined;
  if (response.snapshot) hydrateRunSnapshot(response.snapshot);
  else hydrateLegacyStatus(Boolean(response.running));
  return response;
}

async function pollStopUntilReconciled(generation: number): Promise<void> {
  for (const delayMs of STOP_POLL_DELAYS_MS) {
    await delay(delayMs);
    if (generation !== stopPollingGeneration) return;
    try {
      const response = await reconcileStatus();
      if (!response || generation !== stopPollingGeneration) continue;
      const view = getRunViewState();
      if (isTerminalStatus(view.status) || !isActiveStatus(view.status)) return;
    } catch {
      // Keep the bounded reconciliation schedule; the final state is actionable.
    }
  }
  if (generation !== stopPollingGeneration || getRunViewState().status !== "cancelling") return;
  addSystemMessage(
    "⚠",
    "Cancellation has not been confirmed yet. Try Stop again or reload the extension if it remains stuck.",
    "warning",
  );
  // An explicit retry is more useful than a permanently disabled stop control.
  stopBtn.disabled = false;
  stopBtn.setAttribute("aria-label", "Retry Stop agent");
}

async function sendMessage(): Promise<void> {
  const text = messageInput.value.trim();
  if (!text || running || sendDebounceTimer) return;
  sendDebounceTimer = setTimeout(() => { sendDebounceTimer = null; }, 10_000);

  try {
    const localRes = await storageGet(["provider"], "local");
    const provider = (localRes?.provider as string) || "";
    const apiKeyValue = await ensureApiKeyInSession();
    if (!provider || !apiKeyValue) {
      clearSendDebounce();
      addSystemMessage("⚠", "No API key configured. Open Settings to add your provider key.");
      return;
    }
    if (running) {
      clearSendDebounce();
      return;
    }

    removeEmptyState();
    addUserMessage(text);
    messageInput.value = "";
    beginLocalRun(text);
    clearRunTotals();

    let responded = false;
    pendingRunTimeout = setTimeout(() => {
      pendingRunTimeout = null;
      if (responded) return;
      responded = true;
      clearSendDebounce();
      failLocalRun("No response from background — try reloading the extension");
      addSystemMessage("❌", "No response from background — try reloading the extension", "error");
    }, 10_000);

    const res = await runtimeSendMessage({ type: "RUN", task: text, maxSteps, mode: currentMode }) as {
      ok?: boolean; error?: string; snapshot?: RunSnapshotV1;
    } | undefined;
    if (responded) return;
    responded = true;
    clearPendingRunTimeout();
    clearSendDebounce();
    if (res?.snapshot) hydrateRunSnapshot(res.snapshot);
    if (!res?.ok) {
      const message = res?.error || "Failed to start";
      failLocalRun(message);
      addSystemMessage("❌", message, "error");
    } else if (!res.snapshot) {
      // Newer workers expose their authoritative snapshot through STATUS.
      // Reconcile immediately rather than waiting for a panel remount.
      void reconcileStatus().catch(() => undefined);
    }
  } catch (err) {
    clearSendDebounce();
    const message = `Send failed: ${sanitizeLastError(err instanceof Error ? err.message : undefined)}`;
    failLocalRun(message);
    addSystemMessage("❌", message, "error");
  }
}

sendBtn.addEventListener("click", () => { void sendMessage(); });
messageInput.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendMessage();
  }
});
messageInput.addEventListener("input", () => {
  sendBtn.disabled = !storageReady || !messageInput.value.trim() || running;
});

document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key !== "/" || e.ctrlKey || e.metaKey) return;
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
  if (document.activeElement === messageInput) return;
  e.preventDefault();
  messageInput.focus();
});

stopBtn.addEventListener("click", () => {
  if (stopBtn.disabled) return;
  void (async () => {
    requestLocalCancellation();
    // A user-initiated Stop must cancel the in-flight RUN timeout: the fake
    // "No response from background" failure must not fire after the user
    // already acted.
    clearPendingRunTimeout();
    addSystemMessage("⏹", "Cancellation requested immediately. Confirming with the agent…", "warning");
    const generation = ++stopPollingGeneration;
    try {
      const response = await runtimeSendMessage({ type: "STOP" }) as StopResponse | undefined;
      if (!response?.ok) throw new Error(response?.error || "Stop request failed");
      if (response.snapshot) hydrateRunSnapshot(response.snapshot);
      else if (response.status === "idle") hydrateLegacyStatus(false);
      if (response.status === "idle") {
        addSystemMessage("⏹", "No active run to cancel.", "warning");
        return;
      }
      void pollStopUntilReconciled(generation);
    } catch (err) {
      const message = sanitizeLastError(err instanceof Error ? err.message : undefined);
      addSystemMessage("❌", `Stop failed: ${message}`, "error");
      // STATUS is the source of truth after a failed STOP transport.
      try { await reconcileStatus(); } catch { /* retain actionable cancelling UI */ }
    }
  })();
});

// Phase 14 "no silent changes": a mode change is a safety-relevant control, so
// every user-initiated switch is announced (polite) with the exact mode label
// and, for the most capable mode, the consequence. Storage hydration / sync
// from another window never announces — only a real change event does.
const MODE_LABELS: Record<string, string> = {
  restricted: "Restricted",
  standard: "Standard",
  full_agentic: "Full agentic",
};

modeSelect?.addEventListener("change", () => {
  if (!modeSelect) return;
  setCurrentMode(modeSelect.value);
  const label = MODE_LABELS[modeSelect.value] ?? modeSelect.value;
  const consequence =
    modeSelect.value === "full_agentic"
      ? " — this mode can take irreversible actions on the page."
      : modeSelect.value === "restricted"
        ? " — actions on the page are blocked."
        : ".";
  announce(`Agent mode set to ${label}${consequence}`);
});

/** Called after an admitted AGENT_EVENT to cancel legacy stale detection. */
export function onAgentEvent(): void {
  if (staleCheckTimer) {
    clearTimeout(staleCheckTimer);
    staleCheckTimer = null;
  }
  // A versioned event is deliberately not a state mutation. Reconcile after
  // every admitted event — coalesced per microtask — and collapse bursts with
  // a trailing 50ms floor: while a reconcile is in flight, further events only
  // mark "reconcile again", and the follow-up runs once the burst settles.
  // Snapshots are versioned and idempotent, so convergence is unaffected.
  if (!reconcileScheduled) {
    reconcileScheduled = true;
    queueMicrotask(() => {
      void reconcileStatus()
        .catch(() => undefined)
        .finally(() => {
          reconcileScheduled = false;
          if (reconcileAgain) {
            reconcileAgain = false;
            setTimeout(() => onAgentEvent(), 50);
          }
        });
    });
  } else {
    reconcileAgain = true;
  }
}

registerAgentEventReconciler(onAgentEvent);

async function renderInterruptedRunNotice(): Promise<void> {
  try {
    const res = await storageGet(["open_cowork_interrupted_notice"], "session");
    const notice = res?.open_cowork_interrupted_notice;
    if (typeof notice !== "string" || !notice) return;
    addSystemMessage("⚠", notice, "error");
    if (chrome.storage?.session) await chrome.storage.session.remove("open_cowork_interrupted_notice");
  } catch { /* storage unavailable — non-fatal */ }
}

void (async () => {
  try {
    const response = await reconcileStatus();
    restoreTotalsFromStorage(); // legacy fallback; snapshots drive rich usage.
    void renderInterruptedRunNotice();
    if (response?.running && !response.snapshot) {
      staleCheckTimer = setTimeout(() => {
        staleCheckTimer = null;
        if (getRunViewState().status === "running") {
          addSystemMessage("⚠", "No response from agent — run may be stale. Check the page or reload the extension.", "warning");
        }
      }, 8_000);
    }
  } catch {
    // A later STATUS poll or live event can still hydrate the panel.
  }
})();
