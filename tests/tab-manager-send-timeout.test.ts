/**
 * tab-manager.ts — `extractStateFromTab` / `executeActionsInTab` must not hang
 * forever when the content script is unresponsive. Both helpers now race the
 * `chrome.tabs.sendMessage` round-trip against a bounded timeout, so a wedged
 * content script makes the step reject ("content script did not respond")
 * instead of deadlocking the orchestrator. These tests pin that bounded-failure
 * behavior and that a responsive script still resolves.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

import {
  extractStateFromTab,
  executeActionsInTab,
} from "../src/extension/background/tab-manager";
import {
  beginRunController,
  resetRunControllerForTests,
} from "../src/extension/background/run-controller";

let chromeMock: {
  tabs: {
    sendMessage: ReturnType<typeof vi.fn>;
  };
};

function installChrome(): void {
  const sendMessage = vi.fn((_tabId: number, msg: { type?: string }) => {
    if (msg?.type === "PING") return Promise.resolve({ ok: true });
    return Promise.resolve({});
  });
  chromeMock = {
    tabs: { sendMessage },
  };
  (globalThis as Record<string, unknown>).chrome = chromeMock;
}

const TABS = [
  { id: 1, label: "0001", url: "https://example.com", title: "Example", active: true },
] as never;

beforeEach(() => {
  installChrome();
  resetRunControllerForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).chrome;
  vi.clearAllMocks();
  resetRunControllerForTests();
});

describe("content-script sendMessage timeout", () => {
  test("extractStateFromTab rejects (not hangs) when the content script never responds", async () => {
    chromeMock.tabs.sendMessage.mockImplementation((_tabId: number, msg: { type?: string }) => {
      if (msg?.type === "PING") return Promise.resolve({ ok: true });
      // EXTRACT_STATE never settles — simulates a wedged content script.
      return new Promise<never>(() => {});
    });

    const p = extractStateFromTab(1, TABS, false);
    // Attach a handler synchronously so the rejection during the timer advance
    // is never reported as unhandled; we assert on the captured error below.
    let caught: unknown;
    p.catch((e) => {
      caught = e;
    });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toMatch(/content script did not respond/);
  });

  test("executeActionsInTab rejects (not hangs) when the content script never responds", async () => {
    chromeMock.tabs.sendMessage.mockImplementation((_tabId: number, msg: { type?: string }) => {
      if (msg?.type === "PING") return Promise.resolve({ ok: true });
      return new Promise<never>(() => {});
    });

    const p = executeActionsInTab(1, []);
    let caught: unknown;
    p.catch((e) => {
      caught = e;
    });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toMatch(/content script did not respond/);
  });

  test("extractStateFromTab resolves when the content script responds", async () => {
    chromeMock.tabs.sendMessage.mockImplementation((_tabId: number, msg: { type?: string }) => {
      if (msg?.type === "PING") return Promise.resolve({ ok: true });
      if (msg?.type === "EXTRACT_STATE") {
        return Promise.resolve({ ok: true, state: { url: "https://example.com" } });
      }
      return Promise.resolve({});
    });

    const state = await extractStateFromTab(1, TABS, false);
    expect(state).toMatchObject({ url: "https://example.com" });
  });

  test("executeActionsInTab resolves when the content script responds", async () => {
    chromeMock.tabs.sendMessage.mockImplementation((_tabId: number, msg: { type?: string }) => {
      if (msg?.type === "PING") return Promise.resolve({ ok: true });
      if (msg?.type === "EXECUTE_ACTIONS") {
        return Promise.resolve({ ok: true, results: [] });
      }
      return Promise.resolve({});
    });

    const results = await executeActionsInTab(1, []);
    expect(results).toEqual([]);
  });

  test("executeActionsInTab forwards the agent mode so loader steps are gated", async () => {
    let sent: { type?: string; agentMode?: unknown } | undefined;
    chromeMock.tabs.sendMessage.mockImplementation((_tabId: number, msg: { type?: string }) => {
      sent = msg as { type?: string; agentMode?: unknown };
      if (msg?.type === "PING") return Promise.resolve({ ok: true });
      if (msg?.type === "EXECUTE_ACTIONS") {
        return Promise.resolve({ ok: true, results: [] });
      }
      return Promise.resolve({});
    });

    await executeActionsInTab(1, [], "restricted");
    expect(sent?.agentMode).toBe("restricted");

    await executeActionsInTab(1, []);
    expect(sent?.agentMode).toBeUndefined();
  });

  test("executeActionsInTab rejects an invalidated run token before sending a batch", async () => {
    const controller = beginRunController({
      runId: "run-a", task: "task", maxSteps: 1, mode: "standard",
    });
    controller.markRunning();
    const token = controller.dispatchToken;
    controller.requestCancellation();

    await expect(executeActionsInTab(1, [], undefined, { token })).rejects.toThrow(
      "BLOCKED: stale or cancelled action dispatch",
    );
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
  });

  test("executeActionsInTab aborts a pending content-script response", async () => {
    chromeMock.tabs.sendMessage.mockImplementation((_tabId: number, msg: { type?: string }) => {
      if (msg?.type === "PING") return Promise.resolve({ ok: true });
      return new Promise<never>(() => {});
    });
    const controller = new AbortController();
    const pending = executeActionsInTab(1, [], undefined, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("extractStateFromTab aborts a pending observation response", async () => {
    chromeMock.tabs.sendMessage.mockImplementation((_tabId: number, msg: { type?: string }) => {
      if (msg?.type === "PING") return Promise.resolve({ ok: true });
      return new Promise<never>(() => {});
    });
    const controller = new AbortController();
    const pending = extractStateFromTab(1, TABS, false, controller.signal);
    controller.abort(new DOMException("Stop requested", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
