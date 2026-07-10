/**
 * F-14: `appendThinkingEntry` must HTML-escape `body` before interpolating it
 * into `innerHTML`, so a future unescaped LLM/page string can never XSS the
 * side panel. Callers pass RAW (unescaped) text; newlines render as `<br>`.
 *
 * `lifecycle.ts` imports `elements.ts`, which reads several element ids at
 * module load via the throwing `$()` helper — so those ids must exist before
 * the dynamic import.
 */

import { describe, test, expect, beforeAll, beforeEach } from "vitest";

function setupDom(): void {
  document.body.innerHTML = `
    <textarea id="task"></textarea>
    <button id="runBtn"></button>
    <button id="stopBtn"></button>
    <div id="log"></div>
    <span id="stepLabel"></span>
    <span id="countLabel"></span>
    <span id="barFill"></span>
    <span id="liveDot"></span>
    <span id="costLabel"></span>
    <span id="tokenLabel"></span>
    <div id="thinkingBody"></div>
  `;
}

describe("appendThinkingEntry body escaping (F-14)", () => {
  let appendThinkingEntry: (
    kind: "planner" | "navigator" | "error",
    head: string,
    body: string,
  ) => void;
  let thinkingBody: HTMLElement;

  beforeAll(async () => {
    setupDom();
    const mod = await import("../src/extension/sidepanel/lifecycle");
    appendThinkingEntry = mod.appendThinkingEntry;
    thinkingBody = document.getElementById("thinkingBody") as HTMLElement;
  });

  beforeEach(() => {
    // Each test appends a new entry; clear so querySelector finds THIS test's
    // entry rather than the first one ever appended.
    thinkingBody.innerHTML = "";
  });

  test("escapes an HTML-injection payload in body (no live element)", () => {
    appendThinkingEntry("navigator", "Step 1", `<img src=x onerror=alert(1)>`);
    const entry = thinkingBody.querySelector(".te-body") as HTMLElement;
    expect(entry).not.toBeNull();
    // The raw tag is escaped — no <img> element was actually created.
    expect(entry.querySelector("img")).toBeNull();
    expect(entry.innerHTML).toContain("&lt;img");
    expect(entry.innerHTML).not.toContain("<img");
  });

  test("escapes script payloads in body", () => {
    appendThinkingEntry("error", "Step 2", `<script>alert('xss')</script>`);
    const entry = thinkingBody.querySelector(".te-body") as HTMLElement;
    expect(entry.querySelector("script")).toBeNull();
    expect(entry.innerHTML).toContain("&lt;script&gt;");
  });

  test("renders newlines as <br> and escapes each line", () => {
    appendThinkingEntry("planner", "Step 3", "line one\nline <b>two</b>");
    const entry = thinkingBody.querySelector(".te-body") as HTMLElement;
    expect(entry.innerHTML).toContain("<br>");
    expect(entry.innerHTML).toContain("line one");
    expect(entry.innerHTML).toContain("line &lt;b&gt;two&lt;/b&gt;");
    expect(entry.querySelector("b")).toBeNull();
  });

  test("escapes the head too", () => {
    appendThinkingEntry("navigator", "<b>head</b>", "plain body");
    const head = thinkingBody.querySelector(".te-head") as HTMLElement;
    expect(head.innerHTML).toContain("&lt;b&gt;head&lt;/b&gt;");
    expect(head.querySelector("b")).toBeNull();
  });
});
