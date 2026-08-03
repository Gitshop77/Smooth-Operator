/**
 * Select helper (modelled on the standard `<select>` wrapper class).
 *
 * A small helper that wraps an `HTMLSelectElement` and provides robust
 * option-selection semantics:
 * - selectByVisibleText / selectByValue / selectByIndex with multi-select
 * awareness (the helper iterates ALL matching options for `multiple`
 * selects, only the first for single-selects)
 * - disabled-option guard (throws {@link ElementNotSelectableError})
 * - optgroup awareness (collects options from `<optgroup>` as well as
 * direct `<option>` children)
 * - getOptions / getFirstSelectedOption accessors
 *
 * Mirrors the standard `Select` helper class from the source taxonomy,
 * adapted to operate on a live `HTMLSelectElement` (no WebElement promises).
 */

import {
  ElementNotSelectableError,
  NoSuchElementException,
  UnsupportedOperationError,
} from "../../errors";

/**
 * Wrap a `<select>` element with selection helpers. Throws if `el` is not a
 * `<select>` (the caller should pre-check, but the constructor is defensive).
 */
export class Select {
  readonly element: HTMLSelectElement;
  private readonly multiple: boolean;

  constructor(el: HTMLSelectElement) {
 // Defensive guard: the typed signature already guarantees `el` is a
 // `<select>` at compile time, but a caller could pass a non-`<select>`
 // element through a cast. Fail fast with a clear error instead of letting
 // confusing `querySelectorAll`/property behaviour surface later.
    if (el.tagName !== "SELECT") {
      throw new Error(
        `Select expected a <select> element, got <${(el.tagName || "unknown").toLowerCase()}>`,
      );
    }
    this.element = el;
 // The `multiple` attribute's presence (any value, including "false"
 // string, since HTML treats its presence as truthy) determines
 // multi-select semantics. Use `hasAttribute` for spec-compliance.
    this.multiple = el.hasAttribute("multiple");
  }

  /**
 * All `<option>` elements under this `<select>`, including those nested
 * inside `<optgroup>` elements. Order matches DOM order.
 */
  getOptions(): HTMLOptionElement[] {
    return Array.from(this.element.querySelectorAll("option"));
  }

  /** The first selected `<option>` (or `null` if none). */
  getFirstSelectedOption(): HTMLOptionElement | null {
    return this.getOptions().find((o) => o.selected) ?? null;
  }

  /**
 * Select an option by its visible text. Exact match first; if none, a
 * case-insensitive substring match. For multi-selects, all matching
 * options are selected; for single-select, only the first match.
 *
 * @throws {ElementNotSelectableError} if the matched option is `disabled`.
 * @throws {NoSuchElementException} if no option matches the text.
 */
  selectByVisibleText(text: string): void {
    const want = String(text).trim();
    if (want === "") {
 // An empty/whitespace-only argument is almost always a missing-field
 // bug (e.g. an LLM tool call with an omitted field). Treat it as an
 // invalid argument rather than silently matching every option via the
 // substring fallback, where `"".includes("")` is true for all text.
      throw new NoSuchElementException(
        "selectByVisibleText requires a non-empty visible text argument",
      );
    }
    const opts = this.getOptions();
 // Single pass: keep exact matches and (separately) case-insensitive
 // substring matches, then prefer exact — preserves the original
 // exact-first semantics while scanning the options only once.
    const lower = want.toLowerCase();
    const exact: HTMLOptionElement[] = [];
    const sub: HTMLOptionElement[] = [];
    for (const o of opts) {
      const t = (o.textContent || "").trim();
      if (t === want) exact.push(o);
      else if (t.toLowerCase().includes(lower)) sub.push(o);
    }
    const matched = exact.length > 0 ? exact : sub;
    if (matched.length === 0) {
      throw new NoSuchElementException(
        `select option with text "${want}" not found`,
      );
    }
    if (!this.multiple) {
 // Validate the target option BEFORE clearing, so a disabled option
 // (injection-controllable via the select_dropdown tool) leaves the
 // prior selection intact instead of wiping it before the guard throws.
      if (matched[0].disabled) {
        throw new ElementNotSelectableError(this.disabledOptionMessage(matched[0]));
      }
 // Single-select: clear all silently, then select + dispatch ONE change.
      for (const o of opts) o.selected = false;
      this.setSelected(matched[0]);
      return;
    }
    this.selectMultiple(matched);
  }

