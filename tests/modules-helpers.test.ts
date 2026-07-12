/**
 * Smoke tests for four unrelated modules whose public APIs aren't big enough
 * to warrant a dedicated test file each:
 * - `tools/registry` — `getFormatInstructions` (prompt-injection helper)
 * - `dom/dom-utils` — `By` / `findByLocator` (CSS/XPath/tag-name locators)
 * - `errors` — typed hierarchy + encode/decode round-trip
 * - `tools/executor` — `Select` helper, alert actions, native-click fallback
 *
 * Renamed from `agent4-probe.test.ts` (the historical name referenced an
 * internal development phase and didn't describe the file's scope).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";

describe("registry: getFormatInstructions", () => {
  test("getFormatInstructions produces a JSON-schema-bearing string", async () => {
    const { getFormatInstructions } = await import("../src/lib/agent/tools/registry");
    const schema = z.object({ type: z.literal("click"), index: z.number() });
    const text = getFormatInstructions(schema);
    expect(text).toContain("JSON instance");
    expect(text).toContain("output schema");
    expect(text).toContain('"type"');
    expect(text).toContain('"index"');
  });
});

describe("dom-utils: By + findByLocator", () => {
  test("By.css resolves to css selector strategy", async () => {
    const { By } = await import("../src/lib/agent/dom/dom-utils");
    const by = By.css("button.primary");
    expect(by.using).toBe("css selector");
    expect(by.value).toBe("button.primary");
  });

  test("By.id / By.name / By.className escape into CSS selectors", async () => {
    const { By } = await import("../src/lib/agent/dom/dom-utils");
    expect(By.id("submit").value).toContain('id="submit"');
    expect(By.byName("q").value).toContain('name="q"');
    expect(By.className("btn primary").using).toBe("css selector");
  });

  test("By.xpath / By.linkText / By.tagName carry the right strategy", async () => {
    const { By } = await import("../src/lib/agent/dom/dom-utils");
    expect(By.xpath("//button").using).toBe("xpath");
    expect(By.linkText("Sign in").using).toBe("link text");
    expect(By.partialLinkText("Sign").using).toBe("partial link text");
    expect(By.tagName("button").using).toBe("tag name");
  });

  test("findByLocator resolves CSS selectors to live elements", async () => {
    const { findByLocator, By } = await import("../src/lib/agent/dom/dom-utils");
    document.body.innerHTML = '<button class="x">A</button><button class="x">B</button>';
    const els = findByLocator(By.css("button.x"));
    expect(els.length).toBe(2);
    document.body.innerHTML = "";
  });
});

describe("errors: typed hierarchy", () => {
  test("each typed error carries a stable code", async () => {
    const {
      NoSuchElementException, ElementNotFoundError, StaleElementReferenceError,
      TimeoutError, InvalidSelectorError, ElementNotInteractableError, ElementClickInterceptedError,
      UnexpectedAlertOpenError, NoSuchAlertError, isAgentError,
    } = await import("../src/lib/agent/errors");
    expect(new NoSuchElementException().code).toBe("no_such_element");
    expect(new ElementNotFoundError().code).toBe("element_not_found");
    expect(new StaleElementReferenceError().code).toBe("stale_element_reference");
    expect(new TimeoutError().code).toBe("timeout");
    expect(new InvalidSelectorError().code).toBe("invalid_selector");
    expect(new ElementNotInteractableError().code).toBe("element_not_interactable");
    expect(new ElementClickInterceptedError().code).toBe("element_click_intercepted");
    expect(new UnexpectedAlertOpenError().code).toBe("unexpected_alert_open");
    expect(new NoSuchAlertError().code).toBe("no_such_alert");
    expect(isAgentError(new TimeoutError())).toBe(true);
    expect(isAgentError(new Error("plain"))).toBe(false);
  });

  test("encode/decode round-trip preserves the typed class", async () => {
    const { encodeAgentError, decodeAgentError, TimeoutError, isAgentError } = await import("../src/lib/agent/errors");
    const encoded = encodeAgentError(new TimeoutError("waited too long"));
    expect(encoded.code).toBe("timeout");
    const decoded = decodeAgentError(encoded);
    expect(isAgentError(decoded)).toBe(true);
    expect(decoded).toBeInstanceOf(TimeoutError);
    expect(decoded.message).toBe("waited too long");
  });
});

describe("executor: Select helper + alert actions + click fallback", () => {
  test("select_dropdown uses Select class for text match", async () => {
    const { executeAction } = await import("../src/lib/agent/tools/executor");
    const select = document.createElement("select");
    const opt1 = document.createElement("option");
    opt1.textContent = "Apple";
    opt1.value = "apple";
    const opt2 = document.createElement("option");
    opt2.textContent = "Banana";
    opt2.value = "banana";
    select.append(opt1, opt2);
    document.body.appendChild(select);
    const state = { selectorMap: { 1: select } } as any;
    const result = await executeAction({ type: "select_dropdown", index: 1, text: "Banana" }, state);
    expect(result.success).toBe(true);
    expect(select.value).toBe("banana");
    document.body.innerHTML = "";
  });

  test("select_dropdown guards against disabled options", async () => {
    const { executeAction } = await import("../src/lib/agent/tools/executor");
    const select = document.createElement("select");
    const opt = document.createElement("option");
    opt.textContent = "Disabled";
    opt.value = "disabled";
    opt.disabled = true;
    select.appendChild(opt);
    document.body.appendChild(select);
    const state = { selectorMap: { 1: select } } as any;
    const result = await executeAction({ type: "select_dropdown", index: 1, text: "Disabled" }, state);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/disabled|not selectable/i);
    document.body.innerHTML = "";
  });

  test("alert_get_text returns empty content when no dialog open", async () => {
    const { executeAction } = await import("../src/lib/agent/tools/executor");
 // Reset the popup-handler's pending queue by dismissing.
    const { dismissAlert } = await import("../src/lib/agent/dom/popup-handler");
    dismissAlert();
    const result = await executeAction({ type: "alert_get_text" } as any, { selectorMap: {} } as any);
    expect(result.success).toBe(true);
    expect(result.extractedContent).toBe("");
  });

  test("alert_accept fails when no dialog is open", async () => {
    const { executeAction } = await import("../src/lib/agent/tools/executor");
    const { dismissAlert } = await import("../src/lib/agent/dom/popup-handler");
    dismissAlert();
    const result = await executeAction({ type: "alert_accept" } as any, { selectorMap: {} } as any);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/nothing to accept/i);
  });

  test("popup-handler queues dialogs for later inspection", async () => {
    const { installPopupHandler, getPendingAlertText, getPendingAlertKind, acceptAlert } = await import("../src/lib/agent/dom/popup-handler");
    installPopupHandler();
    window.alert("hello world");
    expect(getPendingAlertText()).toBe("hello world");
    expect(getPendingAlertKind()).toBe("alert");
    expect(acceptAlert()).toBe(true);
    expect(getPendingAlertText()).toBe(null);
  });

  test("click fallback uses native el.click() when no chrome.runtime", async () => {
    const { executeAction } = await import("../src/lib/agent/tools/executor");
    const button = document.createElement("button");
    document.body.appendChild(button);
    let clicked = false;
    button.addEventListener("click", () => { clicked = true; });
    const state = { selectorMap: { 1: button } } as any;
    const result = await executeAction({ type: "click", index: 1 }, state);
    expect(result.success).toBe(true);
    expect(clicked).toBe(true);
    expect(result.message).toContain("native");
    document.body.innerHTML = "";
  });

  test("click fallback falls through to dispatched-event when el.click() throws", async () => {
    const { executeAction } = await import("../src/lib/agent/tools/executor");
 // Create an element whose .click() throws.
    const button = document.createElement("button");
    document.body.appendChild(button);
    (button as any).click = () => { throw new Error("synthetic failure"); };
 // CSS selector strategy should also fail (the only button on the page is
 // the broken one), and text-search will skip the same element. Dispatched
 // MouseEvent on `button` should succeed and we report dispatched-event.
    let dispatched = false;
    button.addEventListener("click", () => { dispatched = true; });
    const state = { selectorMap: { 1: button } } as any;
    const result = await executeAction({ type: "click", index: 1 }, state);
    expect(result.success).toBe(true);
    expect(dispatched).toBe(true);
    document.body.innerHTML = "";
  });
});

// ─── CDP-first click cascade ────────────────────────────────────────────────
//
// The click handler's strategy order is: CDP → native → CSS → text → dispatched.
// CDP is strategy 1 — `el.click()` silently fails on ~30% of real websites
// (isTrusted-gated handlers), so trying native first would report false success
// and never reach CDP.
//
// These tests pin the CDP-first ordering: when `chrome.runtime.id` is truthy
// (extension context) AND `chrome.runtime.sendMessage` returns `{ ok: true }`,
// CDP must be tried FIRST and native `el.click()` must NOT be tried.

describe("executor: CDP-first click cascade", () => {
  let originalChrome: unknown;

  beforeEach(() => {
    originalChrome = (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  afterEach(() => {
    if (originalChrome === undefined) {
      delete (globalThis as unknown as { chrome?: unknown }).chrome;
    } else {
      (globalThis as unknown as { chrome: unknown }).chrome = originalChrome;
    }
    document.body.innerHTML = "";
  });

  /** Install a chrome global with `runtime.id` + a `sendMessage` mock. */
  function installChromeMock(sendMessage: ReturnType<typeof vi.fn>): void {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
 // `chrome.runtime.id` is truthy in extension context, undefined in
 // test pages. The CDP guard checks `chrome.runtime?.id`.
        id: "test-extension-id",
        sendMessage,
      },
    };
  }

  test("CDP is tried FIRST when chrome.runtime.id is set (strategy 1) — native el.click() is NOT called", async () => {
    const { executeAction } = await import("../src/lib/agent/tools/executor");
    const sendMsg = vi.fn(async () => ({ ok: true }));
    installChromeMock(sendMsg);

    const button = document.createElement("button");
    document.body.appendChild(button);
    let nativeClicked = false;
    button.addEventListener("click", () => { nativeClicked = true; });

    const state = { selectorMap: { 1: button } } as any;
    const result = await executeAction({ type: "click", index: 1 }, state);

 // CDP was tried (sendMessage called with CDP_CLICK).
    expect(sendMsg).toHaveBeenCalledTimes(1);
    expect((sendMsg.mock.calls[0] as unknown[])[0]).toMatchObject({ type: "CDP_CLICK" });
 // Native el.click() was NOT tried (CDP succeeded → strategy 2 skipped).
    expect(nativeClicked).toBe(false);
 // Result reports CDP as the strategy used.
    expect(result.success).toBe(true);
    expect(result.message).toContain("CDP");
  });

  test("CDP message includes the element's bounding rect", async () => {
 // The CDP click needs the element's center coordinates to dispatch the
 // mouse event. The message MUST carry `rect` (the BoundingClientRect).
    const { executeAction } = await import("../src/lib/agent/tools/executor");
    const sendMsg = vi.fn(async () => ({ ok: true }));
    installChromeMock(sendMsg);

    const button = document.createElement("button");
    document.body.appendChild(button);
    const state = { selectorMap: { 1: button } } as any;
    await executeAction({ type: "click", index: 1 }, state);

    expect(sendMsg).toHaveBeenCalledTimes(1);
    const msg = (sendMsg.mock.calls[0] as unknown[])[0] as { type: string; rect: unknown };
    expect(msg.type).toBe("CDP_CLICK");
    expect(msg.rect).toBeDefined();
 // `rect` is the result of el.getBoundingClientRect() — must have x/y/width/height.
    expect(typeof (msg.rect as DOMRect).x).toBe("number");
    expect(typeof (msg.rect as DOMRect).y).toBe("number");
    expect(typeof (msg.rect as DOMRect).width).toBe("number");
    expect(typeof (msg.rect as DOMRect).height).toBe("number");
  });

  test("when CDP fails, falls through to native el.click() (strategy 2)", async () => {
 // CDP-first does NOT mean CDP-only — when CDP returns `{ ok: false }`,
 // the cascade must continue to native. This proves the cascade ORDER
 // (CDP before native) rather than just CDP-only behavior.
    const { executeAction } = await import("../src/lib/agent/tools/executor");
    const sendMsg = vi.fn(async () => ({ ok: false, error: "debugger rejected" }));
    installChromeMock(sendMsg);

    const button = document.createElement("button");
    document.body.appendChild(button);
    let nativeClicked = false;
    button.addEventListener("click", () => { nativeClicked = true; });

    const state = { selectorMap: { 1: button } } as any;
    const result = await executeAction({ type: "click", index: 1 }, state);

 // CDP was tried first.
    expect(sendMsg).toHaveBeenCalledTimes(1);
    expect((sendMsg.mock.calls[0] as unknown[])[0]).toMatchObject({ type: "CDP_CLICK" });
 // Native was tried AFTER CDP failed (cascade continued).
    expect(nativeClicked).toBe(true);
 // Result reports native as the strategy used (CDP failed).
    expect(result.success).toBe(true);
    expect(result.message).toContain("native");
    expect(result.message).not.toContain("CDP");
  });

  test("when chrome.runtime.id is absent (test/demo context), CDP is skipped — native first (regression guard)", async () => {
 // The CDP guard is `chrome.runtime?.id`. In test/demo context (no chrome
 // global), CDP must be skipped entirely and native el.click() runs first.
 // This test pins the guard so a future refactor that always-tries CDP
 // (e.g. by dropping the `chrome.runtime?.id` check) would break tests
 // that don't mock chrome — making the regression immediately visible.
    const { executeAction } = await import("../src/lib/agent/tools/executor");
 // No chrome global installed — simulate non-extension context.
    delete (globalThis as unknown as { chrome?: unknown }).chrome;

    const button = document.createElement("button");
    document.body.appendChild(button);
    let nativeClicked = false;
    button.addEventListener("click", () => { nativeClicked = true; });

    const state = { selectorMap: { 1: button } } as any;
    const result = await executeAction({ type: "click", index: 1 }, state);

    expect(nativeClicked).toBe(true);
    expect(result.success).toBe(true);
    expect(result.message).toContain("native");
    expect(result.message).not.toContain("CDP");
  });
});
