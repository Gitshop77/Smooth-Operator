import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("stdio transport", () => {
  it("keeps help on stderr and advertises managed browser mode", async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "src/server/main.ts", "--help"], {
      cwd: process.cwd(),
      env: { ...process.env, OPEN_COWORK_BROWSER_MODE: undefined },
    });
    expect(stdout).toBe("");
    expect(stderr).toContain("OPEN_COWORK_BROWSER_MODE=disabled|connect|launch|managed");
  });

  it("completes a handshake through a real server process", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "open-cowork-stdio-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "src/server/main.ts"],
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        OPEN_COWORK_TRANSPORT: "stdio",
        OPEN_COWORK_BROWSER_MODE: "disabled",
        OPEN_COWORK_DATA_DIR: dataDir,
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    const client = new Client({ name: "stdio-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe("modern");
      expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      const tools = await client.listTools();
      const resources = await client.listResources();
      const resourceTemplates = await client.listResourceTemplates();
      const prompts = await client.listPrompts();
      expect(tools.tools).toHaveLength(59);
      expect(resources.resources).toHaveLength(6);
      expect(resourceTemplates.resourceTemplates).toHaveLength(1);
      expect(prompts.prompts).toHaveLength(4);
      expect(tools.tools.some((tool) => tool.name === "server_health")).toBe(true);
      const health = await client.callTool({ name: "server_health", arguments: {} });
      expect(health.isError).not.toBe(true);
      expect(JSON.stringify(health)).toContain('"status":"ok"');
    } finally {
      await client.close().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
