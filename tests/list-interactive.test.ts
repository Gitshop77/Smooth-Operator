/**
 * `list_interactive` + the 5-strategy selector chain.
 *
 * `list_interactive` is the port of stealthy's get_elements.js: lists
 * interactive elements (links, buttons, inputs, selects, textareas,
 * [role=…], [onclick], [tabindex], label[for], summary, [contenteditable])
 * with pixel coordinates + unique CSS selectors so the LLM gets CDP click
 * targets without a vision pass.
 *
 * `generateCssSelector` is extended from 2 strategies (id, tag.class) to 5:
 * id → unique class → tag[name] → data-testid/aria-label/title/placeholder
 * → CSS sibling-count chain (the XPath walk expressed as `:nth-of-type`).
 * The first two strategies keep their existing output byte-for-byte (the
 * click fallback in click-utils.ts re-finds by CSS and depends on them).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleListInteractive } from "../src/lib/agent/tools/handlers/list-interactive";
import { generateCssSelector } from "../src/lib/agent/tools/helpers/element-resolver";
import { makeState } from "./helpers";
import type { ActionContext } from "../src/lib/agent/tools/handlers/types";
import type { ActionResult } from "../src/lib/agent/types";

function ctx(): ActionContext {
  return {
    state: makeState(),
    beforeUrl: "https://example.com",
    beforeFingerprint: "fp",
  };
}

/** Give an element a concrete layout rect (jsdom has no layout engine). */
function mockRect(el: Element, x: number, y: number, w: number, h: number): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      x,
      y,
      width: w,
      height: h,
      top: y,
      left: x,
      right: x + w,
      bottom: y + h,
      toJSON: () => ({}),
    }) as DOMRect;
}

interface ParsedDescriptor {
  i: number;
  tag: string;
  id: string;
  text: string;
  selector: string;
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}

function parseListing(res: ActionResult): ParsedDescriptor[] {
  const content = res.extractedContent ?? "";
  return content
    .split("\n")
    .filter((line) => /^\d+: /.test(line))
    .map((line) => JSON.parse(line.slice(line.indexOf(": ") + 2)) as ParsedDescriptor);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("handleListInteractive", () => {
  it("lists 2 inputs + 1 button with numeric x/y/w/h and visible flags", async () => {
    document.body.innerHTML = `
      <div>
        <input id="q" name="q" placeholder="Search…">
        <input type="password" id="pwd">
        <button>Submit</button>
      </div>`;
    const q = document.getElementById("q")!;
    const pwd = document.getElementById("pwd")!;
    const submit = document.querySelector("button")!;
    mockRect(q, 10, 20, 200, 40);
    mockRect(pwd, 10, 70, 200, 40);
    mockRect(submit, 10, 120, 120, 36);

    const res = await handleListInteractive(ctx(), { type: "list_interactive", visible_only: false, max_results: 50 });

    expect(res.success).toBe(true);
    const items = parseListing(res);
    expect(items.length).toBe(3);
    const [qItem, pwdItem, btnItem] = items;
    expect(qItem.tag).toBe("input");
    expect(qItem.id).toBe("q");
    expect(qItem.text).toBe("Search…");
    expect(qItem.x).toBe(110); // round(10 + 200/2)
    expect(qItem.y).toBe(40);  // round(20 + 40/2)
    expect(qItem.w).toBe(200);
    expect(qItem.h).toBe(40);
    expect(qItem.visible).toBe(true);
    expect(pwdItem.id).toBe("pwd");
    expect(pwdItem.text).toBe("[value redacted]");
    expect(pwdItem.visible).toBe(true);
    expect(btnItem.tag).toBe("button");
    expect(btnItem.text).toBe("Submit");
    expect(btnItem.x).toBe(70);
    expect(btnItem.y).toBe(138);
  });

  it("returns unique selectors for every listed element", async () => {
    document.body.innerHTML = `
      <input id="q" name="q">
      <button data-testid="cta">Go</button>
      <a href="/home">Home</a>`;
    for (const el of Array.from(document.querySelectorAll("*"))) {
      if (el.tagName !== "HTML" && el.tagName !== "BODY" && el.tagName !== "DIV") {
        mockRect(el, 0, 0, 100, 30);
      }
    }

    const res = await handleListInteractive(ctx(), { type: "list_interactive", visible_only: false, max_results: 50 });
    const items = parseListing(res);
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const item of items) {
      expect(document.querySelectorAll(item.selector).length).toBe(1);
    }
  });

  it("filters off-viewport elements when visible_only is set", async () => {
    document.body.innerHTML = `
      <button id="on">On screen</button>
      <button id="off">Off screen</button>`;
    mockRect(document.getElementById("on")!, 10, 10, 100, 30);
    mockRect(document.getElementById("off")!, 5000, 5000, 100, 30);

    const all = await handleListInteractive(ctx(), { type: "list_interactive", visible_only: false, max_results: 50 });
    const allItems = parseListing(all);
    expect(allItems.find((i) => i.id === "on")!.visible).toBe(true);
    expect(allItems.find((i) => i.id === "off")!.visible).toBe(false);
    expect(allItems.length).toBe(2);

    const filtered = await handleListInteractive(ctx(), { type: "list_interactive", visible_only: true, max_results: 50 });
    const filteredItems = parseListing(filtered);
    expect(filteredItems.length).toBe(1);
    expect(filteredItems[0].id).toBe("on");
  });

  it("caps text at 60 chars and honors max_results", async () => {
    document.body.innerHTML = `
      <button>${"x".repeat(80)}</button>
      <button>Second</button>
      <button>Third</button>`;
    const buttons = Array.from(document.querySelectorAll("button"));
    buttons.forEach((b, i) => mockRect(b, 0, i * 40, 100, 30));

    const res = await handleListInteractive(ctx(), { type: "list_interactive", visible_only: false, max_results: 2 });
    const items = parseListing(res);
    expect(items.length).toBe(2);
    expect(items[0].text.length).toBeLessThanOrEqual(60);
    expect(items[0].text).toBe("x".repeat(60));
  });

  it("masks input values containing registered secrets", async () => {
    const { setSecret } = await import("../src/lib/agent/secrets");
    await setSecret("listingsecret", "super-secret-value-123");
    document.body.innerHTML = `<input id="secret" value="super-secret-value-123">`;
    mockRect(document.getElementById("secret")!, 0, 0, 100, 30);

    const res = await handleListInteractive(ctx(), { type: "list_interactive", visible_only: false, max_results: 50 });
    const items = parseListing(res);
    expect(items[0].text).not.toContain("super-secret-value-123");
  });
});

