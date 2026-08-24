import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir, platform } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { AppError } from "./errors";

const execFileAsync = promisify(execFile);
const INSTALL_COMMAND_TIMEOUT_MS = 30_000;
const MAX_INSTALL_MESSAGE_BYTES = 2_000;
const JSON_BACKUP_LIMIT = 1_000;
const SUPPORTED_HARNESSES = ["claude-code", "opencode", "copilot", "codex", "gemini", "vscode", "cursor", "windsurf", "claude-desktop"] as const;

type JsonConfigTarget = "cursor" | "windsurf" | "claude-desktop";
type OpenCodeConfigTarget = "opencode";
type ConfigTarget = JsonConfigTarget | OpenCodeConfigTarget;
type NormalizedTarget = "claude-code" | "opencode" | "copilot" | "codex" | "gemini" | "vscode" | ConfigTarget;

export interface HarnessCommand {
  command: string;
  args: string[];
}

export interface HarnessInstallOptions {
  /** Test/deployment hook. The default uses execFile and never invokes a shell. */
  executeCommand?: (command: string, args: readonly string[]) => Promise<void>;
  /** Override the home directory and environment for an isolated installer run. */
  homeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  /** Override the resolved server executable for a GUI configuration. */
  serverEntry?: HarnessCommand;
  /** Override a target's configuration path, primarily for isolated tests. */
  configPaths?: Partial<Record<ConfigTarget, string>>;
}

export type HarnessInstallPlan =
  | {
    kind: "cli";
    target: string;
    command: string;
    args: string[];
  }
  | {
    kind: "json";
    target: ConfigTarget;
    path: string;
  };

const SERVER_NAME = "open-cowork";

export function supportedHarnessTargets(): readonly string[] {
  return SUPPORTED_HARNESSES;
}

/**
 * Return the exact argv that would be passed to a harness CLI.
 *
 * Keeping this separate from execution makes installer behavior auditable and
 * allows callers/tests to inspect arguments without launching another program.
 * OpenCode is deliberately represented as a JSON plan: its current `mcp add`
 * command is interactive, so invoking it with a command tail is not supported.
 */
export function planHarnessInstall(target: string, options: Pick<HarnessInstallOptions, "homeDirectory" | "environment" | "configPaths" | "serverEntry"> = {}): HarnessInstallPlan {
  const normalized = normalizeTarget(target);
  const entry = options.serverEntry ?? resolveServerEntry();
  const cliEntry: HarnessCommand = { command: "open-cowork-mcp", args: [] };
  if (normalized === "claude-code") {
    return { kind: "cli", target: normalized, command: "claude", args: ["mcp", "add", "--scope", "user", SERVER_NAME, "--", cliEntry.command, ...cliEntry.args] };
  }
  if (normalized === "opencode") {
    return { kind: "json", target: normalized, path: resolveOpenCodeConfigPath(options.homeDirectory, options.environment, options.configPaths?.opencode) };
  }
  if (normalized === "copilot") {
    return { kind: "cli", target: normalized, command: "copilot", args: ["mcp", "add", SERVER_NAME, "--", cliEntry.command, ...cliEntry.args] };
  }
  if (normalized === "codex") {
    return { kind: "cli", target: normalized, command: "codex", args: ["mcp", "add", SERVER_NAME, "--", cliEntry.command, ...cliEntry.args] };
  }
  if (normalized === "gemini") {
    // Gemini's current yargs command is `add <name> <command> [args...]`.
    // Keep options after the positional command, matching its official form.
    return { kind: "cli", target: normalized, command: "gemini", args: ["mcp", "add", SERVER_NAME, cliEntry.command, ...cliEntry.args, "--scope", "user"] };
  }
  if (normalized === "vscode") {
    return {
      kind: "cli",
      target: normalized,
      command: "code",
      args: ["--add-mcp", JSON.stringify({ name: SERVER_NAME, command: entry.command, args: entry.args })],
    };
  }
  const configTarget = normalized as JsonConfigTarget;
  return { kind: "json", target: configTarget, path: resolveConfigPath(configTarget, options.homeDirectory, options.environment, options.configPaths?.[configTarget]) };
}

