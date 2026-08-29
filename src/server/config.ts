import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { env } from "node:process";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { join, parse, resolve, sep } from "node:path";
import { domainToASCII } from "node:url";
import process from "node:process";

import * as z from "zod/v4";

import { AppError } from "./errors";
import type { LogLevel } from "./logger";
import { canonicalizeAllowedFileRoots } from "./policy";

const TransportSchema = z.enum(["stdio", "http"]);
const BrowserModeSchema = z.enum(["disabled", "connect", "launch", "managed"]);
const ConfigPathSchema = z.string().trim().min(1).max(4_096);
const DomainPatternSchema = z.string().trim().min(1).max(253).refine(isValidDomainPattern, "Domain patterns must be exact hostnames or *.-prefixed suffixes.");
const HostPatternSchema = z.string().trim().min(1).max(255).refine(isValidHostPattern, "Host allowlists must contain hostnames or bracketed IPv6 addresses without ports.");
const ViewportDimensionSchema = z.number().int().min(1).max(10_000);
const BrowserViewportSchema = z.object({ width: ViewportDimensionSchema, height: ViewportDimensionSchema }).strict();
const ConfigList = <T extends z.ZodType>(schema: T) => z.array(schema).max(128);
const MAX_CONFIG_FILE_BYTES = 2_000_000;

const RawConfigSchema = z
  .object({
    transport: TransportSchema.optional(),
    http: z
      .object({
        host: z.string().trim().min(1).max(255).optional(),
        port: z.number().int().min(1).max(65_535).optional(),
        path: z.string().trim().min(1).max(4_096).optional(),
        token: z.string().min(1).max(4_096).optional(),
        allowRemote: z.boolean().optional(),
        allowedHosts: ConfigList(HostPatternSchema).optional(),
        allowedOrigins: ConfigList(HostPatternSchema).optional(),
        maxBodyBytes: z.number().int().min(1_024).max(20_000_000).optional(),
      })
      .strict()
      .optional(),
    browser: z
      .object({
        mode: BrowserModeSchema.optional(),
        wsEndpoint: ConfigPathSchema.optional(),
        url: ConfigPathSchema.optional(),
        executablePath: ConfigPathSchema.optional(),
        headless: z.boolean().optional(),
        viewport: BrowserViewportSchema.optional(),
        userDataDir: ConfigPathSchema.optional(),
        autoLaunch: z.boolean().optional(),
        actionTimeoutMs: z.number().int().min(100).max(120_000).optional(),
        connectTimeoutMs: z.number().int().min(1_000).max(180_000).optional(),
        cdpTimeoutMs: z.number().int().min(100).max(120_000).optional(),
        maxScreenshotBytes: z.number().int().min(100_000).max(20_000_000).optional(),
        maxHtmlChars: z.number().int().min(1_000).max(500_000).optional(),
      })
      .strict()
      .optional(),
    security: z
      .object({
        allowedDomains: ConfigList(DomainPatternSchema).optional(),
        blockedDomains: ConfigList(DomainPatternSchema).optional(),
        allowedFileRoots: ConfigList(ConfigPathSchema).optional(),
        allowPrivateNetwork: z.boolean().optional(),
        allowEval: z.boolean().optional(),
      })
      .strict()
      .optional(),
    dataDir: ConfigPathSchema.optional(),
    logLevel: z.enum(["debug", "info", "warn", "error"]).optional(),
    stealth: z
      .object({
        enabled: z.boolean().optional(),
        profile: z.enum(["balanced", "max"]).optional(),
        gpu: z.boolean().optional(),
        behaviorEnabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type RawConfig = z.infer<typeof RawConfigSchema>;

type Transport = z.infer<typeof TransportSchema>;

export interface ServerConfig {
  transport: Transport;
  http: {
    host: string;
    port: number;
    path: string;
    token?: string;
    allowRemote: boolean;
    allowedHosts: string[];
    allowedOrigins: string[];
    maxBodyBytes: number;
  };
  browser: {
    mode: z.infer<typeof BrowserModeSchema>;
    wsEndpoint?: string;
    url?: string;
    executablePath?: string;
    headless: boolean;
    viewport?: { width: number; height: number };
    userDataDir?: string;
    autoLaunch: boolean;
    actionTimeoutMs: number;
    connectTimeoutMs: number;
    cdpTimeoutMs: number;
    maxScreenshotBytes: number;
    maxHtmlChars: number;
  };
  security: {
    allowedDomains: string[];
    blockedDomains: string[];
    allowedFileRoots: string[];
    allowPrivateNetwork: boolean;
    allowEval: boolean;
  };
  stealth: {
    enabled: boolean;
    profile: "balanced" | "max";
    gpu: boolean;
    behaviorEnabled: boolean;
  };
  dataDir: string;
  logLevel: LogLevel;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase();
  if (trimmed === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (trimmed === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  throw new AppError("CONFIG_INVALID", `Invalid boolean value '${value}'.`);
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed)) {
    throw new AppError("CONFIG_INVALID", `Invalid integer value '${value}'.`);
  }
  return parsed;
}

function parseOptionalInteger(value: string | undefined, fallback: number | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed)) {
    throw new AppError("CONFIG_INVALID", `Invalid integer value '${value}'.`);
  }
  return parsed;
}

function resolveBrowserViewport(width: number | undefined, height: number | undefined): { width: number; height: number } | undefined {
  if (width === undefined && height === undefined) {
    return undefined;
  }
  if (width === undefined || height === undefined) {
    throw new AppError("CONFIG_INVALID", "Browser viewport configuration requires both width and height.");
  }
  return { width, height };
}

function parseList(value: string | undefined, fallback: string[] = []): string[] {
  if (value === undefined || value.trim() === "") {
    return normalizeList(fallback);
  }
  const items = value.split(",").map((item) => item.trim());
  if (items.some((item) => item.length === 0)) {
    throw new AppError("CONFIG_INVALID", "Configured comma-separated lists must not contain empty entries.");
  }
  return normalizeList(items);
}

function expandPath(value: string, homeDirectory = homedir()): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) {
    throw new AppError("CONFIG_INVALID", "Configured paths must be non-empty and must not contain null bytes.");
  }
  const expanded = trimmed === "~" ? homeDirectory : trimmed.startsWith("~/") ? join(homeDirectory, trimmed.slice(2)) : trimmed;
  return resolve(expanded);
}

