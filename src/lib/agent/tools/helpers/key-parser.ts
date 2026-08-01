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
  capslock: "CapsLock",
  insert: "Insert",
  contextmenu: "ContextMenu",
  printscreen: "PrintScreen",
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

/** Alias → canonical modifier name, so `control`/`cmd`/`command` collapse to
 * the same key as `ctrl`/`meta` and membership tests become O(1) Set lookups. */
const MODIFIER_ALIASES: Record<string, string> = {
  control: "ctrl",
  cmd: "meta",
  command: "meta",
};

/** Every raw token that may appear as a modifier (canonical names + aliases). */
const KNOWN_MODIFIERS = new Set<string>([
  ...MODIFIER_NAMES,
  ...Object.keys(MODIFIER_ALIASES),
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
 // Modifier tokens are lowercased for case-insensitive matching, then
 // normalized through the alias table (e.g. `control` → `ctrl`, `cmd` → `meta`).
  const modifiers = rawParts
    .slice(0, -1)
    .map((p) => p.toLowerCase())
    .filter((p) => p.length > 0);
  for (const m of modifiers) {
    if (!KNOWN_MODIFIERS.has(m)) {
      throw new Error(
        `parseKeys: unknown modifier "${m}" in "${keys}" — valid modifiers are ` +
          `ctrl/shift/alt/meta (and aliases control/cmd/command)`,
      );
    }
  }
  const modifierSet = new Set(modifiers.map((m) => MODIFIER_ALIASES[m] ?? m));
 // The main key is kept at its original case.
  let mainRaw = rawParts[rawParts.length - 1] ?? "";
 // A trailing `+` separator with nothing after it denotes a LITERAL "+"
 // key (e.g. `"+"` → just "+", `"ctrl++"` → Ctrl + "+"). Without this
 // special-case `keys.split("+")` yields an empty main token and we'd wrongly
 // reject a valid request to type a plus sign. The agent can also use the
 // `shift+=` form; both now work.
  if (mainRaw === "" && rawParts.length > 1) {
    mainRaw = "+";
  } else if (mainRaw.trim() === "") {
    mainRaw = " ";
  }

 // Reject input that resolves to no real key: a bare modifier name
 // (`"ctrl"`, `"shift"`) — or, after the literal-`+` fixup above, a still
 // empty main. Without this, `main` would be a modifier token and downstream
 // handlers would dispatch a meaningless `KeyboardEvent` as a silent no-op
 // instead of failing loudly. To type a literal "+", use `"+"` (or the
 // `shift+=` form); the error message now hints at that so a model emitting
 // `send_keys("+")` understands the intended workaround.
  if (mainRaw === "" || MODIFIER_NAMES.has(mainRaw.toLowerCase())) {
    throw new Error(
      `parseKeys: invalid key combination "${keys}" — expected a non-modifier ` +
        `main key (e.g. "ctrl+a" or "Enter"); to type a literal "+", use "+" or "shift+="`,
    );
  }

  const mainLower = mainRaw.toLowerCase();
  // Own-property lookup only: `KEY_MAP` is a plain object, so `"constructor"`
  // / `"toString"` would otherwise resolve through Object.prototype to garbage
  // and be treated as a real key name.
  let main = Object.hasOwn(KEY_MAP, mainLower) ? KEY_MAP[mainLower] : mainRaw;
  const shift = modifierSet.has("shift");

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
    ctrl: modifierSet.has("ctrl"),
    shift,
    alt: modifierSet.has("alt"),
    meta: modifierSet.has("meta"),
  };
}
