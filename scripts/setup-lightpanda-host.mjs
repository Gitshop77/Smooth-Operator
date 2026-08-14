#!/usr/bin/env node
/**
 * One-time setup for the Open Cowork Lightpanda native messaging host.
 *
 * Usage:
 *   npm run setup:lightpanda-host -- --extension-id <id> [--binary-path <path>] [--browser chrome|chromium|brave|edge|all] [--skip-download]
 *
 * The extension id is shown in chrome://extensions (Developer mode) and in
 * Options → Automation → Lightpanda research. Unpacked ids are 32 lowercase
 * a-p characters; they change on re-install/re-key, so re-run this after
 * reinstalling Chrome or the extension.
 *
 * HOW IT WORKS: Chrome native-messaging host manifests support ONLY
 * name/description/path/type/allowed_origins — there is NO "args" field.
 * Chrome spawns "path" with no arguments and a minimal environment, so we
 * write a small LAUNCHER script with absolute paths baked in (node, this
 * host script, the lightpanda binary) and point the manifest at the launcher.
 * Never use `#!/usr/bin/env node` for the host: GUI sessions have a minimal
 * PATH and would fail to resolve node.
 */
import { homedir } from "node:os";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HOST_NAME = "com.open_cowork.lightpanda";
const HOST_SCRIPT = fileURLToPath(new URL("./lightpanda-native-host.mjs", import.meta.url));
const LAUNCHER = join(homedir(), ".open-cowork", "bin", "lightpanda-host");

function parseArgs(argv) {
  const out = { browser: "all", skipDownload: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--extension-id") out.extensionId = argv[++i];
    else if (a === "--binary-path") out.binaryPath = argv[++i];
    else if (a === "--browser") out.browser = argv[++i];
    else if (a === "--skip-download") out.skipDownload = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/setup-lightpanda-host.mjs --extension-id <id> [--binary-path <path>] [--browser chrome|chromium|brave|edge|all] [--skip-download]\n\n" +
        "Installs the Open Cowork Lightpanda native messaging host for one or more browsers.\n" +
        "The extension id (32 lowercase a-p chars) is shown in chrome://extensions.\n" +
        "Rerun after reinstalling Chrome or the extension (the id changes).",
      );
      process.exit(0);
    }
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  return out;
}

const BROWSER_DIRS = {
  darwin: {
    chrome: ["Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"],
    chromium: ["Library", "Application Support", "Chromium", "NativeMessagingHosts"],
    brave: ["Library", "Application Support", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"],
    edge: ["Library", "Application Support", "Microsoft Edge", "NativeMessagingHosts"],
  },
  linux: {
    chrome: [".config", "google-chrome", "NativeMessagingHosts"],
    chromium: [".config", "chromium", "NativeMessagingHosts"],
    brave: [".config", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"],
    edge: [".config", "microsoft-edge", "NativeMessagingHosts"],
  },
};

function resolveBinary(opts) {
  if (opts.binaryPath) {
    if (!existsSync(opts.binaryPath)) { console.error(`binary not found: ${opts.binaryPath}`); process.exit(1); }
    return opts.binaryPath;
  }
  const which = spawnSync("which", ["lightpanda"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  if (opts.skipDownload) return "lightpanda";
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const os = process.platform === "darwin" ? "macos" : "linux";
  // Nightly asset pattern verified live: lightpanda-{aarch64|x86_64}-{linux|macos}.
  const url = `https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-${arch}-${os}`;
  const destDir = join(homedir(), ".open-cowork", "bin");
  const dest = join(destDir, "lightpanda");
  mkdirSync(destDir, { recursive: true });
  console.log(`Downloading lightpanda nightly (${arch}-${os})…`);
  const curl = spawnSync("curl", ["-L", "-o", dest, url], { stdio: "inherit" });
  if (curl.status !== 0) {
    console.error("download failed — install via: brew install lightpanda-io/browser/lightpanda");
    process.exit(1);
  }
  chmodSync(dest, 0o755);
  // curl does not set the quarantine flag, but strip it defensively anyway.
  if (process.platform === "darwin") {
    spawnSync("xattr", ["-d", "com.apple.quarantine", dest]);
  }
  // `lightpanda version` prints the version and exits 0 (main.zig:67-75).
  const verify = spawnSync(dest, ["version"], { encoding: "utf8" });
  if (verify.status !== 0) { console.error("downloaded binary failed the version check"); process.exit(1); }
  console.log(`Installed ${dest} (${verify.stdout.trim()})`);
  return dest;
}

function writeLauncher(binaryPath) {
  const launcherDir = join(homedir(), ".open-cowork", "bin");
  mkdirSync(launcherDir, { recursive: true });
  // Absolute paths only — Chrome spawns the launcher with a minimal env.
  const body = `#!/bin/sh\n# Open Cowork Lightpanda native messaging host launcher (generated by\n# scripts/setup-lightpanda-host.mjs). Re-run the setup script to update.\nexec "${process.execPath}" "${HOST_SCRIPT}" "${binaryPath}" "$@"\n`;
  writeFileSync(LAUNCHER, body);
  chmodSync(LAUNCHER, 0o755);
  console.log(`Wrote launcher ${LAUNCHER}`);
}

function writeManifest(browser, opts) {
  if (process.platform === "win32") {
    console.warn("Windows: install the native host manually per https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-hosts (registry key " + HOST_NAME + ").");
    return;
  }
  const dirs = BROWSER_DIRS[process.platform] ?? BROWSER_DIRS.darwin;
  const dir = dirs[browser];
  if (!dir) { console.error(`unknown browser: ${browser}`); process.exit(2); }
  const destDir = join(homedir(), ...dir);
  mkdirSync(destDir, { recursive: true });
  // NOTE: no "args" field — Chrome does not support it. "path" is the launcher.
  const manifest = {
    name: HOST_NAME,
    description: "Open Cowork Lightpanda research host",
    path: LAUNCHER,
    type: "stdio",
    allowed_origins: [`chrome-extension://${opts.extensionId}/`],
  };
  const dest = join(destDir, `${HOST_NAME}.json`);
  writeFileSync(dest, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${dest}`);
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.extensionId) {
  console.error("Missing --extension-id <id> (32 lowercase a-p chars). Copy it from chrome://extensions or Options → Automation → Lightpanda research.");
  process.exit(2);
}
if (!/^[a-p]{32}$/.test(opts.extensionId)) {
  console.error(`Invalid extension id "${opts.extensionId}" — expected 32 lowercase a-p characters.`);
  process.exit(2);
}
const binaryPath = resolveBinary(opts);
console.log(`Lightpanda binary: ${binaryPath}`);
console.log(`Host script: ${HOST_SCRIPT}`);
writeLauncher(binaryPath);
const browsers = opts.browser === "all" ? Object.keys(BROWSER_DIRS[process.platform] ?? BROWSER_DIRS.darwin) : [opts.browser];
for (const b of browsers) writeManifest(b, opts);
console.log("Done. No Chrome restart needed — reload the extension, then Options → Automation → Lightpanda research → Test connection.");
