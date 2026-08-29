import { dirname, isAbsolute, join, parse, resolve, win32 } from "node:path";
import { existsSync } from "node:fs";
import { chmod, lstat, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

import { AppError } from "./errors";
import { createConfigBackup, ensureSecureDirectory, parseJsonc, readSecureConfigFile } from "./installer";
import { createUi } from "./ui";
import { SERVER_VERSION } from "./version";

export type WizardChoices = {
  mode: string;
  headless: boolean;
  allowedDomains: string[];
  blockedDomains: string[];
  allowEval: boolean;
  dataDir: string;
  browserUrl?: string;
  /** Absolute path to the Chromium-based browser the server should drive. */
  browserExecutablePath?: string;
};

/** Input stream for wizard prompts. Plain (non-TTY) objects are permitted so
 * tests and CI can inject inert streams; they never reach readline because
 * non-interactive runs short-circuit to defaults before any prompt opens. */
type WizardStdin = NodeJS.ReadableStream & { isTTY?: boolean };
type WizardStdout = NodeJS.WritableStream & { isTTY?: boolean };
type SpawnFunction = typeof import("node:child_process").spawn;
type ProbeResult = { state: string; version?: unknown };
type ProbeFunction = (url: string, timeoutMs: number) => Promise<ProbeResult>;

interface WizardRunOptions {
  yes: boolean;
  stdin?: WizardStdin;
  stdout?: WizardStdout;
  spawn?: SpawnFunction;
  probe?: ProbeFunction;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Shown in the banner; defaults to the protocol-facing server version. */
  version?: string;
}

interface PersonalChromeOptions {
  executablePath?: string;
  dataDir: string;
  /** Launch the helper browser without a visible window when selected by the wizard. */
  headless?: boolean;
  port?: number;
  spawn?: SpawnFunction;
  probe: ProbeFunction;
  /** Upper bound for the readiness poll loop. Defaults to 33 (~10s at 300ms). */
  probeAttempts?: number;
}

const PROBE_INTERVAL_MS = 300;
const DEFAULT_PROBE_ATTEMPTS = 33;
const MAX_WIZARD_CONFIG_BYTES = 2_000_000;
const HARNESS_MENU = [
  { id: "opencode", label: "OpenCode", description: "Configures ~/.config/opencode/opencode.json" },
  { id: "claude-code", label: "Claude Code", description: "Runs `claude mcp add` for your user scope" },
  { id: "copilot", label: "GitHub Copilot CLI", description: "Runs `copilot mcp add`" },
  { id: "codex", label: "OpenAI Codex CLI", description: "Runs `codex mcp add`" },
  { id: "gemini", label: "Gemini CLI", description: "Runs `gemini mcp add` for your user scope" },
  { id: "vscode", label: "VS Code", description: "Runs `code --add-mcp`" },
  { id: "cursor", label: "Cursor", description: "Adds SmoothOperator to ~/.cursor/mcp.json" },
  { id: "windsurf", label: "Windsurf", description: "Adds SmoothOperator to Windsurf's mcp_config.json" },
  { id: "claude-desktop", label: "Claude Desktop", description: "Updates claude_desktop_config.json" },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function isAbsolutePath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function isFilesystemRoot(value: string): boolean {
  return (isAbsolute(value) && parse(value).root === value) || (win32.isAbsolute(value) && win32.parse(value).root === value);
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);
}

export async function promptForHarness(opts: { stdin: WizardStdin; stdout: WizardStdout }): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const ui = createUi(opts.stdout);
  const input = opts.stdin as unknown as import("node:stream").Readable;
  const output = opts.stdout as unknown as import("node:stream").Writable;
  const rl = createInterface({ input, output });
  const session: WizardSession = tolerantQuestion(rl);

  try {
    if (opts.stdout.isTTY) {
      ui.step(0, HARNESS_MENU.length, "Which harness should get a browser?");
      ui.explain(["The AI harness you use every day. Pick yours; you can re-run this later for others."]);
      HARNESS_MENU.forEach((entry, index) => ui.option(index + 1, entry.label, entry.description));
    }
    while (true) {
      const answer = await session.question(`Choose 1-${HARNESS_MENU.length} or type a name [opencode]: `);
      const trimmed = answer.trim().toLowerCase();
      if (!trimmed) return "opencode";
      const numeric = Number.parseInt(trimmed, 10);
      if (`${numeric}` === trimmed && numeric >= 1 && numeric <= HARNESS_MENU.length) {
        return HARNESS_MENU[numeric - 1].id;
      }
      if (/^\d+$/.test(trimmed)) {
        continue;
      }
      return normalizeHarnessName(trimmed);
    }
  } finally {
    rl.close();
  }
}

