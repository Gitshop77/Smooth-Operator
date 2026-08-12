/**
 * retention.ts — settings/import retention bounds: quota-safe caps applied
 * before persistence, never crashing, never persisting out-of-bounds values.
 */

import { describe, it, expect } from "vitest";
import {
  MAX_SETTING_ARRAY_LENGTH,
  MAX_SETTING_STRING_LENGTH,
  MAX_WEBHOOK_URL_LENGTH,
  applySettingsRetention,
  clampWebhookUrl,
} from "../src/lib/agent/retention";

describe("clampWebhookUrl", () => {
  it("passes short URLs through unchanged", () => {
    expect(clampWebhookUrl("https://example.com/hook")).toBe("https://example.com/hook");
  });

  it("clamps URLs longer than the cap", () => {
    const long = `https://example.com/hook?token=${"x".repeat(MAX_WEBHOOK_URL_LENGTH + 100)}`;
    const clamped = clampWebhookUrl(long);
    expect(clamped.length).toBe(MAX_WEBHOOK_URL_LENGTH);
    expect(clamped).toBe(long.slice(0, MAX_WEBHOOK_URL_LENGTH));
  });
});

describe("applySettingsRetention", () => {
  it("clamps the webhook URL and long strings", () => {
    const out = applySettingsRetention({
      webhookUrl: `https://e.com/${"x".repeat(MAX_WEBHOOK_URL_LENGTH + 10)}`,
      defaultTask: "t".repeat(MAX_SETTING_STRING_LENGTH + 5),
      maxSteps: 100,
    });
    expect((out.webhookUrl as string).length).toBe(MAX_WEBHOOK_URL_LENGTH);
    expect((out.defaultTask as string).length).toBe(MAX_SETTING_STRING_LENGTH);
    expect(out.maxSteps).toBe(100);
  });

  it("drops non-finite numbers instead of persisting NaN/Infinity", () => {
    const out = applySettingsRetention({ costCap: Number.NaN, maxSteps: Infinity, ok: 5 });
    expect(out).toEqual({ ok: 5 });
  });

  it("does not mutate the input object", () => {
    const input = { webhookUrl: `https://e.com/${"x".repeat(MAX_WEBHOOK_URL_LENGTH + 1)}` };
    const before = input.webhookUrl.length;
    applySettingsRetention(input);
    expect(input.webhookUrl.length).toBe(before);
  });

  it("honors a custom webhook key name", () => {
    const out = applySettingsRetention({ hook: "x".repeat(MAX_WEBHOOK_URL_LENGTH + 5) }, "hook");
    expect((out.hook as string).length).toBe(MAX_WEBHOOK_URL_LENGTH);
    // Without the custom key the same value is only capped by the generic string cap.
    const defaultKey = applySettingsRetention({ hook: "x".repeat(MAX_WEBHOOK_URL_LENGTH + 5) });
    expect((defaultKey.hook as string).length).toBe(MAX_WEBHOOK_URL_LENGTH + 5);
  });

  it("caps array-shaped settings (allowlists / blocked domains) before persist", () => {
    const out = applySettingsRetention({
      allowedDomains: Array.from({ length: MAX_SETTING_ARRAY_LENGTH + 50 }, (_, i) => `d${i}.com`),
      blockedDomains: ["a.com", "b.com"],
    });
    expect((out.allowedDomains as string[]).length).toBe(MAX_SETTING_ARRAY_LENGTH);
    expect((out.blockedDomains as string[]).length).toBe(2);
    // A short array is passed through untouched (same reference contract).
    const short = ["x.com"];
    expect(applySettingsRetention({ blockedDomains: short }).blockedDomains).toBe(short);
  });
});
