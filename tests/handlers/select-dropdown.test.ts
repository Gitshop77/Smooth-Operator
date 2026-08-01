/**
 * `select_dropdown` native-`<select>` text matching — a digit-string like "2"
 * must match an option's visible text or value, and must NEVER be
 * reinterpreted as a positional index: on [Apple, Banana, Cherry], "2" would
 * silently select Cherry. A digit string that matches no option's text/value
 * must fail loudly instead.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { handleSelectDropdown } from "../../src/lib/agent/tools/handlers/select-dropdown";
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