function normalizeHarnessName(name: string): string {
  const aliases: Record<string, string> = {
    "claude": "claude-code",
    "github-copilot": "copilot",
    "codex-cli": "codex",
    "gemini-cli": "gemini",
    "vs-code": "vscode",
  };
  return aliases[name] ?? name;
}

function recommendedDefaults(homeDir: string | undefined): WizardChoices {
  return {
    mode: "managed",
    headless: false,
    allowedDomains: [],
    blockedDomains: [],
    allowEval: true,
    dataDir: join(homeDir ?? homedir(), ".smooth-operator"),
  };
}

const WIZARD_STEP_TOTAL = 3;

/** Ask which installed Chromium-based browser the server should drive. Any
 * CDP-compatible browser works, so present everything detected and allow a
 * manual path as the escape hatch. */
async function askBrowser(session: WizardSession, ui: ReturnType<typeof createUi>): Promise<string | undefined> {
  const { findChromiumExecutables } = await import("./browser/discovery.js");
  const detected = findChromiumExecutables();
  if (detected.length > 0) {
    ui.explain(["Choose an installed Chromium browser. The first option is the preferred detected browser.", "If none of these is right, type an existing absolute executable path."]);
    detected.forEach((candidate, index) => {
      ui.option(index + 1, candidate.label, candidate.path, index === 0);
    });
    while (true) {
      const answer = (await session.question(`Browser [1]: `)).trim();
      if (!answer || answer === "1") return detected[0].path;
      const numeric = Number.parseInt(answer, 10);
      if (`${numeric}` === answer && numeric >= 1 && numeric <= detected.length) {
        return detected[numeric - 1].path;
      }
      if (/^\d+$/.test(answer)) continue;
      if (isAbsolutePath(answer) && existsSync(answer)) return answer;
      ui.failure("Enter a listed number or an existing absolute path.");
    }
  }
  while (true) {
    const answer = (await session.question("Browser executable path (Enter = auto-detect): ")).trim();
    if (!answer) return undefined;
    if (!isAbsolutePath(answer)) {
      ui.failure("Enter an absolute path.");
      continue;
    }
    if (!existsSync(answer)) {
      ui.failure("That path does not exist.");
      continue;
    }
    return answer;
  }
}

interface WizardSession {
  question(prompt: string): Promise<string>;
}

/** readline's promise API rejects on EOF/Ctrl-D; treat that as "accept the
 * default" instead of crashing mid-setup. */
function tolerantQuestion(rl: { question(prompt: string): Promise<string> }): WizardSession {
  return {
    async question(prompt: string): Promise<string> {
      try {
        return await rl.question(prompt);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        const aborted = error instanceof Error && error.name === "AbortError";
        if (aborted || code === "ABORT_ERR" || code === "ERR_USE_AFTER_CLOSE") {
          return "";
        }
        throw error;
      }
    },
  };
}

async function askBinaryChoice(
  session: WizardSession,
  ui: ReturnType<typeof createUi>,
  prompt: string,
  firstLabel: string,
  firstDescription: string,
  secondLabel: string,
  secondDescription: string,
): Promise<1 | 2> {
  ui.option(1, firstLabel, firstDescription, true);
  ui.option(2, secondLabel, secondDescription);
  while (true) {
    const answer = (await session.question(`${prompt} [1]: `)).trim();
    if (!answer || answer === "1") return 1;
    if (answer === "2") return 2;
    ui.failure("Enter 1 or 2.");
  }
}