function normalizeList(values: readonly string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function normalizeDomainPattern(value: string): string {
  const trimmed = value.trim().replace(/^\.+|\.+$/g, "");
  const wildcard = trimmed.startsWith("*.");
  const base = wildcard ? trimmed.slice(2) : trimmed;
  const bracketless = base.replace(/^\[|\]$/g, "");
  if (isIP(bracketless) !== 0) {
    return `${wildcard ? "*." : ""}${bracketless.toLowerCase()}`;
  }
  return `${wildcard ? "*." : ""}${domainToASCII(base).toLowerCase()}`;
}

function normalizeDomainList(values: readonly string[]): string[] {
  const normalized = normalizeList(values);
  if (normalized.some((value) => !isValidDomainPattern(value))) {
    throw new AppError("CONFIG_INVALID", "Configuration failed validation: configured domain patterns must be exact hostnames or *.-prefixed suffixes.");
  }
  return normalized.map(normalizeDomainPattern);
}

function normalizeHostPattern(value: string): string {
  const trimmed = value.trim();
  if (!isValidHostPattern(trimmed)) {
    throw new AppError("CONFIG_INVALID", "Configuration failed validation: configured HTTP host allowlists must contain hostnames or bracketed IPv6 addresses without ports.");
  }
  try {
    return new URL(`http://${trimmed}`).hostname.toLowerCase();
  } catch (error) {
    throw new AppError("CONFIG_INVALID", "Configuration failed validation: configured HTTP host allowlists contain an invalid hostname.", { cause: error });
  }
}

function normalizeHostList(values: readonly string[]): string[] {
  return normalizeList(values).map(normalizeHostPattern);
}

function isValidDomainPattern(value: string): boolean {
  const trimmed = value.trim().replace(/^\.+|\.+$/g, "");
  const wildcard = trimmed.startsWith("*.");
  const base = wildcard ? trimmed.slice(2) : trimmed;
  if (!base || (trimmed.includes("*") && !wildcard) || base.includes("..")) {
    return false;
  }
  const bracketless = base.replace(/^\[|\]$/g, "");
  if (isIP(bracketless) !== 0) {
    return true;
  }
  let ascii: string;
  try {
    ascii = domainToASCII(base);
  } catch {
    return false;
  }
  if (!ascii || ascii.length > 253) {
    return false;
  }
  return ascii.split(".").every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

function isValidHostPattern(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u0020/?#@]/.test(trimmed) || trimmed.includes("*")) {
    return false;
  }
  try {
    const endpoint = new URL(`http://${trimmed}`);
    return Boolean(endpoint.hostname)
      && endpoint.username === ""
      && endpoint.password === ""
      && endpoint.port === ""
      && endpoint.pathname === "/"
      && endpoint.search === ""
      && endpoint.hash === "";
  } catch {
    return false;
  }
}

function isValidListenHost(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u0020/?#@]/.test(trimmed)) {
    return false;
  }
  const bracketless = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  if (isIP(bracketless) !== 0) {
    return true;
  }
  return isValidHostPattern(trimmed);
}

