/**
 * cookies + storage (S5): SW-side `handleTabAction` cases and the content-script
 * delegation contract.
 *
 * - get_cookies: optional urls filter, full cookie projection (name, value,
 *   domain, path, secure, httpOnly, sameSite, expirationDate, session,
 *   hostOnly) in `data.cookies`.
 * - set_cookie: REQUIRES url or domain, and the effective URL goes through the
 *   same domain allow/blocklist gate as navigate/search — a cookie can never
 *   be written to a disallowed host.
 * - delete_cookies: removes every matching cookie with a reconstructed
 *   scheme://domain+path URL (approximation of the browser's removal key).
 * - get/set/clear_storage: chrome.storage.local by default, session opt-in.
 *   set_storage round-trips through JSON so a non-serializable value fails
 *   loudly instead of silently storing nothing.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/agent/tools/helpers/domain-config", () => ({
  checkUrlAllowedWithDomainConfig: vi.fn(() => ({ allowed: true })),
}));

import { handleTabAction } from "../src/extension/background/tab-manager";
import { handleGetCookies, handleSetCookie } from "../src/lib/agent/tools/handlers/cookies";
import {
  handleGetStorage,
  handleSetStorage,
  handleClearStorage,
} from "../src/lib/agent/tools/handlers/storage";
import { ActionSchema } from "../src/lib/agent/tools/schema";
import { checkUrlAllowedWithDomainConfig } from "@/lib/agent/tools/helpers/domain-config";
import { makeChromeStorageMock } from "./helpers/chrome-storage-mock";
import type { RunState } from "../src/extension/background/state-store";

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

const cookieFixture = [
  {
    name: "session_id",
    value: "abc",
    domain: ".example.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax" as chrome.cookies.SameSiteStatus,
    expirationDate: 1_800_000_000,
    session: false,
    hostOnly: false,
  },
  {
    name: "prefs",
    value: "dark",
    domain: "example.com",
    path: "/",
    secure: false,
    httpOnly: false,
    sameSite: "no_restriction" as chrome.cookies.SameSiteStatus,
    expirationDate: undefined,
    session: true,
    hostOnly: true,
  },
];

let chromeMock: Record<string, unknown>;
let localStore: Map<string, unknown>;
let sessionStore: Map<string, unknown>;

function installChrome(): void {
  localStore = new Map([["persisted", { a: 1 }]]);
  sessionStore = new Map();
  const storageMock = makeChromeStorageMock(localStore, sessionStore);
  chromeMock = {
    ...storageMock,
    tabs: {
      get: vi.fn(async () => ({ id: 1, status: "complete", url: "https://example.com" })),
      query: vi.fn(async () => []),
    },
    cookies: {
      getAll: vi.fn(async () => cookieFixture),
      set: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({})),
    },
  };
  (globalThis as Record<string, unknown>).chrome = chromeMock;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
  vi.restoreAllMocks();
});

// vi.restoreAllMocks() does not reset the implementation of a vi.fn() mock,
// so the default must be re-seeded before every test — otherwise an impl set
// by an earlier test (or a run order change) would leak into the domain gate.
beforeEach(() => {
  (checkUrlAllowedWithDomainConfig as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    allowed: true,
  }));
});

describe("handleTabAction — get_cookies", () => {
  beforeEach(() => {
    installChrome();
  });

  test("returns the full cookie projection with VALUES REDACTED", async () => {
    const res = await handleTabAction({ type: "get_cookies" } as never, runState);
    expect(res.success).toBe(true);
    const data = res.data as { cookies: Array<Record<string, unknown>>; count: number };
    expect(data.count).toBe(2);
    expect(data.cookies[0]).toMatchObject({
      name: "session_id",
      // Session tokens are credentials — the value never reaches the model.
      value: "[REDACTED]",
      domain: ".example.com",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      session: false,
      hostOnly: false,
    });
    expect(data.cookies[0]).toHaveProperty("path");
    expect(data.cookies[0]).toHaveProperty("expirationDate");
  });

  test("with urls, reads cookies per URL; invalid URL strings are dropped", async () => {
    const res = await handleTabAction(
      { type: "get_cookies", urls: ["https://example.com/path", "ftp://bad", "https://other.org"] } as never,
      runState,
    );
    expect(res.success).toBe(true);
    expect((chromeMock.cookies as { getAll: ReturnType<typeof vi.fn> }).getAll).toHaveBeenCalledWith({
      url: "https://example.com/path",
    });
    expect((chromeMock.cookies as { getAll: ReturnType<typeof vi.fn> }).getAll).toHaveBeenCalledWith({
      url: "https://other.org",
    });
    expect((chromeMock.cookies as { getAll: ReturnType<typeof vi.fn> }).getAll).not.toHaveBeenCalledWith({
      url: "ftp://bad",
    });
  });
});

describe("handleTabAction — set_cookie", () => {
  beforeEach(() => {
    installChrome();
  });

  test("BLOCKED on a disallowed host: notify fires and chrome.cookies.set is never called", async () => {
    (checkUrlAllowedWithDomainConfig as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      allowed: false,
      reason: "domain not allowlisted",
    }));
    const notify = vi.fn();
    const res = await handleTabAction(
      { type: "set_cookie", url: "https://evil.example.net", name: "s", value: "x" } as never,
      runState,
      notify,
    );
    expect(res.success).toBe(false);
    expect(res.message).toContain("BLOCKED");
    expect(notify).toHaveBeenCalled();
    expect((chromeMock.cookies as { set: ReturnType<typeof vi.fn> }).set).not.toHaveBeenCalled();
  });

  test("writes the cookie on an allowed host and reports the name in data", async () => {
    (checkUrlAllowedWithDomainConfig as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      allowed: true,
    }));
    const res = await handleTabAction(
      { type: "set_cookie", url: "https://example.com", name: "theme", value: "dark", secure: true } as never,
      runState,
    );
    expect(res.success).toBe(true);
    expect((chromeMock.cookies as { set: ReturnType<typeof vi.fn> }).set).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com", name: "theme", value: "dark", secure: true }),
    );
    expect((res.data as { set: string }).set).toBe("theme");
  });

  test("domain-only cookies gate against the https://domain URL (leading dot dropped)", async () => {
    (checkUrlAllowedWithDomainConfig as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      allowed: true,
    }));
    const res = await handleTabAction(
      { type: "set_cookie", domain: ".example.com", name: "t", value: "v" } as never,
      runState,
    );
    expect(res.success).toBe(true);
    expect(checkUrlAllowedWithDomainConfig).toHaveBeenCalledWith("https://example.com");
    expect((chromeMock.cookies as { set: ReturnType<typeof vi.fn> }).set).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com", domain: ".example.com" }),
    );
  });

  test("neither url nor domain is BLOCKED before any API call", async () => {
    const res = await handleTabAction(
      { type: "set_cookie", name: "t", value: "v" } as never,
      runState,
    );
    expect(res.success).toBe(false);
    expect(res.message).toContain("url or domain");
    expect((chromeMock.cookies as { set: ReturnType<typeof vi.fn> }).set).not.toHaveBeenCalled();
  });
});

describe("handleTabAction — delete_cookies", () => {
  beforeEach(() => {
    installChrome();
  });

  test("removes every cookie only with the explicit all:true opt-in", async () => {
    const res = await handleTabAction({ type: "delete_cookies", all: true } as never, runState);
    expect(res.success).toBe(true);
    const remove = (chromeMock.cookies as { remove: ReturnType<typeof vi.fn> }).remove;
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith({
      url: "https://example.com/",
      name: "session_id",
    });
    expect(remove).toHaveBeenCalledWith({
      url: "http://example.com/",
      name: "prefs",
    });
    expect((res.data as { deleted: number }).deleted).toBe(2);
  });

  test("without urls or explicit all:true, delete_cookies is BLOCKED before any API call", async () => {
    const getAll = (chromeMock.cookies as { getAll: ReturnType<typeof vi.fn> }).getAll;
    const remove = (chromeMock.cookies as { remove: ReturnType<typeof vi.fn> }).remove;
    const res = await handleTabAction({ type: "delete_cookies" } as never, runState);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/BLOCKED/);
    expect(res.message).toMatch(/all:true|url/i);
    expect(getAll).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  test("with urls, only the matching cookies are removed", async () => {
    const getAll = (chromeMock.cookies as { getAll: ReturnType<typeof vi.fn> }).getAll;
    const res = await handleTabAction(
      { type: "delete_cookies", urls: ["https://example.com/"] } as never,
      runState,
    );
    expect(res.success).toBe(true);
    expect(getAll).toHaveBeenCalledWith({ url: "https://example.com/" });
    expect((chromeMock.cookies as { remove: ReturnType<typeof vi.fn> }).remove).toHaveBeenCalledTimes(2);
  });

  test("all:true wipe aborts without removing anything when a jar cookie hits a blocked domain", async () => {
    (checkUrlAllowedWithDomainConfig as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      allowed: false,
      reason: "domain not allowlisted",
    }));
    const notify = vi.fn();
    const res = await handleTabAction({ type: "delete_cookies", all: true } as never, runState, notify);
    expect(res.success).toBe(false);
    expect(res.message).toContain("BLOCKED");
    expect(notify).toHaveBeenCalled();
    expect((chromeMock.cookies as { remove: ReturnType<typeof vi.fn> }).remove).not.toHaveBeenCalled();
  });
});

describe("handleTabAction — storage", () => {
  beforeEach(() => {
    installChrome();
  });

  test("get_storage reads chrome.storage.local by default", async () => {
    const res = await handleTabAction({ type: "get_storage" } as never, runState);
    expect(res.success).toBe(true);
    const data = res.data as { items: Record<string, unknown>; type: string };
    expect(data.type).toBe("local");
    expect(data.items.persisted).toEqual({ a: 1 });
  });

  test("get_storage with storage_type=session reads the session area", async () => {
    sessionStore.set("ephemeral", 42);
    const res = await handleTabAction(
      { type: "get_storage", storage_type: "session" } as never,
      runState,
    );
    const data = res.data as { items: Record<string, unknown>; type: string };
    expect(data.type).toBe("session");
    expect(data.items.ephemeral).toBe(42);
  });

  test("set_storage round-trips the value through JSON (nested structures survive)", async () => {
    const res = await handleTabAction(
      { type: "set_storage", key: "profile", value: { name: "a", tags: [1, 2] } } as never,
      runState,
    );
    expect(res.success).toBe(true);
    expect((res.data as { set: string }).set).toBe("profile");
    expect(localStore.get("profile")).toEqual({ name: "a", tags: [1, 2] });
  });

  test("set_storage rejects non-serializable values without writing", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const res = await handleTabAction(
      { type: "set_storage", key: "loop", value: circular } as never,
      runState,
    );
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/JSON|serializable/i);
    expect(localStore.has("loop")).toBe(false);
  });

  test("clear_storage clears the whole area only with the explicit all:true opt-in", async () => {
    const res = await handleTabAction(
      { type: "clear_storage", storage_type: "session", all: true } as never,
      runState,
    );
    expect(res.success).toBe(true);
    expect((res.data as { cleared: string }).cleared).toBe("session");
    expect(sessionStore.size).toBe(0);
  });

  test("clear_storage with a keys list removes exactly those keys", async () => {
    localStore.set("keep", 1);
    localStore.set("drop", 2);
    const res = await handleTabAction(
      { type: "clear_storage", keys: ["drop"] } as never,
      runState,
    );
    expect(res.success).toBe(true);
    expect(localStore.has("drop")).toBe(false);
    expect(localStore.has("keep")).toBe(true);
    expect((res.data as { removed: number }).removed).toBe(1);
  });

  test("clear_storage without keys or all:true is BLOCKED (whole-area wipe needs explicit opt-in)", async () => {
    const res = await handleTabAction({ type: "clear_storage" } as never, runState);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/BLOCKED/);
    // API keys / settings / domain config survive.
    expect(localStore.get("persisted")).toEqual({ a: 1 });
  });
});

describe("schema opt-in refines for destructive actions", () => {
  test("delete_cookies requires at least one url or explicit all:true", () => {
    expect(ActionSchema.safeParse({ type: "delete_cookies" }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: "delete_cookies", urls: [] }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: "delete_cookies", urls: ["https://example.com/"] }).success).toBe(true);
    expect(ActionSchema.safeParse({ type: "delete_cookies", all: true }).success).toBe(true);
  });

  test("clear_storage requires at least one key or explicit all:true", () => {
    expect(ActionSchema.safeParse({ type: "clear_storage" }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: "clear_storage", keys: [] }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: "clear_storage", keys: ["session"] }).success).toBe(true);
    expect(ActionSchema.safeParse({ type: "clear_storage", all: true }).success).toBe(true);
  });
});

describe("content-side cookie handlers", () => {
  test("handleGetCookies delegates TAB_ACTION and passes data through", async () => {
    const sendMessage = vi.fn(async () => ({
      ok: true,
      success: true,
      message: "read 1 cookies",
      data: { cookies: [{ name: "a", value: "b" }], count: 1 },
    }));
    (globalThis as Record<string, unknown>).chrome = { runtime: { id: "ext-id", sendMessage } };
    const res = await handleGetCookies({} as never, { type: "get_cookies" } as never);
    expect(sendMessage).toHaveBeenCalledWith({
      type: "TAB_ACTION",
      action: { type: "get_cookies" },
    });
    expect(res.success).toBe(true);
    expect((res.data as { count: number }).count).toBe(1);
  });

  test("handleSetCookie surfaces a BLOCKED response as failure", async () => {
    const sendMessage = vi.fn(async () => ({
      ok: true,
      success: false,
      message: "BLOCKED: domain not allowlisted",
    }));
    (globalThis as Record<string, unknown>).chrome = { runtime: { id: "ext-id", sendMessage } };
    const res = await handleSetCookie({} as never, {
      type: "set_cookie",
      url: "https://evil.example.net",
      name: "s",
      value: "x",
    } as never);
    expect(res.success).toBe(false);
    expect(res.message).toContain("BLOCKED");
  });

  test("cookie/storage handlers fail honestly without an extension context", async () => {
    const res = await handleGetCookies({} as never, { type: "get_cookies" } as never);
    expect(res.success).toBe(false);
    expect(res.message).toContain("not supported");
    const resStorage = await handleGetStorage({} as never, { type: "get_storage" } as never);
    expect(resStorage.success).toBe(false);
    expect(resStorage.message).toContain("not supported");
    const resSet = await handleSetStorage({} as never, { type: "set_storage", key: "k", value: 1 } as never);
    expect(resSet.success).toBe(false);
    expect(resSet.message).toContain("not supported");
    const resClear = await handleClearStorage({} as never, { type: "clear_storage" } as never);
    expect(resClear.success).toBe(false);
    expect(resClear.message).toContain("not supported");
  });
});
