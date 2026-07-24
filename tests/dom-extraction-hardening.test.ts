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
import { redactUrlTokens } from "../src/lib/agent/dom/extraction/element-info";
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
