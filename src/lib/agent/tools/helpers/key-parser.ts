/**
 * Modifier-key parsing for `send_keys` — converts a key-combination string
 * like `"ctrl+shift+a"` or `"Enter"` into the main key + active modifiers.
 */

/** Map of lowercase key aliases → canonical `KeyboardEvent.key` values. */
export const KEY_MAP: Record<string, string> = {
  enter: "Enter",
  escape: "Escape",
  esc: "Escape",
  tab: "Tab",
  space: " ",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  backspace: "Backspace",
  delete: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

/** Parsed key combination: the main key + active modifiers. */
export interface ParsedKeys {
  main: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/**
 * Parse a key combination string like `"ctrl+shift+a"` or `"Enter"` into the
 * main key plus active modifiers. Modifier names are case-insensitive.
 */
export function parseKeys(keys: string): ParsedKeys {
  const parts = keys.toLowerCase().split("+").map((p) => p.trim());
  const modifiers = parts.slice(0, -1);
  const main = parts[parts.length - 1];
  return {
    main: KEY_MAP[main] ?? main,
    ctrl: modifiers.includes("ctrl") || modifiers.includes("control"),
    shift: modifiers.includes("shift"),
    alt: modifiers.includes("alt"),
    meta: modifiers.includes("meta") || modifiers.includes("cmd") || modifiers.includes("command"),
  };
}
