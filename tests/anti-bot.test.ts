/**
 * anti-bot.ts — spoofing-guard regression tests.
 *
 * The hardened challenge classifier deliberately refuses to trust
 * attacker-settable page content: a title alone is never sufficient (it must be
 * corroborated by an authoritative Cloudflare selector or the challenge script),
 * a block page needs the CF error selector OR a title+body AND-match, and
 * content-only block/rate-limit heuristics are refused entirely. These tests
 * lock in that corroboration so a future edit that re-weakens the guard (e.g.
 * accepting title-only "just a moment...") fails CI.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  detectChallengeInPage,
  isChallengeKind,
  parseChallengeResult,
  detectChallengeResult,
  waitForChallengeResolution,
} from "../src/lib/agent/anti-bot";

function resetDom(): void {
  document.title = "";
  document.head.innerHTML = "";
  document.body.innerHTML = "";
}

afterEach(resetDom);

describe("detectChallengeInPage — Cloudflare JS corroboration", () => {
  test("title 'just a moment...' alone (no selector, no script) → null", () => {
    document.title = "Just a moment...";
    expect(detectChallengeInPage()).toBeNull();
  });

  test("title 'checking your browser' alone → null", () => {
    document.title = "Checking your browser before accessing";
    expect(detectChallengeInPage()).toBeNull();
  });

  test("title + challenges.cloudflare.com script → cloudflare-js", () => {
    document.title = "Just a moment...";
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    document.head.appendChild(s);
    expect(detectChallengeInPage()).toEqual({
      kind: "cloudflare-js",
      message: "Cloudflare JS challenge",
    });
  });

  test("authoritative CF JS script tag alone (no title) → cloudflare-js", () => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/scripts/jsd/turnstile_0/flash/main.js";
    document.head.appendChild(s);
    expect(detectChallengeInPage()).toEqual({
      kind: "cloudflare-js",
      message: "Cloudflare JS challenge",
    });
  });
});

describe("detectChallengeInPage — block page AND-corroboration", () => {
  test("title 'attention required' + body 'blocked' (no .cf-error-details) → cloudflare-block via AND", () => {
    document.title = "Attention Required! | Cloudflare";
    document.body.textContent = "Sorry, you have been blocked";
    expect(detectChallengeInPage()).toEqual({
      kind: "cloudflare-block",
      message: "Cloudflare block page",
    });
  });

  test("title 'attention required' WITHOUT body 'blocked' → null (title alone insufficient)", () => {
    document.title = "Attention Required! | Cloudflare";
    document.body.textContent = "welcome to the site";
    expect(detectChallengeInPage()).toBeNull();
  });

  test("body 'blocked' WITHOUT the attention-required title → null (body alone insufficient)", () => {
    document.title = "My Blog";
    document.body.textContent = "this content is blocked for members";
    expect(detectChallengeInPage()).toBeNull();
  });

  test("title 'attention required' + body 'blocked' → cloudflare-block via AND-corroboration", () => {
    // The source removed .cf-error-details as a standalone trigger (attacker-settable).
    // The current detection requires title "attention required" AND body "blocked".
    document.title = "Attention Required! | Cloudflare";
    document.body.innerHTML = '<div class="cf-error-details"></div><p>Sorry, you have been blocked</p>';
    expect(detectChallengeInPage()).toEqual({
      kind: "cloudflare-block",
      message: "Cloudflare block page",
    });
  });
});

describe("detectChallengeInPage — widget challenges require the authoritative selector", () => {
  test("Turnstile widget → cloudflare-turnstile", () => {
    document.body.innerHTML = '<div class="cf-turnstile"></div>';
    expect(detectChallengeInPage()?.kind).toBe("cloudflare-turnstile");
  });

  test("hCaptcha widget → hcaptcha", () => {
    document.body.innerHTML = '<div class="h-captcha"></div>';
    expect(detectChallengeInPage()?.kind).toBe("hcaptcha");
  });

  test("reCAPTCHA widget → recaptcha", () => {
    document.body.innerHTML = '<div class="g-recaptcha"></div>';
    expect(detectChallengeInPage()?.kind).toBe("recaptcha");
  });

  test("plain page with no challenge markers → null", () => {
    document.title = "Example Domain";
    document.body.textContent = "This domain is for use in examples.";
    expect(detectChallengeInPage()).toBeNull();
  });

  test("content-only 'rate limited' text is never derived from the page → null", () => {
    document.title = "429 Too Many Requests";
    document.body.textContent = "You are being rate limited.";
    expect(detectChallengeInPage()).toBeNull();
  });
});

describe("parseChallengeResult — trust-boundary validation", () => {
  test("valid kind + message passes through", () => {
    expect(parseChallengeResult({ kind: "cloudflare-js", message: "x" })).toEqual({
      kind: "cloudflare-js",
      message: "x",
    });
    expect(parseChallengeResult({ kind: "rate-limited", message: "y" })).toEqual({
      kind: "rate-limited",
      message: "y",
    });
  });

  test("unknown kind string → null (rejected at the trust boundary)", () => {
    expect(parseChallengeResult({ kind: "totally-made-up", message: "x" })).toBeNull();
  });

  test("null / non-object / missing fields → null", () => {
    expect(parseChallengeResult(null)).toBeNull();
    expect(parseChallengeResult("nope")).toBeNull();
    expect(parseChallengeResult({ kind: "cloudflare-js" })).toBeNull();
    expect(parseChallengeResult({ message: "x" })).toBeNull();
    expect(parseChallengeResult({ kind: 5, message: "x" })).toBeNull();
    expect(parseChallengeResult({ kind: "hcaptcha", message: 5 })).toBeNull();
  });

  test("auth-wall kind parses (positive — allowlisted challenge kind)", () => {
    expect(parseChallengeResult({ kind: "auth-wall", message: "login required" })).toEqual({
      kind: "auth-wall",
      message: "login required",
    });
  });
});

describe("isChallengeKind — allowlist trust boundary", () => {
  test("accepts every allowlisted kind (incl. auth-wall)", () => {
    const allowlisted = [
      "cloudflare-js",
      "cloudflare-block",
      "cloudflare-turnstile",
      "hcaptcha",
      "recaptcha",
      "blocked",
      "rate-limited",
      "auth-wall",
    ];
    for (const kind of allowlisted) {
      expect(isChallengeKind(kind)).toBe(true);
    }
  });

  test("rejects unknown / non-string values", () => {
    expect(isChallengeKind("totally-made-up")).toBe(false);
    expect(isChallengeKind("CLOUDFLARE-JS")).toBe(false);
    expect(isChallengeKind("")).toBe(false);
    expect(isChallengeKind(42)).toBe(false);
    expect(isChallengeKind(null)).toBe(false);
    expect(isChallengeKind({ kind: "hcaptcha" })).toBe(false);
  });
});

// ─── chrome.scripting mocks (folded in from the former tests/agent/anti-bot.test.ts) ───

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

describe("detectChallengeResult — tab injection outcomes", () => {
  test("successful challenge result → status:'challenge' with info", async () => {
    setExecuteScript(async () => [
      { result: { kind: "cloudflare-js", message: "cf" } },
    ]);
    const out = await detectChallengeResult(1);
    expect(out.status).toBe("challenge");
    if (out.status === "challenge") {
      expect(out.info).toEqual({ kind: "cloudflare-js", message: "cf" });
    }
  });

  test("auth-wall challenge result → status:'challenge' (positive path)", async () => {
    setExecuteScript(async () => [
      { result: { kind: "auth-wall", message: "login required" } },
    ]);
    const out = await detectChallengeResult(1);
    expect(out.status).toBe("challenge");
    if (out.status === "challenge") {
      expect(out.info).toEqual({ kind: "auth-wall", message: "login required" });
    }
  });

  test("no challenge found → status:'no-challenge'", async () => {
    setExecuteScript(async () => [{ result: null }]);
    const out = await detectChallengeResult(2);
    expect(out.status).toBe("no-challenge");
  });

  test("injection failure → status:'error' (NOT 'no-challenge' — fail-closed)", async () => {
    setExecuteScript(async () => {
      throw new Error("injection failed");
    });
    const out = await detectChallengeResult(3);
    expect(out.status).toBe("error");
  });
});

describe("waitForChallengeResolution — conservative on detection failure", () => {
  test("initial no-challenge → resolved immediately", async () => {
    setExecuteScript(async () => [{ result: null }]);
    const out = await waitForChallengeResolution(1, { timeoutMs: 1000, pollMs: 250 });
    expect(out.resolved).toBe(true);
    expect(out.challenge).toBeNull();
  });

  test("initial detection error → unresolved (never 'resolved' on failure)", async () => {
    setExecuteScript(async () => {
      throw new Error("injection failed");
    });
    const out = await waitForChallengeResolution(1, { timeoutMs: 1000, pollMs: 250 });
    expect(out.resolved).toBe(false);
    expect(out.challenge).toBeNull();
  });
});

// ─── waitForChallengeResolution — poll loop, deadline, and clamping (fake timers) ───
//
// These pin the polling contract: the challenge clears on a later poll, a
// persistent challenge is reported unresolved WITH its info at the deadline,
// detection errors mid-poll are never treated as "resolved", and the opts are
// clamped to timeoutMs [500, 120000] / pollMs [250, 5000].

describe("waitForChallengeResolution — poll loop and deadline (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("challenge clears on a later poll → resolved", async () => {
    const script = vi
      .fn()
      .mockResolvedValueOnce([{ result: { kind: "cloudflare-js", message: "cf" } }])
      .mockResolvedValue([{ result: null }]);
    setExecuteScript(script);
    const p = waitForChallengeResolution(1, { timeoutMs: 5000, pollMs: 250 });
    await vi.advanceTimersByTimeAsync(0); // initial detect settles
    await vi.advanceTimersByTimeAsync(249);
    expect(script).toHaveBeenCalledTimes(1); // no poll fired yet
    await vi.advanceTimersByTimeAsync(1); // poll at t=250: challenge cleared
    await expect(p).resolves.toEqual({ resolved: true, challenge: null });
    // 1 initial + 2 for the clearing detect (challenge scan + auth-wall scan).
    expect(script).toHaveBeenCalledTimes(3);
  });

  test("challenge persists past the deadline → unresolved with the challenge info", async () => {
    const script = vi.fn().mockResolvedValue([{ result: { kind: "cloudflare-js", message: "cf" } }]);
    setExecuteScript(script);
    const p = waitForChallengeResolution(1, { timeoutMs: 750, pollMs: 250 });
    await vi.advanceTimersByTimeAsync(0);
    // deadline at t=750 → loop polls at 250/500/750, then one final check.
    await vi.advanceTimersByTimeAsync(750);
    await expect(p).resolves.toEqual({
      resolved: false,
      challenge: { kind: "cloudflare-js", message: "cf" },
    });
    expect(script).toHaveBeenCalledTimes(5);
  });

  test("a detection error mid-poll is not treated as resolved — keeps waiting", async () => {
    const script = vi
      .fn()
      .mockResolvedValueOnce([{ result: { kind: "cloudflare-js", message: "cf" } }])
      .mockRejectedValueOnce(new Error("injection failed"))
      .mockResolvedValue([{ result: null }]);
    setExecuteScript(script);
    const p = waitForChallengeResolution(1, { timeoutMs: 5000, pollMs: 250 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500); // poll 1 errors, poll 2 clears
    await expect(p).resolves.toEqual({ resolved: true, challenge: null });
    // 1 initial + 1 error + 2 for the clearing detect (challenge + auth-wall).
    expect(script).toHaveBeenCalledTimes(4);
  });

  test("persistent detection errors past the deadline → unresolved with null challenge", async () => {
    const script = vi
      .fn()
      .mockResolvedValueOnce([{ result: { kind: "cloudflare-js", message: "cf" } }])
      .mockRejectedValue(new Error("injection failed"));
    setExecuteScript(script);
    const p = waitForChallengeResolution(1, { timeoutMs: 500, pollMs: 250 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    // Deadline hit; the final check errors too, so the challenge is null.
    await expect(p).resolves.toEqual({ resolved: false, challenge: null });
    expect(script).toHaveBeenCalledTimes(4);
  });

  test("timeoutMs is clamped to a minimum of 500", async () => {
    const script = vi.fn().mockResolvedValue([{ result: { kind: "cloudflare-js", message: "cf" } }]);
    setExecuteScript(script);
    const p = waitForChallengeResolution(1, { timeoutMs: 1, pollMs: 250 });
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(250);
    // Unclamped (deadline=1) would have settled here; the clamped 500ms deadline has not.
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    await p;
    expect(settled).toBe(true);
  });

  test("timeoutMs is clamped to a maximum of 120000", async () => {
    const script = vi.fn().mockResolvedValue([{ result: { kind: "cloudflare-js", message: "cf" } }]);
    setExecuteScript(script);
    const p = waitForChallengeResolution(1, { timeoutMs: 999999, pollMs: 250 });
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    // The loop exits exactly at the clamped 120s deadline; an unclamped
    // 999999ms deadline would still be polling at this point.
    await vi.advanceTimersByTimeAsync(120000);
    await p;
    expect(settled).toBe(true);
  });

  test("pollMs is clamped to a minimum of 250", async () => {
    const script = vi
      .fn()
      .mockResolvedValueOnce([{ result: { kind: "cloudflare-js", message: "cf" } }])
      .mockResolvedValue([{ result: null }]);
    setExecuteScript(script);
    const p = waitForChallengeResolution(1, { timeoutMs: 5000, pollMs: 1 });
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(script).toHaveBeenCalledTimes(1); // clamped 250ms poll not fired yet
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toBe(true);
    // 1 initial + 2 for the clearing detect (challenge + auth-wall).
    expect(script).toHaveBeenCalledTimes(3);
  });

  test("pollMs is clamped to a maximum of 5000", async () => {
    const script = vi
      .fn()
      .mockResolvedValueOnce([{ result: { kind: "cloudflare-js", message: "cf" } }])
      .mockResolvedValue([{ result: null }]);
    setExecuteScript(script);
    const p = waitForChallengeResolution(1, { timeoutMs: 20000, pollMs: 999999 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4999);
    expect(script).toHaveBeenCalledTimes(1); // clamped 5000ms poll not fired yet
    await vi.advanceTimersByTimeAsync(1);
    await p;
    // 1 initial + 2 for the clearing detect (challenge + auth-wall).
    expect(script).toHaveBeenCalledTimes(3);
  });
});
