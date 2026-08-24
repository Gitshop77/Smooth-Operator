import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
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
  const configured = process.env.OPEN_COWORK_TEST_BROWSER_EXECUTABLE ?? process.env.OPEN_COWORK_BROWSER_EXECUTABLE;
  if (configured) {
    if (await executable(configured)) {
      return configured;
    }
    throw new Error(`Configured Chrome executable does not exist or is not executable: ${configured}`);
  }

  const commands = process.platform === "win32"
    ? ["chrome.exe", "chromium.exe"]
    : ["google-chrome", "google-chrome-stable", "google-chrome-beta", "google-chrome-unstable", "chromium", "chromium-browser"];
  const locator = process.platform === "win32" ? "where.exe" : "which";
  for (const command of commands) {
    try {
      const result = await execFileAsync(locator, [command], { maxBuffer: 64_000, timeout: 5_000 });
      const candidate = result.stdout.trim().split(/\r?\n/, 1)[0];
      if (candidate && await executable(candidate)) {
        return candidate;
      }
    } catch {
      // Try the next well-known channel name.
    }
  }
  throw new Error("No executable Chrome/Chromium installation was found. Install Chrome or set OPEN_COWORK_TEST_BROWSER_EXECUTABLE before running the opt-in live suite.");
}

async function main() {
  const browser = await discoverChrome();
  process.stdout.write(`Running live browser tests with ${browser}\n`);
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = await execFileAsync(command, ["vitest", "run", "tests/browser-live.test.ts"], {
    cwd: root,
    env: { ...process.env, OPEN_COWORK_TEST_BROWSER_EXECUTABLE: browser },
    maxBuffer: 4_000_000,
    timeout: 180_000,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

