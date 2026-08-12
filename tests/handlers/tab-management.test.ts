/**
 * list_tabs payload serialization — the LLM renders only `message` +
 * `extractedContent`, so a data-only tab listing would be a dead action.
 * delegateTabAction must serialize the SW's `data.tabs` into a bounded
 * extractedContent (and never for non-listing actions).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  delegateTabAction,
  handleListTabs,
} from "../../src/lib/agent/tools/handlers/tab-management";
import type { ActionContext } from "../../src/lib/agent/tools/handlers/types";

function installSendMessage(mock: (msg: unknown) => Promise<unknown>): void {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { id: "ext-id", sendMessage: mock },
  };
}

function ctx(): ActionContext {
  return {
    state: { url: "http://example.com", title: "t", elements: [] } as never,
    beforeUrl: "http://example.com",
    beforeFingerprint: "",
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
});

describe("list_tabs payload serialization", () => {
  test("list_tabs serializes the SW tab listing into extractedContent", async () => {
    installSendMessage(async () => ({
      ok: true,
      success: true,
      message: "tabs listed",
      data: {
        tabs: [
          { url: "https://a.example/x", active: true, index: 0 },
          { url: "https://b.example/y?t=secret-token", active: false, index: 1 },
        ],
      },
    }));
    const result = await handleListTabs(ctx(), { type: "list_tabs" });
    expect(result.success).toBe(true);
    expect(result.extractedContent).toContain("https://a.example/x (active:true, id:0)");
    expect(result.extractedContent).toContain("https://b.example/y?t=secret-token (active:false, id:1)");
    expect(result.extractedContent).toMatch(/^<untrusted_tab_list>/);
  });

  test("list_tabs bounds the serialized listing to 50 tabs", async () => {
    const tabs = Array.from({ length: 80 }, (_, i) => ({
      url: `https://tab-${i}.example/`,
      active: i === 0,
      index: i,
    }));
    installSendMessage(async () => ({ ok: true, success: true, message: "ok", data: { tabs } }));
    const result = await handleListTabs(ctx(), { type: "list_tabs" });
    const lines = result.extractedContent!.split("\n").filter((l) => l.startsWith("https://tab-"));
    expect(lines).toHaveLength(50);
  });

  test("non-listing delegated actions do NOT gain a tab-list extractedContent", async () => {
    installSendMessage(async () => ({
      ok: true,
      success: true,
      message: "switched",
      data: { tabs: [{ url: "https://x.example", active: true, index: 0 }] },
    }));
    const result = await delegateTabAction({ type: "switch_tab", tab_id: 1 } as never, undefined, undefined, undefined);
    expect(result.success).toBe(true);
    expect(result.extractedContent).toBeUndefined();
  });
});
