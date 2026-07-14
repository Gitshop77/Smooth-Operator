/**
 * `select_dropdown` action handler — select an option in a native `<select>`
 * (via the `Select` helper) or a custom dropdown widget
 * (`div[role=listbox]`, `div[role=combobox]`, or any element with
 * `[role=option]` children).
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { highlightElement } from "../../dom/overlay";
import { NoSuchElementException, ElementNotSelectableError } from "../../errors";
import { TIMINGS, sleep } from "../constants";
import { resolveElement, safeScrollIntoView, Select } from "../helpers";
import type { ActionContext } from "./types";

/**
 * Render the first `n` options as a compact `i:label` list for error/help
 * messages. Used by both the custom-dropdown and native-`<select>` paths so the
 * format can't drift between them. Emits `value` as a fallback when an option
 * has no visible text.
 */
function formatOptionList(opts: Element[], n = 8): string {
  return opts
    .slice(0, n)
    .map((o, i) => `${i}:${(o.textContent || "").trim() || (o as HTMLOptionElement).value || ""}`)
    .join(", ");
}

/**
 * Build the single, canonical enumeration of options for a custom
 * dropdown. It is used for BOTH reading option text and resolving
 * `option_index`, so keeping one consistent enumeration — mirroring the
 * visible options the model observed — is what prevents `option_index`
 * desync in portaled widgets.
 *
 * Custom dropdowns render their options either inside the widget's own
 * subtree OR portaled to document.body (MUI / React-Select / downshift).
 * We must therefore look in both places, but we scope the lookup to
 * *visible* options and to the panel that belongs to this trigger, so we
 * never (a) pick a widget's hidden in-subtree option stubs while the real,
 * visible options are portaled, nor (b) mix in unrelated closed dropdowns,
 * either of which would re-order the list and desync `option_index`.
 *
 * Resolution order:
 * 1. Visible `[role=option]` inside the trigger's own subtree.
 * 2. A visible `[role=listbox]` associated with the trigger (portaled panel).
 * 3. Any single visible (open) `[role=listbox]` on the page.
 * 4. Last resort: every visible `[role=option]` on the page. This can
 * re-order the list if other dropdowns are open, so `option_index`
 * is then unreliable — callers should prefer `text` for selection.
 */
function collectDropdownOptions(trigger: Element): HTMLElement[] {
  const visible = (els: NodeListOf<Element> | Element[]) =>
    (Array.from(els) as HTMLElement[]).filter(isVisible);

 // 1. Options inside the widget's own subtree (non-portaled widgets).
 // Filtered to *visible* options so hidden in-subtree stubs do not
 // shadow the portaled, visible options the model actually enumerated.
  const subtree = visible(trigger.querySelectorAll('[role="option"]'));
  if (subtree.length > 0) return subtree;

 // 2. Portaled panel: a listbox labelled by this trigger.
  const triggerId = trigger.getAttribute("id");
 // `aria-labelledby~="…"` is a whitespace-token match; an attacker-controlled
 // id containing quotes/CSS metacharacters could otherwise break the selector
 // (or, worse, be parsed as a malformed selector that throws). Only use the
 // id-scoped lookup when it is a valid CSS identifier; otherwise skip straight
 // to the page-wide listbox scan below.
  if (triggerId && /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(triggerId)) {
    const labelled = document.querySelector<HTMLElement>(
      `[role="listbox"][aria-labelledby~="${triggerId}"]`,
    );
    if (labelled && isVisible(labelled)) {
      const opts = visible(labelled.querySelectorAll('[role="option"]'));
      if (opts.length > 0) return opts;
    }
  }

 // 3. The single currently-open (visible) listbox on the page.
  const openListbox = (
    Array.from(document.querySelectorAll('[role="listbox"]')) as HTMLElement[]
  ).find(isVisible);
  if (openListbox) {
    const opts = visible(openListbox.querySelectorAll('[role="option"]'));
    if (opts.length > 0) return opts;
  }

 // 4. Last resort — see note above.
  return visible(document.querySelectorAll('[role="option"]'));
}

/**
 * True when an element is rendered (not display:none / visibility:hidden)
 * and is actually laid out.
 *
 * The rect-based check (`width > 0 && height > 0`) is a legitimate signal in
 * a real browser — a genuinely-not-rendered element reports a zero-size rect.
 * But environments without a layout engine (notably jsdom, used by the test
 * suite) return a zero-size rect for *every* element, so a zero rect there is
 * NOT evidence of invisibility. We therefore only reject on a zero-size rect
 * when a real layout engine is present; otherwise we trust the computed-style
 * check alone. This keeps real-browser behaviour intact while not breaking
 * non-layout environments.
 */
