#!/usr/bin/env node
/**
 * Open Cowork — Lightpanda native messaging host.
 *
 * Chrome native messaging protocol: 4-byte little-endian length prefix +
 * UTF-8 JSON on stdin/stdout.
 *
 * Inbound (from the extension service worker):
 *   { id, type: "ping" }
 *   { id, type: "agent", binary?: string, args: string[], env: Record<string,string>, timeoutMs: number }
 *   { id, type: "cancel" }
 * Outbound:
 *   { id, type: "pong" }
 *   { id, type: "chunk", channel: "stdout"|"stderr", data: string }
 *   { id, type: "done", exitCode: number|null, timeout?: true }
 *   { id, type: "cancelled" }
 *   { id, type: "error", message: string }
 *
 * Invariant: exactly ONE terminal message per run (done OR cancelled). Cancel
 * marks the run finished BEFORE killing, so the child's later "close" event
 * cannot emit a trailing done. All kills are SIGKILL: lightpanda agent mode
 * ignores SIGTERM (no_hard_exit).
 *
 * Usage: node lightpanda-native-host.mjs [default-binary-path]
 * The default binary is baked into the LAUNCHER by
 * scripts/setup-lightpanda-host.mjs. Chrome native host manifests support NO
 * "args" field, so the manifest "path" points at the launcher, which execs
 * `node <this script> <binaryPath>`.
 */

import { spawn } from "node:child_process";
import process from "node:process";

// The ONLY environment keys ever passed to the child. Whitelisted so a
// corrupted/compromised extension can't exfiltrate arbitrary env values
// (e.g. HOME, SSH keys) into the child process's argv/stdio.
const ALLOWED_ENV = new Set([
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "VERTEX_API_KEY", "HF_TOKEN",
  "AI_GATEWAY_API_KEY", "MISTRAL_API_KEY", "BRAVE_API_KEY", "TAVILY_API_KEY",
  "LIGHTPANDA_DISABLE_TELEMETRY",
]);

const MAX_MESSAGE_BYTES = 1 << 20;
const MAX_ARGV_LEN = 64;
const MAX_ARG_CHARS = 64 * 1024;
const MAX_ENV_VALUE_CHARS = 4096;
const DEFAULT_BINARY = process.argv[2] || "lightpanda";

let stdoutOpen = true;
let input = Buffer.alloc(0);
let currentRun = null; // { id, child, timer, finished }

function send(obj) {
  if (!stdoutOpen) return;
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const frame = Buffer.alloc(4);
  frame.writeUInt32LE(json.length, 0);
  try {
    process.stdout.write(Buffer.concat([frame, json]));
  } catch {
    stdoutOpen = false;
  }
}

function stopChild() {
  if (!currentRun) return;
  if (currentRun.timer) { clearTimeout(currentRun.timer); currentRun.timer = null; }
  const c = currentRun.child;
  // SIGKILL: lightpanda agent mode ignores SIGTERM.
  if (c && c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
}

function handleMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  const id = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;
  switch (msg.type) {
    case "ping":
      send({ id, type: "pong" });
      break;
    case "cancel":
      if (currentRun) {
        currentRun.finished = true;
        stopChild();
        currentRun = null;
      }
      send({ id, type: "cancelled" });
      break;
    case "agent":
      handleAgent(msg, id);
      break;
    default:
      send({ id, type: "error", message: `unknown message type: ${String(msg.type)}` });
  }
}

function handleAgent(msg, id) {
  if (currentRun) {
    send({ id, type: "error", message: "busy: another lightpanda process is running" });
    return;
  }
  const args = msg.args;
  if (!Array.isArray(args) || args.length === 0 || args.length > MAX_ARGV_LEN ||
      args.some((a) => typeof a !== "string" || a.length > MAX_ARG_CHARS)) {
    send({ id, type: "error", message: "invalid args" });
    return;
  }
  const binary = typeof msg.binary === "string" && msg.binary.length > 0 && msg.binary.length <= 2048
    ? msg.binary
    : DEFAULT_BINARY;
  if (!binary || binary.includes("\u0000")) {
    send({ id, type: "error", message: "invalid binary path" });
    return;
  }
  const env = {};
  for (const [key, value] of Object.entries(msg.env || {})) {
    if (ALLOWED_ENV.has(key) && typeof value === "string" && value.length <= MAX_ENV_VALUE_CHARS) {
      env[key] = value;
    }
  }
  const timeoutMs = Number.isFinite(msg.timeoutMs) ? Math.max(1000, msg.timeoutMs) : 120000;
  const run = { id, child: null, timer: null, finished: false };
  const finish = (payload) => {
    if (run.finished) return;
    run.finished = true;
    stopChild();
    send({ id, ...payload });
  };
  // SCRUBBED base env: never spread process.env into the child (ambient
  // GOOGLE_API_KEY / OPENAI_BASE_URL / SSH keys must not bleed through).
  const baseEnv = { HOME: process.env.HOME || "", PATH: process.env.PATH || "", ...env };
  run.child = spawn(binary, args, { env: baseEnv, stdio: ["ignore", "pipe", "pipe"] });
  currentRun = run;
  for (const channel of ["stdout", "stderr"]) {
    run.child[channel].on("data", (buf) => {
      if (!run.finished) send({ id, type: "chunk", channel, data: buf.toString("utf8") });
    });
  }
  run.child.on("error", (err) => finish({ type: "error", message: `failed to spawn ${binary}: ${err.message}` }));
  run.child.on("close", (code) => finish({ type: "done", exitCode: code }));
  run.timer = setTimeout(() => {
    run.timer = null;
    if (run.finished) return;
    run.finished = true;
    currentRun = null;
    if (run.child && run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
    send({ id, type: "done", exitCode: null, timeout: true });
  }, timeoutMs);
}

function onData(chunk) {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const len = input.readUInt32LE(0);
    if (len > MAX_MESSAGE_BYTES) process.exit(1);
    if (input.length < 4 + len) break;
    const body = input.subarray(4, 4 + len).toString("utf8");
    input = input.subarray(4 + len);
    try {
      handleMessage(JSON.parse(body));
    } catch (e) {
      send({ id: null, type: "error", message: `invalid JSON: ${e.message}` });
    }
  }
}

process.stdin.on("data", onData);
process.stdin.on("end", () => { stopChild(); stdoutOpen = false; process.exit(0); });
process.stdin.on("error", () => { stopChild(); stdoutOpen = false; process.exit(1); });
