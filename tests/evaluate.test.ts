// @vitest-environment-options {"url":"http://test.example.com/"}

/**
 * `evaluate` must only report `pageChanged: true` when the page actually
 * changed (URL or DOM fingerprint differs from what the executor captured in
 * `ctx` BEFORE the handler ran). A read-only script must report `false` so the
 * loop detector isn't defeated and the DOM isn't needlessly re-extracted.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { handleEvaluate } from "../src/lib/agent/tools/handlers/evaluate";
import { runSandboxedCode } from "../src/lib/agent/tools/handlers/evaluate-utils";
import { domFingerprint } from "../src/lib/agent/tools/helpers";
import type { ActionContext } from "../src/lib/agent/tools/handlers/types";
import { allowDomain, clearDomainAllowlist } from "./helpers/domain-stub";

describe("evaluate pageChanged", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    // `evaluate` fails closed without an explicit domain allowlist.
    // The jsdom env runs at http://test.example.com, so allowlist "test.example.com"
    // (a dotted host the hardened matcher accepts).
    allowDomain("test.example.com");
  });
  afterEach(() => {
    clearDomainAllowlist();
  });

  function ctx(): ActionContext {
    return {
      state: {} as ActionContext["state"],
      beforeUrl: location.href,
      beforeFingerprint: domFingerprint(),
    };
  }

  test("a read-only evaluate reports pageChanged: false", async () => {
    const res = await handleEvaluate(ctx(), {
      type: "evaluate",
      code: "1 + 1",
    });
    expect(res.success).toBe(true);
    expect(res.pageChanged).toBe(false);
  });

  test("an evaluate that mutates the DOM reports pageChanged: true", async () => {
    const res = await handleEvaluate(ctx(), {
      type: "evaluate",
      code: "document.body.appendChild(document.createElement('button'));",
    });
    expect(res.success).toBe(true);
    expect(res.pageChanged).toBe(true);
  });

  test("an evaluate whose captured URL differs reports pageChanged: true", async () => {
    // The handler compares the LIVE location.href against the URL the executor
    // captured in `ctx.beforeUrl`. A genuine navigation between capture + run
    // makes them differ → pageChanged true (even with a read-only script).
    const c = ctx();
    c.beforeUrl = "http://127.0.0.2/now-different";
    const res = await handleEvaluate(c, { type: "evaluate", code: "1 + 1" });
    expect(res.success).toBe(true);
    expect(res.pageChanged).toBe(true);
  });

  test("evaluate is blocked when the origin is not on the allowlist", async () => {
    delete (globalThis as Record<string, unknown>).__openCoworkDomainConfig;
    const res = await handleEvaluate(ctx(), { type: "evaluate", code: "1 + 1" });
    expect(res.success).toBe(false);
    expect(res.message).toContain("BLOCKED evaluate");
  });

  // ─── evaluate sandbox must deny `chrome` access (no secret exfil) ───

  test.each([
    ["chrome", "chrome.storage.session.get('open_cowork_secrets')"],
    ["window.chrome", "window.chrome.storage.session.get('open_cowork_secrets')"],
    ["globalThis.chrome", "globalThis.chrome.storage.session.get('open_cowork_secrets')"],
    ["self.chrome", "self.chrome"],
  ])("direct %s access denied", async (_name, code) => {
    // A prompt-injection payload trying to exfiltrate the secret store must be
    // denied by the sandbox rather than reaching the real `chrome` global.
    await expect(
      handleEvaluate(ctx(), { type: "evaluate", code }),
    ).rejects.toThrow(/access denied by evaluate sandbox/);
  });

  test("Function('return chrome')() indirect access is also denied", async () => {
    await expect(
      handleEvaluate(ctx(), {
        type: "evaluate",
        code: "Function('return chrome')()",
      }),
    ).rejects.toThrow(/access denied by evaluate sandbox/);
  });

  test("eval('chrome') indirect access is also denied", async () => {
    await expect(
      handleEvaluate(ctx(), {
        type: "evaluate",
        code: "eval('chrome')",
      }),
    ).rejects.toThrow(/access denied by evaluate sandbox/);
  });

  test("reflection-based Reflect.get(globalThis, 'chrome') access denied", async () => {
    // `Reflect.get` still routes through the hardened proxy's `get` trap, which
    // denies `chrome`, so this indirect path is also blocked.
    await expect(
      handleEvaluate(ctx(), { type: "evaluate", code: "Reflect.get(globalThis, 'chrome')" }),
    ).rejects.toThrow(/access denied by evaluate sandbox/);
  });

  // The reflection vector through `getOwnPropertyDescriptor` is now denied: the
  // hardened window proxy traps `getOwnPropertyDescriptor` and reports denied
  // props (`chrome`) as absent, so the descriptor access cannot recover the real
  // `chrome` global. Lock the hardening with a passing regression assertion.
  test("getOwnPropertyDescriptor(window,'chrome') does not reveal real chrome", async () => {
    const res = await handleEvaluate(ctx(), {
      type: "evaluate",
      code: "return Object.getOwnPropertyDescriptor(window, 'chrome') === undefined;",
    });
    expect(res.success).toBe(true);
    expect(res.extractedContent).toBe("true");
  });

  test("legitimate numeric/string computation still works in the sandbox", async () => {
    const res = await handleEvaluate(ctx(), { type: "evaluate", code: "return 2 + 2" });
    expect(res.success).toBe(true);
    expect(res.extractedContent).toBe("4");
  });

  test("document is still available for legitimate DOM evaluation", async () => {
    // The sandbox hardens `chrome` but keeps the page `document` usable.
    const res = await handleEvaluate(ctx(), {
      type: "evaluate",
      code: "document.body.appendChild(document.createElement('span')); return 'ok'",
    });
    expect(res.success).toBe(true);
    expect(res.extractedContent).toBe("ok");
    expect(document.querySelector("span")).not.toBeNull();
  });
});

describe("runSandboxedCode unicode-escape normalization", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("a single-escaped \\u002econstructor decodes and is blocked", () => {
    // Source contains `\u002econstructor` — the escape scanner must decode it
    // to `.constructor` and block the program.
    expect(() => runSandboxedCode("'\\u002econstructor'")).toThrow(/blocked/);
  });

  test("a double-escaped \\\\u002econstructor is literal data, NOT blocked", () => {
    // Source contains `\\u002econstructor` — an escaped backslash followed by
    // the literal text "u002econstructor". Decoding the escape would be a
    // false positive; the program is harmless and must run.
    expect(() => runSandboxedCode("'\\\\u002econstructor'")).not.toThrow();
  });

  test("triple-escaped escapes still decode (even backslash count)", () => {
    // Source contains `\\\u002econstructor` — `\\` is an escaped backslash and
    // `\u002e` is a real escape, so the decoded program contains `.constructor`
    // and must be blocked.
    expect(() => runSandboxedCode("'\\\\\\u002econstructor'")).toThrow(/blocked/);
  });
});

describe("domFingerprint window hashing", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("is stable across calls on an unchanged DOM", () => {
    document.body.innerHTML = "<button>1</button><button>2</button>";
    expect(domFingerprint()).toBe(domFingerprint());
  });

  test("changes when an interactive element's text changes", () => {
    document.body.innerHTML = "<button>one</button>";
    const before = domFingerprint();
    document.querySelector("button")!.textContent = "two";
    expect(domFingerprint()).not.toBe(before);
  });

  test("hashes the trailing window when n > limit (below-the-fold changes detected)", () => {
    // 501 buttons (limit = 500): the LAST element falls only in the trailing
    // window. Leading-window-only hashing would miss the change.
    for (let i = 0; i < 501; i++) {
      const b = document.createElement("button");
      b.textContent = `b${i}`;
      document.body.appendChild(b);
    }
    const before = domFingerprint();
    const last = document.querySelectorAll("button")[500];
    last.textContent = "changed-last";
    expect(domFingerprint()).not.toBe(before);
  });

  test("caps per-element signature length (very long text/aria-label bound)", () => {
    const longText = "x".repeat(4000);
    document.body.innerHTML = `<button aria-label="${longText}">${longText}</button>`;
    // The fingerprint stays a compact hex string (16 chars from FNV-1a) — the
    // per-element signature cap prevents hashing megabytes of text.
    expect(domFingerprint()).toMatch(/^[0-9a-f]{1,8}$/);
  });

  test("does NOT fold input values into the fingerprint (transient input churn)", () => {
    document.body.innerHTML = '<input type="text" value="secret">';
    const before = domFingerprint();
    const input = document.querySelector("input")!;
    input.value = "changed";
    expect(domFingerprint()).toBe(before);
  });
});
