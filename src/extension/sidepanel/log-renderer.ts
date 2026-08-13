/**
 * sidepanel/log-renderer.ts — AGENT_EVENT handling + cost/token tracking.
 *
 * Receives AGENT_EVENT messages from the background service worker and
 * renders them as chat messages, updates cost/token totals, and dispatches
 * lifecycle + takeover side effects.
 *
 * Exports `clearRunTotals` and `restoreTotalsFromStorage` for use by
 * `controls.ts` (STATUS check).
 */

import type { LogEvent } from "@/lib/agent/types";
import {
  costLabel,
  tokenLabel,
  statusCenter,
  STORAGE_KEYS,
} from "./elements";
import {
  addSystemMessage,
  addAssistantMessage,
  addLLMCallStart,
  updateLLMCallProgress,
  finishLLMCall,
  addReasoningActivity,
  addPlannerActivity,
  addActionActivity,
  finishActionActivity,
  addJudgeActivity,
  resetActivityRenderState,
} from "./chat-renderer";
import { showTakeoverBanner, hideTakeoverBanner } from "./takeover";
import { requestAgentEventReconciliation } from "./reconcile-port";
import { formatTokens, isValidAgentEvent } from "./log-renderer-utils";
import { applyRunEvent, type EventVersion } from "./run-store";
import { announce } from "../accessibility";
import { resetKeepaliveBackoff } from "./keepalive";

// ─── State (owned by this module) ───────────────────────────────────────────

let totalCost = 0;
let totalTokens = 0;
let totalsRestored = false;
let restoreGeneration = 0;
/** Trailing debounce for the cost/token storage IPC (one write per burst). */
let costStorageTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleCostStorageWrite(): void {
  if (costStorageTimer) return;
  costStorageTimer = setTimeout(() => {
    costStorageTimer = null;
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      void chrome.storage.local.set({
        [STORAGE_KEYS.costUsd]: totalCost,
        [STORAGE_KEYS.tokens]: totalTokens,
      });
    }
  }, 300);
}

// ─── Persistence ───────────────────────────────────────────────────────────

/**
 * Reset the persisted cost / token snapshot. Called at the start of a
 * new run so counters don't carry over from a previous run.
 */
export function clearRunTotals(): void {
  resetActivityRenderState();
  totalCost = 0;
  totalTokens = 0;
  totalsRestored = true;
  // Invalidate any in-flight restore so a stale snapshot can't be applied
  // after the counters were reset (restoreGeneration is re-checked in the
  // restore callback).
  restoreGeneration++;
  costLabel.textContent = "$0.0000";
  if (tokenLabel) tokenLabel.textContent = formatTokens(0);
  // Clear persisted snapshot so restoreTotalsFromStorage doesn't read stale
  // values from a prior run back into the fresh counters. Setting
  // totalsRestored = true above ensures any in-flight restore skips its read.
  void chrome.storage.local.remove([STORAGE_KEYS.costUsd, STORAGE_KEYS.tokens]);
}

/**
 * Drive the cost/token display from an authoritative snapshot usage. Unlike
 * per-event accumulation, this makes the totals correct even when the panel
 * opened mid-run and missed earlier `cost` events.
 */
export function setRunTotalsFromUsage(usage: { tokensIn: number; tokensOut: number; costUsd: number }): void {
  totalCost = Number(usage.costUsd) || 0;
  totalTokens = (Number(usage.tokensIn) || 0) + (Number(usage.tokensOut) || 0);
  totalsRestored = true;
  costLabel.textContent = `$${totalCost.toFixed(4)}`;
  if (tokenLabel) tokenLabel.textContent = formatTokens(totalTokens);
  scheduleCostStorageWrite();
}

// ─── Event rendering ──────────────────────────────────────────────────────

/**
 * Render an AGENT_EVENT as a chat message.
 */
