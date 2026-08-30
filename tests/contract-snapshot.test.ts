import { createHash } from "node:crypto";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { createMcpServer, MCP_INSTRUCTIONS } from "@/server/mcp";
import { ServerRuntime } from "@/server/runtime";

import { testConfig } from "./helpers";

describe("public MCP contract snapshot", () => {
  it("locks tools, schemas, annotations, resources, prompts, and envelopes", async () => {
    const runtime = await ServerRuntime.create(testConfig());
    const server = createMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "contract-snapshot-test", version: "1.0.0" });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const [tools, resources, resourceTemplates, prompts] = await Promise.all([
        client.listTools(),
        client.listResources(),
        client.listResourceTemplates(),
        client.listPrompts(),
      ]);
      const promptCases: Array<[string, Record<string, string>]> = [
        ["agent-chrome-setup", {}],
        ["browser-workflow", { task: "inspect the page", url: "https://example.test/" }],
        ["extract-page", { question: "What is explicitly shown?" }],
        ["research-question", { question: "What is the observed answer?" }],
      ];
      const generatedPrompts = await Promise.all(promptCases.map(async ([name, args]) => ({ name, result: await client.getPrompt({ name, arguments: args }) })));
      const manifest = {
        instructions: MCP_INSTRUCTIONS,
        tools: tools.tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
        resources: resources.resources.map(({ name, uri, title, description, mimeType }) => ({ name, uri, title, description, mimeType })),
        resourceTemplates: resourceTemplates.resourceTemplates.map(({ name, uriTemplate, title, description, mimeType }) => ({ name, uriTemplate, title, description, mimeType })),
        prompts: prompts.prompts.map(({ name, title, description, arguments: promptArguments }) => ({ name, title, description, arguments: promptArguments })),
        generatedPrompts,
      };
      const fingerprint = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
      expect(fingerprint).toBe("08a4e19e2c5b573f12d9dedfe2798430b85531a1915f58948e44cb2ec32b335b");

      const success = await client.callTool({ name: "server_health", arguments: {} });
      expect(success.isError).not.toBe(true);
      expect(parseTextContent(success)).toEqual(success.structuredContent);

      const failure = await client.callTool({ name: "browser_evaluate", arguments: { code: "1 + 1" } });
      expect(failure.isError).toBe(true);
      expect(parseTextContent(failure)).toEqual(failure.structuredContent);
      expect(failure.structuredContent).toMatchObject({ ok: false, error: { code: "EVALUATE_DISABLED" } });
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await runtime.close();
    }
  });
});

function parseTextContent(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (text === undefined) {
    throw new Error("MCP result did not include a text fallback.");
  }
  return JSON.parse(text) as unknown;
}
