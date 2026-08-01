import type { ParsedKeys } from "../helpers";

/** Keys that represent navigation/selection rather than text content. */
const CARET_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
]);

/** Keys that change text content. */
const CONTENT_KEYS = new Set([
  "Backspace",
  "Delete",
]);

const NAMED_KEY_CODES: Record<string, number> = {
  Enter: 13,
  Escape: 27,
  Tab: 9,
  Backspace: 8,
  Delete: 46,
  ArrowLeft: 37,
  ArrowRight: 39,
  ArrowUp: 38,
  ArrowDown: 40,
  Home: 36,
  End: 35,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Meta: 91,
  CapsLock: 20,
  NumLock: 144,
  ScrollLock: 145,
  Insert: 45,
  PageUp: 33,
  PageDown: 34,
  F1: 112,
  F2: 113,
  F3: 114,
  F4: 115,
  F5: 116,
  F6: 117,
  F7: 118,
  F8: 119,
  F9: 120,
  F10: 121,
  F11: 122,
  F12: 123,
};

const SYMBOL_TO_PHYSICAL_CODE: Record<string, string> = {
  "!": "Digit1", "@": "Digit2", "#": "Digit3", "$": "Digit4", "%": "Digit5",
  "^": "Digit6", "&": "Digit7", "*": "Digit8", "(": "Digit9", ")": "Digit0",
  "_": "Minus", "+": "Equal", "{": "BracketLeft", "}": "BracketRight",
  "|": "Backslash", ":": "Semicolon", "\"": "Quote", "<": "Comma",
  ">": "Period", "?": "Slash", "~": "Backquote", "[": "BracketLeft",
  "]": "BracketRight", "\\": "Backslash", ";": "Semicolon", "'": "Quote",
  ",": "Comma", ".": "Period", "/": "Slash", "`": "Backquote",
  "-": "Minus", "=": "Equal",
};

const PHYSICAL_CODE_TO_KEYCODE: Record<string, number> = {
  Digit1: 49, Digit2: 50, Digit3: 51, Digit4: 52, Digit5: 53,
  Digit6: 54, Digit7: 55, Digit8: 56, Digit9: 57, Digit0: 48,
  Minus: 189, Equal: 187, BracketLeft: 219, BracketRight: 221,
  Backslash: 220, Semicolon: 186, Quote: 222, Comma: 188,
  Period: 190, Slash: 191, Backquote: 192,
};

export function keyEventCodes(key: string): { keyCode: number; which: number; code: string } {
  if (Object.hasOwn(NAMED_KEY_CODES, key)) {
    const kc = NAMED_KEY_CODES[key];
    return { keyCode: kc, which: kc, code: key };
  }
  if (key.length === 1) {
    const lower = key.toLowerCase();
    const isLetter = lower >= "a" && lower <= "z";
    const upper = key.toUpperCase();
    let code: string;
    let keyCode: number;
    if (key === " ") {
      code = "Space";
      keyCode = 32;
    } else if (isLetter) {
      code = `Key${upper}`;
      keyCode = upper.charCodeAt(0);
    } else if (key >= "0" && key <= "9") {
      code = `Digit${key}`;
      keyCode = key.charCodeAt(0);
    } else {
      const phys = SYMBOL_TO_PHYSICAL_CODE[key];
      code = phys ?? key;
      keyCode = phys
        ? PHYSICAL_CODE_TO_KEYCODE[phys] ?? key.charCodeAt(0)
        : key.charCodeAt(0);
    }
    return { keyCode, which: keyCode, code };
  }
  return { keyCode: 0, which: 0, code: "" };
}

export function isPrintableKey(parsed: ParsedKeys): boolean {
  if (parsed.ctrl || parsed.alt || parsed.meta) return false;
  const k = parsed.main;
  if (k.length !== 1) return false;
  if (CARET_KEYS.has(k) || CONTENT_KEYS.has(k)) return false;
  return k >= " " && k !== "\x7f";
}

export function isTextInput(
  el: EventTarget | null,
): el is HTMLInputElement | HTMLTextAreaElement {
  return (
    (typeof HTMLInputElement !== "undefined" && el instanceof HTMLInputElement) ||
    (typeof HTMLTextAreaElement !== "undefined" && el instanceof HTMLTextAreaElement)
  );
}

export function isEditableTarget(el: EventTarget | null): boolean {
  return (
    isTextInput(el) ||
    (typeof HTMLElement !== "undefined" && el instanceof HTMLElement && el.isContentEditable)
  );
}