export function addLogRow(event: LogEvent, time: string, version: EventVersion = {}): void {
  // Even a cross-run event that is not safe to render is evidence that this
  // panel may have missed an authoritative snapshot (for example, another
  // open side panel started the next run). Queue STATUS first, then retain
  // the transcript admission check below as the boundary against stale text.
  // Progress frames are ephemeral UI animation, not authoritative lifecycle
  // transitions. Re-requesting STATUS for every SSE chunk would create an IPC
  // storm and erase the efficiency gained by keeping them out of storage.
  // Durable snapshots already arrive through chrome.storage.session. STATUS
  // reconciliation is only useful at lifecycle boundaries; requesting it for
  // every reasoning/tool/cost row creates avoidable worker IPC on long runs.
  if (
    event.type === "run-start" || event.type === "done" ||
    (event.type === "error" && !event.recoverable) ||
    event.type === "paused" || event.type === "resumed" || event.type === "takeover"
  ) requestAgentEventReconciliation();
  // A live AGENT_EVENT proves the worker is awake — keep the keepalive
  // backoff at its baseline instead of climbing on a healthy worker.
  resetKeepaliveBackoff();
  if (!applyRunEvent(event, version)) return;
  let body = "";

  switch (event.type) {
    case "run-start":
      clearRunTotals();
      addSystemMessage("▶", `Task: ${event.task}`, undefined, time);
      break;
    case "planner-step":
      addPlannerActivity(event, time);
      break;
    case "navigator-step-start":
      // Agent-loop indices are zero-based; transcript numbering matches the
      // snapshot and history count that users see elsewhere.
      addSystemMessage("→", `Step ${event.step + 1}`, undefined, time);
      break;
    case "state":
      body = `${event.elementCount} elements · ${event.pageInfo}`;
      addSystemMessage("👁", body, undefined, time);
      break;
    case "thinking":
      if (event.text || event.evaluation || event.memory || event.nextGoal) {
        addReasoningActivity(event, time);
      }
      break;
    case "llm-call-start":
      addLLMCallStart(event, time);
      break;
    case "llm-call-progress":
      updateLLMCallProgress(event);
      break;
    case "llm-call-end":
      finishLLMCall(event, time);
      break;
    case "judge":
      addJudgeActivity(event, time);
      break;
    case "action":
      addActionActivity(event, time);
      break;
    case "action-result":
      finishActionActivity(event, time);
      break;
    case "visual-inspection": {
      const size = event.screenshotChars ? ` · ${Math.round(event.screenshotChars / 1024)} KB` : "";
      const icon = event.stage === "unavailable" ? "⚠" : "◉";
      addSystemMessage(icon, `Vision ${event.stage}${size} — ${event.message}`, event.stage === "unavailable" ? "warning" : undefined, time);
      break;
    }
    case "budget-warning":
      addSystemMessage("⚠", `${event.pct}% of steps used`, "warning", time);
      break;
    case "loop-warning":
      addSystemMessage("⚠", `Loop detected: repeated ${event.count}x`, "warning", time);
      break;
    case "done":
      addSystemMessage(
        event.success ? "✅" : "❌",
        event.success ? "Task completed!" : `Task failed: ${event.text}`,
        event.success ? undefined : "error",
        time,
      );
      if (event.success && event.text) addAssistantMessage(event.text, time);
      break;
    case "error": {
      const parts = [event.code ? `[${event.code}]` : null, event.recovery ?? null].filter(Boolean).join(" ");
      const text = `${event.message}${parts ? ` — ${parts}` : ""}`;
      if (!event.recoverable) {
        addSystemMessage("❌", text, "error", time);
        announce(text, { assertive: true });
      } else {
        addSystemMessage("⚠", text, "warning", time);
      }
      break;
    }
    case "cost": {
      const c = Number(event.costUsd);
      const ti = Number(event.tokensIn);
      const to = Number(event.tokensOut);
      if (!isFinite(c) || !isFinite(ti) || !isFinite(to)) {
        console.warn("[log-renderer] dropped malformed cost event");
        break;
      }
      totalCost += c;
      totalTokens += ti + to;
      if (costLabel) costLabel.textContent = `$${totalCost.toFixed(4)}`;
      if (tokenLabel) tokenLabel.textContent = formatTokens(totalTokens);
      // Persist (debounced) so restoreTotalsFromStorage() works on panel
      // reopen mid-run — a burst of cost events settles into one IPC write.
      scheduleCostStorageWrite();
      // Reveal telemetry on first cost event
      if (statusCenter) statusCenter.hidden = false;
      // Render EVERY LLM call as a compact per-call usage line (the user asked
      // for full event visibility). The run totals live in the usage panel.
      const parts = [`${formatTokens(ti)} in`, `${formatTokens(to)} out`];
      if (event.reasoningTokens) parts.push(`${formatTokens(event.reasoningTokens)} reasoning`);
      if (event.cachedInputTokens) parts.push(`${formatTokens(event.cachedInputTokens)} cache`);
      if (event.model) parts.push(event.model);
      addSystemMessage("⚡", `${parts.join(" · ")} · $${c.toFixed(4)}`, undefined, time);
      break;
    }
    case "info":
      addSystemMessage("ℹ", event.message || "", undefined, time);
      break;
    case "warn":
      addSystemMessage("⚠", event.message || "", undefined, time);
      break;
    case "compaction":
      addSystemMessage("↻", `Compacted ${event.compactedCount} steps`, undefined, time);
      break;
    case "challenge_detected":
      showTakeoverBanner(`Anti-bot challenge (${event.kind}): ${event.message}`);
      break;
    case "paused":
      addSystemMessage("⏸", "Agent paused by user", undefined, time);
      break;
    case "resumed":
      addSystemMessage("▶", "Agent resumed", undefined, time);
      hideTakeoverBanner();
      break;
    case "heartbeat":
      break; // internal keep-alive, not user-facing
    case "takeover":
      showTakeoverBanner(event.reason);
      break;
    default: {
      try {
        body = JSON.stringify(event).slice(0, 100);
      } catch {
        body = "[unserializable event]";
      }
      addSystemMessage("·", body, undefined, time);
      break;
    }
  }
}

