/**
 * Bundle secret-hygiene test (E5) — builds the extension bundles the same way
 * CI's `npm run build:extension` does (esbuild CLI, production define, tmp
 * outdir) and asserts no secret-shaped literals survive into the emitted JS.
 * Runs standalone because CI executes vitest BEFORE the real build, so
 * `chrome-extension/` may not exist yet.
 *
 * The esbuild CLI binary is spawned directly (not the JS API) — vitest's
 * module transform of esbuild's CJS wrapper breaks its internal binary
 * version check.
 *
 * The scanner is exercised by a positive control (planted secret) so a
 * vacuous pass is impossible.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import path from "path";
import os from "os";

/** Secret shapes the scan rejects. Kept aligned with the redaction rules. */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "openai", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "anthropic", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "google-api", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "github-pat", re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: "github-fine-grained", re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/ },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

function scanForSecrets(text: string): Array<{ name: string; match: string }> {
  const hits: Array<{ name: string; match: string }> = [];
  for (const { name, re } of SECRET_PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push({ name, match: m[0] });
  }
  return hits;
}

const ESBUILD_BIN = path.resolve("node_modules/.bin/esbuild");
const SRC = path.resolve("src/extension");

const ENTRY_POINTS = [
  { entry: "background.ts", format: "esm" as const },
  { entry: "content.ts", format: "iife" as const },
  { entry: "content-main.ts", format: "iife" as const },
  { entry: "sidepanel.ts", format: "iife" as const },
  { entry: "options.ts", format: "iife" as const },
];

let tmpDir: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "bundle-secret-hygiene-"));
});

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    tmpDir = undefined;
  }
});

describe("bundle secret hygiene", () => {
  test(
    "production bundles contain no secret-shaped literals",
    async () => {
      expect(existsSync(ESBUILD_BIN)).toBe(true);
      // Same entry points, formats, and production define as esbuild.config.ts
      // (the zod-locales/console-strip plugins are omitted — they only affect
      // size/logging, never which literals reach the bundle).
      for (const { entry, format } of ENTRY_POINTS) {
        const outdir = path.join(tmpDir!, format === "esm" ? "esm" : "iife");
        execFileSync(
          ESBUILD_BIN,
          [
            path.join(SRC, entry),
            "--bundle",
            "--target=chrome116",
            "--platform=browser",
            `--format=${format}`,
            "--splitting=false",
            "--legal-comments=none",
            "--log-level=silent",
            `--define:process.env.NODE_ENV=${JSON.stringify('"production"')}`,
            `--outdir=${outdir}`,
          ],
          { stdio: "pipe" },
        );
      }

      const hits: Array<{ file: string; pattern: string; match: string }> = [];
      const scannedFiles: Array<{ file: string; bytes: number }> = [];
      for (const subdir of readdirSync(tmpDir!)) {
        const dir = path.join(tmpDir!, subdir);
        for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
          const text = readFileSync(path.join(dir, file), "utf8");
          scannedFiles.push({ file: path.join(subdir, file), bytes: text.length });
          for (const hit of scanForSecrets(text)) {
            hits.push({ file: path.join(subdir, file), pattern: hit.name, match: hit.match.slice(0, 32) });
          }
        }
      }
      // Every entry point must have produced a non-empty bundle — otherwise a
      // silent build failure would make the scan vacuous.
      expect(scannedFiles.length).toBe(ENTRY_POINTS.length);
      for (const f of scannedFiles) expect(f.bytes).toBeGreaterThan(1_000);
      expect(hits).toEqual([]);
    },
    180_000,
  );

  test("the scanner catches a planted secret (positive control)", () => {
    const planted = 'const k = "sk-ant-A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0U1V2W3X4Y5Z";';
    const hits = scanForSecrets(planted);
    expect(hits.some((h) => h.name === "anthropic")).toBe(true);
  });

  test("the scanner flags a JWT-shaped literal (positive control)", () => {
    const planted =
      'const t = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";';
    const hits = scanForSecrets(planted);
    expect(hits.some((h) => h.name === "jwt")).toBe(true);
  });
});
