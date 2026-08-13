/**
 * Phantom-cursor stealth gate — the fake mouse cursor is a page-visible
 * artifact (an SVG overlay appended to `document.body`). It runs in NORMAL
 * mode (the user's visual "where is the agent pointing" indicator) and is
 * SUPPRESSED when stealth mode is on, so a stealth user's page sees no
 * automation artifacts. When suppressed, the API stays callable
 * (promise-resolving) but never touches the DOM.
 */

import { describe, test, expect, beforeEach } from "vitest";
import {
  movePhantomCursor,
  moveCursorToElement,
} from "../src/lib/agent/dom/interaction/hover";
import { _setStealthEnabledCacheForTests } from "../src/lib/agent/anti-detection-utils";

beforeEach(() => {
  document.body.innerHTML = "";
  _setStealthEnabledCacheForTests(null);
});

describe("phantom cursor stealth gate", () => {
  test("cursor element is created when stealth is explicitly off", async () => {
    _setStealthEnabledCacheForTests(false);
    await movePhantomCursor(10, 20);
    expect(document.querySelectorAll("[data-oc-cursor]")).toHaveLength(1);
  });

  test("moveCursorToElement resolves coordinates and shows the cursor when stealth is off", async () => {
    _setStealthEnabledCacheForTests(false);
    const el = document.createElement("button");
    document.body.appendChild(el);
    const coords = await moveCursorToElement(el);
    expect(typeof coords.x).toBe("number");
    expect(typeof coords.y).toBe("number");
    expect(document.querySelectorAll("[data-oc-cursor]")).toHaveLength(1);
  });

  test("no cursor element is created when stealth mode is on (no page mutation)", async () => {
    _setStealthEnabledCacheForTests(true);
    await movePhantomCursor(10, 20);
    expect(document.querySelectorAll("[data-oc-cursor]")).toHaveLength(0);
  });

  test("moveCursorToElement still resolves coordinates without touching the page in stealth mode", async () => {
    _setStealthEnabledCacheForTests(true);
    const el = document.createElement("button");
    document.body.appendChild(el);
    const coords = await moveCursorToElement(el);
    expect(typeof coords.x).toBe("number");
    expect(typeof coords.y).toBe("number");
    expect(document.querySelectorAll("[data-oc-cursor]")).toHaveLength(0);
  });
});
