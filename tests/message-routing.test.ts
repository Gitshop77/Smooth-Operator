/**
 * message-routing.ts — pure helper coverage for truncateFilename and
 * isPrivilegedSender (the trust boundary for all privileged handlers).
 *
 * Both functions are imported dynamically so the module's top-level
 * `chrome.runtime.onMessage.addListener` registration runs against the stub.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

function installChromeStub() {
  const chrome = {
    runtime: {
      id: "extid",
      onMessage: { addListener: vi.fn() },
    },
  };
  (globalThis as Record<string, unknown>).chrome = chrome;
  return chrome;
}

let restore: () => void;

beforeEach(() => {
  installChromeStub();
  restore = () => {
    delete (globalThis as Record<string, unknown>).chrome;
  };
});

afterEach(() => {
  restore();
});

describe("truncateFilename", () => {
  test("preserves .pdf extension on a long name", async () => {
    const long = "a".repeat(200) + ".pdf";
    const out = (await import("../src/extension/background/message-routing")).truncateFilename(long, 120);
    expect(out.endsWith(".pdf")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(120);
  });

  test("preserves .jpeg extension on a long name", async () => {
    const long = "x".repeat(200) + ".jpeg";
    const out = (await import("../src/extension/background/message-routing")).truncateFilename(long, 120);
    expect(out.endsWith(".jpeg")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(120);
  });

  test("falls back to a plain slice when extensionless", async () => {
    const long = "a".repeat(200);
    const out = (await import("../src/extension/background/message-routing")).truncateFilename(long, 120);
    expect(out.length).toBe(120);
  });

  test("returns short names unchanged", async () => {
    const out = (await import("../src/extension/background/message-routing")).truncateFilename("report.pdf", 120);
    expect(out).toBe("report.pdf");
  });

  test("extensionless short name is returned unchanged", async () => {
    const out = (await import("../src/extension/background/message-routing")).truncateFilename("noext", 5);
    expect(out).toBe("noext");
  });
});

describe("sanitizeDownloadName", () => {
  test("strips forward-slash path separators", async () => {
    const { sanitizeDownloadName } = await import("../src/extension/background/message-routing");
    const out = sanitizeDownloadName("../../etc/passwd");
    expect(out.includes("/")).toBe(false);
    expect(out).not.toContain("..");
  });

  test("strips backslash path separators", async () => {
    const { sanitizeDownloadName } = await import("../src/extension/background/message-routing");
    const out = sanitizeDownloadName("..\\..\\windows\\system32\\evil.exe");
    expect(out.includes("\\")).toBe(false);
    expect(out).not.toContain("..");
  });

  test("collapses runs of two-or-more dots", async () => {
    const { sanitizeDownloadName } = await import("../src/extension/background/message-routing");
    const out = sanitizeDownloadName("report..pdf");
    expect(out).not.toContain("..");
  });

  test("preserves a single-dot extension on a normal name", async () => {
    const { sanitizeDownloadName } = await import("../src/extension/background/message-routing");
    expect(sanitizeDownloadName("report.pdf")).toBe("report.pdf");
  });

  test("preserves the extension when truncating a long traversal name", async () => {
    const { sanitizeDownloadName } = await import("../src/extension/background/message-routing");
    const out = sanitizeDownloadName("../" + "a".repeat(300) + ".jpg");
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith(".jpg")).toBe(true);
    expect(out).not.toContain("..");
    expect(out.includes("/")).toBe(false);
  });
});

describe("isPrivilegedSender", () => {
  test("rejects a foreign sender id", async () => {
    const { isPrivilegedSender } = await import("../src/extension/background/message-routing");
    expect(isPrivilegedSender({ id: "other" } as chrome.runtime.MessageSender)).toBe(false);
  });

  test("accepts a chrome-extension:// URL with our id", async () => {
    const { isPrivilegedSender } = await import("../src/extension/background/message-routing");
    expect(
      isPrivilegedSender({
        id: "extid",
        url: "chrome-extension://extid/panel.html",
      } as chrome.runtime.MessageSender),
    ).toBe(true);
  });

  test("accepts a content-script sender (tab set)", async () => {
    const { isPrivilegedSender } = await import("../src/extension/background/message-routing");
    expect(
      isPrivilegedSender({ id: "extid", tab: { id: 1 } } as chrome.runtime.MessageSender),
    ).toBe(true);
  });

  test("rejects a first-party context with neither tab nor extension url", async () => {
    const { isPrivilegedSender } = await import("../src/extension/background/message-routing");
    expect(isPrivilegedSender({ id: "extid" } as chrome.runtime.MessageSender)).toBe(false);
  });

  test("rejects a foreign sender id regardless of url", async () => {
    const { isPrivilegedSender } = await import("../src/extension/background/message-routing");
    expect(
      isPrivilegedSender({
        id: "evil",
        url: "https://evil.com",
      } as chrome.runtime.MessageSender),
    ).toBe(false);
  });
});
