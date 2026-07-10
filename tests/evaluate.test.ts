// @vitest-environment-options {"url":"http://localhost:3000"}

/**
 * F-19: `evaluate` must only report `pageChanged: true` when the page actually
 * changed (URL or DOM fingerprint differs from what the executor captured in
 * `ctx` BEFORE the handler ran). A read-only script must report `false` so the
 * loop detector isn't defeated and the DOM isn't needlessly re-extracted.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { handleEvaluate } from "../src/lib/agent/tools/handlers/evaluate";
import { domFingerprint } from "../src/lib/agent/tools/helpers";
import type { ActionContext } from "../src/lib/agent/tools/handlers/types";

describe("evaluate pageChanged (F-19)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    // F-15: `evaluate` fails closed without an explicit domain allowlist.
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

  test("F-15: evaluate is blocked when the origin is not on the allowlist", async () => {
    delete (globalThis as Record<string, unknown>).__openCoworkDomainConfig;
    const res = await handleEvaluate(ctx(), { type: "evaluate", code: "1 + 1" });
    expect(res.success).toBe(false);
    expect(res.message).toContain("BLOCKED evaluate");
  });
});
