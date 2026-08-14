/**
 * Regression tests for DOM-extraction hardening fixes:
 *  - shadow-piercer backdoor rejects fabricated (non-iterable) fake shadow roots
 *  - AX-tree heading text is escaped exactly once
 *  - `redactUrlTokens` / `redactIframeSrc` neutralize non-http(s) schemes
 *
 * Run with: `npx vitest run tests/dom-extraction-hardening.test.ts`
 */

import { describe, test, expect, beforeEach } from "vitest";
import {
  extractBrowserState,
  resetDomBaseline,
} from "../src/lib/agent/dom/extractor";
import {
  getShadowRoot,
  _resetShadowPiercerForTests,
  installShadowPiercer,
} from "../src/lib/agent/dom/shadow-piercer";
import { redactUrlTokens } from "../src/lib/agent/dom/extraction/element-info-utils";
import { _setStealthEnabledCacheForTests } from "../src/lib/agent/anti-detection-utils";
import {
  generateAccessibilityTree,
  __test_resetRegistry,
} from "../src/lib/agent/dom/extraction/ax-tree-builder";
import type { TabInfo } from "../src/lib/agent/types";
import { installJsdomLayoutMock } from "./helpers";

const MOCK_TABS: TabInfo[] = [
  { id: 1, label: "1", url: "https://example.com", title: "Test", active: true },
];

beforeEach(() => {
  document.body.innerHTML = "";
  resetDomBaseline();
  __test_resetRegistry();
  _resetShadowPiercerForTests();
  installShadowPiercer({ tagExisting: true });
  installJsdomLayoutMock();
  // The cross-world backdoor is gated behind stealth mode — enable it so the
  // hostile-backdoor rejection path below is exercised (readBackdoor consults
  // window only when stealth is on).
  _setStealthEnabledCacheForTests(true);
});

describe("shadow-piercer backdoor hardening", () => {
  test("hostile fake-node backdoor is rejected and does not throw when walked", () => {
    _resetShadowPiercerForTests();
    // A hostile page overwrites the cross-world backdoor to return a node
    // that only mimics a ShadowRoot (real ShadowRoots expose an iterable
    // `childNodes`).
    (window as any)[Symbol.for("__open_cowork_piercer_bd__")] = {
      getShadowRoot: () => ({ nodeType: 11, host: {} }),
      hasShadowRoot: () => false,
      stats: () => ({ installed: true, open: 0, closed: 0 }),
    };

    const el = document.createElement("div");
    document.body.appendChild(el);

    let threw = false;
    let result: unknown = null;
    try {
      result = getShadowRoot(el);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toBeNull();

    // The full page-state walk must not throw either.
    expect(() => extractBrowserState(MOCK_TABS)).not.toThrow();
  });
});

describe("interactive-container visibility", () => {
  test("a hidden onclick container is NOT indexed as a phantom click target", () => {
    const visible = document.createElement("div");
    visible.setAttribute("onclick", "doThing()");
    visible.textContent = "Visible container";
    document.body.appendChild(visible);

    const hidden = document.createElement("div");
    hidden.setAttribute("onclick", "doThing()");
    hidden.textContent = "Hidden container";
    hidden.style.opacity = "0";
    document.body.appendChild(hidden);

    const state = extractBrowserState(MOCK_TABS);
    // Only the visible container is indexed; the opacity:0 one is skipped by
    // the full visibility check before indexing.
    expect(state.elementsText).toContain("[1]<div");
    expect(state.elementsText).not.toContain("[2]<div");
    expect(Object.keys(state.selectorMap)).toHaveLength(1);
    // The hidden container's text is dropped too (parent visibility cached as
    // false by the element walk).
    expect(state.elementsText).not.toContain("Hidden container");
  });
});

describe("aria-hidden ancestor gating", () => {
  test("elements under an aria-hidden ancestor are excluded; a visible sibling stays included", () => {
    const hiddenWrapper = document.createElement("div");
    hiddenWrapper.setAttribute("aria-hidden", "true");
    const hiddenChild = document.createElement("button");
    hiddenChild.textContent = "Hidden subtree button";
    hiddenWrapper.appendChild(hiddenChild);
    document.body.appendChild(hiddenWrapper);

    const visibleSibling = document.createElement("button");
    visibleSibling.textContent = "Visible sibling button";
    document.body.appendChild(visibleSibling);

    const state = extractBrowserState(MOCK_TABS);
    expect(state.elementsText).toContain("Visible sibling button");
    expect(state.elementsText).not.toContain("Hidden subtree button");
    // Only the visible sibling is indexed as an interactive element.
    expect(Object.keys(state.selectorMap)).toHaveLength(1);
  });
});

describe("AX-tree heading escaping", () => {
  test("heading text with & is escaped exactly once", () => {
    const h = document.createElement("h1");
    h.textContent = "FAQ & Products";
    document.body.appendChild(h);

    const { pageContent } = generateAccessibilityTree("all", 15);
    expect(pageContent).toContain("FAQ &amp; Products");
    expect(pageContent).not.toContain("&amp;amp;");
  });

  test("heading text with < is escaped exactly once", () => {
    const h = document.createElement("h2");
    h.textContent = "a < b";
    document.body.appendChild(h);

    const { pageContent } = generateAccessibilityTree("all", 15);
    expect(pageContent).toContain("a &lt; b");
    expect(pageContent).not.toContain("&amp;lt;");
  });
});

describe("URL token redaction", () => {
  test("non-http(s) schemes are neutralized", () => {
    expect(redactUrlTokens("javascript:alert(1)")).toBe("[non-http url redacted]");
    expect(redactUrlTokens("data:text/html,<script>1</script>")).toBe(
      "[non-http url redacted]",
    );
  });

  test("http(s) navigation links keep scheme+host+path and drop tokens", () => {
    expect(redactUrlTokens("https://example.com/path?token=1#frag")).toBe(
      "https://example.com/path",
    );
    expect(redactUrlTokens("http://example.com/?a=1")).toBe("http://example.com/");
  });
});