export async function installHarness(target: string, options: HarnessInstallOptions = {}): Promise<string> {
  const plan = planHarnessInstall(target, options);
  if (plan.kind === "cli") {
    return runCliInstall(plan, options.executeCommand);
  }
  // Keep the public HarnessInstallPlan intentionally small. The JSONC sibling
  // preference is an internal resolution detail: an explicit config path must
  // be used exactly, while the implicit/default path may select an existing
  // opencode.jsonc when opencode.json is absent.
  const environment = options.environment ?? process.env;
  const allowOpenCodeJsoncFallback = plan.target === "opencode"
    && options.configPaths?.opencode === undefined
    && !environment.OPENCODE_CONFIG;
  return installJsonConfig(plan.target, plan.path, options, allowOpenCodeJsoncFallback);
}

function normalizeTarget(target: string): NormalizedTarget {
  const normalized = target.trim().toLowerCase();
  if (normalized === "claude" || normalized === "claude-code") {
    return "claude-code";
  }
  if (normalized === "open-code" || normalized === "opencode") {
    return "opencode";
  }
  if (normalized === "copilot" || normalized === "github-copilot") {
    return "copilot";
  }
  if (normalized === "codex" || normalized === "codex-cli") {
    return "codex";
  }
  if (normalized === "gemini" || normalized === "gemini-cli") {
    return "gemini";
  }
  if (normalized === "vscode" || normalized === "vs-code") {
    return "vscode";
  }
  if (normalized === "cursor" || normalized === "windsurf" || normalized === "claude-desktop") {
    return normalized;
  }
  throw new AppError("INSTALL_TARGET_UNSUPPORTED", `Unsupported harness '${target}'. Use ${supportedHarnessTargets().join(", ")}.`);
}

function resolveServerEntry(): HarnessCommand {
  // A published npm executable runs this module from dist. Using the absolute
  // Node path plus absolute bundled entrypoint avoids GUI applications that
  // start with a different PATH from finding the `open-cowork-mcp` shim. In a
  // source checkout, retain the portable command used by the local CLIs.
  const modulePath = fileURLToPath(import.meta.url);
  if (basename(modulePath) === "open-cowork-mcp.mjs") {
    return { command: process.execPath, args: [modulePath] };
  }
  return { command: "open-cowork-mcp", args: [] };
}

async function runCliInstall(plan: Extract<HarnessInstallPlan, { kind: "cli" }>, executeCommand?: HarnessInstallOptions["executeCommand"]): Promise<string> {
  const runner = executeCommand ?? (async (command: string, args: readonly string[]): Promise<void> => {
    await execFileAsync(command, [...args], {
      maxBuffer: 1_000_000,
      timeout: INSTALL_COMMAND_TIMEOUT_MS,
      killSignal: "SIGTERM",
      windowsHide: true,
    });
  });
  try {
    await runner(plan.command, plan.args);
    return `Installed ${SERVER_NAME} in ${plan.command}. Restart the harness if it was already running.`;
  } catch (error) {
    const command = formatCommand(plan.command, plan.args);
    throw new AppError("INSTALL_COMMAND_FAILED", `Could not configure ${plan.command}. Install it first, then run the argv equivalent: ${command}`, { cause: error });
  }
}

function formatCommand(command: string, args: readonly string[]): string {
  const formatted = [command, ...args].map((part) => /^[a-zA-Z0-9_./:@%+=,-]+$/.test(part) ? part : JSON.stringify(part)).join(" ");
  return truncate(formatted, MAX_INSTALL_MESSAGE_BYTES);
}

