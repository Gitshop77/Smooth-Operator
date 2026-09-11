import { homedir } from "node:os";

import { loadServerConfig } from "./config";
import { asAppError } from "./errors";
import { supportedHarnessTargets } from "./installer";
import { redactValue } from "./logger";
import { ServerRuntime } from "./runtime";
import { SERVER_VERSION } from "./version";

export const INSTALL_USAGE = `Usage: smooth-operator install [harness]   (interactive when no harness is given)
       harness: <${supportedHarnessTargets().join("|")}>
       smooth-operator install --yes
       smooth-operator install --help`;

export const HELP = `SmoothOperator MCP server

Usage:
  smooth-operator [server] [--transport stdio|http] [--config path] [--host host] [--port port]
  smooth-operator install [harness] --yes
  smooth-operator doctor [--config path]
  smooth-operator --version
  smooth-operator --help

Commands:
  server               Start the MCP server (default when no command is given)
  install [harness]    Install into a harness; --yes applies recommended defaults
  doctor               Print executable, profile, and endpoint diagnostics

Options:
  --transport stdio|http  Select the MCP transport (default: stdio)
  --config path           Load an explicit JSON configuration file
  --host host             HTTP bind host (default: 127.0.0.1)
  --port port             HTTP bind port (default: 3344)

Environment:
  SMOOTH_OPERATOR_TRANSPORT=stdio|http
  SMOOTH_OPERATOR_BROWSER_MODE=disabled|connect|launch|managed
  SMOOTH_OPERATOR_BROWSER_WS_ENDPOINT=ws://...
  SMOOTH_OPERATOR_BROWSER_URL=http://127.0.0.1:9222
  SMOOTH_OPERATOR_BROWSER_EXECUTABLE=/path/to/chrome
  SMOOTH_OPERATOR_BROWSER_VIEWPORT_WIDTH=1280 and SMOOTH_OPERATOR_BROWSER_VIEWPORT_HEIGHT=720
  SMOOTH_OPERATOR_BROWSER_CONNECT_TIMEOUT_MS=30000
  SMOOTH_OPERATOR_BROWSER_CDP_TIMEOUT_MS=30000
  SMOOTH_OPERATOR_ALLOWED_DOMAINS=example.com,*.example.org
  SMOOTH_OPERATOR_ALLOW_EVAL=true (default; set false to disable page JavaScript)
  SMOOTH_OPERATOR_HTTP_TOKEN=... (required for remote HTTP)
  SMOOTH_OPERATOR_HTTP_MAX_BODY_BYTES=2000000
`;

export function commandName(args: readonly string[]): "install" | "doctor" | "server" | "help" | "version" {
  if (args[0] === "install") {
    return "install";
  }
  if (args[0] === "doctor") {
    return "doctor";
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
    return "version";
  }
  if (args.includes("--help") || args.includes("-h")) {
    return "help";
  }
  return "server";
}

export function serverArgs(args: readonly string[]): string[] {
  return args[0] === "server" ? [...args.slice(1)] : [...args];
}

export function printVersion(stdout: NodeJS.WritableStream = process.stdout): void {
  stdout.write(`${SERVER_VERSION}\n`);
}

export function printHelp(stderr: NodeJS.WritableStream = process.stderr): void {
  stderr.write(HELP);
}

/** Load config, probe executable/profile/endpoint, print diagnostics, shut down. */
export async function runDoctor(args: readonly string[] = [], io: { stdout?: NodeJS.WritableStream } = {}): Promise<void> {
  const stdout = io.stdout ?? process.stdout;
  const config = loadServerConfig(serverArgs(args.filter((argument) => argument !== "doctor")));
  const runtime = await ServerRuntime.create(config);
  try {
    const health = runtime.health();
    const doctor = await runtime.browserDoctor();
    const payload = redactValue({
      command: "doctor",
      version: SERVER_VERSION,
      home: homedir(),
      status: health.status,
      ready: health.ready,
      transport: health.transport,
      checks: health.checks,
      doctor,
    });
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } finally {
    await runtime.close();
  }
}

export function writeCliError(error: unknown, stderr: NodeJS.WritableStream = process.stderr): void {
  const normalized = asAppError(error);
  stderr.write(`${JSON.stringify(redactValue({ level: "error", message: normalized.message, code: normalized.code }))}\n`);
}
