import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import {
  CLOSED_WORLD_TOOLS,
  MCP_INSTRUCTIONS,
  PROMPT_NAMES,
  PUBLIC_TOOL_COUNT,
  PUBLIC_TOOL_NAMES,
  RESOURCE_TEMPLATE_URIS,
  RESOURCE_URIS,
  RETIRED_TOOL_ROUTES,
  TOOL_ALIASES,
  aliasCanonical,
  assertCatalogInvariants,
  assertCatalogSize,
} from "@/server/catalog";
import { sanitizeMcpOutput } from "@/server/envelope";
import { createMcpServer } from "@/server/mcp";
import { ServerRuntime } from "@/server/runtime";

import { testConfig } from "./helpers";

describe("public MCP catalog", () => {
  it("locks the published tool, alias, resource, and prompt names", () => {
    assertCatalogSize();
    expect(PUBLIC_TOOL_COUNT).toBeLessThan(64);
    expect(PUBLIC_TOOL_NAMES).toHaveLength(PUBLIC_TOOL_COUNT);
    expect(new Set(PUBLIC_TOOL_NAMES).size).toBe(PUBLIC_TOOL_COUNT);
    expect(Object.values(TOOL_ALIASES).flat()).toEqual([
      "browser_list_tabs",
      "browser_get_state",
      "browser_type",
      "browser_extract_content",
      "browser_go_back",
      "browser_close_all",
      "browser_exec",
    ]);
    expect(aliasCanonical("browser_list_tabs")).toBe("browser_tabs");
    expect(aliasCanonical("browser_snapshot")).toBe("browser_snapshot");
    expect(aliasCanonical("browser_wait_for_element")).toBe("browser_wait_for_element");
    expect(aliasCanonical("browser_logs")).toBe("browser_network_log");
    expect(aliasCanonical("browser_unknown")).toBe("browser_unknown");
    expect(RESOURCE_URIS).toHaveLength(6);
    expect(RESOURCE_TEMPLATE_URIS).toEqual(["smooth-operator://browser/page/{pageId}"]);
    expect(PROMPT_NAMES).toEqual(["agent-chrome-setup", "browser-workflow", "extract-page", "research-question"]);
    expect(CLOSED_WORLD_TOOLS).toContain("server_health");
    expect(MCP_INSTRUCTIONS).toContain("The server has no internal LLM/planner.");
    expect(MCP_INSTRUCTIONS).toContain("observe -> act -> verify");
    expect(MCP_INSTRUCTIONS).toContain("final classification explicitly reports the challenge absent");
    expect(MCP_INSTRUCTIONS).toContain("internal connected-AI loop");
    expect(() => assertCatalogInvariants(64, PUBLIC_TOOL_NAMES, TOOL_ALIASES, RETIRED_TOOL_ROUTES)).toThrow(/under 64/);
    expect(() => assertCatalogInvariants(PUBLIC_TOOL_COUNT, [...PUBLIC_TOOL_NAMES, "browser_extra"], TOOL_ALIASES, RETIRED_TOOL_ROUTES)).toThrow(/drifted/);
    expect(() => assertCatalogInvariants(PUBLIC_TOOL_COUNT, [...PUBLIC_TOOL_NAMES.slice(0, -1), PUBLIC_TOOL_NAMES[0]!], TOOL_ALIASES, RETIRED_TOOL_ROUTES)).toThrow(/duplicates/);
    expect(() => assertCatalogInvariants(PUBLIC_TOOL_COUNT, PUBLIC_TOOL_NAMES, { browser_tabs: ["browser_list_tabs"] }, RETIRED_TOOL_ROUTES)).toThrow(/alias list drifted/);
    expect(() => assertCatalogInvariants(PUBLIC_TOOL_COUNT, PUBLIC_TOOL_NAMES, { browser_missing: Object.values(TOOL_ALIASES).flat() as string[] }, RETIRED_TOOL_ROUTES)).toThrow(/missing from tools\/list/);
    expect(() => assertCatalogInvariants(PUBLIC_TOOL_COUNT, PUBLIC_TOOL_NAMES, { browser_tabs: ["browser_snapshot", ...Object.values(TOOL_ALIASES).flat().slice(1)] }, RETIRED_TOOL_ROUTES)).toThrow(/must not appear in tools\/list/);
    expect(() => assertCatalogInvariants(PUBLIC_TOOL_COUNT, PUBLIC_TOOL_NAMES, TOOL_ALIASES, { browser_tabs: { tool: "browser_tabs" } })).toThrow(/Retired tool browser_tabs/);
    expect(() => assertCatalogInvariants(PUBLIC_TOOL_COUNT, PUBLIC_TOOL_NAMES, TOOL_ALIASES, { browser_list_tabs: { tool: "browser_missing" } })).toThrow(/missing canonical/);
  });

  it("matches live tools/list, resources, and prompts to the catalog", async () => {
    const runtime = await ServerRuntime.create(testConfig());
    const server = createMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "catalog-lock-test", version: "1.0.0" });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const [tools, resources, resourceTemplates, prompts] = await Promise.all([
        client.listTools(),
        client.listResources(),
        client.listResourceTemplates(),
        client.listPrompts(),
      ]);
      expect(tools.tools.map((tool) => tool.name)).toEqual([...PUBLIC_TOOL_NAMES]);
      expect(tools.tools).toHaveLength(PUBLIC_TOOL_COUNT);
      expect(resources.resources.map((resource) => resource.uri)).toEqual([...RESOURCE_URIS]);
      expect(resourceTemplates.resourceTemplates.map((resource) => resource.uriTemplate)).toEqual([...RESOURCE_TEMPLATE_URIS]);
      expect(prompts.prompts.map((prompt) => prompt.name)).toEqual([...PROMPT_NAMES]);
      for (const tool of tools.tools) {
        expect(tool.title).not.toContain("Compatibility alias");
        expect(tool.description).not.toContain("Compatibility alias");
      }
      for (const alias of Object.values(TOOL_ALIASES).flat()) {
        expect(tools.tools.some((tool) => tool.name === alias)).toBe(false);
      }
      for (const name of ["browser_wait", "browser_challenge", "browser_scroll"]) {
        const schema = tools.tools.find((tool) => tool.name === name)?.inputSchema as { properties?: Record<string, unknown> };
        expect(schema.properties?.operation).toBeUndefined();
        expect(schema.properties?.to).toBeUndefined();
        expect(schema.properties?.source).toBeUndefined();
      }
      for (const [name, operations] of [
        ["browser_cookies", ["get", "set", "delete"]],
        ["browser_storage", ["get", "set", "clear"]],
        ["browser_dialog", ["get_text", "accept", "dismiss", "send_keys"]],
        ["browser_resource_blocking", ["get", "set", "clear"]],
        ["browser_network_log", ["enable", "disable", "read", "clear", "read_and_clear"]],
        ["browser_console_log", ["enable", "disable", "read", "clear", "read_and_clear"]],
      ] as const) {
        const schema = tools.tools.find((tool) => tool.name === name)?.inputSchema as { properties?: { operation?: { enum?: string[] } } };
        expect(schema.properties?.operation?.enum).toEqual([...operations]);
      }
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await runtime.close();
    }
  });

  it("maps every retired name to a canonical tool the handler accepts", async () => {
    const runtime = await ServerRuntime.create(testConfig());
    const server = createMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "retired-route-test", version: "1.0.0" });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const tools = await client.listTools();
      const listed = new Set(tools.tools.map((tool) => tool.name));
      for (const [retired, route] of Object.entries(RETIRED_TOOL_ROUTES)) {
        expect(listed.has(retired), `${retired} must not remain in tools/list`).toBe(false);
        expect(listed.has(route.tool), `${retired} must map to listed ${route.tool}`).toBe(true);
        await expect(client.callTool({ name: route.tool, arguments: route.arguments })).resolves.toBeDefined();
      }
      const startOfGoal = [
        "browser_snapshot", "browser_tabs", "browser_list_sessions", "browser_close_session", "browser_get_html",
        "browser_navigate", "browser_click", "browser_input", "browser_select", "browser_scroll", "browser_key",
        "browser_switch_tab", "browser_close_tab", "browser_back", "browser_forward", "browser_reload", "browser_close",
        "browser_wait", "browser_logs", "browser_resource_blocking", "browser_find_text", "browser_extract",
        "browser_upload", "browser_screenshot", "browser_pdf", "browser_downloads", "browser_dropdown_options",
        "browser_page_next", "browser_search_page", "browser_find_elements", "browser_inspect_element",
        "browser_interactive", "browser_frames", "browser_accessibility_snapshot", "browser_computed_style",
        "browser_page_info", "browser_hover", "browser_move", "browser_press_and_hold", "browser_challenge",
        "browser_evaluate", "browser_batch", "browser_dialog", "browser_cookies", "browser_storage",
        "web_search", "server_health", "browser_doctor",
      ];
      for (const name of startOfGoal) {
        if (listed.has(name)) continue;
        const route = RETIRED_TOOL_ROUTES[name];
        expect(route, `${name} must remain listed or map to a canonical tool`).toBeDefined();
        await expect(client.callTool({ name: route.tool, arguments: route.arguments })).resolves.toBeDefined();
      }
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await runtime.close();
    }
  });

  it("marks truncation instead of silently dropping output", () => {
    const oversized = {
      text: "x".repeat(40_000),
      links: Array.from({ length: 20 }, (_, index) => ({ href: `https://example.test/${index}` })),
      results: Array.from({ length: 20 }, (_, index) => ({ title: `r${index}`, snippet: "s".repeat(8_000) })),
    };
    const bounded = sanitizeMcpOutput(oversized) as Record<string, unknown>;
    expect(bounded.truncated === true || bounded.mcpOutputTruncated === true || bounded.linksTruncated === true || bounded.resultsTruncated === true).toBe(true);
    expect(JSON.stringify(bounded)).toContain("Truncat");
  });
});