function trimOptional(value: string | undefined): string | undefined {
  return value?.trim();
}

function expandOptionalPath(value: string | undefined, homeDirectory = homedir()): string | undefined {
  return value === undefined ? undefined : expandPath(value, homeDirectory);
}

function isErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}

function isAllowedSystemAlias(path: string): boolean {
  return process.platform === "darwin" && (path === "/var" || path === "/tmp" || path === "/etc");
}

function assertNoSymlinkComponents(path: string): void {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() && !isAllowedSystemAlias(current)) {
        throw new AppError("CONFIG_INSECURE", "Configuration paths must not contain symbolic links.");
      }
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
  }
}

function readBoundedConfigText(descriptor: number, expectedBytes = MAX_CONFIG_FILE_BYTES): string {
  // Start at the observed size (plus one byte) to avoid reserving 2 MiB for a
  // typical tiny config. If the file grows after fstat, expand geometrically
  // up to one byte beyond the hard limit so the race is still detected without
  // ever allocating an unbounded buffer.
  const allocation = Math.min(MAX_CONFIG_FILE_BYTES, Math.max(0, Math.trunc(expectedBytes))) + 1;
  let buffer = Buffer.allocUnsafe(allocation);
  let offset = 0;
  while (true) {
    if (offset === buffer.byteLength) {
      if (buffer.byteLength >= MAX_CONFIG_FILE_BYTES + 1) break;
      const nextLength = Math.min(MAX_CONFIG_FILE_BYTES + 1, Math.max(buffer.byteLength * 2, offset + 1));
      const expanded = Buffer.allocUnsafe(nextLength);
      buffer.copy(expanded, 0, 0, offset);
      buffer = expanded;
    }
    const bytesRead = readSync(descriptor, buffer, offset, buffer.byteLength - offset, offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  if (offset > MAX_CONFIG_FILE_BYTES) {
    throw new AppError("CONFIG_INVALID", `Configuration files must be ${MAX_CONFIG_FILE_BYTES} bytes or smaller.`);
  }
  return buffer.subarray(0, offset).toString("utf8");
}

interface ReadConfigOptions {
  allowMissing?: boolean;
  allowUnknownRootKeys?: boolean;
}

function readConfigFile(configPath: string, options: ReadConfigOptions = {}): RawConfig {
  let descriptor: number | undefined;
  try {
    // Inspect parent components as well as the final file. O_NOFOLLOW only
    // protects the final component; a user-controlled symlinked directory
    // would otherwise redirect a trusted config path outside the profile.
    assertNoSymlinkComponents(configPath);
    // Open and inspect the same descriptor that is subsequently read.  On
    // platforms that expose O_NOFOLLOW this prevents a symlink swap between
    // an lstat and the read.  The lstat fallback is retained for platforms
    // without that flag, where Node cannot request no-follow semantics.
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const closeOnExecValue = (constants as unknown as Record<string, unknown>).O_CLOEXEC;
    const closeOnExec = typeof closeOnExecValue === "number" ? closeOnExecValue : 0;
    if (noFollow === 0) {
      const beforeOpen = lstatSync(configPath);
      if (beforeOpen.isSymbolicLink()) {
        throw new AppError("CONFIG_INSECURE", "Configuration files must not be symbolic links.");
      }
    }
    descriptor = openSync(configPath, constants.O_RDONLY | noFollow | closeOnExec);
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new AppError("CONFIG_INVALID", "The configuration path must point to a regular file.");
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && stats.uid !== uid) {
      throw new AppError("CONFIG_INSECURE", "Configuration files must be owned by the current user.");
    }
    // Windows mode bits are compatibility metadata, not an ACL. Preserve the
    // symlink/regular-file checks there and enforce owner-only bits on POSIX.
    if (process.platform !== "win32") {
      const mode = stats.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        throw new AppError("CONFIG_INSECURE", "Configuration files must use owner-only permissions (for example, chmod 600).");
      }
    }
    if (stats.size > MAX_CONFIG_FILE_BYTES) {
      throw new AppError("CONFIG_INVALID", `Configuration files must be ${MAX_CONFIG_FILE_BYTES} bytes or smaller.`);
    }
    const parsed = JSON.parse(readBoundedConfigText(descriptor, stats.size)) as unknown;
    // The wizard intentionally preserves unrelated root sections so it can
    // coexist with harness settings. Explicit --config files remain strict;
    // the auto-discovered wizard file only consumes SmoothOperator's known
    // sections and ignores unrelated root settings.
    const schema = options.allowUnknownRootKeys ? RawConfigSchema.strip() : RawConfigSchema;
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new AppError("CONFIG_INVALID", "Configuration file failed schema validation.", {
        details: { issues: result.error.issues.map((issue) => issue.message) },
      });
    }
    return result.data;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    if (options.allowMissing && isErrorCode(error, "ENOENT")) {
      return {};
    }
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ELOOP") {
      throw new AppError("CONFIG_INSECURE", "Configuration files must not be symbolic links.", { cause: error });
    }
    throw new AppError("CONFIG_INVALID", "Unable to inspect or read the configuration file.", { cause: error });
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The original validation/read error is more useful than a close
        // failure, and the descriptor is no longer usable after this path.
      }
    }
  }
}

