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
import { describe, test, expect, afterEach } from "vitest";
import {
  detectChallengeInPage,
  parseChallengeResult,
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
  });
});
