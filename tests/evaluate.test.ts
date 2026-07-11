// @vitest-environment-options {"url":"http://localhost:3000"}

/**
 * `evaluate` must only report `pageChanged: true` when the page actually
 * changed (URL or DOM fingerprint differs from what the executor captured in
 * `ctx` BEFORE the handler ran). A read-only script must report `false` so the
 * loop detector isn't defeated and the DOM isn't needlessly re-extracted.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { handleEvaluate } from "../src/lib/agent/tools/handlers/evaluate";
import { domFingerprint } from "../src/lib/agent/tools/helpers";
import type { ActionContext } from "../src/lib/agent/tools/handlers/types";

describe("evaluate pageChanged", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    // `evaluate` fails closed without an explicit domain allowlist.
    // The jsdom env runs at http://localhost:3000, so allowlist "localhost".
    (globalThis as Record<string, unknown>).__openCoworkDomainConfig = {
      allowedDomains: ["localhost"],
    };
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__openCoworkDomainConfig;
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
    c.beforeUrl = "http://localhost:9999/now-different";
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

  test("evaluate code cannot read chrome.storage.session (throws)", async () => {
    // A prompt-injection payload trying to exfiltrate the secret store must be
    // denied by the sandbox rather than reaching the real `chrome` global.
    await expect(
      handleEvaluate(ctx(), {
        type: "evaluate",
        code: "chrome.storage.session.get('open_cowork_secrets')",
      }),
    ).rejects.toThrow(/access denied by evaluate sandbox/);
  });

  test("window.chrome bypass vector is also denied", async () => {
    await expect(
      handleEvaluate(ctx(), {
        type: "evaluate",
        code: "window.chrome.storage.session.get('open_cowork_secrets')",
      }),
    ).rejects.toThrow(/access denied by evaluate sandbox/);
  });

  test("globalThis.chrome bypass vector is also denied", async () => {
    await expect(
      handleEvaluate(ctx(), {
        type: "evaluate",
        code: "globalThis.chrome.storage.session.get('open_cowork_secrets')",
      }),
    ).rejects.toThrow(/access denied by evaluate sandbox/);
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
