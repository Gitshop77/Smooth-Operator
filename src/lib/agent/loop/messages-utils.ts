import type { HistoryItem, TabInfo } from "../types";
import { wrapUntrusted } from "../security";

/** Max chars of interactive-element text shipped to the navigator per step. */
export const ELEMENTS_TEXT_CHAR_CAP = 60_000;

/** Max chars of extracted content surfaced inline per action result. */
const EXTRACTED_CONTENT_INLINE_LIMIT = 2000;

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
  return plan.map((item, i) => {
    const marker = i === currentPlanItem
      ? "[>]"
      : i < (currentPlanItem ?? 0)
        ? "[x]"
        : "[ ]";
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
  let out = "";
  if (total > limit) {
    out += `<sys>[${total - limit} previous steps omitted]</sys>\n`;
  }
  for (const h of recent) {
    out += `<step_${h.step} agent="${h.agent}">\n`;
    if (h.evaluation) out += `Evaluation: ${wrapUntrusted(h.evaluation)}\n`;
    if (h.memory) out += `Memory: ${wrapUntrusted(h.memory)}\n`;
    if (h.goal) out += `Goal: ${wrapUntrusted(h.goal)}\n`;
    if (h.results.length) {
      out += `Action Results:\n`;
      for (const r of h.results) {
        out += `- ${r.action.type}: ${wrapUntrusted(r.message ?? "")}${r.success ? "" : " (FAILED)"}\n`;
        if (r.extractedContent) {
          out += `  Extracted: ${wrapUntrusted(r.extractedContent.slice(0, EXTRACTED_CONTENT_INLINE_LIMIT))}\n`;
        }
      }
    }
    out += `</step_${h.step}>\n`;
  }
  return out.trim();
}