function resolveConfigPath(target: JsonConfigTarget, homeDirectory = homedir(), environment = process.env, override?: string): string {
  if (override) {
    return resolve(override);
  }
  const home = homeDirectory || homedir();
  if (target === "cursor") {
    return join(home, ".cursor", "mcp.json");
  }
  if (target === "windsurf") {
    return join(home, ".codeium", "windsurf", "mcp_config.json");
  }
  if (platform() === "darwin") {
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (platform() === "win32") {
    return join(environment.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  }
  return join(environment.XDG_CONFIG_HOME ?? join(home, ".config"), "Claude", "claude_desktop_config.json");
}

function resolveOpenCodeConfigPath(homeDirectory = homedir(), environment = process.env, override?: string): string {
  if (override) {
    return resolve(override);
  }
  if (environment.OPENCODE_CONFIG) {
    return resolve(environment.OPENCODE_CONFIG);
  }
  const configDirectory = environment.OPENCODE_CONFIG_DIR ?? join(homeDirectory || homedir(), ".config", "opencode");
  return join(configDirectory, "opencode.json");
}

async function installJsonConfig(target: ConfigTarget, plannedPath: string, options: HarnessInstallOptions, allowOpenCodeJsoncFallback = false): Promise<string> {
  const path = target === "opencode" && allowOpenCodeJsoncFallback ? await chooseExistingOpenCodePath(plannedPath) : plannedPath;
  await ensureSecureDirectory(dirname(path));

  let config: Record<string, unknown> = {};
  let existed = false;
  let reviewedBytes: Buffer | undefined;
  let reviewedHandle: FileHandle | undefined;
  try {
    const reviewed = await readConfigFile(path);
    if (reviewed) {
      reviewedBytes = reviewed.bytes;
      reviewedHandle = reviewed.handle;
    }
    const source = reviewed?.bytes.toString("utf8");
    if (source === undefined) {
      throw missingFileError(path);
    }
    existed = true;
    config = parseJsonc(source, path);
  } catch (error) {
    if (!isMissingFile(error)) {
      await reviewedHandle?.close().catch(() => undefined);
      throw error;
    }
  }

  const entry = options.serverEntry ?? resolveServerEntry();
  let merged: { config: Record<string, unknown>; alreadyConfigured: boolean };
  try {
    merged = target === "opencode" ? mergeOpenCodeConfig(config, entry, path) : mergeMcpServersConfig(config, entry, path);
  } catch (error) {
    await reviewedHandle?.close().catch(() => undefined);
    throw error;
  }
  if (merged.alreadyConfigured) {
    await reviewedHandle?.close().catch(() => undefined);
    return `open-cowork is already configured in ${path}.`;
  }

  // Secure the descriptor that was actually reviewed. Chmod by pathname here
  // would follow a swapped symlink and could modify an unrelated file.
  if (existed) {
    try {
      if (reviewedHandle) {
        await reviewedHandle.chmod(0o600);
      } else {
        // Windows and older runtimes may not expose descriptor chmod. The
        // fallback remains protected by a fresh no-symlink check.
        await rejectSymlink(path, "configuration file");
        await chmod(path, 0o600);
      }
    } catch (error) {
      await reviewedHandle?.close().catch(() => undefined);
      throw new AppError("INSTALL_CONFIG_FAILED", `Could not secure ${path} before updating it.`, { cause: error });
    }
  }

  await reviewedHandle?.close().catch(() => undefined);
  const backupPath = existed ? await createUniqueBackup(path, reviewedBytes) : undefined;

  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(merged.config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(tempPath, 0o600);
    await rejectSymlink(path, "configuration file");
    await rename(tempPath, path);
    return `Installed open-cowork in ${path}${backupPath ? ` (backup: ${backupPath})` : ""}. Restart the harness.`;
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw new AppError("INSTALL_CONFIG_FAILED", `Could not write ${path}.`, { cause: error });
  }
}

interface ReviewedConfigFile {
  bytes: Buffer;
  handle: FileHandle;
}

/**
 * Read the config through one descriptor and retain the reviewed bytes for a
 * backup. O_NOFOLLOW is available on POSIX; the lstat fallback is retained for
 * Windows and older Node builds where that flag is unavailable.
 */
async function readConfigFile(path: string): Promise<ReviewedConfigFile | undefined> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  if (!noFollow) {
    await rejectSymlink(path, "configuration file");
  }
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    if (noFollow && (isErrorCode(error, "EINVAL") || isErrorCode(error, "ENOTSUP") || isErrorCode(error, "EOPNOTSUPP"))) {
      // Some cross-platform Node/filesystem combinations expose the flag but
      // reject it at runtime. Fall back to lstat + open rather than making
      // otherwise safe configuration installs unavailable.
      await rejectSymlink(path, "configuration file");
      handle = await open(path, constants.O_RDONLY);
    } else {
      if (isErrorCode(error, "ELOOP") || isErrorCode(error, "EFTYPE")) {
        throw new AppError("INSTALL_CONFIG_FAILED", `The configuration file '${path}' must not be a symbolic link.`);
      }
      throw error;
    }
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new AppError("INSTALL_CONFIG_FAILED", `The configuration file '${path}' must be a regular file.`);
    }
    const bytes = await handle.readFile();
    return { bytes, handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function missingFileError(path: string): NodeJS.ErrnoException {
  const error = new Error(`Missing file: ${path}`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

async function chooseExistingOpenCodePath(plannedPath: string): Promise<string> {
  if (await pathExists(plannedPath)) {
    return plannedPath;
  }
  if (basename(plannedPath) === "opencode.json") {
    const jsoncPath = join(dirname(plannedPath), "opencode.jsonc");
    if (await pathExists(jsoncPath)) {
      return jsoncPath;
    }
  }
  return plannedPath;
}

function mergeMcpServersConfig(config: Record<string, unknown>, entry: HarnessCommand, path: string): { config: Record<string, unknown>; alreadyConfigured: boolean } {
  if (config.mcpServers !== undefined && !isRecord(config.mcpServers)) {
    throw new AppError("INSTALL_CONFIG_INVALID", `The mcpServers value in ${path} must be an object; refusing to replace it.`);
  }
  const servers = isRecord(config.mcpServers) ? { ...config.mcpServers } : {};
  const existing = servers[SERVER_NAME];
  if (existing !== undefined) {
    if (!isRecord(existing) || !sameStdioEntry(existing, entry)) {
      throw new AppError("INSTALL_CONFIG_CONFLICT", `The '${SERVER_NAME}' server in ${path} has a conflicting configuration; refusing to overwrite it.`);
    }
    return { config, alreadyConfigured: true };
  }
  servers[SERVER_NAME] = { command: entry.command, args: [...entry.args] };
  return { config: { ...config, mcpServers: servers }, alreadyConfigured: false };
}

function mergeOpenCodeConfig(config: Record<string, unknown>, entry: HarnessCommand, path: string): { config: Record<string, unknown>; alreadyConfigured: boolean } {
  const currentMcp = config.mcp;
  if (currentMcp !== undefined && !isRecord(currentMcp)) {
    throw new AppError("INSTALL_CONFIG_INVALID", `The mcp value in ${path} must be an object; refusing to replace it.`);
  }
  const mcp = isRecord(currentMcp) ? { ...currentMcp } : {};
  // Current OpenCode v2 uses mcp.servers. Older releases used server names
  // directly under mcp; preserve that shape when it is already populated.
  // A new/empty config uses the current nested schema.
  const mcpKeys = Object.keys(mcp);
  const modernSchema = Object.prototype.hasOwnProperty.call(mcp, "servers") || mcpKeys.length === 0 || mcpKeys.every((key) => key === "timeout");
  const currentServers = modernSchema && Object.prototype.hasOwnProperty.call(mcp, "servers") ? mcp.servers : modernSchema ? {} : mcp;
  if (!isRecord(currentServers)) {
    throw new AppError("INSTALL_CONFIG_INVALID", `The OpenCode MCP server collection in ${path} must be an object; refusing to replace it.`);
  }
  const servers = { ...currentServers };
  const existing = servers[SERVER_NAME];
  const desired: Record<string, unknown> = modernSchema
    ? { type: "local", command: [entry.command, ...entry.args] }
    : { type: "local", command: [entry.command, ...entry.args], enabled: true };
  if (existing !== undefined) {
    if (!isRecord(existing) || !sameOpenCodeEntry(existing, desired)) {
      throw new AppError("INSTALL_CONFIG_CONFLICT", `The '${SERVER_NAME}' server in ${path} has a conflicting configuration; refusing to overwrite it.`);
    }
    return { config, alreadyConfigured: true };
  }
  servers[SERVER_NAME] = desired;
  if (modernSchema) {
    mcp.servers = servers;
  } else {
    Object.assign(mcp, servers);
  }
  return { config: { ...config, mcp }, alreadyConfigured: false };
}

function sameStdioEntry(value: Record<string, unknown>, entry: HarnessCommand): boolean {
  return value.command === entry.command && Array.isArray(value.args) && value.args.length === entry.args.length && value.args.every((arg, index) => arg === entry.args[index]);
}

function sameOpenCodeEntry(value: Record<string, unknown>, desired: Record<string, unknown>): boolean {
  const valueCommand = value.command;
  const desiredCommand = desired.command;
  const modern = desired.enabled === undefined;
  return value.type === desired.type && Array.isArray(valueCommand) && Array.isArray(desiredCommand)
    && valueCommand.length === desiredCommand.length && valueCommand.every((arg, index) => arg === desiredCommand[index])
    // OpenCode v2 defaults `disabled` to false. A disabled matching entry is
    // an explicit conflict because silently reporting idempotence leaves the
    // server unusable. Legacy direct-under-mcp entries use `enabled`, whose
    // effective default is true and follows the same fail-closed rule.
    && (modern
      ? value.enabled === undefined && (value.disabled === undefined || value.disabled === false)
      : value.enabled === undefined || value.enabled === true);
}

async function ensureSecureDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  // macOS exposes /var (and sometimes /tmp) through system aliases. Check all
  // components while allowing only those known OS aliases; a user-controlled
  // symlink such as ~/.config must fail closed before mkdir follows it.
  await assertNoSymlinkComponents(absolute, "configuration directory");
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(absolute, "configuration directory");
  await chmod(absolute, 0o700).catch((error: unknown) => {
    throw new AppError("INSTALL_CONFIG_FAILED", `Could not secure the configuration directory for ${path}.`, { cause: error });
  });
}

async function assertNoSymlinkComponents(path: string, label: string): Promise<void> {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  let current = parsed.root;
  const relative = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  for (const part of relative) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() && !isAllowedSystemAlias(current)) {
        throw new AppError("INSTALL_CONFIG_FAILED", `The ${label} '${current}' must not be a symbolic link.`);
      }
    } catch (error) {
      if (isMissingFile(error)) {
        return;
      }
      throw error;
    }
  }
}

