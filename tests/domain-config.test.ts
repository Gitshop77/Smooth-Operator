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
  setDomainConfig,
  validateDomainConfig,
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

const enforce = (v = true): void => {
  (globalThis as Record<string, unknown>)[ENFORCED] = v;
};
const setCfg = (c: unknown): void => {
  (globalThis as Record<string, unknown>)[CONFIG] = c;
};

describe("getDomainConfig", () => {
  test("returns {} when no config global is set (default allow-all)", () => {
    expect(getDomainConfig()).toEqual({});
  });

  test("returns the configured object when the global is set", () => {
    const cfg: DomainConfig = { allowedDomains: ["example.com"] };
    setCfg(cfg);
    expect(getDomainConfig()).toBe(cfg);
  });

  test("returns {} when the global is set to a non-object", () => {
    setCfg(42);
    expect(getDomainConfig()).toEqual({});
  });
});

describe("isDomainPolicyEnforced / isDomainConfigMissingButEnforced", () => {
  test("enforced flag false (default) → not enforced", () => {
    expect(isDomainPolicyEnforced()).toBe(false);
    expect(isDomainConfigMissingButEnforced()).toBe(false);
  });

  test("enforced flag true + config present → not 'missing but enforced'", () => {
    enforce();
    setCfg({ allowedDomains: ["example.com"] });
    expect(isDomainPolicyEnforced()).toBe(true);
    expect(isDomainConfigMissingButEnforced()).toBe(false);
  });

  test("enforced flag true + config missing → missing-but-enforced", () => {
    enforce();
    expect(isDomainPolicyEnforced()).toBe(true);
    expect(isDomainConfigMissingButEnforced()).toBe(true);
  });
});

describe("checkUrlAllowedWithDomainConfig (fail-closed)", () => {
  test("enforced + config MISSING → blocks (fail closed)", () => {
    enforce();
    const result = checkUrlAllowedWithDomainConfig("https://evil.com");
    expect(result.allowed).toBe(false);
    expect(result.reason ?? "").toMatch(/fail closed/i);
  });

  test("throwing global accessor fails closed (blocked)", () => {
    enforce();
    Object.defineProperty(globalThis, CONFIG, {
      configurable: true,
      get() {
        throw new Error("hostile accessor");
      },
    });
    const result = checkUrlAllowedWithDomainConfig("https://evil.com");
    expect(result.allowed).toBe(false);
  });

  test("NOT enforced + config missing → allows (default allow-all preserved)", () => {
    const result = checkUrlAllowedWithDomainConfig("https://anything.com");
    expect(result.allowed).toBe(true);
  });

  test("NOT enforced + config present → delegates to checkUrlAllowed (allowlist)", () => {
    setCfg({ allowedDomains: ["example.com"] });
    expect(checkUrlAllowedWithDomainConfig("https://example.com").allowed).toBe(true);
    expect(checkUrlAllowedWithDomainConfig("https://evil.com").allowed).toBe(false);
  });

  test("enforced + config present → delegates to checkUrlAllowed (blocklist)", () => {
    enforce();
    setCfg({ blockedDomains: ["evil.com"] });
    expect(checkUrlAllowedWithDomainConfig("https://evil.com").allowed).toBe(false);
    expect(checkUrlAllowedWithDomainConfig("https://example.com").allowed).toBe(true);
  });

  test("scheme floor still applies even when not enforced", () => {
    const result = checkUrlAllowedWithDomainConfig("javascript:alert(1)");
    expect(result.allowed).toBe(false);
  });

  test("scheme floor (javascript:/data:/file:) still applies under enforced config", () => {
    // The enforced path delegates to checkUrlAllowed, which applies the scheme
    // floor. A regression dropping the floor under enforcement would open a
    // navigate-to-code-exec hole.
    enforce();
    setCfg({ allowedDomains: ["example.com"] });
    expect(checkUrlAllowedWithDomainConfig("javascript:alert(1)").allowed).toBe(false);
    expect(checkUrlAllowedWithDomainConfig("data:text/html,<script>").allowed).toBe(false);
    expect(checkUrlAllowedWithDomainConfig("file:///etc/passwd").allowed).toBe(false);
  });

  test("enforced=true + config present-but-empty {} delegates to allow-all (fail-open boundary)", () => {
    // A deliberately empty config ({}) is treated as PRESENT (not missing), so
    // it does NOT trigger the fail-closed path — it is allow-all by design.
    // This pins that boundary so a future regression cannot silently flip the
    // present-but-empty case to block (or vice versa).
    enforce();
    setCfg({});
    const result = checkUrlAllowedWithDomainConfig("https://anything.com");
    expect(result.allowed).toBe(true);
  });
});

describe("getDomainConfig shape handling", () => {
  test("returns {} (allow-all) for a malformed global shape", () => {
    setCfg({ allowedDomains: "example.com" });
    expect(getDomainConfig()).toEqual({});
    setCfg(42);
    expect(getDomainConfig()).toEqual({});
  });

  test("returns a frozen canonical object for a valid global", () => {
    const cfg: DomainConfig = { allowedDomains: ["example.com"] };
    setCfg(cfg);
    const got = getDomainConfig();
    expect(Object.isFrozen(got)).toBe(true);
    expect(Object.isFrozen(got.allowedDomains)).toBe(true);
  });
});

describe("validateDomainConfig shape checks", () => {
  test("rejects malformed shapes", () => {
    expect(validateDomainConfig(null)).toBeNull();
    expect(validateDomainConfig(undefined)).toBeNull();
    expect(validateDomainConfig(42)).toBeNull();
    expect(validateDomainConfig([])).toBeNull();
    expect(validateDomainConfig({ allowedDomains: "example.com" })).toBeNull();
    expect(validateDomainConfig({ allowedDomains: ["ok"], blockedDomains: 5 })).toBeNull();
    expect(validateDomainConfig({ allowedDomains: ["ok", 9] })).toBeNull();
  });

  test("accepts valid shapes", () => {
    expect(validateDomainConfig({})).not.toBeNull();
    expect(validateDomainConfig({ allowedDomains: ["a.com"] })).toEqual({ allowedDomains: ["a.com"] });
    expect(validateDomainConfig({ blockedDomains: ["b.com"] })).toEqual({ blockedDomains: ["b.com"] });
  });
});

describe("setDomainConfig retains last-known-good (never downgrades to allow-all)", () => {
  test("invalid config keeps the previously installed allowlist", () => {
    const good: DomainConfig = { allowedDomains: ["example.com"] };
    setDomainConfig(good, true);
    setDomainConfig({ allowedDomains: "example.com" } as unknown as DomainConfig, true);
    expect(getDomainConfig()).toEqual({ allowedDomains: ["example.com"] });
  });

  test("undefined config keeps the previously installed blocklist", () => {
    const good: DomainConfig = { blockedDomains: ["evil.com"] };
    setDomainConfig(good, true);
    setDomainConfig(undefined, true);
    expect(getDomainConfig()).toEqual({ blockedDomains: ["evil.com"] });
  });

  test("valid config updates the active policy", () => {
    setDomainConfig({ allowedDomains: ["a.com"] }, true);
    expect(checkUrlAllowedWithDomainConfig("https://a.com").allowed).toBe(true);
    expect(checkUrlAllowedWithDomainConfig("https://b.com").allowed).toBe(false);
  });
});
