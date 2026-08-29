import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function executable(path) {
  try {
    await access(path, constants.X_OK);
    return path;
  } catch {
    return undefined;
  }
}

async function discoverChrome() {
  const configured = process.env.SMOOTH_OPERATOR_TEST_BROWSER_EXECUTABLE ?? process.env.SMOOTH_OPERATOR_BROWSER_EXECUTABLE;
  if (configured) {
    if (await executable(configured)) {
      return configured;
    }
    throw new Error(`Configured Chrome executable does not exist or is not executable: ${configured}`);
  }

  const directCandidates = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        join(homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
        join(homedir(), "Applications", "Brave Browser.app", "Contents", "MacOS", "Brave Browser"),
      ]
    : process.platform === "win32"
      ? [
          join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
          join(process.env.PROGRAMFILES ?? "C:\\Program Files", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
          join(process.env.LOCALAPPDATA ?? "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        ]
      : [];
  for (const candidate of directCandidates) {
    if (await executable(candidate)) {
      return candidate;
    }
  }

  const commands = process.platform === "win32"
    ? ["chrome.exe", "brave.exe", "msedge.exe", "chromium.exe"]
    : ["google-chrome", "google-chrome-stable", "google-chrome-beta", "google-chrome-unstable", "brave-browser", "brave", "microsoft-edge", "microsoft-edge-stable", "chromium", "chromium-browser"];
  const locator = process.platform === "win32" ? "where.exe" : "which";
  // The locator calls are independent. Run them together, then retain the
  // documented command preference when selecting the first usable result;
  // this avoids paying the full per-command timeout on machines without a
  // browser while keeping discovery deterministic.
  const located = await Promise.all(commands.map(async (command) => {
    try {
      const result = await execFileAsync(locator, [command], { maxBuffer: 64_000, timeout: 5_000 });
      const candidate = result.stdout.trim().split(/\r?\n/, 1)[0];
      return candidate && await executable(candidate) ? candidate : undefined;
    } catch {
      // Try the next well-known channel name.
      return undefined;
    }
  }));
  for (const candidate of located) {
    if (candidate) {
      return candidate;
    }
  }
  throw new Error("No executable Chrome/Chromium installation was found. Install Chrome or set SMOOTH_OPERATOR_TEST_BROWSER_EXECUTABLE before running the opt-in live suite.");
}

async function main() {
  const browser = await discoverChrome();
  process.stdout.write(`Running live browser tests with ${browser}\n`);
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const run = {
    cwd: root,
    env: { ...process.env, SMOOTH_OPERATOR_TEST_BROWSER_EXECUTABLE: browser },
    maxBuffer: 4_000_000,
    timeout: 180_000,
  };
  try {
    const result = await execFileAsync(command, ["vitest", "run", "tests/browser-live.test.ts"], run);
    await writeDiagnostics(result.stdout, result.stderr, browser, "passed");
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  } catch (error) {
    const cause = error && typeof error === "object" ? error : {};
    await writeDiagnostics(cause.stdout ?? "", cause.stderr ?? "", browser, "failed", cause.message ?? String(error));
    throw error;
  }
}

async function writeDiagnostics(stdout, stderr, browser, status, errorMessage = "") {
  const destination = process.env.SMOOTH_OPERATOR_LIVE_DIAGNOSTICS_PATH;
  if (!destination) {
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify({ status, browser, stdout, stderr, ...(errorMessage ? { error: errorMessage } : {}) }, null, 2), { mode: 0o600 });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
