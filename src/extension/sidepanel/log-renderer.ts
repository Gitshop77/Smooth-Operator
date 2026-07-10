/**
 * sidepanel/log-renderer.ts — activity-log rendering + cost/token tracking.
 *
 * Appends each incoming `AGENT_EVENT` to the activity log as a colour-coded
 * row, updates the step progress bar / element count / cost totals, mirrors
 * the row into `logHistory` (persisted to chrome.storage.local so the panel
 * can restore on close/reopen mid-run), and dispatches lifecycle + takeover
 * side effects for the relevant event types.
 *
 * Exports `addLogRow`, `clearRunTotals`, and `restoreTotalsFromStorage` for
 * use by `controls.ts` (run/stop/pause buttons + STATUS check).
 */

import type { LogEvent } from "@/lib/agent/types";
import { escapeHtml } from "@/extension/shared";
import {
  logEl,
  costLabel,
  tokenLabel,
  stepLabel,
  barFill,
  countLabel,
  costProjectionEl,
  costPerStepEl,
  costCapInfoEl,
  maxSteps,
  costCapUsd,
  STORAGE_KEYS,
} from "./elements";
import { setTaskStatus, setLifecycle, appendThinkingEntry } from "./lifecycle";
import { showTakeoverBanner, hideTakeoverBanner } from "./takeover";
import { setRunning } from "./controls";

// ─── State (owned by this module) ───────────────────────────────────────────

let totalCost = 0;
let totalTokens = 0;
let currentStep = 0;

/**
 * In-memory mirror of the activity log kept in sync by {@link addLogRow}.
 * Capped so a long-running agent doesn't grow `chrome.storage.local`
 * unboundedly. Persisted to `STORAGE_KEYS.log` so the side panel can restore
 * the log across close/reopen cycles mid-run.
 */
const logHistory: Array<{ event: LogEvent; time: string }> = [];

/**
 * Guard flag set during {@link restoreTotalsFromStorage} so the per-row
 * `persistRunTotals()` call inside `addLogRow` doesn't fire N redundant
 * `chrome.storage.local.set()` writes (one per restored row) on every panel
 * open. The restore path reads the persisted snapshot as-is — re-persisting
 * it mid-restore is both wasteful and can trigger storage-quota warnings on
 * large logs (500 rows × full-array write per row).
 */
let isRestoring = false;

interface AgentEventEnvelope {
  type: "AGENT_EVENT";
  event: LogEvent;
  time: string;
}

// ─── Persistence ───────────────────────────────────────────────────────────

/**
 * Persist the current cost / token / log snapshot to chrome.storage.local
 * so the side panel can restore them if the user closes + reopens the panel
 * mid-run. Called from {@link addLogRow} (which fires on every AGENT_EVENT).
 * Best-effort — storage failures are non-fatal.
 */
function persistRunTotals(): void {
  if (isRestoring) return; // skip during restore — see isRestoring docstring
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  chrome.storage.local.set({
    [STORAGE_KEYS.costUsd]: totalCost,
    [STORAGE_KEYS.tokens]: totalTokens,
    [STORAGE_KEYS.log]: logHistory,
  }).catch(() => {
    /* best-effort persistence — storage may be unavailable */
  });
}

/**
 * Reset the persisted cost / token / log snapshot. Called at the start of a
 * new run so counters don't carry over from a previous run.
 */
export function clearRunTotals(): void {
  totalCost = 0;
  totalTokens = 0;
  logHistory.length = 0;
  costLabel.textContent = "$0.0000";
  tokenLabel.textContent = "0 tokens";
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  chrome.storage.local.set({
    [STORAGE_KEYS.costUsd]: 0,
    [STORAGE_KEYS.tokens]: 0,
    [STORAGE_KEYS.log]: [],
  }).catch(() => { /* best-effort */ });
}

// cost projection
/** A9: Update the cost-per-step projection + cost cap progress. */
function updateCostProjection(): void {
  if (!costProjectionEl || !costPerStepEl) return;
  if (currentStep > 0) {
    const perStep = totalCost / currentStep;
    costPerStepEl.textContent = `$${perStep.toFixed(4)}/step`;
    costProjectionEl.style.display = "";
  }
  if (costCapInfoEl && costCapUsd > 0) {
    const pct = Math.min(100, (totalCost / costCapUsd) * 100);
    costCapInfoEl.textContent = `cap: ${pct.toFixed(0)}% of $${costCapUsd.toFixed(2)}`;
  } else if (costCapInfoEl) {
    costCapInfoEl.textContent = "";
  }
}

// ─── Log rendering ─────────────────────────────────────────────────────────

/** Maximum number of rows kept in the activity log (older rows are pruned). */
const MAX_LOG_ROWS = 500;

/**
 * Append a single log event to the activity log as a colour-coded row.
 * Also updates the step progress bar, element count, and cost totals.
 */
