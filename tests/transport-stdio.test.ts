import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);

describe("stdio transport", () => {
  it("closes the runtime when stdio transport setup fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-stdio-startup-"));
    const configPath = join(directory, "config.json");
    await writeFile(configPath, "{}", "utf8");
    await chmod(configPath, 0o600);

    const close = vi.fn().mockResolvedValue(undefined);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const previousEnvironment = {
      SMOOTH_OPERATOR_CONFIG: process.env.SMOOTH_OPERATOR_CONFIG,
      SMOOTH_OPERATOR_BROWSER_MODE: process.env.SMOOTH_OPERATOR_BROWSER_MODE,
      SMOOTH_OPERATOR_TRANSPORT: process.env.SMOOTH_OPERATOR_TRANSPORT,
      SMOOTH_OPERATOR_DATA_DIR: process.env.SMOOTH_OPERATOR_DATA_DIR,
    };
    process.env.SMOOTH_OPERATOR_CONFIG = configPath;
    process.env.SMOOTH_OPERATOR_BROWSER_MODE = "disabled";
    process.env.SMOOTH_OPERATOR_TRANSPORT = "stdio";
    process.env.SMOOTH_OPERATOR_DATA_DIR = directory;
    vi.doMock("@modelcontextprotocol/server/stdio", () => ({
      serveStdio: vi.fn(() => {
        throw new Error("stdio setup failed");
      }),
    }));
    vi.doMock("@/server/runtime", () => ({
      ServerRuntime: {
        create: vi.fn().mockResolvedValue({ config: { transport: "stdio" }, logger, close }),
      },
    }));

    try {
      const { main } = await import("@/server/main");
      await expect(main(["--transport", "stdio"])).rejects.toThrow("stdio setup failed");
      expect(close).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith("Shutdown requested", { reason: "STDIO_STARTUP_FAILED" });
    } finally {
      vi.resetModules();
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps help on stderr and advertises managed browser mode", async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "src/server/main.ts", "--help"], {
      cwd: process.cwd(),
      env: { ...process.env, SMOOTH_OPERATOR_BROWSER_MODE: undefined },
    });
    expect(stdout).toBe("");
    expect(stderr).toContain("SMOOTH_OPERATOR_BROWSER_MODE=disabled|connect|launch|managed");
  });

  it("completes a handshake through a real server process", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "smooth-operator-stdio-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "src/server/main.ts"],
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        SMOOTH_OPERATOR_TRANSPORT: "stdio",
        SMOOTH_OPERATOR_BROWSER_MODE: "disabled",
        SMOOTH_OPERATOR_DATA_DIR: dataDir,
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
      expect(tools.tools).toHaveLength(61);
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