// ─── AGENT_EVENT listener ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: unknown, sender) => {
  // Trust boundary — only accept messages from this extension (matches
  // the guard in human-interact.ts, content.ts, and background/message-routing.ts).
  // Reject messages from content scripts (sender.tab is set) so their
  // fire-and-forget AGENT_EVENT broadcasts don't get re-rendered.
  if (sender.id !== chrome.runtime.id) return false;
  if (sender.tab) return false;
  // Brave/Chromium includes the MV3 service worker URL in sender.url. The old
  // blanket rejection silently dropped every real background event while
  // URL-less test mocks passed. Admit only the exact packaged worker URL;
  // options/sidepanel/other extension pages remain rejected.
  if (sender.url && sender.url !== chrome.runtime.getURL("background.js")) return false;
  const payload = msg as {
    type?: string;
    event?: LogEvent;
    time?: string;
    runId?: unknown;
    revision?: unknown;
  };
  if (payload?.type === "AGENT_EVENT") {
    const hasVersionField = payload.runId !== undefined || payload.revision !== undefined;
    const validVersion = !hasVersionField ||
      (typeof payload.runId === "string" && typeof payload.revision === "number" && Number.isFinite(payload.revision));
    if (isValidAgentEvent(payload.event) && typeof payload.time === "string" && validVersion) {
      addLogRow(payload.event, payload.time, {
        ...(typeof payload.runId === "string" ? { runId: payload.runId } : {}),
        ...(typeof payload.revision === "number" ? { revision: payload.revision } : {}),
      });
    } else {
      console.warn("[log-renderer] dropped malformed AGENT_EVENT envelope");
    }
  }
  return false;
});

// ─── Restore totals from storage (called by controls.ts STATUS check) ──────

/**
 * Restore the cost / token snapshot from chrome.storage.local. Called
 * by the STATUS check in `controls.ts` when the panel reopens mid-run.
 */
export function restoreTotalsFromStorage(): void {
  if (totalsRestored) return;
  totalsRestored = true;
  const generation = restoreGeneration;
  chrome.storage.local.get([STORAGE_KEYS.costUsd, STORAGE_KEYS.tokens], (s) => {
    if (chrome.runtime.lastError) return;
    // A clearRunTotals() landing while the read was in flight must win.
    if (generation !== restoreGeneration) return;
    const storedCost = s[STORAGE_KEYS.costUsd];
    const storedTokens = s[STORAGE_KEYS.tokens];
    if (Number.isFinite(storedCost)) {
      totalCost = Math.max(totalCost, storedCost as number);
      costLabel.textContent = `$${totalCost.toFixed(4)}`;
    }
    if (Number.isFinite(storedTokens)) {
      totalTokens = Math.max(totalTokens, storedTokens as number);
      if (tokenLabel) tokenLabel.textContent = formatTokens(totalTokens);
    }
    if (Number.isFinite(storedCost) || Number.isFinite(storedTokens)) {
      if (statusCenter) statusCenter.hidden = false;
    }
  });
}
