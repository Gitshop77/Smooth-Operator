/**
 * Download-capture tests (P5) — the SW-side download ring in
 * message-routing.ts: recording completed `chrome.downloads.onChanged` deltas,
 * sanitization, mime guessing, ring cap, and the `list_downloads` TAB_ACTION
 * response. The module is imported dynamically so its top-level listener
 * registration runs against the chrome stub.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

type OnMessage = (msg: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => boolean | undefined;
type OnDownloadsChanged = (delta: unknown) => void;

let onMessage: OnMessage | undefined;
let onDownloadsChanged: OnDownloadsChanged | undefined;

function installChromeStub() {
  const chrome = {
    runtime: {
      id: "extid",
      onMessage: { addListener: (cb: OnMessage) => { onMessage = cb; } },
    },
    downloads: {
      onChanged: { addListener: (cb: OnDownloadsChanged) => { onDownloadsChanged = cb; } },
    },
  };
  (globalThis as Record<string, unknown>).chrome = chrome;
}

// The module registers its listeners once at import time, so the stub must
// be installed ONCE before the first dynamic import (a per-test reinstall
// would orphan the captured callbacks). Tests reset the ring via the
// exported clearCapturedDownloads instead.
beforeAll(() => {
  installChromeStub();
});

beforeEach(async () => {
  const { clearCapturedDownloads } = await import("../src/extension/background/message-routing");
  clearCapturedDownloads();
});

afterAll(() => {
  delete (globalThis as Record<string, unknown>).chrome;
});

function completeDelta(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    state: { current: "complete", previous: "in_progress" },
    filename: { current: "report.pdf" },
    url: { current: "https://example.com/report.pdf" },
    mime: { current: "application/pdf" },
    fileSize: { current: 1234 },
    totalBytes: { current: 1234 },
    ...overrides,
  };
}

describe("download capture ring", () => {
  test("records a completed download with sanitized fields", async () => {
    const { recordDownload, getCapturedDownloads, clearCapturedDownloads } =
      await import("../src/extension/background/message-routing");
    clearCapturedDownloads();
    const rec = recordDownload(completeDelta() as never);
    expect(rec).not.toBeNull();
    const list = getCapturedDownloads();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      filename: "report.pdf",
      url: "https://example.com/report.pdf",
      mime: "application/pdf",
      sizeBytes: 1234,
    });
  });

  test("ignores non-complete transitions", async () => {
    const { recordDownload, getCapturedDownloads, clearCapturedDownloads } =
      await import("../src/extension/background/message-routing");
    clearCapturedDownloads();
    recordDownload(completeDelta({ state: { current: "in_progress", previous: "interrupted" } }) as never);
    expect(getCapturedDownloads()).toHaveLength(0);
  });

  test("ignores interrupted downloads", async () => {
    const { recordDownload, getCapturedDownloads, clearCapturedDownloads } =
      await import("../src/extension/background/message-routing");
    clearCapturedDownloads();
    recordDownload(completeDelta({ state: { current: "interrupted", previous: "in_progress" } }) as never);
    expect(getCapturedDownloads()).toHaveLength(0);
  });

  test("ignores zero-byte completes", async () => {
    const { recordDownload, getCapturedDownloads, clearCapturedDownloads } =
      await import("../src/extension/background/message-routing");
    clearCapturedDownloads();
    recordDownload(completeDelta({ fileSize: { current: 0 } }) as never);
    expect(getCapturedDownloads()).toHaveLength(0);
  });

  test("caps the ring at 20 records, dropping the oldest", async () => {
    const { recordDownload, getCapturedDownloads, clearCapturedDownloads } =
      await import("../src/extension/background/message-routing");
    clearCapturedDownloads();
    for (let i = 1; i <= 25; i++) {
      recordDownload(completeDelta({ id: i, filename: { current: `file-${i}.txt` } }) as never);
    }
    const list = getCapturedDownloads();
    expect(list).toHaveLength(20);
    expect(list[0].filename).toBe("file-6.txt");
    expect(list[19].filename).toBe("file-25.txt");
  });

  test("guesses the mime from the filename when mime is absent", async () => {
    const { recordDownload, getCapturedDownloads, clearCapturedDownloads } =
      await import("../src/extension/background/message-routing");
    clearCapturedDownloads();
    recordDownload(completeDelta({ mime: { current: undefined } }) as never);
    expect(getCapturedDownloads()[0].mime).toBe("application/octet-stream");

    clearCapturedDownloads();
    recordDownload(completeDelta({ mime: undefined, filename: { current: "photo.png" } }) as never);
    expect(getCapturedDownloads()[0].mime).toBe("image/png");
  });

  test("sanitizes a traversal filename before storing", async () => {
    const { recordDownload, getCapturedDownloads, clearCapturedDownloads } =
      await import("../src/extension/background/message-routing");
    clearCapturedDownloads();
    recordDownload(completeDelta({ filename: { current: "../../evil.sh" } }) as never);
    const stored = getCapturedDownloads()[0].filename;
    expect(stored).not.toContain("..");
    expect(stored.includes("/")).toBe(false);
  });

  test("clearCapturedDownloads empties the ring", async () => {
    const { recordDownload, getCapturedDownloads, clearCapturedDownloads } =
      await import("../src/extension/background/message-routing");
    clearCapturedDownloads();
    recordDownload(completeDelta() as never);
    clearCapturedDownloads();
    expect(getCapturedDownloads()).toHaveLength(0);
  });
});

describe("list_downloads TAB_ACTION", () => {
  test("responds from the capture ring without delegating to tab-manager", async () => {
    const { clearCapturedDownloads } = await import("../src/extension/background/message-routing");
    clearCapturedDownloads();
    onDownloadsChanged?.(completeDelta() as never);
    onDownloadsChanged?.(completeDelta({ id: 2, filename: { current: "b.png" } }) as never);

    const sendResponse = vi.fn();
    const handled = onMessage?.(
      { type: "TAB_ACTION", action: { type: "list_downloads" } },
      { id: "extid" },
      sendResponse,
    );
    // Returning false = "response already sent synchronously".
    expect(handled).toBe(false);
    expect(sendResponse).toHaveBeenCalledOnce();
    const response = sendResponse.mock.calls[0][0] as {
      ok: boolean;
      success?: boolean;
      downloads?: Array<{ filename: string }>;
    };
    expect(response.ok).toBe(true);
    expect(response.success).toBe(true);
    expect(response.downloads).toHaveLength(2);
    expect(response.downloads![1].filename).toBe("b.png");
  });

  test("reports an empty list when nothing was captured", async () => {
    const { clearCapturedDownloads } = await import("../src/extension/background/message-routing");
    clearCapturedDownloads();
    const sendResponse = vi.fn();
    onMessage?.({ type: "TAB_ACTION", action: { type: "list_downloads" } }, { id: "extid" }, sendResponse);
    const response = sendResponse.mock.calls[0][0] as { ok: boolean; downloads?: unknown[] };
    expect(response.ok).toBe(true);
    expect(response.downloads).toEqual([]);
  });
});
