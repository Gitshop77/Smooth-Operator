#!/usr/bin/env node

/**
 * Mutation / negative verification for the CRITICAL CONTROLS (Phase 15).
 *
 * For each control, applies ONE deliberate weakening to the production source
 * (backup → mutate → run the adversarial suite → restore), then requires the
 * suite to FAIL under the mutation. A mutation that the suite does NOT catch
 * is a real gap in the control's verification and fails this gate.
 *
 * The mutation targets mirror the tests in
 * `tests/phase15-mutation-controls.test.ts` (and, where noted, the existing
 * dedicated suites): cancellation abort, cost-cap enforcement, credential
 * redaction, SSRF sink-IP guard, stale-element guard, run-phase transition
 * fail-closed, and the settings save-summary permission line.
 *
 * Usage:
 *   node scripts/mutation-check.mjs            # run every mutation
 *   node scripts/mutation-check.mjs --only ssrf,redaction
 *   MUTATION_VERBOSE=1 node scripts/mutation-check.mjs
 *
 * Exit code: 0 when every mutation is caught (suite fails as expected and the
 * file is restored byte-for-byte); 1 otherwise.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** One mutation per critical control. `find` must match exactly once. */
export const MUTATIONS = [
  {
    id: "cancellation-abort",
    control: "cancellation",
    file: "src/extension/background/run-controller.ts",
    find: '    this.rootAbortController.abort(new DOMException(message, "AbortError"));\n    return this.snapshot;',
    replace: '    void message; // MUTATION-15: cancellation abort removed\n    return this.snapshot;',
    suites: ["tests/phase15-mutation-controls.test.ts", "tests/run-controller.test.ts"],
  },
  {
    id: "budget-cap",
    control: "budget enforcement",
    file: "src/lib/agent/loop/helpers/state-helpers.ts",
    find: "  const exceeded =\n    Number.isFinite(totalCostUsd) &&",
    replace: "  const exceeded =\n    false && // MUTATION-15: cost cap bypassed\n    Number.isFinite(totalCostUsd) &&",
    suites: ["tests/phase15-mutation-controls.test.ts", "tests/cost-cap.test.ts"],
  },
  {
    id: "credential-redaction",
    control: "credential redaction",
    file: "src/lib/agent/redact-shared.ts",
    find: "  let out = s.replace(keyRe(), (m) => {",
    replace: "  let out = s; if (false) out = s.replace(keyRe(), (m) => { // MUTATION-15: key-prefix redaction removed",
    suites: ["tests/phase15-mutation-controls.test.ts", "tests/messages-redaction.test.ts"],
  },
  {
    id: "ssrf-sink-ip",
    control: "SSRF sink-IP guard",
    file: "src/lib/agent/llm/route/ssrf-validate.ts",
    find: "  if (isDangerousSinkIp(normalizedHost)) {",
    replace: "  if (false && isDangerousSinkIp(normalizedHost)) { // MUTATION-15: sink-IP check disabled",
    suites: ["tests/phase15-mutation-controls.test.ts", "tests/llm-ssrf.test.ts"],
  },
  {
    id: "stale-element",
    control: "stale-element guard",
    file: "src/lib/agent/tools/helpers/element-resolver.ts",
    find: "    if (!el.isConnected) {",
    replace: "    if (false && !el.isConnected) { // MUTATION-15: stale-element guard disabled",
    suites: ["tests/phase15-mutation-controls.test.ts", "tests/phase10-stale-element.test.ts"],
  },
  {
    id: "run-phase-transitions",
    control: "run-store status transitions",
    file: "src/lib/agent/loop/run-state-machine.ts",
    find: "  if (!RUN_TRANSITIONS[from].includes(to)) {",
    replace: "  if (false && !RUN_TRANSITIONS[from].includes(to)) { // MUTATION-15: illegal transitions legalized",
    suites: ["tests/phase15-mutation-controls.test.ts", "tests/run-state-machine.test.ts"],
  },
  {
    id: "save-summary-permissions",
    control: "settings save summary",
    file: "src/extension/options/settings-sync-utils.ts",
    find: '  if (typeof data.enableScreenshots === "boolean") {',
    replace: '  if (false && typeof data.enableScreenshots === "boolean") { // MUTATION-15: screenshots line dropped',
    suites: ["tests/phase15-mutation-controls.test.ts", "tests/phase14-no-silent-changes.test.ts"],
  },
];


export function parseOnly(args) {
  const onlyIndex = args.indexOf("--only");
  if (onlyIndex === -1) return null;
  const value = args[onlyIndex + 1];
  if (!value) throw new Error("mutation-check: --only requires a comma-separated id list");
  return new Set(value.split(",").map((id) => id.trim()).filter((id) => id.length > 0));
}

function runVitest(cwd, suites, verbose) {
  const result = spawnSync("npx", ["vitest", "run", "--silent", "--reporter=dot", ...suites], {
    cwd,
    stdio: verbose ? "inherit" : "pipe",
    encoding: "utf8",
  });
  return result.status ?? 1;
}

/**
 * Apply one mutation and verify the suite catches it.
 * Returns `{ caught, status }`.
 */
export function checkOneMutation(mutation, { cwd = ROOT, verbose = false } = {}) {
  const absolute = path.join(cwd, mutation.file);
  const original = readFileSync(absolute, "utf8");
  const occurrences = original.split(mutation.find).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `mutation-check: "${mutation.id}" — find string must match exactly once in ${mutation.file}; found ${occurrences}`,
    );
  }
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "mutation-check-"));
  const backup = path.join(temporaryDirectory, "backup");
  try {
    copyFileSync(absolute, backup);
    const mutated = original.replace(mutation.find, mutation.replace);
    writeFileSync(absolute, mutated, "utf8");
    const status = runVitest(cwd, mutation.suites, verbose);
    // A mutation is "caught" when the suite FAILS under it.
    const caught = status !== 0;
    return { id: mutation.id, control: mutation.control, status, caught };
  } finally {
    // Restore unconditionally — the mutation must never survive this script.
    if (existsSync(backup)) {
      copyFileSync(backup, absolute);
      const restored = readFileSync(absolute, "utf8");
      if (restored !== original) {
        throw new Error(`mutation-check: "${mutation.id}" — failed to restore ${mutation.file} byte-for-byte`);
      }
    }
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function runMutationCheck({ cwd = ROOT, only = null, verbose = false } = {}) {
  const selected = only ? MUTATIONS.filter((m) => only.has(m.id)) : MUTATIONS;
  if (selected.length === 0) throw new Error("mutation-check: --only matched no mutation ids");
  const results = [];
  for (const mutation of selected) {
    const result = checkOneMutation(mutation, { cwd, verbose });
    results.push(result);
    const line = `mutation-check: [${result.id}] ${result.control}: ` +
      (result.caught ? "CAUGHT (suite failed as expected)" : "NOT CAUGHT (suite passed under mutation — GAP)");
    process.stdout.write(`${line}\n`);
  }
  const gaps = results.filter((r) => !r.caught);
  process.stdout.write(
    `mutation-check: ${results.length - gaps.length}/${results.length} mutations caught; every source file restored byte-for-byte.\n`,
  );
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const only = parseOnly(process.argv.slice(2));
    const verbose = process.env.MUTATION_VERBOSE === "1";
    const results = runMutationCheck({ only, verbose });
    if (results.some((r) => !r.caught)) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
