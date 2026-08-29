import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { createUi } from "@/server/ui";
import { launchPersonalChrome, persistWizardConfig, promptForHarness, runWizard } from "@/server/installer-wizard";

const rlState = vi.hoisted(() => ({ answers: [] as string[], prompts: [] as string[] }));
const discoveryState = vi.hoisted(() => ({
  executables: [
    { path: "/opt/google-chrome", label: "Google Chrome", channel: "stable" },
    { path: "/opt/brave", label: "Brave", channel: "stable" },
  ],
}));
vi.mock("@/server/browser/discovery", () => ({
  findChromiumExecutables: () => discoveryState.executables,
  findChromeExecutable: () => discoveryState.executables[0] ?? null,
}));
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: (prompt: string) => {
      rlState.prompts.push(prompt);
      return Promise.resolve(rlState.answers.shift() ?? "");
    },
    close: () => undefined,
  }),
}));

describe("wizard --yes", () => {
  it("returns recommended defaults without prompts", async () => {
    const result = await runWizard("opencode", { yes: true, stdin: null as any, stdout: null as any, spawn: null as any, probe: null as any, homeDir: "/tmp/test-home", env: {} });
    expect(result).toEqual({ mode: "managed", headless: false, allowedDomains: [], blockedDomains: [], allowEval: true, dataDir: expect.stringContaining(".smooth-operator") });
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
      allowEval: true, dataDir: join("/tmp/test-home", ".smooth-operator"),
    });
  });

  it("asks exactly three questions in profile, display, and browser order", async () => {
    rlState.answers = ["", "2", ""];
    rlState.prompts = [];
    const output: string[] = [];
    const result = await runWizard("opencode", {
      yes: false,
      stdin: { isTTY: true } as never,
      stdout: { isTTY: true, write: (chunk: string | Uint8Array) => { output.push(String(chunk)); return true; } } as never,
      homeDir: "/tmp/test-home",
      env: {},
    });
    expect(rlState.prompts).toEqual(["Profile ownership [1]: ", "Browser display [1]: ", "Browser [1]: "]);
    expect(result).toMatchObject({ mode: "managed", headless: true, allowEval: true, allowedDomains: [], blockedDomains: [], browserExecutablePath: "/opt/google-chrome" });
    const rendered = output.join("");
    expect(rendered).toContain("Isolated managed profile");
    expect(rendered).toContain("Connected/personal browser profile");
    expect(rendered).toContain("Headed (visible window)");
    expect(rendered).toContain("Headless (no window)");
    expect(rendered).toContain("Google Chrome");
    expect(rendered.indexOf("Google Chrome")).toBeLessThan(rendered.indexOf("Brave"));
    expect(rendered).not.toContain("Disabled");
  });

  it("treats an injected CI environment as non-interactive even for TTY-shaped streams", async () => {
    rlState.answers = ["2"];
    const result = await runWizard("opencode", {
      yes: false,
      stdin: { isTTY: true } as never,
      stdout: { isTTY: true } as never,
      homeDir: "/tmp/test-home",
      env: { CI: "1" },
    });
    expect(result.mode).toBe("managed");
    expect(result.browserUrl).toBeUndefined();
    expect(rlState.answers).toEqual(["2"]);
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
      expect(merged.stealth).toEqual({ enabled: true, profile: "balanced", gpu: false, behaviorEnabled: false });
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
        browser: { mode: "connect", headless: true, url: "http://127.0.0.1:9222", executablePath: "/tmp/old-browser", actionTimeoutMs: 20_000 },
        security: { allowEval: true, allowedDomains: ["x.com"] },
        stealth: { enabled: false, profile: "max", gpu: true, behaviorEnabled: false },
        captchaSolver: { provider: "none" },
        dataDir: join(home, "old-data"),
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
      expect(merged.browser.url).toBeUndefined();
      expect(merged.browser.executablePath).toBeUndefined();
      expect(merged.security.allowEval).toBe(false);
      expect(merged.security.allowedDomains).toEqual([]);
      expect(merged.security.blockedDomains).toEqual([]);
      expect(merged.stealth).toEqual({ enabled: true, profile: "balanced", gpu: false, behaviorEnabled: false });
      expect(merged.captchaSolver).toBeUndefined();
      expect(merged.browser.actionTimeoutMs).toBe(20_000);
      expect(merged.logLevel).toBe("debug");
      expect(merged.dataDir).toBe(join(home, ".smooth-operator"));
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

  it("rejects an oversized existing config before merging or backing it up", async () => {
    const home = await mkdtemp(join(tmpdir(), "smooth-operator-wizard-large-"));
    try {
      const configDir = join(home, ".smooth-operator");
      await mkdir(configDir, { recursive: true });
      const configPath = join(configDir, "config.json");
      await writeFile(configPath, "x".repeat(2_000_001));
      await chmod(configPath, 0o600);
      await expect(persistWizardConfig(
        { mode: "managed", headless: false, allowedDomains: [], blockedDomains: [], allowEval: false,
          dataDir: join(home, ".smooth-operator") },
        home,
      )).rejects.toThrow(/2000000 bytes or smaller/);
      await expect(readFile(`${configPath}.bak`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a generated wizard config that would exceed the persistence bound", async () => {
    const home = await mkdtemp(join(tmpdir(), "smooth-operator-wizard-generated-large-"));
    try {
      const configDir = join(home, ".smooth-operator");
      const configPath = join(configDir, "config.json");
      const original = JSON.stringify({ keep: "x".repeat(1_999_900) });
      expect(Buffer.byteLength(original, "utf8")).toBeLessThan(2_000_000);
      await mkdir(configDir, { recursive: true });
      await writeFile(configPath, original);
      await chmod(configPath, 0o600);
      await expect(persistWizardConfig(
        { mode: "managed", headless: false, allowedDomains: [], blockedDomains: [], allowEval: false,
          dataDir: join(home, ".smooth-operator") },
        home,
      )).rejects.toThrow(/generated server configuration.*2000000 bytes or smaller/);
      expect(await readFile(configPath, "utf8")).toBe(original);
      await expect(stat(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects an existing group-readable wizard config before creating a backup", async () => {
    if (process.platform === "win32") {
      return;
    }
    const home = await mkdtemp(join(tmpdir(), "smooth-operator-wizard-permissions-"));
    try {
      const configDir = join(home, ".smooth-operator");
      const configPath = join(configDir, "config.json");
      await mkdir(configDir, { recursive: true });
      await writeFile(configPath, '{ "logLevel": "debug" }');
      await chmod(configPath, 0o644);
      await expect(persistWizardConfig(
        { mode: "managed", headless: false, allowedDomains: [], blockedDomains: [], allowEval: false,
          dataDir: join(home, ".smooth-operator") },
        home,
      )).rejects.toThrow(/owner-only permissions/);
      expect(await readFile(configPath, "utf8")).toBe('{ "logLevel": "debug" }');
      await expect(stat(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects invalid direct wizard choices before touching the config directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "smooth-operator-wizard-invalid-"));
    try {
      await expect(persistWizardConfig(
        { mode: "managed", headless: false, allowedDomains: ["https://evil.example"], blockedDomains: [], allowEval: false,
          dataDir: join(home, ".smooth-operator") },
        home,
      )).rejects.toThrow(/invalid pattern/);
      await expect(stat(join(home, ".smooth-operator"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked config directory before creating files through it", async () => {
    const home = await mkdtemp(join(tmpdir(), "smooth-operator-wizard-directory-link-"));
    const outside = join(home, "outside");
    try {
      await mkdir(outside, { recursive: true });
      await symlink(outside, join(home, ".smooth-operator"));
      await expect(persistWizardConfig(
        { mode: "managed", headless: false, allowedDomains: [], blockedDomains: [], allowEval: false,
          dataDir: join(home, ".smooth-operator") },
        home,
      )).rejects.toThrow(/symbolic link/i);
      await expect(readFile(join(outside, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
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

describe("personal Chrome launcher", () => {
  it("probes immediately after spawning when DevTools is already ready", async () => {
    const home = await mkdtemp(join(tmpdir(), "smooth-operator-wizard-launch-ready-"));
    try {
      const spawn = vi.fn((_executable: string, _args: string[]) => ({ unref: vi.fn() }));
      const probe = vi.fn(async () => ({ state: "live", version: { Browser: "Chrome/124" } }));
      await expect(launchPersonalChrome({ executablePath: "/bin/chrome", dataDir: home, spawn: spawn as never, probe, probeAttempts: 1 })).resolves.toEqual({ url: "http://127.0.0.1:9222" });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0]?.[1]).not.toContain("--headless=new");
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("passes the headless selection to a helper-launched browser", async () => {
    const home = await mkdtemp(join(tmpdir(), "smooth-operator-wizard-launch-headless-"));
    try {
      const spawn = vi.fn((_executable: string, _args: string[]) => ({ unref: vi.fn() }));
      const probe = vi.fn(async () => ({ state: "live" }));
      await expect(launchPersonalChrome({ executablePath: "/bin/chrome", dataDir: home, headless: true, spawn: spawn as never, probe, probeAttempts: 1 })).resolves.toEqual({ url: "http://127.0.0.1:9222" });
      expect(spawn.mock.calls[0]?.[1]).toContain("--headless=new");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects unsafe data directories and ports before spawning Chrome", async () => {
    const spawn = vi.fn();
    const probe = vi.fn();
    await expect(launchPersonalChrome({ executablePath: "/bin/chrome", dataDir: "", spawn, probe })).rejects.toThrow(/data directory/);
    await expect(launchPersonalChrome({ executablePath: "/bin/chrome", dataDir: "/tmp/smooth-operator-launcher", port: 0, spawn, probe })).rejects.toThrow(/port/);
    expect(spawn).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not launch through a symlinked data directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "smooth-operator-wizard-launch-link-"));
    try {
      const target = join(home, "target");
      const link = join(home, "link");
      await mkdir(target);
      await symlink(target, link);
      const spawn = vi.fn();
      await expect(launchPersonalChrome({ executablePath: "/bin/chrome", dataDir: link, spawn, probe: vi.fn() })).rejects.toThrow(/symbolic link/i);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("installer terminal output", () => {
  it("removes control characters and line breaks from user-facing values", () => {
    const chunks: string[] = [];
    const ui = createUi({
      isTTY: false,
      write: (chunk: string | Uint8Array) => {
        chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      },
    } as never);
    ui.keyValues([["Label\nforged", "secret\x1b[31m\nnext"]]);
    ui.success("done\r\nfake-line");
    const output = chunks.join("");
    expect(output).not.toContain("\x1b");
    expect(output).toContain("Label forged");
    expect(output).toContain("secret[31m next");
    expect(output).not.toContain("secret[31m\nnext");
    expect(output).not.toContain("done\r\nfake-line");
  });
});
