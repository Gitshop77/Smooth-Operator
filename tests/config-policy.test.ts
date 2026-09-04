import { access, chmod, mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const dnsLookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: dnsLookup }));

import {
  loadServerConfig,
  MAX_CONFIG_DOMAIN_PATTERN_CHARS,
  MAX_CONFIG_FILE_ROOT_CHARS,
  MAX_CONFIG_HOST_PATTERN_CHARS,
  MAX_CONFIG_LIST_RAW_CHARS,
} from "@/server/config";
import { AppError } from "@/server/errors";
import { describeAllowedFileRoots, SecurityPolicy } from "@/server/policy";
import { ServerRuntime } from "@/server/runtime";
import { redactSecretPlaceholders, wrapUntrustedText } from "@/server/security";

import { testConfig } from "./helpers";

const TEST_HOME = join(tmpdir(), "smooth-operator-config-test-home");
const loadTestConfig = (args: string[] = [], environment: NodeJS.ProcessEnv = {}) => loadServerConfig(args, environment, TEST_HOME);

describe("configuration", () => {
  it("loads a server-only configuration without model or provider settings", () => {
    const config = loadTestConfig([], {
      SMOOTH_OPERATOR_BROWSER_MODE: "disabled",
      SMOOTH_OPERATOR_ALLOWED_DOMAINS: "example.com,*.example.org",
      SMOOTH_OPERATOR_DATA_DIR: "/tmp/smooth-operator-config-test",
    });
    expect(config.browser.mode).toBe("disabled");
    expect(config.security.allowedDomains).toEqual(["example.com", "*.example.org"]);
    expect("provider" in config).toBe(false);
  });

  it("ignores removed CAPTCHA solver environment keys", () => {
    const config = loadTestConfig([], {
      SMOOTH_OPERATOR_CAPTCHA_SOLVER: "2captcha",
      SMOOTH_OPERATOR_CAPTCHA_SOLVER_API_KEY: "test-key",
      SMOOTH_OPERATOR_CAPTCHA_SOLVER_POLL_INTERVAL_MS: "100",
    });
    expect("captchaSolver" in config).toBe(false);
  });

  it("rejects the removed per-server security mode setting", () => {
    expect(() => loadTestConfig([], { SMOOTH_OPERATOR_DEFAULT_MODE: "restricted" })).toThrowError(/capability profile/);
  });

  it("loads one native browser profile and runtime bounds", () => {
    const config = loadTestConfig([], {
      SMOOTH_OPERATOR_BROWSER_MODE: "launch",
      SMOOTH_OPERATOR_BROWSER_TIMEOUT_MS: "20000",
      SMOOTH_OPERATOR_BROWSER_CONNECT_TIMEOUT_MS: "45000",
      SMOOTH_OPERATOR_BROWSER_CDP_TIMEOUT_MS: "25000",
      SMOOTH_OPERATOR_MAX_SCREENSHOT_BYTES: "4000000",
      SMOOTH_OPERATOR_MAX_HTML_CHARS: "120000",
      SMOOTH_OPERATOR_BROWSER_VIEWPORT_WIDTH: "1280",
      SMOOTH_OPERATOR_BROWSER_VIEWPORT_HEIGHT: "720",
      SMOOTH_OPERATOR_BROWSER_EXECUTABLE: "/usr/bin/chromium",
    });
    expect("profile" in config.browser).toBe(false);
    expect(config.browser.actionTimeoutMs).toBe(20_000);
    expect(config.browser.connectTimeoutMs).toBe(45_000);
    expect(config.browser.cdpTimeoutMs).toBe(25_000);
    expect(config.browser.maxScreenshotBytes).toBe(4_000_000);
    expect(config.browser.maxHtmlChars).toBe(120_000);
    expect(config.browser.viewport).toEqual({ width: 1_280, height: 720 });
  });

  it("defaults idle browser cleanup off and accepts bounded environment values", () => {
    expect(loadTestConfig([], {}).browser.idleTimeoutMs).toBe(0);
    expect(loadTestConfig([], { SMOOTH_OPERATOR_BROWSER_IDLE_TIMEOUT_MS: "86400000" }).browser.idleTimeoutMs).toBe(86_400_000);
    for (const value of ["-1", "86400001"]) {
      expect(() => loadTestConfig([], { SMOOTH_OPERATOR_BROWSER_IDLE_TIMEOUT_MS: value })).toThrowError(/Configuration failed validation/);
    }
  });

  it("loads the JSON browser idle timeout and rejects unsafe bounds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-config-idle-"));
    const configPath = join(directory, "config.json");
    try {
      await writeFile(configPath, JSON.stringify({ browser: { idleTimeoutMs: 12_345 } }));
      await chmod(configPath, 0o600);
      expect(loadTestConfig(["--config", configPath], {}).browser.idleTimeoutMs).toBe(12_345);

      await writeFile(configPath, JSON.stringify({ browser: { idleTimeoutMs: 86_400_001 } }));
      await chmod(configPath, 0o600);
      expect(() => loadTestConfig(["--config", configPath], {})).toThrowError(/schema validation/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("defaults to full local capabilities while honoring explicit false settings", () => {
    const defaults = loadTestConfig([], {});
    const explicit = loadTestConfig([], {
      SMOOTH_OPERATOR_ALLOW_EVAL: "false",
      SMOOTH_OPERATOR_STEALTH_ENABLED: "false",
      SMOOTH_OPERATOR_BEHAVIOR_ENABLED: "false",
    });
    expect(defaults.security.allowEval).toBe(true);
    expect(defaults.stealth).toEqual({ enabled: true, profile: "balanced", gpu: false, behaviorEnabled: false });
    expect(explicit.security.allowEval).toBe(false);
    expect(explicit.stealth).toEqual({ enabled: false, profile: "balanced", gpu: false, behaviorEnabled: false });
  });

  it("expands and canonicalizes tilde paths against the supplied home directory", async () => {
    const config = loadTestConfig([], {
      SMOOTH_OPERATOR_DATA_DIR: "~/smooth-data",
      SMOOTH_OPERATOR_BROWSER_USER_DATA_DIR: "~/browser-profile",
      SMOOTH_OPERATOR_ALLOWED_FILE_ROOTS: "~/files",
    });
    expect(config.dataDir).toBe(join(TEST_HOME, "smooth-data"));
    expect(config.browser.userDataDir).toBe(join(TEST_HOME, "browser-profile"));
    const canonicalHome = join(await realpath(dirname(TEST_HOME)), basename(TEST_HOME));
    expect(config.security.allowedFileRoots).toEqual([join(canonicalHome, "files")]);
  });

  it("normalizes host and domain allowlists and rejects ambiguous host values", () => {
    const config = loadTestConfig([], {
      SMOOTH_OPERATOR_ALLOWED_HOSTS: "LOCALHOST., [::1]",
      SMOOTH_OPERATOR_ALLOWED_ORIGINS: "LOCALHOST.",
      SMOOTH_OPERATOR_ALLOWED_DOMAINS: "*.BÜCHER.example",
    });
    expect(config.http.allowedHosts).toEqual(["localhost", "[::1]"]);
    expect(config.http.allowedOrigins).toEqual(["localhost"]);
    expect(config.security.allowedDomains).toEqual(["*.xn--bcher-kva.example"]);
    expect(() => loadTestConfig([], { SMOOTH_OPERATOR_ALLOWED_HOSTS: "localhost:3344" })).toThrowError(/Configuration failed validation/);
    expect(() => loadTestConfig([], { SMOOTH_OPERATOR_ALLOWED_ORIGINS: "https://localhost" })).toThrowError(/Configuration failed validation/);
    expect(() => loadTestConfig([], { SMOOTH_OPERATOR_ALLOWED_DOMAINS: "*.[::1]" })).toThrowError(/Configuration failed validation/);
  });

  it("bounds raw environment list entries before normalization or filesystem traversal", async () => {
    const rawDomainEntries = Array.from({ length: 129 }, (_, index) => `entry-${index}.example`);
    const duplicateEntries = Array.from({ length: 129 }, () => "duplicate.example");
    const cases: Array<{ name: string; environment: NodeJS.ProcessEnv; expected: RegExp }> = [
      {
        name: "entry count",
        environment: { SMOOTH_OPERATOR_ALLOWED_DOMAINS: rawDomainEntries.join(",") },
        expected: /at most 128 entries/,
      },
      {
        name: "duplicate entry count",
        environment: { SMOOTH_OPERATOR_ALLOWED_DOMAINS: duplicateEntries.join(",") },
        expected: /at most 128 entries/,
      },
      {
        name: "domain item length",
        environment: { SMOOTH_OPERATOR_ALLOWED_DOMAINS: "a".repeat(MAX_CONFIG_DOMAIN_PATTERN_CHARS + 1) },
        expected: /entries must be 253 characters or shorter/,
      },
      {
        name: "host item length",
        environment: { SMOOTH_OPERATOR_ALLOWED_HOSTS: "a".repeat(MAX_CONFIG_HOST_PATTERN_CHARS + 1) },
        expected: /entries must be 255 characters or shorter/,
      },
      {
        name: "file-root item length",
        environment: { SMOOTH_OPERATOR_ALLOWED_FILE_ROOTS: `/definitely/nonexistent/${"a".repeat(MAX_CONFIG_FILE_ROOT_CHARS + 1)}` },
        expected: /entries must be 4096 characters or shorter/,
      },
      {
        name: "raw list length",
        environment: { SMOOTH_OPERATOR_ALLOWED_DOMAINS: "x".repeat(MAX_CONFIG_LIST_RAW_CHARS + 1) },
        expected: /lists must be .* characters or shorter/,
      },
    ];
    for (const testCase of cases) {
      let caught: unknown;
      try {
        loadTestConfig([], testCase.environment);
      } catch (error) {
        caught = error;
      }
      expect(caught, testCase.name).toMatchObject({ code: "CONFIG_INVALID" });
      expect(caught, testCase.name).toHaveProperty("message", expect.stringMatching(testCase.expected));
    }
    // This path is intentionally nonexistent and would otherwise reach the
    // filesystem canonicalizer; the bounded item check must win first.
    expect(() => loadTestConfig([], { SMOOTH_OPERATOR_ALLOWED_FILE_ROOTS: `/definitely/nonexistent/${"a".repeat(MAX_CONFIG_FILE_ROOT_CHARS + 1)}` })).not.toThrow(/must be directories/);
  });

  it("rejects oversized fallback arrays before file-root canonicalization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-config-list-fallback-"));
    const configPath = join(directory, "config.json");
    try {
      await writeFile(configPath, JSON.stringify({ security: { allowedFileRoots: Array.from({ length: 129 }, (_, index) => `/definitely/nonexistent/${index}`) } }));
      await chmod(configPath, 0o600);
      let caught: unknown;
      try {
        loadTestConfig(["--config", configPath], {});
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "CONFIG_INVALID" });
      expect(caught).toHaveProperty("message", expect.stringMatching(/schema validation/));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("trims and deduplicates normal list values without changing their field", async () => {
    const root = await mkdtemp(join(tmpdir(), "smooth-operator-config-list-normal-"));
    try {
      const config = loadTestConfig([], {
        SMOOTH_OPERATOR_ALLOWED_DOMAINS: " example.com, example.com ",
        SMOOTH_OPERATOR_ALLOWED_HOSTS: " localhost, localhost ",
        SMOOTH_OPERATOR_ALLOWED_FILE_ROOTS: ` ${root}, ${root} `,
      });
      expect(config.security.allowedDomains).toEqual(["example.com"]);
      expect(config.http.allowedHosts).toEqual(["localhost"]);
      expect(config.security.allowedFileRoots).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a filesystem root as a configured file root", () => {
    expect(() => loadTestConfig([], { SMOOTH_OPERATOR_ALLOWED_FILE_ROOTS: "/" })).toThrowError(/filesystem roots/);
  });

  it("rejects a regular file as a configured file root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-config-file-root-"));
    const file = join(directory, "root.txt");
    try {
      await writeFile(file, "not a directory");
      expect(() => loadTestConfig([], { SMOOTH_OPERATOR_ALLOWED_FILE_ROOTS: file })).toThrowError(/must be directories/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not read an explicit JSON config through a symlinked directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-config-link-"));
    const realDirectory = join(directory, "real");
    const linkedDirectory = join(directory, "linked");
    try {
      await mkdir(realDirectory);
      await symlink(realDirectory, linkedDirectory);
      await expect(() => loadServerConfig(["--config", join(linkedDirectory, "config.json")], {})).toThrowError(/symbolic links/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses managed, headed browser control by default while respecting explicit settings", () => {
    const defaults = loadTestConfig([], {});
    const explicit = loadTestConfig([], {
      SMOOTH_OPERATOR_BROWSER_MODE: "connect",
      SMOOTH_OPERATOR_BROWSER_HEADLESS: "true",
    });

    expect(defaults.browser).toMatchObject({ mode: "managed", headless: false, autoLaunch: false });
    expect(explicit.browser).toMatchObject({ mode: "connect", headless: true });
  });

  it("loads the wizard's default config and ignores unrelated root sections", async () => {
    const home = await mkdtemp(join(tmpdir(), "smooth-operator-default-config-"));
    const configDirectory = join(home, ".smooth-operator");
    const configPath = join(configDirectory, "config.json");
    try {
      await mkdir(configDirectory, { recursive: true });
      await writeFile(configPath, JSON.stringify({
        browser: { mode: "disabled", headless: true, viewport: { width: 1024, height: 768 } },
        security: { allowedDomains: ["example.com"], allowEval: false },
        dataDir: join(home, "runtime"),
        harness: { name: "unrelated" },
        captchaSolver: { provider: "2captcha", apiKey: "legacy-key" },
      }));
      await chmod(configPath, 0o600);

      const config = loadServerConfig([], {}, home);
      expect(config.browser).toMatchObject({ mode: "disabled", headless: true, viewport: { width: 1024, height: 768 } });
      expect(config.security.allowedDomains).toEqual(["example.com"]);
      expect(config.dataDir).toBe(join(home, "runtime"));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("accepts managed mode without an executable until browser use", () => {
    expect(loadTestConfig([], { SMOOTH_OPERATOR_BROWSER_MODE: "managed" }).browser.mode).toBe("managed");
    expect(loadTestConfig([], { SMOOTH_OPERATOR_BROWSER_AUTO_LAUNCH: "true" }).browser.mode).toBe("managed");
  });

  it("leaves the browser viewport undefined unless explicitly configured", () => {
    expect(loadTestConfig([], {}).browser.viewport).toBeUndefined();
    expect(loadTestConfig([], {
      SMOOTH_OPERATOR_BROWSER_VIEWPORT_WIDTH: "1366",
      SMOOTH_OPERATOR_BROWSER_VIEWPORT_HEIGHT: "768",
    }).browser.viewport).toEqual({ width: 1_366, height: 768 });
  });

  it("requires paired, bounded browser viewport dimensions", () => {
    expect(() => loadTestConfig([], { SMOOTH_OPERATOR_BROWSER_VIEWPORT_WIDTH: "1280" })).toThrowError(/requires both width and height/);
    expect(() => loadTestConfig([], { SMOOTH_OPERATOR_BROWSER_VIEWPORT_HEIGHT: "720" })).toThrowError(/requires both width and height/);
    expect(() => loadTestConfig([], {
      SMOOTH_OPERATOR_BROWSER_VIEWPORT_WIDTH: "0",
      SMOOTH_OPERATOR_BROWSER_VIEWPORT_HEIGHT: "720",
    })).toThrowError(/Configuration failed validation/);
    expect(() => loadTestConfig([], {
      SMOOTH_OPERATOR_BROWSER_VIEWPORT_WIDTH: "10001",
      SMOOTH_OPERATOR_BROWSER_VIEWPORT_HEIGHT: "720",
    })).toThrowError(/Configuration failed validation/);
  });

  it("requires an executable for explicit launch and connect auto-launch", () => {
    expect(() => loadTestConfig([], { SMOOTH_OPERATOR_BROWSER_MODE: "launch" })).toThrowError(/executable/i);
    expect(() => loadTestConfig([], {
      SMOOTH_OPERATOR_BROWSER_MODE: "connect",
      SMOOTH_OPERATOR_BROWSER_AUTO_LAUNCH: "true",
    })).toThrowError(/executable/i);
  });

  it("does not acquire a browser profile when browser control is disabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-runtime-disabled-"));
    const profile = join(directory, "private-profile");
    const base = testConfig();
    const runtime = await ServerRuntime.create(testConfig({
      dataDir: directory,
      browser: { ...base.browser, mode: "disabled", autoLaunch: true, executablePath: "/usr/bin/chromium", userDataDir: profile },
    }));
    try {
      expect(runtime.publicCapabilities()).toMatchObject({
        browser: { configured: false, connection: "disabled", runtime: { owned: false } },
        persistence: { state: "disabled" },
      });
      await expect(access(profile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsafe browser deadline values", () => {
    expect(() => loadTestConfig([], { SMOOTH_OPERATOR_BROWSER_CONNECT_TIMEOUT_MS: "999" })).toThrowError(/failed validation/i);
    expect(() => loadTestConfig([], { SMOOTH_OPERATOR_BROWSER_CDP_TIMEOUT_MS: "121000" })).toThrowError(/failed validation/i);
  });

  it("rejects removed browser profile environment switches", () => {
    expect(() => loadTestConfig([], { SMOOTH_OPERATOR_BROWSER_MODE: "disabled", SMOOTH_OPERATOR_BROWSER_PROFILE: "stealth" })).toThrowError(/profile switches were removed/);
    expect(() => loadTestConfig([], { SMOOTH_OPERATOR_BROWSER_MODE: "disabled", SMOOTH_OPERATOR_BROWSER_STEALTH: "true" })).toThrowError(/profile switches were removed/);
    expect(() => loadTestConfig([], { SMOOTH_OPERATOR_BROWSER_MODE: "disabled", SMOOTH_OPERATOR_BROWSER_USER_AGENT: "fake" })).toThrowError(/user-agent overrides were removed/);
  });

  it("rejects removed browser profile settings in JSON configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-config-"));
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ browser: { mode: "disabled", profile: "stealth" } }));
    await chmod(path, 0o600);
    expect(() => loadTestConfig(["--config", path], {})).toThrowError(AppError);
    await rm(directory, { recursive: true, force: true });
  });

  it("loads stealth settings and ignores removed CAPTCHA solver environment keys", () => {
    const config = loadTestConfig([], {
      SMOOTH_OPERATOR_STEALTH_ENABLED: "true",
      SMOOTH_OPERATOR_STEALTH_PROFILE: "max",
      SMOOTH_OPERATOR_STEALTH_GPU: "false",
      SMOOTH_OPERATOR_CAPTCHA_SOLVER: "capsolver",
      SMOOTH_OPERATOR_CAPTCHA_SOLVER_API_KEY: "  test-api-key  ",
      SMOOTH_OPERATOR_CAPTCHA_SOLVER_URL: "https://solver.example/api",
      SMOOTH_OPERATOR_CAPTCHA_SOLVER_PROXY_URL: "socks5://127.0.0.1:1080",
      SMOOTH_OPERATOR_CAPTCHA_SOLVER_TIMEOUT_MS: "120000",
      SMOOTH_OPERATOR_CAPTCHA_SOLVER_MAX_BYTES: "1000000",
    });
    expect(config.stealth).toEqual({ enabled: true, profile: "max", gpu: false, behaviorEnabled: false });
    expect("captchaSolver" in config).toBe(false);
    expect(config.stealth?.enabled).toBe(true);
  });

  it("defaults stealth to the enabled balanced profile", () => {
    const defaults = loadTestConfig([], {});
    expect(defaults.stealth).toEqual({ enabled: true, profile: "balanced", gpu: false, behaviorEnabled: false });
    expect(loadTestConfig([], { SMOOTH_OPERATOR_STEALTH_ENABLED: "false" }).stealth?.enabled).toBe(false);
  });

  it("keeps stealth enabled when only profile is configured", () => {
    const config = loadTestConfig([], { SMOOTH_OPERATOR_STEALTH_PROFILE: "max" });
    expect(config.stealth).toEqual({ enabled: true, profile: "max", gpu: false, behaviorEnabled: false });
  });

  it("inherits stealth behaviorEnabled from enabled and allows override", () => {
    const inherited = loadTestConfig([], { SMOOTH_OPERATOR_STEALTH_ENABLED: "true" });
    expect(inherited.stealth?.behaviorEnabled).toBe(false);
    const overridden = loadTestConfig([], {
      SMOOTH_OPERATOR_STEALTH_ENABLED: "true",
      SMOOTH_OPERATOR_BEHAVIOR_ENABLED: "false",
    });
    expect(overridden.stealth?.behaviorEnabled).toBe(false);
    expect(loadTestConfig([], { SMOOTH_OPERATOR_STEALTH_ENABLED: "false", SMOOTH_OPERATOR_BEHAVIOR_ENABLED: "true" }).stealth?.behaviorEnabled).toBe(true);
  });

  it("rejects unknown keys in the stealth section and removed root sections in explicit config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-config-stealth-"));
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({
      stealth: { enabled: true, unknownKey: true },
      captchaSolver: { provider: "none" },
    }));
    await chmod(path, 0o600);
    expect(() => loadTestConfig(["--config", path], {})).toThrowError(/Configuration file failed schema validation/);
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects invalid stealth profile", () => {
    expect(() => loadTestConfig([], { SMOOTH_OPERATOR_STEALTH_PROFILE: "extreme" })).toThrowError(/Configuration failed validation/);
    expect(() => loadTestConfig([], { SMOOTH_OPERATOR_STEALTH_PROFILE: "extreme" })).toThrowError(AppError);
  });

  it("rejects removed CAPTCHA solver sections from an explicit JSON configuration file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-config-stealth-ok-"));
    const path = join(directory, "config.json");
    try {
      await writeFile(path, JSON.stringify({
        stealth: { enabled: true, profile: "max" },
        captchaSolver: { provider: "2captcha", apiKey: "abc", timeoutMs: 5000, maxBytes: 4096 },
      }));
      await chmod(path, 0o600);
      expect(() => loadTestConfig(["--config", path], {})).toThrowError(/Configuration file failed schema validation/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("lets explicit environment stealth booleans override JSON booleans", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-config-stealth-precedence-"));
    const path = join(directory, "config.json");
    try {
      await writeFile(path, JSON.stringify({ stealth: { enabled: true, behaviorEnabled: true } }));
      await chmod(path, 0o600);
      const config = loadTestConfig(["--config", path], {
        SMOOTH_OPERATOR_STEALTH_ENABLED: "false",
        SMOOTH_OPERATOR_BEHAVIOR_ENABLED: "false",
      });
      expect(config.stealth).toEqual({ enabled: false, profile: "balanced", gpu: false, behaviorEnabled: false });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("honors explicit false booleans from JSON configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-config-false-precedence-"));
    const path = join(directory, "config.json");
    try {
      await writeFile(path, JSON.stringify({
        security: { allowEval: false },
        stealth: { enabled: false, behaviorEnabled: false },
      }));
      await chmod(path, 0o600);
      const config = loadTestConfig(["--config", path], {});
      expect(config.security.allowEval).toBe(false);
      expect(config.stealth).toEqual({ enabled: false, profile: "balanced", gpu: false, behaviorEnabled: false });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires a strong token for remote HTTP", () => {
    expect(() => loadTestConfig([], {
      SMOOTH_OPERATOR_HTTP_HOST: "0.0.0.0",
      SMOOTH_OPERATOR_ALLOW_REMOTE_HTTP: "true",
      SMOOTH_OPERATOR_HTTP_TOKEN: "too-short",
    })).toThrowError(AppError);
  });

  it("rejects malformed command-line options and unsafe HTTP settings", () => {
    expect(() => loadServerConfig(["--port"], {})).toThrowError(/requires a value/);
    expect(() => loadServerConfig(["--unknown", "value"], {})).toThrowError(/Unknown command-line option/);
    expect(() => loadTestConfig([], {
      SMOOTH_OPERATOR_HTTP_PATH: "/mcp?debug=true",
    })).toThrowError(/single absolute path/);
    expect(() => loadTestConfig([], {
      SMOOTH_OPERATOR_ALLOW_REMOTE_HTTP: "true",
      SMOOTH_OPERATOR_HTTP_TOKEN: "token-with whitespace-012345678901234567890",
    })).toThrowError(/printable ASCII/);
  });

  it("rejects malformed comma-separated configuration lists", () => {
    expect(() => loadTestConfig([], { SMOOTH_OPERATOR_ALLOWED_DOMAINS: "," })).toThrowError(/empty entries/);
    expect(() => loadTestConfig([], { SMOOTH_OPERATOR_ALLOWED_DOMAINS: "example.com,,other.example" })).toThrowError(/empty entries/);
    expect(() => loadTestConfig([], { SMOOTH_OPERATOR_BLOCKED_DOMAINS: "example.*" })).toThrowError(/Configuration failed validation/);
  });

  it("rejects malformed browser endpoints during configuration load", () => {
    expect(() => loadTestConfig([], { SMOOTH_OPERATOR_BROWSER_URL: "not-an-endpoint" })).toThrowError(/DevTools URL/);
    expect(() => loadTestConfig([], { SMOOTH_OPERATOR_BROWSER_URL: "file:///tmp/devtools" })).toThrowError(/absolute http: or https:/);
    expect(() => loadTestConfig([], { SMOOTH_OPERATOR_BROWSER_WS_ENDPOINT: "http://127.0.0.1:9222" })).toThrowError(/WebSocket endpoint/);
  });

  it("rejects group-readable JSON configuration", async () => {
    if (process.platform === "win32") {
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-config-"));
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ browser: { mode: "disabled" } }));
    await chmod(path, 0o644);
    expect(() => loadTestConfig(["--config", path], {})).toThrowError(/chmod 600/);
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects oversized JSON configuration before parsing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-config-large-"));
    const path = join(directory, "config.json");
    try {
      await writeFile(path, "x".repeat(2_000_001));
      await chmod(path, 0o600);
      expect(() => loadTestConfig(["--config", path], {})).toThrowError(/2000000 bytes or smaller/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not initialize runtime data through a symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-runtime-"));
    const target = join(directory, "target");
    const link = join(directory, "link");
    await mkdir(target);
    await symlink(target, link);
    await expect(ServerRuntime.create(testConfig({ dataDir: link }))).rejects.toThrow(/real directory/);
    await rm(directory, { recursive: true, force: true });
  });

  it("does not create a missing runtime target through a symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-runtime-symlink-"));
    const target = join(directory, "missing-target");
    const link = join(directory, "link");
    await symlink(target, link);
    await expect(ServerRuntime.create(testConfig({ dataDir: link }))).rejects.toThrow(/real directory/);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(directory, { recursive: true, force: true });
  });

  it("canonicalizes the runtime data directory before browser services use relative outputs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "smooth-operator-runtime-canonical-"));
    let runtime: ServerRuntime | undefined;
    try {
      const base = testConfig();
      const config = testConfig({ dataDir, security: { ...base.security, allowedFileRoots: [dataDir] } });
      const created = await ServerRuntime.create(config);
      runtime = created;
      expect(created.config.dataDir).toBe(await realpath(dataDir));
      expect(() => created.policy.assertFilePath(join(created.config.dataDir, "files", "page.pdf"))).not.toThrow();
    } finally {
      await runtime?.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("security policy", () => {
  it("redacts URL credentials and secret placeholders from untrusted text", () => {
    const value = "https://alice:super-secret@example.test/%TOKEN%";
    expect(redactSecretPlaceholders(value)).toBe("https://[REDACTED]@example.test/[SECRET_PLACEHOLDER]");
    const wrapped = wrapUntrustedText("page", value);
    expect(wrapped).not.toContain("super-secret");
    expect(wrapped).not.toContain("%TOKEN%");
  });

  it("blocks credentials, private hosts, and disallowed domains", () => {
    const policy = new SecurityPolicy(testConfig({ security: { ...testConfig().security, allowedDomains: ["example.com"] } }));
    expect(() => policy.assertNavigationAllowed("https://user:pass@example.com")).toThrowError(/credentials/);
    expect(() => policy.assertNavigationAllowed("http://192.168.1.10")).toThrowError(/Private-network/);
    expect(() => policy.assertNavigationAllowed("http://[::ffff:127.0.0.1]")).toThrowError(/Private-network/);
    expect(() => policy.assertNavigationAllowed("https://other.example")).toThrowError(/allowlist/);
    expect(policy.assertNavigationAllowed("https://example.com/path").hostname).toBe("example.com");
  });

  it("rejects URL hosts that normalize to an empty hostname", () => {
    const policy = new SecurityPolicy(testConfig());
    for (const rawUrl of ["http://.", "http://..", "http://%2e"]) {
      expect(() => policy.assertNavigationAllowed(rawUrl)).toThrowError(/host is invalid/i);
    }
  });

  it("fails closed when a programmatic blocklist contains an invalid pattern", () => {
    const policy = new SecurityPolicy(testConfig({ security: { ...testConfig().security, blockedDomains: ["example.*"] } }));
    expect(() => policy.assertNavigationAllowed("https://example.com")).toThrowError(/blocked-domain patterns are invalid/);
  });

  it("turns malformed programmatic blocklist values into policy errors", () => {
    const policy = new SecurityPolicy(testConfig({ security: { ...testConfig().security, blockedDomains: [42 as unknown as string] } }));
    expect(() => policy.assertNavigationAllowed("https://example.com")).toThrowError(/blocked-domain patterns are invalid/);
  });

  it("applies the same private-network policy to resolved literal targets", async () => {
    const policy = new SecurityPolicy(testConfig());
    await expect(policy.assertNavigationAllowedAsync("http://[::ffff:127.0.0.1]")).rejects.toThrow(/Private-network/);
  });

  it("does not cache public DNS answers", async () => {
    dnsLookup.mockReset();
    dnsLookup.mockResolvedValue([{ address: "93.184.216.34" }]);
    const policy = new SecurityPolicy(testConfig());
    await policy.assertNavigationAllowedAsync("https://public.example");
    await policy.assertNavigationAllowedAsync("https://public.example");
    expect(dnsLookup).toHaveBeenCalledTimes(2);
    dnsLookup.mockReset();
  });

  it("deduplicates concurrent DNS lookups without caching the public decision", async () => {
    dnsLookup.mockReset();
    let release!: (addresses: Array<{ address: string }>) => void;
    dnsLookup.mockImplementationOnce(() => new Promise<Array<{ address: string }>>((resolve) => { release = resolve; }));
    const policy = new SecurityPolicy(testConfig());
    const first = policy.assertNavigationAllowedAsync("https://concurrent.example");
    const second = policy.assertNavigationAllowedAsync("https://concurrent.example");
    await Promise.resolve();
    expect(dnsLookup).toHaveBeenCalledTimes(1);
    release([{ address: "93.184.216.34" }]);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    dnsLookup.mockResolvedValueOnce([{ address: "93.184.216.34" }]);
    await policy.assertNavigationAllowedAsync("https://concurrent.example");
    expect(dnsLookup).toHaveBeenCalledTimes(2);
    dnsLookup.mockReset();
  });

  it("cleans up a failed in-flight DNS lookup so a retry can resolve", async () => {
    dnsLookup.mockReset();
    dnsLookup.mockRejectedValueOnce(new Error("resolver unavailable"));
    const policy = new SecurityPolicy(testConfig());
    await expect(policy.assertNavigationAllowedAsync("https://retry.example")).rejects.toMatchObject({ code: "DNS_RESOLUTION_FAILED" });
    dnsLookup.mockResolvedValueOnce([{ address: "93.184.216.34" }]);
    await expect(policy.assertNavigationAllowedAsync("https://retry.example")).resolves.toBeInstanceOf(URL);
    expect(dnsLookup).toHaveBeenCalledTimes(2);
    dnsLookup.mockReset();
  });

  it("rechecks a hostname when a later DNS answer becomes private", async () => {
    dnsLookup.mockReset();
    dnsLookup
      .mockResolvedValueOnce([{ address: "93.184.216.34" }])
      .mockResolvedValueOnce([{ address: "127.0.0.1" }]);
    const policy = new SecurityPolicy(testConfig());
    await policy.assertNavigationAllowedAsync("https://rebind.example");
    await expect(policy.assertNavigationAllowedAsync("https://rebind.example")).rejects.toThrow(/private network address/i);
    expect(dnsLookup).toHaveBeenCalledTimes(2);
    dnsLookup.mockReset();
  });

  it("times out hung DNS lookups and allows a later retry", async () => {
    vi.useFakeTimers();
    try {
      dnsLookup.mockReset();
      dnsLookup.mockImplementationOnce(() => new Promise(() => undefined));
      const policy = new SecurityPolicy(testConfig());
      const pending = policy.assertNavigationAllowedAsync("https://hung-dns.example");
      const expectedTimeout = expect(pending).rejects.toMatchObject({ code: "DNS_RESOLUTION_FAILED" });
      await vi.advanceTimersByTimeAsync(10_000);
      await expectedTimeout;

      dnsLookup.mockResolvedValueOnce([{ address: "93.184.216.34" }]);
      await expect(policy.assertNavigationAllowedAsync("https://hung-dns.example")).resolves.toBeInstanceOf(URL);
    } finally {
      dnsLookup.mockReset();
      vi.useRealTimers();
    }
  });

  it("fails closed when any DNS answer is private or malformed", async () => {
    dnsLookup.mockReset();
    dnsLookup.mockResolvedValueOnce([{ address: "93.184.216.34" }, { address: "10.0.0.4" }]);
    const mixed = new SecurityPolicy(testConfig());
    await expect(mixed.assertNavigationAllowedAsync("https://mixed.example")).rejects.toThrow(/private network address/i);
    dnsLookup.mockResolvedValueOnce([{ address: 123 }]);
    const malformed = new SecurityPolicy(testConfig());
    await expect(malformed.assertNavigationAllowedAsync("https://malformed.example")).rejects.toMatchObject({ code: "DNS_RESOLUTION_FAILED" });
    dnsLookup.mockReset();
  });

  it("blocks reserved, multicast, and unspecified address literals", () => {
    const policy = new SecurityPolicy(testConfig());
    for (const address of ["0.0.0.0", "192.0.2.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "[::]", "[::192.168.1.1]", "[fec0::1]", "[ff02::1]", "[2001:db8::1]"]) {
      expect(() => policy.assertNavigationAllowed(`http://${address}`)).toThrowError(/Private-network/);
    }
    expect(() => policy.assertNavigationAllowed("http://[0:0:0:0:0:0:0:1]")).not.toThrow();
    // NAT64/Teredo embedded IPv4 hosts inherit the private decision of the
    // embedded address; the last literal uses the synchronous path (no DNS).
    const policyV6 = new SecurityPolicy(testConfig());
    expect(() => policyV6.assertNavigationAllowed("http://[64:ff9b::127.0.0.1]")).toThrowError(/Private-network/);
    expect(() => policyV6.assertNavigationAllowed("http://[2001:0:abcd:dcba::1]")).toThrowError(/Private-network/);
    expect(() => policyV6.assertNavigationAllowed("http://[2001:0:abcd:dcba::f5ff:fffe]")).toThrowError(/Private-network/);
    expect(() => policyV6.assertNavigationAllowed("http://[2002:7f00:1::1]")).toThrowError(/Private-network/);
    expect(() => policyV6.assertNavigationAllowed("http://[64:ff9b::9.9.9.9]")).not.toThrow();
  });

  it("normalizes Unicode allowlist suffixes and denies invalid patterns", () => {
    const policy = new SecurityPolicy(testConfig({ security: { ...testConfig().security, allowedDomains: ["*.bücher.example"] } }));
    expect(policy.assertNavigationAllowed("https://shop.xn--bcher-kva.example").hostname).toBe("shop.xn--bcher-kva.example");
    expect(() => policy.assertNavigationAllowed("https://bücher.example")).toThrowError(/allowlist/);
    const invalid = new SecurityPolicy(testConfig({ security: { ...testConfig().security, allowedDomains: ["*.*.example"] } }));
    expect(() => invalid.assertNavigationAllowed("https://example")).toThrowError(/allowlist/);
  });

  it("keeps file paths inside configured roots", () => {
    const policy = new SecurityPolicy(testConfig());
    const root = testConfig().dataDir;
    const inside = join(root, "file.txt");
    const outside = join(dirname(root), "smooth-operator-outside", "file.txt");
    expect(policy.assertFilePath(inside)).toBe(inside);
    expect(() => policy.assertFilePath(outside)).toThrowError(/file roots/);
  });

  it("reports canonical allowed roots without exposing a rejected candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "smooth-operator-file-root-details-"));
    const canonicalRoot = await realpath(root);
    const rejected = join(root, "..", "smooth-operator-file-root-details-outside", "secret.txt");
    try {
      const base = testConfig();
      const policy = new SecurityPolicy(testConfig({
        security: { ...base.security, allowedFileRoots: [root] },
      }));
      expect(policy.getAllowedFileRoots()).toEqual([{ id: "root-1", path: canonicalRoot }]);
      expect(describeAllowedFileRoots([root])).toEqual([{ id: "root-1", path: canonicalRoot }]);
      let error: AppError | undefined;
      try {
        policy.assertFilePath(rejected);
      } catch (caught) {
        error = caught as AppError;
      }
      expect(error).toBeInstanceOf(AppError);
      expect(error?.details).toMatchObject({
        reason: "outside_allowed_root",
        allowedRoots: [{ id: "root-1", path: canonicalRoot }],
      });
      expect(error?.message).not.toContain(rejected);
      expect(JSON.stringify(error)).not.toContain(rejected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts canonical paths for a symlinked root without allowing symlink escapes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-file-root-"));
    const physicalRoot = join(directory, "physical");
    const configuredRoot = join(directory, "configured");
    const file = join(physicalRoot, "fixture.txt");
    const outside = join(directory, "outside.txt");
    const escaped = join(configuredRoot, "escape.txt");
    const dangling = join(configuredRoot, "dangling.txt");
    await mkdir(physicalRoot);
    await symlink(physicalRoot, configuredRoot);
    await writeFile(file, "fixture");
    await writeFile(outside, "outside");
    await symlink(outside, escaped);
    await symlink(join(directory, "missing-target.txt"), dangling);

    try {
      const base = testConfig();
      const policy = new SecurityPolicy(testConfig({
        security: { ...base.security, allowedFileRoots: [configuredRoot] },
      }));
      const canonicalFile = await realpath(file);

      expect(policy.assertFilePath(join(configuredRoot, "fixture.txt"))).toBe(join(configuredRoot, "fixture.txt"));
      expect(policy.assertFilePath(canonicalFile)).toBe(canonicalFile);
      expect(() => policy.assertFilePath(escaped)).toThrowError(/file roots/);
      expect(() => policy.assertFilePath(dangling)).toThrowError(/symbolic link/);
      expect(() => policy.assertFilePath(join(configuredRoot, "missing.txt"), { mustExist: true })).toThrowError(/does not exist/);
      expect(() => policy.assertFilePath(`${join(configuredRoot, "missing.txt")}\0`)).toThrowError(/null bytes/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
