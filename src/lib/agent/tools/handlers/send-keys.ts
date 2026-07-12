/**
 * `send_keys` action handler.
 *
 * IMPORTANT — synthetic events do not mutate fields:
 * Browsers never apply *default actions* for synthetic (non-trusted)
 * `KeyboardEvent`s. So dispatching `keydown`/`keyup` to an `<input>`/`<textarea>`
 * does NOT change its `.value`: typing a character, `Backspace`, `Delete`,
 * `ArrowLeft`, etc. are all no-ops at the DOM level. The only path that ever
 * produced a real side effect was `Enter` → `form.requestSubmit()`.
 *
 * To make `send_keys` actually do something for the common text-editing keys,
 * we apply the equivalent edit imperatively (mirroring `input.ts`, which exists
 * precisely because value-setting must bypass React's tracked setter) and then
 * still dispatch the synthetic events so any key listeners fire. We also report
 * an honest `success`/`message` instead of claiming success for a no-op.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { TIMINGS, sleep } from "../constants";
import { type ParsedKeys, parseKeys } from "../helpers";
import type { ActionContext } from "./types";

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

/**
 * Shift-produced symbol for a base key (US-QWERTY). Used to recover the
 * literal character the user intended when a key combination like `shift+1`
 * is requested — the canonical parser lowercases the main key, so without
 * this we would insert the un-shifted character (`1` instead of `!`).
 */
const SHIFT_SYMBOLS: Record<string, string> = {
  "`": "~",
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
  "0": ")",
  "-": "_",
  "=": "+",
  "[": "{",
  "]": "}",
  "\\": "|",
  ";": ":",
  "'": "\"",
  ",": "<",
  ".": ">",
  "/": "?",
};

/**
 * Recover the literal character a `send_keys` with a single printable main key
 * was meant to insert, preserving original case and applying shift-produced
 * symbols. The canonical `parseKeys` lowercases the main key, so for typing we
 * re-derive the character from the raw `keys` string.
 *
 * Returns `null` when the input is not a single printable literal (special
 * keys like `Enter`/`ArrowLeft`/`Backspace`, or any combination carrying
 * Ctrl/Alt/Meta), in which case the caller falls back to `parsed.main`.
 */
function resolveLiteralChar(keys: string, parsed: ParsedKeys): string | null {
  if (parsed.ctrl || parsed.alt || parsed.meta) return null;
  const rawMain = keys.split("+").map((p) => p.trim()).pop() ?? "";
  if (rawMain.length !== 1) return null;
  // Letters: Shift → uppercase.
  if (/[a-z]/i.test(rawMain)) {
    return parsed.shift ? rawMain.toUpperCase() : rawMain.toLowerCase();
  }
  // Symbols: Shift → the shifted glyph (e.g. `shift+1` → `!`).
  if (parsed.shift && SHIFT_SYMBOLS[rawMain] !== undefined) {
    return SHIFT_SYMBOLS[rawMain];
  }
  return rawMain;
}

/**
 * A key is "printable" when it should insert a literal character. We exclude
 * known control keys and any combination carrying Ctrl/Alt/Meta, because those
 * are shortcuts (e.g. `ctrl+a` selects all) rather than typed text. A bare
 * `Shift` is allowed since it produces the intended upper-case/symbol char.
 */
function isPrintableKey(parsed: ParsedKeys): boolean {
  if (parsed.ctrl || parsed.alt || parsed.meta) return false;
  const k = parsed.main;
  if (k.length !== 1) return false;
  if (CARET_KEYS.has(k) || CONTENT_KEYS.has(k)) return false;
  // Reject control characters (e.g. "\n", "\t" keyed via weird input).
  return k >= " " && k !== "\x7f";
}

function isTextInput(
  el: EventTarget | null,
): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

function isEditableTarget(el: EventTarget | null): boolean {
  return isTextInput(el) || (el instanceof HTMLElement && el.isContentEditable);
}

