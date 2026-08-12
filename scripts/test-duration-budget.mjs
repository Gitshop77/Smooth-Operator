#!/usr/bin/env node

/**
 * Full-suite test-duration budget (Phase 15).
 *
 * Runs the complete vitest suite once and FAILS the build when the wall-clock
 * duration exceeds the budget. This is a cumulative-regression gate: a single
 * test already has `testTimeout: 30_000` in vitest.config.ts, but many new
 * slow tests (or a slowdown in setup/import) can each stay under that limit
 * while silently tripling the full-suite time. `npm run test:budget` catches
 * that class of regression.
 *
 * Budget default: 180_000 ms (3 minutes). The measured baseline on the
 * development host is ~46 s; GitHub-hosted runners are typically ~2x slower,
 * so 3 minutes keeps the gate green on CI while still failing on a 3-4x
 * cumulative regression. Override with `TEST_DURATION_BUDGET_MS` for
 * experiments.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BUDGET_MS = 180_000;

/** Pure budget check — exported for focused tests. */
export function isWithinBudget(elapsedMs, budgetMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new Error(`elapsedMs must be a non-negative finite number; got ${elapsedMs}`);
  }
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new Error(`budgetMs must be a positive finite number; got ${budgetMs}`);
  }
  return elapsedMs <= budgetMs;
}

/** Human-readable elapsed time. */
export function formatElapsed(elapsedMs) {
  const seconds = (elapsedMs / 1000).toFixed(1);
  return `${seconds}s`;
}

export function parseBudget(args = process.argv.slice(2)) {
  if (args.length === 0) return DEFAULT_BUDGET_MS;
  const value = Number(args[0]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`test-duration-budget: invalid budget "${args[0]}" — pass a positive millisecond value or nothing`);
  }
  return value;
}

/** Run the full vitest suite and report pass/fail against the budget. */
export function runBudgetCheck({ budgetMs = DEFAULT_BUDGET_MS, cwd = ROOT } = {}) {
  const startedAt = Date.now();
  execFileSync("npx", ["vitest", "run"], { cwd, stdio: "inherit" });
  const elapsedMs = Date.now() - startedAt;
  const within = isWithinBudget(elapsedMs, budgetMs);
  const line = `test-duration-budget: full suite finished in ${formatElapsed(elapsedMs)} (budget ${formatElapsed(budgetMs)}) — ${within ? "WITHIN BUDGET" : "BUDGET EXCEEDED"}`;
  process.stdout.write(`\n${line}\n`);
  return { elapsedMs, budgetMs, within, line };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const budgetMs = Number(process.env.TEST_DURATION_BUDGET_MS ?? "") || parseBudget();
    const { within } = runBudgetCheck({ budgetMs });
    if (!within) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