function normalizeWizardDomain(value: string): string | undefined {
  const trimmed = value.trim().replace(/^\.+|\.+$/g, "");
  const wildcard = trimmed.startsWith("*.");
  const base = wildcard ? trimmed.slice(2) : trimmed;
  if (!base || (trimmed.includes("*") && !wildcard) || base.includes("..")) {
    return undefined;
  }
  const bracketless = base.replace(/^\[|\]$/g, "");
  if (isIP(bracketless) !== 0) {
    return wildcard ? undefined : bracketless.toLowerCase();
  }
  let ascii: string;
  try {
    ascii = domainToASCII(base).toLowerCase();
  } catch {
    return undefined;
  }
  if (!ascii || ascii.length > 253 || !ascii.split(".").every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    return undefined;
  }
  return `${wildcard ? "*." : ""}${ascii}`;
}

function normalizeWizardChoices(choices: WizardChoices): WizardChoices {
  if (!isRecord(choices) || !["managed", "connect", "disabled"].includes(choices.mode)) {
    throw new AppError("INSTALL_CONFIG_INVALID", "Wizard choices contain an unsupported browser mode.");
  }
  if (typeof choices.headless !== "boolean" || typeof choices.allowEval !== "boolean") {
    throw new AppError("INSTALL_CONFIG_INVALID", "Wizard choices contain invalid boolean settings.");
  }
  const allowedDomains = normalizeWizardChoiceList(choices.allowedDomains, "allowed");
  const blockedDomains = normalizeWizardChoiceList(choices.blockedDomains, "blocked");
  const dataDir = typeof choices.dataDir === "string" ? choices.dataDir.trim() : "";
  const resolvedDataDir = dataDir ? resolve(dataDir) : "";
  if (!resolvedDataDir || !isAbsolutePath(dataDir) || isFilesystemRoot(resolvedDataDir) || /[\u0000-\u001f\u007f]/.test(dataDir)) {
    throw new AppError("INSTALL_CONFIG_INVALID", "The wizard data directory must be an absolute non-root path without control characters.");
  }
  const browserUrl = normalizeWizardBrowserUrl(choices.browserUrl, choices.mode);
  const browserExecutablePath = normalizeWizardExecutablePath(choices.browserExecutablePath, choices.mode);
  return {
    mode: choices.mode,
    headless: choices.headless,
    allowedDomains,
    blockedDomains,
    allowEval: choices.allowEval,
    dataDir: resolvedDataDir,
    ...(browserUrl ? { browserUrl } : {}),
    ...(browserExecutablePath ? { browserExecutablePath } : {}),
  };
}

function normalizeWizardChoiceList(values: unknown, label: string): string[] {
  if (!Array.isArray(values) || values.length > 128) {
    throw new AppError("INSTALL_CONFIG_INVALID", `Wizard ${label} domains must be an array of at most 128 entries.`);
  }
  const normalized = values.map((value) => typeof value === "string" ? normalizeWizardDomain(value) : undefined);
  if (normalized.some((value) => value === undefined)) {
    throw new AppError("INSTALL_CONFIG_INVALID", `Wizard ${label} domains contain an invalid pattern.`);
  }
  return [...new Set(normalized as string[])];
}

function normalizeWizardBrowserUrl(value: unknown, mode: string): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || mode !== "connect") {
    throw new AppError("INSTALL_CONFIG_INVALID", "A browser URL is only valid for connect mode and must be a string.");
  }
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password || url.hash) {
      throw new Error("invalid browser URL");
    }
    return url.pathname === "/" && url.search === "" ? url.origin : url.toString();
  } catch {
    throw new AppError("INSTALL_CONFIG_INVALID", "The browser URL must be an HTTP(S) URL without credentials.");
  }
}

function normalizeWizardExecutablePath(value: unknown, mode: string): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || mode === "disabled") {
    throw new AppError("INSTALL_CONFIG_INVALID", "A browser executable is only valid when browser control is enabled.");
  }
  const trimmed = value.trim();
  if (!isAbsolutePath(trimmed) || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new AppError("INSTALL_CONFIG_INVALID", "The browser executable must be an absolute path without control characters.");
  }
  return trimmed;
}

