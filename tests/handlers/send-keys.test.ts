/**
 * Regression coverage for `send_keys`' synthetic-event `keyEventCodes`
 * fidelity. Bot/automation detectors flag synthetic `KeyboardEvent`s that
 * carry `keyCode === 0` / `which === 0` or a wrong `code` (e.g. `code: "A"`
 * instead of `"KeyA"`); this locks in the correct values so a future edit
 * that weakened the mapping would fail CI.
 */

import { describe, test, expect } from "vitest";
import { keyEventCodes } from "../../src/lib/agent/tools/handlers/send-keys";

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
    // realistic (33 for "!").
    expect(keyEventCodes("!")).toEqual({ keyCode: 33, which: 33, code: "Digit1" });
    expect(keyEventCodes("@")).toEqual({ keyCode: 64, which: 64, code: "Digit2" });
    expect(keyEventCodes("#")).toEqual({ keyCode: 35, which: 35, code: "Digit3" });
    expect(keyEventCodes("=")).toEqual({ keyCode: 61, which: 61, code: "Equal" });
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
});
