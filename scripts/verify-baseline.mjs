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
const PHASE2_BOUNDARY_ARTIFACT = "docs/redesign/PHASE2_RECOVERY_BOUNDARY.json";
const PHASE2_BOUNDARY_ARTIFACT_SHA256 = "7dc75cba030673622e11a614b43f1a239cd9a0034dce948455d6289fed59c995";
const PHASE4_DELTA_ARTIFACT = "docs/redesign/PHASE4_DELTA.json";
const PHASE4_DELTA_ARTIFACT_SHA256 = "4bc10f0a43e7d687ec72e1ff2e265acef3849f05aabe0f9cb7a5b2ab1e87c6ea";
const PHASE5_DELTA_ARTIFACT = "docs/redesign/PHASE5_DELTA.json";
const PHASE5_DELTA_ARTIFACT_SHA256 = "c8e495a9073e10ee168c08450a8ff06d532ee7fd2602732eb62ec254e21469c0";
const PHASE6_DELTA_ARTIFACT = "docs/redesign/PHASE6_DELTA.json";
const PHASE6_DELTA_ARTIFACT_SHA256 = "04985ffe26a517addb8f847244f5380759f5a7f79f8f161bf341caffadae748b";
const PHASE7_DELTA_ARTIFACT = "docs/redesign/PHASE7_DELTA.json";
const PHASE7_DELTA_ARTIFACT_SHA256 = "dadafbdf50dba389282f085554ac6e78d0e0296ef2d52cf54489d05cb0c5053b";
const PHASE8_DELTA_ARTIFACT = "docs/redesign/PHASE8_DELTA.json";
const PHASE8_DELTA_ARTIFACT_SHA256 = "9079db150fdd1cb3e0d2e625c2012be4554a9cb2efb005fea046a3bb774698a1";
const PHASE9_DELTA_ARTIFACT = "docs/redesign/PHASE9_DELTA.json";
const PHASE9_DELTA_ARTIFACT_SHA256 = "06fc314c0a65754fe49cf45d74e349eb96886a3ec07c7b8cf590941b980ab7bd";
const PHASE10_DELTA_ARTIFACT = "docs/redesign/PHASE10_DELTA.json";
const PHASE10_DELTA_ARTIFACT_SHA256 = "e82611ef5c64c0e5c711ab8cad17df34b41cfab2901b3aef9500bd21c6e8f10c";
const PHASE11_DELTA_ARTIFACT = "docs/redesign/PHASE11_DELTA.json";
const PHASE11_DELTA_ARTIFACT_SHA256 = "52e3ab78bbe1009bc9bd830766a561ac6b772efbeebdbf3ba7ff807fd1ce4bb8";
const PHASE12_DELTA_ARTIFACT = "docs/redesign/PHASE12_DELTA.json";
const PHASE12_DELTA_ARTIFACT_SHA256 = "201e41ee23db733b9ca4d60eebd199448876ae7c2c0872ee834cf2dc4ed9c87e";
const PHASE13_DELTA_ARTIFACT = "docs/redesign/PHASE13_DELTA.json";
const PHASE13_DELTA_ARTIFACT_SHA256 = "8e20e54d8f724b5989023d58682961dae80a546d9ef902bf145a632e264de3ac";
const PHASE14_DELTA_ARTIFACT = "docs/redesign/PHASE14_DELTA.json";
const PHASE14_DELTA_ARTIFACT_SHA256 = "b5b578989e572d3a8ca847bffdddfee8feb6c4cd3335d6c4dcfd8758592f2998";
const PHASE15_DELTA_ARTIFACT = "docs/redesign/PHASE15_DELTA.json";
const PHASE15_DELTA_ARTIFACT_SHA256 = "ddbf5bbab3b41d9966d016df7d1567627bc43ad33862f8fae80bd385ce66d2eb";
const PHASE16_DELTA_ARTIFACT = "docs/redesign/PHASE16_DELTA.json";
const PHASE16_DELTA_ARTIFACT_SHA256 = "64aa284c2702fef6827804b8496c345319701834d2e6e96c5bdc144239c184a6";
const PHASE17_DELTA_ARTIFACT = "docs/redesign/PHASE17_DELTA.json";
const PHASE17_DELTA_ARTIFACT_SHA256 = "ef865d33530c9d12a05f9a9f95ad2db72886e3bdbf5bac976cceacad6ce8901b";
const PHASE18_DELTA_ARTIFACT = "docs/redesign/PHASE18_DELTA.json";
const PHASE18_DELTA_ARTIFACT_SHA256 = "9082739dd58186efce8c806f88972f4cb15adb55502e95f62647500672a5afac";
const PHASE19_DELTA_ARTIFACT = "docs/redesign/PHASE19_DELTA.json";
const PHASE2_BOUNDARY_RECURSIVE_DIRECTORIES = [".github", "assets", "src"];
const PHASE2_BOUNDARY_ROOT_FILES = [
  ".gitignore",
  ".nvmrc",
  "LICENSE",
  "PERMISSIONS.md",
  "README.md",
  "build-utils.ts",
  "esbuild.config.ts",
  "eslint.config.mjs",
  "package-lock.json",
  "package.json",
  "scripts/generate-icons.mjs",
  "tsconfig.json",
  "vitest.config.ts",
];
export const EXPECTED_BUNDLE_FILES = [
  "manifest.json",
  "background.js",
  "content.js",
  "content-main.js",
  "sidepanel.js",
  "sidepanel.html",
  "sidepanel.css",
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
const EXPECTED_CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; base-uri 'self'; frame-ancestors 'none';";
const REVIEWED_PERMISSIONS = [
  "sidePanel", "scripting", "tabs", "activeTab", "storage", "alarms", "debugger",
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

function portableRelative(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function repositoryPathInventory(root, recursiveDirectories, rootFiles) {
  const absoluteFiles = [];
  const walk = (directory) => {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
      fail(`boundary inventory directory is missing: ${portableRelative(root, directory)}`);
    }
    for (const entry of readdirSync(directory).sort()) {
      const absolute = path.join(directory, entry);
      const stats = statSync(absolute);
      if (stats.isDirectory()) walk(absolute);
      else if (stats.isFile()) absoluteFiles.push(absolute);
    }
  };
  for (const directory of recursiveDirectories) walk(path.join(root, directory));
  for (const file of rootFiles) {
    const absolute = path.join(root, file);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      fail(`boundary inventory file is missing: ${file}`);
    }
    absoluteFiles.push(absolute);
  }
  return [...new Set(absoluteFiles.map((absolute) => path.resolve(absolute)))]
    .map((absolute) => {
      const bytes = readFileSync(absolute);
      return { file: portableRelative(root, absolute), bytes: bytes.length, sha256: sha256(bytes) };
    })
    .sort((left, right) => left.file.localeCompare(right.file));
}

function summarizeRepositoryInventory(inventory) {
  const stable = [...inventory]
    .sort((left, right) => left.file.localeCompare(right.file))
    .map(({ file, bytes, sha256: digest }) => ({ file, bytes, sha256: digest }));
  const pathBytes = stable.map(({ file }) => file).join("\n") + "\n";
  const treeBytes = stable
    .map(({ file, bytes, sha256: digest }) => `${file}\0${bytes}\0${digest}`)
    .join("\n") + "\n";
  return {
    fileCount: stable.length,
    totalBytes: stable.reduce((total, item) => total + item.bytes, 0),
    pathInventorySha256: sha256(pathBytes),
    contentTreeSha256: sha256(treeBytes),
  };
}

/** Build the canonical recovery-era boundary and recorded Phase 3 delta summaries. */
export function buildPhase2RecoveryBoundaryInventory(root, phase3DeltaFiles) {
  const production = repositoryPathInventory(
    root,
    PHASE2_BOUNDARY_RECURSIVE_DIRECTORIES,
    PHASE2_BOUNDARY_ROOT_FILES,
  );
  const normalizedDelta = [...phase3DeltaFiles].map((file) => String(file).split(path.sep).join("/"));
  if (new Set(normalizedDelta).size !== normalizedDelta.length) {
    fail("Phase 3 delta inventory contains duplicate paths");
  }
  const invalidDelta = normalizedDelta.filter((file) =>
    !(file.startsWith("tests/") || file.startsWith("docs/redesign/") || file === "scripts/verify-baseline.mjs") ||
    file === PHASE2_BOUNDARY_ARTIFACT,
  );
  if (invalidDelta.length > 0) {
    fail(`Phase 3 delta escapes test/verifier/docs scope: ${invalidDelta.join(", ")}`);
  }
  const delta = repositoryPathInventory(root, [], normalizedDelta);
  return {
    production: summarizeRepositoryInventory(production),
    phase3Delta: summarizeRepositoryInventory(delta),
  };
}

/** Validate the now-immutable recovery-era artifact itself, not the live tree. */
export function validatePhase2RecoveryBoundary(root = ROOT) {
  const artifactPath = path.join(root, PHASE2_BOUNDARY_ARTIFACT);
  if (!existsSync(artifactPath)) fail(`missing recovery boundary artifact: ${PHASE2_BOUNDARY_ARTIFACT}`);
  const artifactBytes = readFileSync(artifactPath);
  if (sha256(artifactBytes) !== PHASE2_BOUNDARY_ARTIFACT_SHA256) {
    fail("immutable Phase 2 recovery boundary artifact bytes changed after Phase 3 closure");
  }
  const artifact = JSON.parse(artifactBytes.toString("utf8"));
  if (artifact?.formatVersion !== 1 || artifact?.boundary !== "phase-2-recovery-era") {
    fail("Phase 2 recovery boundary artifact has an unsupported format");
  }
  if (!sameValues(artifact.productionScope?.recursiveDirectories ?? [], PHASE2_BOUNDARY_RECURSIVE_DIRECTORIES) ||
      !sameValues(artifact.productionScope?.rootFiles ?? [], PHASE2_BOUNDARY_ROOT_FILES)) {
    fail("Phase 2 recovery boundary scope differs from the reviewed production/config/build inventory");
  }
  if (!Array.isArray(artifact.phase3Delta?.files)) {
    fail("Phase 2 recovery boundary artifact must list the recorded Phase 3 delta files");
  }
  if (typeof artifact.evidenceLimit !== "string" || !/not retroactive proof/i.test(artifact.evidenceLimit)) {
    fail("recovery boundary must state that it is not retroactive proof of lost history");
  }
  return {
    artifactSha256: PHASE2_BOUNDARY_ARTIFACT_SHA256,
    production: artifact.productionInventory,
    phase3Delta: artifact.phase3Delta.inventory,
  };
}

/**
 * Bind Phase 4 to the immutable recovery-era artifact without pretending the
 * aggregate Phase 2 hash can identify historical per-file changes. The Phase 4
 * artifact therefore records the reviewed production-path allowlist and pins
 * the complete resulting production tree. It must remain provisional until all
 * Phase 4 owners have supplied their paths.
 */
export function validatePhase4Delta(root = ROOT, artifactOverride) {
  const phase2 = validatePhase2RecoveryBoundary(root);
  const artifactPath = path.join(root, PHASE4_DELTA_ARTIFACT);
  if (!artifactOverride && !existsSync(artifactPath)) {
    fail(`missing Phase 4 delta artifact: ${PHASE4_DELTA_ARTIFACT}`);
  }
  let artifactSha256 = null;
  if (!artifactOverride) {
    artifactSha256 = sha256(readFileSync(artifactPath));
    if (artifactSha256 !== PHASE4_DELTA_ARTIFACT_SHA256) {
      fail("immutable Phase 4 delta artifact bytes changed after Phase 5 began");
    }
  }
  const artifact = artifactOverride ?? readJson(artifactPath);
  if (artifact?.formatVersion !== 1 || artifact?.boundary !== "phase-4-delta-against-phase-2-recovery-era") {
    fail("Phase 4 delta artifact has an unsupported format");
  }
  if (artifact.baseArtifact?.path !== PHASE2_BOUNDARY_ARTIFACT ||
      artifact.baseArtifact?.sha256 !== PHASE2_BOUNDARY_ARTIFACT_SHA256) {
    fail("Phase 4 delta must bind the immutable Phase 2 recovery artifact digest");
  }
  if (artifact.provisional === true) {
    fail("Phase 4 delta is provisional; collect every owner path and seal it before release verification");
  }
  const files = artifact.productionDelta?.files;
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== "string")) {
    fail("Phase 4 delta must list its production/config/build/runtime files");
  }
  const sortedFiles = [...files].sort((left, right) => left.localeCompare(right));
  if (new Set(files).size !== files.length || !sameValues(files, sortedFiles)) {
    fail("Phase 4 production delta paths must be unique and canonically sorted");
  }
  const productionPaths = new Set(repositoryPathInventory(
    root,
    PHASE2_BOUNDARY_RECURSIVE_DIRECTORIES,
    PHASE2_BOUNDARY_ROOT_FILES,
  ).map(({ file }) => file));
  const invalidFiles = files.filter((file) => !productionPaths.has(file));
  if (invalidFiles.length > 0) {
    fail(`Phase 4 delta escapes the production/config/build/runtime inventory: ${invalidFiles.join(", ")}`);
  }
  const resultingProductionInventory = artifact.productionDelta?.resultingProductionInventory;
  if (!resultingProductionInventory || typeof resultingProductionInventory.contentTreeSha256 !== "string") {
    fail("Phase 4 delta must retain its sealed resulting production inventory");
  }
  // Artifact overrides are verifier fixtures and still compare against the
  // live tree. The on-disk Phase 4 artifact is historical after its exact
  // bytes are frozen; Phase 5 owns subsequent live-tree equality.
  let currentProduction = null;
  if (artifactOverride) {
    currentProduction = buildPhase2RecoveryBoundaryInventory(root, []).production;
    if (JSON.stringify(currentProduction) !== JSON.stringify(resultingProductionInventory)) {
      fail("Phase 4 resulting production inventory drifted from the sealed delta");
    }
  }
  if (typeof artifact.evidenceLimit !== "string" || !/aggregate Phase 2 hash cannot identify/i.test(artifact.evidenceLimit)) {
    fail("Phase 4 delta must state the recovery-era aggregate-hash evidence limit");
  }
  return {
    phase2,
    files,
    artifactSha256,
    resultingProductionInventory,
    currentProduction,
  };
}