export async function runWizard(harness: string, opts: WizardRunOptions): Promise<WizardChoices> {
  const defaults = recommendedDefaults(opts.homeDir);
  if (opts.yes) {
    return defaults;
  }
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const environment = opts.env ?? process.env;
  // Non-interactive runs (piped stdin/stdout or CI) must never open readline:
  // apply exactly the same recommended defaults as the `--yes` path.
  const interactive = Boolean(stdin.isTTY && stdout.isTTY && !environment.CI);
  if (!interactive) {
    return defaults;
  }

  const ui = createUi(stdout);
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({
    input: stdin as unknown as import("node:stream").Readable,
    output: stdout as unknown as import("node:stream").Writable,
  });
  const session: WizardSession = tolerantQuestion(rl);

  try {
    ui.banner("SmoothOperator Setup", `Give ${harness} a real Chrome it can drive`, opts.version ?? SERVER_VERSION);
    ui.note(`Configuring: ${harness}`);
    ui.note("Answer each question, or press Enter to accept the recommended default.");
    ui.note(`You can re-run \`smooth-operator install ${harness}\` at any time to change these.`);

    ui.step(1, WIZARD_STEP_TOTAL, "Browser profile ownership");
    ui.explain([
      "Choose whether SmoothOperator owns an isolated profile or connects to a",
      "browser profile you provide. Connected mode uses a dedicated debugging",
      "profile when this wizard launches Chromium; it does not attach to your",
      "daily default profile, which Chromium security does not permit safely.",
    ]);
    const ownership = await askBinaryChoice(
      session,
      ui,
      "Profile ownership",
      "Isolated managed profile",
      "SmoothOperator owns a private, persistent profile under its data directory.",
      "Connected/personal browser profile",
      "Use a browser you provide, with existing sign-ins only when that browser exposes them.",
    );
    const mode = ownership === 1 ? "managed" : "connect";
    const browserUrl = mode === "connect" ? "http://127.0.0.1:9222" : undefined;

    ui.step(2, WIZARD_STEP_TOTAL, "Browser display");
    ui.explain([
      "Headed shows a visible browser window so you can watch and intervene.",
      "Headless runs Chromium without a window, which is useful for unattended runs.",
    ]);
    const display = await askBinaryChoice(
      session,
      ui,
      "Browser display",
      "Headed (visible window)",
      "Show the browser window while SmoothOperator works.",
      "Headless (no window)",
      "Run Chromium without a visible window, including when connected mode launches its helper browser.",
    );
    const headless = display === 2;

    ui.step(3, WIZARD_STEP_TOTAL, "Chromium browser");
    const browserExecutablePath = await askBrowser(session, ui);

    if (mode === "connect") {
      ui.note(headless
        ? "Starting a dedicated headless debugging profile on port 9222..."
        : "Starting a dedicated headed debugging profile on port 9222...");
      try {
        const launched = await launchPersonalChrome({
          dataDir: defaults.dataDir,
          executablePath: browserExecutablePath,
          headless,
          spawn: opts.spawn,
          probe: opts.probe ?? defaultProbe,
          port: 9222,
        });
        ui.success(`Connected to the dedicated debugging profile at ${launched.url}`);
      } catch (error) {
        if (error instanceof AppError && (error.code === "INSTALL_CONFIG_INVALID" || error.code === "INSTALL_CONFIG_FAILED")) {
          throw error;
        }
        ui.note("Could not reach the dedicated debugging profile on port 9222 yet - keeping the default URL.");
      }
    }

    const choices: WizardChoices = {
      ...defaults,
      mode,
      headless,
      ...(browserUrl ? { browserUrl } : {}),
      ...(browserExecutablePath ? { browserExecutablePath } : {}),
    };
    writeSummary(ui, harness, choices);
    return choices;
  } finally {
    rl.close();
  }
}

