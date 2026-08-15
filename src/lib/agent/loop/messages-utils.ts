import type { HistoryItem, TabInfo } from "../types";
import { wrapUntrusted } from "../security";
import { getSecretSetVersion } from "../secrets";
import { BASE_OBS_ELEMENTS_CHARS } from "../prompts/prompt-token-budget";
import { escapeXml } from "./xml-escape";
import { redactKeyShapes } from "../key-shape-redact";

/** Max chars of interactive-element text shipped to the navigator per step —
 * derived from the observation-budget base cap (prompt-token-budget.ts) so it
 * can never drift from the budget module. The loop already truncates
 * elementsText to its per-step derived budget (≤ this base), so the fail-closed
 * slice in `buildNavigatorUserMessage` is unreachable by construction — kept
 * for hypothetical direct callers. */
export const ELEMENTS_TEXT_CHAR_CAP = BASE_OBS_ELEMENTS_CHARS;

/** Max chars of extracted content surfaced inline per action result. */
const EXTRACTED_CONTENT_INLINE_LIMIT = 8_500;

/** Max chars of a result message surfaced inline per action result (parity
 * with {@link EXTRACTED_CONTENT_INLINE_LIMIT}); a handler/model that stuffs
 * page dumps into the message cannot crowd the next observation out. */
const RESULT_MESSAGE_INLINE_LIMIT = 8_500;

/** Model-authored bookkeeping is prompted to be terse, but local/open models
 * can ignore that request and return paragraphs. Bound it at the render seam
 * (not the parser) so the action still executes and the full in-memory record
 * remains available to compaction, while one verbose turn cannot crowd the
 * next page observation out of a constrained context window. */
const EVALUATION_INLINE_LIMIT = 600;
const MEMORY_INLINE_LIMIT = 1600;
const GOAL_INLINE_LIMIT = 600;

function boundModelNote(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated verbose ${label}]`;
}

/**
 * Recent observations keep their full content; observations outside the
 * retention window render a structural placeholder ("what was called + args")
 * so context stays bounded without silently dropping the action history —
 * WebVoyager-style masking at the safe mid-capacity regime.
 */
const OBSERVATION_RETENTION_WINDOW = 2;

/** Max history items rendered inline in the navigator message. Shared by the
 * renderer (messages.ts) and the prompt-size stats (llm-calls.ts) so the
 * metric measures exactly what the model sees. */
export const NAVIGATOR_HISTORY_LIMIT = 12;

/** Max history items rendered inline in the planner message (mirrors
 * `PLANNER_HISTORY_LIMIT` in loop/messages.ts — the planner message builder's
 * rendered window). Kept here so the llm-calls prompt metrics measure the
 * SAME window the message builder ships. */
export const PLANNER_HISTORY_LIMIT = 8;

/** Max chars of the action-args placeholder rendered for stale observations. */
const STALE_ACTION_ARGS_LIMIT = 80;

/**
 * Stable-key-ordered, bounded render of an action's own enumerable params.
 *
 * The args render OUTSIDE `wrapUntrusted` (mid-line inside the `<step_…>`
 * block), so they are the one history channel that never passes through the
 * sanitizer: a model-echoed credential in an arg (a key-shaped token the task
 * text contained, echoed into `navigate(url=…)` / `evaluate(code=…)`) would
 * round-trip to the provider on every subsequent step, and a forged
 * `</step_…>` / `<` payload in an arg could break out of the step block.
 * Key-shape redaction (fail-closed: a throw masks the whole value) + XML
 * escaping close both channels at the render seam, mirroring the treatment
 * the message/extracted-content channels get from `redactHistoryForPrompt`.
 */
function actionArgsPlaceholder(action: { type: string }): string {
  const own = Object.entries(action)
    .filter(([k]) => k !== "type")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${escapeXml(redactKeyShapes(String(v)), true)}`)
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
 * Render a single history item as an XML-tagged `<step_…>` block. With
 * `inRetention` the item renders its full result content (message + extracted
 * content); otherwise the results degrade to the stale-observation structural
 * placeholder ("what was called + args") — see {@link renderHistory}.
 *
 * Exported so tests can drive/observe the per-item renderer directly.
 */