/** Validate the now-immutable Phase 5 record against the immutable Phase 4 delta. */
export function validatePhase5Delta(
  root = ROOT,
  artifactOverride,
  { allowProvisional = false } = {},
) {
  const phase4 = validatePhase4Delta(root);
  const artifactPath = path.join(root, PHASE5_DELTA_ARTIFACT);
  if (!artifactOverride && !existsSync(artifactPath)) {
    fail(`missing Phase 5 delta artifact: ${PHASE5_DELTA_ARTIFACT}`);
  }
  let artifactSha256 = null;
  if (!artifactOverride) {
    artifactSha256 = sha256(readFileSync(artifactPath));
    if (artifactSha256 !== PHASE5_DELTA_ARTIFACT_SHA256) {
      fail("immutable Phase 5 delta artifact bytes changed after Phase 6 began");
    }
  }
  const artifact = artifactOverride ?? readJson(artifactPath);
  if (artifact?.formatVersion !== 1 ||
      artifact?.boundary !== "phase-5-delta-against-phase-4") {
    fail("Phase 5 delta artifact has an unsupported format");
  }
  if (artifact.baseArtifact?.path !== PHASE4_DELTA_ARTIFACT ||
      artifact.baseArtifact?.sha256 !== PHASE4_DELTA_ARTIFACT_SHA256) {
    fail("Phase 5 delta must bind the immutable Phase 4 delta digest");
  }
  const provisional = artifact.provisional === true;
  if (provisional && !allowProvisional) {
    fail("Phase 5 delta is provisional; collect every owner path and seal it before release verification");
  }
  const files = artifact.productionDelta?.files;
  if (!Array.isArray(files) || files.length === 0 ||
      files.some((file) => typeof file !== "string")) {
    fail("Phase 5 delta must list its production/config/build/runtime files");
  }
  const sortedFiles = [...files].sort((left, right) => left.localeCompare(right));
  if (new Set(files).size !== files.length || !sameValues(files, sortedFiles)) {
    fail("Phase 5 production delta paths must be unique and canonically sorted");
  }
  const productionPaths = new Set(repositoryPathInventory(
    root,
    PHASE2_BOUNDARY_RECURSIVE_DIRECTORIES,
    PHASE2_BOUNDARY_ROOT_FILES,
  ).map(({ file }) => file));
  const invalidFiles = files.filter((file) => !productionPaths.has(file));
  if (invalidFiles.length > 0) {
    fail(`Phase 5 delta escapes the production/config/build/runtime inventory: ${invalidFiles.join(", ")}`);
  }
  const recorded = artifact.productionDelta?.resultingProductionInventory;
  if (provisional) {
    if (recorded !== null) {
      fail("provisional Phase 5 delta must not claim a sealed resulting inventory");
    }
  } else if (!recorded || typeof recorded.contentTreeSha256 !== "string") {
    fail("Phase 5 delta must retain its sealed resulting production inventory");
  }
  let currentProduction = null;
  if (artifactOverride && !provisional) {
    currentProduction = buildPhase2RecoveryBoundaryInventory(root, []).production;
    if (JSON.stringify(currentProduction) !== JSON.stringify(recorded)) {
      fail("Phase 5 resulting production inventory drifted from the sealed delta");
    }
  }
  if (typeof artifact.evidenceLimit !== "string" ||
      !/provisional/i.test(artifact.evidenceLimit)) {
    fail("Phase 5 delta must state its provisional evidence limit");
  }
  return {
    phase4,
    provisional,
    files,
    artifactSha256,
    resultingProductionInventory: recorded,
    currentProduction,
  };
}