function isAllowedSystemAlias(path: string): boolean {
  return platform() === "darwin" && (path === "/var" || path === "/tmp" || path === "/etc");
}

async function rejectSymlink(path: string, label: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new AppError("INSTALL_CONFIG_FAILED", `The ${label} '${path}' must not be a symbolic link.`);
    }
  } catch (error) {
    if (isMissingFile(error)) {
      return;
    }
    throw error;
  }
}

async function createUniqueBackup(path: string, reviewedBytes?: Buffer): Promise<string> {
  if (!reviewedBytes) {
    throw new AppError("INSTALL_BACKUP_FAILED", `Could not review ${path} before creating its backup.`);
  }
  for (let index = 0; index < JSON_BACKUP_LIMIT; index += 1) {
    const candidate = index === 0 ? `${path}.bak` : `${path}.bak.${index}`;
    await rejectSymlink(candidate, "configuration backup");
    let handle: FileHandle | undefined;
    try {
      // Exclusive creation prevents a pathname swap from redirecting a copy
      // into an attacker-selected file. Bytes come from the descriptor used
      // for parsing, so a replaced config path cannot alter the backup.
      handle = await open(candidate, "wx", 0o600);
      await handle.writeFile(reviewedBytes);
      await handle.chmod(0o600);
      await handle.sync();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (isErrorCode(error, "EEXIST")) {
        continue;
      }
      throw new AppError("INSTALL_BACKUP_FAILED", `Could not create a backup before updating ${path}.`, { cause: error });
    }
    await handle?.close().catch((error: unknown) => {
      throw new AppError("INSTALL_BACKUP_FAILED", `Could not close the backup for ${path}.`, { cause: error });
    });
    return candidate;
  }
  throw new AppError("INSTALL_BACKUP_FAILED", `Could not allocate a unique backup name for ${path}.`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) {
      return false;
    }
    throw error;
  }
}

