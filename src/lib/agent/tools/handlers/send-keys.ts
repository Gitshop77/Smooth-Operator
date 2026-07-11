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
    const next = el.value.slice(0, start) + parsed.main + el.value.slice(end);
    setNativeValue(el, next);
    const caret = start + parsed.main.length;
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
  const parsed = parseKeys(action.keys);
  const target = (document.activeElement as HTMLElement) || document.body;

  const opts: KeyboardEventInit = {
    key: parsed.main,
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
  const mutated = applyEditableMutation(target, parsed);

  if (parsed.main === "Enter") {
    const form = target.closest("form");
    if (form && typeof form.requestSubmit === "function") form.requestSubmit();
  }

  await sleep(TIMINGS.keyEventAfter);

  const isContentKey =
    isPrintableKey(parsed) ||
    CONTENT_KEYS.has(parsed.main) ||
    CARET_KEYS.has(parsed.main);

  // A content-changing key on a non-editable target is a genuine no-op: the
  // field (if any) did not change, so we must not report misleading success.
  if (isContentKey && !isEditableTarget(target)) {
    return {
      action,
      success: false,
      message: `Sent keys: ${action.keys} — target is not an editable field, so no text was entered or modified`,
    };
  }

  const message = mutated
    ? `Sent keys: ${action.keys} (applied to editable field)`
    : `Sent keys: ${action.keys}`;
  return { action, success: true, message };
}