/** Validate the immutable Phase 6 record against the immutable Phase 5 delta. */
export function validatePhase6Delta(
  root = ROOT,
  artifactOverride,
  { allowProvisional = false } = {},
) {
  const phase5 = validatePhase5Delta(root);
  const artifactPath = path.join(root, PHASE6_DELTA_ARTIFACT);
  if (!artifactOverride && !existsSync(artifactPath)) {
    fail(`missing Phase 6 delta artifact: ${PHASE6_DELTA_ARTIFACT}`);
  }
  let artifactSha256 = null;
  if (!artifactOverride) {
    artifactSha256 = sha256(readFileSync(artifactPath));
    if (artifactSha256 !== PHASE6_DELTA_ARTIFACT_SHA256) {
      fail("immutable Phase 6 delta artifact bytes changed after Phase 7 began");
    }
  }
  const artifact = artifactOverride ?? readJson(artifactPath);
  if (artifact?.formatVersion !== 1 || artifact?.boundary !== "phase-6-delta-against-phase-5") {
    fail("Phase 6 delta artifact has an unsupported format");
  }
  if (artifact.baseArtifact?.path !== PHASE5_DELTA_ARTIFACT ||
      artifact.baseArtifact?.sha256 !== PHASE5_DELTA_ARTIFACT_SHA256) {
    fail("Phase 6 delta must bind the immutable Phase 5 delta digest");
  }
  const provisional = artifact.provisional === true;
  if (provisional && !allowProvisional) {
    fail("Phase 6 delta is provisional; collect every owner path and seal it before release verification");
  }
  const files = artifact.productionDelta?.files;
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== "string")) {
    fail("Phase 6 delta must list its production/config/build/runtime files");
  }
  const sortedFiles = [...files].sort((left, right) => left.localeCompare(right));
  if (new Set(files).size !== files.length || !sameValues(files, sortedFiles)) {
    fail("Phase 6 production delta paths must be unique and canonically sorted");
  }
  const productionPaths = new Set(repositoryPathInventory(
    root,
    PHASE2_BOUNDARY_RECURSIVE_DIRECTORIES,
    PHASE2_BOUNDARY_ROOT_FILES,
  ).map(({ file }) => file));
  const invalidFiles = files.filter((file) => !productionPaths.has(file));
  if (invalidFiles.length > 0) {
    fail(`Phase 6 delta escapes the production/config/build/runtime inventory: ${invalidFiles.join(", ")}`);
  }
  const recorded = artifact.productionDelta?.resultingProductionInventory;
  if (provisional) {
    if (recorded !== null) fail("provisional Phase 6 delta must not claim a sealed resulting inventory");
  } else if (!recorded || typeof recorded.contentTreeSha256 !== "string") {
    fail("Phase 6 delta must retain its sealed resulting production inventory");
  }
  let currentProduction = null;
  if (artifactOverride && !provisional) {
    currentProduction = buildPhase2RecoveryBoundaryInventory(root, []).production;
    if (JSON.stringify(currentProduction) !== JSON.stringify(recorded)) {
      fail("Phase 6 resulting production inventory drifted from the sealed delta");
    }
  }
  if (typeof artifact.evidenceLimit !== "string" || !/provisional/i.test(artifact.evidenceLimit)) {
    fail("Phase 6 delta must state its provisional evidence limit");
  }
  return { phase5, provisional, files, artifactSha256, resultingProductionInventory: recorded, currentProduction };
}

