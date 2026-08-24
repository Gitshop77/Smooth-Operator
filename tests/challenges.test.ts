import { describe, expect, it } from "vitest";

import { classifyChallenge } from "@/server/browser/challenges";

describe("challenge classification", () => {
  it("returns structured human-action evidence for common challenges", () => {
    const result = classifyChallenge({
      title: "Just a moment...",
      text: "Checking your browser before accessing the site",
      html: '<div class="cf-turnstile"></div>',
      frameSources: ["https://challenges.cloudflare.com/turnstile/v0/api.js"],
      visibleMarkers: ["DIV cf-turnstile"],
    });

    expect(result.detected).toBe(true);
    expect(result.humanActionRequired).toBe(true);
    expect(result.bypassAttempted).toBe(false);
    expect(result.matches.map((match) => match.kind)).toEqual(expect.arrayContaining(["cloudflare-js", "cloudflare-turnstile"]));
  });

  it("recognizes a rate limit from HTTP evidence", () => {
    const result = classifyChallenge({ status: 429 });
    expect(result.matches).toEqual([{ kind: "rate-limited", confidence: "high", indicators: ["http-status-429"] }]);
  });

  it("does not classify ordinary page content", () => {
    expect(classifyChallenge({ title: "Example", text: "A normal page with a form" })).toEqual({
      status: "absent",
      detected: false,
      matches: [],
      humanActionRequired: false,
      bypassAttempted: false,
    });
  });

  it("does not treat documentation that merely mentions a widget as an active challenge", () => {
    const result = classifyChallenge({ title: "CAPTCHA integration guide", text: "This article explains how reCAPTCHA works in a form." });
    expect(result.status).toBe("absent");
    expect(result.matches).toEqual([]);
  });

  it("does not latch on a hidden widget library alone", () => {
    expect(classifyChallenge({
      title: "Product page",
      text: "Welcome",
      html: '<script src="https://www.google.com/recaptcha/api.js"></script><iframe src="https://www.google.com/recaptcha/api2/anchor" style="display:none"></iframe>',
      frameSources: ["https://www.google.com/recaptcha/api2/anchor"],
    }).status).toBe("absent");
  });

  it("fails closed on a vendor-less human-verification page", () => {
    const result = classifyChallenge({ title: "Verification", text: "Please verify you are human to continue." });
    expect(result.status).toBe("present");
    expect(result.matches).toEqual([{ kind: "generic-challenge", confidence: "low", indicators: ["verify you are human", "please verify"] }]);
    expect(result.bypassAttempted).toBe(false);
  });

  it("fails closed on vendor-less automated-access wording", () => {
    const result = classifyChallenge({
      title: "Unusual traffic",
      text: "Our systems detected automated access. Access to this site has been denied.",
    });
    expect(result.matches).toEqual([{ kind: "generic-challenge", confidence: "low", indicators: ["unusual traffic", "automated access", "access to this site has been denied"] }]);
    expect(result.bypassAttempted).toBe(false);
  });

  it("requires corroboration for auth walls and rate limits", () => {
    expect(classifyChallenge({ title: "Access denied", text: "Please sign in to continue" }).status).toBe("absent");
    expect(classifyChallenge({ title: "Sign in to continue", html: '<input type="password">' }).matches.map((match) => match.kind)).toContain("auth-wall");
    expect(classifyChallenge({ title: "Too many requests", text: "Please slow down" }).status).toBe("absent");
    expect(classifyChallenge({ status: 503 }).matches).toEqual([]);
    expect(classifyChallenge({ status: 503, text: "Too many requests; please slow down." }).matches.map((match) => match.kind)).toContain("rate-limited");
  });

  it("bounds oversized challenge evidence before classification", () => {
    const result = classifyChallenge({
      title: "Verification",
      text: "Verify you are human",
      html: `<div class="cf-turnstile"></div>${"x".repeat(2_000_000)}`,
      frameSources: Array.from({ length: 500 }, () => "x".repeat(4_000)),
    });
    expect(result.matches.map((match) => match.kind)).toContain("cloudflare-turnstile");
  });
});
