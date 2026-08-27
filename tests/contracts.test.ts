import { describe, expect, it } from "vitest";

import { BatchRequestSchema, BrowserActionInputSchema, BrowserActionPlanSchema, BrowserActionSchema, ClickRequestSchema, CookieRequestSchema, EvaluateRequestSchema, ExtractRequestSchema, HtmlRequestSchema, InputRequestSchema, NavigateRequestSchema, ResearchRequestSchema, ScreenshotRequestSchema, SnapshotRequestSchema, StorageRequestSchema, TargetRequestSchema } from "@/server/contracts";

describe("MCP contracts", () => {
  it("accepts browser-use indexed and coordinate click forms", () => {
    expect(ClickRequestSchema.safeParse({ index: 0 }).success).toBe(true);
    expect(ClickRequestSchema.safeParse({ index: 0, new_tab: true }).success).toBe(true);
    expect(ClickRequestSchema.safeParse({ selector: "#submit" }).success).toBe(true);
    expect(ClickRequestSchema.safeParse({ ref: "e5" }).success).toBe(true);
    expect(ClickRequestSchema.safeParse({ ref: "ref:e5" }).success).toBe(true);
    expect(ClickRequestSchema.safeParse({ coordinate_x: 10, coordinate_y: 20 }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ action: "click", coordinateX: 10, coordinateY: 20 }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ action: "click", ref: "e5" }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ action: "input", ref: "e5", text: "hello" }).success).toBe(true);
    expect(NavigateRequestSchema.safeParse({ url: "https://example.com", new_tab: true }).success).toBe(true);
    expect(InputRequestSchema.safeParse({ ref: "e5", text: "hello" }).success).toBe(true);
    expect(InputRequestSchema.safeParse({ ref: "ref:e5", text: "hello" }).success).toBe(true);
  });

  it("rejects ambiguous or incomplete targets at the schema boundary", () => {
    expect(ClickRequestSchema.safeParse({ target: "#a", index: 0 }).success).toBe(false);
    expect(ClickRequestSchema.safeParse({ ref: "button" }).success).toBe(false);
    expect(ClickRequestSchema.safeParse({ ref: "e0" }).success).toBe(false);
    expect(ClickRequestSchema.safeParse({ ref: "e5", target: "#a" }).success).toBe(false);
    expect(ClickRequestSchema.safeParse({ coordinateX: 10 }).success).toBe(false);
    expect(InputRequestSchema.safeParse({ target: "#a", index: 0, text: "x" }).success).toBe(false);
    expect(InputRequestSchema.safeParse({ ref: "e5", target: "#a", text: "x" }).success).toBe(false);
    expect(InputRequestSchema.safeParse({ selector: "#a", text: "x" }).success).toBe(true);
    expect(InputRequestSchema.safeParse({ target: "#a", selector: "#b", text: "x" }).success).toBe(false);
    expect(TargetRequestSchema.safeParse({}).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "click", target: "#a", coordinateX: 10, coordinateY: 20 }).success).toBe(false);
  });

  it("does not expose per-request security or provider overrides", () => {
    expect(SnapshotRequestSchema.safeParse({ mode: "full" }).success).toBe(false);
    expect(ResearchRequestSchema.safeParse({ query: "mcp", mode: "full" }).success).toBe(false);
    expect(BatchRequestSchema.safeParse({ actions: [{ action: "wait" }], mode: "full" }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "wait", model: "provider-model" }).success).toBe(false);
    for (const key of ["allowed_domains", "allowedDomains", "model", "provider", "mode", "use_vision", "useVision"]) {
      expect(BrowserActionSchema.safeParse({ action: "wait", [key]: "override" }).success, key).toBe(false);
      expect(BatchRequestSchema.safeParse({ actions: [{ action: "wait", [key]: "override" }] }).success, key).toBe(false);
    }
  });

  it("rejects whitespace-only page evaluation code", () => {
    expect(EvaluateRequestSchema.safeParse({ code: "   \n\t" }).success).toBe(false);
    expect(EvaluateRequestSchema.safeParse({ code: "  1 + 1  " }).success).toBe(true);
  });

  it("accepts the expression alias for evaluate exactly like batch actions", () => {
    expect(EvaluateRequestSchema.safeParse({ expression: "1 + 1" }).success).toBe(true);
    expect(EvaluateRequestSchema.safeParse({ code: "1", expression: "2" }).success).toBe(false);
    expect(EvaluateRequestSchema.safeParse({ expression: "   " }).success).toBe(false);
  });

  it("reports distinct evaluate guidance for missing versus duplicated arguments", () => {
    const standaloneMissing = EvaluateRequestSchema.safeParse({});
    expect(standaloneMissing.success).toBe(false);
    if (!standaloneMissing.success) {
      expect(standaloneMissing.error.issues.map((issue) => issue.message)).toContain("Provide code or expression.");
      expect(standaloneMissing.error.issues.map((issue) => issue.message)).not.toContain("Provide code or expression, not both.");
    }
    const standaloneBoth = EvaluateRequestSchema.safeParse({ code: "1", expression: "2" });
    expect(standaloneBoth.success).toBe(false);
    if (!standaloneBoth.success) {
      expect(standaloneBoth.error.issues.map((issue) => issue.message)).toContain("Provide code or expression, not both.");
      expect(standaloneBoth.error.issues.map((issue) => issue.message)).not.toContain("Provide code or expression.");
    }
    const batchMissing = BrowserActionSchema.safeParse({ action: "evaluate" });
    expect(batchMissing.success).toBe(false);
    if (!batchMissing.success) {
      expect(batchMissing.error.issues.map((issue) => issue.message)).toContain("Provide code or expression.");
    }
    const batchBoth = BrowserActionSchema.safeParse({ action: "evaluate", code: "1", expression: "2" });
    expect(batchBoth.success).toBe(false);
    if (!batchBoth.success) {
      expect(batchBoth.error.issues.map((issue) => issue.message)).toContain("Provide code or expression, not both.");
    }
  });

  it("supports snapshot-aware frame actions and guarded storage clearing", () => {
    expect(ClickRequestSchema.safeParse({ target: "ref:e1", snapshotId: "snap", frameId: "main" }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ action: "page_next", offset: 10 }).success).toBe(true);
    expect(StorageRequestSchema.safeParse({ operation: "clear", all: true }).success).toBe(true);
    expect(StorageRequestSchema.safeParse({ operation: "clear" }).success).toBe(false);
    expect(StorageRequestSchema.safeParse({ operation: "clear", key: "a", all: true }).success).toBe(false);
  });

  it("accepts browser-use CLI screenshot aliases with bounded downscaling", () => {
    expect(ScreenshotRequestSchema.safeParse({ full: true, max_dim: 1_200 }).success).toBe(true);
    expect(ScreenshotRequestSchema.safeParse({ max_dim: 99 }).success).toBe(true);
    expect(ScreenshotRequestSchema.safeParse({ max_dim: 1 }).success).toBe(true);
    expect(ScreenshotRequestSchema.safeParse({ full: true, fullPage: false }).success).toBe(false);
    expect(ScreenshotRequestSchema.safeParse({ maxBytes: 100_000, max_bytes: 100_000 }).success).toBe(false);
  });

  it("accepts the browser-use snapshot full_page alias and rejects conflicts like screenshots", () => {
    expect(SnapshotRequestSchema.safeParse({ full_page: true }).success).toBe(true);
    expect(SnapshotRequestSchema.safeParse({ fullPage: false, full: true }).success).toBe(false);
    expect(SnapshotRequestSchema.safeParse({ full_page: false, full: true }).success).toBe(false);
    expect(SnapshotRequestSchema.safeParse({ fullPage: true, full_page: false, full: true }).success).toBe(false);
  });

  it("rejects conflicting aliases before transforms choose a winner", () => {
    expect(SnapshotRequestSchema.safeParse({ includeScreenshot: true, include_screenshot: false }).success).toBe(false);
    expect(SnapshotRequestSchema.safeParse({ fullPage: true, full: false }).success).toBe(false);
    expect(NavigateRequestSchema.safeParse({ url: "https://example.com", newTab: true, new_tab: false }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "screenshot", full: true, fullPage: false }).success).toBe(false);
  });

  it("accepts only absolute HTTP(S) navigation URLs", () => {
    expect(NavigateRequestSchema.safeParse({ url: "https://example.com/path" }).success).toBe(true);
    expect(NavigateRequestSchema.safeParse({ url: "javascript:alert(1)" }).success).toBe(false);
    expect(NavigateRequestSchema.safeParse({ url: "https://user:secret@example.com" }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "navigate", url: "file:///etc/passwd" }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "set_cookie", cookieName: "session", url: "javascript:alert(1)" }).success).toBe(false);
    expect(CookieRequestSchema.safeParse({ operation: "set", name: "session", value: "x", url: "file:///tmp/cookie" }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "wait_for_url", url: "*" }).success).toBe(true);
  });

  it("bounds page text request sizes at the MCP boundary", () => {
    expect(SnapshotRequestSchema.safeParse({ maxChars: 8_000 }).success).toBe(true);
    expect(SnapshotRequestSchema.safeParse({ maxChars: 8_001 }).success).toBe(false);
    expect(ExtractRequestSchema.safeParse({ maxChars: 8_000 }).success).toBe(true);
    expect(ExtractRequestSchema.safeParse({ maxChars: 8_001 }).success).toBe(false);
    expect(HtmlRequestSchema.safeParse({ maxChars: 8_000 }).success).toBe(true);
    expect(HtmlRequestSchema.safeParse({ maxChars: 8_001 }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "extract", maxChars: 8_000 }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ action: "extract", maxChars: 8_001 }).success).toBe(false);
    expect(ResearchRequestSchema.safeParse({ query: "mcp", maxChars: 4_000 }).success).toBe(true);
    expect(ResearchRequestSchema.safeParse({ query: "mcp", maxChars: 4_001 }).success).toBe(false);
    expect(ResearchRequestSchema.safeParse({ query: "mcp", maxResults: 10 }).success).toBe(true);
    expect(ResearchRequestSchema.safeParse({ query: "mcp", maxResults: 11 }).success).toBe(false);
    expect(ResearchRequestSchema.safeParse({ query: "mcp", maxChars: 499 }).success).toBe(false);
  });

  it("rejects ambiguous aliases, unsupported batch fields, and incomplete cookies", () => {
    expect(BrowserActionSchema.safeParse({ action: "click", target: "#a", selector: "#b" }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "input", target: "#a", text: "x", clear: true, append: true }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "wait_for_text", text: "a", query: "b" }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "wait_for_url", url: "https://example.com", value: "*" }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "set_cookie", cookieName: "session", cookieValue: "a", value: "b" }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "set_storage", storageKey: "key", storageValue: "a", value: "b" }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "save_as_pdf", outputPath: "/tmp/a.pdf", filePath: "/tmp/b.pdf" }).success).toBe(false);
    expect(ExtractRequestSchema.safeParse({ selector: "body", query: "title" }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "wait", milliseconds: 0, provider: "openai" }).success).toBe(false);
    expect(CookieRequestSchema.safeParse({ operation: "set", name: "session" }).success).toBe(false);
    expect(CookieRequestSchema.safeParse({ operation: "delete" }).success).toBe(false);
  });

  it("validates required fields for batched actions at the second trust boundary", () => {
    expect(BrowserActionSchema.safeParse({ action: "navigate" }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "input", index: 0 }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "input", index: 0, text: "" }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ action: "send_keys", key: "Enter", keys: ["Escape"] }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "alert_send_keys" }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "alert_send_keys", text: "okay" }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ action: "send_keys", keys: [" "] }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ action: "press_and_hold", target: "#drag", endCoordinateX: 10 }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "press_and_hold", target: "#drag", endCoordinateX: 10, endCoordinateY: 20 }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ action: "press_and_hold", selector: "#canvas", path: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ action: "press_and_hold", selector: "#canvas", path: [{ x: 1, y: 1 }, { x: 2, y: 2 }], endCoordinateX: 3, endCoordinateY: 3 }).success).toBe(false);
    expect(BrowserActionInputSchema.safeParse({ action: "dialog", operation: "send_keys" }).success).toBe(false);
    expect(BrowserActionInputSchema.safeParse({ action: "dialog", operation: "send_keys", text: "okay" }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ action: "find_elements", selector: "button", index: 0 }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "run_script", script: "[]" }).success).toBe(true);
  });

  it("validates explicit action plans before execution", () => {
    expect(BrowserActionPlanSchema.safeParse([{ action: "wait" }]).success).toBe(true);
    expect(BrowserActionPlanSchema.safeParse([{ action: "run_script", script: "[]" }]).success).toBe(false);
    expect(BrowserActionPlanSchema.safeParse([{ action: "screenshot" }]).success).toBe(false);
    expect(BrowserActionPlanSchema.safeParse([{ action: "close_browser" }, { action: "wait" }]).success).toBe(false);
  });

  it("requires explicit confirmation for destructive batches", () => {
    const action = { action: "clear_storage", storageAll: true };
    expect(BatchRequestSchema.safeParse({ actions: [action] }).success).toBe(false);
    expect(BatchRequestSchema.safeParse({ actions: [action], confirmDestructive: true }).success).toBe(true);
    for (const actionName of ["evaluate", "clear_network_log", "getclear_network_log", "clear_console_log", "getclear_console_log"] as const) {
      const action = actionName === "evaluate" ? { action: actionName, code: "1 + 1" } : { action: actionName };
      expect(BatchRequestSchema.safeParse({ actions: [action] }).success).toBe(false);
      expect(BatchRequestSchema.safeParse({ actions: [action], confirmDestructive: true }).success).toBe(true);
    }
    expect(BatchRequestSchema.safeParse({ actions: [{ action: "save_as_pdf", outputPath: "/tmp/page.pdf" }] }).success).toBe(false);
    expect(BatchRequestSchema.safeParse({ actions: [{ action: "save_as_pdf", outputPath: "/tmp/page.pdf" }], confirmDestructive: true }).success).toBe(true);
  });

  it("normalizes canonical, standalone, and grouped batch aliases before validation", () => {
    const aliases = BrowserActionInputSchema.safeParse({ action: "key", key: "Enter", tab_id: "tab-1" });
    expect(aliases.success).toBe(true);
    expect(aliases.success && aliases.data).toMatchObject({ action: "send_keys", key: "Enter", pageId: "tab-1" });

    const grouped = BatchRequestSchema.safeParse({ confirmDestructive: true, actions: [
      { action: "cookie", operation: "set", name: "session", value: "safe", url: "https://example.com" },
      { action: "storage", operation: "get", area: "session", key: "theme" },
      { action: "dialog", operation: "get_text" },
      { action: "network_log", operation: "enable" },
      { action: "console", operation: "read" },
    ] });
    expect(grouped.success).toBe(true);
    expect(grouped.success && grouped.data.actions.map((action) => action.action)).toEqual([
      "set_cookie", "get_storage", "alert_get_text", "enable_network_log", "get_console_log",
    ]);
    expect(grouped.success && grouped.data.actions[0]).toMatchObject({ cookieName: "session", cookieValue: "safe" });
    expect(grouped.success && grouped.data.actions[1]).toMatchObject({ storageArea: "session", storageKey: "theme" });
  });

  it("reports conflicting aliases with the field names before execution", () => {
    const result = BatchRequestSchema.safeParse({ actions: [{ action: "cookie", operation: "set", name: "session", cookieName: "canonical", value: "safe" }] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes("cookieName") && issue.message.includes("name"))).toBe(true);
      expect(result.error.issues.some((issue) => issue.path.includes(0))).toBe(true);
    }
  });
});
