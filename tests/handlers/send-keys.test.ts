/**
 * Regression coverage for `send_keys`' synthetic-event `keyEventCodes`
 * fidelity. Bot/automation detectors flag synthetic `KeyboardEvent`s that
 * carry `keyCode === 0` / `which === 0` or a wrong `code` (e.g. `code: "A"`
 * instead of `"KeyA"`); this locks in the correct values so a future edit
 * that weakened the mapping would fail CI.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { keyEventCodes } from "../../src/lib/agent/tools/handlers/send-keys";
import { mutateTextInput } from "../../src/lib/agent/tools/handlers/send-keys-utils";
import { parseKeys, type ParsedKeys } from "../../src/lib/agent/tools/helpers/key-parser";

const plain = (main: string): ParsedKeys => ({
  main,
  ctrl: false,
  shift: false,
  alt: false,
  meta: false,
});

describe("keyEventCodes fidelity", () => {
  test("uppercase letter maps to Key<UPPER> with the upper-case keyCode", () => {
    expect(keyEventCodes("A")).toEqual({ keyCode: 65, which: 65, code: "KeyA" });
  });

  test("lowercase letter maps to Key<UPPER> (keyCode is the upper-case code)", () => {
    expect(keyEventCodes("a")).toEqual({ keyCode: 65, which: 65, code: "KeyA" });
  });

  test("digit maps to Digit<n> with its charCode keyCode", () => {
    expect(keyEventCodes("1")).toEqual({ keyCode: 49, which: 49, code: "Digit1" });
  });

  test("shifted symbol maps to its physical base code (not the literal char)", () => {
    // A real Shift+1 KeyboardEvent has code "Digit1", NOT "!". Emitting
    // code:"!" is a detectable automation anomaly. keyCode/which stay
    // realistic (the physical key's code, not the literal char code).
    expect(keyEventCodes("!")).toEqual({ keyCode: 49, which: 49, code: "Digit1" });
    expect(keyEventCodes("@")).toEqual({ keyCode: 50, which: 50, code: "Digit2" });
    expect(keyEventCodes("#")).toEqual({ keyCode: 51, which: 51, code: "Digit3" });
    expect(keyEventCodes("=")).toEqual({ keyCode: 187, which: 187, code: "Equal" });
  });

  test("space maps to code 'Space' with keyCode 32", () => {
    expect(keyEventCodes(" ")).toEqual({ keyCode: 32, which: 32, code: "Space" });
  });

  test("named function keys carry their legacy keyCode and valid code", () => {
    expect(keyEventCodes("Escape")).toEqual({ keyCode: 27, which: 27, code: "Escape" });
    expect(keyEventCodes("Tab")).toEqual({ keyCode: 9, which: 9, code: "Tab" });
    expect(keyEventCodes("Enter")).toEqual({ keyCode: 13, which: 13, code: "Enter" });
    expect(keyEventCodes("F1")).toEqual({ keyCode: 112, which: 112, code: "F1" });
    expect(keyEventCodes("F12")).toEqual({ keyCode: 123, which: 123, code: "F12" });
    expect(keyEventCodes("ArrowLeft")).toEqual({ keyCode: 37, which: 37, code: "ArrowLeft" });
  });

  test("Object.prototype names like 'constructor' never resolve through NAMED_KEY_CODES", () => {
    expect(keyEventCodes("constructor")).toEqual({ keyCode: 0, which: 0, code: "" });
    expect(keyEventCodes("toString")).toEqual({ keyCode: 0, which: 0, code: "" });
    expect(keyEventCodes("hasOwnProperty")).toEqual({ keyCode: 0, which: 0, code: "" });
  });

  test("parseKeys never maps an Object.prototype name through KEY_MAP", () => {
    expect(parseKeys("constructor")).toEqual({
      main: "constructor",
      ctrl: false,
      shift: false,
      alt: false,
      meta: false,
    });
    expect(parseKeys("toString")).toEqual({
      main: "toString",
      ctrl: false,
      shift: false,
      alt: false,
      meta: false,
    });
  });
});

describe("mutateTextInput caret placement", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("typing at the end appends and leaves the caret after the new char", () => {
    const input = document.createElement("input");
    input.value = "abc";
    input.setSelectionRange(3, 3);
    expect(mutateTextInput(input, plain("d"))).toBe(true);
    expect(input.value).toBe("abcd");
    expect(input.selectionStart).toBe(4);
  });

  test("typing 'hello' into an empty field yields 'hello' (not a scramble)", () => {
    const input = document.createElement("input");
    input.value = "";
    for (const ch of "hello") {
      input.setSelectionRange(input.value.length, input.value.length);
      expect(mutateTextInput(input, plain(ch))).toBe(true);
    }
    expect(input.value).toBe("hello");
  });

  test("caret beyond the value length clamps to the end instead of inserting at 0", () => {
    const input = document.createElement("input");
    input.value = "abc";
    input.setSelectionRange(10, 10);
    expect(mutateTextInput(input, plain("d"))).toBe(true);
    expect(input.value).toBe("abcd");
    expect(input.selectionStart).toBe(4);
  });

  test("mid-string insert keeps the caret after the inserted char", () => {
    const input = document.createElement("input");
    input.value = "ac";
    input.setSelectionRange(1, 1);
    expect(mutateTextInput(input, plain("b"))).toBe(true);
    expect(input.value).toBe("abc");
    expect(input.selectionStart).toBe(2);
  });
});
