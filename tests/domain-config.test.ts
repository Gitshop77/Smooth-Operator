/**
 * domain-config fail-closed behavior.
 *
 * `getDomainConfig()` previously returned `{}` on ANY error or when the
 * `__openCoworkDomainConfig` global was unset, and `checkUrlAllowed({})`
 * returns `{allowed:true}` (empty config = allow-all). If a user configured
 * a list but the message ever lacked `domainConfig`, the policy was silently
 * bypassed (fail-open). The fix distinguishes "no policy configured" (allow-all
 * by design) from "policy expected but unavailable" (block) via the
 * `__openCoworkDomainConfigEnforced` flag, and `checkUrlAllowedWithDomainConfig`
 * fails CLOSED in the latter case.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  getDomainConfig,
  isDomainPolicyEnforced,
  isDomainConfigMissingButEnforced,
  checkUrlAllowedWithDomainConfig,
  type DomainConfig,
} from "../src/lib/agent/tools/helpers/domain-config";

const ENFORCED = "__openCoworkDomainConfigEnforced";
const CONFIG = "__openCoworkDomainConfig";

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[ENFORCED];
  delete (globalThis as Record<string, unknown>)[CONFIG];
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[ENFORCED];
  delete (globalThis as Record<string, unknown>)[CONFIG];
});

describe("getDomainConfig", () => {
  test("returns {} when no config global is set (default allow-all)", () => {
    expect(getDomainConfig()).toEqual({});
  });

  test("returns the configured object when the global is set", () => {
    const cfg: DomainConfig = { allowedDomains: ["example.com"] };
    (globalThis as Record<string, unknown>)[CONFIG] = cfg;
    expect(getDomainConfig()).toBe(cfg);
  });

  test("returns {} when the global is set to a non-object", () => {
    (globalThis as Record<string, unknown>)[CONFIG] = 42;
    expect(getDomainConfig()).toEqual({});
  });
});

describe("isDomainPolicyEnforced / isDomainConfigMissingButEnforced", () => {
  test("enforced flag false (default) → not enforced", () => {
    expect(isDomainPolicyEnforced()).toBe(false);
    expect(isDomainConfigMissingButEnforced()).toBe(false);
  });

  test("enforced flag true + config present → not 'missing but enforced'", () => {
    (globalThis as Record<string, unknown>)[ENFORCED] = true;
    (globalThis as Record<string, unknown>)[CONFIG] = { allowedDomains: ["example.com"] };
    expect(isDomainPolicyEnforced()).toBe(true);
    expect(isDomainConfigMissingButEnforced()).toBe(false);
  });

  test("enforced flag true + config missing → missing-but-enforced", () => {
    (globalThis as Record<string, unknown>)[ENFORCED] = true;
    expect(isDomainPolicyEnforced()).toBe(true);
    expect(isDomainConfigMissingButEnforced()).toBe(true);
  });
});

describe("checkUrlAllowedWithDomainConfig (fail-closed)", () => {
  test("enforced + config MISSING → blocks (fail closed)", () => {
    (globalThis as Record<string, unknown>)[ENFORCED] = true;
    const result = checkUrlAllowedWithDomainConfig("https://evil.com");
    expect(result.allowed).toBe(false);
    expect(result.reason ?? "").toMatch(/fail closed/i);
  });

  test("NOT enforced + config missing → allows (default allow-all preserved)", () => {
    const result = checkUrlAllowedWithDomainConfig("https://anything.com");
    expect(result.allowed).toBe(true);
  });

  test("NOT enforced + config present → delegates to checkUrlAllowed (allowlist)", () => {
    (globalThis as Record<string, unknown>)[CONFIG] = { allowedDomains: ["example.com"] };
    expect(checkUrlAllowedWithDomainConfig("https://example.com").allowed).toBe(true);
    expect(checkUrlAllowedWithDomainConfig("https://evil.com").allowed).toBe(false);
  });

  test("enforced + config present → delegates to checkUrlAllowed (blocklist)", () => {
    (globalThis as Record<string, unknown>)[ENFORCED] = true;
    (globalThis as Record<string, unknown>)[CONFIG] = { blockedDomains: ["evil.com"] };
    expect(checkUrlAllowedWithDomainConfig("https://evil.com").allowed).toBe(false);
    expect(checkUrlAllowedWithDomainConfig("https://example.com").allowed).toBe(true);
  });

  test("scheme floor still applies even when not enforced", () => {
    const result = checkUrlAllowedWithDomainConfig("javascript:alert(1)");
    expect(result.allowed).toBe(false);
  });
});
