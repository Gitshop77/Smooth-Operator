import { join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

import { createUi } from "./ui";

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
  /** Shown in the banner; defaults to "2.3.0" when omitted. */
  version?: string;
}

interface PersonalChromeOptions {
  executablePath?: string;
  dataDir: string;
  port?: number;
  spawn?: SpawnFunction;
  probe: ProbeFunction;
  /** Upper bound for the readiness poll loop. Defaults to 33 (~10s at 300ms). */
  probeAttempts?: number;
}

const PROBE_INTERVAL_MS = 300;
const DEFAULT_PROBE_ATTEMPTS = 33;
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

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);
}

export async function promptForHarness(opts: { stdin: WizardStdin; stdout: WizardStdout }): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const ui = createUi(opts.stdout);
  const input = opts.stdin as unknown as import("node:stream").Readable;
  const output = opts.stdout as unknown as import("node:stream").Writable;
  const rl = createInterface({ input, output });

  try {
    if (opts.stdout.isTTY) {
      ui.step(0, HARNESS_MENU.length, "Which harness should get a browser?");
      ui.explain(["The AI harness you use every day. Pick yours; you can re-run this later for others."]);
      HARNESS_MENU.forEach((entry, index) => ui.option(index + 1, entry.label, entry.description));
    }
    while (true) {
      const answer = await rl.question(`Choose 1-${HARNESS_MENU.length} or type a name [opencode]: `);
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
    allowEval: false,
    dataDir: join(homeDir ?? homedir(), ".smooth-operator"),
    browserExecutablePath: undefined,
  };
}

const WIZARD_STEP_TOTAL = 7;

/** Ask which installed Chromium-based browser the server should drive. Any
 * CDP-compatible browser works, so present everything detected and allow a
 * manual path as the escape hatch. */
