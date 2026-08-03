/**
 * `tryCdpClick` viewport pre-check — an element whose center lands exactly on
 * the right/bottom viewport edge is OUTSIDE the visible pixel range (coords are
 * 0-based, so the last visible pixel column is `innerWidth - 1`). The pre-check
 * must treat the edge pixel as outside instead of sending a coordinate click
 * that lands off-screen.
 *
 * `tryCssSelectorClick` ambiguity guard — `generateCssSelector` can return a
 * non-unique selector (bare tag / tag+classes when the element has no id), and
 * the strategy must NOT click the first `querySelector` match in that case
 * (that could click a DIFFERENT element and report success). A non-unique
 * selector must fall back to the next strategy instead.
 */

import { describe, test, expect, afterEach, vi, beforeEach } from "vitest";
import {
  executeCdpClick,
  tryCdpClick,
  tryCssSelectorClick,
} from "../../src/lib/agent/tools/handlers/click-utils";
import { generateCssSelector } from "../../src/lib/agent/tools/helpers";

function installExtensionMock(): void {
  (globalThis as Record<string, unknown>).chrome = { runtime: { id: "ext-id" } };
}

function installExtensionMockWithSendMessage(sendMessage: () => Promise<unknown>): void {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { id: "ext-id", sendMessage },
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
  vi.restoreAllMocks();
});

function stubRect(el: HTMLElement, x: number, y: number, width: number, height: number): void {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect);
}

describe("tryCdpClick viewport edge pre-check", () => {
  test("rejects a center exactly at the right/bottom edge (0-based coords)", () => {
    installExtensionMock();
    const el = document.createElement("button");
    const w = window.innerWidth;
    const h = window.innerHeight;
    stubRect(el, w - 10, h - 10, 20, 20);
    const res = tryCdpClick(el);
    expect(res.error ?? "").toContain("outside the viewport");
  });

  test("allows a center one pixel inside the right/bottom edge", () => {
    installExtensionMock();
    const el = document.createElement("button");
    const w = window.innerWidth;
    const h = window.innerHeight;
    stubRect(el, w - 10, h - 10, 18, 18);
    const res = tryCdpClick(el);
    expect(res.error).toBeUndefined();
    expect(res.strategyUsed).toBe("CDP");
  });
});

describe("tryCssSelectorClick ambiguity guard", () => {
  test("skips (no click, no success) when the selector matches MULTIPLE elements", () => {
    // A DETACHED target (stale) whose class is shared by two attached
    // buttons: `generateCssSelector` can't verify uniqueness for a detached
    // element, falls through the class/attr strategies and the sibling chain,
    // and returns the bare tag `button` — which matches BOTH attached
    // buttons. The strategy must refuse rather than click the wrong one.
    const other = document.createElement("button");
    other.className = "shared";
    other.textContent = "wrong target";
    const twin = document.createElement("button");
    twin.className = "shared";
    twin.textContent = "also wrong";
    document.body.append(other, twin);
    const el = document.createElement("button"); // never appended — detached
    el.className = "shared";
    el.textContent = "actual target";

    const otherClick = vi.fn();
    other.addEventListener("click", otherClick);
    const twinClick = vi.fn();
    twin.addEventListener("click", twinClick);

    const res = tryCssSelectorClick(el);
    expect(res.clicked).toBe(false);
    expect(res.strategyUsed).toBe("");
    expect(res.error ?? "").toContain("ambiguously");
    expect(otherClick).not.toHaveBeenCalled();
    expect(twinClick).not.toHaveBeenCalled();
  });

  test("clicks the unique match when the selector matches exactly one element", () => {
    // A unique selector (id) yields exactly one match — a different live
    // element than the stale reference — which is the strategy's documented
    // purpose (re-find the current instance and click it).
    const target = document.createElement("button");
    target.id = "unique-target";
    target.textContent = "target";
    document.body.appendChild(target);
    const stale = document.createElement("button");
    stale.id = "unique-target";

    const targetClick = vi.fn();
    target.addEventListener("click", targetClick);

    const res = tryCssSelectorClick(stale);
    expect(res.clicked).toBe(true);
    expect(res.strategyUsed).toBe("css-selector");
    expect(targetClick).toHaveBeenCalledTimes(1);
  });

  test("reports a clear error when the selector matches nothing", () => {
    const el = document.createElement("button");
    el.id = "ghost-target"; // not in the document
    const res = tryCssSelectorClick(el);
    expect(res.clicked).toBe(false);
    expect(res.error ?? "").toContain("did not match any element");
  });
});

