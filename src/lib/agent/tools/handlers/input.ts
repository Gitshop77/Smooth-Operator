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
import { type ActionContext, isExtensionContext } from "./types";
import { rejectOnAbort, throwIfAborted } from "./abort";

/** Give up on an unresponsive SW typer rather than hanging the agent loop. */
const HUMANIZED_INPUT_TIMEOUT_MS = 30_000;

// Cache native value setters at module scope (mirrors send-keys.ts pattern).
// Lazy-initialized on first input call to avoid touching HTMLInputElement
// prototype in non-DOM contexts (service worker).
let cachedInputSetter: ((v: string) => void) | undefined;
let cachedTextareaSetter: ((v: string) => void) | undefined;

function resolveSetters(): void {
  if (cachedInputSetter === undefined) {
    cachedInputSetter = typeof HTMLInputElement !== "undefined"
      ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
      : undefined;
    cachedTextareaSetter = typeof HTMLTextAreaElement !== "undefined"
      ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
      : undefined;
  }
}

/**
 * True when `el` is a native `<input>` / `<textarea>`. Feature-detects the
 * DOM element globals so this never throws `ReferenceError` if the handler is
 * ever invoked in a non-DOM context (e.g. the MV3 service worker, which has
 * no `HTMLInputElement` global); in a real DOM the globals are always present.
 */
function isNativeTextInput(el: HTMLElement): el is HTMLInputElement | HTMLTextAreaElement {
  return (
    (typeof HTMLInputElement !== "undefined" && el instanceof HTMLInputElement) ||
    (typeof HTMLTextAreaElement !== "undefined" && el instanceof HTMLTextAreaElement)
  );
}

/**
 * Parameter type for the `input` action. Mirrors the parsed {@link Action}
 * shape exactly, except `clear` is made optional: it carries a `.default(true)`
 * at parse time, but callers (the executor, LLM prompts, and tests) legitimately
 * omit it — and the handler already treats a missing `clear` as "replace"
 * (`action.clear !== false`). Keeping `index`/`text` as their real (non-coerced)
 * types avoids the `unknown` widening that `z.input` would introduce.
 */
type InputAction = Omit<Extract<Action, { type: "input" }>, "clear"> & {
  clear?: boolean | null;
};

/**
 * Delegate humanized typing to the service worker, which types the text via
 * CDP `Input.dispatchKeyEvent` (browser-trusted key events) instead of the
 * content script's instant value-set. The SW returns a `TAB_ACTION`-shaped
 * response; this mirrors the delegation contract used by switch_tab/close_tab.
 */
