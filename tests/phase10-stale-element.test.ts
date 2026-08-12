// @vitest-environment-options {"url":"https://phase10-stale.test/"}

/**
 * Phase 10 — stale-element execution guard + element-identity stability.
 *
 * The canonical action set MUST never operate on a stale element reference:
 * - `resolveElement` (the single resolution path every index-based handler
 *   goes through) rejects detached nodes (`isConnected`) AND nodes whose
 *   identity changed since the observation snapshot
 *   (`state.elementIdentities[index]` fingerprint re-verification).
 * - Identity fingerprints are captured at extraction time alongside the
 *   selector map (`page-state.ts`) and survive observation snapshots,
 *   including shadow-root elements; the same live node always yields the same
 *   identity, a different node never collides with it.
 * - A stale target therefore yields a FAILED `ActionResult` with the
 *   "extract state again" retry contract and zero side effects on the page.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { extractBrowserState, resetDomBaseline, getSelectorMap, getElementIdentities } from "../src/lib/agent/dom/extractor";
import { elementIdentity } from "../src/lib/agent/dom/extraction/element-info";
import { resolveElement } from "../src/lib/agent/tools/helpers/element-resolver";
import { executeAction } from "../src/lib/agent/tools/executor";
import { NoSuchElementException } from "../src/lib/agent/errors";
import type { TabInfo } from "../src/lib/agent/types";
import { makeState } from "./helpers";
import { installJsdomLayoutMock, restoreJsdomLayoutMock } from "./helpers";

const MOCK_TABS: TabInfo[] = [
  { id: 1, label: "1", url: "https://example.com", title: "Test", active: true },
];

beforeEach(() => {
  document.body.innerHTML = "";
  resetDomBaseline();
  installJsdomLayoutMock();
});

afterEach(() => {
  restoreJsdomLayoutMock();
});

// ─── elementIdentity stability ───────────────────────────────────────────────

describe("elementIdentity stability", () => {
  test("the same live node yields the same identity across repeated calls", () => {
    const button = document.createElement("button");
    button.textContent = "Sign in";
    document.body.append(button);

    expect(elementIdentity(button)).toBe(elementIdentity(button));
  });

  test("two nodes with different attributes or positions never collide", () => {
    document.body.innerHTML = "<main><button id='a'>A</button></main><aside><button id='a'>A</button></aside>";
    const [first, second] = document.querySelectorAll<HTMLElement>("button");
    // Same tag + same id, but different branch paths (main vs aside).
    expect(elementIdentity(first)).not.toBe(elementIdentity(second));

    const renamed = document.createElement("button");
    renamed.id = "b";
    document.body.append(renamed);
    expect(elementIdentity(renamed)).not.toBe(elementIdentity(first));
  });

  test("a same-position identical replacement keeps the observed identity (isConnected is the guard there)", () => {
    // An element replaced by an IDENTICAL node is exactly what the agent saw
    // (same tag/attrs/path), so the identity stays the same — the action is
    // still aimed at the right control. The stale-REFERENCE problem is then
    // handled by the `isConnected` guard in resolveElement, which rejects the
    // detached original before any handler runs.
    document.body.innerHTML = "<main><button id='a'>A</button></main>";
    const original = document.querySelector<HTMLElement>("#a")!;
    const observed = elementIdentity(original);

    const replacement = document.createElement("button");
    replacement.id = "a";
    replacement.textContent = "A";
    original.replaceWith(replacement);

    expect(elementIdentity(replacement)).toBe(observed);
    expect(original.isConnected).toBe(false);
    const state = makeState({ selectorMap: { 1: original } });
    expect(() => resolveElement(state, 1)).toThrow(NoSuchElementException);
  });

  test("a relabeled but still-connected node changes identity (SPA re-render)", () => {
    const button = document.createElement("button");
    button.id = "submit";
    button.textContent = "Submit";
    document.body.append(button);
    const before = elementIdentity(button);

    button.setAttribute("aria-label", "Submit order now");
    expect(elementIdentity(button)).not.toBe(before);
  });

  test("a re-ordered node changes identity (nth-of-type branch path)", () => {
    document.body.innerHTML = "<ul><li id='x'>X</li><li id='y'>Y</li></ul>";
    const x = document.querySelector<HTMLElement>("#x")!;
    const before = elementIdentity(x);
    document.body.innerHTML = "<ul><li id='y'>Y</li><li id='x'>X</li></ul>";
    expect(elementIdentity(x)).not.toBe(before);
  });

  test("shadow-root elements get a stable, distinguishable identity", () => {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    const inner = document.createElement("button");
    inner.id = "inner";
    inner.textContent = "Inner";
    root.append(inner);
    document.body.append(host);

    expect(elementIdentity(inner)).toBe(elementIdentity(inner));
    const hostButton = document.createElement("button");
    hostButton.id = "inner";
    hostButton.textContent = "Inner";
    document.body.append(hostButton);
    expect(elementIdentity(inner)).not.toBe(elementIdentity(hostButton));
  });

  test("identity inputs never include a password value", () => {
    const pw = document.createElement("input");
    pw.type = "password";
    pw.value = "sk-super-secret-123";
    pw.id = "pw";
    document.body.append(pw);
    const identityWithSecret = elementIdentity(pw);
    pw.value = "sk-other-secret-456";
    expect(elementIdentity(pw)).toBe(identityWithSecret);
    expect(identityWithSecret).not.toContain("sk-");
  });
});

// ─── extraction captures identities per index ───────────────────────────────

describe("observation snapshots carry per-index identities", () => {
  test("extractBrowserState returns elementIdentities aligned with selectorMap", () => {
    document.body.innerHTML =
      "<button id='b1'>One</button><input id='i1' /><a id='l1' href='https://example.com/x'>Link</a>";
    const state = extractBrowserState(MOCK_TABS);

    const map = state.selectorMap;
    const ids = state.elementIdentities ?? {};
    const indices = Object.keys(map).map(Number);
    expect(indices.length).toBe(3);
    for (const idx of indices) {
      expect(typeof ids[idx]).toBe("string");
      expect(ids[idx].length).toBeGreaterThan(0);
      expect(elementIdentity(map[idx] as HTMLElement)).toBe(ids[idx]);
    }
  });

  test("getElementIdentities() mirrors the last successful snapshot", () => {
    document.body.innerHTML = "<button id='b1'>One</button>";
    extractBrowserState(MOCK_TABS);
    const ids = getElementIdentities();
    const map = getSelectorMap();
    const idx = Number(Object.keys(map)[0]);
    expect(elementIdentity(map[idx] as HTMLElement)).toBe(ids[idx]);
  });

  test("a shadow-root element is indexed and identified through the piercer path", () => {
    const host = document.createElement("div");
    host.id = "host";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = "<button id='inner-btn'>Shadow Button</button>";
    document.body.append(host);

    const state = extractBrowserState(MOCK_TABS);
    const entries = Object.entries(state.selectorMap);
    expect(entries.length).toBeGreaterThan(0);
    const inner = root.querySelector<HTMLElement>("#inner-btn")!;
    const entry = entries.find(([, el]) => el === inner);
    expect(entry).toBeDefined();
    if (entry) {
      const [idx] = entry;
      expect(state.elementIdentities?.[Number(idx)]).toBe(elementIdentity(inner));
    }
  });

  test("identity survives across two snapshots of the same untouched page", () => {
    document.body.innerHTML = "<button id='b1'>One</button><a id='a1' href='https://example.com/'>Link</a>";
    const first = extractBrowserState(MOCK_TABS);
    const second = extractBrowserState(MOCK_TABS);
    for (const idx of Object.keys(first.selectorMap)) {
      expect(second.elementIdentities?.[Number(idx)]).toBe(first.elementIdentities?.[Number(idx)]);
    }
  });
});

// ─── resolveElement stale guards ─────────────────────────────────────────────

describe("resolveElement stale-element guards", () => {
  test("a connected element whose identity matches resolves", () => {
    const button = document.createElement("button");
    button.id = "ok";
    button.textContent = "OK";
    document.body.append(button);
    const state = makeState({
      selectorMap: { 1: button },
      elementIdentities: { 1: elementIdentity(button) },
    });
    expect(resolveElement(state, 1)).toBe(button);
  });

  test("a detached element is rejected even without an identity record", () => {
    const button = document.createElement("button");
    const state = makeState({ selectorMap: { 1: button } });
    expect(() => resolveElement(state, 1)).toThrow(NoSuchElementException);
    expect(() => resolveElement(state, 1)).toThrow(/detached/i);
  });

  test("a still-connected but relabeled element is rejected (identity mismatch)", () => {
    const button = document.createElement("button");
    button.id = "pay";
    button.textContent = "Pay now";
    document.body.append(button);
    const observed = elementIdentity(button);

    // The page re-renders the SAME node with a new label between snapshot and
    // action (SPA in-flight mutation). Still connected — but no longer what
    // the agent saw.
    button.setAttribute("aria-label", "Pay with card now");
    const state = makeState({
      selectorMap: { 1: button },
      elementIdentities: { 1: observed },
    });
    expect(() => resolveElement(state, 1)).toThrow(NoSuchElementException);
    expect(() => resolveElement(state, 1)).toThrow(/changed since extraction/i);
  });

  test("a replaced node (same position, new node) is rejected via the identity path", () => {
    document.body.innerHTML = "<button id='b'>Original</button>";
    const original = document.querySelector<HTMLElement>("#b")!;
    const observed = elementIdentity(original);

    const replacement = document.createElement("button");
    replacement.id = "b";
    replacement.textContent = "Original";
    original.replaceWith(replacement);

    const state = makeState({
      selectorMap: { 1: original },
      elementIdentities: { 1: observed },
    });
    // The original reference is detached AND (had it survived) its identity
    // fingerprint changed — both guard layers fire.
    expect(() => resolveElement(state, 1)).toThrow(NoSuchElementException);
  });

  test("no identity record keeps the isConnected-only behavior (non-extension contexts)", () => {
    const button = document.createElement("button");
    document.body.append(button);
    const state = makeState({ selectorMap: { 1: button } });
    expect(resolveElement(state, 1)).toBe(button);
  });
});

// ─── executor-level: stale target → failed result, zero side effects ────────

describe("executor never acts on a stale element", () => {
  test("click on a relabeled (identity-changed) element fails with the re-extract contract and no click fires", async () => {
    const button = document.createElement("button");
    button.id = "submit";
    button.textContent = "Submit";
    document.body.append(button);
    const observed = elementIdentity(button);
    const onClick = vi.fn();
    button.addEventListener("click", onClick);

    button.setAttribute("aria-label", "Submit order now");
    const state = makeState({
      selectorMap: { 1: button },
      elementIdentities: { 1: observed },
    });

    const result = await executeAction({ type: "click", index: 1 } as never, state);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/changed since extraction|no_such_element|extract state again/i);
    expect(onClick).not.toHaveBeenCalled();
  });

  test("click on a detached element fails with no click and no DOM mutation", async () => {
    const button = document.createElement("button");
    const onClick = vi.fn();
    button.addEventListener("click", onClick);
    const state = makeState({ selectorMap: { 1: button } });

    const result = await executeAction({ type: "click", index: 1 } as never, state);
    expect(result.success).toBe(false);
    expect(onClick).not.toHaveBeenCalled();
  });

  test("input on an identity-changed input fails and never dispatches input events", async () => {
    const input = document.createElement("input");
    input.id = "email";
    document.body.append(input);
    const observed = elementIdentity(input);
    const onInput = vi.fn();
    input.addEventListener("input", onInput);
    input.addEventListener("change", onInput);

    input.setAttribute("placeholder", "Work email");
    const state = makeState({
      selectorMap: { 1: input },
      elementIdentities: { 1: observed },
    });

    const result = await executeAction({ type: "input", index: 1, text: "a@b.test" } as never, state);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/changed since extraction|no_such_element|extract state again/i);
    expect(onInput).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  test("hover on a detached element fails without dispatching hover events", async () => {
    const button = document.createElement("button");
    const onHover = vi.fn();
    button.addEventListener("mouseover", onHover);
    const state = makeState({ selectorMap: { 1: button } });

    const result = await executeAction({ type: "hover", index: 1 } as never, state);
    expect(result.success).toBe(false);
    expect(onHover).not.toHaveBeenCalled();
  });
});

