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
 * A key is "printable" when it should insert a literal character. We exclude
 * known control keys and any combination carrying Ctrl/Alt/Meta, because those
 * are shortcuts (e.g. `ctrl+a` selects all) rather than typed text. A bare
 * `Shift` is allowed since it produces the intended upper-case/symbol char.
 */
/**
 * Map the small set of named/forwarded control keys to their legacy
 * `keyCode`/`which` numbers. Synthetic events dispatched without these set
 * `keyCode === 0` / `which === 0`, which bot/automation detectors and a lot of
 * legacy page code use to flag a non-human (non-trusted) event — undermining the
 * extension's stealth goal. (Printable chars are handled separately below.)
 */
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

/**
 * Map shifted-symbol / punctuation keys to their physical base `code` so the
 * synthetic `KeyboardEvent` matches a real one. A bare `Shift+1` produces
 * key `'!'`; emitting `code: '!'` (the old fallback) is a detectable automation
 * anomaly — page shortcut handlers keyed on `event.code` misfire and bot
 * detectors flag the event. The physical code for `!` is `Digit1`, for `@` is
 * `Digit2`, etc. (Letters/digits keep their `Key*`/`Digit*` codes, mapped
 * separately below.) Only covers the common printable symbols; anything
 * unmapped still falls back to the literal character (unchanged behavior).
 */
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

/**
 * Legacy `keyCode`/`which` for the physical base keys that the symbol map
 * resolves to. Synthetic events emitted without these set `keyCode === 0`,
 * which bot/automation detectors flag. Shifted symbols ('!', '@', …) must
 * report the base key's code (Digit1 → 49, Equal → 187), not the literal
 * character's char code, so a real `Shift+1` is indistinguishable from ours.
 */
const PHYSICAL_CODE_TO_KEYCODE: Record<string, number> = {
  Digit1: 49, Digit2: 50, Digit3: 51, Digit4: 52, Digit5: 53,
  Digit6: 54, Digit7: 55, Digit8: 56, Digit9: 57, Digit0: 48,
  Minus: 189, Equal: 187, BracketLeft: 219, BracketRight: 221,
  Backslash: 220, Semicolon: 186, Quote: 222, Comma: 188,
  Period: 190, Slash: 191, Backquote: 192,
};

/** Resolve `keyCode`/`which`/`code` for a synthetic KeyboardEvent. */
export function keyEventCodes(key: string): { keyCode: number; which: number; code: string } {
  if (key in NAMED_KEY_CODES) {
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
      // Derive the legacy keyCode from the resolved PHYSICAL code, not the
      // literal symbol char code — '!' must report 49 (Digit1), not 33.
      keyCode = phys
        ? PHYSICAL_CODE_TO_KEYCODE[phys] ?? key.charCodeAt(0)
        : key.charCodeAt(0);
    }
    return { keyCode, which: keyCode, code };
  }
  return { keyCode: 0, which: 0, code: "" };
}

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
 // Guard the `instanceof` checks with a DOM-global feature-detection so this
 // helper can't throw `ReferenceError: HTMLInputElement is not defined` if it
 // ever runs outside a DOM (e.g. the MV3 service worker). In a real page these
 // globals are always present, so page-side behavior is unchanged.
  return (
    (typeof HTMLInputElement !== "undefined" && el instanceof HTMLInputElement) ||
    (typeof HTMLTextAreaElement !== "undefined" && el instanceof HTMLTextAreaElement)
  );
}

function isEditableTarget(el: EventTarget | null): boolean {
  return (
    isTextInput(el) ||
    (typeof HTMLElement !== "undefined" && el instanceof HTMLElement && el.isContentEditable)
  );
}

 // The native prototype `value` setters are resolved lazily on first use
 // rather than at module load. This module is also imported by the MV3
 // background service worker (to enumerate/validate tool schemas), and a
 // service worker has no DOM — so touching `HTMLInputElement.prototype` at
 // module top-level throws `ReferenceError: HTMLInputElement is not defined`
 // and aborts service-worker registration. The setters are only ever needed
 // inside `setNativeValue`, which runs in a real DOM context (content script).
let INPUT_VALUE_SETTER: ((v: string) => void) | undefined;
let TEXTAREA_VALUE_SETTER: ((v: string) => void) | undefined;

