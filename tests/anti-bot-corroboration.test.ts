/**
 * Widget-challenge corroboration.
 *
 * A CAPTCHA widget alone is not proof of an interstitial: contact/checkout/
 * login pages legitimately embed Turnstile/hCaptcha/reCAPTCHA. A challenge
 * is only reported when the widget is corroborated by an interstitial
 * signal — a near-empty body (an interstitial is a shell) or the
 * `#challenge-running` marker Cloudflare injects during a real challenge.
 *
 * This complements tests/anti-bot.test.ts, which pins the authoritative
 * selector as the primary trigger (empty-body pages still classify).
 */

import { describe, test, expect, afterEach } from "vitest";
import { detectChallengeInPage } from "../src/lib/agent/anti-bot";

function longBody(): string {
  // A realistic widget-bearing content page: form fields and prose.
  return `
    <h1>Contact us</h1>
    <p>${"We'd love to hear from you. ".repeat(80)}</p>
    <form>
      <label>Name <input type="text"></label>
      <label>Email <input type="email"></label>
      <label>Message <textarea></textarea></label>
      ${"<div>More content to make this clearly a real page.</div>".repeat(20)}
    </form>
  `;
}

afterEach(() => {
  document.body.innerHTML = "";
  document.title = "";
});

describe("widget detection requires interstitial corroboration", () => {
  test("widget + short body → challenge (interstitial shell)", () => {
    document.body.innerHTML = '<div class="cf-turnstile"></div>';
    expect(detectChallengeInPage()?.kind).toBe("cloudflare-turnstile");
  });

  test("widget + long content-page body → null (false positive fixed)", () => {
    document.body.innerHTML = `<div class="cf-turnstile"></div>${longBody()}`;
    expect(detectChallengeInPage()).toBeNull();
  });

  test("widget + long body + #challenge-running → challenge", () => {
    document.body.innerHTML =
      `<div class="cf-turnstile"></div><div id="challenge-running"></div>${longBody()}`;
    expect(detectChallengeInPage()?.kind).toBe("cloudflare-turnstile");
  });

  test("hCaptcha and reCAPTCHA follow the same corroboration rule", () => {
    document.body.innerHTML = `<div class="h-captcha"></div>${longBody()}`;
    expect(detectChallengeInPage()).toBeNull();
    document.body.innerHTML = `<div class="h-captcha"></div>`;
    expect(detectChallengeInPage()?.kind).toBe("hcaptcha");

    document.body.innerHTML = `<div class="g-recaptcha"></div>${longBody()}`;
    expect(detectChallengeInPage()).toBeNull();
    document.body.innerHTML = `<div class="g-recaptcha"></div>`;
    expect(detectChallengeInPage()?.kind).toBe("recaptcha");
  });

  test("Cloudflare challenge SCRIPT is authoritative without corroboration", () => {
    // The cross-origin script src is the signal the module trusts by itself.
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    document.body.appendChild(s);
    document.body.insertAdjacentHTML("beforeend", longBody());
    expect(detectChallengeInPage()?.kind).toBe("cloudflare-js");
  });
});
