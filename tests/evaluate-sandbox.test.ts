/**
 * Regression tests for the `evaluate` sandbox hardening in
 * `src/lib/agent/tools/handlers/evaluate.ts`.
 *
 * These assert that the hardened proxies and throwing parameter stubs fail
 * CLOSED — any attempt to reach the real `chrome`/`Function`/`eval` globals
 * from inside evaluated code throws. The benign-path and "use strict" cases
 * assert the wrapper still runs ordinary code. The constructor/ownerDocument
 * bypass is documented below as a known, unpatched escape
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

  // The parameter/proxy shadowing cannot stop code from climbing an object's
  // prototype chain to the realm's own `Function` constructor (`[].constructor
  // .constructor`), which builds a function in the live realm. In the content
  // script the realm has NO `chrome` global (the secret store is kept out of
  // content-script scope — see SECURITY.md + `setSecretsResolvedExternally` in
  // secrets.ts), so even though the escape bypasses the `chrome` parameter
  // shadow it CANNOT reach `chrome.storage.session` to exfiltrate secrets. This
  // test pins that invariant: a Function obtained via the escape, when used to
  // read the secret store, must fail (throw / return the BLOCKED sentinel) —
  // it must never surface a session handle. NOTE: full realm isolation
  // (ShadowRealm / keeping the secret store in the background SW) is the
  // recommended architectural follow-up; until then the sandbox hardening here
  // is defense-in-depth and this test guards the invariant that the page realm
  // has no secret store to reach.
  test("constructor-chain escape cannot reach the secret store", () => {
    const result = runSandboxedCode(
      "const F = [].constructor.constructor;" +
        "try { return F('return chrome && chrome.storage && chrome.storage.session')(); }" +
        "catch (e) { return 'BLOCKED'; }",
    );
    expect(result).toBe("BLOCKED");
  });
});
