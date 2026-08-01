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