/** Bind the live Phase 7 tree to immutable Phase 6 bytes. */
export function validatePhase7Delta(
  root = ROOT,
  artifactOverride,
  { allowProvisional = false } = {},
) {
  const phase6 = validatePhase6Delta(root);
  const artifactPath = path.join(root, PHASE7_DELTA_ARTIFACT);
  if (!artifactOverride && !existsSync(artifactPath)) fail(`missing Phase 7 delta artifact: ${PHASE7_DELTA_ARTIFACT}`);
  let artifactSha256 = null;
  if (!artifactOverride) {
    artifactSha256 = sha256(readFileSync(artifactPath));
    if (artifactSha256 !== PHASE7_DELTA_ARTIFACT_SHA256) {
      fail("immutable Phase 7 delta artifact bytes changed after Phase 8 began");
    }
  }
  const artifact = artifactOverride ?? readJson(artifactPath);
  if (artifact?.formatVersion !== 1 || artifact?.boundary !== "phase-7-delta-against-phase-6") {
    fail("Phase 7 delta artifact has an unsupported format");
  }
  if (artifact.baseArtifact?.path !== PHASE6_DELTA_ARTIFACT ||
      artifact.baseArtifact?.sha256 !== PHASE6_DELTA_ARTIFACT_SHA256) {
    fail("Phase 7 delta must bind the immutable Phase 6 delta digest");
  }
  const provisional = artifact.provisional === true;
  if (provisional && !allowProvisional) fail("Phase 7 delta is provisional; collect every owner path and seal it before release verification");
  const files = artifact.productionDelta?.files;
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== "string")) {
    fail("Phase 7 delta must list its production/config/build/runtime files");
  }
  const sortedFiles = [...files].sort((left, right) => left.localeCompare(right));
  if (new Set(files).size !== files.length || !sameValues(files, sortedFiles)) {
    fail("Phase 7 production delta paths must be unique and canonically sorted");
  }
  const productionPaths = new Set(repositoryPathInventory(
    root,
    PHASE2_BOUNDARY_RECURSIVE_DIRECTORIES,
    PHASE2_BOUNDARY_ROOT_FILES,
  ).map(({ file }) => file));
  const invalidFiles = files.filter((file) => !productionPaths.has(file));
  if (invalidFiles.length > 0) fail(`Phase 7 delta escapes the production/config/build/runtime inventory: ${invalidFiles.join(", ")}`);
  const recorded = artifact.productionDelta?.resultingProductionInventory;
  if (provisional) {
    if (recorded !== null) fail("provisional Phase 7 delta must not claim a sealed resulting inventory");
  } else if (!recorded || typeof recorded.contentTreeSha256 !== "string") {
    fail("Phase 7 delta must retain its sealed resulting production inventory");
  }
  // The on-disk Phase 7 artifact is historical after its exact bytes are
  // frozen; Phase 8 owns subsequent live-tree equality. Overrides (verifier
  // fixtures) still compare against the live tree.
  let currentProduction = null;
  if (artifactOverride && !provisional) {
    currentProduction = buildPhase2RecoveryBoundaryInventory(root, []).production;
    if (JSON.stringify(currentProduction) !== JSON.stringify(recorded)) {
      fail("Phase 7 resulting production inventory drifted from the sealed delta");
    }
  }
  if (typeof artifact.evidenceLimit !== "string" || !/provisional/i.test(artifact.evidenceLimit)) {
    fail("Phase 7 delta must state its provisional evidence limit");
  }
  return { phase6, provisional, files, artifactSha256, currentProduction };
}

