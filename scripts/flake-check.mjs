#!/usr/bin/env node

/**
 * Flake hardening.
 *
 * Runs the flake-prone suites (timers, async races, chrome-mock interactions)
 * ROUNDS times — default 3 — with vitest's `--retry=2` (a failed test is
 * retried twice within the round; only a triply-failing test counts against
 * the round). Any failing round fails the gate, so a flake that reproduces
 * more than a couple of times in a row cannot ship green.
 *
 * The file list is the product of the concurrency/timer/chrome-mock suites
 * that have historically been the most timing-sensitive (task queue, abort
 * signals, state store, run-event fan-out, watchdog timers, transport
 * streaming, mutex, direct-LLM races, tab-manager timeouts, takeover resume).
 *
 * Overrides: `FLAKE_ROUNDS` (default 3), `FLAKE_ONLY="a.test.ts b.test.ts"`
 * to run a custom subset.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const FLAKE_PRONE_FILES = [
  "tests/task-queue.test.ts",
  "tests/abort-signal-queue.test.ts",
  "tests/state-store.test.ts",
  "tests/state-store-abort.test.ts",
  "tests/run-event-service.test.ts",
  "tests/run-event-broadcast.test.ts",
  "tests/scheduled-tasks.test.ts",
  "tests/scheduled-tasks-arming.test.ts",
  "tests/sw-watchdog.test.ts",
  "tests/memory-watchdog.test.ts",
  "tests/sw-startup-keepalive.test.ts",
  "tests/stream-stall-retry.test.ts",
  "tests/transport-http.test.ts",
  "tests/mutex.test.ts",
  "tests/llm-direct.test.ts",
  "tests/llm-direct-race.test.ts",
  "tests/tab-manager-handle-tab-action.test.ts",
  "tests/tab-manager-send-timeout.test.ts",
  "tests/takeover.test.ts",
  "tests/retry.test.ts",
  "tests/judge-retry.test.ts",
];

export function parseRounds(args = process.argv.slice(2)) {
  if (args.length === 0) return 3;
  const value = Number(args[0]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`flake-check: invalid round count "${args[0]}" — pass a positive integer or nothing`);
  }
  return value;
}

/** Run one round over the flake-prone files with `--retry=2`. */
export function runRound(files, { cwd = ROOT, retries = 2 } = {}) {
  const args = ["vitest", "run", ...files, "--retry", String(retries)];
  const result = spawnSync("npx", args, { cwd, stdio: "inherit", encoding: "utf8" });
  return { status: result.status ?? 1 };
}

/** Summary line per round — exported for tests. */
export function formatRound(round, total, status, elapsedMs) {
  const ok = status === 0;
  return `flake-check round ${round}/${total}: ${ok ? "PASS" : "FAIL"} (${formatElapsed(elapsedMs)})`;
}

function formatElapsed(elapsedMs) {
  return `${(elapsedMs / 1000).toFixed(1)}s`;
}

export function runFlakeCheck({ rounds = 3, cwd = ROOT } = {}) {
  const files = process.env.FLAKE_ONLY
    ? process.env.FLAKE_ONLY.split(/\s+/).filter((f) => f.length > 0)
    : FLAKE_PRONE_FILES;
  if (files.length === 0) throw new Error("flake-check: no test files to run");
  const results = [];
  for (let round = 1; round <= rounds; round += 1) {
    const startedAt = Date.now();
    const { status } = runRound(files, { cwd });
    const elapsedMs = Date.now() - startedAt;
    const line = formatRound(round, rounds, status, elapsedMs);
    results.push({ round, status, elapsedMs, line });
    process.stdout.write(`${line}\n`);
  }
  const failed = results.filter((r) => r.status !== 0);
  if (failed.length > 0) {
    process.stdout.write(
      `flake-check: ${failed.length}/${rounds} round(s) FAILED across ${files.length} flake-prone file(s). ` +
        `A triply-failing test in any round is a real flake and must be fixed, not retried away.\n`,
    );
  } else {
    process.stdout.write(
      `flake-check: ${rounds}/${rounds} rounds PASSED across ${files.length} flake-prone file(s) with --retry=2. No persistent flake reproduced.\n`,
    );
  }
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const rounds = Number(process.env.FLAKE_ROUNDS ?? "") || parseRounds();
    const results = runFlakeCheck({ rounds });
    if (results.some((r) => r.status !== 0)) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

