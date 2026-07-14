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
import { glyph } from "./glyphs";
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

/**
 * Tracks whether the static ".empty" placeholder has been removed, so we don't
 * re-query the DOM on every event (finding: per-event DOM scan + forced reflow).
 */
let emptyPlaceholderCleared = false;

/**
 * Cached `clientHeight` of the log container, refreshed by a ResizeObserver so
 * the auto-scroll check doesn't force a synchronous reflow read of `clientHeight`
 * on every event (finding: per-event DOM scan + forced reflow).
 */
let cachedClientHeight = 0;
if (typeof ResizeObserver !== "undefined" && typeof logEl !== "undefined") {
  cachedClientHeight = logEl.clientHeight;
  const ro = new ResizeObserver(() => { cachedClientHeight = logEl.clientHeight; });
  ro.observe(logEl);
}

interface AgentEventEnvelope {
  type: "AGENT_EVENT";
  event: LogEvent;
  time: string;
}

/** Format a token count with correct English pluralization (finding: log renderer
 * does not handle pluralization — avoids the ungrammatical "1 tokens"). */
function formatTokens(n: number): string {
  return `${n} ${n === 1 ? "token" : "tokens"}`;
}

// ─── Persistence ───────────────────────────────────────────────────────────

/**
 * Persist the current cost / token / log snapshot to chrome.storage.local
 * so the side panel can restore them if the user closes + reopens the panel
 * mid-run. Called from {@link addLogRow} (which fires on every AGENT_EVENT).
 * Best-effort — storage failures are non-fatal.
 */
/**
 * Coalesces per-event persistence into a single write ~500 ms after the last
 * event, so a high-frequency AGENT_EVENT stream doesn't serialize + write the
 * full (≤500-row) `logHistory` array to `chrome.storage.local` on every event
 * (finding: cost/token/log snapshot writes the full array per event). Still
 * best-effort — storage failures are non-fatal.
 */
let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persistRunTotals(): void {
  if (isRestoring) return; // skip during restore — see isRestoring docstring
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  if (persistTimer !== undefined) return; // a write is already scheduled
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    chrome.storage.local.set({
      [STORAGE_KEYS.costUsd]: totalCost,
      [STORAGE_KEYS.tokens]: totalTokens,
      [STORAGE_KEYS.log]: logHistory,
    }).catch(() => {
      /* best-effort persistence — storage may be unavailable */
    });
  }, 500);
}

/**
 * Reset the persisted cost / token / log snapshot. Called at the start of a
 * new run so counters don't carry over from a previous run.
 */
