/**
 * Tests for the action executor (`src/lib/agent/tools/executor.ts`).
 *
 * The executor runs in a content-script context (`document`, `window`,
 * `location`, `chrome`). Vitest's `environment: "jsdom"` (set by Task 6)
 * provides a real DOM, so the DOM-requiring actions below run against real
 * jsdom elements.
 *
 * The non-DOM actions (`done`, `wait`, `evaluate`, plus the `click`-on-missing-
 * index error path) install a minimal `document`/`location` stub so they
 * don't depend on whatever the previous test left in `document.body`. The
 * stub is restored to the real jsdom globals in `afterEach` (see
 * `clearMinimalDomStubs`).
 *
 * Run with: `npx vitest run tests/executor.test.ts`
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { installJsdomLayoutMock, restoreJsdomLayoutMock } from "./helpers/jsdom-layout-mock";
import { allowDomain, clearDomainAllowlist } from "./helpers/domain-stub";
import { testDescribeActionNewerTypes } from "./helpers/action-behavior";
import type { BrowserState } from "../src/lib/agent/types";

// Mock the visual overlay so `highlightElement` is a no-op. The real
// `highlightElement` schedules a 1200ms `setTimeout` to auto-remove the
// badge and restore inline styles; that timer fires AFTER the test ends,
// at which point jsdom has torn down `window` and the cleanup throws
// `TypeError: window.removeEventListener is not a function` (visible as
// an unhandled error in vitest's stderr). Mocking it out avoids the
// leak without affecting test semantics (the tests assert on the click/
// input/hover side effects, not on the highlight badge).
vi.mock("../src/lib/agent/dom/overlay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/agent/dom/overlay")>();
  return {
    ...actual,
    highlightElement: () => ({ remove: () => { /* no-op */ } }),
  };
});

import { executeAction } from "../src/lib/agent/tools/executor";

// ─── Minimal DOM stubs ──────────────────────────────────────────────────────
//
// `executeAction` reads `location.href` and calls `domFingerprint()` (which
// calls `document.querySelectorAll("a,button,input,select,textarea")` and
// iterates by `.length`/index) at the very top of the function — before the
// switch is reached. For actions whose case bodies don't touch the DOM
// themselves (`done`, `wait`, `evaluate`, and `click` when `resolveElement`
// throws first), a stub `document` with a `querySelectorAll` that returns an
// empty array + a stub `location` with a string `href` is enough.
//
// The stubs are installed per-test via `beforeEach`/`afterEach` and restored
// to the real jsdom globals afterward so the DOM-requiring `describe` at the
// bottom of this file sees a live `document`/`location`.

// Capture the real jsdom-provided globals at module load (before any test
// installs the stub). These are restored in `clearMinimalDomStubs` so the
// DOM-requiring `describe` block at the bottom of this file sees a real DOM.
const REAL_DOCUMENT = globalThis.document;
const REAL_LOCATION = globalThis.location;

interface StubDoc {
  querySelectorAll: (sel: string) => Element[];
}