function validateConfig(config: ServerConfig): ServerConfig {
  if (!config.http.path.startsWith("/") || /[\u0000-\u0020?#]/.test(config.http.path) || config.http.path.includes("//")) {
    throw new AppError("CONFIG_INVALID", "HTTP path must be a single absolute path without whitespace, query, or fragment components.");
  }
  if (!isValidListenHost(config.http.host)) {
    throw new AppError("CONFIG_INVALID", "HTTP host must be a hostname or IP address without a port, path, or credentials.");
  }
  if (config.http.token !== undefined && !/^[\x21-\x7e]+$/.test(config.http.token)) {
    throw new AppError("CONFIG_INVALID", "HTTP tokens must contain printable ASCII characters only.");
  }
  if (config.http.allowRemote && (!config.http.token || config.http.token.length < 32)) {
    throw new AppError("CONFIG_INVALID", "Remote HTTP transport requires a token of at least 32 characters.");
  }
  const localHost = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(config.http.host.trim().toLowerCase());
  if (!localHost && !config.http.allowRemote) {
    throw new AppError("CONFIG_INVALID", "Remote HTTP binding is disabled by default.");
  }
  if (config.browser.mode === "launch" && !config.browser.executablePath) {
    throw new AppError("CONFIG_INVALID", "Launch mode requires SMOOTH_OPERATOR_BROWSER_EXECUTABLE.");
  }
  if (config.browser.autoLaunch && config.browser.mode === "connect" && !config.browser.executablePath) {
    throw new AppError("CONFIG_INVALID", "Automatic browser launch requires SMOOTH_OPERATOR_BROWSER_EXECUTABLE.");
  }
  if (config.browser.actionTimeoutMs < 100 || config.browser.actionTimeoutMs > 120_000) {
    throw new AppError("CONFIG_INVALID", "Browser action timeout must be between 100ms and 120000ms.");
  }
  if (config.browser.connectTimeoutMs < 1_000 || config.browser.connectTimeoutMs > 180_000) {
    throw new AppError("CONFIG_INVALID", "Browser connection timeout must be between 1000ms and 180000ms.");
  }
  if (config.browser.cdpTimeoutMs < 100 || config.browser.cdpTimeoutMs > 120_000) {
    throw new AppError("CONFIG_INVALID", "Browser CDP timeout must be between 100ms and 120000ms.");
  }
  if (config.browser.maxScreenshotBytes < 100_000 || config.browser.maxScreenshotBytes > 20_000_000) {
    throw new AppError("CONFIG_INVALID", "Maximum screenshot bytes must be between 100000 and 20000000.");
  }
  if (config.browser.maxHtmlChars < 1_000 || config.browser.maxHtmlChars > 500_000) {
    throw new AppError("CONFIG_INVALID", "Maximum HTML characters must be between 1000 and 500000.");
  }
  validateBrowserEndpoint(config.browser.url, ["http:", "https:"], "Browser DevTools URL");
  validateBrowserEndpoint(config.browser.wsEndpoint, ["ws:", "wss:"], "Browser WebSocket endpoint");
  if (config.stealth && config.stealth.profile !== "balanced" && config.stealth.profile !== "max") {
    throw new AppError("CONFIG_INVALID", "Stealth profile must be 'balanced' or 'max'.");
  }
  return config;
}

function validateBrowserEndpoint(value: string | undefined, protocols: readonly string[], label: string): void {
  if (value === undefined) {
    return;
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (error) {
    throw new AppError("CONFIG_INVALID", `${label} must be a valid URL.`, { cause: error });
  }
  if (!protocols.includes(endpoint.protocol) || !endpoint.hostname || endpoint.hostname === "." || endpoint.hostname === ".." || endpoint.username || endpoint.password) {
    throw new AppError("CONFIG_INVALID", `${label} must be an absolute ${protocols.join(" or ")} URL without credentials.`);
  }
}

export function loadServerConfig(args: string[] = [], environment: NodeJS.ProcessEnv = env, homeDirectory = homedir()): ServerConfig {
  if (environment.SMOOTH_OPERATOR_BROWSER_PROFILE !== undefined || environment.SMOOTH_OPERATOR_BROWSER_STEALTH !== undefined) {
    throw new AppError("CONFIG_INVALID", "Browser profile switches were removed. The native server uses one fixed native profile.");
  }
  if (environment.SMOOTH_OPERATOR_DEFAULT_MODE !== undefined) {
    throw new AppError("CONFIG_INVALID", "SMOOTH_OPERATOR_DEFAULT_MODE was removed. The native MCP server uses one capability profile.");
  }
  if (environment.SMOOTH_OPERATOR_BROWSER_USER_AGENT !== undefined) {
    throw new AppError("CONFIG_INVALID", "Browser user-agent overrides were removed. The native server preserves the browser's real identity.");
  }
  const argumentValues = parseArguments(args);
  const argValue = (name: string): string | undefined => argumentValues.get(name);

  const configPath = argValue("--config") ?? environment.SMOOTH_OPERATOR_CONFIG;
  const defaultConfigPath = join(homeDirectory, ".smooth-operator", "config.json");
  const fileConfig = configPath
    ? readConfigFile(expandPath(configPath, homeDirectory))
    : readConfigFile(defaultConfigPath, { allowMissing: true, allowUnknownRootKeys: true });
  const nestedHttp = fileConfig.http ?? {};
  const nestedBrowser = fileConfig.browser ?? {};
  const nestedSecurity = fileConfig.security ?? {};
  const nestedStealth = fileConfig.stealth ?? {};
  const viewportWidth = parseOptionalInteger(environment.SMOOTH_OPERATOR_BROWSER_VIEWPORT_WIDTH, nestedBrowser.viewport?.width);
  const viewportHeight = parseOptionalInteger(environment.SMOOTH_OPERATOR_BROWSER_VIEWPORT_HEIGHT, nestedBrowser.viewport?.height);
  const viewport = resolveBrowserViewport(viewportWidth, viewportHeight);

  const dataDir = expandPath(environment.SMOOTH_OPERATOR_DATA_DIR ?? fileConfig.dataDir ?? join(homeDirectory, ".smooth-operator"), homeDirectory);
  const defaultBrowserDataDir = join(dataDir, "browser");
  const configuredRoots = parseList(environment.SMOOTH_OPERATOR_ALLOWED_FILE_ROOTS, nestedSecurity.allowedFileRoots ?? []);
  // Default to private data directory; explicit allowlist required for other roots.
  const allowedFileRoots = canonicalizeAllowedFileRoots((configuredRoots.length > 0 ? configuredRoots : [join(dataDir, "files"), join(dataDir, "downloads")]).map((path) => expandPath(path, homeDirectory)));

  // Stealth is part of the native default profile. Environment values take
  // precedence over installer JSON for each setting independently, so an
  // explicit `false` remains authoritative.
  const stealthEnabled = parseBoolean(environment.SMOOTH_OPERATOR_STEALTH_ENABLED, nestedStealth.enabled ?? true);
  const stealth: NonNullable<ServerConfig["stealth"]> = {
    enabled: stealthEnabled,
    profile: (environment.SMOOTH_OPERATOR_STEALTH_PROFILE ?? nestedStealth.profile ?? "balanced") as "balanced" | "max",
    gpu: parseBoolean(environment.SMOOTH_OPERATOR_STEALTH_GPU, nestedStealth.gpu ?? false),
    behaviorEnabled: environment.SMOOTH_OPERATOR_BEHAVIOR_ENABLED === undefined
      ? nestedStealth.behaviorEnabled ?? true
      : parseBoolean(environment.SMOOTH_OPERATOR_BEHAVIOR_ENABLED, stealthEnabled),
  };

  const config: ServerConfig = {
    transport: (argValue("--transport") ?? environment.SMOOTH_OPERATOR_TRANSPORT ?? fileConfig.transport ?? "stdio") as Transport,
    http: {
      host: (argValue("--host") ?? environment.SMOOTH_OPERATOR_HTTP_HOST ?? nestedHttp.host ?? "127.0.0.1").trim(),
      port: parseInteger(argValue("--port") ?? environment.SMOOTH_OPERATOR_HTTP_PORT, nestedHttp.port ?? 3_344),
      path: (environment.SMOOTH_OPERATOR_HTTP_PATH ?? nestedHttp.path ?? "/mcp").trim(),
      token: environment.SMOOTH_OPERATOR_HTTP_TOKEN ?? nestedHttp.token,
      allowRemote: parseBoolean(environment.SMOOTH_OPERATOR_ALLOW_REMOTE_HTTP, nestedHttp.allowRemote ?? false),
      allowedHosts: normalizeHostList(parseList(environment.SMOOTH_OPERATOR_ALLOWED_HOSTS, nestedHttp.allowedHosts ?? ["localhost", "127.0.0.1", "[::1]"])),
      allowedOrigins: normalizeHostList(parseList(environment.SMOOTH_OPERATOR_ALLOWED_ORIGINS, nestedHttp.allowedOrigins ?? ["localhost", "127.0.0.1", "[::1]"])),
      maxBodyBytes: parseInteger(environment.SMOOTH_OPERATOR_HTTP_MAX_BODY_BYTES, nestedHttp.maxBodyBytes ?? 2_000_000),
    },
    browser: {
      mode: (environment.SMOOTH_OPERATOR_BROWSER_MODE ?? nestedBrowser.mode ?? "managed") as ServerConfig["browser"]["mode"],
      wsEndpoint: trimOptional(environment.SMOOTH_OPERATOR_BROWSER_WS_ENDPOINT ?? nestedBrowser.wsEndpoint),
      url: trimOptional(environment.SMOOTH_OPERATOR_BROWSER_URL ?? nestedBrowser.url) ?? "http://127.0.0.1:9222",
      executablePath: expandOptionalPath(environment.SMOOTH_OPERATOR_BROWSER_EXECUTABLE ?? nestedBrowser.executablePath, homeDirectory),
      headless: parseBoolean(environment.SMOOTH_OPERATOR_BROWSER_HEADLESS, nestedBrowser.headless ?? false),
      ...(viewport ? { viewport } : {}),
      // Managed and launch modes get one private, persistent profile by default. This is
      // an internal server profile, not a user-selectable capability profile;
      // an explicit path remains available for isolated harness runs.
      userDataDir: expandOptionalPath(environment.SMOOTH_OPERATOR_BROWSER_USER_DATA_DIR ?? nestedBrowser.userDataDir, homeDirectory) ?? defaultBrowserDataDir,
      autoLaunch: parseBoolean(environment.SMOOTH_OPERATOR_BROWSER_AUTO_LAUNCH, nestedBrowser.autoLaunch ?? false),
      actionTimeoutMs: parseInteger(environment.SMOOTH_OPERATOR_BROWSER_TIMEOUT_MS, nestedBrowser.actionTimeoutMs ?? 15_000),
      connectTimeoutMs: parseInteger(environment.SMOOTH_OPERATOR_BROWSER_CONNECT_TIMEOUT_MS, nestedBrowser.connectTimeoutMs ?? 30_000),
      cdpTimeoutMs: parseInteger(environment.SMOOTH_OPERATOR_BROWSER_CDP_TIMEOUT_MS, nestedBrowser.cdpTimeoutMs ?? 30_000),
      maxScreenshotBytes: parseInteger(environment.SMOOTH_OPERATOR_MAX_SCREENSHOT_BYTES, nestedBrowser.maxScreenshotBytes ?? 8_000_000),
      maxHtmlChars: parseInteger(environment.SMOOTH_OPERATOR_MAX_HTML_CHARS, nestedBrowser.maxHtmlChars ?? 200_000),
    },
    security: {
      allowedDomains: normalizeDomainList(parseList(environment.SMOOTH_OPERATOR_ALLOWED_DOMAINS, nestedSecurity.allowedDomains ?? [])),
      blockedDomains: normalizeDomainList(parseList(environment.SMOOTH_OPERATOR_BLOCKED_DOMAINS, nestedSecurity.blockedDomains ?? [])),
      allowedFileRoots,
      allowPrivateNetwork: parseBoolean(environment.SMOOTH_OPERATOR_ALLOW_PRIVATE_NETWORK, nestedSecurity.allowPrivateNetwork ?? false),
      allowEval: parseBoolean(environment.SMOOTH_OPERATOR_ALLOW_EVAL, nestedSecurity.allowEval ?? true),
    },
    stealth,
    dataDir,
    logLevel: (environment.SMOOTH_OPERATOR_LOG_LEVEL ?? fileConfig.logLevel ?? "info") as LogLevel,
  };

  const parsed = RawConfigSchema.safeParse({
    transport: config.transport,
    http: config.http,
    browser: config.browser,
    security: config.security,
    stealth: config.stealth,
    dataDir: config.dataDir,
    logLevel: config.logLevel,
  });
  if (!parsed.success) {
    throw new AppError("CONFIG_INVALID", "Configuration failed validation.", {
      details: { issues: parsed.error.issues.map((issue) => issue.message) },
    });
  }
  return validateConfig(config);
}

function parseArguments(args: readonly string[]): Map<string, string> {
  const supported = new Set(["--config", "--transport", "--host", "--port"]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!supported.has(name)) {
      throw new AppError("CONFIG_INVALID", `Unknown command-line option '${name}'.`);
    }
    if (values.has(name)) {
      throw new AppError("CONFIG_INVALID", `Command-line option '${name}' was provided more than once.`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new AppError("CONFIG_INVALID", `Command-line option '${name}' requires a value.`);
    }
    values.set(name, value);
    index += 1;
  }
  return values;
}