function writeSummary(ui: ReturnType<typeof createUi>, harness: string, choices: WizardChoices): void {
  const modeLabel: Record<string, string> = {
    managed: "Managed private Chrome (isolated profile)",
    connect: "Dedicated Chromium debugging profile via port 9222",
    disabled: "Disabled - no browser tools",
  };
  ui.banner("Configuration Summary", `Ready to configure ${harness}`, "");
  ui.keyValues([
    ["Browser mode", choices.mode === "connect" ? modeLabel.connect : (modeLabel[choices.mode] ?? choices.mode)],
    ...(choices.browserExecutablePath ? [["Browser", choices.browserExecutablePath] as const] : []),
    ["Headless", choices.headless ? "yes - no visible window" : "no - you can watch and intervene"],
    ...(choices.mode === "disabled" ? [] : [
      ["Allowed sites", choices.allowedDomains.length ? choices.allowedDomains.join(", ") : "all sites"],
      ["Blocked sites", choices.blockedDomains.length ? choices.blockedDomains.join(", ") : "none"],
      ["Page JavaScript", choices.allowEval ? "enabled" : "off"],
      ["Stealth baseline", "enabled (balanced)"],
      ["Behavioral timing", "off (fast native input)"],
      ["Data directory", choices.dataDir],
    ] satisfies ReadonlyArray<readonly [string, string]>),
  ]);
}

async function defaultProbe(url: string, timeoutMs: number): Promise<ProbeResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return { state: "no-file" };
    const version: unknown = await response.json().catch(() => ({}));
    return { state: "live", version };
  } catch {
    return { state: "no-file" };
  }
}

async function assertPrivateWizardConfig(handle: FileHandle): Promise<void> {
  const info = await handle.stat();
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && info.uid !== uid) {
    throw new AppError("INSTALL_CONFIG_FAILED", "The existing server configuration must be owned by the current user.");
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new AppError("INSTALL_CONFIG_FAILED", "The existing server configuration must use owner-only permissions (for example, chmod 600).");
  }
}

async function rejectWizardConfigSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new AppError("INSTALL_CONFIG_FAILED", "The server configuration must not be a symbolic link.");
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
}

export async function persistWizardConfig(rawChoices: WizardChoices, homeDir: string): Promise<void> {
  const choices = normalizeWizardChoices(rawChoices);
  const configPath = resolve(join(homeDir, ".smooth-operator", "config.json"));
  await ensureSecureDirectory(dirname(configPath));

  // Read and parse the same no-follow descriptor whose bytes are later used
  // for the backup. This avoids pathname races and bounds memory use even if
  // the file grows after its initial stat.
  let previous: Record<string, unknown> = {};
  let reviewedBytes: Buffer | undefined;
  let reviewedHandle: FileHandle | undefined;
  try {
    const reviewed = await readSecureConfigFile(configPath);
    if (reviewed) {
      reviewedBytes = reviewed.bytes;
      reviewedHandle = reviewed.handle;
      await assertPrivateWizardConfig(reviewedHandle);
      const parsed: unknown = parseJsonc(reviewedBytes.toString("utf8"), configPath);
      if (isRecord(parsed)) previous = parsed;
    }
  } finally {
    await reviewedHandle?.close().catch(() => undefined);
  }

  // Merge into the previous configuration instead of replacing it, so
  // unrelated user settings (and unknown sections) survive the wizard.
  const prevBrowser = isRecord(previous.browser) ? previous.browser : {};
  const prevSecurity = isRecord(previous.security) ? previous.security : {};
  const prevStealth = isRecord(previous.stealth) ? previous.stealth : {};
  const browserSection: Record<string, unknown> = { ...prevBrowser, mode: choices.mode, headless: choices.headless };
  // These optional browser fields are wizard-managed too. Clear stale values
  // when a rerun switches back to managed/disabled mode.
  delete browserSection.url;
  delete browserSection.executablePath;
  if (choices.browserUrl) browserSection.url = choices.browserUrl;
  if (choices.browserExecutablePath) browserSection.executablePath = choices.browserExecutablePath;
  const securitySection = {
    ...prevSecurity,
    allowEval: choices.allowEval,
    allowedDomains: choices.allowedDomains,
    blockedDomains: choices.blockedDomains,
  };
  // These settings are owned by the wizard's recommended native profile. A
  // rerun must reset stale profile values while retaining any unrelated root
  // configuration sections.
  const stealthSection = {
    ...prevStealth,
    enabled: true,
    profile: "balanced",
    gpu: false,
    behaviorEnabled: false,
  };

  const config: Record<string, unknown> = { ...previous, browser: browserSection, security: securitySection, stealth: stealthSection };
  // CAPTCHA solver configuration is no longer part of the server contract;
  // drop stale wizard-managed data during a secure config rewrite.
  delete config.captchaSolver;
  // Persist the wizard-owned data directory even when it is the recommended
  // default. This makes a rerun authoritative instead of leaving a stale
  // custom path in the merged configuration.
  config.dataDir = choices.dataDir;

  const serializedConfig = `${JSON.stringify(config, null, 2)}\n`;
  if (Buffer.byteLength(serializedConfig, "utf8") > MAX_WIZARD_CONFIG_BYTES) {
    throw new AppError("INSTALL_CONFIG_FAILED", `The generated server configuration must be ${MAX_WIZARD_CONFIG_BYTES} bytes or smaller.`);
  }

  const { randomUUID } = await import("node:crypto");
  const tmpPath = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmpPath, serializedConfig, { mode: 0o600, flag: "wx" });
    await chmod(tmpPath, 0o600);
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined);
    throw new AppError("INSTALL_CONFIG_FAILED", "Could not write the temporary server configuration.", { cause: error });
  }

  try {
    if (reviewedBytes) {
      await createConfigBackup(configPath, reviewedBytes);
    }
    // Recheck the parent and final component immediately before the atomic
    // replacement. Rename replaces a final symlink rather than following it;
    // the checks prevent a user-controlled directory/file link from becoming
    // the destination in the first place.
    await ensureSecureDirectory(dirname(configPath));
    await rejectWizardConfigSymlink(configPath);
    await rename(tmpPath, configPath);
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError("INSTALL_CONFIG_FAILED", "Could not persist the server configuration.", { cause: error });
  }
}

