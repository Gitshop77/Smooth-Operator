import { join } from "node:path";
import { homedir } from "node:os";

export type WizardChoices = {
  mode: string;
  headless: boolean;
  allowedDomains: string[];
  blockedDomains: string[];
  allowEval: boolean;
  dataDir: string;
  browserUrl?: string;
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
  // The interactive path only runs against real terminal streams; the casts
  // bridge NodeJS.ReadableStream/WritableStream to readline's stream types.
  const rl = createInterface({
    input: opts.stdin as unknown as import("node:stream").Readable,
    output: opts.stdout as unknown as import("node:stream").Writable,
  });
  try {
    const answer = await rl.question(`Harness [opencode/claude-code/copilot/codex/gemini/vscode/cursor/windsurf/claude-desktop] [opencode]: `);
    const trimmed = answer.trim().toLowerCase();
    if (!trimmed) return "opencode";
    const map: Record<string, string> = {
      "claude": "claude-code",
      "github-copilot": "copilot",
      "codex-cli": "codex",
      "gemini-cli": "gemini",
      "vs-code": "vscode",
    };
    return map[trimmed] ?? trimmed;
  } finally {
    rl.close();
  }
}

function recommendedDefaults(homeDir: string | undefined): WizardChoices {
  return {
    mode: "managed",
    headless: false,
    allowedDomains: [],
    blockedDomains: [],
    allowEval: false,
    dataDir: join(homeDir ?? homedir(), ".smooth-operator"),
  };
}

export async function runWizard(_harness: string, opts: WizardRunOptions): Promise<WizardChoices> {
  if (opts.yes) {
    return recommendedDefaults(opts.homeDir);
  }
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  // Non-interactive runs (piped stdin/stdout or CI) must never open readline:
  // apply exactly the same recommended defaults as the `--yes` path.
  const interactive = Boolean(stdin.isTTY && stdout.isTTY && !process.env.CI);
  if (!interactive) {
    return recommendedDefaults(opts.homeDir);
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({
    input: stdin as unknown as import("node:stream").Readable,
    output: stdout as unknown as import("node:stream").Writable,
  });
  try {
    const modeAns = await rl.question("Browser mode: 1) managed private (recommended) 2) personal Chrome (connect) 3) disabled [1]: ");
    const modeMap: Record<string, string> = { "1": "managed", "2": "connect", "3": "disabled", "": "managed" };
    let mode = modeMap[modeAns.trim()] ?? "managed";
    if (!["managed", "connect", "disabled"].includes(mode)) mode = "managed";
    let browserUrl: string | undefined;
    if (mode === "connect") {
      browserUrl = "http://127.0.0.1:9222";
    }
    const headlessAns = await rl.question("Headless Chrome? (y/N) [N]: ");
    const headless = headlessAns.trim().toLowerCase() === "y";
    const allowedAns = await rl.question("Allowed domains (comma-separated, empty=all) []: ");
    const allowedDomains = allowedAns.trim() ? allowedAns.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const blockedAns = await rl.question("Blocked domains (comma-separated) []: ");
    const blockedDomains = blockedAns.trim() ? blockedAns.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const evalAns = await rl.question("Allow page JavaScript (browser_evaluate)? (y/N) [N]: ");
    const allowEval = evalAns.trim().toLowerCase() === "y";
    const dataDirAns = await rl.question(`Data directory [${join(opts.homeDir ?? homedir(), ".smooth-operator")}]: `);
    const dataDir = dataDirAns.trim() ? dataDirAns.trim() : join(opts.homeDir ?? homedir(), ".smooth-operator");
    // If personal Chrome was chosen, launch the helper; fall back to the
    // default local DevTools URL when the helper cannot start Chrome.
    if (mode === "connect") {
      try {
        const launched = await launchPersonalChrome({ dataDir, spawn: opts.spawn, probe: opts.probe ?? defaultProbe, port: 9222 });
        browserUrl = launched.url;
      } catch {
        // keep default URL if helper fails
      }
    }
    return { mode, headless, allowedDomains, blockedDomains, allowEval, dataDir, browserUrl };
  } finally {
    rl.close();
  }
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

  const tmpPath = `${configPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
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
