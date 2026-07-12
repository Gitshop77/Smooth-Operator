/**
 * `input` action handler — type text into an input, textarea, or
 * contenteditable element. Substitutes `%secret%` placeholders at execution
 * time so the real value never reaches the LLM.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { highlightElement } from "../../dom/overlay";
import { substituteSecrets } from "../../secrets";
import { LIMITS, TIMINGS, sleep } from "../constants";
import { resolveElement, safeScrollIntoView } from "../helpers";
import type { ActionContext } from "./types";

export async function handleInput(
  ctx: ActionContext,
  action: Extract<Action, { type: "input" }>,
): Promise<ActionResult> {
  const { state } = ctx;
  const el = resolveElement(state, action.index);
 // Fail fast: validate the element is editable BEFORE applying any side
 // effects (highlight / scroll / focus). Otherwise a non-text element would
 // have its focus stolen and be scrolled into view and highlighted, only for
 // the handler to throw afterwards — leaving the executor to recover from an
 // unexpected page state.
  if (
    !(el instanceof HTMLInputElement) &&
    !(el instanceof HTMLTextAreaElement) &&
    !el.isContentEditable
  ) {
    throw new Error(`element [${action.index}] is not a text input`);
  }
  highlightElement(el, `input [${action.index}]`);
  safeScrollIntoView(el);
  await sleep(TIMINGS.inputScrollIntoView);
  el.focus();
 // Substitute %secret_name% placeholders at execution time.
 // The LLM only sees the placeholder — the real value never reaches the LLM.
 // `action.text ?? ""` guards the (schema-required) text so a future relaxation
 // of the schema to an optional text can never silently append the literal
 // "undefined" to a field via the `clear:false` append path below.
  const text = await substituteSecrets(action.text ?? "");
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
 // Use the native value setter so React-controlled inputs sync their
 // state. Directly assigning `el.value = text` works for uncontrolled
 // inputs but React tracks the last-known value internally and may
 // reset it on the next render. The native prototype setter bypasses
 // React's tracking, then the `input` event lets React pick up the
 // new value.
    const proto = el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (action.clear !== false) {
      if (nativeSetter) nativeSetter.call(el, text);
      else el.value = text;
    } else {
      if (nativeSetter) nativeSetter.call(el, el.value + text);
      else el.value += text;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el.isContentEditable) {
    if (action.clear !== false) el.textContent = text;
    else el.textContent = (el.textContent || "") + text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
 // Mirror the native-input path above and also dispatch `change` so
 // contenteditable-aware frameworks (React onChange-wrapped
 // contentEditable, ProseMirror/Slate change observers, etc.) commit the
 // edit. Without it the host app may never register the change even though
 // this handler reports success.
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
 // Defensive: unreachable after the fail-fast check above (which guarantees
 // the element is a text input / textarea / contentEditable), but keeps this
 // function total (always returns an ActionResult) and satisfies the
 // type-checker, since `el.isContentEditable` is not a TS type guard.
    throw new Error(`element [${action.index}] is not a text input`);
  }
  await sleep(TIMINGS.inputAfterType);
 // If `substituteSecrets` changed the text (i.e. a %secret% placeholder was
 // replaced with a real value), the real value must NOT appear in
 // `ActionResult.message` — that field is replayed into every subsequent
 // LLM prompt via `renderHistory()` and persisted unredacted to disk via
 // `run-history.ts`. Showing the real value here would defeat the entire
 // placeholder-substitution system: the secret would cross the network to
 // the LLM provider on the next step and sit in plaintext in the on-disk
 // run history.
 //
 // When no substitution occurred (plain text, no %secret% placeholders),
 // show the FULL typed text (capped at LIMITS.inputEchoChars) so the agent
 // can verify the field's complete contents from the history. Truncating
 // too aggressively caused the agent to think long fields (e.g. a cover
 // letter) were only partially filled, leading to infinite "complete the
 // text" loops.
  if (text !== action.text) {
    return {
      action,
      success: true,
      message: `Typed [REDACTED — secret substituted] into [${action.index}]`,
    };
  }
  return { action, success: true, message: `Typed "${text.slice(0, LIMITS.inputEchoChars)}" into [${action.index}]` };
}