export function addLogRow(event: LogEvent, time: string): void {
  // Don't clobber the whole log when the first row arrives — just remove the
  // empty-state placeholder.
  const empty = logEl.querySelector(".empty");
  if (empty) empty.remove();

  let cls = "info";
  let label = "info";
  let icon = "·";
  let body = "";

  switch (event.type) {
    case "run-start":
      cls = "info"; label = "start"; icon = "▸"; body = event.task;
      setTaskStatus("running");
      setLifecycle("thinking");
      break;
    case "planner-step":
      cls = "planner"; label = "planner"; icon = "🧠";
      body = event.decision + (event.goal ? " → " + event.goal : "");
      setLifecycle("thinking");
      appendThinkingEntry(
        "planner",
        `Step ${event.step} · planner`,
        `decision: ${event.decision}` +
        (event.goal ? `\ngoal: ${event.goal}` : "") +
        (event.plan?.length ? `\nplan: ${event.plan.join(" → ")}` : ""),
      );
      break;
    case "navigator-step-start":
      cls = "step"; label = "step"; icon = "▸"; body = `Step ${event.step}`;
      setLifecycle("thinking");
      break;
    case "state":
      cls = "observe"; label = "observe"; icon = "👁";
      body = `${event.elementCount} el · ${event.newElementCount} new · ${event.pageInfo}`;
      setLifecycle("thinking");
      break;
    case "thinking":
      cls = "reason"; label = "reason"; icon = "🧠";
      body = event.nextGoal || event.text;
      setLifecycle("thinking");
      appendThinkingEntry(
        "navigator",
        `Step ${event.step} · navigator`,
        `goal: ${event.nextGoal}` +
        (event.evaluation ? `\neval: ${event.evaluation}` : "") +
        (event.memory ? `\nmemory: ${event.memory}` : "") +
        (event.text ? `\nthinking: ${event.text}` : ""),
      );
      break;
    case "action":
      cls = "act"; label = `act ${event.index}/${event.total}`; icon = "🖱";
      body = event.description;
      setLifecycle("acting");
      break;
    case "action-result":
      cls = event.success ? "ok" : "err"; label = event.name;
      icon = event.success ? "✓" : "✗"; body = event.message;
      setLifecycle(event.success ? "acting" : "error");
      break;
    case "budget-warning":
      cls = "err"; label = "budget"; icon = "⚠"; body = `${event.pct}% of steps used`;
      break;
    case "loop-warning":
      cls = "err"; label = "loop"; icon = "⚠"; body = `repeated ${event.count}x`;
      break;
    case "done":
      cls = event.success ? "ok" : "err"; label = "done";
      icon = event.success ? "✓" : "✗"; body = event.text;
      // setRunning(false) MUST run BEFORE setTaskStatus — otherwise
      // setRunning's internal `setTaskStatus("pending")` overwrites the
      // "completed"/"failed" status the very next line sets, and the badge
      // never reflects completion. Order: disable buttons (setRunning) →
      // set badge (setTaskStatus) → set lifecycle icon (setLifecycle).
      setRunning(false);
      setTaskStatus(event.success ? "completed" : "failed");
      setLifecycle(event.success ? "done" : "error");
      break;
    case "error":
      cls = "err"; label = "error"; icon = "✗"; body = event.message;
      if (!event.recoverable) {
        // Call setRunning(false) BEFORE setLifecycle("error") so the
        // running→idle transition doesn't clobber the error lifecycle.
        setRunning(false);
        setLifecycle("error");
        setTaskStatus("failed");
        appendThinkingEntry("error", `Step ${event.step} · error`, event.message);
      } else {
        setLifecycle("error");
      }
      break;
    case "cost": {
      cls = "cost"; label = "cost"; icon = "$";
      body = `${event.tokensIn}+${event.tokensOut} tok · $${event.costUsd.toFixed(4)}`;
      // Skip accumulation during restore — the stored totals are already correct
      // and the log may be truncated (capped at 500 rows), so rebuilding from
      // the log would under-count for long runs.
      if (!isRestoring) {
        totalCost += event.costUsd;
        totalTokens += event.tokensIn + event.tokensOut;
        costLabel.textContent = `$${totalCost.toFixed(4)}`;
        tokenLabel.textContent = `${totalTokens} tokens`;
        updateCostProjection();
      }
      break;
    }
    case "info":
      cls = "info"; label = "info"; icon = "·"; body = event.message;
      if (event.message === "Run finished.") setRunning(false);
      break;
    case "compaction":
      cls = "info"; label = "compact"; icon = "↺";
      body = `compacted ${event.compactedCount} steps`;
      break;
    case "challenge_detected":
      cls = "err"; label = "challenge"; icon = "⚠";
      body = `${event.kind}: ${event.message}`;
      setLifecycle("waiting");
      // Show the takeover banner so the user can solve the challenge +
      // click Resume — same UX as the takeover action.
      showTakeoverBanner(`Anti-bot challenge (${event.kind}): ${event.message}`);
      break;
    case "paused":
      cls = "info"; label = "paused"; icon = "⏸";
      body = "Agent paused by user";
      setLifecycle("waiting");
      break;
    case "resumed":
      cls = "info"; label = "resumed"; icon = "▶";
      body = "Agent resumed";
      setLifecycle("thinking");
      // Hide the takeover banner when the agent resumes — covers two cases:
      //   1. Challenge auto-resolved (orchestrator emits `resumed` after
      //      `challenge_detected` → banner was shown, now needs hiding).
      //   2. User clicked Resume on the takeover banner (banner already
      //      hidden by the click handler — this is a no-op).
      // `hideTakeoverBanner` is a no-op if the banner is already hidden.
      hideTakeoverBanner();
      break;
    case "takeover":
      // Show the takeover banner — the agent is paused waiting for the user.
      cls = "err"; label = "takeover"; icon = "⚠";
      body = `Paused: ${event.reason}`;
      setLifecycle("waiting");
      showTakeoverBanner(event.reason);
      break;
    default:
      body = JSON.stringify(event).slice(0, 100);
  }

  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML =
    `<span class="t">${escapeHtml(time)}</span>` +
    `<span class="ic ${cls}">${icon}</span>` +
    `<span class="lb">${escapeHtml(label)}</span>` +
    `<span class="bd ${cls}">${escapeHtml(body)}</span>`;
  logEl.appendChild(row);

  // Cap log rows so a long-running agent doesn't accumulate unbounded DOM.
  while (logEl.children.length > MAX_LOG_ROWS) {
    logEl.firstElementChild?.remove();
  }

  // Mirror the row into logHistory + persist the cost/token/log snapshot so
  // the panel can restore them if the user closes + reopens it mid-run. The
  // cap matches MAX_LOG_ROWS so the persisted log and the on-screen log stay
  // in sync. (Before this fix, the side panel read these keys on reopen but
  // nothing ever wrote them — the restore path was dead.)
  logHistory.push({ event, time });
  while (logHistory.length > MAX_LOG_ROWS) {
    logHistory.shift();
  }
  persistRunTotals();

  // Only auto-scroll if the user is already near the bottom (don't yank the
  // scroll position if they're scrolled up reading history).
  const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80;
  if (nearBottom) logEl.scrollTop = logEl.scrollHeight;

  if (event.type === "navigator-step-start") {
    currentStep = event.step;
    stepLabel.textContent = `step ${event.step} / ${maxSteps}`;
    const pct = Math.min(100, (event.step / maxSteps) * 100);
    barFill.style.width = `${pct}%`;
    updateCostProjection();
  }
  if (event.type === "state") countLabel.textContent = `${event.elementCount} el`;
}

