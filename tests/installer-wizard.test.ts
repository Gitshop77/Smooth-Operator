import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { persistWizardConfig, promptForHarness, runWizard } from "@/server/installer-wizard";

const rlState = vi.hoisted(() => ({ answers: [] as string[] }));
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: () => Promise.resolve(rlState.answers.shift() ?? ""),
    close: () => undefined,
  }),
}));

describe("wizard --yes", () => {
  it("returns recommended defaults without prompts", async () => {
    const result = await runWizard("opencode", { yes: true, stdin: null as any, stdout: null as any, spawn: null as any, probe: null as any, homeDir: "/tmp/test-home", env: {} });
    expect(result).toEqual({ mode: "managed", headless: false, allowedDomains: [], blockedDomains: [], allowEval: false, dataDir: expect.stringContaining(".smooth-operator") });
  });
});

describe("wizard non-interactive fallback", () => {
  it("returns recommended defaults when stdin/stdout are not TTYs", async () => {
    const result = await runWizard("opencode", {
      yes: false,
      stdin: { isTTY: false } as never,
      stdout: { isTTY: false } as never,
      homeDir: "/tmp/test-home",
      env: {},
    });
    expect(result).toEqual({
      mode: "managed", headless: false, allowedDomains: [], blockedDomains: [],
      allowEval: false, dataDir: join("/tmp/test-home", ".smooth-operator"),
    });
  });
});

describe("promptForHarness", () => {
  it("defaults to opencode on an empty answer", async () => {
    rlState.answers = [""];
    await expect(promptForHarness({ stdin: { isTTY: false } as never, stdout: { isTTY: false } as never })).resolves.toBe("opencode");
  });

  it("maps claude and github-copilot aliases to canonical targets", async () => {
    rlState.answers = ["claude"];
    await expect(promptForHarness({ stdin: { isTTY: false } as never, stdout: { isTTY: false } as never })).resolves.toBe("claude-code");
    rlState.answers = ["GitHub-Copilot "];
    await expect(promptForHarness({ stdin: { isTTY: false } as never, stdout: { isTTY: false } as never })).resolves.toBe("copilot");
  });

  it("passes through an arbitrary target answer", async () => {
    rlState.answers = ["windsurf"];
    await expect(promptForHarness({ stdin: { isTTY: false } as never, stdout: { isTTY: false } as never })).resolves.toBe("windsurf");
  });
});

describe("persistWizardConfig merges instead of replacing", () => {
  it("preserves unrelated existing settings and sections", async () => {
    const home = await mkdtemp(join(tmpdir(), "smooth-operator-wizard-"));
    try {
      const configDir = join(home, ".smooth-operator");
      await mkdir(configDir, { recursive: true });
      const existing = {
        browser: { actionTimeoutMs: 20_000 },
        security: { allowPrivateNetwork: true },
        logLevel: "debug",
        mcp: { servers: {} },
      };
      const existingJson = JSON.stringify(existing, null, 2);
      await writeFile(join(configDir, "config.json"), existingJson);
      await chmod(join(configDir, "config.json"), 0o600);
      await persistWizardConfig(
        { mode: "connect", headless: false, allowedDomains: ["example.com"], blockedDomains: [], allowEval: false,
          dataDir: join(home, ".smooth-operator"), browserUrl: "http://127.0.0.1:9222" },
        home,
      );
      const merged = JSON.parse(await readFile(join(configDir, "config.json"), "utf8"));
      expect(merged.browser.actionTimeoutMs).toBe(20_000);
      expect(merged.browser.mode).toBe("connect");
      expect(merged.browser.url).toBe("http://127.0.0.1:9222");
      expect(merged.security.allowPrivateNetwork).toBe(true);
      expect(merged.security.allowedDomains).toEqual(["example.com"]);
      expect(merged.logLevel).toBe("debug");
      expect(merged.mcp).toEqual({ servers: {} });
      await expect(readFile(`${join(configDir, "config.json")}.bak`, "utf8")).resolves.toBe(existingJson);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rewrites stale unsafe values from wizard choices while preserving unrelated settings", async () => {
    const home = await mkdtemp(join(tmpdir(), "smooth-operator-wizard-reset-"));
    try {
      const configDir = join(home, ".smooth-operator");
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "config.json"), JSON.stringify({
        browser: { mode: "connect", headless: true, actionTimeoutMs: 20_000 },
        security: { allowEval: true, allowedDomains: ["x.com"] },
        logLevel: "debug",
      }, null, 2));
      await chmod(join(configDir, "config.json"), 0o600);
      await persistWizardConfig(
        { mode: "managed", headless: false, allowedDomains: [], blockedDomains: [], allowEval: false,
          dataDir: join(home, ".smooth-operator") },
        home,
      );
      const merged = JSON.parse(await readFile(join(configDir, "config.json"), "utf8"));
      expect(merged.browser.mode).toBe("managed");
      expect(merged.browser.headless).toBe(false);
      expect(merged.security.allowEval).toBe(false);
      expect(merged.security.allowedDomains).toEqual([]);
      expect(merged.security.blockedDomains).toEqual([]);
      expect(merged.browser.actionTimeoutMs).toBe(20_000);
      expect(merged.logLevel).toBe("debug");
      expect(merged.dataDir).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked config and keeps JSONC comments out of the way", async () => {
    const home = await mkdtemp(join(tmpdir(), "smooth-operator-wizard-link-"));
    try {
      const configDir = join(home, ".smooth-operator");
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "real.json"), '{ /* c */ "browser": { "headless": true }, }');
      await symlink(join(configDir, "real.json"), join(configDir, "config.json"));
      await expect(persistWizardConfig(
        { mode: "managed", headless: false, allowedDomains: [], blockedDomains: [], allowEval: false,
          dataDir: join(home, ".smooth-operator") },
        home,
      )).rejects.toThrow(/symbolic link/i);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("persistWizardConfig browser selection", () => {
  it("persists a chosen Chromium-based executable into the browser section", async () => {
    const home = await mkdtemp(join(tmpdir(), "smooth-operator-wizard-browser-"));
    try {
      await mkdir(join(home, ".smooth-operator"), { recursive: true });
      await persistWizardConfig(
        { mode: "managed", headless: false, allowedDomains: [], blockedDomains: [], allowEval: false,
          dataDir: join(home, ".smooth-operator"),
          browserExecutablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
        home,
      );
      const merged = JSON.parse(await readFile(join(home, ".smooth-operator", "config.json"), "utf8"));
      expect(merged.browser.executablePath).toBe("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
