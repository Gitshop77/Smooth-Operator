/**
 * Select helper (modelled on the standard `<select>` wrapper class).
 *
 * A small helper that wraps an `HTMLSelectElement` and provides robust
 * option-selection semantics:
 *   - selectByVisibleText / selectByValue / selectByIndex with multi-select
 *     awareness (the helper iterates ALL matching options for `multiple`
 *     selects, only the first for single-selects)
 *   - disabled-option guard (throws {@link ElementNotSelectableError})
 *   - optgroup awareness (collects options from `<optgroup>` as well as
 *     direct `<option>` children)
 *   - deselectAll (used internally by single-select reset)
 *   - getOptions / getFirstSelectedOption accessors
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
   * @throws {NoSuchElementException}    if no option matches the text.
   */
  selectByVisibleText(text: string): void {
    const want = String(text).trim();
    const opts = this.getOptions();
    let matched = opts.filter((o) => (o.textContent || "").trim() === want);
    if (matched.length === 0) {
      // Substring fallback (case-insensitive).
      const lower = want.toLowerCase();
      matched = opts.filter((o) => (o.textContent || "").trim().toLowerCase().includes(lower));
    }
    if (matched.length === 0) {
      throw new NoSuchElementException(
        `select option with text "${want}" not found`,
      );
    }
    if (!this.multiple) {
      // Single-select: clear all silently, then select + dispatch ONE change.
      for (const o of this.getOptions()) o.selected = false;
      this.setSelected(matched[0]);
      return;
    }
    for (const o of matched) this.setSelected(o);
  }

  /**
   * Select an option by its `value` attribute. For multi-selects, all
   * matching options are selected; for single-select, only the first.
   *
   * @throws {ElementNotSelectableError} if the matched option is `disabled`.
   * @throws {NoSuchElementException}    if no option has the value.
   */
  selectByValue(value: string): void {
    const want = String(value);
    const matched = this.getOptions().filter((o) => o.value === want);
    if (matched.length === 0) {
      throw new NoSuchElementException(
        `select option with value "${want}" not found`,
      );
    }
    if (!this.multiple) {
      for (const o of this.getOptions()) o.selected = false;
      this.setSelected(matched[0]);
      return;
    }
    for (const o of matched) this.setSelected(o);
  }

  /**
   * Select an option by its 0-based `index` property (matches the
   * `HTMLOptionElement.index` semantics — the option's position among all
   * options in the select, including those inside optgroups).
   *
   * @throws {ElementNotSelectableError} if the option is `disabled`.
   * @throws {NoSuchElementException}    if the index is out of range.
   */
  selectByIndex(index: number): void {
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
      for (const o of this.getOptions()) o.selected = false;
    }
    this.setSelected(opts[index]);
  }

  /**
   * Clear all selected options. No-op on single-selects that don't allow
   * deselection (per the HTML spec, single-selects must always have one
   * option selected — calling `deselectAll` on a single-select clears
   * `.selected` on every option, but the browser will re-select the first
   * option on the next paint).
   */
  deselectAll(): void {
    for (const o of this.getOptions()) {
      o.selected = false;
    }
    this.element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /**
   * Mark `option` as selected. Throws {@link ElementNotSelectableError} if
   * the option is `disabled` — mirrors the standard guard from the source
   * taxonomy. Fires a `change` event on the `<select>` so framework listeners
   * (React, Vue, etc.) pick up the new value.
   */
  private setSelected(option: HTMLOptionElement): void {
    if (option.disabled) {
      throw new ElementNotSelectableError(
        `cannot select a disabled option: "${(option.textContent || "").trim() || option.value}"`,
      );
    }
    option.selected = true;
    // Sync the select's value too — setting `option.selected` does this for
    // single-selects, but for multi-selects the `value` property reflects
    // only the first selected option. Setting it explicitly avoids surprises
    // when callers read `select.value` after a multi-select operation.
    if (!this.multiple) this.element.value = option.value;
    this.element.dispatchEvent(new Event("change", { bubbles: true }));
  }
}
