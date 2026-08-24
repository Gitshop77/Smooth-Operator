import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { installHarness, planHarnessInstall, type HarnessCommand } from "@/server/installer";

const SOURCE_ENTRY: HarnessCommand = { command: "smooth-operator", args: [] };

async function makeDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(process.env.TMPDIR ?? "/tmp", prefix));
}

function configOptions(path: string, serverEntry: HarnessCommand = SOURCE_ENTRY) {
  return { configPaths: { "claude-desktop": path }, serverEntry } as const;
}

describe("harness installer", () => {
  it("plans current non-interactive CLI argv without launching programs", async () => {
    const entry = { command: "/opt/Node Runtime/node", args: ["/opt/SmoothOperator/dist/smooth-operator.mjs"] };
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const options = { serverEntry: entry, executeCommand: async (command: string, args: readonly string[]) => { calls.push({ command, args }); } };

    await installHarness("claude-code", options);
    await installHarness("copilot", options);
    await installHarness("codex", options);
    await installHarness("gemini", options);
    await installHarness("vscode", options);

    expect(calls).toEqual([
      { command: "claude", args: ["mcp", "add", "--scope", "user", "SmoothOperator", "--", "smooth-operator"] },
      { command: "copilot", args: ["mcp", "add", "SmoothOperator", "--", "smooth-operator"] },
      { command: "codex", args: ["mcp", "add", "SmoothOperator", "--", "smooth-operator"] },
      { command: "gemini", args: ["mcp", "add", "SmoothOperator", "smooth-operator", "--scope", "user"] },
      { command: "code", args: ["--add-mcp", JSON.stringify({ name: "SmoothOperator", command: entry.command, args: entry.args })] },
    ]);
  });

  it("uses a supported direct config path for OpenCode instead of its interactive add command", async () => {
    const directory = await makeDirectory("smooth-operator-installer-opencode-");
    const path = join(directory, "opencode.json");
    const entry = { command: "/usr/local/bin/node", args: ["/opt/SmoothOperator/dist/smooth-operator.mjs"] };
    try {
      const plan = planHarnessInstall("opencode", { configPaths: { opencode: path }, serverEntry: entry });
      expect(plan).toEqual({ kind: "json", target: "opencode", path });
      const result = await installHarness("opencode", { configPaths: { opencode: path }, serverEntry: entry });
      expect(result).toContain(path);
      const installed = JSON.parse(await readFile(path, "utf8")) as { mcp: { servers: Record<string, { type: string; command: string[] }> } };
      expect(installed.mcp.servers["SmoothOperator"]).toEqual({ type: "local", command: [entry.command, ...entry.args] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses structured absolute executable fields for GUI JSON clients", async () => {
    const directory = await makeDirectory("smooth-operator-installer-gui-");
    const configPath = join(directory, "cursor.json");
    const entry = { command: "/Applications/Node Runtime/bin/node", args: ["/Applications/SmoothOperator/dist/smooth-operator.mjs"] };
    try {
      await installHarness("cursor", { configPaths: { cursor: configPath }, serverEntry: entry });
      const installed = JSON.parse(await readFile(configPath, "utf8")) as { mcpServers: Record<string, { command: string; args: string[] }> };
      expect(installed.mcpServers["SmoothOperator"]).toEqual(entry);
      expect(installed.mcpServers["SmoothOperator"].args).toEqual(["/Applications/SmoothOperator/dist/smooth-operator.mjs"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves URLs while parsing JSONC and secures an exclusive config backup", async () => {
    const directory = await makeDirectory("smooth-operator-installer-jsonc-");
    const configPath = join(directory, "claude_desktop_config.json");
    try {
      await writeFile(configPath, `{
        // Keep this URL intact while comments are removed.
        "mcpServers": {
          "existing": { "command": "node", "args": ["https://example.test/a//b",], },
        },
      }`);
      await chmod(configPath, 0o644);

      await installHarness("claude-desktop", configOptions(configPath));
      const installed = JSON.parse(await readFile(configPath, "utf8")) as { mcpServers: Record<string, { command: string; args: string[] }> };
      expect(installed.mcpServers.existing.args[0]).toBe("https://example.test/a//b");
      expect(installed.mcpServers["SmoothOperator"]).toEqual({ command: "smooth-operator", args: [] });
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
      expect((await stat(`${configPath}.bak`)).mode & 0o777).toBe(0o600);
      expect(await readFile(`${configPath}.bak`, "utf8")).toContain("https://example.test/a//b");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for a non-object mcpServers value without changing the file", async () => {
    const directory = await makeDirectory("smooth-operator-installer-invalid-");
    const configPath = join(directory, "config.json");
    const original = '{ "mcpServers": "keep this value", "other": 1 }\n';
    try {
      await writeFile(configPath, original);
      await expect(installHarness("claude-desktop", configOptions(configPath))).rejects.toThrow(/mcpServers value/);
      expect(await readFile(configPath, "utf8")).toBe(original);
      expect(await readdir(directory)).toEqual(["config.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for a conflicting existing server and preserves unrelated data", async () => {
    const directory = await makeDirectory("smooth-operator-installer-conflict-");
    const configPath = join(directory, "config.json");
    const original = JSON.stringify({ unrelated: { keep: true }, mcpServers: { "SmoothOperator": { command: "other", args: ["--unsafe"] } } });
    try {
      await writeFile(configPath, original);
      await expect(installHarness("claude-desktop", configOptions(configPath))).rejects.toThrow(/conflicting configuration/);
      expect(await readFile(configPath, "utf8")).toBe(original);
      expect(await readdir(directory)).toEqual(["config.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("is idempotent and does not replace the first backup on a repeat install", async () => {
    const directory = await makeDirectory("smooth-operator-installer-repeat-");
    const configPath = join(directory, "config.json");
    try {
      await writeFile(configPath, JSON.stringify({ unrelated: "preserve" }));
      await installHarness("claude-desktop", configOptions(configPath));
      const firstBackup = await readFile(`${configPath}.bak`, "utf8");
      const secondResult = await installHarness("claude-desktop", configOptions(configPath));
      expect(secondResult).toContain("already configured");
      expect(await readFile(`${configPath}.bak`, "utf8")).toBe(firstBackup);
      expect((await readdir(directory)).sort()).toEqual(["config.json", "config.json.bak"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("supports the current and legacy OpenCode config shapes without replacing unrelated values", async () => {
    const directory = await makeDirectory("smooth-operator-installer-opencode-shapes-");
    const modernPath = join(directory, "modern.json");
    const legacyPath = join(directory, "legacy.json");
    const entry = { command: "/opt/node", args: ["/opt/SmoothOperator.mjs"] };
    try {
      await writeFile(modernPath, JSON.stringify({ model: "keep", mcp: { servers: { existing: { type: "local", command: ["node", "existing.js"] } } } }));
      await installHarness("opencode", { configPaths: { opencode: modernPath }, serverEntry: entry });
      const modern = JSON.parse(await readFile(modernPath, "utf8")) as { model: string; mcp: { servers: Record<string, unknown> } };
      expect(modern.model).toBe("keep");
      expect(modern.mcp.servers["SmoothOperator"]).toEqual({ type: "local", command: [entry.command, ...entry.args] });

      await writeFile(legacyPath, JSON.stringify({ mcp: { existing: { type: "local", command: ["node", "existing.js"], enabled: true } } }));
      await installHarness("opencode", { configPaths: { opencode: legacyPath }, serverEntry: entry });
      const legacy = JSON.parse(await readFile(legacyPath, "utf8")) as { mcp: Record<string, { type: string; command: string[]; enabled?: boolean }> };
      expect(legacy.mcp["SmoothOperator"]).toEqual({ type: "local", command: [entry.command, ...entry.args], enabled: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("treats disabled matching OpenCode entries as conflicts instead of idempotent", async () => {
    const directory = await makeDirectory("smooth-operator-installer-opencode-disabled-");
    const modernPath = join(directory, "modern.json");
    const legacyPath = join(directory, "legacy.json");
    const entry = { command: "/opt/node", args: ["/opt/SmoothOperator.mjs"] };
    try {
      await writeFile(modernPath, JSON.stringify({ mcp: { servers: { "SmoothOperator": { type: "local", command: [entry.command, ...entry.args], disabled: true } } } }));
      await expect(installHarness("opencode", { configPaths: { opencode: modernPath }, serverEntry: entry })).rejects.toThrow(/conflicting configuration/);
      expect(JSON.parse(await readFile(modernPath, "utf8"))).toEqual({ mcp: { servers: { "SmoothOperator": { type: "local", command: [entry.command, ...entry.args], disabled: true } } } });

      await writeFile(legacyPath, JSON.stringify({ mcp: { "SmoothOperator": { type: "local", command: [entry.command, ...entry.args], enabled: false } } }));
      await expect(installHarness("opencode", { configPaths: { opencode: legacyPath }, serverEntry: entry })).rejects.toThrow(/conflicting configuration/);
      expect(JSON.parse(await readFile(legacyPath, "utf8"))).toEqual({ mcp: { "SmoothOperator": { type: "local", command: [entry.command, ...entry.args], enabled: false } } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("treats absent or explicitly enabled OpenCode entries as idempotent", async () => {
    const directory = await makeDirectory("smooth-operator-installer-opencode-enabled-");
    const modernPath = join(directory, "modern.json");
    const legacyPath = join(directory, "legacy.json");
    const entry = { command: "/opt/node", args: ["/opt/SmoothOperator.mjs"] };
    try {
      await writeFile(modernPath, JSON.stringify({ mcp: { servers: { "SmoothOperator": { type: "local", command: [entry.command, ...entry.args], disabled: false } } } }));
      await expect(installHarness("opencode", { configPaths: { opencode: modernPath }, serverEntry: entry })).resolves.toMatch(/already configured/);

      await writeFile(legacyPath, JSON.stringify({ mcp: { "SmoothOperator": { type: "local", command: [entry.command, ...entry.args] } } }));
      await expect(installHarness("opencode", { configPaths: { opencode: legacyPath }, serverEntry: entry })).resolves.toMatch(/already configured/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("honors an explicit OpenCode config path without switching to a sibling JSONC file", async () => {
    const directory = await makeDirectory("smooth-operator-installer-opencode-explicit-");
    const explicitPath = join(directory, "opencode.json");
    const siblingPath = join(directory, "opencode.jsonc");
    const entry = { command: "/opt/node", args: ["/opt/SmoothOperator.mjs"] };
    try {
      await writeFile(siblingPath, JSON.stringify({ mcp: { servers: { sibling: { type: "local", command: ["node", "sibling.mjs"] } } } }));
      const environment = { OPENCODE_CONFIG: explicitPath };
      expect(planHarnessInstall("opencode", { environment, serverEntry: entry })).toEqual({ kind: "json", target: "opencode", path: explicitPath });
      await installHarness("opencode", { environment, serverEntry: entry });
      expect(JSON.parse(await readFile(explicitPath, "utf8"))).toMatchObject({ mcp: { servers: { "SmoothOperator": { type: "local", command: [entry.command, ...entry.args] } } } });
      expect(JSON.parse(await readFile(siblingPath, "utf8"))).toEqual({ mcp: { servers: { sibling: { type: "local", command: ["node", "sibling.mjs"] } } } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prefers an existing JSONC file only for implicit OpenCode resolution", async () => {
    const directory = await makeDirectory("smooth-operator-installer-opencode-implicit-");
    const configDirectory = join(directory, "config");
    const jsonPath = join(configDirectory, "opencode.json");
    const jsoncPath = join(configDirectory, "opencode.jsonc");
    const entry = { command: "/opt/node", args: ["/opt/SmoothOperator.mjs"] };
    try {
      await mkdir(configDirectory, { recursive: true });
      await writeFile(jsoncPath, '{ "mcp": { "servers": {} }, }');
      await installHarness("opencode", { environment: { OPENCODE_CONFIG_DIR: configDirectory }, serverEntry: entry });
      expect((await readdir(configDirectory)).sort()).toEqual(["opencode.jsonc", "opencode.jsonc.bak"]);
      expect(await stat(jsoncPath)).toBeTruthy();
      expect(await stat(jsonPath).catch(() => undefined)).toBeUndefined();
      expect(JSON.parse(await readFile(jsoncPath, "utf8"))).toMatchObject({ mcp: { servers: { "SmoothOperator": { type: "local", command: [entry.command, ...entry.args] } } } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed OpenCode server collections without replacing the file", async () => {
    const directory = await makeDirectory("smooth-operator-installer-opencode-invalid-");
    const configPath = join(directory, "opencode.json");
    const original = JSON.stringify({ mcp: { servers: ["not-an-object"] }, keep: true });
    try {
      await writeFile(configPath, original);
      await expect(installHarness("opencode", { configPaths: { opencode: configPath }, serverEntry: SOURCE_ENTRY })).rejects.toThrow(/server collection/);
      expect(await readFile(configPath, "utf8")).toBe(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not follow a pre-existing configuration-backup symlink", async () => {
    const directory = await makeDirectory("smooth-operator-installer-backup-");
    const configPath = join(directory, "config.json");
    const outsidePath = join(directory, "outside.txt");
    try {
      await writeFile(configPath, '{ "mcpServers": {} }');
      await writeFile(outsidePath, "must remain unchanged");
      await symlink(outsidePath, `${configPath}.bak`);

      await expect(installHarness("claude-desktop", configOptions(configPath))).rejects.toThrow(/symbolic link/);
      expect(await readFile(outsidePath, "utf8")).toBe("must remain unchanged");
      expect(await readFile(configPath, "utf8")).toBe('{ "mcpServers": {} }');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked configuration file before parsing or writing", async () => {
    const directory = await makeDirectory("smooth-operator-installer-config-link-");
    const realPath = join(directory, "real.json");
    const configPath = join(directory, "config.json");
    try {
      await writeFile(realPath, '{ "mcpServers": {} }');
      await symlink(realPath, configPath);
      await expect(installHarness("claude-desktop", configOptions(configPath))).rejects.toThrow(/symbolic link/);
      expect(await readFile(realPath, "utf8")).toBe('{ "mcpServers": {} }');
      expect((await readdir(directory)).sort()).toEqual(["config.json", "real.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked configuration directory before mkdir can follow it", async () => {
    const directory = await makeDirectory("smooth-operator-installer-directory-link-");
    const outsideDirectory = join(directory, "outside");
    const linkedDirectory = join(directory, "linked-config");
    const configPath = join(linkedDirectory, "config.json");
    try {
      await mkdir(outsideDirectory, { recursive: true });
      await symlink(outsideDirectory, linkedDirectory);
      await expect(installHarness("claude-desktop", configOptions(configPath))).rejects.toThrow(/symbolic link/);
      expect(await readdir(outsideDirectory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
