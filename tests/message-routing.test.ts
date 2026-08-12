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

  test("extension longer than maxLen falls back to a truncated extension", async () => {
    // baseMax <= 0 branch: the whole `.ext` doesn't fit, so the result is a
    // plain slice of the extension (`ext.slice(0, maxLen)`).
    const { truncateFilename } = await import("../src/extension/background/message-routing");
    const out = truncateFilename("1234567890.abcde", 4);
    expect(out).toBe(".abc");
  });

  test("extension exactly maxLen chars keeps the extension and drops the base", async () => {
    const { truncateFilename } = await import("../src/extension/background/message-routing");
    const out = truncateFilename("1234567890.abcde", 6);
    expect(out).toBe(".abcde");
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

  test("preserves Unicode letters (\\p{L} path) in a normal filename", async () => {
    const { sanitizeDownloadName } = await import("../src/extension/background/message-routing");
    expect(sanitizeDownloadName("rapport-été-2026.pdf")).toBe("rapport-été-2026.pdf");
    expect(sanitizeDownloadName("季度报告.pdf")).toBe("季度报告.pdf");
  });

  test("keeps Unicode letters while still stripping path separators", async () => {
    const { sanitizeDownloadName } = await import("../src/extension/background/message-routing");
    const out = sanitizeDownloadName("../résumé-äöü.txt");
    expect(out).not.toContain("..");
    expect(out.includes("/")).toBe(false);
    expect(out).toContain("résumé-äöü.txt");
  });

  test("strips leading dots so the name is never a hidden file", async () => {
    const { sanitizeDownloadName } = await import("../src/extension/background/message-routing");
    expect(sanitizeDownloadName(".secret.txt")).toBe("secret.txt");
    expect(sanitizeDownloadName("...hidden")).toBe("hidden");
  });

  test("trims trailing dots and spaces", async () => {
    const { sanitizeDownloadName } = await import("../src/extension/background/message-routing");
    expect(sanitizeDownloadName("report.pdf.")).toBe("report.pdf");
    expect(sanitizeDownloadName("report. ")).toBe("report");
    // A double-dot run collapses to a single underscore (matches the existing
    // traversal-collapse contract: no `..` may survive).
    expect(sanitizeDownloadName("name..")).toBe("name_");
  });

  test("prefixes NTFS-reserved device names so the downloads API accepts them", async () => {
    const { sanitizeDownloadName } = await import("../src/extension/background/message-routing");
    expect(sanitizeDownloadName("CON")).toBe("_CON");
    expect(sanitizeDownloadName("con.txt")).toBe("_con.txt");
    expect(sanitizeDownloadName("COM1")).toBe("_COM1");
    expect(sanitizeDownloadName("LPT9.log")).toBe("_LPT9.log");
    expect(sanitizeDownloadName("NUL")).toBe("_NUL");
    // A non-reserved name with the same prefix is untouched.
    expect(sanitizeDownloadName("concord.pdf")).toBe("concord.pdf");
  });

  test("drops C0 control characters entirely and falls back to file for empty input", async () => {
    const { sanitizeDownloadName } = await import("../src/extension/background/message-routing");
    expect(sanitizeDownloadName("bad\u0000name.txt")).toBe("badname.txt");
    expect(sanitizeDownloadName("\u0001\u0002\u0003")).toBe("file");
    expect(sanitizeDownloadName("...")).toBe("file");
    expect(sanitizeDownloadName("   ")).toBe("file");
    expect(sanitizeDownloadName("")).toBe("file");
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

describe("log-ring message dispatch", () => {
  test("NETWORK_LOG / CONSOLE_LOG / CONSOLE_LOG_ENTRY route to the shared handler", async () => {
    vi.resetModules();
    const chromeStub = installChromeStub();
    await import("../src/extension/background/message-routing");
    const addListener = chromeStub.runtime.onMessage.addListener as ReturnType<typeof vi.fn>;
    const listener = addListener.mock.calls[0][0] as (
      msg: unknown,
      sender: { id?: string },
      respond: (r?: unknown) => void,
    ) => boolean | undefined;
    const respond = vi.fn();

    // Unknown types fall through (return false) so other listeners may run.
    expect(listener({ type: "UNKNOWN_TYPE" }, { id: "extid" }, respond)).toBe(false);

    // NETWORK_LOG is consumed asynchronously by the shared handler (true).
    expect(listener({ type: "NETWORK_LOG", verb: "enable" }, { id: "extid" }, respond)).toBe(true);

    // CONSOLE_LOG_ENTRY is a fire-and-forget push (false, no response).
    expect(
      listener({ type: "CONSOLE_LOG_ENTRY", entry: { type: "log", message: "x", timestamp: 1 } }, { id: "extid" }, respond),
    ).toBe(false);
    expect(respond).not.toHaveBeenCalled();
  });
});