/** Bind the live Phase 8 tree to immutable Phase 7 bytes. */
export function validatePhase8Delta(
  root = ROOT,
  artifactOverride,
  { allowProvisional = false } = {},
) {
  const phase7 = validatePhase7Delta(root);
  const artifactPath = path.join(root, PHASE8_DELTA_ARTIFACT);
  if (!artifactOverride && !existsSync(artifactPath)) fail(`missing Phase 8 delta artifact: ${PHASE8_DELTA_ARTIFACT}`);
  const artifact = artifactOverride ?? readJson(artifactPath);
  if (artifact?.formatVersion !== 1 || artifact?.boundary !== "phase-8-delta-against-phase-7") {
    fail("Phase 8 delta artifact has an unsupported format");
  }
  if (artifact.baseArtifact?.path !== PHASE7_DELTA_ARTIFACT ||
      artifact.baseArtifact?.sha256 !== PHASE7_DELTA_ARTIFACT_SHA256) {
    fail("Phase 8 delta must bind the immutable Phase 7 delta digest");
  }
  const provisional = artifact.provisional === true;
  if (provisional && !allowProvisional) fail("Phase 8 delta is provisional; collect every owner path and seal it before release verification");
  let artifactSha256 = null;
  if (!artifactOverride) {
    artifactSha256 = sha256(readFileSync(artifactPath));
  }
  const files = artifact.productionDelta?.files;
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== "string")) {
    fail("Phase 8 delta must list its production/config/build/runtime files");
  }
  const sortedFiles = [...files].sort((left, right) => left.localeCompare(right));
  if (new Set(files).size !== files.length || !sameValues(files, sortedFiles)) {
    fail("Phase 8 production delta paths must be unique and canonically sorted");
  }
  const productionPaths = new Set(repositoryPathInventory(
    root,
    PHASE2_BOUNDARY_RECURSIVE_DIRECTORIES,
    PHASE2_BOUNDARY_ROOT_FILES,
  ).map(({ file }) => file));
  const invalidFiles = files.filter((file) => !productionPaths.has(file));
  if (invalidFiles.length > 0) fail(`Phase 8 delta escapes the production/config/build/runtime inventory: ${invalidFiles.join(", ")}`);
  const currentProduction = buildPhase2RecoveryBoundaryInventory(root, []).production;
  const recorded = artifact.productionDelta?.resultingProductionInventory;
  if (provisional) {
    if (recorded !== null) fail("provisional Phase 8 delta must not claim a sealed resulting inventory");
  } else if (!recorded || typeof recorded.contentTreeSha256 !== "string") {
    fail("Phase 8 delta must retain its sealed resulting production inventory");
  }
  // The on-disk Phase 8 artifact is historical after its exact bytes are
  // frozen; Phase 9 owns subsequent live-tree equality. Overrides (verifier
  // fixtures) still compare against the live tree.
  if (artifactOverride && !provisional) {
    if (JSON.stringify(currentProduction) !== JSON.stringify(recorded)) {
      fail("Phase 8 resulting production inventory drifted from the sealed delta");
    }
  }
  if (typeof artifact.evidenceLimit !== "string" || !/provisional/i.test(artifact.evidenceLimit)) {
    fail("Phase 8 delta must state its provisional evidence limit");
  }
  return { phase7, provisional, files, artifactSha256, currentProduction };
}

