import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { highlightElement } from "../../dom/overlay";
import { NoSuchElementException, ElementNotSelectableError } from "../../errors";
import { TIMINGS, sleep } from "../constants";
import { resolveElement, safeScrollIntoView, Select } from "../helpers";
import { type ActionContext } from "./types";
import { sanitizeLabel, formatOptionList, collectDropdownOptions } from "./select-dropdown-utils";

export async function handleSelectDropdown(
  ctx: ActionContext,
  action: Extract<Action, { type: "select_dropdown" }>,
): Promise<ActionResult> {
  const { state } = ctx;
  const el = resolveElement(state, action.index);
  if (!(el instanceof HTMLSelectElement)) {
    const isCustomDropdown =
      el.getAttribute("role") === "listbox" ||
      el.getAttribute("role") === "combobox" ||
      !!el.querySelector('[role="option"]');
    if (isCustomDropdown) {
      try {
        safeScrollIntoView(el);
        highlightElement(el, `select [${action.index}]`);
        await sleep(TIMINGS.clickScrollIntoView);
        (el as HTMLElement).click();
        await sleep(TIMINGS.clickAfterSettle);
        const optionEls = collectDropdownOptions(el);
        if (optionEls.length === 0) {
          return {
            action,
            success: false,
            message: "custom-dropdown has no options (opened but none found in subtree or portal)",
          };
        }
        let match: HTMLElement | undefined;
        if (!action.text?.trim() && action.option_index != null) {
          const target = optionEls[action.option_index];
          if (!target) {
            return { action, success: false, message: "custom-dropdown option_index out of range" };
          }
          match = target;
        } else {
          const want = action.text?.trim() || "";
          const wantTrim = want.toLowerCase();
          if (!wantTrim) {
            return {
              action,
              success: false,
              message: "custom-dropdown option not found (no text and option_index out of range)",
            };
          }
          match = optionEls.find((o) =>
            (o.textContent || "").trim().toLowerCase() === wantTrim,
          );
          if (!match) {
            match = optionEls.find((o) =>
              (o.textContent || "").trim().toLowerCase().includes(wantTrim),
            );
          }
          if (!match) {
            const available = formatOptionList(optionEls);
            throw new Error(
              `custom-dropdown option "${sanitizeLabel(want)}" not found. Available: ${available}`,
            );
          }
        }
        safeScrollIntoView(match);
        highlightElement(match, `select [${action.index}]`);
        await sleep(TIMINGS.clickScrollIntoView);
        match.click();
        await sleep(TIMINGS.clickAfterSettle);
        const selectedLabel = sanitizeLabel((match.textContent || "").trim());
        // Report pageChanged only on ACTUAL navigation. The full
        // `hasPageChanged` (URL OR fingerprint) can't be used for selects: the
        // select/trigger state itself folds into the DOM fingerprint, so any
        // selection flips it and would report pageChanged:true on every
        // successful selection — aborting the remaining queue. Mirror
        // click.ts's navigation-guard philosophy: only a URL change counts.
        const pageChanged = location.href !== ctx.beforeUrl;
        return {
          action,
          success: true,
          message: `Selected "${selectedLabel}" in custom dropdown [${action.index}]`,
          pageChanged,
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
  const select = new Select(el);
  const want = action.text;
  const labelOf = (opt: HTMLOptionElement | null, fallback: string): string =>
    opt ? sanitizeLabel(opt.textContent?.trim() || opt.value) : fallback;
  let selectedLabel: string;
  try {
    if (want !== undefined && want !== "") {
      try {
        select.selectByVisibleText(want);
      } catch (e) {
        if (!(e instanceof NoSuchElementException)) throw e;
        try {
          select.selectByValue(want);
        } catch (e2) {
          // A digit-string that matches no option's text or value must NOT be
          // reinterpreted as a positional index — "2" on [Apple, Banana,
          // Cherry] would silently select Cherry. Rethrow so the caller
          // surfaces "not found" instead.
          throw e2;
        }
      }
      selectedLabel = labelOf(select.getFirstSelectedOption(), want);
    } else if (action.option_index !== undefined) {
      select.selectByIndex(action.option_index);
      selectedLabel = labelOf(select.getFirstSelectedOption(), `index ${action.option_index}`);
    } else {
      throw new Error("must provide either text or option_index");
    }
  } catch (e) {
    if (e instanceof NoSuchElementException || e instanceof ElementNotSelectableError) {
      const available = formatOptionList(select.getOptions());
      const reason = e instanceof ElementNotSelectableError ? " (option is disabled)" : "";
      throw new Error(`option "${want !== undefined ? sanitizeLabel(want) : action.option_index}" not found${reason}. Available: ${available}`);
    }
    throw e;
  }
  // URL-only page-change detection — see the custom-dropdown branch above
  // (the select's own value folds into the DOM fingerprint, so the full
  // `hasPageChanged` would report true on EVERY selection).
  const pageChanged = location.href !== ctx.beforeUrl;
  return {
    action,
    success: true,
    message: `Selected "${selectedLabel}" in [${action.index}]`,
    pageChanged,
  };
}