describe("generateCssSelector — 5-strategy chain", () => {
  it("keeps the id strategy byte-for-byte (stability for the click fallback)", () => {
    document.body.innerHTML = `<div id="hero">x</div>`;
    expect(generateCssSelector(document.getElementById("hero")!)).toBe(`*[id="hero"]`);
  });

  it("uses tag + unique class", () => {
    document.body.innerHTML = `<div class="unique-widget">x</div>`;
    expect(generateCssSelector(document.querySelector(".unique-widget")!)).toBe("div.unique-widget");
  });

  it("falls through a non-unique class to tag[name]", () => {
    document.body.innerHTML = `
      <div class="shared">a</div>
      <div class="shared">b</div>
      <input name="email">`;
    const input = document.querySelector('input[name="email"]')!;
    expect(generateCssSelector(input)).toBe('input[name="email"]');
  });

  it("uses data-testid / aria-label / title / placeholder attributes", () => {
    document.body.innerHTML = `
      <button data-testid="cta">Go</button>
      <div aria-label="close">×</div>
      <img title="Logo" alt="Logo">
      <input placeholder="Search…">`;
    expect(generateCssSelector(document.querySelector('[data-testid="cta"]')!)).toBe('button[data-testid="cta"]');
    expect(generateCssSelector(document.querySelector('[aria-label="close"]')!)).toBe('div[aria-label="close"]');
    expect(generateCssSelector(document.querySelector("img")!)).toBe('img[title="Logo"]');
    expect(generateCssSelector(document.querySelector("input")!)).toBe('input[placeholder="Search…"]');
  });

  it("escapes quotes inside attribute values", () => {
    document.body.innerHTML = `<input placeholder='say "hi"'>`;
    const input = document.querySelector("input")!;
    const sel = generateCssSelector(input);
    expect(sel).toBe('input[placeholder="say \\"hi\\""]');
    expect(document.querySelectorAll(sel).length).toBe(1);
  });

  it("emits a CSS sibling-count chain for elements with no id/class/name/attrs", () => {
    document.body.innerHTML = `
      <div><button id="first">A</button></div>
      <div>
        <button>B</button>
        <button>C</button>
      </div>`;
    const target = document.querySelectorAll("div:nth-of-type(2) button")[0] as HTMLButtonElement;
    const sel = generateCssSelector(target);
    expect(sel).toBe("html > body:nth-of-type(1) > div:nth-of-type(2) > button:nth-of-type(1)");
    expect(document.querySelectorAll(sel).length).toBe(1);
    expect(document.querySelector(sel)).toBe(target);
  });
});