/**
 * Shared structural validation for a phase delta that binds the previous
 * phase's digest and owns the live-tree equality gate. Used by Phase 9 and
 * Phase 10 (and any later phase) to avoid per-phase copy/paste drift.
 */
function validateSequentialPhaseDelta({
  root,
  artifactOverride,
  allowProvisional,
  artifactPath,
  baseArtifactPath,
  baseArtifactSha256,
  boundary,
  label,
  baseValidator,
  liveTreeCheck = true,
}) {
  const base = baseValidator(root);
  if (!artifactOverride && !existsSync(artifactPath)) fail(`missing ${label} delta artifact: ${artifactPath}`);
  let artifactSha256 = null;
  if (!artifactOverride) {
    artifactSha256 = sha256(readFileSync(artifactPath));
  }
  const artifact = artifactOverride ?? readJson(artifactPath);
  if (artifact?.formatVersion !== 1 || artifact?.boundary !== boundary) {
    fail(`${label} delta artifact has an unsupported format`);
  }
  if (artifact.baseArtifact?.path !== baseArtifactPath ||
      artifact.baseArtifact?.sha256 !== baseArtifactSha256) {
    fail(`${label} delta must bind the immutable ${label} digest`);
  }
  const provisional = artifact.provisional === true;
  if (provisional && !allowProvisional) {
    fail(`${label} delta is provisional; collect every owner path and seal it before release verification`);
  }
  const files = artifact.productionDelta?.files;
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== "string")) {
    fail(`${label} delta must list its production/config/build/runtime files`);
  }
  const sortedFiles = [...files].sort((left, right) => left.localeCompare(right));
  if (new Set(files).size !== files.length || !sameValues(files, sortedFiles)) {
    fail(`${label} production delta paths must be unique and canonically sorted`);
  }
  const productionPaths = new Set(repositoryPathInventory(
    root,
    PHASE2_BOUNDARY_RECURSIVE_DIRECTORIES,
    PHASE2_BOUNDARY_ROOT_FILES,
  ).map(({ file }) => file));
  const invalidFiles = files.filter((file) => !productionPaths.has(file));
  if (invalidFiles.length > 0) fail(`${label} delta escapes the production/config/build/runtime inventory: ${invalidFiles.join(", ")}`);
  const currentProduction = buildPhase2RecoveryBoundaryInventory(root, []).production;
  const recorded = artifact.productionDelta?.resultingProductionInventory;
  if (provisional) {
    if (recorded !== null) fail(`provisional ${label} delta must not claim a sealed resulting inventory`);
  } else if (!recorded || typeof recorded.contentTreeSha256 !== "string") {
    fail(`${label} delta must retain its sealed resulting production inventory`);
  } else if (liveTreeCheck && JSON.stringify(currentProduction) !== JSON.stringify(recorded)) {
    fail(`${label} resulting production inventory drifted from the sealed delta`);
  }
  if (typeof artifact.evidenceLimit !== "string" || !/provisional/i.test(artifact.evidenceLimit)) {
    fail(`${label} delta must state its provisional evidence limit`);
  }
  return { base, provisional, files, artifactSha256, currentProduction };
}

