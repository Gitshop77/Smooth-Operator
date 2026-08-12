import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createOptionsPlatformCommandHandler,
  isExactOptionsSender,
} from "../src/extension/background/options-platform-command";
import type { OptionsPlatformCommandMessageV1 } from "../src/extension/options-platform-contract";

const message: OptionsPlatformCommandMessageV1 = {
  type: "OPTIONS_PLATFORM_COMMAND",
  version: 1,
  command: {
    kind: "connection_test",
    config: {
      version: 1,
      provider: "openai",
      model: "gpt-selected",
      provenance: "user",
      credential: null,
    },
  },
};

beforeEach(() => {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      id: "extension-id",
      getURL: (path: string) => `chrome-extension://extension-id/${path}`,
    },
  };
});

describe("Options platform command admission", () => {
  test("admits the exact Options extension page and returns the sanitized service result", async () => {
    const result = {
      version: 1 as const,
      ok: true,
      code: "ok" as const,
      latencyMs: 10,
      provider: "openai",
      model: "gpt-selected",
      message: "Connected.",
    };
    const service = { test: vi.fn(async () => result) };
    const getCredentialStatus = vi.fn(async () => ({ status: "none" as const }));
    const handler = createOptionsPlatformCommandHandler({ connection: service, getCredentialStatus });
    const sendResponse = vi.fn();

    expect(handler(message, {
      id: "extension-id",
      url: "chrome-extension://extension-id/options.html?source=menu#connection",
    }, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true, kind: "connection_test", result }));
    expect(service.test).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-selected" }));
  });

  test.each([
    { id: "foreign", url: "chrome-extension://extension-id/options.html" },
    { id: "extension-id", url: "https://example.com/options.html" },
    { id: "extension-id", url: "chrome-extension://extension-id/sidepanel.html" },
    { id: "extension-id", url: undefined },
  ])("rejects non-Options sender %#", (sender) => {
    const service = { test: vi.fn() };
    const handler = createOptionsPlatformCommandHandler({ connection: service, getCredentialStatus: vi.fn() } as never);
    const sendResponse = vi.fn();
    expect(handler(message, sender as chrome.runtime.MessageSender, sendResponse)).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "Unauthorized Options platform sender." });
    expect(service.test).not.toHaveBeenCalled();
  });

  test("fails closed on an unsupported command version", () => {
    const handler = createOptionsPlatformCommandHandler({ connection: { test: vi.fn() }, getCredentialStatus: vi.fn() } as never);
    const sendResponse = vi.fn();
    expect(handler(
      { ...message, version: 2 } as never,
      { id: "extension-id", url: "chrome-extension://extension-id/options.html" },
      sendResponse,
    )).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "Unsupported Options platform command." });
  });

  test("returns only non-secret credential status metadata", async () => {
    const getCredentialStatus = vi.fn(async () => ({ status: "none" as const }));
    const handler = createOptionsPlatformCommandHandler({
      connection: { test: vi.fn() },
      getCredentialStatus,
    });
    const sendResponse = vi.fn();
    expect(handler(
      { type: "OPTIONS_PLATFORM_COMMAND", version: 1, command: { kind: "credential_status" } },
      { id: "extension-id", url: "chrome-extension://extension-id/options.html" },
      sendResponse,
    )).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({
      ok: true,
      kind: "credential_status",
      status: { status: "none" },
    }));
  });

  test("sender predicate rejects deceptive prefix and path matches", () => {
    expect(isExactOptionsSender({
      id: "extension-id",
      url: "chrome-extension://extension-id/options.html.evil",
    })).toBe(false);
  });
});