function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
 // Use the native prototype setter so React-controlled inputs sync state.
  if (INPUT_VALUE_SETTER === undefined) {
 // Feature-detect the DOM element prototypes: the MV3 service worker has no
 // `HTMLInputElement` global, so reading `.prototype` there throws
 // `ReferenceError: HTMLInputElement is not defined`. Guarding each access keeps
 // this lazily-initialized setter safe in a non-DOM context (it is only ever
 // needed inside a real DOM, so it is never reached in the SW anyway).
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

/**
 * Set the selection range on a text input/textarea, swallowing the
 * `InvalidStateError` that `setSelectionRange` throws for input types that
 * don't support selection (e.g. `email`/`number`/`date`). Callers (the
 * imperative edit helpers) must not let that throw escape into the executor
 * loop as an unhandled exception .
 */
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

/** Apply the edit imperatively to an `<input>`/`<textarea>`. */
function mutateTextInput(
  el: HTMLInputElement | HTMLTextAreaElement,
  parsed: ParsedKeys,
): boolean {
  const len = el.value.length;
  const start = el.selectionStart ?? len;
  const end = el.selectionEnd ?? len;
  const setCaret = (s: number, e: number) =>
    safeSetSelectionRange(
      el,
      Math.max(0, Math.min(s, len)),
      Math.max(0, Math.min(e, len)),
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
      return false; // caret at start with nothing selected → nothing to delete
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
 // The platform fires `selectionchange` on `document`, and page code
 // (rich-text editors, custom caret UIs) listens there — notify document
 // for consistency with native selection changes. We do NOT dispatch a
 // synthetic `selectionchange` on the element itself: native
 // `selectionchange` targets `document` only and never bubbles, so an
 // element-targeted dispatch is a detectable anomaly.
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

/** Apply the equivalent edit imperatively when the target is editable. */
function applyEditableMutation(target: HTMLElement, parsed: ParsedKeys): boolean {
  if (isTextInput(target)) return mutateTextInput(target, parsed);
  if (target.isContentEditable) return mutateContentEditable(target, parsed);
  return false;
}

export async function handleSendKeys(
  _ctx: ActionContext,
  action: Extract<Action, { type: "send_keys" }>,
): Promise<ActionResult> {
 // `parseKeys` can throw on a malformed key combination. Convert that to a
 // structured failure instead of letting it propagate as an unhandled
 // exception in the executor loop .
  let parsed: ParsedKeys;
  try {
    parsed = parseKeys(action.keys);
  } catch (e) {
    return {
      action,
      success: false,
      message: `Sent keys: failed to parse "${action.keys}": ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
  const target = (document.activeElement as HTMLElement) || document.body;
  if (!target) {
    return {
      action,
      success: false,
      message: `Sent keys: ${action.keys} — no focusable target (no active element or body)`,
    };
  }

 // `parsed.main` already carries the correct character: `parseKeys` preserves
 // the original case of printable keys and applies Shift-produced symbols
 // (`shift+1` → `!`, `shift+a` → `A`), so no further re-derivation is needed.
  const { keyCode, which, code } = keyEventCodes(parsed.main);
  const opts: KeyboardEventInit = {
    key: parsed.main,
    keyCode,
    which,
    code,
    bubbles: true,
    cancelable: true,
    ctrlKey: parsed.ctrl,
    shiftKey: parsed.shift,
    altKey: parsed.alt,
    metaKey: parsed.meta,
  };
 // Capture the field value BEFORE dispatching so we can detect a page that
 // mutates the field from its own keydown listener (synthetic events don't
 // auto-apply default actions, but a page-side keydown handler can). If such a
 // handler already changed the value, our imperative edit below would insert
 // the same character twice (finding: send_keys double-inserts a character
 // when the page's keydown handler also mutates the field value).
  const textTarget = isTextInput(target) ? target : null;
  const valueBefore = textTarget ? textTarget.value : undefined;
  target.dispatchEvent(new KeyboardEvent("keydown", opts));
 // Native typing order is keydown → keypress → input → keyup. A `keypress`
 // fires for printable characters and for Enter (the only non-printable key
 // we forward it for, since other control keys don't emit keypress).
  if (parsed.main === "Enter" || isPrintableKey(parsed)) {
    target.dispatchEvent(new KeyboardEvent("keypress", opts));
  }
  target.dispatchEvent(new KeyboardEvent("keyup", opts));

 // A page-side keydown handler may have mutated the field during the dispatch
 // above; if so, skip the imperative edit to avoid duplicating the input.
  const pageMutated = textTarget !== null && textTarget.value !== valueBefore;

 // Synthetic events never apply default actions — mutate editable fields
 // imperatively so the key actually takes effect. Guard this call: an
 // exception (e.g. `setSelectionRange` on a non-selectable input, or
 // `execCommand` throwing) must become a structured failure rather than an
 // unhandled exception in the executor loop . If the page already applied the
 // edit (pageMutated), we treat the field as mutated and skip our imperative
 // write so we don't insert the character twice.
  let mutated = false;
  if (pageMutated) {
    mutated = true;
  } else {
    try {
      mutated = applyEditableMutation(target, parsed);
    } catch (e) {
      return {
        action,
        success: false,
        message: `Sent keys: ${action.keys} — edit application failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }
  }

  if (parsed.main === "Enter" && !parsed.shift && !parsed.ctrl && !parsed.alt && !parsed.meta) {
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

 // ArrowUp/ArrowDown on an editable field: synthetic events cannot move the
 // caret, and `mutateTextInput` intentionally does not claim a mutation for
 // them, so `mutated` is `false`. Report success (the key was dispatched) but
 // be honest that no caret movement was applied, rather than implying the
 // cursor moved .
  const isArrowUpDown = parsed.main === "ArrowUp" || parsed.main === "ArrowDown";
  const message = mutated
    ? `Sent keys: ${action.keys} (applied to editable field)`
    : isArrowUpDown && isEditableTarget(target)
      ? `Sent keys: ${action.keys} (dispatched; native caret movement not applied for synthetic events)`
      : `Sent keys: ${action.keys}`;
  return { action, success: true, message };
}
