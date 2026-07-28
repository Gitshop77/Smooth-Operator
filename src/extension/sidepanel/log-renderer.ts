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
import { redactKeyLeak } from "@/extension/shared";
import {
  costLabel,
  tokenLabel,
  STORAGE_KEYS,
} from "./elements";
import { setLifecycle } from "./lifecycle";
import {
  addSystemMessage,
} from "./chat-renderer";
import { showTakeoverBanner, hideTakeoverBanner } from "./takeover";
import { setRunning, onAgentEvent } from "./controls";

// ─── State (owned by this module) ───────────────────────────────────────────

let totalCost = 0;
let totalTokens = 0;
let totalsRestored = false;

/**
 * Format a token count with correct English pluralization.
 */
function formatTokens(n: number): string {
  return `${n} ${n === 1 ? "token" : "tokens"}`;
}

// ─── Persistence ───────────────────────────────────────────────────────────

/**
 * Reset the persisted cost / token snapshot. Called at the start of a
 * new run so counters don't carry over from a previous run.
 */
export function clearRunTotals(): void {
  totalCost = 0;
  totalTokens = 0;
  totalsRestored = true;
  costLabel.textContent = "$0.0000";
  tokenLabel.textContent = formatTokens(0);
  // Clear persisted snapshot so restoreTotalsFromStorage doesn't read stale
  // values from a prior run back into the fresh counters. Setting
  // totalsRestored = true above ensures any in-flight restore skips its read.
  void chrome.storage.local.remove([STORAGE_KEYS.costUsd, STORAGE_KEYS.tokens]);
}

// ─── Event rendering ──────────────────────────────────────────────────────

/**
 * Render an AGENT_EVENT as a chat message.
 */
export function addLogRow(event: LogEvent, time: string): void {
  onAgentEvent();
  let body = "";

  switch (event.type) {
    case "run-start":
      setLifecycle("thinking");
      clearRunTotals();
      addSystemMessage("▶", `Task: ${event.task}`, undefined, time);
      break;
    case "planner-step":
      setLifecycle("thinking");
      body = event.decision + (event.goal ? " → " + event.goal : "");
      addSystemMessage("🧭", body, undefined, time);
      break;
    case "navigator-step-start":
      setLifecycle("thinking");
      addSystemMessage("→", `Step ${event.step}`, undefined, time);
      break;
    case "state":
      setLifecycle("thinking");
      body = `${event.elementCount} elements · ${event.pageInfo}`;
      addSystemMessage("👁", body, undefined, time);
      break;
    case "thinking":
      setLifecycle("thinking");
      body = event.nextGoal || event.text || "";
      if (body) addSystemMessage("✦", body, undefined, time);
      break;
    case "action":
      setLifecycle("acting");
      body = event.description || "";
      addSystemMessage("🖱", `Action ${event.index}/${event.total}: ${body}`, undefined, time);
      break;
    case "action-result":
      setLifecycle(event.success ? "acting" : "error");
      body = event.message || "";
      addSystemMessage(event.success ? "✓" : "✗", `${event.name}: ${body}`, undefined, time);
      break;
    case "budget-warning":
      addSystemMessage("⚠", `${event.pct}% of steps used`, "warning", time);
      break;
    case "loop-warning":
      addSystemMessage("⚠", `Loop detected: repeated ${event.count}x`, "warning", time);
      break;
    case "done":
      setRunning(false);
      setLifecycle(event.success ? "done" : "error");
      addSystemMessage(
        event.success ? "✅" : "❌",
        event.success ? "Task completed!" : `Task failed: ${event.text}`,
        event.success ? undefined : "error",
        time,
      );
      break;
    case "error":
      if (!event.recoverable) {
        setRunning(false);
        setLifecycle("error");
        addSystemMessage("❌", event.message, "error", time);
      } else {
        setLifecycle("error");
        addSystemMessage("⚠", event.message, "warning", time);
      }
      break;
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
      costLabel.textContent = `$${totalCost.toFixed(4)}`;
      tokenLabel.textContent = formatTokens(totalTokens);
      // Persist so restoreTotalsFromStorage() works on panel reopen mid-run.
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        void chrome.storage.local.set({
          [STORAGE_KEYS.costUsd]: totalCost,
          [STORAGE_KEYS.tokens]: totalTokens,
        });
      }
      // Reveal telemetry on first cost event
      const center = document.getElementById("statusCenter");
      if (center) center.hidden = false;
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
      setLifecycle("waiting");
      showTakeoverBanner(`Anti-bot challenge (${event.kind}): ${event.message}`);
      break;
    case "paused":
      setLifecycle("waiting");
      addSystemMessage("⏸", "Agent paused by user", undefined, time);
      break;
    case "resumed":
      setLifecycle("thinking");
      addSystemMessage("▶", "Agent resumed", undefined, time);
      hideTakeoverBanner();
      break;
    case "heartbeat":
      break; // internal keep-alive, not user-facing
    case "takeover":
      setLifecycle("waiting");
      showTakeoverBanner(event.reason);
      break;
    default: {
      try {
        body = redactKeyLeak(JSON.stringify(event).slice(0, 100));
      } catch {
        body = "[unserializable event]";
      }
      addSystemMessage("·", body, undefined, time);
      break;
    }
  }
}

// ─── AGENT_EVENT listener ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: unknown, sender, _sendResponse) => {
  // Trust boundary — only accept messages from this extension (matches
  // the guard in human-interact.ts, content.ts, and background/message-routing.ts).
  // Reject messages from content scripts (sender.tab is set) so their
  // fire-and-forget AGENT_EVENT broadcasts don't get re-rendered.
  if (sender.id !== chrome.runtime.id) return false;
  if (sender.tab) return false;
  const payload = msg as { type?: string; event?: LogEvent; time?: string };
  if (payload?.type === "AGENT_EVENT") {
    if (isValidAgentEvent(payload.event) && typeof payload.time === "string") {
      addLogRow(payload.event, payload.time);
    } else {
      console.warn("[log-renderer] dropped malformed AGENT_EVENT envelope");
    }
  }
  return false;
});

/**
 * Validate an incoming AGENT_EVENT payload at the message-passing trust boundary.
 */
function isValidAgentEvent(ev: unknown): ev is LogEvent {
  if (typeof ev !== "object" || ev === null) return false;
  const e = ev as { type?: unknown };
  if (typeof e.type !== "string") return false;
  return true;
}

// ─── Restore totals from storage (called by controls.ts STATUS check) ──────

/**
 * Restore the cost / token snapshot from chrome.storage.local. Called
 * by the STATUS check in `controls.ts` when the panel reopens mid-run.
 */
export function restoreTotalsFromStorage(): void {
  if (totalsRestored) return;
  totalsRestored = true;
  chrome.storage.local.get([STORAGE_KEYS.costUsd, STORAGE_KEYS.tokens], (s) => {
    if (chrome.runtime.lastError) return;
    const storedCost = s[STORAGE_KEYS.costUsd];
    const storedTokens = s[STORAGE_KEYS.tokens];
    if (Number.isFinite(storedCost)) {
      totalCost = Math.max(totalCost, storedCost as number);
      costLabel.textContent = `$${totalCost.toFixed(4)}`;
    }
    if (Number.isFinite(storedTokens)) {
      totalTokens = Math.max(totalTokens, storedTokens as number);
      tokenLabel.textContent = formatTokens(totalTokens);
    }
    if (Number.isFinite(storedCost) || Number.isFinite(storedTokens)) {
      const center = document.getElementById("statusCenter");
      if (center) center.hidden = false;
    }
  });
}
