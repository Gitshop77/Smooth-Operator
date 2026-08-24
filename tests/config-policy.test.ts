import { access, chmod, mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const dnsLookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: dnsLookup }));

import { loadServerConfig } from "@/server/config";
import { AppError } from "@/server/errors";
import { SecurityPolicy } from "@/server/policy";
import { ServerRuntime } from "@/server/runtime";

import { testConfig } from "./helpers";

describe("configuration", () => {
  it("loads a server-only configuration without model or provider settings", () => {
    const config = loadServerConfig([], {
      OPEN_COWORK_BROWSER_MODE: "disabled",
      OPEN_COWORK_ALLOWED_DOMAINS: "example.com,*.example.org",
      OPEN_COWORK_DATA_DIR: "/tmp/open-cowork-config-test",
    });
    expect(config.browser.mode).toBe("disabled");
    expect(config.security.allowedDomains).toEqual(["example.com", "*.example.org"]);
    expect("provider" in config).toBe(false);
  });

  it("rejects the removed per-server security mode setting", () => {
    expect(() => loadServerConfig([], { OPEN_COWORK_DEFAULT_MODE: "restricted" })).toThrowError(/capability profile/);
  });

  it("loads one native browser profile and runtime bounds", () => {
    const config = loadServerConfig([], {
      OPEN_COWORK_BROWSER_MODE: "launch",
      OPEN_COWORK_BROWSER_TIMEOUT_MS: "20000",
      OPEN_COWORK_BROWSER_CONNECT_TIMEOUT_MS: "45000",
      OPEN_COWORK_BROWSER_CDP_TIMEOUT_MS: "25000",
      OPEN_COWORK_MAX_SCREENSHOT_BYTES: "4000000",
      OPEN_COWORK_MAX_HTML_CHARS: "120000",
      OPEN_COWORK_BROWSER_EXECUTABLE: "/usr/bin/chromium",
    });
    expect("profile" in config.browser).toBe(false);
    expect(config.browser.actionTimeoutMs).toBe(20_000);
    expect(config.browser.connectTimeoutMs).toBe(45_000);
    expect(config.browser.cdpTimeoutMs).toBe(25_000);
    expect(config.browser.maxScreenshotBytes).toBe(4_000_000);
    expect(config.browser.maxHtmlChars).toBe(120_000);
  });

  it("uses managed, headed browser control by default while respecting explicit settings", () => {
    const defaults = loadServerConfig([], {});
    const explicit = loadServerConfig([], {
      OPEN_COWORK_BROWSER_MODE: "connect",
      OPEN_COWORK_BROWSER_HEADLESS: "true",
    });

    expect(defaults.browser).toMatchObject({ mode: "managed", headless: false, autoLaunch: false });
    expect(explicit.browser).toMatchObject({ mode: "connect", headless: true });
  });

  it("accepts managed mode without an executable until browser use", () => {
    expect(loadServerConfig([], { OPEN_COWORK_BROWSER_MODE: "managed" }).browser.mode).toBe("managed");
    expect(loadServerConfig([], { OPEN_COWORK_BROWSER_AUTO_LAUNCH: "true" }).browser.mode).toBe("managed");
  });

  it("requires an executable for explicit launch and connect auto-launch", () => {
    expect(() => loadServerConfig([], { OPEN_COWORK_BROWSER_MODE: "launch" })).toThrowError(/executable/i);
    expect(() => loadServerConfig([], {
      OPEN_COWORK_BROWSER_MODE: "connect",
      OPEN_COWORK_BROWSER_AUTO_LAUNCH: "true",
    })).toThrowError(/executable/i);
  });

  it("does not acquire a browser profile when browser control is disabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "open-cowork-runtime-disabled-"));
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
    expect(() => loadServerConfig([], { OPEN_COWORK_BROWSER_CONNECT_TIMEOUT_MS: "999" })).toThrowError(/failed validation/i);
    expect(() => loadServerConfig([], { OPEN_COWORK_BROWSER_CDP_TIMEOUT_MS: "121000" })).toThrowError(/failed validation/i);
  });

  it("rejects removed browser profile environment switches", () => {
    expect(() => loadServerConfig([], { OPEN_COWORK_BROWSER_MODE: "disabled", OPEN_COWORK_BROWSER_PROFILE: "stealth" })).toThrowError(/profile switches were removed/);
    expect(() => loadServerConfig([], { OPEN_COWORK_BROWSER_MODE: "disabled", OPEN_COWORK_BROWSER_STEALTH: "true" })).toThrowError(/profile switches were removed/);
    expect(() => loadServerConfig([], { OPEN_COWORK_BROWSER_MODE: "disabled", OPEN_COWORK_BROWSER_USER_AGENT: "fake" })).toThrowError(/user-agent overrides were removed/);
  });

  it("rejects removed browser profile settings in JSON configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "open-cowork-config-"));
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ browser: { mode: "disabled", profile: "stealth" } }));
    await chmod(path, 0o600);
    expect(() => loadServerConfig(["--config", path], {})).toThrowError(AppError);
    await rm(directory, { recursive: true, force: true });
  });

  it("requires a strong token for remote HTTP", () => {
    expect(() => loadServerConfig([], {
      OPEN_COWORK_HTTP_HOST: "0.0.0.0",
      OPEN_COWORK_ALLOW_REMOTE_HTTP: "true",
      OPEN_COWORK_HTTP_TOKEN: "too-short",
    })).toThrowError(AppError);
  });

  it("rejects malformed command-line options and unsafe HTTP settings", () => {
    expect(() => loadServerConfig(["--port"], {})).toThrowError(/requires a value/);
    expect(() => loadServerConfig(["--unknown", "value"], {})).toThrowError(/Unknown command-line option/);
    expect(() => loadServerConfig([], {
      OPEN_COWORK_HTTP_PATH: "/mcp?debug=true",
    })).toThrowError(/single absolute path/);
    expect(() => loadServerConfig([], {
      OPEN_COWORK_ALLOW_REMOTE_HTTP: "true",
      OPEN_COWORK_HTTP_TOKEN: "token-with whitespace-012345678901234567890",
    })).toThrowError(/printable ASCII/);
  });

  it("rejects group-readable JSON configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "open-cowork-config-"));
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ browser: { mode: "disabled" } }));
    await chmod(path, 0o644);
    expect(() => loadServerConfig(["--config", path], {})).toThrowError(/chmod 600/);
    await rm(directory, { recursive: true, force: true });
  });

  it("does not initialize runtime data through a symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "open-cowork-runtime-"));
    const target = join(directory, "target");
    const link = join(directory, "link");
    await mkdir(target);
    await symlink(target, link);
    await expect(ServerRuntime.create(testConfig({ dataDir: link }))).rejects.toThrow(/real directory/);
    await rm(directory, { recursive: true, force: true });
  });

  it("does not create a missing runtime target through a symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "open-cowork-runtime-symlink-"));
    const target = join(directory, "missing-target");
    const link = join(directory, "link");
    await symlink(target, link);
    await expect(ServerRuntime.create(testConfig({ dataDir: link }))).rejects.toThrow(/real directory/);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(directory, { recursive: true, force: true });
  });

  it("canonicalizes the runtime data directory before browser services use relative outputs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "open-cowork-runtime-canonical-"));
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
  it("blocks credentials, private hosts, and disallowed domains", () => {
    const policy = new SecurityPolicy(testConfig({ security: { ...testConfig().security, allowedDomains: ["example.com"] } }));
    expect(() => policy.assertNavigationAllowed("https://user:pass@example.com")).toThrowError(/credentials/);
    expect(() => policy.assertNavigationAllowed("http://192.168.1.10")).toThrowError(/Private-network/);
    expect(() => policy.assertNavigationAllowed("http://[::ffff:127.0.0.1]")).toThrowError(/Private-network/);
    expect(() => policy.assertNavigationAllowed("https://other.example")).toThrowError(/allowlist/);
    expect(policy.assertNavigationAllowed("https://example.com/path").hostname).toBe("example.com");
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
    expect(policy.assertFilePath("/tmp/open-cowork-test/file.txt")).toBe("/tmp/open-cowork-test/file.txt");
    expect(() => policy.assertFilePath("/tmp/outside/file.txt")).toThrowError(/file roots/);
  });

  it("accepts canonical paths for a symlinked root without allowing symlink escapes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "open-cowork-file-root-"));
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