export function clearRunTotals(): void {
  if (persistTimer !== undefined) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  totalCost = 0;
  totalTokens = 0;
 // Reset the step counter too — otherwise a previous run that ended at step N
 // leaves `currentStep = N`, skewing the per-step cost projection
 // (`totalCost / currentStep`) until the new run's first navigator step
 // overwrites it (finding: currentStep never reset between runs).
  currentStep = 0;
  logHistory.length = 0;
  costLabel.textContent = "$0.0000";
  tokenLabel.textContent = formatTokens(0);
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
 // empty-state placeholder (once). Use a flag instead of re-querying the DOM
 // on every event (finding: per-event DOM scan + forced reflow).
  if (!emptyPlaceholderCleared) {
    const empty = logEl.querySelector(".empty");
    if (empty) empty.remove();
    emptyPlaceholderCleared = true;
  }

  let cls = "info";
  let label = "info";
  let icon = glyph("info");
  let body = "";

  switch (event.type) {
    case "run-start":
      cls = "info"; label = "start"; icon = glyph("play"); body = event.task;
      setTaskStatus("running");
      setLifecycle("thinking");
      break;
    case "planner-step":
      cls = "planner"; label = "planner"; icon = glyph("compass");
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
      cls = "step"; label = "step"; icon = glyph("chevron-right"); body = `Step ${event.step}`;
      setLifecycle("thinking");
      break;
    case "state":
      cls = "observe"; label = "observe"; icon = glyph("eye");
      body = `${event.elementCount} el · ${event.newElementCount} new · ${event.pageInfo}`;
      setLifecycle("thinking");
      break;
    case "thinking":
      cls = "reason"; label = "reason"; icon = glyph("sparkles");
      body = event.nextGoal || event.text || "";
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
      cls = "act"; label = `act ${event.index}/${event.total}`; icon = glyph("mouse-pointer");
      body = event.description || "";
      setLifecycle("acting");
      break;
    case "action-result":
      cls = event.success ? "ok" : "err"; label = event.name;
      icon = event.success ? glyph("check") : glyph("x"); body = event.message || "";
      setLifecycle(event.success ? "acting" : "error");
      break;
    case "budget-warning":
      cls = "err"; label = "budget"; icon = glyph("alert-triangle"); body = `${event.pct}% of steps used`;
      break;
    case "loop-warning":
      cls = "err"; label = "loop"; icon = glyph("alert-triangle"); body = `repeated ${event.count}x`;
      break;
    case "done":
      cls = event.success ? "ok" : "err"; label = "done";
      icon = event.success ? glyph("check-circle") : glyph("x"); body = event.text;
 // setRunning(false) MUST run BEFORE setTaskStatus — otherwise
 // setRunning's internal `setTaskStatus("pending")` overwrites the
 // "completed"/"failed" status the very next line sets, and the badge
 // never reflects completion. Order: disable buttons (setRunning) →
 // set badge (setTaskStatus) → set lifecycle icon (setLifecycle).
 // During restore replay (#10) suppress ALL of these side effects so
 // re-opening the panel mid-run doesn't re-disable the controls / rewrite
 // the final state / re-append thinking entries (finding: setLifecycle /
 // setTaskStatus fired unguarded during restore replay).
      if (!isRestoring) {
        setRunning(false);
        setTaskStatus(event.success ? "completed" : "failed");
        setLifecycle(event.success ? "done" : "error");
      }
      break;
    case "error":
      cls = "err"; label = "error"; icon = glyph("x"); body = event.message;
      if (!event.recoverable) {
 // Call setRunning(false) BEFORE setLifecycle("error") so the
 // running→idle transition doesn't clobber the error lifecycle.
 // Suppressed during restore replay (see done case above) — keep the
 // lifecycle icon in sync (cheap, idempotent) but skip the
 // control-disabling / badge-rewriting / thinking side effects.
        if (!isRestoring) {
          setRunning(false);
          setTaskStatus("failed");
          appendThinkingEntry("error", `Step ${event.step} · error`, event.message);
        }
        setLifecycle("error");
      } else {
        setLifecycle("error");
      }
      break;
    case "cost": {
      cls = "cost"; label = "cost"; icon = glyph("dollar-sign");
 // Validate the numeric payload BEFORE dereferencing it. A malformed cost
 // event (missing / non-numeric `costUsd`/`tokensIn`/`tokensOut`) would
 // throw on `event.costUsd.toFixed(4)` and crash the listener, or — worse
 // — poison `totalCost`/`totalTokens` with `NaN`, silently corrupting every
 // downstream metric. Skip + warn instead (see also the envelope guard in
 // the message listener below).
      const c = Number(event.costUsd);
      const ti = Number(event.tokensIn);
      const to = Number(event.tokensOut);
      if (!isFiniteCostEvent(event)) {
        body = "cost (invalid payload — skipped)";
        console.warn("[log-renderer] dropped malformed cost event (non-numeric costUsd/tokensIn/tokensOut)");
        break;
      }
      body = `${ti}+${to} tok · $${c.toFixed(4)}`;
 // Skip accumulation during restore — the stored totals are already correct
 // and the log may be truncated (capped at 500 rows), so rebuilding from
 // the log would under-count for long runs.
      if (!isRestoring) {
        totalCost += c;
        totalTokens += ti + to;
        costLabel.textContent = `$${totalCost.toFixed(4)}`;
        tokenLabel.textContent = formatTokens(totalTokens);
        updateCostProjection();
      }
      break;
    }
    case "info":
      cls = "info"; label = "info"; icon = glyph("info"); body = event.message || "";
      if (event.message === "Run finished.") setRunning(false);
      break;
    case "warn":
      cls = "warn"; label = "warn"; icon = glyph("alert-triangle"); body = event.message || "";
      break;
    case "compaction":
      cls = "info"; label = "compact"; icon = glyph("refresh-cw");
      body = `compacted ${event.compactedCount} steps`;
      break;
    case "challenge_detected":
      cls = "err"; label = "challenge"; icon = glyph("alert-triangle");
      body = `${event.kind}: ${event.message}`;
      setLifecycle("waiting");
 // Show the takeover banner so the user can solve the challenge +
 // click Resume — same UX as the takeover action. Suppressed during
 // restore replay (#10) so the banner doesn't re-pop for an already-
 // cleared challenge.
      if (!isRestoring) showTakeoverBanner(`Anti-bot challenge (${event.kind}): ${event.message}`);
      break;
    case "paused":
      cls = "info"; label = "paused"; icon = glyph("pause");
      body = "Agent paused by user";
      setLifecycle("waiting");
      break;
    case "resumed":
      cls = "info"; label = "resumed"; icon = glyph("play");
      body = "Agent resumed";
      setLifecycle("thinking");
 // Hide the takeover banner when the agent resumes — covers two cases:
 // 1. Challenge auto-resolved (orchestrator emits `resumed` after
 // `challenge_detected` → banner was shown, now needs hiding).
 // 2. User clicked Resume on the takeover banner (banner already
 // hidden by the click handler — this is a no-op).
 // `hideTakeoverBanner` is a no-op if the banner is already hidden.
 // Suppressed during restore replay (#10).
      if (!isRestoring) hideTakeoverBanner();
      break;
    case "takeover":
 // Show the takeover banner — the agent is paused waiting for the user.
      cls = "err"; label = "takeover"; icon = glyph("alert-triangle");
      body = `Paused: ${event.reason}`;
      setLifecycle("waiting");
 // Suppressed during restore replay (#10) so the banner doesn't re-pop
 // for an already-handled takeover.
      if (!isRestoring) showTakeoverBanner(event.reason);
      break;
    default: {
      try {
        body = JSON.stringify(event).slice(0, 100);
      } catch {
        body = "[unserializable event]";
      }
      break;
    }
  }

  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML =
    `<span class="t">${escapeHtml(time)}</span>` +
    `<span class="ic ${cls}" aria-hidden="true">${icon}</span>` +
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
 // scroll position if they're scrolled up reading history). Use the cached
 // `clientHeight` (refreshed by a ResizeObserver) so we only force a reflow
 // read of scrollHeight/scrollTop here, not of clientHeight too (finding:
 // per-event DOM scan + forced reflow).
  const nearBottom = logEl.scrollHeight - logEl.scrollTop - cachedClientHeight < 80;
  if (nearBottom) logEl.scrollTop = logEl.scrollHeight;

  if (event.type === "navigator-step-start") {
    currentStep = event.step;
    stepLabel.textContent = `step ${event.step} / ${maxSteps}`;
    const pct = Math.min(100, (event.step / maxSteps) * 100);
    barFill.style.width = `${pct}%`;
 // Keep the progressbar's ARIA value in sync with the visual width so
 // assistive tech reports the actual step. The `role="progressbar"` lives on
 // the parent `.bar`, so the value must be set there — not on the inner fill.
    barFill.parentElement?.setAttribute("aria-valuemin", "0");
    barFill.parentElement?.setAttribute("aria-valuemax", String(maxSteps));
    barFill.parentElement?.setAttribute("aria-valuenow", String(event.step));
    updateCostProjection();
  }
  if (event.type === "state") countLabel.textContent = `${event.elementCount} el`;
}

