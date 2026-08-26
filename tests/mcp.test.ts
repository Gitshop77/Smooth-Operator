import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import { createMcpServer } from "@/server/mcp";
import { ServerRuntime } from "@/server/runtime";
import { AppError } from "@/server/errors";

import { testConfig } from "./helpers";

const EXPECTED_READ_ONLY_TOOLS = new Set([
  "browser_snapshot",
  "browser_tabs",
  "browser_list_tabs",
  "browser_list_sessions",
  "browser_get_state",
  "browser_get_html",
  "browser_extract_content",
  "browser_wait",
  "browser_wait_for_element",
  "browser_wait_for_text",
  "browser_wait_for_url",
  "browser_wait_for_network_idle",
  "browser_extract",
  "browser_screenshot",
  "browser_downloads",
  "browser_dropdown_options",
  "browser_page_next",
  "browser_search_page",
  "browser_find_text",
  "browser_find_elements",
  "browser_interactive",
  "browser_frames",
  "browser_accessibility_snapshot",
  "browser_computed_style",
  "browser_page_info",
  "browser_challenge",
  "browser_wait_for_human",
  "web_search",
  "server_health",
  "browser_doctor",
]);

// Browser operations cross the page/browser/network boundary and therefore
// advertise open-world behavior.  These tools only report or control native
// server session state, so they remain deliberately closed-world.
const CLOSED_WORLD_TOOLS = new Set(["server_health", "browser_doctor", "browser_list_sessions", "browser_close_session"]);

