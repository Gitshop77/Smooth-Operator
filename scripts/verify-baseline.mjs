#!/usr/bin/env node

/**
 * Reproducible, release-style verification for the extension.
 *
 * The default package script starts with `npm ci`; use `--skip-install` only
 * when the current `node_modules` was already produced by that exact lockfile.
 * It deliberately reports hashes rather than writing generated evidence into
 * the worktree, keeping the command safe to run locally and in CI.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMP_DIRECTORY_PREFIX = "open-cowork-baseline-";
const EXCLUDED_COPY_PATHS = new Set([
  ".git",
  "node_modules",
  "chrome-extension",
  "coverage",
  ".nyc_output",
  "test-results",
  "playwright-report",
]);
export const EXPECTED_BUNDLE_FILES = [
  "manifest.json",
  "background.js",
  "components.css",
  "content.js",
  "content-main.js",
  "sidepanel.js",
  "sidepanel.html",
  "sidepanel.css",
  "tokens.css",
  "options.js",
  "options.html",
  "options.css",
  "icons/icon.png",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
  "LICENSE",
  "LICENSE-APACHE",
  "LICENSE-MIT",
  "LICENSE-MIT-ZOD",
  "LICENSE-MIT-OPENCODE-MODELS",
  "NOTICE",
  "THIRD_PARTY_LICENSES.json",
];
const EXPECTED_CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; base-uri 'self'; frame-ancestors 'none'; connect-src 'self' http: https: ws: wss:;";
const REVIEWED_PERMISSIONS = [
  "sidePanel", "scripting", "tabs", "activeTab", "storage", "alarms", "debugger",
  "nativeMessaging",
  "notifications", "downloads", "unlimitedStorage", "power", "webRequest", "cookies",
].sort();
const REVIEWED_HOST_PERMISSIONS = ["http://*/*", "https://*/*"];
const SECRET_PATTERNS = [
  ["openai", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["anthropic", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ["google-api", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["github-pat", /\bghp_[A-Za-z0-9]{36}\b/],
  ["github-fine-grained", /\bgithub_pat_[A-Za-z0-9_]{50,}\b/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

function fail(message) {
  throw new Error(`Baseline verification failed: ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Hash exact bytes, never a parsed or normalized representation. */
export function hashRawLockfile(lockfileBytes) {
  if (!Buffer.isBuffer(lockfileBytes) && typeof lockfileBytes !== "string") {
    fail("raw package-lock input must be bytes or a string");
  }
  return sha256(lockfileBytes);
}

/** The complete lockfile must survive source copying and clean installation unchanged. */
export function validateRawLockfileHashes(referenceHash, candidateHash, referenceLabel = "root", candidateLabel = "candidate") {
  if (typeof referenceHash !== "string" || !/^[a-f0-9]{64}$/.test(referenceHash) ||
      typeof candidateHash !== "string" || !/^[a-f0-9]{64}$/.test(candidateHash)) {
    fail("raw package-lock hashes must be SHA-256 hex digests");
  }
  if (referenceHash !== candidateHash) {
    fail(`raw package-lock SHA-256 differs between ${referenceLabel} (${referenceHash}) and ${candidateLabel} (${candidateHash})`);
  }
  return referenceHash;
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function compareVersion(left, right) {
  const parse = (value) => String(value).match(/^v?(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function satisfiesOverride(installed, expected) {
  const comparison = compareVersion(installed, expected.replace(/^[~^>=< ]+/, ""));
  if (comparison === null) return false;
  if (expected.startsWith(">=")) return comparison >= 0;
  if (expected.startsWith("^")) {
    const expectedMajor = Number(expected.slice(1).split(".", 1)[0]);
    return Number(installed.split(".", 1)[0]) === expectedMajor && comparison >= 0;
  }
  if (expected.startsWith("~")) {
    const [major, minor] = expected.slice(1).split(".");
    return installed.startsWith(`${major}.${minor}.`) && comparison >= 0;
  }
  return comparison === 0;
}

/** Exported for focused tests and for CI integrations that need preflight only. */
export function validatePackagePrerequisites(
  pkg,
  lock,
  nodeVersion = process.versions.node,
  // Resolve the executable on PATH instead of trusting npm_config_user_agent:
  // wrapper launchers (npx/corepack) legitimately leave their parent npm
  // version in that variable even after selecting the pinned child toolchain.
  npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
) {
  const requiredNode = String(pkg.engines?.node ?? "");
  const requiredNpm = String(pkg.engines?.npm ?? "");
  if (nodeVersion !== requiredNode) {
    fail(`Node ${requiredNode || "exact version"} is required; found ${nodeVersion}`);
  }
  if (npmVersion !== requiredNpm || pkg.packageManager !== `npm@${requiredNpm}`) {
    fail(`npm ${requiredNpm || "exact version"} and matching packageManager are required; found npm ${npmVersion}`);
  }
  if (lock.lockfileVersion < 2 || !lock.packages?.[""]) fail("package-lock.json must be lockfile v2+ with a root package entry");
  const root = lock.packages[""];
  // npm lockfiles deliberately do not copy the root `overrides` field. Verify
  // declared dependency maps directly, then verify every simple root override
  // against the resolved package below.
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
    if (JSON.stringify(pkg[key] ?? {}) !== JSON.stringify(root[key] ?? {})) {
      fail(`package-lock root ${key} does not match package.json; run npm install --package-lock-only`);
    }
  }
  for (const [name, expectedVersion] of Object.entries(pkg.overrides ?? {})) {
    if (typeof expectedVersion !== "string") continue;
    const installed = lock.packages[`node_modules/${name}`];
    if (!installed || !satisfiesOverride(installed.version, expectedVersion)) {
      fail(`override ${name}@${expectedVersion} is not reflected in package-lock.json`);
    }
  }
  return { node: nodeVersion, npm: npmVersion, requiredNode, requiredNpm, lockfileVersion: lock.lockfileVersion };
}

export function validateNvmrc(nvmrc, pkg) {
  const expected = String(pkg.engines?.node ?? "");
  if (nvmrc.trim() !== expected) {
    fail(`.nvmrc must pin Node ${expected || "to the package engine"}; found ${nvmrc.trim() || "empty"}`);
  }
  return expected;
}

/** Exported for focused tests and for independent manifest checks. */
export function validateManifest(manifest, packageVersion) {
  if (manifest.manifest_version !== 3) fail("extension manifest must be Manifest V3");
  if (manifest.version !== packageVersion) fail("manifest version must equal package.json version");
  if (manifest.content_security_policy?.extension_pages !== EXPECTED_CSP) {
    fail("extension CSP differs from the reviewed MV3 policy");
  }
  if (manifest.content_security_policy.extension_pages.includes("'unsafe-eval'")) {
    fail("extension CSP must not enable unsafe-eval");
  }
  for (const [name, permissions] of [["permissions", manifest.permissions], ["host_permissions", manifest.host_permissions]]) {
    if (!Array.isArray(permissions) || permissions.some((permission) => typeof permission !== "string") || new Set(permissions).size !== permissions.length) {
      fail(`manifest ${name} must be a duplicate-free string array`);
    }
  }
  if (!sameValues([...manifest.permissions].sort(), REVIEWED_PERMISSIONS)) {
    fail("manifest permissions differ from the reviewed permission inventory");
  }
  if (!sameValues([...manifest.host_permissions].sort(), REVIEWED_HOST_PERMISSIONS)) {
    fail("manifest host_permissions differ from the reviewed host permission inventory");
  }
  if (!manifest.permissions.includes("sidePanel") || !manifest.background?.service_worker || !manifest.side_panel?.default_path) {
    fail("manifest is missing reviewed side panel or background entry points");
  }
  return {
    manifestVersion: manifest.manifest_version,
    version: manifest.version,
    permissions: [...manifest.permissions].sort(),
    hostPermissions: [...manifest.host_permissions].sort(),
    csp: manifest.content_security_policy.extension_pages,
  };
}

function inventoryLockfile(lock, lockfileBytes) {
  return {
    packageCount: Object.keys(lock.packages ?? {}).length,
    rawSha256: hashRawLockfile(lockfileBytes),
  };
}

function fileInventory(directory) {
  if (!existsSync(directory)) fail(`missing build directory: ${path.relative(ROOT, directory)}`);
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const absolute = path.join(current, entry);
      const stats = statSync(absolute);
      if (stats.isDirectory()) walk(absolute);
      else if (stats.isFile()) {
        const relative = path.relative(directory, absolute);
        const bytes = stats.size;
        files.push({ file: relative, bytes, sha256: sha256(readFileSync(absolute)) });
      }
    }
  };
  walk(directory);
  return files;
}

/** Exact packaged-file and byte reproducibility gate. */
function validateArtifactInventoryNames(inventory, label) {
  const expected = [...EXPECTED_BUNDLE_FILES].sort();
  const names = inventory.map((item) => item.file).sort();
  if (!sameValues(names, expected)) {
    const missing = expected.filter((file) => !names.includes(file));
    const unexpected = names.filter((file) => !expected.includes(file));
    fail(`${label} build artifact inventory drifted (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`);
  }
}

/** Exact packaged-file and byte reproducibility gate. */
export function validateArtifactInventories(first, second = first, firstLabel = "first", secondLabel = "second") {
  validateArtifactInventoryNames(first, firstLabel);
  validateArtifactInventoryNames(second, secondLabel);
  const stable = (items) => [...items]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map(({ file, bytes, sha256: digest }) => ({ file, bytes, sha256: digest }));
  if (JSON.stringify(stable(first)) !== JSON.stringify(stable(second))) {
    fail(`artifact bytes differ between ${firstLabel} and ${secondLabel}`);
  }
  return stable(first);
}

/** Compare both independent clean-install packages to the root package and to each other. */
export function validateIndependentBuildArtifacts(rootArtifacts, firstArtifacts, secondArtifacts) {
  validateArtifactInventories(rootArtifacts, firstArtifacts, "root build", "isolated build 1");
  validateArtifactInventories(rootArtifacts, secondArtifacts, "root build", "isolated build 2");
  return validateArtifactInventories(firstArtifacts, secondArtifacts, "isolated build 1", "isolated build 2");
}

/** Fail closed when a new direct runtime dependency has no shipped notice. */
export function validateThirdPartyLicenseInventory(dependencies, licenseManifest) {
  if (licenseManifest?.formatVersion !== 1 || !Array.isArray(licenseManifest.dependencies)) {
    fail("third-party license inventory must use formatVersion 1 with a dependencies array");
  }
  const entries = licenseManifest.dependencies;
  const declared = Object.keys(dependencies ?? {}).sort();
  const names = entries.map((entry) => entry?.name);
  if (names.some((name) => typeof name !== "string") || new Set(names).size !== names.length) {
    fail("third-party license inventory contains an invalid or duplicate dependency name");
  }
  if (!sameValues(declared, [...names].sort())) {
    fail("third-party license inventory does not cover every direct runtime dependency");
  }
  for (const entry of entries) {
    if (typeof entry.version !== "string" || entry.version.length === 0 ||
        typeof entry.license !== "string" || entry.license.length === 0 ||
        typeof entry.artifact !== "string" || !EXPECTED_BUNDLE_FILES.includes(entry.artifact)) {
      fail(`invalid third-party license entry for ${String(entry.name)}`);
    }
  }
  return entries;
}

export function findSecretShapes(text) {
  return SECRET_PATTERNS
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
}

/** Positive control prevents an accidentally weakened secret scanner from passing. */
export function validateSecretScannerPositiveControl() {
  const positiveControl = "sk-ant-A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0";
  if (!findSecretShapes(positiveControl).includes("anthropic")) {
    fail("exact-package secret scanner positive control was not detected");
  }
}

/** Scan every JavaScript file in the exact built package, not selected surrogate bundles. */
export function validateBuiltBundleSecretHygiene(bundleDirectory) {
  validateSecretScannerPositiveControl();
  const hits = [];
  const javascriptFiles = fileInventory(bundleDirectory).filter(({ file }) => file.endsWith(".js"));
  for (const item of javascriptFiles) {
    const text = readFileSync(path.join(bundleDirectory, item.file), "utf8");
    for (const pattern of findSecretShapes(text)) hits.push({ file: item.file, pattern });
  }
  if (hits.length > 0) {
    fail(`exact package contains secret-shaped literals: ${hits.map((hit) => `${hit.file}:${hit.pattern}`).join(", ")}`);
  }
  return { scannedJavaScriptFiles: javascriptFiles.length };
}

/**
 * `chrome.storage.session` is deliberately trusted-context-only.  Content
 * worlds can read `storage.local`, so widening session access would turn every
 * matched page into a credential reader. Scan the exact emitted package as a
 * release gate in addition to the source-level contract test. An explicit
 * `TRUSTED_CONTEXTS` call is a safe restriction and remains legal; an unknown
 * or indirect level fails closed because the package scanner cannot prove it
 * preserves the trusted-only boundary.
 */
export function hasUnsafeBuiltSessionAccessPolicy(text) {
  if (/TRUSTED_AND_UNTRUSTED_CONTEXTS/.test(text)) return true;
  const calls = text.match(/\.storage\.session\.setAccessLevel\s*\([\s\S]{0,500}?\)/g) ?? [];
  const explicitTrustedRestriction =
    /(?:\baccessLevel\b|["']accessLevel["'])\s*:\s*["']TRUSTED_CONTEXTS["']/;
  return calls.some((call) => !explicitTrustedRestriction.test(call));
}

export function validateBuiltBundleSessionAccessPolicy(bundleDirectory) {
  const hits = [];
  const javascriptFiles = fileInventory(bundleDirectory).filter(({ file }) => file.endsWith(".js"));
  for (const item of javascriptFiles) {
    const text = readFileSync(path.join(bundleDirectory, item.file), "utf8");
    if (hasUnsafeBuiltSessionAccessPolicy(text)) hits.push(item.file);
  }
  if (hits.length > 0) {
    fail(`exact package widens chrome.storage.session access: ${hits.join(", ")}`);
  }
  return { scannedJavaScriptFiles: javascriptFiles.length };
}

function validateBundle(root, sourceManifest) {
  const bundle = path.join(root, "chrome-extension");
  for (const file of EXPECTED_BUNDLE_FILES) {
    const target = path.join(bundle, file);
    if (!existsSync(target) || statSync(target).size === 0) fail(`build output is missing or empty: ${file}`);
  }
  const builtManifest = readJson(path.join(bundle, "manifest.json"));
  if (JSON.stringify(builtManifest) !== JSON.stringify(sourceManifest)) {
    fail("built manifest does not exactly match src/extension/manifest.json");
  }
  const background = readFileSync(path.join(bundle, "background.js"), "utf8");
  if ((background.match(/await import\(/g) ?? []).length > 1) {
    fail("background.js contains more than the reviewed single computed dynamic import");
  }
  const packageJson = readJson(path.join(root, "package.json"));
  const licenses = readJson(path.join(bundle, "THIRD_PARTY_LICENSES.json"));
  validateThirdPartyLicenseInventory(packageJson.dependencies, licenses);
  validateBuiltBundleSecretHygiene(bundle);
  validateBuiltBundleSessionAccessPolicy(bundle);
  return fileInventory(bundle);
}

function run(command, args, cwd = ROOT) {
  try {
    execFileSync(command, args, { cwd, stdio: "inherit" });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error ? error.status : "unknown";
    fail(`command failed in ${cwd}: ${command} ${args.join(" ")} (exit ${status})`);
  }
}

export function parseOptions(args) {
  const allowed = new Set(["--clean-install", "--skip-install"]);
  if (args.some((arg) => !allowed.has(arg))) fail(`unknown option(s): ${args.join(" ")}`);
  if (args.includes("--clean-install") && args.includes("--skip-install")) fail("choose either --clean-install or --skip-install");
  return { cleanInstall: !args.includes("--skip-install") };
}

export function preflight(root = ROOT) {
  const pkg = readJson(path.join(root, "package.json"));
  const lockPath = path.join(root, "package-lock.json");
  const lockfileBytes = readFileSync(lockPath);
  const lock = JSON.parse(lockfileBytes.toString("utf8"));
  const manifest = readJson(path.join(root, "src/extension/manifest.json"));
  if (!existsSync(path.join(root, "LICENSE")) || statSync(path.join(root, "LICENSE")).size === 0) {
    fail("repository LICENSE is missing or empty");
  }
  return {
    prerequisites: validatePackagePrerequisites(pkg, lock),
    nvmrc: validateNvmrc(readFileSync(path.join(root, ".nvmrc"), "utf8"), pkg),
    package: {
      name: pkg.name,
      version: pkg.version,
      dependencies: pkg.dependencies ?? {},
      devDependencies: pkg.devDependencies ?? {},
      overrides: pkg.overrides ?? {},
      inventory: inventoryLockfile(lock, lockfileBytes),
    },
    manifest: validateManifest(manifest, pkg.version),
  };
}

function copyCurrentSource(destination) {
  cpSync(ROOT, destination, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(ROOT, source);
      const topLevel = relative.split(path.sep, 1)[0];
      return relative === "" || !EXCLUDED_COPY_PATHS.has(topLevel);
    },
  });
}

function removeTemporaryDirectory(directory) {
  const resolved = path.resolve(directory);
  const temporaryRoot = path.resolve(tmpdir());
  if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith(TEMP_DIRECTORY_PREFIX)) {
    fail(`refusing to remove unexpected temporary directory: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function buildInIndependentCleanInstall(sourceLabel, rootLockHash) {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), TEMP_DIRECTORY_PREFIX));
  const sourceDirectory = path.join(temporaryDirectory, "source");
  try {
    copyCurrentSource(sourceDirectory);
    const copiedPreflight = preflight(sourceDirectory);
    validateRawLockfileHashes(rootLockHash, copiedPreflight.package.inventory.rawSha256, "root", `${sourceLabel} before npm ci`);
    run("npm", ["ci"], sourceDirectory);
    const installedLockHash = hashRawLockfile(readFileSync(path.join(sourceDirectory, "package-lock.json")));
    validateRawLockfileHashes(rootLockHash, installedLockHash, "root", `${sourceLabel} after npm ci`);
    run("npm", ["run", "build:extension"], sourceDirectory);
    const sourceManifest = readJson(path.join(sourceDirectory, "src/extension/manifest.json"));
    return validateBundle(sourceDirectory, sourceManifest);
  } finally {
    removeTemporaryDirectory(temporaryDirectory);
  }
}

export function main(args = process.argv.slice(2)) {
  const { cleanInstall } = parseOptions(args);
  const report = preflight();
  if (cleanInstall) run("npm", ["ci"]);
  run("npm", ["run", "lint"]);
  run("npx", ["tsc", "--noEmit"]);
  run("npm", ["run", "test:coverage"]);
  run("npm", ["run", "build:extension"]);
  const sourceManifest = readJson(path.join(ROOT, "src/extension/manifest.json"));
  const rootArtifacts = validateBundle(ROOT, sourceManifest);
  const rootLockHash = report.package.inventory.rawSha256;
  const firstIsolatedArtifacts = buildInIndependentCleanInstall("isolated build 1", rootLockHash);
  const secondIsolatedArtifacts = buildInIndependentCleanInstall("isolated build 2", rootLockHash);
  report.artifacts = validateIndependentBuildArtifacts(rootArtifacts, firstIsolatedArtifacts, secondIsolatedArtifacts);
  run("npm", ["audit", "--audit-level=high"]);
  run("npm", ["audit", "signatures"]);
  run("git", ["diff", "--check"]);
  process.stdout.write(`\nBASELINE_INVENTORY=${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
