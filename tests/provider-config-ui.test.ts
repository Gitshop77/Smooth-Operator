/**
 * provider error text may embed an API key — `redactKeyLeak` must mask
 * the common key prefixes before the message is surfaced in the UI.
 *
 * `provider-config-ui.ts` runs DOM side-effects at import time (it wires up
 * event listeners on specific element ids), so we set up those elements before
 * the dynamic import.
 */

import { describe, test, expect, beforeAll } from "vitest";

function setupDom(): void {
  document.body.innerHTML = `
    <select id="provider"></select>
    <button id="testConnection"></button>
    <input id="model">
  `;
}

describe("redactKeyLeak", () => {
  let redactKeyLeak: (s: string) => string;

  beforeAll(async () => {
    setupDom();
    const mod = await import("../src/extension/options/provider-config-ui");
    redactKeyLeak = mod.redactKeyLeak;
  });

  test("masks a sk- key", () => {
    const redacted = redactKeyLeak("401: Invalid API key: sk-proj-abc123");
    expect(redacted).toContain("sk-[REDACTED]");
    expect(redacted).not.toContain("sk-proj-abc123");
  });

  test("masks a sk-ant- key", () => {
    const redacted = redactKeyLeak("error: sk-ant-api03-xyz789");
 // The implementation masks at the first '-', so `sk-ant-api03-xyz789`
 // collapses to `sk-[REDACTED]` — the random secret body is gone.
    expect(redacted).toContain("sk-[REDACTED]");
    expect(redacted).not.toContain("sk-ant-api03-xyz789");
    expect(redacted).not.toContain("api03-xyz789");
  });

  test("masks an AIza (Google) key", () => {
    const redacted = redactKeyLeak("AIzaSyABC123DEF");
    expect(redacted).toContain("AIza[REDACTED]");
    expect(redacted).not.toContain("AIzaSyABC123DEF");
  });

  test("masks a gsk_ (Groq) key", () => {
    const redacted = redactKeyLeak("gsk_abcdefghijklmnop");
    expect(redacted).toContain("gsk_[REDACTED]");
    expect(redacted).not.toContain("abcdefghijklmnop");
  });

  test("masks an xoxb- (Slack) key", () => {
    const redacted = redactKeyLeak("xoxb-1234567890-abcdef");
    expect(redacted).toContain("xoxb-[REDACTED]");
    expect(redacted).not.toContain("1234567890-abcdef");
  });

  test("masks a JWT (eyJ...) key", () => {
    const redacted = redactKeyLeak("token: eyJhbGciOiJIUzI1NiJ9.abc");
 // The regex stops at the JWT's first '.', so the leading `eyJh` segment is
 // masked; the full token must not survive.
    expect(redacted).toContain("eyJh[REDACTED]");
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  test("leaves non-key error text unchanged", () => {
    expect(redactKeyLeak("Network timeout after 30000ms")).toBe("Network timeout after 30000ms");
  });

  test("does not leak the key body even when embedded mid-string", () => {
    const redacted = redactKeyLeak("curl failed: sk-live-abcdefghijklmnopqr");
    expect(redacted).toContain("sk-[REDACTED]");
    expect(redacted).not.toContain("abcdefghijklmnopqr");
  });
});