describe("native MCP registry", () => {
  it("completes a real MCP handshake and exposes only native server capabilities", async () => {
    const runtime = await ServerRuntime.create(testConfig());
    vi.spyOn(runtime, "webSearch").mockResolvedValue({ results: [] });
    const server = createMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    const resources = await client.listResources();
    const resourceTemplates = await client.listResourceTemplates();
    const prompts = await client.listPrompts();

    expect(tools.tools).toHaveLength(60);
    expect(resources.resources).toHaveLength(6);
    expect(resourceTemplates.resourceTemplates).toHaveLength(1);
    expect(prompts.prompts).toHaveLength(4);

    const toolNames = new Set(tools.tools.map((tool) => tool.name));
    for (const name of [
      "browser_navigate", "browser_click", "browser_type", "browser_get_state",
      "browser_extract_content", "browser_get_html", "browser_screenshot", "browser_scroll",
      "browser_go_back", "browser_list_tabs", "browser_switch_tab", "browser_close_tab",
      "browser_list_sessions", "browser_close_session", "browser_close_all",
      "browser_exec",
    ]) {
      expect(toolNames.has(name), `${name} must remain in the browser-use parity surface`).toBe(true);
    }
    expect(toolNames.has("browser_snapshot")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "browser_get_state")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "browser_get_html")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "browser_extract_content")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "browser_close")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "browser_evaluate")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "browser_exec")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "retry_with_browser_use_agent")).toBe(false);
    expect(tools.tools.some((tool) => tool.name === "browser_frames")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "browser_accessibility_snapshot")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "agent_run")).toBe(false);
    expect(tools.tools.some((tool) => tool.name === "provider_config")).toBe(false);
    expect(resources.resources.map((resource) => resource.uri)).toContain("smooth-operator://server/capabilities");
    expect(resourceTemplates.resourceTemplates.map((resource) => resource.uriTemplate)).toContain("smooth-operator://browser/page/{pageId}");
    expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(expect.arrayContaining(["browser-workflow", "extract-page", "agent-chrome-setup"]));

    const toolByName = new Map(tools.tools.map((tool) => [tool.name, tool]));
    const missingReadOnlyTools = [...EXPECTED_READ_ONLY_TOOLS].filter((name) => !toolByName.has(name));
    expect(missingReadOnlyTools, "expected read-only tools missing from tools/list").toEqual([]);
    const unannotatedReadOnlyTools = [...EXPECTED_READ_ONLY_TOOLS].filter((name) => !isReadOnly(toolByName.get(name)));
    expect(unannotatedReadOnlyTools, "read-only tools missing readOnlyHint=true").toEqual([]);
    const mislabeledReadOnlyTools = tools.tools
      .filter((tool) => !EXPECTED_READ_ONLY_TOOLS.has(tool.name) && isReadOnly(tool))
      .map((tool) => tool.name)
      .sort();
    expect(mislabeledReadOnlyTools, "mutating tools must not advertise readOnlyHint=true").toEqual([]);

    const openWorldViolations = tools.tools
      .filter((tool) => (tool.name.startsWith("browser_") || tool.name === "web_search") && !CLOSED_WORLD_TOOLS.has(tool.name))
      .filter((tool) => tool.annotations?.openWorldHint !== true)
      .map((tool) => tool.name)
      .sort();
    expect(openWorldViolations, "browser-facing tools must advertise openWorldHint=true").toEqual([]);
    for (const name of CLOSED_WORLD_TOOLS) {
      expect(toolByName.get(name)?.annotations?.openWorldHint, `${name} is local session/server state`).toBe(false);
    }

    const schemaText = [...toolByName.values()].map((tool) => JSON.stringify(tool.inputSchema)).join("\n");
    expect(schemaText).not.toContain('"mode"');
    expect(schemaText).not.toContain('"model"');
    expect(schemaText).not.toContain('"provider"');
    expect(schemaText).not.toContain('"allowed_domains"');
    expect(schemaText).not.toContain('"allowedDomains"');
    expect(schemaText).not.toContain('"use_vision"');
    expect(schemaText).not.toContain('"useVision"');
    expect(hasRequiredBranch(toolByName.get("browser_click")?.inputSchema, "target")).toBe(true);
    expect(hasRequiredBranch(toolByName.get("browser_click")?.inputSchema, "ref")).toBe(true);
    expect(hasRequiredBranch(toolByName.get("browser_click")?.inputSchema, "coordinateX")).toBe(true);
    expect(hasRequiredBranch(toolByName.get("browser_input")?.inputSchema, "selector")).toBe(true);
    expect(hasRequiredBranch(toolByName.get("browser_switch_tab")?.inputSchema, "pageId")).toBe(true);
    expect(hasRequiredBranch(toolByName.get("browser_switch_tab")?.inputSchema, "tab_id")).toBe(true);
    expect(JSON.stringify(toolByName.get("browser_press_and_hold")?.inputSchema)).toContain("durationMs");
    expect(toolByName.get("browser_press_and_hold")?.description).toContain("endCoordinateX");
    expect(toolByName.get("browser_press_and_hold")?.description).toContain("path");
    expect(toolByName.has("browser_move")).toBe(true);
    expect(toolByName.get("browser_get_state")?.annotations?.readOnlyHint).toBe(true);
    expect(toolByName.get("browser_get_state")?.annotations?.openWorldHint).toBe(true);
    expect(toolByName.get("browser_get_state")?.annotations?.idempotentHint).toBeUndefined();
    expect(toolByName.get("browser_get_state")?.annotations?.destructiveHint).toBeUndefined();
    expect(toolByName.get("browser_get_html")?.annotations?.readOnlyHint).toBe(true);
    expect(toolByName.get("browser_get_html")?.annotations?.openWorldHint).toBe(true);
    expect(toolByName.get("browser_click")?.description).toContain("ref");
    expect(toolByName.get("browser_extract")?.description).toContain("truncated");
    expect(toolByName.get("browser_page_next")?.description).toContain("hasMore");
    expect(toolByName.get("browser_find_text")?.annotations?.readOnlyHint).toBe(true);
    expect(toolByName.get("browser_find_text")?.annotations?.destructiveHint).toBeUndefined();
    expect(toolByName.get("browser_find_text")?.annotations?.openWorldHint).toBe(true);
    expect(toolByName.get("browser_type")?.annotations?.readOnlyHint).not.toBe(true);
    expect(toolByName.get("browser_type")?.annotations?.openWorldHint).toBe(true);
    expect(toolByName.get("web_search")?.annotations?.openWorldHint).toBe(true);
    for (const name of ["browser_network_log", "browser_console_log", "browser_cookies", "browser_storage", "browser_evaluate", "browser_batch", "browser_exec"]) {
      expect(toolByName.get(name)?.annotations?.destructiveHint, `${name} must advertise destructive capability`).toBe(true);
      expect(toolByName.get(name)?.annotations?.openWorldHint, `${name} must advertise external scope`).toBe(true);
    }
    expect(toolByName.get("browser_pdf")?.annotations?.destructiveHint).toBe(true);
    expect(toolByName.get("browser_pdf")?.annotations?.openWorldHint).toBe(true);

    const health = await client.callTool({ name: "server_health", arguments: {} });
    expect(health.isError).not.toBe(true);
    expect(JSON.stringify(health)).toContain('"status":"ok"');
    expect(health.structuredContent).toMatchObject({ status: "ok" });
    const doctor = await client.callTool({ name: "browser_doctor", arguments: {} });
    expect(doctor.isError).not.toBe(true);
    expect(doctor.structuredContent).toMatchObject({ endpoint: { state: "no-file" } });

    const rejectedOverride = await client.callTool({ name: "browser_evaluate", arguments: { code: "1 + 1", mode: "full" } });
    expect(rejectedOverride.isError).toBe(true);
    expect(JSON.stringify(rejectedOverride)).toContain("Unrecognized key");
    const denied = await client.callTool({ name: "browser_evaluate", arguments: { code: "1 + 1" } });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("EVALUATE_DISABLED");
    expect(denied.structuredContent).toMatchObject({ ok: false, error: { code: "EVALUATE_DISABLED", retryable: false } });

    const missingDialogText = await client.callTool({ name: "browser_dialog", arguments: { operation: "send_keys" } });
    expect(missingDialogText.isError).toBe(true);
    expect(JSON.stringify(missingDialogText)).toContain("requires text");
    const unexpectedDialogText = await client.callTool({ name: "browser_dialog", arguments: { operation: "get_text", text: "ignored" } });
    expect(unexpectedDialogText.isError).toBe(true);
    expect(JSON.stringify(unexpectedDialogText)).toContain("does not accept text");

    const invalidProgram = await client.callTool({ name: "browser_exec", arguments: { code: "not-json" } });
    expect(invalidProgram.isError).toBe(true);
    expect(JSON.stringify(invalidProgram)).toContain("JSON array");
    const arbitraryProgram = await client.callTool({ name: "browser_exec", arguments: { code: "print('not allowed')" } });
    expect(arbitraryProgram.isError).toBe(true);
    expect(JSON.stringify(arbitraryProgram)).toContain("JSON array");
    for (const arguments_ of [
      { operation: "send_keys" },
      { operation: "get_text", text: "unexpected" },
      { operation: "accept", text: "unexpected" },
      { operation: "dismiss", text: "unexpected" },
    ]) {
      const invalidDialog = await client.callTool({ name: "browser_dialog", arguments: arguments_ });
      expect(invalidDialog.isError).toBe(true);
      expect(JSON.stringify(invalidDialog)).toContain("Dialog");
    }
    const unconfirmedEvaluationPlan = await client.callTool({ name: "browser_batch", arguments: { actions: [{ action: "evaluate", code: "1 + 1" }] } });
    expect(unconfirmedEvaluationPlan.isError).toBe(true);
    expect(JSON.stringify(unconfirmedEvaluationPlan)).toContain("confirmDestructive");
    const unconfirmedExecPlan = await client.callTool({ name: "browser_exec", arguments: { code: JSON.stringify([{ action: "evaluate", code: "1 + 1" }]) } });
    expect(unconfirmedExecPlan.isError).toBe(true);
    expect(JSON.stringify(unconfirmedExecPlan)).toContain("confirmDestructive");
    const capabilityResource = await client.readResource({ uri: "smooth-operator://server/capabilities" });
    expect(JSON.stringify(capabilityResource)).toContain("Model Context Protocol");

    // Exercise the protocol-facing callback boundary for every native tool
    // with bounded, syntactically valid arguments. Browser access is disabled
    // in this fixture, so browser calls fail closed without launching Chrome;
    // the purpose here is registry/schema/annotation/serialization coverage.
    const calls: Array<[string, Record<string, unknown>]> = [
      ["browser_snapshot", {}], ["browser_tabs", {}], ["browser_list_tabs", {}], ["browser_get_state", {}], ["browser_doctor", {}],
      ["browser_list_sessions", {}], ["browser_close_session", { session_id: "missing" }],
      ["browser_type", { index: 0, text: "x" }], ["browser_get_html", {}], ["browser_extract_content", { query: "body" }],
      ["browser_navigate", { url: "http://127.0.0.1" }], ["browser_click", { target: "#x" }],
      ["browser_input", { target: "#x", text: "x" }], ["browser_select", { selector: "select", optionValue: "x" }],
      ["browser_scroll", {}], ["browser_scroll_to_bottom", {}], ["browser_key", { keys: ["Enter"] }],
      ["browser_switch_tab", { pageId: "missing" }], ["browser_close_tab", { pageId: "missing" }],
      ["browser_back", {}], ["browser_go_back", {}], ["browser_forward", {}], ["browser_reload", {}], ["browser_close", {}], ["browser_close_all", {}],
      ["browser_wait", { milliseconds: 0 }], ["browser_wait_for_element", { selector: "#x" }],
      ["browser_wait_for_text", { text: "x" }], ["browser_wait_for_url", { url: "*" }], ["browser_wait_for_network_idle", {}],
      ["browser_network_log", { operation: "read" }], ["browser_console_log", { operation: "read" }],
      ["browser_find_text", { query: "x" }], ["browser_extract", {}], ["browser_extract_content", { query: "body", extract_links: true }],
      ["browser_upload", { selector: "input[type=file]", filePath: "/tmp/smooth-operator-test/file.txt" }],
      ["browser_screenshot", {}], ["browser_pdf", { outputPath: "/tmp/smooth-operator-test/page.pdf" }], ["browser_downloads", {}],
      ["browser_dropdown_options", { selector: "select" }], ["browser_page_next", {}], ["browser_search_page", { query: "x" }],
      ["browser_find_elements", { selector: "button" }], ["browser_interactive", {}], ["browser_computed_style", { selector: "body" }],
      ["browser_frames", {}], ["browser_accessibility_snapshot", {}],
      ["browser_page_info", {}], ["browser_hover", { target: "#x" }], ["browser_move", { coordinateX: 1, coordinateY: 1 }], ["browser_press_and_hold", { target: "#x" }],
      ["browser_press_and_hold", { target: "#x", durationMs: 10 }],
      ["browser_challenge", {}], ["browser_evaluate", { code: "1 + 1" }],
      ["browser_wait_for_human", { timeoutMs: 500 }],
      ["browser_exec", { code: JSON.stringify([{ action: "wait", milliseconds: 0 }]) }],
      ["browser_batch", { actions: [{ action: "wait", milliseconds: 0 }] }],
      ["browser_dialog", { operation: "get_text" }], ["browser_cookies", { operation: "get" }], ["browser_storage", { operation: "get" }],
      ["web_search", { query: "MCP", maxResults: 1, maxChars: 500 }],
    ];
    for (const [name, arguments_] of calls) {
      await expect(client.callTool({ name, arguments: arguments_ })).resolves.toBeDefined();
    }
    const exercisedToolNames = new Set(calls.map(([name]) => name));
    exercisedToolNames.add("server_health");
    expect([...toolNames].filter((name) => !exercisedToolNames.has(name)), "every registered tool must have a protocol call").toEqual([]);

    // Every discovered tool also receives a schema-invalid call. This keeps
    // the coverage matrix tied to tools/list instead of silently drifting as
    // tools are added or renamed.
    for (const name of toolNames) {
      const invalid = await client.callTool({ name, arguments: { __smooth_operator_invalid_field__: "invalid" } });
      expect(invalid.isError, `${name} must reject an unknown input field`).toBe(true);
    }

    for (const uri of [
      "smooth-operator://browser/tabs",
      "smooth-operator://browser/page/current",
      "smooth-operator://browser/downloads",
      "smooth-operator://browser/logs/network",
      "smooth-operator://browser/logs/console",
    ]) {
      await expect(client.readResource({ uri })).rejects.toBeDefined();
    }
    await expect(client.readResource({ uri: `smooth-operator://browser/page/${"x".repeat(201)}` })).rejects.toBeDefined();
    await expect(client.getPrompt({ name: "browser-workflow", arguments: { task: "inspect" } })).resolves.toBeDefined();
    await expect(client.getPrompt({ name: "extract-page", arguments: { question: "what?" } })).resolves.toBeDefined();
    await expect(client.getPrompt({ name: "research-question", arguments: { question: "what?" } })).resolves.toBeDefined();
    await expect(client.getPrompt({ name: "agent-chrome-setup", arguments: {} })).resolves.toBeDefined();

    await client.close();
    await server.close();
    await runtime.close();
  });

  it("forwards the MCP request signal to live resource operations", async () => {
    const runtime = await ServerRuntime.create(testConfig());
    const resourceSignals: AbortSignal[] = [];
    vi.spyOn(runtime, "listTabs").mockImplementation(async (signal) => {
      if (signal) resourceSignals.push(signal);
      return [];
    });
    vi.spyOn(runtime, "snapshot").mockImplementation(async (_options, signal) => {
      if (signal) resourceSignals.push(signal);
      return {} as Awaited<ReturnType<ServerRuntime["snapshot"]>>;
    });
    vi.spyOn(runtime, "run").mockImplementation(async (_action, signal) => {
      if (signal) resourceSignals.push(signal);
      return {};
    });

    const server = createMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-signal-test", version: "1.0.0" });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      for (const uri of [
        "smooth-operator://browser/tabs",
        "smooth-operator://browser/page/current",
        "smooth-operator://browser/downloads",
        "smooth-operator://browser/logs/network",
        "smooth-operator://browser/logs/console",
        "smooth-operator://browser/page/page-1",
      ]) {
        await client.readResource({ uri }, { cacheMode: "bypass" });
      }

      expect(resourceSignals).toHaveLength(6);
      expect(resourceSignals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await runtime.close();
    }
  });

  it("forwards request signals through control-plane tools", async () => {
    const runtime = await ServerRuntime.create(testConfig());
    const listTabs = vi.spyOn(runtime, "listTabs").mockResolvedValue([]);
    const closeSession = vi.spyOn(runtime, "closeSession").mockResolvedValue({ closed: true, session_id: "session" });
    const server = createMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "control-signal-test", version: "1.0.0" });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      await client.callTool({ name: "browser_tabs", arguments: {} });
      await client.callTool({ name: "browser_close_session", arguments: { session_id: "session" } });
      expect(listTabs.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
      expect(closeSession.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await runtime.close();
    }
  });

  it("rejects visual payloads that exceed the MCP image budget", async () => {
    const runtime = await ServerRuntime.create(testConfig());
    vi.spyOn(runtime, "run").mockResolvedValue({
      screenshotBase64: "A".repeat(11_000_000),
      mimeType: "image/png",
    });
    const server = createMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "image-budget-test", version: "1.0.0" });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: "browser_screenshot", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: false, error: { code: "OUTPUT_TOO_LARGE" } });
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await runtime.close();
    }
  });

  it("does not expose runtime exception text from resource failures", async () => {
    const runtime = await ServerRuntime.create(testConfig());
    vi.spyOn(runtime, "snapshot").mockRejectedValue(new Error("ENOENT /Users/wasd/private/session-token"));
    const server = createMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-error-test", version: "1.0.0" });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const error = await client.readResource({ uri: "smooth-operator://browser/page/current" }, { cacheMode: "bypass" }).then(
        () => undefined,
        (cause: unknown) => cause as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain("The requested MCP resource could not be read.");
      expect(error?.message).not.toContain("/Users/wasd/private/session-token");
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await runtime.close();
    }
  });

  it("preserves browser-use refs, indexes, coordinate aliases, and type semantics", async () => {
    const runtime = await ServerRuntime.create(testConfig());
    const run = vi.spyOn(runtime, "run").mockResolvedValue({ clicked: true });
    const server = createMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ref-normalization-test", version: "1.0.0" });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: "browser_click", arguments: { ref: "e5" } });
      expect(result.isError).not.toBe(true);
      expect(run.mock.calls[0]?.[0]).toMatchObject({ action: "click", target: "e5" });

      const prefixed = await client.callTool({ name: "browser_click", arguments: { ref: "ref:e5" } });
      expect(prefixed.isError).not.toBe(true);
      expect(run.mock.calls[1]?.[0]).toMatchObject({ action: "click", target: "ref:e5" });

      const indexed = await client.callTool({ name: "browser_click", arguments: { index: 4 } });
      expect(indexed.isError).not.toBe(true);
      expect(run.mock.calls[2]?.[0]).toMatchObject({ action: "click", index: 4 });

      const coordinates = await client.callTool({ name: "browser_click", arguments: { coordinate_x: 10, coordinate_y: 20 } });
      expect(coordinates.isError).not.toBe(true);
      expect(run.mock.calls[3]?.[0]).toMatchObject({ action: "click", coordinateX: 10, coordinateY: 20 });

      const typed = await client.callTool({ name: "browser_type", arguments: { index: 2, text: "hello" } });
      expect(typed.isError).not.toBe(true);
      expect(run.mock.calls[4]?.[0]).toMatchObject({ action: "input", index: 2, text: "hello" });

      await client.callTool({ name: "browser_switch_tab", arguments: { tab_id: "tab-2" } });
      expect(run.mock.calls[5]?.[0]).toEqual({ action: "switch_tab", pageId: "tab-2" });

      await client.callTool({ name: "browser_close_tab", arguments: { tab_id: "tab-2" } });
      expect(run.mock.calls[6]?.[0]).toEqual({ action: "close_tab", pageId: "tab-2" });
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await runtime.close();
    }
  });

  it("keeps unexpected tool errors bounded while preserving a stable envelope", async () => {
    const runtime = await ServerRuntime.create(testConfig());
    vi.spyOn(runtime, "run").mockRejectedValue(new Error(`Bearer abcdefghijklmnop ${"x".repeat(60_000)}`));
    const server = createMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "error-budget-test", version: "1.0.0" });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: "browser_wait", arguments: { milliseconds: 0 } });
      expect(result.isError).toBe(true);
      const structured = result.structuredContent as { ok: boolean; error: { code: string; message: string } };
      expect(structured).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
      expect(structured.error.message).not.toContain("abcdefghijklmnop");
      expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(10_000);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await runtime.close();
    }
  });

  it("keeps oversized extraction records below the client JSON budget with explicit omission flags", async () => {
    const runtime = await ServerRuntime.create(testConfig());
    const run = vi.spyOn(runtime, "run").mockResolvedValue({
      text: `<untrusted_extracted_text>${"page evidence ".repeat(10_000)}</untrusted_extracted_text>`,
      links: Array.from({ length: 100 }, (_, index) => ({
        text: `Observed link ${index}`,
        href: `https://example.test/result/${index}/${"x".repeat(4_000)}`,
      })),
    });
    const server = createMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bounded-output-test", version: "1.0.0" });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: "browser_extract", arguments: { query: "body", includeLinks: true, maxChars: 8_000 } });
      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.truncated).toBe(true);
      expect(structured.linksTruncated).toBe(true);
      expect(structured.mcpOutputTruncated).toBe(true);
      expect(JSON.stringify(structured)).toContain("[MCP_OUTPUT_TRUNCATED]");
      expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(65_536);
      expect(run.mock.calls[0]?.[0]).toMatchObject({ action: "extract", maxChars: 8_000 });

      run.mockResolvedValue(Array.from({ length: 100 }, () => ({ text: "element evidence ".repeat(1_000) })));
      const arrayResult = await client.callTool({ name: "browser_find_elements", arguments: { selector: "div" } });
      expect(arrayResult.isError).not.toBe(true);
      expect((arrayResult.structuredContent as Record<string, unknown>).truncated).toBe(true);
      expect(new TextEncoder().encode(JSON.stringify(arrayResult)).byteLength).toBeLessThan(65_536);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await runtime.close();
    }
  });

  it("preserves small batch results and bounds only the oversized tail", async () => {
    const runtime = await ServerRuntime.create(testConfig());
    const runBatch = vi.spyOn(runtime, "runBatch").mockResolvedValue({ results: Array.from({ length: 50 }, (_, index) => ({ index, ok: true })) });
    const server = createMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "batch-output-test", version: "1.0.0" });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const small = await client.callTool({ name: "browser_batch", arguments: { actions: [{ action: "wait", milliseconds: 0 }] } });
      expect(small.isError).not.toBe(true);
      expect((small.structuredContent as { results: unknown[] }).results).toHaveLength(50);
      expect(runBatch.mock.calls[0]?.[0]).toHaveLength(1);

      runBatch.mockResolvedValue({ results: Array.from({ length: 50 }, (_, index) => ({ index, evidence: "x".repeat(2_000) })) });
      const large = await client.callTool({ name: "browser_batch", arguments: { actions: [{ action: "wait", milliseconds: 0 }] } });
      expect(large.isError).not.toBe(true);
      expect(large.structuredContent).toMatchObject({ resultsTruncated: true, mcpOutputTruncated: true, omittedResults: expect.any(Number) });
      expect(new TextEncoder().encode(JSON.stringify(large)).byteLength).toBeLessThan(65_536);

      runBatch.mockRejectedValue(new AppError("ACTION_FAILED", "The action failed.", {
        details: { failedIndex: 3, failedAction: "click", completedActions: 3, completedResults: [{ ok: true }] },
      }));
      const failed = await client.callTool({ name: "browser_batch", arguments: { actions: [{ action: "wait", milliseconds: 0 }] } });
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toMatchObject({ ok: false, error: { details: { failedIndex: 3, failedAction: "click", completedActions: 3 } } });

      runBatch.mockRejectedValue(new AppError("ACTION_FAILED", "The action failed.", {
        details: {
          failedIndex: 49,
          failedAction: "click",
          completedActions: 49,
          completedResults: Array.from({ length: 49 }, (_, index) => ({ index, evidence: "x".repeat(500) })),
        },
      }));
      const largeFailure = await client.callTool({ name: "browser_batch", arguments: { actions: [{ action: "wait", milliseconds: 0 }] } });
      expect(largeFailure.isError).toBe(true);
      expect(largeFailure.structuredContent).toMatchObject({
        ok: false,
        error: { details: { failedIndex: 49, failedAction: "click", completedActions: 49, completedResults: expect.any(Array), resultsTruncated: true } },
      });
      expect(new TextEncoder().encode(JSON.stringify(largeFailure)).byteLength).toBeLessThan(65_536);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await runtime.close();
    }
  });
});

function isReadOnly(tool: { annotations?: { readOnlyHint?: boolean } } | undefined): boolean {
  return tool?.annotations?.readOnlyHint === true;
}

function hasRequiredBranch(schema: unknown, field: string): boolean {
  if (!schema || typeof schema !== "object") {
    return false;
  }
  const record = schema as Record<string, unknown>;
  if (Array.isArray(record.required) && record.required.includes(field)) {
    return true;
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branches = record[key];
    if (Array.isArray(branches) && branches.some((branch) => hasRequiredBranch(branch, field))) {
      return true;
    }
  }
  return false;
}