function installMinimalDomStubs(): void {
  const fakeDoc: StubDoc = {
 // domFingerprint only reads `.length` and indexed `[i].tagName` etc.
 // An empty array short-circuits the loop.
    querySelectorAll: () => [],
  };
  const fakeLocation = { href: "https://example.test/" };

  Object.defineProperty(globalThis, "document", {
    value: fakeDoc,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "location", {
    value: fakeLocation,
    configurable: true,
    writable: true,
  });
 // `evaluate` now fails closed unless the current origin is on an
 // explicit domain allowlist. Configure one for the stub host so the
 // evaluate behavioral tests exercise real JS execution. The blocked
 // (no-allowlist) path is covered by a dedicated test below.
  allowDomain("example.test");
}

function clearMinimalDomStubs(): void {
  clearDomainAllowlist();
 // Restore the real jsdom-provided globals so the next describe (which may
 // use real DOM APIs like `document.createElement`) sees a live document.
 // The originals were captured at module load before any stub was installed.
  Object.defineProperty(globalThis, "document", {
    value: REAL_DOCUMENT,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "location", {
    value: REAL_LOCATION,
    configurable: true,
    writable: true,
  });
}

/** Build an empty BrowserState — most tests don't need any selectorMap entries. */
function emptyState(): BrowserState {
  return { selectorMap: {} } as unknown as BrowserState;
}

// ─── describeAction (extends coverage from unit.test.ts) ────────────────────

// ─── describeAction (newer action types) ─────────────────────────────────
// Shared with executor-actions.test.ts so the semantic behavior is asserted
// exactly once (see tests/helpers/action-behavior.ts).
testDescribeActionNewerTypes();

// ─── executeAction: done (pure, no DOM) ─────────────────────────────────────

describe("executeAction — done", () => {
  beforeEach(installMinimalDomStubs);
  afterEach(clearMinimalDomStubs);

  test("done with success:true returns isDone and a 'Task complete' message", async () => {
    const result = await executeAction(
      { type: "done", text: "all done", success: true },
      emptyState(),
    );
    expect(result.success).toBe(true);
    expect(result.isDone).toBe(true);
    expect(result.message).toContain("Task complete");
    expect(result.message).toContain("all done");
  });

  test("done with success:false returns incomplete (isDone still set)", async () => {
    const result = await executeAction(
      { type: "done", text: "could not finish", success: false },
      emptyState(),
    );
    expect(result.success).toBe(false);
    expect(result.isDone).toBe(true);
    expect(result.message).toContain("Task incomplete");
    expect(result.message).toContain("could not finish");
  });
});

// ─── executeAction: wait (uses setTimeout, no DOM mutation) ─────────────────

describe("executeAction — wait", () => {
  beforeEach(installMinimalDomStubs);
  afterEach(clearMinimalDomStubs);

  test("wait action waits the specified seconds", async () => {
 // Drive timers deterministically: real wall-clock waits are the classic
 // flakiness source under CI load (timer coalescing / CPU starvation).
    vi.useFakeTimers();
    try {
      const promise = executeAction({ type: "wait", seconds: 1 }, emptyState());
      let resolved = false;
      void promise.then(() => {
        resolved = true;
      });
 // Half the requested duration must NOT have elapsed yet.
      await vi.advanceTimersByTimeAsync(500);
      expect(resolved).toBe(false);
 // The full second elapses and the action resolves successfully.
      await vi.advanceTimersByTimeAsync(500);
      const result = await promise;
      expect(resolved).toBe(true);
      expect(result.success).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── executeAction: evaluate (the bug-fix path) ─────────────────────────────
//
// `substituteCustomToolCalls` (imported lazily from `./registry`) is async.
// Before the fix, `code = substituteCustomToolCalls(code)` (no `await`)
// assigned a Promise to `code`; `new Function(code)` then coerced that to the
// string `"[object Promise]"`, which fails to parse as JS — so EVERY evaluate
// action surfaced as a SyntaxError-flavored "JS evaluation failed" result and
// the caller never saw the real substituted code. After the fix, the await
// resolves and the real code runs.

describe("executeAction — evaluate", () => {
  beforeEach(installMinimalDomStubs);
  afterEach(clearMinimalDomStubs);

  test("evaluate runs the supplied JavaScript and returns its result", async () => {
    const result = await executeAction(
      { type: "evaluate", code: "return 1 + 2" },
      emptyState(),
    );
    expect(result.success).toBe(true);
    expect(result.extractedContent).toBe("3");
    expect(result.pageChanged).toBe(false);
  });

  test("evaluate handles thrown JS errors gracefully", async () => {
    const result = await executeAction(
      { type: "evaluate", code: "throw new Error('boom')" },
      emptyState(),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("JS evaluation failed");
    expect(result.message).toContain("boom");
  });

  test("evaluate surfaces undefined result without throwing", async () => {
    const result = await executeAction(
      { type: "evaluate", code: "undefined" },
      emptyState(),
    );
    expect(result.success).toBe(true);
    expect(result.extractedContent).toBeUndefined();
  });

  test("evaluate does not coerce the substituted code to a Promise string (regression for missing await)", async () => {
 // Before the fix, `code = substituteCustomToolCalls(code)` (no await)
 // assigned a Promise to `code`; `new Function(code)` then coerced that to
 // "[object Promise]" and threw a SyntaxError. After the fix the await
 // resolves and the real code runs.
    const result = await executeAction(
      { type: "evaluate", code: "return 42" },
      emptyState(),
    );
    expect(result.success).toBe(true);
    expect(result.extractedContent).toBe("42");
 // The Promise-coercion bug would have surfaced as a SyntaxError-flavored
 // message; assert the literal coercion artifact never appears.
    expect(result.message).not.toContain("[object Promise]");
  });

  test("evaluate fails closed (BLOCKED) when no domain allowlist is configured", async () => {
 // Remove the allowlist installed by installMinimalDomStubs so the origin
 // is unconfigured. `evaluate` must refuse to execute rather than run
 // arbitrary JS on an unconstrained origin.
    delete (globalThis as Record<string, unknown>).__openCoworkDomainConfig;
    const result = await executeAction(
      { type: "evaluate", code: "return 1 + 2" },
      emptyState(),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("BLOCKED evaluate");
 // The JS must NOT have run (no result surfaced).
    expect(result.extractedContent).toBeUndefined();
  });
});

// ─── executeAction: click error path (no real DOM needed) ───────────────────

describe("executeAction — click error path", () => {
  beforeEach(installMinimalDomStubs);
  afterEach(clearMinimalDomStubs);

  test("click action on missing index returns failure", async () => {
 // Empty selectorMap → resolveElement throws "element [99] not found …"
 // before any DOM-mutating code runs.
    const result = await executeAction({ type: "click", index: 99 }, emptyState());
    expect(result.success).toBe(false);
    expect(result.message).toContain("not found");
  });
});

// ─── DOM-requiring actions — enabled under jsdom (Task 5C) ──────────────────
//
// These actions call `document.querySelector`, `window.scrollBy`, `location.href`
// (as a setter), `document.body`, `document.createTreeWalker`,
// `HTMLInputElement.prototype`, `document.activeElement`, `history.back`, etc.
// jsdom provides all of these. The `beforeEach` below installs three small
// jsdom-limitation workarounds:
// 1. `HTMLElement.prototype.scrollIntoView` — jsdom doesn't implement it
// (the executor calls it on `click`, `input`, `hover`, `find_text`); we
// replace it with a no-op so the executor's `el.scrollIntoView({...})`
// calls don't throw `TypeError: el.scrollIntoView is not a function`.
// 2. `HTMLElement.prototype.getBoundingClientRect` — jsdom returns a
// zero-size rect for every element (no real layout), which makes the
// executor's local `isVisible()` helper (`rect.width > 0 || rect.height > 0`)
// treat every element as hidden. We return a small non-zero rect so the
// `find_text` "is the match visible?" check passes.
// 3. `document.body.innerText` — jsdom doesn't implement `innerText`
// (returns `undefined`); the `extract` action uses it for body text. We
// alias it to `textContent` (close enough for the test — the test only
// checks that the query string and the body text are surfaced together).
//
// The mocks are restored in `afterEach` so they don't leak to other suites.

describe("executeAction — DOM-requiring actions (Task 5C: enabled under jsdom)", () => {
 // Save originals so we can restore them in afterEach (some are `undefined`
 // in jsdom — that's fine, `defineProperty` works regardless).
  let origScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;
  let innerTextDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    document.body.innerHTML = "";
 // 1. jsdom limitation: scrollIntoView is not implemented.
    origScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function scrollIntoView(): void { /* no-op */ };

 // 2. jsdom limitation: no real layout → all rects are zero-size, which
 // makes the executor's local `isVisible` check reject everything. Use the
 // shared layout mock (non-zero rect for visible elements).
    installJsdomLayoutMock();

 // 3. jsdom limitation: `innerText` is not implemented (returns undefined).
 // Alias it to `textContent` so the `extract` action surfaces body text.
    innerTextDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText");
    Object.defineProperty(HTMLElement.prototype, "innerText", {
      configurable: true,
      get(this: HTMLElement): string { return this.textContent || ""; },
      set(value: string) { this.textContent = value; },
    });
  });

  afterEach(() => {
    if (origScrollIntoView) {
      HTMLElement.prototype.scrollIntoView = origScrollIntoView;
    } else {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
    restoreJsdomLayoutMock();
    if (innerTextDescriptor) {
      Object.defineProperty(HTMLElement.prototype, "innerText", innerTextDescriptor);
    } else {
      delete (HTMLElement.prototype as { innerText?: unknown }).innerText;
    }
 // Cancel any pending highlight-auto-remove setTimeouts scheduled by
 // `highlightElement` (1200ms) so they don't fire after jsdom has torn
 // down for this test file. Without this, vitest logs an unhandled
 // `TypeError: window.removeEventListener is not a function` from
 // `overlay.ts:86` during module teardown (the timer fires after `window`
 // is gone). Cancelling is safe — the badges were already removed when we
 // cleared `document.body.innerHTML` at the start of the next test.
    vi.clearAllTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  test("click on a real element dispatches a click", async () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    let clicked = false;
    button.addEventListener("click", () => {
      clicked = true;
    });
    const state = { selectorMap: { 1: button } } as unknown as BrowserState;
    const result = await executeAction({ type: "click", index: 1 }, state);
    expect(result.success).toBe(true);
    expect(clicked).toBe(true);
  });

  test("input types text into an HTMLInputElement", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const state = { selectorMap: { 1: input } } as unknown as BrowserState;
    const result = await executeAction(
      { type: "input", index: 1, text: "hello", clear: true },
      state,
    );
    expect(result.success).toBe(true);
    expect(input.value).toBe("hello");
  });

  test("select_dropdown picks the option matching text", async () => {
    const select = document.createElement("select");
    const opt1 = document.createElement("option");
    opt1.textContent = "Apple";
    opt1.value = "apple";
    const opt2 = document.createElement("option");
    opt2.textContent = "Banana";
    opt2.value = "banana";
    select.append(opt1, opt2);
    document.body.appendChild(select);
    const state = { selectorMap: { 1: select } } as unknown as BrowserState;
    const result = await executeAction(
      { type: "select_dropdown", index: 1, text: "Banana" },
      state,
    );
    expect(result.success).toBe(true);
    expect(select.value).toBe("banana");
  });

  test("scroll calls window.scrollBy", async () => {
    const spy = vi.spyOn(window, "scrollBy");
    await executeAction({ type: "scroll", down: true, pages: 1 }, emptyState());
    expect(spy).toHaveBeenCalledOnce();
  });

  test("find_text scrolls to matching text", async () => {
    document.body.innerHTML = "<p>Find me here</p>";
    const result = await executeAction(
      { type: "find_text", text: "Find me" },
      emptyState(),
    );
    expect(result.success).toBe(true);
  });

  test("extract returns page body text tagged with the query", async () => {
    document.body.innerHTML = "<p>The price is $19.99</p>";
    const result = await executeAction(
      { type: "extract", query: "price" },
      emptyState(),
    );
    expect(result.success).toBe(true);
    expect(result.extractedContent).toContain("price");
    expect(result.extractedContent).toContain("$19.99");
  });

  test("search_page returns matches", async () => {
    document.body.innerHTML = "<p>foo bar baz</p><p>qux foo</p>";
    const result = await executeAction(
      { type: "search_page", pattern: "foo", regex: false, case_sensitive: false },
      emptyState(),
    );
    expect(result.success).toBe(true);
    expect(result.extractedContent).toContain("foo");
  });

  test("find_elements returns matching elements", async () => {
    document.body.innerHTML = "<button>A</button><button>B</button>";
    const result = await executeAction(
      { type: "find_elements", selector: "button", max_results: 50 },
      emptyState(),
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain("2");
  });

  test("dropdown_options lists options", async () => {
    const select = document.createElement("select");
    select.innerHTML = "<option>One</option><option>Two</option>";
    document.body.appendChild(select);
    const state = { selectorMap: { 1: select } } as unknown as BrowserState;
    const result = await executeAction(
      { type: "dropdown_options", index: 1 },
      state,
    );
    expect(result.success).toBe(true);
    expect(result.extractedContent).toContain("One");
    expect(result.extractedContent).toContain("Two");
  });

  test("hover dispatches mouseenter on the element", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const state = { selectorMap: { 1: el } } as unknown as BrowserState;
    let entered = false;
    el.addEventListener("mouseenter", () => {
      entered = true;
    });
    const result = await executeAction({ type: "hover", index: 1 }, state);
    expect(result.success).toBe(true);
    expect(entered).toBe(true);
  });
});
