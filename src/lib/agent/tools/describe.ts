/**
 * Produce a short human-readable description of an action for logs + UI display.
 * Truncates long string params so log lines stay readable.
 */
import type { AgentAction } from "../types";
import { LIMITS } from "./constants";

export function describeAction(a: AgentAction): string {
  switch (a.type) {
    case "click": return `click [${a.index}]`;
    case "input": return `type "${a.text.slice(0, 40)}" into [${a.index}]`;
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
    case "find_text": return `find "${a.text.slice(0, 30)}"`;
    case "extract": return `extract: ${a.query.slice(0, 40)}`;
    case "done": return `done (${a.success ? "success" : "incomplete"})`;
    case "search": return `search "${a.query}" (${a.engine ?? "duckduckgo"})`;
    case "upload_file": return `upload ${a.path} to [${a.index}]`;
    case "screenshot": return `screenshot${a.file_name ? ` → ${a.file_name}` : ""}`;
    case "save_as_pdf": return `save as PDF${a.file_name ? ` → ${a.file_name}` : ""}`;
    case "dropdown_options": return `list options of [${a.index}]`;
    case "search_page": return `search page for "${a.pattern}"`;
    case "find_elements": return `find elements "${a.selector}"`;
    case "evaluate": return `evaluate JS (${a.code.slice(0, 30)}…)`;
    case "hover": return `hover [${a.index}]`;
    case "press_and_hold": return `press_and_hold [${a.index}] (${a.hold_ms}ms)`;
    case "ask_human": return `ask_human: ${a.question.slice(0, LIMITS.describeSliceDefault)}`;
    case "takeover": return `takeover: ${a.reason.slice(0, LIMITS.describeSliceDefault)}`;
    case "verify": return `verify: ${a.expectation.slice(0, LIMITS.describeSliceDefault)}`;
    case "load_skill": return `load_skill: ${a.name}`;
    case "alert_accept": return "accept alert";
    case "alert_dismiss": return "dismiss alert";
    case "alert_get_text": return "get alert text";
    case "alert_send_keys": return `alert send_keys: ${a.text.slice(0, 40)}`;
    case "detect_visual": return `detect_visual: ${a.query.slice(0, LIMITS.describeSliceDefault)}`;
  }
}
