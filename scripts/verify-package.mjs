import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const DIST_ENTRY = "dist/smooth-operator.mjs";
const DIST_MAP = "dist/smooth-operator.mjs.map";
const REQUIRED_PACKAGED_FILES = new Set([
  "package.json",
  "README.md",
  "LICENSE",
  ".env.example",
  "docs/mcp-server.md",
  "docs/harnesses.md",
  DIST_ENTRY,
  DIST_MAP,
]);
const FORBIDDEN_RUNTIME_REFERENCES = [
  /\bsrc\/extension\b/i,
  /\bchrome\s+extension\b/i,
  /\bservice\s+worker\b/i,
  /\bcontent\s+script/i,
  /\bembedded\s+(?:model|agent)/i,
  /\bmodel\s+provider/i,
  /\bnative\s+messaging\b/i,
  /\blightpanda\b/i,
  /\binternal\s+(?:agent\s+)?loop\b/i,
];

function usage() {
  return "Usage: node scripts/verify-package.mjs [--install]";
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (args.some((argument) => argument !== "--install")) {
    throw new Error(`Unknown package verification option. ${usage()}`);
  }
  const install = args.includes("--install");
  const packageJsonPath = join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  await verifySourceMetadata(packageJson);
  await verifySourceHygiene();
  await access(join(root, DIST_ENTRY));
  await verifySourceModes();

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "smooth-operator-package-smoke-"));
  try {
    const packed = await execFileAsync(npmCommand, ["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryDirectory], {
      cwd: root,
      maxBuffer: 2_000_000,
      timeout: 120_000,
    });
    const metadata = JSON.parse(packed.stdout.trim());
    const pack = metadata[0];
    if (!pack || pack.name !== packageJson.name || pack.version !== packageJson.version || typeof pack.filename !== "string" || !Array.isArray(pack.files)) {
      throw new Error("npm pack returned incomplete or mismatched package metadata.");
    }
    const files = new Set(pack.files.map((file) => file.path));
    const missing = [...REQUIRED_PACKAGED_FILES].filter((path) => !files.has(path));
    const unexpected = [...files].filter((path) => !REQUIRED_PACKAGED_FILES.has(path));
    const forbidden = [...files].filter((path) => /^(?:src|tests|scripts|coverage|node_modules|\.git)\//.test(path) || path === "package-lock.json");
    if (missing.length || unexpected.length || forbidden.length) {
      throw new Error(`Package contents failed verification: missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}; forbidden=${forbidden.join(",") || "none"}.`);
    }
    await verifyPackText(files);
    await verifySourcemap();
    const tarball = join(temporaryDirectory, pack.filename);
    let installStatus = "not-run";
    if (install) {
      const installDirectory = await mkdtemp(join(tmpdir(), "smooth-operator-package-install-"));
      try {
        await execFileAsync(npmCommand, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--prefix", installDirectory, tarball], {
          cwd: installDirectory,
          maxBuffer: 2_000_000,
          timeout: 180_000,
        });
        const binary = join(installDirectory, "node_modules", ".bin", process.platform === "win32" ? "smooth-operator.cmd" : "smooth-operator");
        const version = await execFileAsync(binary, ["--version"], { cwd: installDirectory, timeout: 30_000 });
        if (version.stdout.trim() !== packageJson.version) {
          throw new Error(`Installed package reported version '${version.stdout.trim()}', expected '${packageJson.version}'.`);
        }
        const transport = new StdioClientTransport({
          command: binary,
          args: ["--transport", "stdio"],
          cwd: installDirectory,
          env: {
            ...process.env,
            SMOOTH_OPERATOR_BROWSER_MODE: "disabled",
            SMOOTH_OPERATOR_DATA_DIR: join(installDirectory, "data"),
            SMOOTH_OPERATOR_LOG_LEVEL: "error",
          },
          stderr: "pipe",
        });
        const client = new Client({ name: "smooth-operator-package-smoke", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
        try {
          await client.connect(transport);
          const tools = await client.listTools();
          if (!Array.isArray(tools.tools) || tools.tools.length === 0) {
            throw new Error("Installed package completed stdio handshake but returned no MCP tools.");
          }
        } finally {
          await client.close().catch(() => undefined);
          await transport.close().catch(() => undefined);
        }
        installStatus = "passed";
      } finally {
        await rm(installDirectory, { recursive: true, force: true });
      }
    }
    process.stdout.write(`${JSON.stringify({ ok: true, package: `${packageJson.name}@${packageJson.version}`, fileCount: files.size, install: installStatus })}\n`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function verifySourceMetadata(packageJson) {
  if (packageJson.name !== "smooth-operator-mcp") {
    throw new Error("package.json name must remain smooth-operator-mcp.");
  }
  const declaredFiles = new Set(Array.isArray(packageJson.files) ? packageJson.files : []);
  const expectedFiles = new Set(["dist", "docs/mcp-server.md", "docs/harnesses.md", "README.md", "LICENSE", ".env.example"]);
  if (declaredFiles.size !== expectedFiles.size || [...expectedFiles].some((file) => !declaredFiles.has(file))) {
    throw new Error(`package.json files must intentionally allowlist: ${[...expectedFiles].join(", ")}.`);
  }
  if (packageJson.bin?.["smooth-operator"] !== DIST_ENTRY) {
    throw new Error(`package.json must expose smooth-operator at ${DIST_ENTRY}.`);
  }
  if (packageJson.packageManager !== "npm@12.0.2") {
    throw new Error("package.json must declare npm@12.0.2 as its package manager baseline.");
  }
  if (packageJson.engines?.node !== ">=22.23.2" || packageJson.engines?.npm !== ">=12.0.2") {
    throw new Error("package.json engines must declare the Node 22.23.2/npm 12.0.2 baseline.");
  }
  const lockfile = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  if (lockfile.name !== packageJson.name || lockfile.version !== packageJson.version || lockfile.packages?.[""].name !== packageJson.name || lockfile.packages?.[""].version !== packageJson.version) {
    throw new Error(`Package metadata drift: package.json=${packageJson.name}@${packageJson.version}; package-lock.json=${lockfile.name ?? "missing"}@${lockfile.version ?? "missing"}.`);
  }
  const versionSource = await readFile(join(root, "src", "server", "version.ts"), "utf8");
  const match = versionSource.match(/SERVER_VERSION\s*=\s*["']([^"']+)["']/);
  if (!match || match[1] !== packageJson.version) {
    throw new Error(`Version drift: package.json=${packageJson.version}; src/server/version.ts=${match?.[1] ?? "missing"}.`);
  }
  for (const file of ["README.md", "docs/mcp-server.md", "docs/harnesses.md"]) {
    const path = join(root, file);
    await access(path);
    const source = await readFile(path, "utf8");
    for (const pattern of FORBIDDEN_RUNTIME_REFERENCES) {
      if (pattern.test(source)) {
        throw new Error(`Forbidden legacy/runtime reference ${pattern} found in ${file}.`);
      }
    }
    await verifyMarkdownLinks(file, source);
  }
}

const SOURCE_HYGIENE_ROOTS = [
  "src/server",
  "scripts",
  ".github",
  "README.md",
  "package.json",
  "docs/mcp-server.md",
  "docs/harnesses.md",
  ".env.example",
];
// docs/superpowers contains historical design/audit evidence and intentionally
// records dropped architecture; it is not a packaged release surface.
const SOURCE_HYGIENE_EXCLUSIONS = new Set([
  // This verifier contains the forbidden expressions as its own test data.
  "scripts/verify-package.mjs",
  // Historical gitleaks exceptions intentionally name deleted legacy fixtures.
  ".github/gitleaks.toml",
]);

async function verifySourceHygiene() {
  const files = (await Promise.all(SOURCE_HYGIENE_ROOTS.map((path) => collectSurfaceFiles(path)))).flat();
  for (const file of files) {
    if (SOURCE_HYGIENE_EXCLUSIONS.has(file)) {
      continue;
    }
    const source = await readFile(join(root, file), "utf8");
    for (const pattern of FORBIDDEN_RUNTIME_REFERENCES) {
      if (pattern.test(source)) {
        throw new Error(`Forbidden stale extension/provider/model/runtime reference ${pattern} found in first-party surface ${file}.`);
      }
    }
  }
}

async function collectSurfaceFiles(relativePath) {
  const absolutePath = join(root, relativePath);
  const info = await stat(absolutePath);
  if (info.isFile()) {
    return [relativePath];
  }
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(relativePath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSurfaceFiles(child));
    } else if (entry.isFile() && /\.(?:ts|mts|mjs|js|md|json|ya?ml|toml|example)$/.test(entry.name)) {
      files.push(child);
    }
  }
  return files;
}

async function verifySourceModes() {
  for (const file of ["package.json", "LICENSE", "tsconfig.json", ".env.example"]) {
    const info = await stat(join(root, file));
    if ((info.mode & 0o111) !== 0) {
      throw new Error(`Source/document file ${file} must not be executable.`);
    }
  }
  const executable = await stat(join(root, DIST_ENTRY));
  if (process.platform !== "win32" && (executable.mode & 0o111) === 0) {
    throw new Error(`${DIST_ENTRY} must remain executable for the package bin.`);
  }
}

async function verifyPackText(files) {
  for (const file of files) {
    if (![".md", ".json", ".example", ".mjs"].includes(extname(file)) && file !== ".env.example") {
      continue;
    }
    const sourcePath = join(root, file);
    if (!file.startsWith("dist/") && !(await pathExists(sourcePath))) {
      continue;
    }
    const source = file.startsWith("dist/") ? await readFile(sourcePath, "utf8") : await readFile(sourcePath, "utf8");
    for (const pattern of FORBIDDEN_RUNTIME_REFERENCES) {
      if (pattern.test(source)) {
        throw new Error(`Forbidden legacy/runtime reference ${pattern} found in packaged file ${file}.`);
      }
    }
  }
}

async function verifyMarkdownLinks(file, source) {
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of source.matchAll(linkPattern)) {
    const raw = match[1].trim().replace(/^<|>$/g, "");
    if (!raw || raw.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith("//")) {
      continue;
    }
    const target = decodeURIComponent(raw.split(/[?#]/, 1)[0]);
    const resolved = resolve(root, dirname(file), target);
    if (!(await pathExists(resolved))) {
      throw new Error(`Broken local Markdown link in ${file}: ${raw}`);
    }
  }
}

async function verifySourcemap() {
  const entry = await readFile(join(root, DIST_ENTRY), "utf8");
  if (!entry.includes("//# sourceMappingURL=smooth-operator.mjs.map")) {
    throw new Error(`${DIST_ENTRY} must reference its external sourcemap.`);
  }
  const map = JSON.parse(await readFile(join(root, DIST_MAP), "utf8"));
  if (map.version !== 3 || !Array.isArray(map.sources) || map.sources.length === 0 || map.sourcesContent !== undefined || map.sources.some((source) => typeof source !== "string" || !/^\.\.\/src\/server\//.test(source.replaceAll("\\", "/")))) {
    throw new Error("The external sourcemap must be version 3, list sources, and omit embedded source content.");
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
