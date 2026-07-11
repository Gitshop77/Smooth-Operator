/**
 * `select_dropdown` action handler — select an option in a native `<select>`
 * (via the `Select` helper) or a custom dropdown widget
 * (`div[role=listbox]`, `div[role=combobox]`, or any element with
 * `[role=option]` children).
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { highlightElement } from "../../dom/overlay";
import { NoSuchElementException } from "../../errors";
import { TIMINGS, sleep } from "../constants";
import { resolveElement, safeScrollIntoView, Select } from "../helpers";
import type { ActionContext } from "./types";

/**
 * Collect `[role=option]` elements that are portaled outside the
 * dropdown's own subtree (e.g. to document.body by MUI / React-Select /
 * downshift).
 *
 * We scope the lookup to options that are *actually rendered/visible*
 * so the enumeration order matches what the model saw in the page
 * snapshot. Including every hidden portaled option on the page would
 * (a) mix in unrelated closed dropdowns and (b) re-order the list,
 * which would desync `option_index` resolution.
 *
 * `trigger` is the element the handler just clicked to open the panel;
 * if a visible `[role=listbox]` is reachable from it we read that
 * panel's options directly, otherwise we fall back to all visible
 * `[role=option]` elements on the page.
 */
function collectVisiblePortalOptions(trigger: Element): HTMLElement[] {
  // Prefer a visible listbox/popup that is associated with the trigger.
  const triggerId = trigger.getAttribute("id");
  if (triggerId) {
    const labelled = document.querySelector<HTMLElement>(
      `[role="listbox"][aria-labelledby~="${triggerId}"]`,
    );
    if (labelled && isVisible(labelled)) {
      const opts = Array.from(
        labelled.querySelectorAll('[role="option"]'),
      ) as HTMLElement[];
      if (opts.length > 0) return opts.filter(isVisible);
    }
  }
  // Fallback: any visible [role=listbox] (the just-opened panel) and its
  // options, or visible [role=option] elements elsewhere on the page.
  const listboxes = Array.from(
    document.querySelectorAll('[role="listbox"]'),
  ) as HTMLElement[];
  const openListbox = listboxes.find(isVisible);
  if (openListbox) {
    const opts = Array.from(
      openListbox.querySelectorAll('[role="option"]'),
    ) as HTMLElement[];
    if (opts.length > 0) return opts.filter(isVisible);
  }
  return Array.from(
    document.querySelectorAll('[role="option"]'),
  ).filter(isVisible) as HTMLElement[];
}

