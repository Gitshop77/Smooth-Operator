import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  beginRunController,
  getCurrentRunController,
  resetRunControllerForTests,
} from "../src/extension/background/run-controller";
import { resetRunStateStoreForTests } from "../src/extension/background/state-store";

const sender = { id: "extid", tab: { id: 7 } } as chrome.runtime.MessageSender;

beforeEach(() => {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { id: "extid" },
    debugger: { attach: vi.fn(), sendCommand: vi.fn(), detach: vi.fn() },
    downloads: { download: vi.fn() },
    tabs: { create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    storage: {
      session: {
        get: vi.fn().mockResolvedValue({
          open_cowork_run_state: {
            // Genuine pre-version legacy RunState: version is absent, but all
            // historically required fields remain present.
            task: "privileged RPC fixture",
            maxSteps: 1,
            mode: "standard",
            startTabId: 7,
            currentTabId: 7,
            step: 0,
            active: true,
            abortRequested: false,
          },
        }),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
  resetRunControllerForTests();
  resetRunStateStoreForTests();
});

afterEach(() => {
  resetRunControllerForTests();
  resetRunStateStoreForTests();
  delete (globalThis as Record<string, unknown>).chrome;
});

describe("privileged content RPC dispatch identity", () => {
  test("a valid restricted token cannot authorize navigation at the background effect boundary", async () => {
    const controller = beginRunController({ runId: "restricted", task: "task", maxSteps: 1, mode: "restricted" });
    controller.markRunning();
    const { handleAuthorizeActionEffect } = await import("../src/extension/background/message-handlers");
    const responses: unknown[] = [];

    handleAuthorizeActionEffect(
      { type: "AUTHORIZE_ACTION_EFFECT", token: controller.dispatchToken, action: { type: "navigate", url: "https://example.com", new_tab: false } },
      sender,
      (response) => responses.push(response),
    );
    await vi.waitFor(() => expect(responses.length).toBe(1));
    expect(responses[0]).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining("Navigation") }));
    expect((globalThis.chrome.tabs.update as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  test("a standard token cannot manufacture confirmation for cookie mutation", async () => {
    const controller = beginRunController({ runId: "standard", task: "task", maxSteps: 1, mode: "standard" });
    controller.markRunning();
    const { handleAuthorizeActionEffect } = await import("../src/extension/background/message-handlers");
    const responses: unknown[] = [];

    handleAuthorizeActionEffect(
      {
        type: "AUTHORIZE_ACTION_EFFECT",
        token: controller.dispatchToken,
        action: { type: "set_cookie", url: "https://example.com", name: "role", value: "admin" },
      },
      sender,
      (response) => responses.push(response),
    );
    await vi.waitFor(() => expect(responses.length).toBe(1));
    expect(responses[0]).toEqual(expect.objectContaining({ ok: false, error: "BLOCKED: confirmation required for set_cookie" }));
  });

  test("a direct privileged RPC with a valid token but no effect capability is rejected", async () => {
    const controller = beginRunController({ runId: "full", task: "task", maxSteps: 1, mode: "full_agentic" });
    controller.markRunning();
    (globalThis.chrome.storage.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      open_cowork_run_state: {
        runId: controller.dispatchToken.runId,
        task: "privileged RPC fixture",
        maxSteps: 1,
        mode: "full_agentic",
        startTabId: 7,
        currentTabId: 7,
        step: 0,
        active: true,
        abortRequested: false,
      },
    });
    resetRunStateStoreForTests();
    const { handleScreenshot } = await import("../src/extension/background/message-handlers");
    const responses: unknown[] = [];

    handleScreenshot(
      { type: "SCREENSHOT", fileName: "proof.jpg", action: { type: "screenshot" }, token: controller.dispatchToken },
      sender,
      (response) => responses.push(response),
    );
    await vi.waitFor(() => expect(responses.length).toBe(1));
    expect(responses[0]).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining("effect capability") }));
    expect((globalThis.chrome.downloads.download as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  test("worker loss rejects an old token when no in-memory controller exists", async () => {
    const oldToken = { runId: "dead-worker-run", dispatchRevision: 4 };
    const { handleCdpClick } = await import("../src/extension/background/message-handlers");
    const responses: unknown[] = [];

    handleCdpClick(
      { type: "CDP_CLICK", rect: { x: 1, y: 1, width: 1, height: 1 }, token: oldToken },
      sender,
      (response) => responses.push(response),
    );
    await vi.waitFor(() => expect(responses).toContainEqual(expect.objectContaining({ ok: false })));

    expect(getCurrentRunController()).toBeNull();
    expect((globalThis.chrome.debugger.attach as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((globalThis.chrome.debugger.sendCommand as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  test("a delayed CDP request cannot begin after its dispatch is invalidated", async () => {
    const controller = beginRunController({ runId: "run-a", task: "task", maxSteps: 1, mode: "standard" });
    controller.markRunning();
    const token = controller.dispatchToken;
    const { handleCdpClick } = await import("../src/extension/background/message-handlers");
    const responses: unknown[] = [];

    // Invalidate between message receipt and its async handler continuation.
    const keptOpen = handleCdpClick(
      { type: "CDP_CLICK", rect: { x: 1, y: 1, width: 1, height: 1 }, token },
      sender,
      (response) => responses.push(response),
    );
    controller.requestCancellation();
    await vi.waitFor(() => expect(responses.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(responses.length).toBeGreaterThan(0));

    expect(keptOpen).toBe(true);
    expect((globalThis.chrome.debugger.sendCommand as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(responses).toContainEqual(expect.objectContaining({ ok: false }));
  });

  test("a prior run token cannot dispatch into its successor", async () => {
    const old = beginRunController({ runId: "run-old", task: "task", maxSteps: 1, mode: "standard" });
    old.markRunning();
    const oldToken = old.dispatchToken;
    old.markTerminal("cancelled", "cancelled");
    const successor = beginRunController({ runId: "run-new", task: "task", maxSteps: 1, mode: "standard" });
    successor.markRunning();
    const { handleCdpClick } = await import("../src/extension/background/message-handlers");
    const responses: unknown[] = [];

    handleCdpClick(
      { type: "CDP_CLICK", rect: { x: 1, y: 1, width: 1, height: 1 }, token: oldToken },
      sender,
      (response) => responses.push(response),
    );
    await vi.waitFor(() => expect(responses.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(responses.length).toBeGreaterThan(0));

    expect(getCurrentRunController()).toBe(successor);
    expect((globalThis.chrome.debugger.sendCommand as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(responses).toContainEqual(expect.objectContaining({ ok: false }));
  });

  test("an invalidated screenshot request cannot begin a download", async () => {
    const controller = beginRunController({ runId: "run-download", task: "task", maxSteps: 1, mode: "standard" });
    controller.markRunning();
    const token = controller.dispatchToken;
    controller.requestCancellation();
    const { handleScreenshot } = await import("../src/extension/background/message-handlers");
    const responses: unknown[] = [];

    handleScreenshot(
      { type: "SCREENSHOT", fileName: "proof.jpg", token },
      sender,
      (response) => responses.push(response),
    );
    await vi.waitFor(() => expect(responses.length).toBeGreaterThan(0));

    expect((globalThis.chrome.downloads.download as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(responses).toContainEqual(expect.objectContaining({ ok: false }));
  });

  test("a stale TAB_ACTION cannot create or navigate a tab in a successor run", async () => {
    const old = beginRunController({ runId: "run-tabs-old", task: "task", maxSteps: 1, mode: "standard" });
    old.markRunning();
    const oldToken = old.dispatchToken;
    old.markTerminal("cancelled", "cancelled");
    const successor = beginRunController({ runId: "run-tabs-new", task: "task", maxSteps: 1, mode: "standard" });
    successor.markRunning();
    const { handleTabAction } = await import("../src/extension/background/message-handlers");
    const responses: unknown[] = [];

    handleTabAction(
      { type: "TAB_ACTION", action: { type: "navigate", url: "https://example.com", new_tab: true }, token: oldToken } as never,
      sender,
      (response) => responses.push(response),
    );
    await vi.waitFor(() => expect(responses.length).toBeGreaterThan(0));

    expect((globalThis.chrome.tabs.create as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((globalThis.chrome.tabs.update as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(responses).toContainEqual(expect.objectContaining({ ok: false }));
  });

  test("a valid controller token cannot read a mismatched session run for TAB_ACTION", async () => {
    const controller = beginRunController({ runId: "controller-run", task: "task", maxSteps: 1, mode: "standard" });
    controller.markRunning();
    (globalThis.chrome.storage.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      open_cowork_run_state: {
        runId: "different-session-run",
        task: "successor",
        maxSteps: 1,
        mode: "standard",
        startTabId: 7,
        currentTabId: 7,
        step: 0,
        active: true,
        abortRequested: false,
      },
    });
    const { handleAuthorizeActionEffect, handleTabAction } = await import("../src/extension/background/message-handlers");
    const action = { type: "navigate", url: "https://example.com", new_tab: true } as const;
    const authorizationResponses: Array<{ effectCapability?: string }> = [];
    handleAuthorizeActionEffect(
      { type: "AUTHORIZE_ACTION_EFFECT", token: controller.dispatchToken, action },
      sender,
      (response) => authorizationResponses.push(response as { effectCapability?: string }),
    );
    await vi.waitFor(() => expect(authorizationResponses[0]?.effectCapability).toBeTypeOf("string"));

    const responses: unknown[] = [];
    handleTabAction(
      {
        type: "TAB_ACTION",
        action,
        token: controller.dispatchToken,
        effectCapability: authorizationResponses[0]!.effectCapability,
      },
      sender,
      (response) => responses.push(response),
    );
    await vi.waitFor(() => expect(responses.length).toBe(1));

    expect(responses[0]).toEqual(expect.objectContaining({ ok: false, error: "no active run" }));
    expect((globalThis.chrome.tabs.create as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((globalThis.chrome.tabs.update as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  test("a stale cache invalidation cannot mutate successor vision state", async () => {
    const old = beginRunController({ runId: "run-cache-old", task: "task", maxSteps: 1, mode: "standard" });
    old.markRunning();
    const oldToken = old.dispatchToken;
    old.markTerminal("cancelled", "cancelled");
    const successor = beginRunController({ runId: "run-cache-new", task: "task", maxSteps: 1, mode: "standard" });
    successor.markRunning();
    const { handleClearVisionCache } = await import("../src/extension/background/message-handlers");
    const responses: unknown[] = [];

    handleClearVisionCache(
      { type: "CLEAR_VISION_CACHE", token: oldToken },
      sender,
      (response) => responses.push(response),
    );
    await vi.waitFor(() => expect(responses.length).toBeGreaterThan(0));

    expect(getCurrentRunController()).toBe(successor);
    expect(responses).toContainEqual(expect.objectContaining({ ok: false }));
  });

  test("DETECT_VISUAL cannot return cached detection success after its token becomes stale", async () => {
    const controller = beginRunController({
      runId: "run-visual",
      task: "task",
      maxSteps: 1,
      mode: "standard",
    });
    controller.markRunning();
    (globalThis.chrome.storage.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      open_cowork_run_state: {
        runId: controller.dispatchToken.runId,
        dispatchRevision: controller.dispatchToken.dispatchRevision,
        task: "task",
        maxSteps: 1,
        mode: "standard",
        startTabId: 7,
        currentTabId: 7,
        step: 0,
        active: true,
        abortRequested: false,
      },
    });
    resetRunStateStoreForTests();
    const runHelpers = await import("../src/extension/background/run-helpers");
    const visual = vi.spyOn(runHelpers, "handleDetectVisualRequest").mockImplementationOnce(async () => {
      controller.requestCancellation("cancelled after detection");
      return { ok: true, count: 1, description: "stale cached detection" };
    });
    const { handleAuthorizeActionEffect, handleDetectVisual } = await import("../src/extension/background/message-handlers");
    const action = { type: "detect_visual", query: "button" } as const;
    const authorizationResponses: Array<{ effectCapability?: string }> = [];
    handleAuthorizeActionEffect(
      { type: "AUTHORIZE_ACTION_EFFECT", token: controller.dispatchToken, action },
      sender,
      (response) => authorizationResponses.push(response as { effectCapability?: string }),
    );
    await vi.waitFor(() => expect(authorizationResponses[0]?.effectCapability).toBeTypeOf("string"));

    const responses: unknown[] = [];
    handleDetectVisual(
      {
        type: "DETECT_VISUAL",
        query: "button",
        token: controller.dispatchToken,
        effectCapability: authorizationResponses[0]!.effectCapability,
      },
      sender,
      (response) => responses.push(response),
    );
    await vi.waitFor(() => expect(responses.length).toBe(1));

    expect(visual).toHaveBeenCalledOnce();
    expect(responses[0]).toEqual(expect.objectContaining({
      ok: false,
      error: expect.stringContaining("cancel"),
    }));
    expect(responses).not.toContainEqual(expect.objectContaining({ ok: true }));
    visual.mockRestore();
  });
});
