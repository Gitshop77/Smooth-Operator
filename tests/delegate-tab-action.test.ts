/**
 * Direct coverage for the content-script `TAB_ACTION` delegation wrapper
 * (`delegateTabAction` in tab-management.ts, exercised through its public
 * handlers `handleSwitchTab` / `handleCloseTab`): the timeout race, the abort
 * race, zod payload validation, the `undefined`-response branch, and the
 * no-extension-context guard. The SW-side half of the contract
 * (`handleTabAction`) is covered separately by tab-manager-handle-tab-action.
 */

import { describe, test, expect, afterEach, vi } from "vitest";
import { handleSwitchTab, handleCloseTab } from "../src/lib/agent/tools/handlers/tab-management";
import type { ActionContext } from "../src/lib/agent/tools/handlers/types";
import { makeState } from "./helpers";

function installExtensionMock(sendMessage: (msg: unknown) => Promise<unknown>): void {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      id: "ext-id",
      sendMessage,
    },
  };
}

function ctx(signal?: AbortSignal): ActionContext {
  return {
    state: makeState(),
    beforeUrl: location.href,
    beforeFingerprint: "fingerprint",
    signal,
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
  vi.restoreAllMocks();
});

describe("delegateTabAction response handling", () => {
  test("forwards a successful SW response", async () => {
    installExtensionMock(vi.fn().mockResolvedValue({ ok: true, success: true, message: "Switched" }));
    const res = await handleSwitchTab(ctx(), { type: "switch_tab", tab_id: 2 });
    expect(res.success).toBe(true);
    expect(res.message).toBe("Switched");
  });

  test("defaults success/message when the SW omits them on ok", async () => {
    installExtensionMock(vi.fn().mockResolvedValue({ ok: true }));
    const res = await handleCloseTab(ctx(), { type: "close_tab", tab_id: 2 });
    expect(res.success).toBe(true);
    expect(res.message).toBe("close_tab ok");
  });

  test("fails with the SW-provided message when ok is false", async () => {
    installExtensionMock(
      vi.fn().mockResolvedValue({ ok: false, message: "cannot close the last tab" }),
    );
    const res = await handleCloseTab(ctx(), { type: "close_tab", tab_id: 2 });
    expect(res.success).toBe(false);
    expect(res.message).toContain("cannot close the last tab");
  });

  test("prefers message over error when ok is false", async () => {
    installExtensionMock(
      vi.fn().mockResolvedValue({ ok: false, message: "desc", error: "raw" }),
    );
    const res = await handleSwitchTab(ctx(), { type: "switch_tab", tab_id: 2 });
    expect(res.success).toBe(false);
    expect(res.message).toContain("desc");
    expect(res.message).not.toContain("raw");
  });

  test("reports no response when sendMessage resolves undefined (no listener)", async () => {
    installExtensionMock(vi.fn().mockResolvedValue(undefined));
    const res = await handleSwitchTab(ctx(), { type: "switch_tab", tab_id: 2 });
    expect(res.success).toBe(false);
    expect(res.message).toContain("no response from extension");
  });

  test("rejects a malformed SW payload via zod validation", async () => {
    // `ok` is required — a payload missing it must not be treated as a
    // success with defaulted fields.
    installExtensionMock(vi.fn().mockResolvedValue({ success: true }));
    const res = await handleSwitchTab(ctx(), { type: "switch_tab", tab_id: 2 });
    expect(res.success).toBe(false);
    expect(res.message).toContain("invalid response from extension");
  });

  test("honors an abort signal issued mid-call", async () => {
    installExtensionMock(vi.fn().mockImplementation(() => new Promise(() => {})));
    const controller = new AbortController();
    const resPromise = handleSwitchTab(ctx(controller.signal), { type: "switch_tab", tab_id: 2 });
    controller.abort();
    const res = await resPromise;
    expect(res.success).toBe(false);
    expect(res.message).toContain("Aborted");
  });

  test("aborts immediately when the signal is already aborted at call time", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, success: true, message: "ok" });
    installExtensionMock(sendMessage);
    const controller = new AbortController();
    controller.abort();
    const res = await handleSwitchTab(ctx(controller.signal), { type: "switch_tab", tab_id: 2 });
    // The race still starts the sendMessage call, but the already-rejected
    // abort promise wins it — the caller sees the abort, not the response.
    expect(res.success).toBe(false);
    expect(res.message).toContain("Aborted");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("times out instead of hanging when the SW never responds", async () => {
    vi.useFakeTimers();
    try {
      installExtensionMock(vi.fn().mockImplementation(() => new Promise(() => {})));
      const resPromise = handleSwitchTab(ctx(), { type: "switch_tab", tab_id: 2 });
      await vi.advanceTimersByTimeAsync(30_000 + 10);
      const res = await resPromise;
      expect(res.success).toBe(false);
      expect(res.message).toContain("no response from extension");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("delegateTabAction extension-context guard", () => {
  test("fails honestly without an extension context", async () => {
    const res = await handleSwitchTab(ctx(), { type: "switch_tab", tab_id: 2 });
    expect(res.success).toBe(false);
    expect(res.message).toContain("not supported in the current mode");
  });
});