  /**
 * Select an option by its `value` attribute. For multi-selects, all
 * matching options are selected; for single-select, only the first.
 *
 * @throws {ElementNotSelectableError} if the matched option is `disabled`.
 * @throws {NoSuchElementException} if no option has the value.
 */
  selectByValue(value: string): void {
    const want = String(value).trim();
    if (want === "") {
      // An empty/whitespace-only argument is almost always a missing-field bug
      // (an LLM tool call with an omitted field). Matching by empty string is
      // meaningless — reject it the same way `selectByVisibleText` does rather
      // than letting a stale `value=""` option absorb the call.
      throw new NoSuchElementException(
        "selectByValue requires a non-empty value argument",
      );
    }
    const opts = this.getOptions();
    const matched = opts.filter((o) => o.value === want);
    if (matched.length === 0) {
      throw new NoSuchElementException(
        `select option with value "${want}" not found`,
      );
    }
    if (!this.multiple) {
 // Validate the target option BEFORE clearing, so a disabled option
 // leaves the prior selection intact instead of wiping it before the
 // guard throws.
      if (matched[0].disabled) {
        throw new ElementNotSelectableError(this.disabledOptionMessage(matched[0]));
      }
 // Reuse the already-fetched options array instead of re-querying the DOM.
      for (const o of opts) o.selected = false;
      this.setSelected(matched[0]);
      return;
    }
    this.selectMultiple(matched);
  }

  /**
 * Select an option by its 0-based `index` property (matches the
 * `HTMLOptionElement.index` semantics — the option's position among all
 * options in the select, including those inside optgroups).
 *
 * @throws {UnsupportedOperationError} if `index` is not an integer or is negative.
 * @throws {ElementNotSelectableError} if the option is `disabled`.
 * @throws {NoSuchElementException} if the index is out of range.
 */
  selectByIndex(index: number): void {
    if (!Number.isInteger(index)) {
 // The signature is `index: number`, so floats (`1.5`), `NaN`, and
 // `Infinity` are type-legal but meaningless for an option position.
 // Reject them at the boundary instead of letting `opts[index]` resolve
 // to `undefined` and crashing deep inside `setSelected` with an opaque
 // `TypeError: Cannot read properties of undefined`.
      throw new UnsupportedOperationError(
        `select index must be an integer (got ${index})`,
      );
    }
    if (index < 0) {
      throw new UnsupportedOperationError(
        `select index must be >= 0 (got ${index})`,
      );
    }
    const opts = this.getOptions();
    if (index >= opts.length) {
      throw new NoSuchElementException(
        `select index ${index} out of range (have ${opts.length} options)`,
      );
    }
    if (!this.multiple) {
 // Validate the target option BEFORE clearing, so a disabled option
 // leaves the prior selection intact instead of wiping it before the
 // guard throws.
      if (opts[index].disabled) {
        throw new ElementNotSelectableError(this.disabledOptionMessage(opts[index]));
      }
      for (const o of opts) o.selected = false;
      this.setSelected(opts[index]);
    } else {
      // Route the single-index selection through selectMultiple so multi-selects
      // emit exactly one batched `change` event (matching the multi-index path)
      // instead of a per-option event, keeping framework listeners from seeing
      // intermediate states.
      this.selectMultiple([opts[index]]);
    }
  }

  /**
   * Build the standard error message for attempting to select a disabled
   * `<option>`. Centralized so the wording can't drift between the five
   * guard sites.
   */
  private disabledOptionMessage(o: HTMLOptionElement): string {
    const label = (o.textContent || "").trim() || o.value || "(option)";
    return `cannot select a disabled option: "${label}"`;
  }

  /**
   * Mark `option` as selected. Throws {@link ElementNotSelectableError} if
   * the option is `disabled` — mirrors the standard guard from the source
   * taxonomy. Fires a `change` event on the `<select>` so framework listeners
   * (React, Vue, etc.) pick up the new value.
   */
  private setSelected(option: HTMLOptionElement): void {
    if (option.disabled) {
      throw new ElementNotSelectableError(this.disabledOptionMessage(option));
    }
    option.selected = true;
 // Sync the select's value too — setting `option.selected` does this for
 // single-selects, but for multi-selects the `value` property reflects
 // only the first selected option. Setting it explicitly avoids surprises
 // when callers read `select.value` after a multi-select operation.
    if (!this.multiple) this.element.value = option.value;
    this.element.dispatchEvent(new InputEvent("input", { bubbles: true }));
    this.element.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
  }

  /**
 * Select several options at once (multi-select path). Every matched option
 * is marked `selected` first, and a SINGLE `change` event is dispatched
 * afterwards — mirroring the single-select batch behaviour and avoiding N
 * redundant events (one per option) for what is logically one user action
 * (React/Vue `onChange` listeners otherwise see intermediate states).
 *
 * @throws {ElementNotSelectableError} if any matched option is `disabled`.
 */
  private selectMultiple(options: HTMLOptionElement[]): void {
 // Validate ALL options BEFORE mutating any (atomicity): a disabled option
 // encountered after some options were already marked selected would
 // otherwise leave the `<select>` in a partially-applied, inconsistent
 // state. Check first, then select in a second pass.
    for (const o of options) {
      if (o.disabled) {
        throw new ElementNotSelectableError(this.disabledOptionMessage(o));
      }
    }
    for (const o of options) {
      o.selected = true;
    }
    this.element.dispatchEvent(new InputEvent("input", { bubbles: true }));
    this.element.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
  }
}