async function delegateHumanizedInput(
  action: Extract<Action, { type: "input" }>,
  signal?: AbortSignal,
  dispatchToken?: ActionContext["dispatchToken"],
  effectCapability?: string,
): Promise<ActionResult> {
  if (!isExtensionContext()) {
    return {
      action,
      success: false,
      message: `${action.type} is not supported in the current mode (no extension tab API)`,
    };
  }
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = rejectOnAbort(signal);
    let raw: unknown;
    try {
      raw = await Promise.race([
        chrome.runtime.sendMessage({ type: "TAB_ACTION", action, ...(dispatchToken ? { token: dispatchToken } : {}), ...(effectCapability ? { effectCapability } : {}) }).finally(() => clearTimeout(timer)),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), HUMANIZED_INPUT_TIMEOUT_MS);
        }),
        abort.promise,
      ]);
    } finally {
      clearTimeout(timer);
      abort.cleanup();
    }
    if (typeof raw === "undefined") {
      return { action, success: false, message: `${action.type} failed: no response from extension (timeout or unreachable service worker)` };
    }
    const res = raw as { ok?: boolean; success?: boolean; message?: string; error?: string };
    if (!res.ok) {
      return { action, success: false, message: `${action.type} failed: ${res.message ?? res.error ?? "unknown error"}` };
    }
    return {
      action,
      success: res.success ?? true,
      message: res.message ?? `${action.type} ok`,
    };
  } catch (e) {
    return { action, success: false, message: `${action.type} failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function handleInput(
  ctx: ActionContext,
  action: InputAction,
): Promise<ActionResult> {
  const { state } = ctx;
  throwIfAborted(ctx.signal);
  const el = resolveElement(state, action.index);
  // Fail fast: validate the element is editable BEFORE applying any side
  // effects (highlight / scroll / focus). Otherwise a non-text element would
  // have its focus stolen and be scrolled into view and highlighted, only for
  // the handler to throw afterwards — leaving the executor to recover from an
  // unexpected page state.
  if (!isNativeTextInput(el) && !el.isContentEditable) {
    throw new Error(`element [${action.index}] is not a text input`);
  }
  highlightElement(el, `input [${action.index}]`);
  throwIfAborted(ctx.signal);
  safeScrollIntoView(el);
  await sleep(TIMINGS.inputScrollIntoView, ctx.signal);
  throwIfAborted(ctx.signal);
  el.focus({ preventScroll: true });
  // Substitute %secret_name% placeholders at execution time.
  // The LLM only sees the placeholder — the real value never reaches the LLM.
  // `action.text ?? ""` guards the (schema-required) text so a future relaxation
  // of the schema to an optional text can never silently append the literal
  // "undefined" to a field via the `clear:false` append path below.
  const text = await substituteSecrets(action.text ?? "");
  throwIfAborted(ctx.signal);
  if (action.humanized === true) {
    // Humanized path (OPT-IN): clear the field content-side so the SW's CDP
    // typing fills a blank field — native inputs need the prototype setter so
    // React-controlled inputs stay in sync, contenteditable elements get their
    // textContent emptied. Otherwise typing lands at the caret over old
    // content and the action reports success with a wrong value.
    if (action.clear !== false) {
      throwIfAborted(ctx.signal);
      if (isNativeTextInput(el)) {
        resolveSetters();
        const nativeSetter = typeof HTMLTextAreaElement !== "undefined" && el instanceof HTMLTextAreaElement
          ? cachedTextareaSetter
          : cachedInputSetter;
        if (nativeSetter) nativeSetter.call(el, "");
        else el.value = "";
      } else if (el.isContentEditable) {
        el.textContent = "";
      }
    }
    const delegated = await delegateHumanizedInput({
      type: "input",
      index: action.index,
      text,
      clear: false,
      humanized: true,
    } as Extract<Action, { type: "input" }>, ctx.signal, ctx.dispatchToken, ctx.effectCapability);
    if (delegated.success) {
      return { ...delegated, action: { ...action, clear: action.clear !== false } };
    }
    return delegated;
  }
  throwIfAborted(ctx.signal);
  if (isNativeTextInput(el)) {
    // Use the native value setter so React-controlled inputs sync their
    // state. Directly assigning `el.value = text` works for uncontrolled
    // inputs but React tracks the last-known value internally and may
    // reset it on the next render. The native prototype setter bypasses
    // React's tracking, then the `input` event lets React pick up the
    // new value.
    resolveSetters();
    const nativeSetter = typeof HTMLTextAreaElement !== "undefined" && el instanceof HTMLTextAreaElement
      ? cachedTextareaSetter
      : cachedInputSetter;
    const finalText = action.clear !== false ? text : el.value + text;
    throwIfAborted(ctx.signal);
    // Dispatch the cancelable `beforeinput` BEFORE the mutation per the UI
    // Events ordering (keydown → beforeinput → input). `beforeinput`'s
    // contract is "fired when the value is about to change"; its purpose is
    // `preventDefault()`. ProseMirror/Slate/IME listeners keyed on the
    // event see it BEFORE the edit (not after) and can cancel it; honoring
    // `preventDefault` prevents a double-edit (listener + our setter).
    const beforeinput = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: text,
    });
    el.dispatchEvent(beforeinput);
    throwIfAborted(ctx.signal);
    // `defaultPrevented` is the reliable cancel signal (dispatchEvent's return
    // value for a canceled event differs across engines).
    const cancelled = beforeinput.defaultPrevented;
    if (!cancelled) {
      if (nativeSetter) nativeSetter.call(el, finalText);
      else el.value = finalText;
    }
    // Re-sync the caret to the end of the value so a follow-up input /
    // send_keys action types from the end instead of the (stale) start.
    // Best-effort — selection APIs throw on some inputs.
    try {
      el.setSelectionRange(finalText.length, finalText.length);
    } catch {
      /* some input types (number/email) reject selection — ignore */
    }
    throwIfAborted(ctx.signal);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    throwIfAborted(ctx.signal);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (cancelled) {
      // A page listener cancelled the edit via `preventDefault()` — the
      // value did NOT change. Report the truth instead of a false success.
      return {
        action: { ...action, clear: action.clear !== false },
        success: false,
        message: `input [${action.index}] was cancelled by the page (beforeinput preventDefault) — the field was not modified`,
      };
    }
  } else if (el.isContentEditable) {
    throwIfAborted(ctx.signal);
    if (action.clear !== false) el.textContent = text;
    else el.textContent = (el.textContent || "") + text;
    throwIfAborted(ctx.signal);
    el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
    throwIfAborted(ctx.signal);
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    // Mirror the native-input path above and also dispatch `change` so
    // contenteditable-aware frameworks (React onChange-wrapped
    // contentEditable, ProseMirror/Slate change observers, etc.) commit the
    // edit. Without it the host app may never register the change even though
    // this handler reports success.
    throwIfAborted(ctx.signal);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    // Defensive: unreachable after the fail-fast check above (which guarantees
    // the element is a text input / textarea / contentEditable), but keeps this
    // function total (always returns an ActionResult) and satisfies the
    // type-checker, since `el.isContentEditable` is not a TS type guard.
    throw new Error(`element [${action.index}] is not a text input`);
  }
  await sleep(TIMINGS.inputAfterType, ctx.signal);
  // If `substituteSecrets` changed the text (a %secret% placeholder was
  // replaced with a real value), the real value must NOT appear in
  // `ActionResult.message` — that field is replayed into every subsequent LLM
  // prompt via `renderHistory()` and persisted unredacted to disk via
  // `run-history.ts`; showing it here would defeat the entire
  // placeholder-substitution system. When no substitution occurred (plain
  // text), show the FULL typed text (capped at LIMITS.inputEchoChars) so the
  // agent can verify the field's complete contents — truncating too
  // aggressively caused infinite "complete the text" loops for long fields.
  const reported: Extract<Action, { type: "input" }> = {
    ...action,
    clear: action.clear !== false,
  };
  if (text !== (action.text ?? "")) {
    return {
      action: reported,
      success: true,
      message: `Typed [REDACTED — secret substituted] into [${action.index}]`,
    };
  }
  return { action: reported, success: true, message: `Typed "${text.slice(0, LIMITS.inputEchoChars)}" into [${action.index}]` };
}
