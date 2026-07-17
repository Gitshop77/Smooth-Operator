import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isChallengeKind,
  parseChallengeResult,
  detectChallengeResult,
  waitForChallengeResolution,
} from "@/lib/agent/anti-bot";

describe("isChallengeKind", () => {
  it("accepts allowlisted kinds", () => {
    for (const k of [
      "cloudflare-js",
      "cloudflare-block",
      "cloudflare-turnstile",
      "hcaptcha",
      "recaptcha",
      "blocked",
      "rate-limited",
    ]) {
      expect(isChallengeKind(k)).toBe(true);
    }
  });

  it("rejects unknown string values", () => {
    expect(isChallengeKind("evil")).toBe(false);
    expect(isChallengeKind("CLOUDFLARE-JS")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isChallengeKind(42)).toBe(false);
    expect(isChallengeKind(null)).toBe(false);
    expect(isChallengeKind({})).toBe(false);
  });
});

describe("parseChallengeResult", () => {
  it("returns null for null", () => {
    expect(parseChallengeResult(null)).toBeNull();
  });

  it("returns null when kind is missing", () => {
    expect(parseChallengeResult({ message: "x" })).toBeNull();
  });

  it("returns null when kind is a non-string", () => {
    expect(parseChallengeResult({ kind: 1, message: "x" })).toBeNull();
  });

  it("returns null when message is a non-string", () => {
    expect(parseChallengeResult({ kind: "hcaptcha", message: 5 })).toBeNull();
  });

  it("returns null for an unknown kind", () => {
    expect(parseChallengeResult({ kind: "evil", message: "x" })).toBeNull();
  });

  it("returns null for a non-object", () => {
    expect(parseChallengeResult("cloudflare-js")).toBeNull();
  });

  it("parses a valid cloudflare-js shape", () => {
    const info = parseChallengeResult({ kind: "cloudflare-js", message: "cf" });
    expect(info).toEqual({ kind: "cloudflare-js", message: "cf" });
  });

  it("parses a valid hcaptcha shape", () => {
    const info = parseChallengeResult({ kind: "hcaptcha", message: "cap" });
    expect(info).toEqual({ kind: "hcaptcha", message: "cap" });
  });
});

describe("detectChallengeResult", () => {
  let prevChrome: unknown;

  beforeEach(() => {
    prevChrome = (globalThis as { chrome?: unknown }).chrome;
  });

  afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = prevChrome;
  });

  const setExecuteScript = (impl: (...args: unknown[]) => Promise<unknown>) => {
    (globalThis as { chrome?: unknown }).chrome = {
      scripting: { executeScript: impl },
    };
  };

  it("maps a successful challenge result to status:'challenge'", async () => {
    setExecuteScript(async () => [
      { result: { kind: "cloudflare-js", message: "cf" } },
    ]);
    const out = await detectChallengeResult(1);
    expect(out.status).toBe("challenge");
  });

  it("maps a no-challenge result to status:'no-challenge'", async () => {
    setExecuteScript(async () => [{ result: null }]);
    const out = await detectChallengeResult(2);
    expect(out.status).toBe("no-challenge");
  });

  it("maps an injection failure to status:'error' (fail-closed)", async () => {
    setExecuteScript(async () => {
      throw new Error("injection failed");
    });
    const out = await detectChallengeResult(3);
    expect(out.status).toBe("error");
  });
});

describe("waitForChallengeResolution", () => {
  let prevChrome: unknown;

  beforeEach(() => {
    prevChrome = (globalThis as { chrome?: unknown }).chrome;
  });

  afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = prevChrome;
  });

  const setExecuteScript = (impl: (...args: unknown[]) => Promise<unknown>) => {
    (globalThis as { chrome?: unknown }).chrome = {
      scripting: { executeScript: impl },
    };
  };

  it("treats an initial no-challenge as resolved", async () => {
    setExecuteScript(async () => [{ result: null }]);
    const result = await waitForChallengeResolution(1, {
      timeoutMs: 1000,
      pollMs: 250,
    });
    expect(result.resolved).toBe(true);
    expect(result.challenge).toBeNull();
  });

  it("treats an initial error as unresolved (fail-closed)", async () => {
    setExecuteScript(async () => {
      throw new Error("injection failed");
    });
    const result = await waitForChallengeResolution(1, {
      timeoutMs: 1000,
      pollMs: 250,
    });
    expect(result.resolved).toBe(false);
    expect(result.challenge).toBeNull();
  });
});
