import type { HistoryItem, TabInfo } from "../types";
import { wrapUntrusted } from "../security";
import { escapeXml } from "./xml-escape";

/** Max chars of interactive-element text shipped to the navigator per step. */
export const ELEMENTS_TEXT_CHAR_CAP = 60_000;

/** Max chars of extracted content surfaced inline per action result. */
const EXTRACTED_CONTENT_INLINE_LIMIT = 2000;

/**
 * Recent observations keep their full content; observations outside the
 * retention window render a structural placeholder ("what was called + args")
 * so context stays bounded without silently dropping the action history —
 * WebVoyager-style masking at the safe mid-capacity regime.
 */
const OBSERVATION_RETENTION_WINDOW = 3;

/** Max chars of the action-args placeholder rendered for stale observations. */
const STALE_ACTION_ARGS_LIMIT = 80;

/** Stable-key-ordered, bounded render of an action's own enumerable params. */
function actionArgsPlaceholder(action: { type: string }): string {
  const own = Object.entries(action)
    .filter(([k]) => k !== "type")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${String(v) ?? ""}`)
    .join(" ");
  if (own.length === 0) return "";
  const truncated = own.length > STALE_ACTION_ARGS_LIMIT
    ? own.slice(0, STALE_ACTION_ARGS_LIMIT) + "…"
    : own;
  return ` [${truncated}]`;
}

/** Format a single tab as a one-line summary for the LLM. */
export function formatTab(t: TabInfo): string {
  const rawTitle = t.title ?? "";
  const title = rawTitle.length > 40 ? rawTitle.slice(0, 40) + "…" : rawTitle;
  const label = t.label ?? "";
  const url = t.url ?? "";
  return `Tab ${t.id} (${label}): ${url} - ${title}`;
}

/** Render the plan as a checklist with `[>]` for the current item. */
export function renderPlan(plan: string[] | undefined, currentPlanItem: number | undefined): string {
  if (!plan || plan.length === 0) return "(no plan yet)";
  const current = currentPlanItem ?? 0;
  return plan.map((item, i) => {
    const marker = i === currentPlanItem ? "[>]" : i < current ? "[x]" : "[ ]";
    return `${marker} ${i}: ${wrapUntrusted(item)}`;
  }).join("\n");
}

/**
 * Render history items as XML-tagged blocks. Truncates to the last `limit`
 * items and emits a `<sys>` marker if older items were omitted.
 */
export function renderHistory(history: HistoryItem[], limit: number, total = history.length): string {
  if (history.length === 0) return "Agent initialized.";
  const recent = history.slice(-limit);
  // Stale-observation masking: only the last OBSERVATION_RETENTION_WINDOW
  // items render their full result content (message + extracted content);
  // older items keep the structural "what was called + args" placeholder.
  const retentionStart = Math.max(0, recent.length - OBSERVATION_RETENTION_WINDOW);
  let out = "";
  if (total > limit) {
    out += `<sys>[${total - limit} previous steps omitted]</sys>\n`;
  }
  for (let i = 0; i < recent.length; i++) {
    const h = recent[i];
    const inRetention = i >= retentionStart;
    const stepTag = escapeXml(String(h.step), true);
    out += `<step_${stepTag} agent="${escapeXml(h.agent, true)}">\n`;
    if (h.evaluation) out += `Evaluation: ${wrapUntrusted(h.evaluation)}\n`;
    if (h.memory) out += `Memory: ${wrapUntrusted(h.memory)}\n`;
    if (h.goal) out += `Goal: ${wrapUntrusted(h.goal)}\n`;
    if (h.results.length) {
      out += `Action Results:\n`;
      for (const r of h.results) {
        if (inRetention) {
          out += `- ${r.action.type}: ${wrapUntrusted(r.message ?? "")}${r.success ? "" : " (FAILED)"}\n`;
          if (r.extractedContent) {
            out += `  Extracted: ${wrapUntrusted(r.extractedContent.slice(0, EXTRACTED_CONTENT_INLINE_LIMIT))}\n`;
          }
        } else {
          // Stale observation: fixed structural placeholder (what was called +
          // args) instead of the full message/extracted content — the action
          // history stays, the token-heavy observation payload is masked.
          out += `- ${r.action.type}${actionArgsPlaceholder(r.action)}: (details omitted — older step)${r.success ? "" : " (FAILED)"}\n`;
        }
      }
    }
    out += `</step_${stepTag}>\n`;
  }
  return out.trim();
}
