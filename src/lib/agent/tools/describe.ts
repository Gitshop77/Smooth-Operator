/**
 * Produce a short human-readable description of an action for logs + UI display.
 * Truncates long string params so log lines stay readable.
 *
 * All string truncations route through `LIMITS.describeSliceDefault` so a tuner
 * editing that single constant changes every action's display width consistently
 * (previously most cases hardcoded their own limits, so the constant only
 * affected the long free-text actions).
 */
import type { AgentAction } from "../types";
import { LIMITS } from "./constants";

const SLICE = LIMITS.describeSliceDefault;

/**
 * Truncate a value to {@link SLICE} chars for log display, appending "…" only
 * when actually cut. Returns "" for non-string values so a missing required
 * field (e.g. `a.text`) can never print a literal "undefined" into the log.
 */
function slice(s: unknown): string {
  return typeof s === "string" ? (s.length > SLICE ? `${s.slice(0, SLICE)}…` : s) : "";
}

export function describeAction(a: AgentAction): string {
  switch (a.type) {
    case "click": return `click [${a.index}]`;
    case "input": return `type "${slice(a.text)}" into [${a.index}]`;
    case "select_dropdown": {
 // `select_dropdown` accepts EITHER `text` (a visible option label)
 // OR `option_index` (a 0-based numeric index from `dropdown_options`).
 // The previous code unconditionally interpolated `a.text`, which prints
 // the literal string "undefined" when the caller used `option_index`.
 // Prefer `option_index` if it's a finite number; fall back to `text`.
      const idx = a.option_index;
      if (typeof idx === "number" && Number.isFinite(idx)) {
        return `select option #${idx} in [${a.index}]`;
      }
      const label = typeof a.text === "string" ? a.text : "(no value)";
      return `select "${label}" in [${a.index}]`;
    }
    case "scroll": return `scroll ${a.down === false ? "up" : "down"} ${a.pages} page(s)`;
    case "send_keys": return `press ${a.keys}`;
    case "navigate": return `navigate to ${a.url}${a.new_tab ? " (new tab)" : ""}`;
    case "switch_tab": return `switch to tab ${a.tab_id}`;
    case "close_tab": return `close tab ${a.tab_id}`;
    case "go_back": return "go back";
    case "wait": return `wait ${a.seconds}s`;
    case "find_text": return `find "${slice(a.text)}"`;
    case "extract": return `extract: ${slice(a.query)}`;
    case "done": return `done (${a.success ? "success" : "incomplete"})`;
    case "search": return `search "${a.query}" (${a.engine ?? "duckduckgo"})`;
    case "upload_file": return `upload ${a.path} to [${a.index}]`;
    case "screenshot": return `screenshot${a.file_name ? ` → ${a.file_name}` : ""}`;
    case "save_as_pdf": return `save as PDF${a.file_name ? ` → ${a.file_name}` : ""}`;
    case "dropdown_options": return `list options of [${a.index}]`;
    case "search_page": return `search page for "${a.pattern}"`;
    case "find_elements": return `find elements "${a.selector}"`;
    case "evaluate": return `evaluate JS (${slice(a.code)})`;
    case "hover": return `hover [${a.index}]`;
    case "press_and_hold": return `press_and_hold [${a.index}] (${a.hold_ms}ms)`;
    case "ask_human": return `ask_human: ${slice(a.question)}`;
    case "takeover": return `takeover: ${slice(a.reason)}`;
    case "verify": return `verify: ${slice(a.expectation)}`;
    case "load_skill": return `load_skill: ${a.name}`;
    case "alert_accept": return "accept alert";
    case "alert_dismiss": return "dismiss alert";
    case "alert_get_text": return "get alert text";
    case "alert_send_keys": return `alert send_keys: ${slice(a.text)}`;
    case "detect_visual": return `detect_visual: ${slice(a.query)}`;
    default:
 // Defensive: a new/unrecognized action type (or malformed action) must not
 // render the literal "undefined" into logs/UI. Keep this switch in sync with
 // the AgentAction union — this branch only catches genuinely unknown types.
      return `unknown action: ${String((a as { type?: unknown }).type ?? "?")}`;
  }
}