async function askBrowser(session: WizardSession, ui: ReturnType<typeof createUi>): Promise<string | undefined> {
  const { findChromiumExecutables } = await import("./browser/discovery.js");
  const detected = findChromiumExecutables();
  if (detected.length > 0) {
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
      if (answer.startsWith("/") && existsSync(answer)) return answer;
      ui.failure("Enter a listed number or an existing absolute path.");
    }
  }
  while (true) {
    const answer = (await session.question("Browser executable path (Enter = auto-detect): ")).trim();
    if (!answer) return undefined;
    if (!answer.startsWith("/")) {
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

async function askYesNo(session: WizardSession, prompt: string, fallback: boolean): Promise<boolean> {
  while (true) {
    const hint = fallback ? "[Y/n]" : "[y/N]";
    const answer = (await session.question(`${prompt} ${hint}: `)).trim().toLowerCase();
    if (!answer) return fallback;
    if (["y", "yes"].includes(answer)) return true;
    if (["n", "no"].includes(answer)) return false;
  }
}

function parseDomainList(raw: string): string[] | undefined {
  const domains = raw.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  const invalid = domains.find((domain) => !/^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain));
  return invalid === undefined ? domains : undefined;
}

export async function runWizard(harness: string, opts: WizardRunOptions): Promise<WizardChoices> {
  const defaults = recommendedDefaults(opts.homeDir);
  if (opts.yes) {
    return defaults;
  }
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  // Non-interactive runs (piped stdin/stdout or CI) must never open readline:
  // apply exactly the same recommended defaults as the `--yes` path.
  const interactive = Boolean(stdin.isTTY && stdout.isTTY && !process.env.CI);
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
    ui.banner("SmoothOperator Setup", `Give ${harness} a real Chrome it can drive`, opts.version ?? "2.2.0");
    ui.note(`Configuring: ${harness}`);
    ui.note("Answer each question, or press Enter to accept the recommended default.");
    ui.note(`You can re-run \`smooth-operator install ${harness}\` at any time to change these.`);

    ui.step(1, WIZARD_STEP_TOTAL, "Browser mode");
    ui.explain([
      "Who owns the Chrome window your AI drives?",
      "",
      "Managed gives the AI its own private Chrome profile at ~/.smooth-operator/browser.",
      "Your daily browser stays untouched; logins for the AI live separately.",
      "",
      "Connect attaches to your real Chrome instead, so the AI uses everything",
      "you are already signed into. Only pick this if you need your existing logins.",
      "",
      "Disabled keeps the server but turns all browsing tools off.",
    ]);
    ui.option(1, "Managed private Chrome", "Isolated profile owned by SmoothOperator. Safest default.", true);
    ui.option(2, "Personal Chrome (connect)", "Reuse your real browser and its existing sign-ins.");
    ui.option(3, "Disabled", "No browser. Tools that need a page will report an error.");

    let mode = "managed";
    let browserUrl: string | undefined;
    let headless = false;
    let allowedDomains: string[] = [];
    let blockedDomains: string[] = [];
    let allowEval = false;
    let dataDir = defaults.dataDir;
    while (true) {
      const answer = (await session.question("Mode [1]: ")).trim();
      if (!answer || answer === "1") {
        mode = "managed";
        break;
      }
      if (answer === "2") {
        mode = "connect";
        browserUrl = "http://127.0.0.1:9222";
        break;
      }
      if (answer === "3") {
        mode = "disabled";
        break;
      }
      ui.failure("Enter 1, 2, or 3.");
    }

    let browserExecutablePath: string | undefined;
    let headlessChoice = false;
    if (mode !== "disabled") {
      ui.step(2, WIZARD_STEP_TOTAL, "Browser");
      ui.explain([
        "Any Chromium-based browser works: Chrome, Brave, Edge, Chromium,",
        "Vivaldi, Arc, Opera. The AI gets its own isolated profile inside the",
        "browser you pick - your everyday profiles are never touched.",
      ]);
      browserExecutablePath = await askBrowser(session, ui);

      ui.step(3, WIZARD_STEP_TOTAL, "Headless mode");
      ui.explain([
        "Headless runs Chrome with no visible window - lighter and invisible.",
        "Visible Chrome lets you watch clicks happen and handle CAPTCHAs or",
        "logins yourself when a site pauses for human verification.",
      ]);
      headlessChoice = await askYesNo(session, "Run Chrome headless (no window)?", false);

      ui.step(4, WIZARD_STEP_TOTAL, "Allowed domains");
      ui.explain([
        "Restrict which sites the AI may open, e.g. docs.example.com, *.wikipedia.org",
        "Leave empty to allow every site. Blocked domains always win over allowed ones.",
      ]);
      while (true) {
        const parsed = parseDomainList(await session.question("Allowed domains (comma-separated, Enter for all): "));
        if (parsed !== undefined) {
          allowedDomains = parsed;
          break;
        }
        ui.failure("That did not look like a domain list. Example: example.com, *.shop.test");
      }

      ui.step(5, WIZARD_STEP_TOTAL, "Blocked domains");
      ui.explain(["Never open these sites, even when everything else is allowed."]);
      while (true) {
        const parsed = parseDomainList(await session.question("Blocked domains (comma-separated, Enter for none): "));
        if (parsed !== undefined) {
          blockedDomains = parsed;
          break;
        }
        ui.failure("That did not look like a domain list. Example: ads.example.com");
      }

      ui.step(6, WIZARD_STEP_TOTAL, "JavaScript execution");
      ui.explain([
        "browser_evaluate runs arbitrary JavaScript on a page - powerful for scraping",
        "but it can also trigger bot defenses. Most users never need it on.",
      ]);
      allowEval = await askYesNo(session, "Allow the AI to run JavaScript on pages?", false);

      ui.step(7, WIZARD_STEP_TOTAL, "Data directory");
      ui.explain([
        "Where the private Chrome profile, logs, and downloads live.",
        "Permissions are locked to 0600 so only your user can read them.",
      ]);
      while (dataDir === defaults.dataDir) {
        const answer = (await session.question(`Data directory [${defaults.dataDir}]: `)).trim();
        if (!answer) break;
        if (!answer.startsWith("/") || answer.replace(/\/+$/, "") === "") {
          ui.failure("Enter an absolute path other than the filesystem root.");
          continue;
        }
        dataDir = answer;
        break;
      }
      headless = headlessChoice;

      if (mode === "connect") {
        ui.note("Starting your personal Chrome with remote debugging on port 9222...");
        try {
          const launched = await launchPersonalChrome({ dataDir, spawn: opts.spawn, probe: opts.probe ?? defaultProbe, port: 9222 });
          browserUrl = launched.url;
          ui.success(`Connected to your Chrome at ${launched.url}`);
        } catch {
          browserUrl = "http://127.0.0.1:9222";
          ui.note("Could not reach Chrome on port 9222 yet - keeping the default URL.");
        }
      }
    }

    writeSummary(ui, harness, { mode, headless, allowedDomains, blockedDomains, allowEval, dataDir, browserExecutablePath });
    return { mode, headless, allowedDomains, blockedDomains, allowEval, dataDir, browserUrl, browserExecutablePath };
  } finally {
    rl.close();
  }
}

