/**
 * list_tabs: SW-side `handleTabAction` listing and the content-script
 * delegation contract.
 *
 * The SW returns `data: { tabs: [{index, url, active}], count }` where index
 * is the tab ID (the same identifier switch_tab/close_tab accept). Internal
 * `chrome://` / `chrome-extension://` tabs are filtered out — they are not
 * navigable by the agent.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/agent/tools/helpers/domain-config", () => ({
  checkUrlAllowedWithDomainConfig: vi.fn(),
}));

import { handleTabAction } from "../src/extension/background/tab-manager";
import { handleListTabs } from "../src/lib/agent/tools/handlers/tab-management";
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

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
  vi.restoreAllMocks();
});

describe("handleTabAction — list_tabs", () => {
  let query: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    query = vi.fn(async () => [
      { id: 1, url: "https://example.com", title: "Example", active: true },
      { id: 2, url: "chrome://extensions", title: "Extensions", active: false },
      { id: 3, url: "https://other.org", title: "Other", active: false },
      { id: 4, url: "chrome-extension://abc/panel.html", title: "Panel", active: false },
    ]);
    (globalThis as Record<string, unknown>).chrome = {
      tabs: { query },
    };
  });

  test("returns every navigable tab with index=tab id, filtered of internal pages", async () => {
    const res = await handleTabAction({ type: "list_tabs" } as never, runState);
    expect(res.handled).toBe(true);
    expect(res.success).toBe(true);
    const data = res.data as { tabs: Array<{ index: number; url: string; active: boolean }>; count: number };
    expect(data.count).toBe(2);
    expect(data.tabs).toEqual([
      { index: 1, url: "https://example.com", active: true },
      { index: 3, url: "https://other.org", active: false },
    ]);
  });
});

describe("handleListTabs (content side)", () => {
  test("delegates TAB_ACTION and passes through the data payload", async () => {
    const sendMessage = vi.fn(async () => ({
      ok: true,
      success: true,
      message: "listed 2 tabs",
      data: { tabs: [{ index: 1, url: "https://example.com", active: true }], count: 1 },
    }));
    (globalThis as Record<string, unknown>).chrome = {
      runtime: { id: "ext-id", sendMessage },
    };
    const res = await handleListTabs({} as never, { type: "list_tabs" } as never);
    expect(sendMessage).toHaveBeenCalledWith({
      type: "TAB_ACTION",
      action: { type: "list_tabs" },
    });
    expect(res.success).toBe(true);
    expect((res.data as { count: number }).count).toBe(1);
  });

  test("fails honestly without an extension context", async () => {
    const res = await handleListTabs({} as never, { type: "list_tabs" } as never);
    expect(res.success).toBe(false);
    expect(res.message).toContain("not supported");
  });
});
