/**
 * Regression tests for the `evaluate` sandbox hardening in
 * `src/lib/agent/tools/handlers/evaluate.ts`.
 *
 * These assert that the hardened proxies and throwing parameter stubs fail
 * CLOSED — any attempt to reach the real `chrome`/`Function`/`eval` globals
 * from inside evaluated code throws. The benign-path and "use strict" cases
 * assert the wrapper still runs ordinary code. The constructor/ownerDocument
 * bypass is documented below as a partially patched escape
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

  // The obvious Function-constructor escape (`[].constructor.constructor`) is
  // now caught by a code-string scan before the sandbox is entered. Obfuscated
  // variants (string concat, template literals) are caught by the MV3 platform
  // restriction on chrome.storage.session from content scripts. This test pins
  // the invariant that the secret store is unreachable from content-script scope
  // even if the scan is bypassed.
  test("constructor-chain escape cannot reach the secret store", () => {
    expect(() =>
      runSandboxedCode(
        "const F = [].constructor.constructor;" +
          "try { return F('return chrome && chrome.storage && chrome.storage.session')(); }" +
          "catch (e) { return 'BLOCKED'; }",
      ),
    ).toThrow(/Function-constructor escape pattern detected/);
  });

  test("obvious constructor-chain escape is blocked at entry", () => {
    expect(() =>
      runSandboxedCode("[].constructor.constructor('return 1')()")
    ).toThrow(/Function-constructor escape pattern detected/);
    expect(() =>
      runSandboxedCode("({}).constructor.constructor('return 1')()")
    ).toThrow(/Function-constructor escape pattern detected/);
  });

  test("async function constructor escape is blocked at entry", () => {
    expect(() =>
      runSandboxedCode("(async function(){}).constructor('return 1')()")
    ).toThrow(/Function-constructor escape pattern detected/);
  });
});