/** Bind the live Phase 9 tree to immutable Phase 8 bytes (historical since Phase 10). */
export function validatePhase9Delta(root = ROOT, artifactOverride, { allowProvisional = false } = {}) {
  return validateSequentialPhaseDelta({
    root,
    artifactOverride,
    allowProvisional,
    artifactPath: path.join(root, PHASE9_DELTA_ARTIFACT),
    baseArtifactPath: PHASE8_DELTA_ARTIFACT,
    baseArtifactSha256: PHASE8_DELTA_ARTIFACT_SHA256,
    boundary: "phase-9-delta-against-phase-8",
    label: "Phase 9",
    baseValidator: validatePhase8Delta,
    liveTreeCheck: false,
  });
}

/** Bind the live Phase 10 tree to immutable Phase 9 bytes (historical since Phase 11). */
export function validatePhase10Delta(root = ROOT, artifactOverride, { allowProvisional = false } = {}) {
  return validateSequentialPhaseDelta({
    root,
    artifactOverride,
    allowProvisional,
    artifactPath: path.join(root, PHASE10_DELTA_ARTIFACT),
    baseArtifactPath: PHASE9_DELTA_ARTIFACT,
    baseArtifactSha256: PHASE9_DELTA_ARTIFACT_SHA256,
    boundary: "phase-10-delta-against-phase-9",
    label: "Phase 10",
    baseValidator: validatePhase9Delta,
    liveTreeCheck: false,
  });
}

/** Bind the live Phase 11 tree to immutable Phase 10 bytes (historical since Phase 12). */
export function validatePhase11Delta(root = ROOT, artifactOverride, { allowProvisional = false } = {}) {
  return validateSequentialPhaseDelta({
    root,
    artifactOverride,
    allowProvisional,
    artifactPath: path.join(root, PHASE11_DELTA_ARTIFACT),
    baseArtifactPath: PHASE10_DELTA_ARTIFACT,
    baseArtifactSha256: PHASE10_DELTA_ARTIFACT_SHA256,
    boundary: "phase-11-delta-against-phase-10",
    label: "Phase 11",
    baseValidator: validatePhase10Delta,
    liveTreeCheck: false,
  });
}

/** Bind the live Phase 12 tree to immutable Phase 11 bytes (historical since Phase 13). */
export function validatePhase12Delta(root = ROOT, artifactOverride, { allowProvisional = false } = {}) {
  return validateSequentialPhaseDelta({
    root,
    artifactOverride,
    allowProvisional,
    artifactPath: path.join(root, PHASE12_DELTA_ARTIFACT),
    baseArtifactPath: PHASE11_DELTA_ARTIFACT,
    baseArtifactSha256: PHASE11_DELTA_ARTIFACT_SHA256,
    boundary: "phase-12-delta-against-phase-11",
    label: "Phase 12",
    baseValidator: validatePhase11Delta,
    liveTreeCheck: false,
  });
}

/** Bind the live Phase 13 tree to immutable Phase 12 bytes (historical since Phase 14). */
export function validatePhase13Delta(root = ROOT, artifactOverride, { allowProvisional = false } = {}) {
  return validateSequentialPhaseDelta({
    root,
    artifactOverride,
    allowProvisional,
    artifactPath: path.join(root, PHASE13_DELTA_ARTIFACT),
    baseArtifactPath: PHASE12_DELTA_ARTIFACT,
    baseArtifactSha256: PHASE12_DELTA_ARTIFACT_SHA256,
    boundary: "phase-13-delta-against-phase-12",
    label: "Phase 13",
    baseValidator: validatePhase12Delta,
    liveTreeCheck: false,
  });
}

/** Bind the live Phase 14 tree to immutable Phase 13 bytes (historical since Phase 15). */
export function validatePhase14Delta(root = ROOT, artifactOverride, { allowProvisional = false } = {}) {
  return validateSequentialPhaseDelta({
    root,
    artifactOverride,
    allowProvisional,
    artifactPath: path.join(root, PHASE14_DELTA_ARTIFACT),
    baseArtifactPath: PHASE13_DELTA_ARTIFACT,
    baseArtifactSha256: PHASE13_DELTA_ARTIFACT_SHA256,
    boundary: "phase-14-delta-against-phase-13",
    label: "Phase 14",
    baseValidator: validatePhase13Delta,
    liveTreeCheck: false,
  });
}

