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
    case "extract":
    case "search":
    case "detect_visual":
      parts.push(`query=${field(a.query)}`);
      break;
    case "search_page":
      parts.push(`pattern=${field(a.pattern)}`);
      break;
    case "find_elements":
      parts.push(`selector=${field(a.selector)}`);
      break;
    case "evaluate":
      parts.push(`code=${field(a.code)}`);
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
