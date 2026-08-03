// @vitest-environment-options {"url":"http://test.example.com/"}

/**
 * Direct regression coverage for the evaluate sandbox hardening
 * (`runSandboxedCode`). The sandbox shadows the dangerous globals by passing
 * them as function parameters wired to throwing / hardened proxies. The free
 * identifiers `parent`, `top`, `frames`, `opener` would otherwise resolve to
 * the REAL content-script window — whose `.chrome` is the real extension API —
 * so `parent.chrome.storage.local.get("apiKey")` would reach the
 * content-script-readable api-key mirror. They must be denied like the
 * directly-shadowed globals. `atob`/`btoa` are denied as well: a computed-key
 * escape (`Array[atob("Y29uc3RydWN0b3I=")]`) would otherwise defeat the
 * literal-string scans of the constructor-escape detector.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { runSandboxedCode } from "../src/lib/agent/tools/handlers/evaluate-utils";

describe("evaluate sandbox free-identifier hardening", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("parent.chrome is denied (parent shadows the real content-script window)", () => {
    // `parent` must NOT resolve to the real realm window whose `.chrome` is
    // the live extension API. In jsdom the real `parent.chrome` is undefined,
    // so only a parameter-wired denial can make this throw.
    expect(() => runSandboxedCode("parent.chrome")).toThrow(
      /access denied by evaluate sandbox/,
    );
  });

  test("top.chrome is denied", () => {
    expect(() => runSandboxedCode("top.chrome")).toThrow(
      /access denied by evaluate sandbox/,
    );
  });

  test("frames.chrome is denied", () => {
    expect(() => runSandboxedCode("frames.chrome")).toThrow(
      /access denied by evaluate sandbox/,
    );
  });

  test("opener.chrome is denied", () => {
    expect(() => runSandboxedCode("opener.chrome")).toThrow(
      /access denied by evaluate sandbox/,
    );
  });

  test("window.parent.chrome is denied through the hardened window proxy", () => {
    expect(() => runSandboxedCode("window.parent.chrome")).toThrow(
      /access denied by evaluate sandbox/,
    );
  });

  test("parent.document.defaultView.chrome is denied through traversal", () => {
    expect(() => runSandboxedCode("parent.document.defaultView.chrome")).toThrow(
      /access denied by evaluate sandbox/,
    );
  });

  test("atob is denied (computed-key constructor escapes)", () => {
    // `Array[atob("Y29uc3RydWN0b3I=")]` builds "constructor" dynamically,
    // defeating the literal-string scan; denying atob closes that path.
    expect(() => runSandboxedCode("atob('Y29uc3RydWN0b3I=')")).toThrow(
      /access denied by evaluate sandbox/,
    );
  });

  test("btoa is denied", () => {
    expect(() => runSandboxedCode("btoa('x')")).toThrow(
      /access denied by evaluate sandbox/,
    );
  });

  test("computed-key constructor escape via atob is blocked", () => {
    expect(() =>
      runSandboxedCode("Array[atob('Y29uc3RydWN0b3I=')]"),
    ).toThrow(/access denied by evaluate sandbox/);
  });

  test("legitimate code still runs in the hardened sandbox", () => {
    expect(runSandboxedCode("return 2 + 2")).toBe(4);
    expect(runSandboxedCode("return ['a', 'b'].join('-')")).toBe("a-b");
  });

  test("the sandbox keeps window/document usable for legitimate DOM work", () => {
    const out = runSandboxedCode(
      "document.body.appendChild(document.createElement('span')); return 'ok'",
    );
    expect(out).toBe("ok");
    expect(document.querySelector("span")).not.toBeNull();
  });
});

describe("evaluate sandbox fail-closed hardening (regression)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

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

  test("[].__proto__.constructor.constructor escape is blocked", () => {
    expect(() =>
      runSandboxedCode(
        "return [].__proto__.constructor.constructor('return chrome')()",
      ),
    ).toThrow();
  });

  test("({}).__proto__.constructor escape is blocked", () => {
    expect(() =>
      runSandboxedCode("return ({}).__proto__.constructor"),
    ).toThrow();
  });

  test("bracket-notation ['constructor'] access is blocked by scan", () => {
    expect(() =>
      runSandboxedCode("return {}['constructor']"),
    ).toThrow(/sandbox escape pattern/);
  });

  test("Object.getPrototypeOf(Array).constructor is blocked on hardened builtins", () => {
    expect(() =>
      runSandboxedCode("return Object.getPrototypeOf(Array).constructor"),
    ).toThrow();
  });

  test("__proto__ access on hardened Object proxy is denied", () => {
    expect(() =>
      runSandboxedCode("return Object.__proto__"),
    ).toThrow(/sandbox escape pattern/);
  });

  test("bracket-notation __proto__ access is blocked by scan", () => {
    expect(() =>
      runSandboxedCode("return Object['__proto__']"),
    ).toThrow(/sandbox escape pattern/);
  });

  test("getPrototypeOf in code string is blocked by scan", () => {
    expect(() =>
      runSandboxedCode("return Object.getPrototypeOf({})"),
    ).toThrow(/sandbox escape pattern/);
  });

  test("normal array operations still work in sandbox", () => {
    expect(runSandboxedCode("return [1, 2, 3].length")).toBe(3);
    expect(runSandboxedCode("return Array.from([1, 2, 3])")).toEqual([1, 2, 3]);
  });

  test("normal object operations still work in sandbox", () => {
    expect(runSandboxedCode("return Object.keys({a: 1})")).toEqual(["a"]);
    expect(runSandboxedCode("return typeof Object")).toBe("function");
  });
});