function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  // Use the native prototype setter so React-controlled inputs sync state.
  const proto = el instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function fireInputEvents(el: HTMLElement): void {
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Apply the edit imperatively to an `<input>`/`<textarea>`. */
function mutateTextInput(
  el: HTMLInputElement | HTMLTextAreaElement,
  parsed: ParsedKeys,
  literal?: string,
): boolean {
  const len = el.value.length;
  const start = el.selectionStart ?? len;
  const end = el.selectionEnd ?? len;
  const setCaret = (s: number, e: number) =>
    el.setSelectionRange(
      Math.max(0, Math.min(s, len)),
      Math.max(0, Math.min(e, len)),
    );

  if (isPrintableKey(parsed)) {
    const ch = literal ?? parsed.main;
    const next = el.value.slice(0, start) + ch + el.value.slice(end);
    setNativeValue(el, next);
    const caret = start + ch.length;
    el.setSelectionRange(caret, caret);
    fireInputEvents(el);
    return true;
  }

  if (parsed.main === "Backspace") {
    if (start === end && start > 0) {
      const next = el.value.slice(0, start - 1) + el.value.slice(end);
      setNativeValue(el, next);
      el.setSelectionRange(start - 1, start - 1);
    } else if (start !== end) {
      const next = el.value.slice(0, start) + el.value.slice(end);
      setNativeValue(el, next);
      el.setSelectionRange(start, start);
    } else {
      return false; // caret at start with nothing selected → nothing to delete
    }
    fireInputEvents(el);
    return true;
  }

  if (parsed.main === "Delete") {
    if (start === end && end < len) {
      const next = el.value.slice(0, start) + el.value.slice(end + 1);
      setNativeValue(el, next);
      el.setSelectionRange(start, start);
    } else if (start !== end) {
      const next = el.value.slice(0, start) + el.value.slice(end);
      setNativeValue(el, next);
      el.setSelectionRange(start, start);
    } else {
      return false; // caret at end with nothing selected → nothing to delete
    }
    fireInputEvents(el);
    return true;
  }

  if (CARET_KEYS.has(parsed.main) && parsed.main !== "ArrowUp" && parsed.main !== "ArrowDown") {
    // Line-aware Up/Down movement is non-trivial in <textarea>; the events
    // below are still dispatched, but we don't claim a mutation occurred.
    switch (parsed.main) {
      case "ArrowLeft":
        parsed.shift ? setCaret(start - 1, end) : setCaret(start - 1, start - 1);
        break;
      case "ArrowRight":
        parsed.shift ? setCaret(start, end + 1) : setCaret(end + 1, end + 1);
        break;
      case "Home":
        parsed.shift ? setCaret(0, end) : setCaret(0, 0);
        break;
      case "End":
        parsed.shift ? setCaret(start, len) : setCaret(len, len);
        break;
    }
    el.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    // The platform fires `selectionchange` on `document`, and page code
    // (rich-text editors, custom caret UIs) listens there — so notify document
    // too for consistency with native selection changes.
    document.dispatchEvent(new Event("selectionchange"));
    return true;
  }

  return false;
}

/**
 * Apply the edit imperatively to a `contentEditable` element. We use the
 * still-functional `execCommand` editing commands which respect the current
 * caret/selection, then fire input/change so frameworks commit the edit.
 */
function mutateContentEditable(el: HTMLElement, parsed: ParsedKeys, literal?: string): boolean {
  let ok = false;
  if (isPrintableKey(parsed)) {
    ok = document.execCommand("insertText", false, literal ?? parsed.main);
  } else if (parsed.main === "Backspace" || parsed.main === "Delete") {
    ok = document.execCommand("delete", false);
  }
  if (ok) fireInputEvents(el);
  return ok;
}

/** Apply the equivalent edit imperatively when the target is editable. */
function applyEditableMutation(target: HTMLElement, parsed: ParsedKeys, literal?: string): boolean {
  if (isTextInput(target)) return mutateTextInput(target, parsed, literal);
  if (target.isContentEditable) return mutateContentEditable(target, parsed, literal);
  return false;
}

export async function handleSendKeys(
  _ctx: ActionContext,
  action: Extract<Action, { type: "send_keys" }>,
): Promise<ActionResult> {
  const parsed = parseKeys(action.keys);
  const target = (document.activeElement as HTMLElement) || document.body;

  // Recover the literal character for single printable keys so Shift-produced
  // symbols (`shift+1` → `!`) and uppercase letters (`A`) are typed correctly
  // (the canonical parser lowercases the main key). `null` → fall back to
  // `parsed.main`.
  const literal = resolveLiteralChar(action.keys, parsed);

  const opts: KeyboardEventInit = {
    key: literal ?? parsed.main,
    bubbles: true,
    cancelable: true,
    ctrlKey: parsed.ctrl,
    shiftKey: parsed.shift,
    altKey: parsed.alt,
    metaKey: parsed.meta,
  };
  target.dispatchEvent(new KeyboardEvent("keydown", opts));
  if (parsed.main === "Enter") {
    target.dispatchEvent(new KeyboardEvent("keypress", opts));
  }
  target.dispatchEvent(new KeyboardEvent("keyup", opts));

  // Synthetic events never apply default actions — mutate editable fields
  // imperatively so the key actually takes effect.
  const mutated = applyEditableMutation(target, parsed, literal ?? undefined);

  if (parsed.main === "Enter") {
    const form = target.closest("form");
    if (form && typeof form.requestSubmit === "function") form.requestSubmit();
  }

  await sleep(TIMINGS.keyEventAfter);

  const isMutationKey =
    isPrintableKey(parsed) || CONTENT_KEYS.has(parsed.main);
  const isNavigationKey = CARET_KEYS.has(parsed.main);

  // A content-changing key (printable char / Backspace / Delete) that did NOT
  // actually mutate the field must be reported as a failure — a silent
  // "success" would make the orchestrator believe text was entered/edited and
  // can derail the task or cause loops.
  if (isMutationKey) {
    if (!isEditableTarget(target)) {
      return {
        action,
        success: false,
        message: `Sent keys: ${action.keys} — target is not an editable field, so no text was entered or modified`,
      };
    }
    if (!mutated) {
      return {
        action,
        success: false,
        message: `Sent keys: ${action.keys} — the field did not accept the edit (e.g. contentEditable rejected it or selection was invalid)`,
      };
    }
  }

  // Caret/navigation keys (Arrows, Home, End) on a non-editable control (e.g. a
  // <select>): the synthetic event was dispatched, but synthetic events cannot
  // drive native control behavior, so the key is a no-op for the control. Report
  // it as dispatched (not a mutation) so the agent isn't misled either way.
  if (isNavigationKey && !isEditableTarget(target)) {
    return {
      action,
      success: true,
      message: `Sent keys: ${action.keys} (dispatched to non-editable control; native action suppressed for synthetic events)`,
    };
  }

  const message = mutated
    ? `Sent keys: ${action.keys} (applied to editable field)`
    : `Sent keys: ${action.keys}`;
  return { action, success: true, message };
}
