/**
 * input handler — UI-Events ordering contract: the cancelable `beforeinput`
 * (`inputType:"insertText"`, `data:text`) fires BEFORE the native-setter
 * mutation; `preventDefault()` cancels the edit (reported honestly, never a
 * false success); and the caret is re-synced to the end of the value so a
 * follow-up input types from the end.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { handleInput } from "../src/lib/agent/tools/handlers/input";
import type { BrowserState } from "../src/lib/agent/types";
import type { Action } from "../src/lib/agent/tools/schema";
import type { ActionContext } from "../src/lib/agent/tools/handlers/types";

function makeCtx(el: HTMLElement): ActionContext {
  return {
    state: { selectorMap: { 0: el } } as unknown as BrowserState,
    beforeUrl: location.href,
    beforeFingerprint: "fp",
  };
}

function makeInputAction(text: string, clear = true): Extract<Action, { type: "input" }> {
  return { type: "input", index: 0, text, clear } as Extract<Action, { type: "input" }>;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("handleInput beforeinput ordering", () => {
  test("beforeinput fires BEFORE the value mutation (UI Events order)", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const events: string[] = [];
    const seenData: unknown[] = [];
    input.addEventListener("beforeinput", (e) => {
      events.push("beforeinput");
      seenData.push((e as InputEvent).data);
    });
    input.addEventListener("input", () => events.push("input"));
    input.addEventListener("change", () => events.push("change"));
    // Probe that the value has NOT yet been mutated when beforeinput fires.
    input.addEventListener("beforeinput", () => {
      expect(input.value).toBe("");
    });

    const result = await handleInput(makeCtx(input), makeInputAction("hello"));
    expect(result.success).toBe(true);
    expect(events).toEqual(["beforeinput", "input", "change"]);
    expect(seenData).toEqual(["hello"]);
    expect(input.value).toBe("hello");
  });

  test("beforeinput preventDefault cancels the edit and reports an honest failure", async () => {
    const input = document.createElement("input");
    input.value = "original";
    document.body.appendChild(input);
    input.addEventListener("beforeinput", (e) => e.preventDefault());

    const result = await handleInput(makeCtx(input), makeInputAction("hello"));
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/cancelled by the page/);
    // The value must be untouched — a cancelled edit is never a false success.
    expect(input.value).toBe("original");
  });

  test("caret is re-synced to the end of the value after the mutation", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.addEventListener("input", () => {
      // jsdom keeps selectionStart/End on the input; the handler must have
      // moved them to the end by the time input listeners run.
      expect(input.selectionStart).toBe(5);
      expect(input.selectionEnd).toBe(5);
    });
    const result = await handleInput(makeCtx(input), makeInputAction("world"));
    expect(result.success).toBe(true);
  });

  test("append path (clear:false) concatenates and syncs the caret past the combined value", async () => {
    const input = document.createElement("input");
    input.value = "prefix";
    document.body.appendChild(input);
    const result = await handleInput(makeCtx(input), makeInputAction("-suffix", false));
    expect(result.success).toBe(true);
    expect(input.value).toBe("prefix-suffix");
    expect(input.selectionStart).toBe("prefix-suffix".length);
  });
});
