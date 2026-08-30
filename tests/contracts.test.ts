import { describe, expect, it } from "vitest";

import { BatchRequestSchema, BrowserActionInputSchema, BrowserActionPlanSchema, BrowserActionSchema, ClickRequestSchema, CookieRequestSchema, EvaluateRequestSchema, ExtractRequestSchema, HtmlRequestSchema, InspectElementRequestSchema, InputRequestSchema, NavigateRequestSchema, NetworkSearchRequestSchema, ResearchRequestSchema, ResourceBlockingRequestSchema, ScreenshotRequestSchema, SnapshotRequestSchema, SolveChallengeRequestSchema, StorageRequestSchema, TargetRequestSchema, UploadRequestSchema } from "@/server/contracts";

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

  it("validates page-scoped resource blocking operations", () => {
    expect(ResourceBlockingRequestSchema.safeParse({ operation: "get", pageId: "page-1" }).success).toBe(true);
    expect(ResourceBlockingRequestSchema.safeParse({ operation: "clear" }).success).toBe(true);
    expect(ResourceBlockingRequestSchema.safeParse({ operation: "set", resourceTypes: ["image", "stylesheet", "font", "media", "script"] }).success).toBe(true);
    expect(ResourceBlockingRequestSchema.safeParse({ operation: "set" }).success).toBe(false);
    expect(ResourceBlockingRequestSchema.safeParse({ operation: "set", resourceTypes: [] }).success).toBe(false);
    expect(ResourceBlockingRequestSchema.safeParse({ operation: "set", resourceTypes: ["image", "image"] }).success).toBe(false);
    expect(ResourceBlockingRequestSchema.safeParse({ operation: "set", resourceTypes: ["document"] }).success).toBe(false);
    expect(ResourceBlockingRequestSchema.safeParse({ operation: "get", resourceTypes: ["image"] }).success).toBe(false);
    expect(ResourceBlockingRequestSchema.safeParse({ operation: "clear", resourceTypes: ["image"] }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "resource_blocking", operation: "set", resourceTypes: ["image"] }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ action: "resource_blocking", operation: "get", resourceTypes: ["image"] }).success).toBe(false);
  });

  it("validates bounded element inspection targets and options", () => {
    expect(InspectElementRequestSchema.safeParse({ selector: "#card", maxDepth: 0, maxChildren: 100 }).success).toBe(true);
    expect(InspectElementRequestSchema.safeParse({ ref: "ref:e5", pageId: "page-1" }).success).toBe(true);
    expect(InspectElementRequestSchema.safeParse({ index: 0, frameId: "main" }).success).toBe(true);
    expect(InspectElementRequestSchema.safeParse({}).success).toBe(false);
    expect(InspectElementRequestSchema.safeParse({ selector: "#card", target: "#other" }).success).toBe(false);
    expect(InspectElementRequestSchema.safeParse({ selector: "#card", maxDepth: -1 }).success).toBe(false);
    expect(InspectElementRequestSchema.safeParse({ selector: "#card", maxDepth: 4 }).success).toBe(false);
    expect(InspectElementRequestSchema.safeParse({ selector: "#card", maxChildren: 0 }).success).toBe(false);
    expect(InspectElementRequestSchema.safeParse({ selector: "#card", maxChildren: 101 }).success).toBe(false);
    expect(InspectElementRequestSchema.safeParse({ selector: "#card", unexpected: true }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "inspect_element", selector: "#card", maxDepth: 3, maxChildren: 100 }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ action: "inspect_element" }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "find_elements", selector: "#card", maxDepth: 1 }).success).toBe(false);
  });

  it("accepts bounded network journal search filters", () => {
    expect(NetworkSearchRequestSchema.safeParse({ query: "checkout", requestId: "req-1", url: "https://example.test", method: "post", status: 200, resourceType: "Fetch", offset: 0, limit: 20, pageId: "page-1" }).success).toBe(true);
    expect(NetworkSearchRequestSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(NetworkSearchRequestSchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(NetworkSearchRequestSchema.safeParse({ status: 1_000 }).success).toBe(false);
    expect(NetworkSearchRequestSchema.safeParse({ query: "   " }).success).toBe(false);
    expect(NetworkSearchRequestSchema.safeParse({ headers: {} }).success).toBe(false);
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

  it("validates cookie scope and SameSite fields by operation", () => {
    expect(CookieRequestSchema.safeParse({ operation: "get", url: "https://example.test/account" }).success).toBe(true);
    expect(CookieRequestSchema.safeParse({ operation: "delete", name: "session", url: "https://example.test/account" }).success).toBe(true);
    for (const sameSite of ["Strict", "Lax", "None"]) {
      expect(CookieRequestSchema.safeParse({ operation: "set", name: "session", value: "safe", sameSite }).success).toBe(true);
      expect(BrowserActionSchema.safeParse({ action: "set_cookie", cookieName: "session", cookieValue: "safe", cookieSameSite: sameSite }).success).toBe(true);
    }
    expect(CookieRequestSchema.safeParse({ operation: "set", name: "session", value: "safe", sameSite: "lax" }).success).toBe(false);
    expect(CookieRequestSchema.safeParse({ operation: "get", sameSite: "Lax" }).success).toBe(false);
    expect(CookieRequestSchema.safeParse({ operation: "delete", name: "session", sameSite: "Lax" }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "get_cookies", cookieSameSite: "Lax" }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "delete_cookies", cookieName: "session", cookieSameSite: "Lax" }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "get_cookies", url: "javascript:alert(1)" }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "delete_cookies", cookieName: "session", url: "file:///etc/passwd" }).success).toBe(false);
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

  it("validates single and multi-file upload forms", () => {
    expect(UploadRequestSchema.safeParse({ selector: "input[type=file]", filePath: "/tmp/a.txt" }).success).toBe(true);
    expect(UploadRequestSchema.safeParse({ selector: "input[type=file]", filePaths: ["/tmp/a.txt", "/tmp/b.txt"] }).success).toBe(true);
    expect(UploadRequestSchema.safeParse({ selector: "input[type=file]", filePath: "/tmp/a.txt", filePaths: ["/tmp/b.txt"] }).success).toBe(false);
    expect(UploadRequestSchema.safeParse({ selector: "input[type=file]", filePaths: [] }).success).toBe(false);
    expect(UploadRequestSchema.safeParse({ selector: "input[type=file]", filePaths: Array.from({ length: 21 }, (_, index) => `/tmp/${index}.txt`) }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "upload_file", target: "input[type=file]", filePaths: ["/tmp/a.txt", "/tmp/b.txt"] }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ action: "upload_file", target: "input[type=file]", filePath: "/tmp/a.txt", filePaths: ["/tmp/b.txt"] }).success).toBe(false);
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
      { action: "cookie", operation: "set", name: "session", value: "safe", url: "https://example.com", sameSite: "Strict" },
      { action: "storage", operation: "get", area: "session", key: "theme" },
      { action: "dialog", operation: "get_text" },
      { action: "network_log", operation: "enable" },
      { action: "console", operation: "read" },
    ] });
    expect(grouped.success).toBe(true);
    expect(grouped.success && grouped.data.actions.map((action) => action.action)).toEqual([
      "set_cookie", "get_storage", "alert_get_text", "enable_network_log", "get_console_log",
    ]);
    expect(grouped.success && grouped.data.actions[0]).toMatchObject({ cookieName: "session", cookieValue: "safe", cookieSameSite: "Strict" });
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

  it("accepts the connected-AI solve_challenge evidence contract", () => {
    expect(SolveChallengeRequestSchema.safeParse({}).success).toBe(true);
    expect(SolveChallengeRequestSchema.safeParse({
      pageId: "p1",
      includeScreenshot: true,
      fullPage: true,
      maxDimension: 1_200,
      maxChars: 8_000,
      maxAttempts: 32,
    }).success).toBe(true);
    expect(SolveChallengeRequestSchema.safeParse({ pageId: "p1", full_page: true, max_dim: 1_200, include_screenshot: false }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ action: "solve_challenge" }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ action: "solve_challenge", pageId: "p1", provider: "capsolver" }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "solve_challenge", pageId: "p1", sitekey: "external" }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ action: "solve_challenge", pageId: "p1", proxyUrl: "https://proxy.example" }).success).toBe(false);
    expect(SolveChallengeRequestSchema.safeParse({ includeScreenshot: true, include_screenshot: false }).success).toBe(false);
    expect(SolveChallengeRequestSchema.safeParse({ fullPage: true, full: false }).success).toBe(false);
    expect(SolveChallengeRequestSchema.safeParse({ maxDimension: 20_001 }).success).toBe(false);
    expect(SolveChallengeRequestSchema.safeParse({ maxChars: 8_001 }).success).toBe(false);
    expect(SolveChallengeRequestSchema.safeParse({ __smooth_operator_invalid_field__: true }).success).toBe(false);
  });
});
