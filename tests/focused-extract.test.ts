import { afterEach, beforeEach, describe, expect, it, test } from "vitest";
import { focusedPageText } from "../src/lib/agent/tools/handlers/extract";
import {
  extractBrowserState,
  getElementIdentities,
  getSelectorMap,
  resetDomBaseline,
} from "../src/lib/agent/dom/extraction/page-state";
import { hashElement } from "../src/lib/agent/dom/extractor";
import { elementIdentity } from "../src/lib/agent/dom/extraction/element-info";
import { installJsdomLayoutMock, restoreJsdomLayoutMock } from "./helpers";

beforeEach(() => {
  document.body.innerHTML = "";
  resetDomBaseline();
  installJsdomLayoutMock();
});

afterEach(() => {
  restoreJsdomLayoutMock();
});

describe("focusedPageText", () => {
  test("keeps query matches with adjacent context instead of a giant page head", () => {
    const lines = Array.from({ length: 800 }, (_, i) =>
      i === 640 ? "Artemis crew includes Reid Wiseman and Victor Glover" : `unrelated navigation item ${i}`,
    );
    const result = focusedPageText(lines.join("\n"), "Find the Artemis crew names");
    expect(result).toContain("Reid Wiseman");
    expect(result).toContain("navigation item 639");
    expect(result.length).toBeLessThanOrEqual(8_040);
    expect(result).not.toContain("navigation item 20\n");
  });

  test("falls back to a bounded head and tail when no query term matches", () => {
    const result = focusedPageText("A".repeat(20_000), "unfindable zebra phrase");
    expect(result).toContain("middle omitted");
    expect(result.length).toBeLessThanOrEqual(8_050);
  });

  it("selectorMap reuse is incremental across extractions (map identity is preserved)", () => {
    document.body.innerHTML = "<button id='b1'>One</button><a id='a1' href='https://example.com/'>Link</a>";
    extractBrowserState([]);
    const mapAfterFirst = getSelectorMap();
    const identitiesAfterFirst = getElementIdentities();
    const second = extractBrowserState([]);
    expect(getSelectorMap()).toBeDefined();
    // both walks see the same selectorMap object mutated in place
    expect(getSelectorMap()).toBe(mapAfterFirst);
    expect(getElementIdentities()).toBe(identitiesAfterFirst);
    expect(Object.keys(getSelectorMap()).length).toBeGreaterThan(0);
    expect(second.elements.length).toBeGreaterThan(0);
  });
});

// ─── elementIdentity / hashElement dedup pins ────────────────────────────────
//
// The walker computes `elementIdentity(el, attrs)` once per indexed element and
// threads it into both `hashElement` (which FNV-hashes that exact identity) and
// the per-index `elementIdentities` record. These pins freeze the contract:
// the recorded identity must be exactly the identity embedded (via FNV) in the
// element's hash, and an externally precomputed identity must produce the same
// hash as letting `hashElement` compute it internally.

describe("elementIdentity/hashElement dedup contract", () => {
  test("elementIdentities is exactly the identity embedded in each element's hash", () => {
    document.body.innerHTML = `
      <form>
        <label>Name <input name="name" placeholder="Jane Doe" /></label>
        <button type="submit">Save</button>
      </form>
      <div role="navigation"><a href="/home">Home</a></div>
      <details><summary>More</summary><p>details body</p></details>
      <select name="color"><option>red</option><option>blue</option></select>
    `;
    const state = extractBrowserState([]);
    expect(state.elements.length).toBeGreaterThan(1);

    for (const el of state.elements) {
      const idx = el.index;
      const live = state.selectorMap[idx] as HTMLElement;
      const recorded = state.elementIdentities?.[idx];
      expect(live).toBeTruthy();
      expect(recorded).toBeTruthy();
      expect(elementIdentity(live, el.attributes)).toBe(recorded);
      expect(hashElement(live, el.attributes, recorded)).toBe(el.hash);
    }
  });

  test("precomputed identity yields the same hash as letting hashElement compute it", () => {
    const btn = document.createElement("button");
    btn.textContent = "Save";
    document.body.appendChild(btn);
    const state = extractBrowserState([]);
    expect(state.elements).toHaveLength(1);
    const el = state.selectorMap[1] as HTMLElement;
    const attrs = state.elements[0].attributes;
    expect(hashElement(el, attrs, elementIdentity(el, attrs))).toBe(hashElement(el, attrs));
    expect(hashElement(el, attrs, elementIdentity(el, attrs))).toBe(state.elements[0].hash);
  });
});
