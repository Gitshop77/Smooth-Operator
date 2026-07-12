/**
 * Modifier-key parsing for `send_keys` — converts a key-combination string
 * like `"ctrl+shift+a"` or `"Enter"` into the main key + active modifiers.
 */

/**
 * Map of lowercase key aliases → canonical `KeyboardEvent.key` values.
 * Used for named / non-printable keys. Printable characters (letters, digits,
 * symbols) are passed through unchanged so their original case is preserved.
 */
const KEY_MAP: Record<string, string> = {
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

/**
 * Shift → symbol map. When a caller uses the explicit `shift+<key>` form for a
 * printable symbol (or a digit), we resolve the produced literal character so
 * `send_keys("shift+1")` actually types `!` and `send_keys("shift+=")` types
 * `+`. This is required because the synthetic `KeyboardEvent` dispatched by the
 * handler is a no-op for text insertion — the handler inserts `parsed.main`
 * imperatively, so `main` must already be the shifted character.
 */
const SHIFT_SYMBOLS: Record<string, string> = {
  "1": "!", "2": "@", "3": "#", "4": "$", "5": "%",
  "6": "^", "7": "&", "8": "*", "9": "(", "0": ")",
  "=": "+", "-": "_", "[": "{", "]": "}", "\\": "|",
  ";": ":", "'": "\"", ",": "<", ".": ">", "/": "?",
  "`": "~",
};

/** Names that denote modifiers — a combination whose main token is one of these
 * has no actual key to press (e.g. `"ctrl"`, `"shift"`). */
const MODIFIER_NAMES = new Set([
  "ctrl", "control", "shift", "alt", "meta", "cmd", "command",
]);

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
 * main key plus active modifiers.
 *
 * The **main key keeps its original case** (`"A"` stays `"A"`, `"F1"` stays
 * `"F1"`) — only the modifier tokens are lowercased for comparison, so
 * CamelCase `KeyboardEvent.key` values (`F1`–`F12`, `ContextMenu`, `CapsLock`,
 * …) survive intact. When the `shift` modifier is present and the main key is a
 * single printable character, the shifted symbol (or upper-cased letter) is
 * computed so the typed text is correct even though the synthetic
 * `KeyboardEvent` can't perform the insertion itself.
 */
export function parseKeys(keys: string): ParsedKeys {
  const rawParts = keys.split("+").map((p) => p.trim());
  // Modifier tokens are lowercased for case-insensitive matching.
  const modifiers = rawParts.slice(0, -1).map((p) => p.toLowerCase());
  // The main key is kept at its original case.
  const mainRaw = rawParts[rawParts.length - 1];

  // Reject input that resolves to no real key: empty / "+"-only (`""`,
  // `"ctrl+"`) or a bare modifier name (`"ctrl"`, `"shift"`). Without this,
  // `main` would be a modifier token (or "") and downstream handlers would
  // dispatch a meaningless `KeyboardEvent` as a silent no-op instead of
  // failing loudly.
  if (mainRaw === "" || MODIFIER_NAMES.has(mainRaw.toLowerCase())) {
    throw new Error(
      `parseKeys: invalid key combination "${keys}" — expected a non-modifier ` +
        `main key (e.g. "ctrl+a" or "Enter")`,
    );
  }

  const mainLower = mainRaw.toLowerCase();
  let main = KEY_MAP[mainLower] ?? mainRaw;
  const shift = modifiers.includes("shift");

  // Apply Shift to produce the correct literal character. This mirrors what a
  // real keypress would yield; the `send_keys` handler inserts `main`
  // imperatively, so it must already be the shifted symbol / upper-cased letter.
  if (shift && main.length === 1) {
    const shifted = SHIFT_SYMBOLS[main];
    if (shifted !== undefined) {
      main = shifted;
    } else if (main >= "a" && main <= "z") {
      main = main.toUpperCase();
    }
  }

  return {
    main,
    ctrl: modifiers.includes("ctrl") || modifiers.includes("control"),
    shift,
    alt: modifiers.includes("alt"),
    meta: modifiers.includes("meta") || modifiers.includes("cmd") || modifiers.includes("command"),
  };
}