/** True when an element is rendered (not display:none / visibility:hidden). */
function isVisible(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export async function handleSelectDropdown(
  ctx: ActionContext,
  action: Extract<Action, { type: "select_dropdown" }>,
): Promise<ActionResult> {
  const { state } = ctx;
  const el = resolveElement(state, action.index);
  // Custom-dropdown fallback: when the resolved element isn't a
  // native `<select>` but is a custom dropdown widget
  // (`div[role=listbox]`, `div[role=combobox]`, or any element
  // containing `[role=option]` children), the standard `Select`
  // helper can't operate on it. The old implementation threw
  // `element is not a <select>` immediately — leaving the agent
  // unable to interact with the many modern SPAs (React-Select,
  // MUI Autocomplete, downshift) that use custom dropdowns.
  //
  // The fallback:
  //   1. Click the dropdown to open its options panel.
  //   2. Find the option whose text matches `want` (exact match
  //      first, then case-insensitive substring).
  //   3. Click the matched option.
  //   4. Settle briefly so the widget's onChange fires.
  if (!(el instanceof HTMLSelectElement)) {
    const isCustomDropdown =
      el.getAttribute("role") === "listbox" ||
      el.getAttribute("role") === "combobox" ||
      !!el.querySelector('[role="option"]');
    if (isCustomDropdown) {
      try {
        safeScrollIntoView(el);
        await sleep(TIMINGS.clickScrollIntoView);
        // 1. Open the dropdown.
        (el as HTMLElement).click();
        await sleep(TIMINGS.clickAfterSettle);
        // 2. Collect the candidate options.
        // `optionEls` is the canonical enumeration we both (a) read the
        // option text from and (b) apply `option_index` against. To keep
        // it consistent with what the model enumerated in the page
        // snapshot, prefer the options inside the widget's own subtree.
        let optionEls = Array.from(
          el.querySelectorAll('[role="option"]'),
        ) as HTMLElement[];
        // Many widgets (MUI, React-Select, downshift) portal the option
        // list to document.body. The model's `option_index` was chosen
        // against the *visible* options it saw, so we must scope the
        // portal lookup to the options that are actually rendered/visible
        // — not every hidden portaled option on the page. Grabbing all
        // `[role=option]` on document.body would mix in other (closed)
        // dropdowns and re-order the list, desyncing `option_index`.
        if (optionEls.length === 0) {
          optionEls = collectVisiblePortalOptions(el);
        }
        if (optionEls.length === 0) {
          return {
            action,
            success: false,
            message: "custom-dropdown has no options (opened but none found in subtree or portal)",
          };
        }
        // Prefer text matching where possible: when the LLM provides
        // `text` we never touch `option_index` (text is unambiguous).
        // Only when `text` is empty do we fall back to `option_index`,
        // resolving it against this same (consistent) `optionEls`
        // enumeration and then re-matching by that option's exact text —
        // which minimises the blast radius of any residual desync.
        const want = (action.text?.trim() || "")
          || (action.option_index != null
            ? (optionEls[action.option_index]?.textContent ?? "").trim()
            : "");
        const wantTrim = want.trim().toLowerCase();
        if (!wantTrim) {
          return {
            action,
            success: false,
            message: "custom-dropdown option not found (no text and option_index out of range)",
          };
        }
        let match: HTMLElement | undefined = optionEls.find((o) =>
          (o.textContent || "").trim().toLowerCase() === wantTrim,
        );
        if (!match) {
          match = optionEls.find((o) =>
            (o.textContent || "").trim().toLowerCase().includes(wantTrim),
          );
        }
        if (!match) {
          const available = optionEls
            .slice(0, 8)
            .map((o, i) => `${i}:${(o.textContent || "").trim()}`)
            .join(", ");
          throw new Error(
            `custom-dropdown option "${want}" not found. Available: ${available}`,
          );
        }
        // 3. Click the matched option.
        safeScrollIntoView(match);
        await sleep(TIMINGS.clickScrollIntoView);
        match.click();
        await sleep(TIMINGS.clickAfterSettle);
        const selectedLabel = (match.textContent || "").trim();
        return {
          action,
          success: true,
          message: `Selected "${selectedLabel}" in custom dropdown [${action.index}]`,
        };
      } catch (e) {
        throw new Error(
          `custom-dropdown fallback failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    throw new Error(`element [${action.index}] is not a <select> or custom dropdown (role=listbox/combobox)`);
  }
  highlightElement(el, `select [${action.index}]`);
  // Use the Select helper (modelled on the standard `<select>` wrapper
  // class) for robust option selection — handles `<optgroup>`-nested
  // options, multi-select, disabled-option guards, and the
  // exact-match-then-substring fallback for text-based selection.
  const select = new Select(el);
  const want = action.text;
  let selectedLabel: string;
  try {
    if (want !== undefined && want !== "") {
      // Try by visible text first (also matches `value` via the
      // substring fallback). If that throws NoSuchElementException,
      // fall back to treating `want` as the option's `value`.
      try {
        select.selectByVisibleText(want);
        const opt = select.getFirstSelectedOption();
        selectedLabel = opt ? (opt.textContent?.trim() || opt.value) : want;
      } catch (e) {
        if (e instanceof NoSuchElementException) {
          // Try by value, then by index (if `want` parses as a number).
          try {
            select.selectByValue(want);
            const opt = select.getFirstSelectedOption();
            selectedLabel = opt ? (opt.textContent?.trim() || opt.value) : want;
          } catch (e2) {
            if (e2 instanceof NoSuchElementException && /^\d+$/.test(want)) {
              select.selectByIndex(parseInt(want, 10));
              const opt = select.getFirstSelectedOption();
              selectedLabel = opt ? (opt.textContent?.trim() || opt.value) : want;
            } else {
              throw e2;
            }
          }
        } else {
          throw e;
        }
      }
    } else if (action.option_index !== undefined) {
      select.selectByIndex(action.option_index);
      const opt = select.getFirstSelectedOption();
      selectedLabel = opt ? (opt.textContent?.trim() || opt.value) : `index ${action.option_index}`;
    } else {
      throw new Error("must provide either text or option_index");
    }
  } catch (e) {
    // Re-throw with the available-options hint so the LLM can recover.
    if (e instanceof NoSuchElementException) {
      const available = select.getOptions().slice(0, 8).map((o, i) => `${i}:${o.textContent?.trim() || o.value || ""}`).join(", ");
      throw new Error(`option "${want ?? action.option_index}" not found. Available: ${available}`);
    }
    throw e;
  }
  return { action, success: true, message: `Selected "${selectedLabel}" in [${action.index}]` };
}
