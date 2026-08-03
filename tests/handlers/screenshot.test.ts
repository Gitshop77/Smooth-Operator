/**
 * `screenshot` handler filename normalization — the SW captures JPEG
 * (`Page.captureScreenshot` format:"jpeg"), so an explicitly-named screenshot
 * must be saved with a `.jpg` extension. A `report.png` / `report.pdf` name
 * would contain JPEG bytes under a misleading extension.
 */

import { describe, test, expect, vi, afterEach } from "vitest";
import { handleScreenshot } from "../../src/lib/agent/tools/handlers/screenshot";
import type { ActionContext } from "../../src/lib/agent/tools/handlers/types";
import type { BrowserState } from "../../src/lib/agent/types";
import { makeState } from "../helpers";

const ctx = {
  state: makeState() as BrowserState,
  beforeUrl: "https://example.com",
  beforeFingerprint: "fingerprint",
} as ActionContext;

function installExtensionMock(sendMessage: () => Promise<unknown>): void {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { id: "ext-id", sendMessage },
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
});

describe("handleScreenshot filename normalization", () => {
  test("forwards a bare name with a .jpg extension", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, filename: "report.jpg" }));
    installExtensionMock(sendMessage);
    const res = await handleScreenshot(ctx, { type: "screenshot", file_name: "report" });
    expect(sendMessage).toHaveBeenCalledWith({ type: "SCREENSHOT", fileName: "report.jpg" });
    expect(res.success).toBe(true);
  });

  test("replaces a misleading .png name with .jpg (JPEG bytes under .png)", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, filename: "report.jpg" }));
    installExtensionMock(sendMessage);
    const res = await handleScreenshot(ctx, { type: "screenshot", file_name: "report.png" });
    expect(sendMessage).toHaveBeenCalledWith({ type: "SCREENSHOT", fileName: "report.jpg" });
    expect(res.success).toBe(true);
  });

  test("replaces any other extension (e.g. .pdf) with .jpg", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, filename: "report.jpg" }));
    installExtensionMock(sendMessage);
    const res = await handleScreenshot(ctx, { type: "screenshot", file_name: "report.pdf" });
    expect(sendMessage).toHaveBeenCalledWith({ type: "SCREENSHOT", fileName: "report.jpg" });
    expect(res.success).toBe(true);
  });
});

describe("handleScreenshot SW error responses", () => {
  test("an explicit SW error surfaces in the failure message", async () => {
    const sendMessage = vi.fn(async () => ({ ok: false, error: "disk full" }));
    installExtensionMock(sendMessage);
    const res = await handleScreenshot(ctx, { type: "screenshot", file_name: "report" });
    expect(res.success).toBe(false);
    expect(res.message).toContain("disk full");
  });

  test("an invalid response shape is rejected, not trusted", async () => {
    const sendMessage = vi.fn(async () => ({ ok: "yes" })); // malformed payload
    installExtensionMock(sendMessage);
    const res = await handleScreenshot(ctx, { type: "screenshot", file_name: "report" });
    expect(res.success).toBe(false);
    expect(res.message).toContain("invalid response");
  });

  test("no response from the SW (undefined, timeout) fails instead of claiming success", async () => {
    // `chrome.runtime.sendMessage` resolves `undefined` when no listener is
    // present (or the timeout wins the race) — must be surfaced as a failure.
    const sendMessage = vi.fn(async () => undefined);
    installExtensionMock(sendMessage);
    const res = await handleScreenshot(ctx, { type: "screenshot", file_name: "report" });
    expect(res.success).toBe(false);
    expect(res.message).toContain("no response");
  });

  test("rejects path-traversal file names before forwarding to the SW", async () => {
    const sendMessage = vi.fn();
    installExtensionMock(sendMessage);
    const res = await handleScreenshot(ctx, { type: "screenshot", file_name: "../evil.jpg" });
    expect(res.success).toBe(false);
    expect(res.message).toContain("invalid file_name");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("fails honestly without an extension context (no chrome.runtime.id)", async () => {
    // No chrome mock installed: `isExtensionContext()` is false, and capture
    // is unavailable in that mode. The handler must return an honest failure
    // instead of claiming the screenshot was saved.
    const res = await handleScreenshot(ctx, { type: "screenshot", file_name: "report" });
    expect(res.success).toBe(false);
    expect(res.message).toContain("not supported");
  });
});