export async function launchPersonalChrome(opts: PersonalChromeOptions): Promise<{ url: string }> {
  const port = opts.port ?? 9222;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new AppError("INSTALL_CONFIG_INVALID", "The personal Chrome debugging port must be an integer between 1 and 65535.");
  }
  const rawDataDir = typeof opts.dataDir === "string" ? opts.dataDir.trim() : "";
  const safeDataDir = rawDataDir ? resolve(rawDataDir) : "";
  if (!safeDataDir || !isAbsolutePath(rawDataDir) || isFilesystemRoot(safeDataDir) || /[\u0000-\u001f\u007f]/.test(rawDataDir)) {
    throw new AppError("INSTALL_CONFIG_INVALID", "The personal Chrome data directory must be an absolute non-root path without control characters.");
  }
  const { findChromeExecutable } = await import("./browser/discovery.js");
  const executable = opts.executablePath ?? findChromeExecutable()?.path;
  if (!executable) {
    throw new AppError("BROWSER_NOT_CONFIGURED", "Install Chrome or set SMOOTH_OPERATOR_BROWSER_EXECUTABLE");
  }
  await ensureSecureDirectory(safeDataDir);
  const spawnFn = opts.spawn ?? (await import("node:child_process")).spawn;
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(safeDataDir, "personal-chrome")}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(opts.headless ? ["--headless=new"] : []),
  ];
  const child = spawnFn(executable, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  const probe = opts.probe;
  const attempts = opts.probeAttempts ?? DEFAULT_PROBE_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // Probe immediately after spawning. Chrome often has its DevTools endpoint
    // ready before the first 300ms tick; retaining the interval between later
    // probes keeps startup bounded without adding avoidable latency.
    if (attempt > 0) {
      await new Promise((resolveTimeout) => setTimeout(resolveTimeout, PROBE_INTERVAL_MS));
    }
    try {
      const res = await probe(`http://127.0.0.1:${port}/json/version`, 1000);
      if (res.state === "live") return { url: `http://127.0.0.1:${port}` };
    } catch {
      // Endpoint not ready yet; keep probing until attempts are exhausted.
    }
  }
  throw new AppError("BROWSER_CONNECT_TIMEOUT", `Chrome DevTools endpoint on port ${port} did not become ready after ${attempts} probes. Close Chrome or choose another port.`);
}
