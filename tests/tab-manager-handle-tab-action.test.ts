/**
 * tab-manager.ts — `handleTabAction` URL-scheme + domain-policy security gate.
 *
 * `handleTabAction` is the authoritative SW-side gate for navigate/search tab
 * actions: it rejects non-http(s) schemes (e.g. `javascript:`) BEFORE the
 * domain-policy check, enforces the allow/blocklist via
 * `checkUrlAllowedWithDomainConfig`, guards "no active tab", and rejects a
 * missing search query. A regression here would let a prompt-injected agent
 * navigate to `javascript:`/disallowed hosts.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/agent/tools/helpers/domain-config", () => ({
  checkUrlAllowedWithDomainConfig: vi.fn(),
}));

import { handleTabAction } from "../src/extension/background/tab-manager";
import { checkUrlAllowedWithDomainConfig } from "@/lib/agent/tools/helpers/domain-config";
import type { RunState } from "../src/extension/background/state-store";

let chromeMock: {
  tabs: {
    sendMessage: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    onUpdated: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
  };
};

function installChrome(): void {
  const sendMessage = vi.fn(async (_tabId: number, msg: { type?: string }) => {
    if (msg?.type === "PING") return { ok: true };
    return { ok: true };
  });
  chromeMock = {
    tabs: {
      sendMessage,
      update: vi.fn(async () => ({ id: 1 })),
      create: vi.fn(async () => ({ id: 9 })),
      get: vi.fn(async () => ({ id: 1, status: "complete", url: "https://example.com" })),
      remove: vi.fn(async () => {}),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
  (globalThis as Record<string, unknown>).chrome = chromeMock;
}

const runState: RunState = {
  task: "t",
  maxSteps: 10,
  mode: "standard",
  startTabId: 1,
  currentTabId: 1,
  step: 0,
  active: true,
  abortRequested: false,
};

beforeEach(() => {
  installChrome();
  (checkUrlAllowedWithDomainConfig as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    allowed: true,
  }));
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
  vi.clearAllMocks();
});

describe("handleTabAction security gate", () => {
  test("navigate with a javascript: scheme is BLOCKED", async () => {
    const res = await handleTabAction(
      { type: "navigate", url: "javascript:alert(1)" } as never,
      runState,
    );
    expect(res.handled).toBe(true);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/unsupported URL scheme/);
    // The domain policy must NOT even be consulted for a bad scheme.
    expect(checkUrlAllowedWithDomainConfig).not.toHaveBeenCalled();
  });

  test("navigate to a blocked domain is BLOCKED and notifies", async () => {
    const notify = vi.fn();
    (checkUrlAllowedWithDomainConfig as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      allowed: false,
      reason: "example.com is blocked",
    }));
    const res = await handleTabAction(
      { type: "navigate", url: "https://blocked.example.com/page" } as never,
      runState,
      notify,
    );
    expect(res.handled).toBe(true);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/BLOCKED/);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", recoverable: false }),
    );
  });

  test.each(["data:text/html,<script>", "file:///etc/passwd", "about:blank", "javascript:alert(1)"])(
    "navigate with a non-http(s) scheme (%s) is BLOCKED without consulting the domain policy",
    async (url) => {
      const res = await handleTabAction({ type: "navigate", url } as never, runState);
      expect(res.handled).toBe(true);
      expect(res.success).toBe(false);
      expect(res.message).toMatch(/unsupported URL scheme/);
      expect(checkUrlAllowedWithDomainConfig).not.toHaveBeenCalled();
    },
  );

  test("navigate to a domain outside the allowlist is BLOCKED and notifies", async () => {
    const notify = vi.fn();
    (checkUrlAllowedWithDomainConfig as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      allowed: false,
      reason: "example.com is not in the allowlist",
    }));
    const res = await handleTabAction(
      { type: "navigate", url: "https://example.com/page" } as never,
      runState,
      notify,
    );
    expect(res.handled).toBe(true);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/BLOCKED/);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", recoverable: false }),
    );
  });

  test("navigate to an allowed http(s) URL is handled", async () => {
    const res = await handleTabAction(
      { type: "navigate", url: "https://example.com/page" } as never,
      runState,
    );
    expect(res.handled).toBe(true);
    expect(res.success).toBe(true);
    expect(res.pageChanged).toBe(true);
    expect(chromeMock.tabs.update).toHaveBeenCalled();
  });

  test("search with a missing query is BLOCKED", async () => {
    const res = await handleTabAction(
      { type: "search", engine: "duckduckgo" } as never,
      runState,
    );
    expect(res.handled).toBe(true);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/missing query/);
  });

  test("search with a normal query is handled", async () => {
    const res = await handleTabAction(
      { type: "search", engine: "duckduckgo", query: "weather" } as never,
      runState,
    );
    expect(res.handled).toBe(true);
    expect(res.success).toBe(true);
    expect(res.pageChanged).toBe(true);
    expect(chromeMock.tabs.update).toHaveBeenCalled();
  });

  test("search on a disallowed domain is BLOCKED and notifies", async () => {
    const notify = vi.fn();
    (checkUrlAllowedWithDomainConfig as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      allowed: false,
      reason: "search host is blocked",
    }));
    const res = await handleTabAction(
      { type: "search", engine: "duckduckgo", query: "weather" } as never,
      runState,
      notify,
    );
    expect(res.handled).toBe(true);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/BLOCKED/);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", recoverable: false }),
    );
  });
});
