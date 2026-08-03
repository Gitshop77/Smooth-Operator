import type { AgentAction } from "../types";

function field(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

export function normalizeAction(action: AgentAction): string {
  const a = action as Record<string, unknown>;
  const parts: string[] = [a.type as string];
  switch (a.type) {
    case "click":
    case "hover":
    case "dropdown_options":
      parts.push(`idx=${field(a.index)}`);
      break;
    case "upload_file":
      parts.push(`idx=${field(a.index)}`, `path=${field(a.path)}`);
      break;
    case "input":
      parts.push(`idx=${field(a.index)}`, `text=${field(a.text)}`);
      break;
    case "select_dropdown":
      parts.push(`idx=${field(a.index)}`, `text=${field(a.text)}`, `optidx=${a.option_index ?? -1}`);
      break;
    case "press_and_hold":
      parts.push(`idx=${field(a.index)}`, `hold=${a.hold_ms ?? 1500}`);
      break;
    case "scroll":
      parts.push(`dir=${a.down === false ? "up" : "down"}`, `pages=${a.pages ?? 1}`);
      break;
    case "scroll_to_bottom":
      parts.push(`delay=${a.delay_seconds ?? 0.4}`);
      break;
    case "send_keys":
      parts.push(`keys=${field(a.keys)}`);
      break;
    case "navigate":
      parts.push(`url=${field(a.url)}`);
      break;
    case "switch_tab":
    case "close_tab":
      parts.push(`tab=${field(a.tab_id)}`);
      break;
    case "find_text":
      parts.push(`text=${field(a.text)}`);
      break;
    case "wait_for_element":
      parts.push(`selector=${field(a.selector)}`, `state=${a.state ?? "visible"}`);
      break;
    case "wait_for_text":
      parts.push(`text=${field(a.text)}`);
      break;
    case "wait_for_url":
      parts.push(`url=${field(a.url)}`);
      break;
    case "wait_for_network_idle":
    case "enable_network_log":
    case "disable_network_log":
    case "get_network_log":
    case "clear_network_log":
    case "getclear_network_log":
    case "enable_console_log":
    case "disable_console_log":
    case "get_console_log":
    case "clear_console_log":
    case "getclear_console_log":
      break;
    case "extract":
    case "search":
    case "detect_visual":
      parts.push(`query=${field(a.query)}`);
      break;
    case "detect_challenge":
      parts.push(`scroll=${a.scroll_into_view ?? false}`);
      break;
    case "list_tabs":
      break;
    case "get_cookies":
      if (Array.isArray(a.urls) && a.urls.length > 0) {
        parts.push(`urls=${field(a.urls.join(","))}`);
      }
      break;
    case "set_cookie":
      parts.push(
        `name=${field(a.name)}`,
        `url=${field(a.url ?? "")}`,
        `domain=${field(a.domain ?? "")}`,
        `value=${field(a.value)}`,
      );
      break;
    case "delete_cookies":
      if (Array.isArray(a.urls) && a.urls.length > 0) {
        parts.push(`urls=${field(a.urls.join(","))}`);
      }
      if (a.all === true) {
        parts.push("all=true");
      }
      break;
    case "get_storage":
      parts.push(`type=${a.storage_type ?? "local"}`);
      break;
    case "set_storage":
      parts.push(`type=${a.storage_type ?? "local"}`, `key=${field(a.key)}`);
      break;
    case "clear_storage":
      parts.push(`type=${a.storage_type ?? "local"}`);
      if (Array.isArray(a.keys) && a.keys.length > 0) {
        parts.push(`keys=${field(a.keys.join(","))}`);
      }
      if (a.all === true) {
        parts.push("all=true");
      }
      break;
    case "search_page":
      parts.push(`pattern=${field(a.pattern)}`);
      break;
    case "find_elements":
      parts.push(`selector=${field(a.selector)}`);
      break;
    case "get_computed_style":
      parts.push(
        `idx=${field(a.index)}`,
        `props=${Array.isArray(a.properties) ? (a.properties as string[]).join(",") : ""}`,
      );
      break;
    case "get_page_info":
      break;
    case "page_next":
      parts.push(`offset=${field(a.offset)}`);
      break;
    case "evaluate":
      parts.push(`code=${field(a.code)}`);
      break;
    case "run_script":
      parts.push(`script=${field(a.script)}`);
      break;
    case "ask_human":
      parts.push(`question=${field(a.question)}`);
      break;
    case "takeover":
      parts.push(`reason=${field(a.reason)}`);
      break;
    case "verify":
      parts.push(`expectation=${field(a.expectation)}`);
      break;
    case "load_skill":
      parts.push(`name=${field(a.name)}`);
      break;
    case "alert_send_keys":
      parts.push(`text=${field(a.text)}`);
      break;
    case "screenshot":
    case "save_as_pdf":
      parts.push(`file=${field(a.file_name)}`);
      break;
  }
  return parts.join("|");
}
