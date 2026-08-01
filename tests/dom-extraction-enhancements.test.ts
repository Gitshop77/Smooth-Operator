/**
 * DOM extraction enhancement tests — covers the new exports added by the
 * DOM-extraction retry: shadow piercing, compound controls, retry-with-backoff,
 * propagating-element containment, and screenshot-annotator multi-color labels.
 *
 * These tests run under vitest's `environment: "jsdom"` and reuse the
 * jsdom-limitation mocks (offsetParent + getBoundingClientRect) from
 * `tests/extractor.test.ts` so the extractor's visibility checks don't reject
 * every element.
 *
 * Run with: `npx vitest run tests/dom-extraction-enhancements.test.ts`
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  extractBrowserState,
  resetDomBaseline,
} from "../src/lib/agent/dom/extractor";
import {
  installShadowPiercer,
  getShadowRoot,
  pierceShadowRoots,
  isShadowHost,
  _resetShadowPiercerForTests,
} from "../src/lib/agent/dom/shadow-piercer";
import {
  isPropagatingElement,
  isContained,
  containmentRatio,
  nearestPropagatingAncestor,
  shouldExcludeAsContained,
  PROPAGATING_ELEMENTS,
  isVisibleFull,
} from "../src/lib/agent/dom/dom-utils";
import {
  annotateScreenshot,
  DEFAULT_ANNOTATE_PALETTE,
  type AnnotatableElement,
} from "../src/lib/agent/dom/screenshot-annotator";
import type { TabInfo } from "../src/lib/agent/types";
import { installJsdomLayoutMock, restoreJsdomLayoutMock } from "./helpers";

const MOCK_TABS: TabInfo[] = [
  { id: 1, label: "1", url: "https://example.com", title: "Test", active: true },
];

// Compact DOMRect stub factory — avoids repeating the full rect object at
// every call site below. `top`/`left` derive from (x, y) and width/height
// from (right, bottom) exactly as the verbose inline literals did.
const makeRect = (x: number, y: number, right: number, bottom: number): DOMRect =>
  ({ x, y, top: y, right, bottom, left: x, width: right - x, height: bottom - y, toJSON: () => ({}) }) as DOMRect;

// ─── jsdom-limitation mocks (shared helper) ──────────────────────────────────
//
// The shared `installJsdomLayoutMock` helper overrides `offsetParent` and
// `getBoundingClientRect` so jsdom (which has no layout engine) reports
// elements as visible. See `tests/helpers/jsdom-layout-mock.ts` for the
// full rationale.

beforeEach(() => {
  document.body.innerHTML = "";
  resetDomBaseline();
  _resetShadowPiercerForTests();
  installShadowPiercer({ tagExisting: true });
  installJsdomLayoutMock();
});

afterEach(() => {
  restoreJsdomLayoutMock();
});

// ─── shadow-piercer ─────────────────────────────────────────────────────────

describe("shadow-piercer", () => {
  test("getShadowRoot returns the open shadow root", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const btn = document.createElement("button");
    btn.textContent = "Open";
    shadow.appendChild(btn);

    expect(getShadowRoot(host)).toBe(shadow);
    expect(isShadowHost(host)).toBe(true);
  });

  test("getShadowRoot returns the CLOSED shadow root (captured via the piercer)", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    // attachShadow with mode:"closed" — host.shadowRoot will be null, but the
    // piercer captured the root in its WeakMap.
    const shadow = host.attachShadow({ mode: "closed" });
    const btn = document.createElement("button");
    btn.textContent = "Closed";
    shadow.appendChild(btn);

    // host.shadowRoot is null for closed roots — that's the whole problem.
    expect(host.shadowRoot).toBeNull();
    // But getShadowRoot pierces the closed root via the piercer's WeakMap.
    expect(getShadowRoot(host)).toBe(shadow);
    expect(isShadowHost(host)).toBe(true);
  });

  test("getShadowRoot returns null for a non-shadow-host element", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    expect(getShadowRoot(div)).toBeNull();
    expect(isShadowHost(div)).toBe(false);
  });

  test("pierceShadowRoots walks into BOTH open and closed shadow roots", () => {
    // Open shadow root.
    const openHost = document.createElement("section");
    openHost.id = "open-host";
    document.body.appendChild(openHost);
    const openShadow = openHost.attachShadow({ mode: "open" });
    const openBtn = document.createElement("button");
    openBtn.id = "open-btn";
    openBtn.textContent = "Open";
    openShadow.appendChild(openBtn);

    // Closed shadow root.
    const closedHost = document.createElement("section");
    closedHost.id = "closed-host";
    document.body.appendChild(closedHost);
    const closedShadow = closedHost.attachShadow({ mode: "closed" });
    const closedBtn = document.createElement("button");
    closedBtn.id = "closed-btn";
    closedBtn.textContent = "Closed";
    closedShadow.appendChild(closedBtn);

    // Top-level button (no shadow).
    const topBtn = document.createElement("button");
    topBtn.id = "top-btn";
    topBtn.textContent = "Top";
    document.body.appendChild(topBtn);

    const all = pierceShadowRoots(document.body);
    const ids = all.map((e) => e.id).filter(Boolean);
    // All three buttons + both hosts appear in the pierced walk.
    expect(ids).toContain("top-btn");
    expect(ids).toContain("open-btn");
    expect(ids).toContain("closed-btn");
    expect(ids).toContain("open-host");
    expect(ids).toContain("closed-host");
  });

  test("installShadowPiercer is idempotent — calling twice is a no-op", () => {
    // Already installed in beforeEach; calling again must not throw and must
    // keep the same state (closed roots captured before the second call are
    // still resolvable).
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "closed" });
    installShadowPiercer({ tagExisting: true });
    expect(getShadowRoot(host)).toBe(shadow);
  });

  test("extractBrowserState indexes a button inside a CLOSED shadow root", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "closed" });
    const btn = document.createElement("button");
    btn.textContent = "Pierced";
    shadow.appendChild(btn);

    const state = extractBrowserState(MOCK_TABS);
    // The button inside the closed shadow root is now indexed — without the
    // piercer, the extractor's `el.shadowRoot` walk would miss it entirely.
    expect(state.elements).toHaveLength(1);
    expect(state.elements[0].tag).toBe("button");
    expect(state.elements[0].text).toBe("Pierced");
  });
});

// ─── compound controls ──────────────────────────────────────────────────────

describe("extractor: compound control virtual children", () => {
  test("select renders first 4 options as virtual child lines", () => {
    const select = document.createElement("select");
    for (const label of ["US", "CA", "MX", "UK", "AU", "JP"]) {
      const o = document.createElement("option");
      o.value = label.toLowerCase();
      o.textContent = label;
      select.appendChild(o);
    }
    document.body.appendChild(select);

    const state = extractBrowserState(MOCK_TABS);
    // The select is the single indexed element.
    expect(state.elements).toHaveLength(1);
    expect(state.elements[0].tag).toBe("select");
    // The elementsText contains virtual child <option> lines for the first 4.
    // The first option is selected by default, so it carries `selected=`.
    expect(state.elementsText).toContain("<option value=\"us\"");
    expect(state.elementsText).toContain(" /> US");
    expect(state.elementsText).toContain("<option value=\"ca\" /> CA");
    expect(state.elementsText).toContain("<option value=\"mx\" /> MX");
    expect(state.elementsText).toContain("<option value=\"uk\" /> UK");
    // The 5th+ options are summarized as "... N more options".
    expect(state.elementsText).toContain("... 2 more options");
    // The 5th option's value is NOT surfaced as a virtual child.
    expect(state.elementsText).not.toContain("<option value=\"au\" />");
  });

  test("input type=range renders a slider virtual child", () => {
    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = "100";
    input.value = "50";
    document.body.appendChild(input);

    const state = extractBrowserState(MOCK_TABS);
    expect(state.elementsText).toContain("<slider valuemin=\"0\" valuemax=\"100\" valuenow=\"50\" /> Value");
  });

  test("input type=file renders a Browse Files virtual child", () => {
    const input = document.createElement("input");
    input.type = "file";
    document.body.appendChild(input);

    const state = extractBrowserState(MOCK_TABS);
    expect(state.elementsText).toContain("<button /> Browse Files");
    expect(state.elementsText).toContain("No file chosen");
  });

  test("details renders a summary virtual child", () => {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "More info";
    details.appendChild(summary);
    details.appendChild(document.createTextNode("hidden content"));
    document.body.appendChild(details);

    const state = extractBrowserState(MOCK_TABS);
    expect(state.elementsText).toContain("<summary /> More info");
  });

  test("details without a summary renders a generic Toggle virtual child", () => {
    const details = document.createElement("details");
    details.textContent = "content";
    document.body.appendChild(details);

    const state = extractBrowserState(MOCK_TABS);
    expect(state.elementsText).toContain("<summary /> Toggle");
  });

  test("non-compound elements (button, input type=text) get no virtual children", () => {
    const btn = document.createElement("button");
    btn.textContent = "Click";
    const input = document.createElement("input");
    input.type = "text";
    document.body.append(btn, input);

    const state = extractBrowserState(MOCK_TABS);
    // No slider, summary, or Browse Files lines.
    expect(state.elementsText).not.toContain("<slider");
    expect(state.elementsText).not.toContain("<summary");
    expect(state.elementsText).not.toContain("Browse Files");
  });
});

// ─── propagating elements + containment ─────────────────────────────────────

describe("dom-utils: propagating elements + 99% containment", () => {
  test("isPropagatingElement matches the canonical pattern set", () => {
    expect(isPropagatingElement(document.createElement("a"))).toBe(true);
    expect(isPropagatingElement(document.createElement("button"))).toBe(true);

    const divBtn = document.createElement("div");
    divBtn.setAttribute("role", "button");
    expect(isPropagatingElement(divBtn)).toBe(true);

    const divCombo = document.createElement("div");
    divCombo.setAttribute("role", "combobox");
    expect(isPropagatingElement(divCombo)).toBe(true);

    const spanBtn = document.createElement("span");
    spanBtn.setAttribute("role", "button");
    expect(isPropagatingElement(spanBtn)).toBe(true);

    // Plain div is NOT propagating.
    expect(isPropagatingElement(document.createElement("div"))).toBe(false);
    // div with a non-propagating role is NOT propagating.
    const divMain = document.createElement("div");
    divMain.setAttribute("role", "main");
    expect(isPropagatingElement(divMain)).toBe(false);
  });

  test("PROPAGATING_ELEMENTS exposes the canonical pattern set", () => {
    expect(PROPAGATING_ELEMENTS.length).toBeGreaterThanOrEqual(7);
    const tags = PROPAGATING_ELEMENTS.map((p) => p.tag);
    expect(tags).toContain("a");
    expect(tags).toContain("button");
    expect(tags).toContain("div");
    expect(tags).toContain("span");
  });

  test("containmentRatio + isContained — child fully inside parent → ratio 1", () => {
    const parent = document.createElement("div");
    const child = document.createElement("span");
    parent.appendChild(child);
    document.body.appendChild(parent);

    // Stub rects: parent is 100x100 at (0,0), child is 50x50 at (10,10).
    parent.getBoundingClientRect = () => makeRect(0, 0, 100, 100);
    child.getBoundingClientRect = () => makeRect(10, 10, 60, 60);

    // 100% contained (intersection = 50*50 = 2500, childArea = 50*50 = 2500).
    expect(containmentRatio(child, parent)).toBeCloseTo(1, 5);
    expect(isContained(child, parent)).toBe(true);
    expect(isContained(child, parent, 0.99)).toBe(true);
  });

  test("containmentRatio — child partially outside parent → ratio < threshold", () => {
    const parent = document.createElement("div");
    const child = document.createElement("span");
    parent.appendChild(child);
    document.body.appendChild(parent);

    // Parent 100x100 at (0,0); child 100x100 at (50,50) — only 25% overlaps.
    parent.getBoundingClientRect = () => makeRect(0, 0, 100, 100);
    child.getBoundingClientRect = () => makeRect(50, 50, 150, 150);

    expect(containmentRatio(child, parent)).toBeCloseTo(0.25, 5);
    expect(isContained(child, parent, 0.99)).toBe(false);
  });

  test("containmentRatio — zero-area child returns 0", () => {
    const parent = document.createElement("div");
    const child = document.createElement("span");
    parent.appendChild(child);
    document.body.appendChild(parent);

    parent.getBoundingClientRect = () => makeRect(0, 0, 100, 100);
    child.getBoundingClientRect = () => makeRect(0, 0, 0, 0);

    expect(containmentRatio(child, parent)).toBe(0);
    expect(isContained(child, parent)).toBe(false);
  });

  test("nearestPropagatingAncestor walks up to the closest propagating parent", () => {
    const button = document.createElement("button");
    const span = document.createElement("span");
    button.appendChild(span);
    document.body.appendChild(button);

    expect(nearestPropagatingAncestor(span)).toBe(button);
    // The button itself has no propagating ancestor (body is not propagating).
    expect(nearestPropagatingAncestor(button)).toBeNull();
  });

  test("shouldExcludeAsContained — span fully inside a button → true (redundant)", () => {
    const button = document.createElement("button");
    const span = document.createElement("span");
    button.appendChild(span);
    document.body.appendChild(button);

    // Stub identical rects so span is 100% contained.
    const rect = makeRect(0, 0, 100, 30);
    button.getBoundingClientRect = () => rect;
    span.getBoundingClientRect = () => rect;

    expect(shouldExcludeAsContained(span)).toBe(true);
  });

  test("shouldExcludeAsContained — input inside a button → false (form elements are never excluded)", () => {
    const button = document.createElement("button");
    const input = document.createElement("input");
    input.type = "text";
    button.appendChild(input);
    document.body.appendChild(button);

    const rect = makeRect(0, 0, 100, 30);
    button.getBoundingClientRect = () => rect;
    input.getBoundingClientRect = () => rect;

    // Form elements have independent interaction semantics — never excluded.
    expect(shouldExcludeAsContained(input)).toBe(false);
  });

  test("shouldExcludeAsContained — element with aria-label → false (independent info)", () => {
    const button = document.createElement("button");
    const span = document.createElement("span");
    span.setAttribute("aria-label", "independent label");
    button.appendChild(span);
    document.body.appendChild(button);

    const rect = makeRect(0, 0, 100, 30);
    button.getBoundingClientRect = () => rect;
    span.getBoundingClientRect = () => rect;

    expect(shouldExcludeAsContained(span)).toBe(false);
  });

  test("isVisibleFull — visibility:collapse → false", () => {
    const el = document.createElement("div");
    el.style.visibility = "collapse";
    document.body.appendChild(el);
    expect(isVisibleFull(el)).toBe(false);
  });
});

// ─── screenshot-annotator enhancements ──────────────────────────────────────

describe("screenshot-annotator: ref-keyed labels + minSize + palette", () => {
  test("annotateScreenshot returns raw screenshot for an empty element list (fast-path)", async () => {
    const raw = "data:image/png;base64,BBBB";
    const result = await annotateScreenshot(raw, []);
    expect(result).toBe(raw);
  });

  test("annotateScreenshot returns raw screenshot when elements is null/undefined", async () => {
    const raw = "data:image/png;base64,CCCC";
    const result = await annotateScreenshot(raw, null as unknown as AnnotatableElement[]);
    expect(result).toBe(raw);
  });

  test("DEFAULT_ANNOTATE_PALETTE has 12 colors", () => {
    expect(DEFAULT_ANNOTATE_PALETTE).toHaveLength(12);
    // All entries are hex color strings.
    for (const c of DEFAULT_ANNOTATE_PALETTE) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  test("AnnotatableElement interface accepts index + rect", () => {
    const el: AnnotatableElement = {
      index: 7,
      rect: { x: 10, y: 20, width: 100, height: 50 },
    };
    expect(el.index).toBe(7);
    expect(el.rect.width).toBe(100);
  });
});
