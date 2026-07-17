/**
 * Regression tests for the `evaluate` sandbox hardening in
 * `src/lib/agent/tools/handlers/evaluate.ts`.
 *
 * These assert that the hardened proxies and throwing parameter stubs fail
 * CLOSED — any attempt to reach the real `chrome`/`Function`/`eval` globals
 * from inside evaluated code throws. The benign-path and "use strict" cases
 * assert the wrapper still runs ordinary code. The constructor/ownerDocument
 * bypass is documented below as a known, unpatched escape owned elsewhere
 * (architectural fix: keep the secret store out of content-script scope).
 */

import { describe, test, expect } from "vitest";
import { runSandboxedCode } from "../src/lib/agent/tools/handlers/evaluate";

describe("evaluate sandbox: fail-closed hardening", () => {
  test("a benign script runs and returns its value", () => {
    expect(runSandboxedCode("return 1 + 1")).toBe(2);
  });

  test("accessing the chrome stub throws", () => {
    expect(() => runSandboxedCode("return chrome.storage")).toThrow();
  });

  test("a bare `new Function(...)` reference throws", () => {
    expect(() => runSandboxedCode("return new Function('return 1')()")).toThrow();
  });

  test("a bare `eval(...)` reference throws", () => {
    expect(() => runSandboxedCode("return eval('1 + 1')")).toThrow();
  });

  test("window.chrome throws", () => {
    expect(() => runSandboxedCode("return window.chrome")).toThrow();
  });

  test("globalThis.chrome throws", () => {
    expect(() => runSandboxedCode("return globalThis.chrome")).toThrow();
  });

  test("self.chrome throws", () => {
    expect(() => runSandboxedCode("return self.chrome")).toThrow();
  });

  test("document.defaultView throws", () => {
    expect(() => runSandboxedCode("return document.defaultView")).toThrow();
  });

  test("a leading 'use strict' directive does not break the wrapper", () => {
    expect(runSandboxedCode('"use strict"; return 2 + 2')).toBe(4);
  });

  test("a leading comment followed by 'use strict' does not break the wrapper", () => {
    expect(runSandboxedCode('// generated\n"use strict"; return 3 + 3')).toBe(6);
  });

  // KNOWN, UNPATCHED bypass (owned elsewhere — see SECURITY.md). The
  // parameter/proxy shadowing cannot stop code from climbing an object's
  // prototype chain to the real `Function` constructor, which builds a
  // function in the live global scope and re-opens the secret-exfil path.
  // This escape must remain reachable until the architectural fix lands; the
  // test records that fact so a silent "fix" that closes it the wrong way
  // (e.g. by weakening legitimate code) is visible.
  test("constructor-chain escape still reaches the real Function (known unpatched bypass)", () => {
    const ctor = runSandboxedCode("return [].constructor.constructor");
    expect(typeof ctor).toBe("function");
  });
});