// ─── AGENT_EVENT listener ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: unknown, sender, _sendResponse) => {
 // Trust boundary — only accept messages from this extension (matches
 // the guard in human-interact.ts, content.ts, and background/message-routing.ts).
  if (sender.id !== chrome.runtime.id) return false;
  const payload = msg as Partial<AgentEventEnvelope>;
  if (payload?.type === "AGENT_EVENT") {
 // Validate the envelope at the trust boundary before dereferencing it
 // (finding: AGENT_EVENT envelope validation was shallow — only `type` +
 // `time`). A malformed envelope (no `event`, non-string `type`, or a
 // `cost` event with non-numeric fields) would throw inside `addLogRow`
 // and crash the listener, or poison the running totals with `NaN`.
 // Ignore it instead of forwarding it.
    if (isValidAgentEvent(payload.event) && typeof payload.time === "string") {
      addLogRow(payload.event as LogEvent, payload.time);
    } else {
      console.warn("[log-renderer] dropped malformed AGENT_EVENT envelope (missing/invalid event or time)");
    }
  }
  return false;
});

/**
 * Validate an incoming `AGENT_EVENT` payload at the message-passing trust
 * boundary (finding: payload not validated beyond sender id; envelope
 * validation too shallow). Ensures the `event` is a non-null object with a
 * string `type`, and — for `cost` events — that the numeric fields are finite
 * (a malformed cost event would otherwise crash `addLogRow` via `.toFixed` or
 * inject `NaN` into the totals).
 */
function isValidAgentEvent(ev: unknown): ev is LogEvent {
  if (typeof ev !== "object" || ev === null) return false;
  const e = ev as { type?: unknown };
  if (typeof e.type !== "string") return false;
  if (e.type === "cost" && !isFiniteCostEvent(ev)) return false;
  return true;
}

/**
 * True when a `cost` event's `costUsd` / `tokensIn` / `tokensOut` fields are all
 * finite numbers. Shared by the message-boundary validator and the in-row cost
 * handler so the two numeric checks can't drift.
 */
function isFiniteCostEvent(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const c = e as { costUsd?: unknown; tokensIn?: unknown; tokensOut?: unknown };
  return (
    Number.isFinite(Number(c.costUsd)) &&
    Number.isFinite(Number(c.tokensIn)) &&
    Number.isFinite(Number(c.tokensOut))
  );
}

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
    if (typeof s[STORAGE_KEYS.costUsd] === "number" && totalCost === 0) {
      totalCost = s[STORAGE_KEYS.costUsd] as number;
      costLabel.textContent = `$${totalCost.toFixed(4)}`;
    }
    if (typeof s[STORAGE_KEYS.tokens] === "number" && totalTokens === 0) {
      totalTokens = s[STORAGE_KEYS.tokens] as number;
      tokenLabel.textContent = formatTokens(totalTokens);
    }
    if (Array.isArray(s[STORAGE_KEYS.log]) && logHistory.length === 0) {
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
 // Route the restored rows through the same envelope validator used at
 // the live message boundary (finding: restore replay skipped validation
 // entirely, so a corrupt stored log could feed `addLogRow` unchecked
 // and render "undefined el · undefined new · undefined"). Drop invalid
 // stored rows rather than forwarding them.
          if (isValidAgentEvent(row.event) && typeof row.time === "string") {
            addLogRow(row.event, row.time);
          } else {
            console.warn("[log-renderer] dropped malformed restored AGENT_EVENT row");
          }
        }
      } finally {
        isRestoring = false;
      }
    }
  });
}