export function renderHistoryItem(h: HistoryItem, inRetention: boolean): string {
  const stepTag = escapeXml(String(h.step), true);
  let out = `<step_${stepTag} agent="${escapeXml(h.agent, true)}">\n`;
  if (inRetention) {
    // The model notes (Evaluation/Memory/Goal) ride along with the retained
    // observation; stale items mask them like the messages — otherwise a long
    // run ships up to ~2,800 chars of notes per stale step (the dominant
    // per-step prompt growth). The newest item always carries the current
    // Memory, so masking the older ones costs nothing but history.
    if (h.evaluation) out += `Evaluation: ${wrapUntrusted(boundModelNote(h.evaluation, EVALUATION_INLINE_LIMIT, "evaluation"))}\n`;
    if (h.memory) out += `Memory: ${wrapUntrusted(boundModelNote(h.memory, MEMORY_INLINE_LIMIT, "memory"))}\n`;
    if (h.goal) out += `Goal: ${wrapUntrusted(boundModelNote(h.goal, GOAL_INLINE_LIMIT, "goal"))}\n`;
  }
  if (h.results.length) {
    out += `Action Results:\n`;
    for (const r of h.results) {
      if (inRetention) {
        // Bound the message at the render seam (like extractedContent) so one
        // verbose result cannot crowd the next observation out of context.
        out += `- ${r.action.type}: ${wrapUntrusted(boundModelNote(r.message ?? "", RESULT_MESSAGE_INLINE_LIMIT, "result message"))}${r.success ? "" : " (FAILED)"}\n`;
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
  return out;
}

/**
 * Indirection `renderHistory` renders items through, so per-item render counts
 * stay observable in tests (`vi.spyOn(historyItemRenderer, "render")`). ESM
 * internal calls bind to the module-local function directly, which a spy on
 * the namespace export cannot intercept.
 */
export const historyItemRenderer: { render: typeof renderHistoryItem } = { render: renderHistoryItem };

/**
 * Incremental render memoization for {@link renderHistory}.
 *
 * The masked (stale-observation) serialization of an item depends only on the
 * item itself, and history items are stable object references across steps
 * (messages.ts's `redactHistoryForPrompt` memoizes the redacted item per
 * original identity + secret-set version, so the same redacted objects are
 * re-rendered on every step). Two layers:
 *
 * - `maskedItemRenderCache` — the masked serialization of each item, keyed by
 *   item identity + redaction version. A window slide re-renders only the one
 *   item that just left the retention window; everything else is a lookup.
 * - `prefixRenderCache` — the joined masked-prefix string, keyed by the
 *   covered item identities + redaction version. Reused only when the covered
 *   items are the SAME objects in the same positions, so an in-place history
 *   mutation (the loop pushes per step; compaction replaces the head via
 *   `length = 0` + push of the retained items) misses the cache and rebuilds.
 *
 * The `<sys>[N previous steps omitted]</sys>` header interpolates the TOTAL,
 * which grows every step — it is re-rendered per call and excluded from both
 * caches. The caches never see the header.
 */
interface MaskedItemEntry {
  version: number;
  text: string;
}
const maskedItemRenderCache = new WeakMap<HistoryItem, MaskedItemEntry>();
interface PrefixEntry {
  version: number;
  items: readonly HistoryItem[];
  text: string;
}
let prefixRenderCache: PrefixEntry | null = null;

/** Masked (stale-observation) render of `h`, memoized by identity + version. */
function renderMaskedItemCached(h: HistoryItem, version: number): string {
  const cached = maskedItemRenderCache.get(h);
  if (cached !== undefined && cached.version === version) return cached.text;
  const text = historyItemRenderer.render(h, false);
  maskedItemRenderCache.set(h, { version, text });
  return text;
}

/** Serialize the masked prefix items `[0, maskedCount)` of the window. */
function renderMaskedPrefix(recent: HistoryItem[], maskedCount: number, version: number): string {
  if (maskedCount <= 0) return "";
  const cached = prefixRenderCache;
  if (
    cached !== null
    && cached.version === version
    && cached.items.length === maskedCount
    && cached.items.every((it, i) => it === recent[i])
  ) {
    return cached.text;
  }
  let text = "";
  for (let i = 0; i < maskedCount; i++) text += renderMaskedItemCached(recent[i], version);
  prefixRenderCache = { version, items: recent.slice(0, maskedCount), text };
  return text;
}

/**
 * Render history items as XML-tagged blocks. Truncates to the last `limit`
 * items and emits a `<sys>` marker if older items were omitted.
 *
 * Keeps its exact signature and byte-identical output; internally the stable
 * masked prefix (all window items except the last OBSERVATION_RETENTION_WINDOW)
 * is memoized (see {@link renderMaskedPrefix}), so repeated renders of the
 * same window — the navigator/planner re-render the same redacted items every
 * step — skip the per-item serialization. Only the final 2 items (the
 * retention window, whose content is re-redacted per step anyway) re-render
 * per call, plus the single item that leaves the retention window when the
 * window slides.
 */
export function renderHistory(history: HistoryItem[], limit: number, total = history.length): string {
  if (history.length === 0) return "Agent initialized.";
  const recent = history.slice(-limit);
  // Stale-observation masking: only the last OBSERVATION_RETENTION_WINDOW
  // items render their full result content (message + extracted content);
  // older items keep the structural "what was called + args" placeholder.
  const retentionStart = Math.max(0, recent.length - OBSERVATION_RETENTION_WINDOW);
  const version = getSecretSetVersion();
  let out = "";
  if (total > limit) {
    out += `<sys>[${total - limit} previous steps omitted]</sys>\n`;
  }
  out += renderMaskedPrefix(recent, retentionStart, version);
  for (let i = retentionStart; i < recent.length; i++) {
    out += historyItemRenderer.render(recent[i], true);
  }
  return out.trim();
}
