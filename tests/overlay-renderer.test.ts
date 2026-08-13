/**
 * Overlay-renderer tests — the highlight path the handler tests mock away
 * (`tests/handlers.test.ts` mocks `highlightElement` outright), so the real
 * behavior was unverified: style capture/restore, overlapping-highlight
 * counting, idempotent `remove`, timeout auto-remove, badge positioning, and
 * the aria-live region.
 *
 * Run with: `npx vitest run tests/overlay-renderer.test.ts`
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import * as overlayModule from "../src/lib/agent/dom/annotation/overlay-renderer";
import { highlightElement } from "../src/lib/agent/dom/annotation/overlay-renderer";
import { _setStealthEnabledCacheForTests } from "../src/lib/agent/anti-detection-utils";
import { installJsdomLayoutMock, restoreJsdomLayoutMock } from "./helpers";

beforeEach(() => {
  document.body.innerHTML = "";
  installJsdomLayoutMock();
  // The overlay is a page-visible artifact that renders in NORMAL mode and
  // is suppressed when stealth mode is on — ensure stealth is OFF so the
  // highlight path actually runs.
  _setStealthEnabledCacheForTests(false);
});

afterEach(() => {
  restoreJsdomLayoutMock();
  vi.useRealTimers();
  _setStealthEnabledCacheForTests(null);
});

function makeButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.textContent = "Go";
  document.body.appendChild(btn);
  return btn;
}

describe("style capture / restore", () => {
  test("applies the highlight styles and restores the originals on remove", () => {
    const btn = makeButton();
    btn.style.outline = "1px solid red";
    btn.style.backgroundColor = "#ffffff";
    const beforeOutline = btn.style.outline;
    const beforeBg = btn.style.backgroundColor;

    const handle = highlightElement(btn, "Click Go");
    expect(btn.style.outline).toBe("3px solid #f97316");
    expect(btn.style.outline).not.toBe(beforeOutline);
    expect(btn.style.backgroundColor).not.toBe(beforeBg);

    handle.remove();
    expect(btn.style.outline).toBe(beforeOutline);
    expect(btn.style.backgroundColor).toBe(beforeBg);
  });

  test("overlapping highlights restore the original styles only after the LAST remove", () => {
    const btn = makeButton();
    btn.style.outline = "1px solid red";

    const first = highlightElement(btn, "One");
    const second = highlightElement(btn, "Two");
    expect(btn.style.outline).toBe("3px solid #f97316");

    first.remove();
    // Still one active highlight → the highlight style stays.
    expect(btn.style.outline).toBe("3px solid #f97316");

    second.remove();
    expect(btn.style.outline).toBe("1px solid red");
  });

  test("remove is idempotent — calling twice restores exactly once", () => {
    const btn = makeButton();
    btn.style.outline = "1px solid red";

    const handle = highlightElement(btn, "Go");
    handle.remove();
    handle.remove();
    expect(btn.style.outline).toBe("1px solid red");
  });

  test("auto-removes after the highlight duration", () => {
    vi.useFakeTimers();
    const btn = makeButton();
    btn.style.outline = "1px solid red";

    highlightElement(btn, "Go");
    expect(btn.style.outline).toBe("3px solid #f97316");

    vi.advanceTimersByTime(1201);
    expect(btn.style.outline).toBe("1px solid red");
  });
});

describe("badge + aria-live", () => {
  test("draws a positioned floating badge with the label text", () => {
    const btn = makeButton();
    const handle = highlightElement(btn, "Click Go");

    // The decorative badge is the `aria-hidden` div carrying the label (the
    // visually-hidden aria-live region carries the same text, so filter by
    // aria-hidden to disambiguate).
    const badges = Array.from(document.querySelectorAll("div")).filter(
      (d) => d.getAttribute("aria-hidden") === "true" && d.textContent === "Click Go",
    );
    expect(badges).toHaveLength(1);
    const badge = badges[0];
    expect(badge.getAttribute("aria-hidden")).toBe("true");
    expect(badge.style.position).toBe("fixed");
    // Layout mock rect is (0,0,100,30): badge sits at the min-coordinate
    // clamp above the element.
    expect(badge.style.left).toBe("4px");
    expect(badge.style.top).toBe("4px");

    handle.remove();
    expect(badge.isConnected).toBe(false);
  });

  test("announces the action via a single memoized aria-live region", () => {
    const btn = makeButton();
    highlightElement(btn, "Announce me");
    let regions = document.querySelectorAll('[aria-live="polite"]');
    expect(regions).toHaveLength(1);
    expect(regions[0].textContent).toBe("Announce me");

    highlightElement(btn, "Again");
    regions = document.querySelectorAll('[aria-live="polite"]');
    expect(regions).toHaveLength(1);
    expect(regions[0].textContent).toBe("Again");
  });
});

describe("public API surface", () => {
  test("setPersistentHighlight is no longer exported (dead API removed)", () => {
    expect(
      (overlayModule as unknown as Record<string, unknown>).setPersistentHighlight,
    ).toBeUndefined();
  });
});

describe("stealth gate", () => {
  test("highlightElement is a no-op when stealth mode is on (no page mutation)", () => {
    _setStealthEnabledCacheForTests(true);
    const btn = makeButton();
    const handle = highlightElement(btn, "Should not render");
    // The handle contract is preserved…
    expect(typeof handle.remove).toBe("function");
    handle.remove();
    // …but the page is untouched: no outline style, no badge, no aria-live region.
    expect(btn.style.outline).toBe("");
    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(0);
    expect(
      Array.from(document.querySelectorAll("div")).filter(
        (d) => d.getAttribute("aria-hidden") === "true",
      ),
    ).toHaveLength(0);
  });
});
