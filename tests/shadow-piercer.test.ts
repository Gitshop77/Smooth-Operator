/**
 * Shadow-piercer tests — the legacy shim's export surface vs the canonical
 * module (parity), plus reset/reinstall behavior:
 *
 * - `_resetShadowPiercerForTests` must restore the ORIGINAL `attachShadow`
 *   prototype (not just strip the patch sentinel), so repeated installs in
 *   one document don't wrap the previous patch and accumulate state.
 * - The cross-world backdoor surface stays minimal: it exposes only the
 *   members production code consumes (`getShadowRoot`, `stats`) — no dead
 *   members like the removed `hasShadowRoot`.
 *
 * Run with: `npx vitest run tests/shadow-piercer.test.ts`
 */

import { describe, test, expect, beforeEach } from "vitest";
import * as shim from "@/lib/agent/dom/shadow-piercer";
import * as canonical from "@/lib/agent/dom/annotation/shadow-piercer";
import {
  installShadowPiercer,
  getShadowRoot,
  _resetShadowPiercerForTests,
} from "../src/lib/agent/dom/shadow-piercer";
import { _setStealthEnabledCacheForTests } from "../src/lib/agent/anti-detection-utils";

beforeEach(() => {
  document.body.innerHTML = "";
  _resetShadowPiercerForTests();
  // The cross-world backdoor is a page-observable artifact that is published
  // in NORMAL mode and suppressed when stealth mode is on — ensure stealth is
  // OFF so the backdoor surface is published.
  _setStealthEnabledCacheForTests(false);
});

describe("shim parity", () => {
  test("the legacy dom/shadow-piercer shim mirrors the canonical module exactly", () => {
    const shimKeys = Object.keys(shim).sort();
    const canonicalKeys = Object.keys(canonical).sort();
    expect(shimKeys).toEqual(canonicalKeys);
  });
});

describe("reset / reinstall", () => {
  test("reset restores the original attachShadow prototype", () => {
    const original = Element.prototype.attachShadow;
    installShadowPiercer();
    expect(Element.prototype.attachShadow).not.toBe(original);

    _resetShadowPiercerForTests();
    expect(Element.prototype.attachShadow).toBe(original);
  });

  test("a closed root created after reset is no longer captured", () => {
    installShadowPiercer();
    _resetShadowPiercerForTests();

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "closed" });
    expect(root).toBeDefined();
    // No piercer state + cleared backdoor → the closed root is invisible.
    expect(getShadowRoot(host)).toBeNull();
  });

  test("install after reset works from a clean prototype", () => {
    const original = Element.prototype.attachShadow;
    installShadowPiercer();
    _resetShadowPiercerForTests();
    installShadowPiercer();

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "closed" });
    expect(getShadowRoot(host)).toBe(root);

    _resetShadowPiercerForTests();
    expect(Element.prototype.attachShadow).toBe(original);
  });
});

describe("backdoor surface", () => {
  test("the backdoor exposes only the members production code consumes", () => {
    installShadowPiercer();
    const bd = (window as unknown as Record<symbol, unknown>)[
      Symbol.for("__open_cowork_piercer_bd__")
    ] as { getShadowRoot?: unknown; stats?: unknown; hasShadowRoot?: unknown };
    expect(bd).toBeDefined();
    expect(typeof bd.getShadowRoot).toBe("function");
    expect(typeof bd.stats).toBe("function");
    // The unused hasShadowRoot member was removed from the surface.
    expect(bd.hasShadowRoot).toBeUndefined();
  });

  test("the backdoor is NOT published when stealth mode is on", () => {
    _setStealthEnabledCacheForTests(true);
    installShadowPiercer();
    // The attachShadow patch still captures roots locally…
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "closed" });
    expect(getShadowRoot(host)).toBe(root); // module-local state, not the backdoor
    // …but no page-observable backdoor exists on window.
    expect(
      (window as unknown as Record<symbol, unknown>)[
        Symbol.for("__open_cowork_piercer_bd__")
      ],
    ).toBeUndefined();
  });
});