let INPUT_VALUE_SETTER: ((v: string) => void) | undefined;
let TEXTAREA_VALUE_SETTER: ((v: string) => void) | undefined;

function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  if (INPUT_VALUE_SETTER === undefined) {
    INPUT_VALUE_SETTER = typeof HTMLInputElement !== "undefined"
      ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
      : undefined;
    TEXTAREA_VALUE_SETTER = typeof HTMLTextAreaElement !== "undefined"
      ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
      : undefined;
  }
  const setter = el instanceof HTMLTextAreaElement
    ? TEXTAREA_VALUE_SETTER
    : INPUT_VALUE_SETTER;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function safeSetSelectionRange(
  el: HTMLInputElement | HTMLTextAreaElement,
  start: number,
  end: number,
): void {
  try {
    el.setSelectionRange(start, end);
  } catch {
    /* input type doesn't support selection — leave caret as-is */
  }
}

function fireInputEvents(el: HTMLElement): void {
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function mutateTextInput(
  el: HTMLInputElement | HTMLTextAreaElement,
  parsed: ParsedKeys,
): boolean {
  const len = el.value.length;
  const start = el.selectionStart ?? len;
  const end = el.selectionEnd ?? len;
  // Clamp against the CURRENT value length at call time — `el.value.length` was
  // captured before the mutation, so clamping to the stale `len` would leave
  // the caret one short after an append-at-end keystroke.
  const setCaret = (s: number, e: number) =>
    safeSetSelectionRange(
      el,
      Math.max(0, Math.min(s, el.value.length)),
      Math.max(0, Math.min(e, el.value.length)),
    );

  if (isPrintableKey(parsed)) {
    const ch = parsed.main;
    const next = el.value.slice(0, start) + ch + el.value.slice(end);
    setNativeValue(el, next);
    const caret = start + ch.length;
    setCaret(caret, caret);
    fireInputEvents(el);
    return true;
  }

  if (parsed.main === "Backspace") {
    if (start === end && start > 0) {
      const next = el.value.slice(0, start - 1) + el.value.slice(end);
      setNativeValue(el, next);
      setCaret(start - 1, start - 1);
    } else if (start !== end) {
      const next = el.value.slice(0, start) + el.value.slice(end);
      setNativeValue(el, next);
      setCaret(start, start);
    } else {
      return false;
    }
    fireInputEvents(el);
    return true;
  }

  if (parsed.main === "Delete") {
    if (start === end && end < len) {
      const next = el.value.slice(0, start) + el.value.slice(end + 1);
      setNativeValue(el, next);
      setCaret(start, start);
    } else if (start !== end) {
      const next = el.value.slice(0, start) + el.value.slice(end);
      setNativeValue(el, next);
      setCaret(start, start);
    } else {
      return false;
    }
    fireInputEvents(el);
    return true;
  }

  if (CARET_KEYS.has(parsed.main) && parsed.main !== "ArrowUp" && parsed.main !== "ArrowDown") {
    switch (parsed.main) {
      case "ArrowLeft":
        if (parsed.shift) {
          setCaret(start - 1, end);
        } else {
          const pos = start === end ? start - 1 : start;
          setCaret(pos, pos);
        }
        break;
      case "ArrowRight":
        if (parsed.shift) {
          setCaret(start, end + 1);
        } else {
          const pos = start === end ? end + 1 : end;
          setCaret(pos, pos);
        }
        break;
      case "Home":
        parsed.shift ? setCaret(0, end) : setCaret(0, 0);
        break;
      case "End":
        parsed.shift ? setCaret(start, len) : setCaret(len, len);
        break;
    }
    document.dispatchEvent(new Event("selectionchange"));
    return true;
  }

  return false;
}

function mutateContentEditable(el: HTMLElement, parsed: ParsedKeys): boolean {
  let ok = false;
  if (isPrintableKey(parsed)) {
    ok = document.execCommand("insertText", false, parsed.main);
  } else if (parsed.main === "Backspace" || parsed.main === "Delete") {
    ok = document.execCommand("delete", false);
  }
  if (ok) fireInputEvents(el);
  return ok;
}

export function applyEditableMutation(target: HTMLElement, parsed: ParsedKeys): boolean {
  if (isTextInput(target)) return mutateTextInput(target, parsed);
  if (target.isContentEditable) return mutateContentEditable(target, parsed);
  return false;
}

export { CARET_KEYS, CONTENT_KEYS };