describe("executeCdpClick SW race + fallback", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  function stubRect(el: HTMLElement): void {
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      top: 0,
      left: 0,
      right: 100,
      bottom: 40,
      toJSON: () => ({}),
    } as DOMRect);
  }

  test("ok:true reports success via the CDP strategy", async () => {
    installExtensionMockWithSendMessage(async () => ({ ok: true }));
    const el = document.createElement("button");
    stubRect(el);
    const res = await executeCdpClick(el);
    expect(res.clicked).toBe(true);
    expect(res.strategyUsed).toBe("CDP");
  });

  test("ok:false + error surfaces the SW error (not a silent success)", async () => {
    installExtensionMockWithSendMessage(async () => ({ ok: false, error: "tab gone" }));
    const el = document.createElement("button");
    stubRect(el);
    const res = await executeCdpClick(el);
    expect(res.clicked).toBe(false);
    expect(res.error ?? "").toContain("tab gone");
    expect(res.cdpUncertain).toBeUndefined();
  });

  test("no response (undefined) is treated as uncertain, not success", async () => {
    // A SW that accepts the message but never sends a response resolves
    // `undefined` — the handler must not claim a click happened.
    installExtensionMockWithSendMessage(async () => undefined);
    const el = document.createElement("button");
    stubRect(el);
    const res = await executeCdpClick(el);
    expect(res.clicked).toBe(false);
    expect(res.error ?? "").toContain("no response");
    expect(res.cdpUncertain).toBe(true);
  });

  test("a SW round-trip that outlives the timeout is uncertain, not success", async () => {
    // Race a mock that NEVER resolves against the SW_RPC_TIMEOUT_MS timer:
    // the click must report uncertainty instead of hanging the agent step.
    vi.useFakeTimers();
    try {
      installExtensionMockWithSendMessage(() => new Promise<never>(() => {}));
      const el = document.createElement("button");
      stubRect(el);
      const resPromise = executeCdpClick(el);
      await vi.advanceTimersByTimeAsync(15_000); // SW_RPC_TIMEOUT_MS
      const res = await resPromise;
      expect(res.clicked).toBe(false);
      expect(res.error ?? "").toContain("CDP_CLICK timeout");
      expect(res.cdpUncertain).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("generateCssSelector escaping", () => {
  test("escapes quotes and backslashes in an id (CSS string context)", () => {
    const el = document.createElement("div");
    el.id = 'a"b';
    expect(generateCssSelector(el)).toBe('*[id="a\\"b"]');
    el.id = "a\\b";
    expect(generateCssSelector(el)).toBe('*[id="a\\\\b"]');
  });

  test("escapes a newline in an id (CSS string escape)", () => {
    const el = document.createElement("div");
    el.id = "a\nb";
    expect(generateCssSelector(el)).toBe('*[id="a\\A b"]');
  });

  test("a leading digit in a class name is hex-escaped (valid identifier)", () => {
    // The element must be attached so the unique-class strategy can verify it.
    const el = document.createElement("div");
    el.className = "1st";
    document.body.appendChild(el);
    expect(generateCssSelector(el)).toBe("div.\\31 st");
    el.remove();
  });

  test("class names with CSS-special characters are escaped", () => {
    const el = document.createElement("div");
    el.className = "a.b:c";
    document.body.appendChild(el);
    expect(generateCssSelector(el)).toBe("div.a\\.b\\:c");
    el.remove();
  });

  test("falls back to the bare tag when there is no id or class", () => {
    const el = document.createElement("div");
    expect(generateCssSelector(el)).toBe("div");
  });
});