let _layoutEnginePresent: boolean | null = null;
function layoutEnginePresent(): boolean {
  if (_layoutEnginePresent === null) {
 // Probe the root element: in jsdom neither the documentElement nor the
 // body is laid out, so their rects are all zeros. If the root reports a
 // non-zero rect, a real layout engine is active.
    const root = document.documentElement;
    const r = root.getBoundingClientRect();
    _layoutEnginePresent = r.width > 0 || r.height > 0;
  }
  return _layoutEnginePresent;
}

function isVisible(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) return true;
 // Zero-size rect: hidden in a real browser, but inconclusive without a
 // layout engine — treat as visible so non-layout envs still resolve options.
  return !layoutEnginePresent();
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
 // 1. Click the dropdown to open its options panel.
 // 2. Find the option whose text matches `want` (exact match
 // first, then case-insensitive substring).
 // 3. Click the matched option.
 // 4. Settle briefly so the widget's onChange fires.
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
 // 1. Open the dropdown.
        (el as HTMLElement).click();
        await sleep(TIMINGS.clickAfterSettle);
 // 2. Collect the candidate options.
 // `optionEls` is the single canonical enumeration we use for BOTH
 // reading option text and resolving `option_index`, built to mirror
 // the visible options the model observed (in-subtree first, then
 // the portaled panel scoped to this trigger). This keeps
 // `option_index` resolution aligned with the model's view. `text`
 // is always preferred when supplied; `option_index` is the fallback.
        const optionEls = collectDropdownOptions(el);
        if (optionEls.length === 0) {
          return {
            action,
            success: false,
            message: "custom-dropdown has no options (opened but none found in subtree or portal)",
          };
        }
 // Resolve the target option. Prefer an explicit `text` (exact, then
 // case-insensitive substring). When only `option_index` is supplied,
 // resolve DIRECTLY by index instead of round-tripping the option's
 // (possibly empty or duplicated) text — that round-trip mis-resolves when
 // two visible options share identical text or the indexed option has
 // empty text.
        let match: HTMLElement | undefined;
        if (!action.text?.trim() && action.option_index != null) {
          const target = optionEls[action.option_index];
          if (!target) {
            return { action, success: false, message: "custom-dropdown option_index out of range" };
          }
          match = target;
        } else {
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
              `custom-dropdown option "${want}" not found. Available: ${available}`,
            );
          }
        }
 // 3. Click the matched option. The click is what performs the
 // selection in the widget — MUI / React-Select / downshift all
 // select via the option's own click handler, and that handler fires
 // from this click. A successfully-resolved, clicked option is a
 // successful selection, so we report success here. (We deliberately
 // do not infer success from the trigger's text/value changing:
 // many widgets reflect the selection asynchronously or not on the
 // trigger at all, so such a check would report false failures for
 // genuine selections.)
        safeScrollIntoView(match);
        highlightElement(match, `select [${action.index}]`);
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
  // Resolve the displayed label for the selected option, falling back to the
  // supplied value (or an explicit fallback) when the option has no text.
  const labelOf = (opt: HTMLOptionElement | null, fallback: string): string =>
    opt ? (opt.textContent?.trim() || opt.value) : fallback;
  let selectedLabel: string;
  try {
    if (want !== undefined && want !== "") {
 // Try by visible text first (also matches `value` via the
 // substring fallback). If that throws NoSuchElementException,
 // fall back to treating `want` as the option's `value`.
      try {
        select.selectByVisibleText(want);
        selectedLabel = labelOf(select.getFirstSelectedOption(), want);
      } catch (e) {
        if (e instanceof NoSuchElementException) {
 // Try by value, then by index (if `want` parses as a number).
          try {
            select.selectByValue(want);
            selectedLabel = labelOf(select.getFirstSelectedOption(), want);
          } catch (e2) {
            if (e2 instanceof NoSuchElementException && /^\d+$/.test(want)) {
              select.selectByIndex(parseInt(want, 10));
              selectedLabel = labelOf(select.getFirstSelectedOption(), want);
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
      selectedLabel = labelOf(select.getFirstSelectedOption(), `index ${action.option_index}`);
    } else {
      throw new Error("must provide either text or option_index");
    }
  } catch (e) {
 // Re-throw with the available-options hint so the LLM can recover. Both a
 // genuinely-missing option (NoSuchElementException) and a matched-but-
 // disabled option (ElementNotSelectableError) are surfaced with the same
 // actionable list, since both are common "option by value/index" failures.
    if (e instanceof NoSuchElementException || e instanceof ElementNotSelectableError) {
      const available = formatOptionList(select.getOptions());
      const reason = e instanceof ElementNotSelectableError ? " (option is disabled)" : "";
      throw new Error(`option "${want ?? action.option_index}" not found${reason}. Available: ${available}`);
    }
    throw e;
  }
  return { action, success: true, message: `Selected "${selectedLabel}" in [${action.index}]` };
}