/** Bind the live Phase 15 tree to immutable Phase 14 bytes (historical since Phase 16). */
export function validatePhase15Delta(root = ROOT, artifactOverride, { allowProvisional = false } = {}) {
  return validateSequentialPhaseDelta({
    root,
    artifactOverride,
    allowProvisional,
    artifactPath: path.join(root, PHASE15_DELTA_ARTIFACT),
    baseArtifactPath: PHASE14_DELTA_ARTIFACT,
    baseArtifactSha256: PHASE14_DELTA_ARTIFACT_SHA256,
    boundary: "phase-15-delta-against-phase-14",
    label: "Phase 15",
    baseValidator: validatePhase14Delta,
    liveTreeCheck: false,
  });
}

/** Bind the live Phase 16 tree to immutable Phase 15 bytes (historical since Phase 17). */
export function validatePhase16Delta(root = ROOT, artifactOverride, { allowProvisional = false } = {}) {
  return validateSequentialPhaseDelta({
    root,
    artifactOverride,
    allowProvisional,
    artifactPath: path.join(root, PHASE16_DELTA_ARTIFACT),
    baseArtifactPath: PHASE15_DELTA_ARTIFACT,
    baseArtifactSha256: PHASE15_DELTA_ARTIFACT_SHA256,
    boundary: "phase-16-delta-against-phase-15",
    label: "Phase 16",
    baseValidator: validatePhase15Delta,
    liveTreeCheck: false,
  });
}

/** Bind the live Phase 17 tree to immutable Phase 16 bytes (historical since Phase 18). */
export function validatePhase17Delta(root = ROOT, artifactOverride, { allowProvisional = false } = {}) {
  return validateSequentialPhaseDelta({
    root,
    artifactOverride,
    allowProvisional,
    artifactPath: path.join(root, PHASE17_DELTA_ARTIFACT),
    baseArtifactPath: PHASE16_DELTA_ARTIFACT,
    baseArtifactSha256: PHASE16_DELTA_ARTIFACT_SHA256,
    boundary: "phase-17-delta-against-phase-16",
    label: "Phase 17",
    baseValidator: validatePhase16Delta,
    liveTreeCheck: false,
  });
}

/** Bind the live Phase 18 tree to immutable Phase 17 bytes (historical since Phase 19). */
export function validatePhase18Delta(root = ROOT, artifactOverride, { allowProvisional = false } = {}) {
  return validateSequentialPhaseDelta({
    root,
    artifactOverride,
    allowProvisional,
    artifactPath: path.join(root, PHASE18_DELTA_ARTIFACT),
    baseArtifactPath: PHASE17_DELTA_ARTIFACT,
    baseArtifactSha256: PHASE17_DELTA_ARTIFACT_SHA256,
    boundary: "phase-18-delta-against-phase-17",
    label: "Phase 18",
    baseValidator: validatePhase17Delta,
    liveTreeCheck: false,
  });
}

/** Bind the live Phase 19 tree to immutable Phase 18 bytes. */
export function validatePhase19Delta(root = ROOT, artifactOverride, { allowProvisional = false } = {}) {
  return validateSequentialPhaseDelta({
    root,
    artifactOverride,
    allowProvisional,
    artifactPath: path.join(root, PHASE19_DELTA_ARTIFACT),
    baseArtifactPath: PHASE18_DELTA_ARTIFACT,
    baseArtifactSha256: PHASE18_DELTA_ARTIFACT_SHA256,
    boundary: "phase-19-delta-against-phase-18",
    label: "Phase 19",
    baseValidator: validatePhase18Delta,
    liveTreeCheck: true,
  });
}

/**
 * Phase 19 gate — the file-disposition ledger must be closed: no row may carry
 * an Unreviewed status. A new file added without a reviewed disposition fails
 * release verification.
 */
export function validateLedgerClosed(root = ROOT) {
  const ledgerPath = path.join(root, "docs/redesign/FILE_DISPOSITION_LEDGER.md");
  if (!existsSync(ledgerPath)) fail("missing FILE_DISPOSITION_LEDGER.md");
  const content = readFileSync(ledgerPath, "utf8");
  const unreviewed = content.split("\n").filter((line) => line.includes("| Unreviewed |")).length;
  if (unreviewed > 0) {
    fail(`file-disposition ledger has ${unreviewed} Unreviewed row(s); every tracked non-generated file must carry an executed disposition (Phase 19)`);
  }
  return { unreviewed };
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
    phase7Delta: validatePhase7Delta(root),
    phase8Delta: validatePhase8Delta(root),
    phase9Delta: validatePhase9Delta(root),
    phase10Delta: validatePhase10Delta(root),
    phase11Delta: validatePhase11Delta(root),
    phase12Delta: validatePhase12Delta(root),
    phase13Delta: validatePhase13Delta(root),
    phase14Delta: validatePhase14Delta(root),
    phase15Delta: validatePhase15Delta(root),
    phase16Delta: validatePhase16Delta(root),
    phase17Delta: validatePhase17Delta(root),
    phase18Delta: validatePhase18Delta(root),
    phase19Delta: validatePhase19Delta(root),
    ledger: validateLedgerClosed(root),
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
