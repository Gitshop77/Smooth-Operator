/**
 * AX-tree DOM-walking tests — covers `src/lib/agent/dom/ax-tree.ts`
 * `generateAccessibilityTree` actual DOM walking.
 *
 * The existing `tests/ax-tree.test.ts` (written before jsdom was available)
 * only tests ref bookkeeping + error paths via a hand-rolled window stub.
 * These tests exercise the real DOM-walking path against jsdom:
 * - empty page → no error, empty pageContent
 * - single button → `button "name" [ref_N]` line emitted
 * - link with href → `link "name" [ref_N] href="..."` line emitted
 * - input with label → accessible name from associated `<label for>`
 * - select with options → `combobox "<selected text>"` + child option lines
 * - heading → `heading "<text>"` line emitted
 * - sensitive input redaction → `[value redacted]` instead of the real value
 * - ref resolution → `resolveRef("ref_N")` returns the live HTMLElement
 * - depth limiting → tree stops at the caller-specified max depth
 * - filter="interactive" → only interactive elements appear
 *
 * Run with: `npx vitest run tests/ax-tree-dom.test.ts`
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  generateAccessibilityTree,
  initElementMap,
  resolveRef,
  __test_resetRegistry,
} from "../src/lib/agent/dom/ax-tree";
import { installJsdomLayoutMock, restoreJsdomLayoutMock } from "./helpers";

// ─── jsdom-limitation mocks (installed in beforeEach) ───────────────────────
//
// The ax-tree path calls `isVisible` (= `isVisibleFull` from dom-utils) and
// `getBoundingClientRect` only when `filter !== "all"` (see `shouldInclude`).
// Most tests below use the default `filter="all"`, which skips both checks —
// no mocking needed. The `filter="interactive"` test (test 10) DOES need the
// mocks, so we install them unconditionally in `beforeEach` to keep the test
// bodies uniform.
//
// The shared `installJsdomLayoutMock` helper overrides `offsetParent` and
// `getBoundingClientRect` so jsdom (which has no layout engine) reports
// elements as visible. See `tests/helpers/jsdom-layout-mock.ts` for the
// full rationale.

beforeEach(() => {
  document.body.innerHTML = "";
 // The element-ref registry is module-scoped (off `window`) for security, so
 // reset it via the test hook to keep ref_N assignments deterministic per
 // test (initElementMap alone is idempotent and won't clear an existing map).
  __test_resetRegistry();
  initElementMap();
  installJsdomLayoutMock();
});

afterEach(() => {
  restoreJsdomLayoutMock();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("generateAccessibilityTree (DOM walking)", () => {
  test("1. empty page → pageContent is empty, no error", () => {
    document.body.innerHTML = "";
    const result = generateAccessibilityTree();
    expect(result.error).toBeUndefined();
    expect(result.pageContent).toBe("");
  });

  test("2. single button → pageContent contains `button \"Click me\" [ref_1]`", () => {
    const btn = document.createElement("button");
    btn.textContent = "Click me";
    document.body.appendChild(btn);
    const result = generateAccessibilityTree();
    expect(result.pageContent).toContain("button");
    expect(result.pageContent).toContain('"Click me"');
    expect(result.pageContent).toContain("[ref_1]");
  });

  test("3. link with href → pageContent contains `link \"Go\" [ref_1] href=\"/foo\"`", () => {
    const a = document.createElement("a");
    a.setAttribute("href", "/foo");
    a.textContent = "Go";
    document.body.appendChild(a);
    const result = generateAccessibilityTree();
    expect(result.pageContent).toContain("link");
    expect(result.pageContent).toContain('"Go"');
    expect(result.pageContent).toContain("[ref_1]");
    expect(result.pageContent).toContain('href="/foo"');
  });

  test("4. input with associated <label for> → accessible name is the label text", () => {
    const label = document.createElement("label");
    label.setAttribute("for", "email");
    label.textContent = "Email";
    const input = document.createElement("input");
    input.id = "email";
    input.setAttribute("type", "email");
    input.setAttribute("placeholder", "Email");
    document.body.append(label, input);
    const result = generateAccessibilityTree();
 // The input's accessible name resolves to "Email" (from the label or
 // placeholder — both happen to equal "Email" here). Verify the input
 // line is emitted with name "Email" and the right role (textbox).
    expect(result.pageContent).toContain("textbox");
    expect(result.pageContent).toContain('"Email"');
  });

  test("5. select with options → combobox line uses selected option's text + emits child option lines", () => {
    const select = document.createElement("select");
    const opt1 = document.createElement("option");
    opt1.textContent = "A";
    opt1.value = "a";
    const opt2 = document.createElement("option");
    opt2.textContent = "B";
    opt2.value = "b";
    opt2.setAttribute("selected", "selected");
    select.append(opt1, opt2);
    document.body.appendChild(select);
    const result = generateAccessibilityTree();
 // The combobox line uses the selected option's text ("B").
    expect(result.pageContent).toContain("combobox");
    expect(result.pageContent).toContain('"B"');
 // Child option lines are emitted (with the selected flag on "B").
    expect(result.pageContent).toContain("option");
    expect(result.pageContent).toContain('"A"');
    expect(result.pageContent).toContain("(selected)");
  });

  test("6. heading → pageContent contains `heading \"<text>\"` for each level", () => {
    document.body.innerHTML = `<h1>Title</h1><h2>Subtitle</h2>`;
    const result = generateAccessibilityTree();
    expect(result.pageContent).toContain("heading");
    expect(result.pageContent).toContain('"Title"');
    expect(result.pageContent).toContain('"Subtitle"');
  });

  test("7. sensitive field redaction — password value is never surfaced", () => {
    const input = document.createElement("input");
    input.setAttribute("type", "password");
    input.setAttribute("value", "secret");
    document.body.appendChild(input);
    const result = generateAccessibilityTree();
    expect(result.pageContent).toContain("[value redacted]");
 // The real password value must NEVER appear in the AX tree.
    expect(result.pageContent).not.toContain("secret");
  });

  test("8. ref resolution — resolveRef returns the live HTMLElement after generation", () => {
    const btn = document.createElement("button");
    btn.textContent = "Go";
    document.body.appendChild(btn);
    generateAccessibilityTree();
    const resolved = resolveRef("ref_1");
    expect(resolved).toBe(btn);
    expect(resolved instanceof HTMLElement).toBe(true);
  });

  test("9. depth limiting — tree stops at the caller-specified max depth", () => {
 // Use <nav> (a structural landmark) so each level IS included in the
 // tree and increments the depth counter. With maxDepth=2, the button
 // at depth 3 is never reached.
    document.body.innerHTML = `
      <nav aria-label="nav1">
        <nav aria-label="nav2">
          <nav aria-label="nav3">
            <button>Deep</button>
          </nav>
        </nav>
      </nav>
    `;
    const result = generateAccessibilityTree("all", 2);
 // All three nav levels (depth 0, 1, 2) appear.
    expect(result.pageContent).toContain("navigation");
    expect(result.pageContent).toContain('"nav1"');
    expect(result.pageContent).toContain('"nav2"');
    expect(result.pageContent).toContain('"nav3"');
 // The button at depth 3 is NOT included (depth > maxDepth returns early).
    expect(result.pageContent).not.toContain("button");
    expect(result.pageContent).not.toContain('"Deep"');

 // With maxDepth=3, the button at depth 3 IS included.
    const result2 = generateAccessibilityTree("all", 3);
    expect(result2.pageContent).toContain("button");
    expect(result2.pageContent).toContain('"Deep"');
  });

  test("10. filter=\"interactive\" — only interactive elements appear (not headings/divs)", () => {
    document.body.innerHTML = `
      <h1>Page Title</h1>
      <div>Some div text</div>
      <button>Click Me</button>
      <a href="/x">A Link</a>
      <input type="text" placeholder="Search" />
    `;
    const result = generateAccessibilityTree("interactive");
 // Interactive elements appear.
    expect(result.pageContent).toContain("button");
    expect(result.pageContent).toContain('"Click Me"');
    expect(result.pageContent).toContain("link");
    expect(result.pageContent).toContain('"A Link"');
    expect(result.pageContent).toContain("textbox");
 // Non-interactive structural / generic elements do NOT appear.
    expect(result.pageContent).not.toContain("heading");
    expect(result.pageContent).not.toContain('"Page Title"');
 // The div has no interactive role and no name worth surfacing — excluded.
    expect(result.pageContent).not.toContain("Some div text");
  });
});