function writeSummary(ui: ReturnType<typeof createUi>, harness: string, choices: WizardChoices): void {
  const modeLabel: Record<string, string> = {
    managed: "Managed private Chrome (isolated profile)",
    connect: "Your personal Chrome via debugging port",
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
      ["Page JavaScript", choices.allowEval ? "enabled" : "off (recommended)"],
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

export async function persistWizardConfig(choices: WizardChoices, homeDir: string): Promise<void> {
  const { join, dirname, resolve } = await import("node:path");
  const { mkdir, chmod, lstat, readFile, writeFile, rename } = await import("node:fs/promises");
  const configPath = resolve(join(homeDir, ".smooth-operator/config.json"));
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(configPath), 0o700).catch(() => {});
  try {
    const stats = await lstat(configPath);
    if (stats.isSymbolicLink()) {
      const { AppError } = await import("./errors.js");
      throw new AppError("INSTALL_CONFIG_FAILED", "Config must not be a symbolic link");
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }

  // Merge into the previous configuration instead of replacing it, so
  // unrelated user settings (and unknown sections) survive the wizard.
  let previous: Record<string, unknown> = {};
  try {
    const raw = await readFile(configPath, "utf8");
    const { parseJsonc } = await import("./installer.js");
    const parsed: unknown = parseJsonc(raw, configPath);
    if (isRecord(parsed)) previous = parsed;
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  const prevBrowser = isRecord(previous.browser) ? previous.browser : {};
  const prevSecurity = isRecord(previous.security) ? previous.security : {};

  // Wizard-managed keys are always written from the chosen values so a
  // previously persisted unsafe value cannot survive a re-run; unrelated
  // keys still merge from the previous configuration below.
  const chosenBrowser: Record<string, unknown> = {
    mode: choices.mode,
    headless: choices.headless,
  };
  if (choices.browserUrl) {
    chosenBrowser.url = choices.browserUrl;
  }
  if (choices.browserExecutablePath) {
    chosenBrowser.executablePath = choices.browserExecutablePath;
  }
  const chosenSecurity: Record<string, unknown> = {
    allowEval: choices.allowEval,
    allowedDomains: choices.allowedDomains,
    blockedDomains: choices.blockedDomains,
  };

  const config: Record<string, unknown> = { ...previous };
  const browserSection = { ...prevBrowser, ...chosenBrowser };
  const securitySection = { ...prevSecurity, ...chosenSecurity };
  if (Object.keys(browserSection).length > 0) config.browser = browserSection;
  if (Object.keys(securitySection).length > 0) config.security = securitySection;
  const defaultDataDir = join(homeDir, ".smooth-operator");
  if (choices.dataDir !== defaultDataDir) {
    config.dataDir = choices.dataDir;
  }

  const { randomUUID } = await import("node:crypto");
  const tmpPath = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmpPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await chmod(tmpPath, 0o600);
  // backup if exists
  try {
    const existing = await readFile(configPath);
    const bak = `${configPath}.bak`;
    try {
      await writeFile(bak, existing, { mode: 0o600, flag: "wx" });
      await chmod(bak, 0o600);
    } catch {
      let i = 1;
      while (true) {
        try {
          await writeFile(`${bak}.${i}`, existing, { mode: 0o600, flag: "wx" });
          await chmod(`${bak}.${i}`, 0o600);
          break;
        } catch {
          i++;
          if (i > 1000) throw new Error("backup limit");
        }
      }
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  await rename(tmpPath, configPath);
  await chmod(configPath, 0o600);
}

export async function launchPersonalChrome(opts: PersonalChromeOptions): Promise<{ url: string }> {
  const port = opts.port ?? 9222;
  const { findChromeExecutable } = await import("./browser/discovery.js");
  const executable = opts.executablePath ?? findChromeExecutable()?.path;
  if (!executable) {
    const { AppError } = await import("./errors.js");
    throw new AppError("BROWSER_NOT_CONFIGURED", "Install Chrome or set SMOOTH_OPERATOR_BROWSER_EXECUTABLE");
  }
  const spawnFn = opts.spawn ?? (await import("node:child_process")).spawn;
  const { join } = await import("node:path");
  const child = spawnFn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${join(opts.dataDir, "personal-chrome")}`, "--no-first-run", "--no-default-browser-check"], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  const probe = opts.probe;
  const { AppError } = await import("./errors.js");
  const attempts = opts.probeAttempts ?? DEFAULT_PROBE_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, PROBE_INTERVAL_MS));
    try {
      const res = await probe(`http://127.0.0.1:${port}/json/version`, 1000);
      if (res.state === "live") return { url: `http://127.0.0.1:${port}` };
    } catch {
      // Endpoint not ready yet; keep probing until attempts are exhausted.
    }
  }
  throw new AppError("BROWSER_CONNECT_TIMEOUT", `Chrome DevTools endpoint on port ${port} did not become ready after ${attempts} probes. Close Chrome or choose another port.`);
}