// ─── AGENT_EVENT listener ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: unknown, sender, _sendResponse) => {
  // Trust boundary — only accept messages from this extension (matches
  // the guard in human-interact.ts, content.ts, and background/message-routing.ts).
  if (sender.id !== chrome.runtime.id) return false;
  if ((msg as AgentEventEnvelope)?.type === "AGENT_EVENT") {
    addLogRow((msg as AgentEventEnvelope).event, (msg as AgentEventEnvelope).time);
  }
  return false;
});

// ─── Restore totals from storage (called by controls.ts STATUS check) ──────

/**
 * Restore the cost / token / log snapshot from chrome.storage.local. Called
 * by the STATUS check in `controls.ts` when the panel reopens mid-run so
 * counters + the log don't appear empty.
 */
export function restoreTotalsFromStorage(): void {
  // Restore counters / log history from storage (kept fresh on every event).
  chrome.storage.local.get([STORAGE_KEYS.costUsd, STORAGE_KEYS.tokens, STORAGE_KEYS.log], (s) => {
    if (chrome.runtime.lastError) return;
    if (typeof s[STORAGE_KEYS.costUsd] === "number") {
      totalCost = s[STORAGE_KEYS.costUsd] as number;
      costLabel.textContent = `$${totalCost.toFixed(4)}`;
    }
    if (typeof s[STORAGE_KEYS.tokens] === "number") {
      totalTokens = s[STORAGE_KEYS.tokens] as number;
      tokenLabel.textContent = `${totalTokens} tokens`;
    }
    if (Array.isArray(s[STORAGE_KEYS.log])) {
      // Clear any rows already in the DOM + in-memory mirror BEFORE replaying,
      // so the persisted log is rendered exactly once. Without this, every
      // STATUS check (fired on each panel open) would append a duplicate copy
      // on top of the existing log. The persisted cost/token counters above are
      // already restored, so clearing here does not lose them.
      logEl.innerHTML = "";
      logHistory.length = 0;
      // Set the restore guard so addLogRow's persistRunTotals() and cost
      // accumulation are both suppressed during this loop. The stored totals
      // set above are already correct — rebuilding from the log would
      // under-count for long runs (log is capped at 500 rows).
      isRestoring = true;
      try {
        for (const row of s[STORAGE_KEYS.log] as Array<{ event: LogEvent; time: string }>) {
          addLogRow(row.event, row.time);
        }
      } finally {
        isRestoring = false;
      }
    }
  });
}
