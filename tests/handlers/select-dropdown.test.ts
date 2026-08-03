/**
 * `select_dropdown` native-`<select>` text matching — a digit-string like "2"
 * must match an option's visible text or value, and must NEVER be
 * reinterpreted as a positional index: on [Apple, Banana, Cherry], "2" would
 * silently select Cherry. A digit string that matches no option's text/value
 * must fail loudly instead.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { handleSelectDropdown } from "../../src/lib/agent/tools/handlers/select-dropdown";
import { Select } from "../../src/lib/agent/tools/helpers";
import type { ActionContext } from "../../src/lib/agent/tools/handlers/types";
import { makeState } from "../helpers";

vi.mock("../../src/lib/agent/dom/overlay", () => ({
  highlightElement: vi.fn(() => ({ remove: () => {} })),
}));

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

function ctxFor(el: HTMLElement, index: number): ActionContext {
  return {
    state: makeState({ selectorMap: { [index]: el } }),
    beforeUrl: location.href,
    beforeFingerprint: "fingerprint",
  };
}

function makeSelect(labels: string[]): HTMLSelectElement {
  const select = document.createElement("select");
  for (const label of labels) {
    const opt = document.createElement("option");
    opt.textContent = label;
    select.appendChild(opt);
  }
  document.body.appendChild(select);
  return select;
}

describe("handleSelectDropdown digit-string matching", () => {
  test("a digit string that matches no option's text or value fails loudly (no positional fallback)", async () => {
    const select = makeSelect(["Apple", "Banana", "Cherry"]);
    await expect(
      handleSelectDropdown(ctxFor(select, 1), {
        type: "select_dropdown",
        index: 1,
        text: "2",
      }),
    ).rejects.toThrow(/not found/);
    // Nothing was selected positionally: the first option stays selected.
    expect(select.selectedIndex).toBe(0);
    expect(select.value).toBe("Apple");
  });

  test("a digit string selects the option whose VALUE matches it", async () => {
    const select = document.createElement("select");
    const opt = document.createElement("option");
    opt.textContent = "Apple";
    opt.value = "2";
    select.appendChild(opt);
    document.body.appendChild(select);
    const res = await handleSelectDropdown(ctxFor(select, 1), {
      type: "select_dropdown",
      index: 1,
      text: "2",
    });
    expect(res.success).toBe(true);
    expect(select.value).toBe("2");
    expect(res.message).toContain("Apple");
  });

  test("a digit-containing label is selectable via substring text matching", async () => {
    const select = makeSelect(["iPhone 15 Pro"]);
    const res = await handleSelectDropdown(ctxFor(select, 1), {
      type: "select_dropdown",
      index: 1,
      text: "15",
    });
    expect(res.success).toBe(true);
    expect(select.value).toBe("iPhone 15 Pro");
  });

  test("a selection on a plain dropdown reports pageChanged: false", async () => {
    // The select's own value folds into the DOM fingerprint, so a naive
    // hasPageChanged() (URL OR fingerprint) reports true on EVERY selection,
    // which aborts the remaining queue. A plain selection must not count as a
    // page change — only actual navigation (URL change) does.
    const select = makeSelect(["Apple", "Banana"]);
    const res = await handleSelectDropdown(ctxFor(select, 1), {
      type: "select_dropdown",
      index: 1,
      text: "Banana",
    });
    expect(res.success).toBe(true);
    expect(select.value).toBe("Banana");
    expect(res.pageChanged).toBe(false);
  });

  test("a selection that triggers navigation reports pageChanged: true", async () => {
    const select = makeSelect(["Apple", "Banana"]);
    // Simulate the selection navigating the page: the URL changes between the
    // pre-action baseline and the handler's post-selection check.
    const before = location.href;
    const url = new URL(before);
    url.pathname = "/navigated";
    window.history.replaceState(null, "", url.href);
    const res = await handleSelectDropdown(
      {
        state: makeState({ selectorMap: { 1: select } }),
        beforeUrl: before,
        beforeFingerprint: "fingerprint",
      },
      {
        type: "select_dropdown",
        index: 1,
        text: "Banana",
      },
    );
    expect(res.success).toBe(true);
    expect(res.pageChanged).toBe(true);
  });
});

describe("Select helper value-sync behavior", () => {
  test("selectByVisibleText updates both the option and the select value", () => {
    const select = makeSelect(["Apple", "Banana"]);
    new Select(select).selectByVisibleText("Banana");
    expect(select.selectedIndex).toBe(1);
    expect(select.value).toBe("Banana");
  });

  test("selectByValue with an empty string throws (missing-field guard), not silent no-op", () => {
    // An empty/whitespace-only value is a missing-field bug; matching a stale
    // `value=""` option silently would select the wrong thing.
    const select = makeSelect(["Apple", "Banana"]);
    const s = new Select(select);
    expect(() => s.selectByValue("")).toThrow(/non-empty value/);
    expect(() => s.selectByValue("   ")).toThrow(/non-empty value/);
    // The prior selection is untouched by the rejected call.
    expect(select.selectedIndex).toBe(0);
  });

  test("selectByValue selects an option with the matching literal value", () => {
    const select = document.createElement("select");
    const opt = document.createElement("option");
    opt.textContent = "Apple";
    opt.value = "fruit-apple";
    select.appendChild(opt);
    document.body.appendChild(select);
    new Select(select).selectByValue("fruit-apple");
    expect(select.value).toBe("fruit-apple");
  });
});

describe("Select helper index / optgroup / multi-select paths", () => {
  test("selectByIndex selects by position and dispatches exactly one change event", () => {
    const select = makeSelect(["A", "B", "C"]);
    const changes: Event[] = [];
    select.addEventListener("change", (e) => changes.push(e));
    new Select(select).selectByIndex(2);
    expect(select.selectedIndex).toBe(2);
    expect(select.value).toBe("C");
    expect(changes.length).toBe(1);
  });

  test("selectByIndex rejects non-integer, negative, and out-of-range indices", () => {
    const select = makeSelect(["A", "B"]);
    const s = new Select(select);
    expect(() => s.selectByIndex(1.5)).toThrow(/integer/);
    expect(() => s.selectByIndex(-1)).toThrow(/>= 0/);
    expect(() => s.selectByIndex(5)).toThrow(/out of range/);
    // The failed calls must not have mutated the selection.
    expect(select.selectedIndex).toBe(0);
  });

  test("selectByIndex counts options inside optgroups (positional index)", () => {
    const select = document.createElement("select");
    const group = document.createElement("optgroup");
    group.label = "Group";
    const a = document.createElement("option");
    a.textContent = "A";
    const b = document.createElement("option");
    b.textContent = "B";
    group.append(a, b);
    const c = document.createElement("option");
    c.textContent = "C";
    select.append(group, c);
    document.body.appendChild(select);

    new Select(select).selectByIndex(2); // index counts through the optgroup
    expect(select.value).toBe("C");
    expect(a.selected).toBe(false);
    expect(b.selected).toBe(false);
  });

  test("multi-select: selects every matching option and fires ONE change event", () => {
    const select = document.createElement("select");
    select.multiple = true;
    const o1 = document.createElement("option");
    o1.textContent = "Same";
    const o2 = document.createElement("option");
    o2.textContent = "Same";
    const o3 = document.createElement("option");
    o3.textContent = "Other";
    select.append(o1, o2, o3);
    document.body.appendChild(select);

    const changes: Event[] = [];
    select.addEventListener("change", (e) => changes.push(e));
    new Select(select).selectByVisibleText("Same");
    expect(o1.selected).toBe(true);
    expect(o2.selected).toBe(true);
    expect(o3.selected).toBe(false);
    expect(changes.length).toBe(1);
  });

  test("multi-select: a disabled matched option aborts the batch before mutating", () => {
    const select = document.createElement("select");
    select.multiple = true;
    const o1 = document.createElement("option");
    o1.textContent = "First";
    const o2 = document.createElement("option");
    o2.textContent = "Second";
    o2.disabled = true;
    select.append(o1, o2);
    document.body.appendChild(select);

    expect(() => new Select(select).selectByVisibleText("S")).toThrow(/disabled/);
    // Atomicity: the valid option was NOT selected before the guard threw.
    expect(o1.selected).toBe(false);
  });
});

describe("handleSelectDropdown custom-dropdown path", () => {
  /** A combobox-style custom widget: trigger + [role="option"] list. A click
   *  on an option flips its aria-selected (a real widget's selection
   *  registration). */
  function makeCustomDropdown(labels: string[]): HTMLElement {
    const combo = document.createElement("div");
    combo.setAttribute("role", "combobox");
    const list = document.createElement("div");
    list.setAttribute("role", "listbox");
    for (const label of labels) {
      const opt = document.createElement("div");
      opt.setAttribute("role", "option");
      opt.id = `opt-${label}`;
      opt.textContent = label;
      opt.addEventListener("click", () => opt.setAttribute("aria-selected", "true"));
      list.appendChild(opt);
    }
    combo.appendChild(list);
    document.body.appendChild(combo);
    return combo;
  }

  test("option_index selects the matching option in a custom dropdown", async () => {
    const combo = makeCustomDropdown(["Red", "Green", "Blue"]);
    const res = await handleSelectDropdown(ctxFor(combo, 1), {
      type: "select_dropdown",
      index: 1,
      option_index: 2,
    });
    expect(res.success).toBe(true);
    expect(res.message).toContain("Blue");
    expect(res.pageChanged).toBe(false);
    expect(combo.querySelector('[role="option"][aria-selected="true"]')?.textContent).toBe("Blue");
  });

  test("text matches an option in a custom dropdown (aria-selected registration)", async () => {
    const combo = makeCustomDropdown(["Red", "Green", "Blue"]);
    const res = await handleSelectDropdown(ctxFor(combo, 1), {
      type: "select_dropdown",
      index: 1,
      text: "Green",
    });
    expect(res.success).toBe(true);
    expect(res.message).toContain("Green");
  });

  test("fails loudly when the widget does NOT register the selection (synthetic click no-op)", async () => {
    // A widget that binds mousedown/pointerdown only — the synthetic `.click()`
    // does nothing, so its exposed selection state (aria-selected) never flips
    // and the trigger text never changes. Because it DOES expose observable
    // selection state, the verification must catch the no-op.
    const combo = document.createElement("div");
    combo.setAttribute("role", "combobox");
    const opt = document.createElement("div");
    opt.setAttribute("role", "option");
    opt.setAttribute("aria-selected", "false");
    opt.textContent = "Silent";
    combo.appendChild(opt);
    document.body.appendChild(combo);

    const res = await handleSelectDropdown(ctxFor(combo, 1), {
      type: "select_dropdown",
      index: 1,
      text: "Silent",
    });
    expect(res.success).toBe(false);
    expect(res.message).toContain("did not register the selection");
  });

  test("custom dropdown without options fails with an explicit no-options message", async () => {
    const combo = document.createElement("div");
    combo.setAttribute("role", "combobox");
    document.body.appendChild(combo);
    const res = await handleSelectDropdown(ctxFor(combo, 1), {
      type: "select_dropdown",
      index: 1,
      text: "Anything",
    });
    expect(res.success).toBe(false);
    expect(res.message).toContain("no options");
  });
});
