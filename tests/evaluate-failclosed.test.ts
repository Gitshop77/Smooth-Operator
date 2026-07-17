// @vitest-environment-options {"url":"http://127.0.0.1:3000/"}

/**
 * Regression coverage for the two fail-closed security gates in `handleEvaluate`
 * (see evaluate.ts lines ~313-326 and ~330-351):
 *
 *  1. `isDomainConfigMissingButEnforced()` → the domain policy was configured as
 *     enforced but the config payload is absent → `evaluate` MUST block
 *     (fail-closed), never run the LLM-authored JS.
 *
 *  2. `import("../registry")` (the custom-tool substitution step) fails → the
 *     handler MUST block and MUST NOT fall through to running the unmodified
 *     LLM-authored code via `new Function`.
 *
 * A regression that silently fell through to `new Function(code)` would not be
 * caught by the happy-path tests below; these assertions pin the blocked
 * outcome so such a regression fails loudly.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { handleEvaluate } from "../src/lib/agent/tools/handlers/evaluate";
import type { ActionContext } from "../src/lib/agent/tools/handlers/types";

// Force the dynamic `import("../registry")` inside handleEvaluate to fail when
// its result is used. The `substituteCustomToolCalls` export is a throwing
// getter, so `const { substituteCustomToolCalls } = await import("../registry")`
// rejects — exactly the fail-closed branch that refuses to run unmodified
// LLM-authored code. `MAX_CUSTOM_TOOL_CODE_LENGTH` is supplied as a plain data
// property so the static import in schema.ts still resolves.
vi.mock("../src/lib/agent/tools/registry", () => {
  return {
    MAX_CUSTOM_TOOL_CODE_LENGTH: 256 * 1024,
    get substituteCustomToolCalls(): never {
      throw new Error("registry unavailable in test");
    },
  };
});

const DOMAIN_CONFIG_KEY = "__openCoworkDomainConfig";
const DOMAIN_CONFIG_ENFORCED_KEY = "__openCoworkDomainConfigEnforced";

describe("evaluate fail-closed gates", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[DOMAIN_CONFIG_KEY];
    delete (globalThis as Record<string, unknown>)[DOMAIN_CONFIG_ENFORCED_KEY];
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[DOMAIN_CONFIG_KEY];
    delete (globalThis as Record<string, unknown>)[DOMAIN_CONFIG_ENFORCED_KEY];
  });

  function ctx(): ActionContext {
    return {
      state: {} as ActionContext["state"],
      beforeUrl: location.href,
      beforeFingerprint: "",
    };
  }

  test("evaluate is BLOCKED when a domain policy is enforced but the config is missing", async () => {
    // Enforced flag set, but no config payload present → fail closed.
    (globalThis as Record<string, unknown>)[DOMAIN_CONFIG_ENFORCED_KEY] = true;
    delete (globalThis as Record<string, unknown>)[DOMAIN_CONFIG_KEY];

    const res = await handleEvaluate(ctx(), {
      type: "evaluate",
      code: "return globalThis.openCowork_secret_probe",
    });

    expect(res.success).toBe(false);
    expect(res.message).toContain("BLOCKED evaluate");
    // The offending code must NOT have been executed.
    expect((globalThis as Record<string, unknown>).openCowork_secret_probe).toBeUndefined();
  });

  test("evaluate is BLOCKED (and code NOT run) when registry import fails", async () => {
    // Allowlist the origin so the only gate that can fire is the import failure.
    (globalThis as Record<string, unknown>)[DOMAIN_CONFIG_KEY] = {
      allowedDomains: ["127.0.0.1"],
    };

    const res = await handleEvaluate(ctx(), {
      type: "evaluate",
      // If this fell through to `new Function`, the probe would be set.
      code: "globalThis.openCowork_secret_probe = 'executed'; return 1",
    });

    expect(res.success).toBe(false);
    expect(res.message).toContain("BLOCKED evaluate");
    expect(res.message).toContain("custom-tool substitution unavailable");
    // Critical: the unmodified LLM-authored code must never be executed.
    expect((globalThis as Record<string, unknown>).openCowork_secret_probe).toBeUndefined();
    // Restore any mock created in this scope.
    vi.restoreAllMocks();
  });
});