function parseJsonc(source: string, path: string): Record<string, unknown> {
  // Harness configuration files are often JSONC. A regex-based comment
  // stripper corrupts valid values such as https://example.test or strings
  // containing //, so scan strings/comments explicitly.
  const withoutComments = stripJsoncComments(source);
  const normalized = removeJsonTrailingCommas(withoutComments);
  try {
    const parsed: unknown = JSON.parse(normalized);
    if (!isRecord(parsed)) {
      throw new Error("root must be an object");
    }
    return parsed;
  } catch (error) {
    throw new AppError("INSTALL_CONFIG_INVALID", `Could not parse ${path} as JSON/JSONC.`, { cause: error });
  }
}

function stripJsoncComments(source: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (inLineComment) {
      if (character === "\n" || character === "\r") {
        inLineComment = false;
        output += character;
      }
      continue;
    }
    if (inBlockComment) {
      if (character === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      } else if (character === "\n" || character === "\r") {
        output += character;
      }
      continue;
    }
    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
    } else if (character === "/" && next === "/") {
      inLineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
    } else {
      output += character;
    }
  }
  return output;
}

function removeJsonTrailingCommas(source: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === ",") {
      let next = index + 1;
      while (/\s/.test(source[next] ?? "")) {
        next += 1;
      }
      if (source[next] === "}" || source[next] === "]") {
        continue;
      }
    }
    output += character;
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isMissingFile(error: unknown): boolean {
  return isErrorCode(error, "ENOENT");
}

function isErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === code);
}

function truncate(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  let result = value;
  while (Buffer.byteLength(result, "utf8") > maxBytes - 3) {
    result = result.slice(0, Math.max(0, result.length - 16));
  }
  return `${result}...`;
}
