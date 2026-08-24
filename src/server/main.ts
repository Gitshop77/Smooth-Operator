import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import process from "node:process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { createMcpHandler } from "@modelcontextprotocol/server";
import { hostHeaderValidation, localhostHostValidation, localhostOriginValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { loadServerConfig } from "./config";
import { AppError, asAppError, safeErrorDiagnostic } from "./errors";
import { createMcpServer } from "./mcp";
import { redactValue } from "./logger";
import { ServerRuntime } from "./runtime";
import { installHarness, supportedHarnessTargets } from "./installer";
import { SERVER_VERSION } from "./version";
import { homedir } from "node:os";

const INSTALL_USAGE = `Usage: smooth-operator install [harness]   (interactive when no harness is given)
       harness: <${supportedHarnessTargets().join("|")}>
       smooth-operator install --help`;

const HELP = `SmoothOperator MCP server

Usage:
  smooth-operator [--transport stdio|http] [--config path]
  npm start -- [--transport stdio|http] [--config path]
  smooth-operator --version
  smooth-operator install <harness>
  smooth-operator install --help

Environment:
  SMOOTH_OPERATOR_TRANSPORT=stdio|http
  SMOOTH_OPERATOR_BROWSER_MODE=disabled|connect|launch|managed
  SMOOTH_OPERATOR_BROWSER_WS_ENDPOINT=ws://...
  SMOOTH_OPERATOR_BROWSER_URL=http://127.0.0.1:9222
  SMOOTH_OPERATOR_BROWSER_EXECUTABLE=/path/to/chrome
  SMOOTH_OPERATOR_BROWSER_CONNECT_TIMEOUT_MS=30000
  SMOOTH_OPERATOR_BROWSER_CDP_TIMEOUT_MS=30000
  SMOOTH_OPERATOR_ALLOWED_DOMAINS=example.com,*.example.org
  SMOOTH_OPERATOR_ALLOW_EVAL=true (explicit page-JavaScript opt-in)
  SMOOTH_OPERATOR_HTTP_TOKEN=... (required for remote HTTP)
  SMOOTH_OPERATOR_HTTP_MAX_BODY_BYTES=2000000
`;

const MAX_HTTP_CONCURRENCY = 32;
// Bounded pool for long-lived SSE/subscription exchanges.
const MAX_HTTP_STREAM_CONCURRENCY = 8;
const HTTP_SHUTDOWN_GRACE_MS = 5_000;
const HTTP_HANDLER_SHUTDOWN_TIMEOUT_MS = 5_000;
const HTTP_REQUEST_TIMEOUT_MS = 120_000;
const HTTP_HEADERS_TIMEOUT_MS = 15_000;

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args[0] === "install") {
    const yes = args.includes("--yes") || args.includes("--no-interactive");
    const rawTargets = args.slice(1).filter((a) => !a.startsWith("--"));
    let harness = rawTargets[0];
    if (args.includes("--help") || args.includes("-h")) {
      process.stderr.write(`${INSTALL_USAGE}\n`);
      return;
    }
    if (harness === "list") {
      process.stdout.write(`${supportedHarnessTargets().join("\n")}\n`);
      return;
    }
    if (harness && args.filter((a) => !a.startsWith("--") && a !== "install").length > 1) {
      throw new AppError("CONFIG_INVALID", "The install command accepts exactly one harness target.");
    }
    const { isInteractive, promptForHarness, runWizard, persistWizardConfig } = await import("./installer-wizard.js");
    if (!harness && (yes || !isInteractive())) {
      process.stderr.write(`${INSTALL_USAGE}\n`);
      return;
    }
    if (!harness) {
      harness = await promptForHarness({ stdin: process.stdin, stdout: process.stdout });
    }
    if (!harness) {
      throw new AppError("CONFIG_INVALID", "The install command requires a harness target.");
    }
    const wizardChoices = await runWizard(harness, { yes, stdin: process.stdin, stdout: process.stdout, homeDir: homedir(), env: process.env });
    await persistWizardConfig(wizardChoices, homedir());
    process.stdout.write(`${await installHarness(harness)}\n`);
    return;
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    process.stderr.write(HELP);
    return;
  }

  const config = loadServerConfig(args);
  const runtime = await ServerRuntime.create(config);
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = async (reason: string): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        runtime.logger.info("Shutdown requested", { reason });
        await runtime.close();
      })();
    }
    return shutdownPromise;
  };

  if (config.transport === "http") {
    try {
      await serveHttp(runtime, shutdown);
    } catch (error) {
      await shutdown("HTTP_STARTUP_FAILED");
      throw error;
    }
    return;
  }

  const handle = serveStdio(() => createMcpServer(runtime), {
    legacy: "serve",
    onerror: (error) => runtime.logger.error("MCP stdio error", safeErrorDiagnostic(error)),
  });
  let closePromise: Promise<void> | undefined;
  const close = async (reason: string): Promise<void> => {
    if (!closePromise) {
      closePromise = (async () => {
        try {
          await runBoundedShutdownPhase("MCP stdio transport close", () => handle.close(), HTTP_HANDLER_SHUTDOWN_TIMEOUT_MS, runtime);
        } finally {
          process.stdin.removeListener("end", onInputClosed);
          process.stdin.removeListener("close", onInputClosed);
          process.stdin.removeListener("error", onInputClosed);
          process.stdout.removeListener("error", onInputClosed);
          await shutdown(reason);
        }
      })();
    }
    return closePromise;
  };
  process.once("SIGINT", () => {
    observeShutdown(close("SIGINT"), runtime);
  });
  process.once("SIGTERM", () => {
    observeShutdown(close("SIGTERM"), runtime);
  });
  // Ensure runtime shutdown when stdio transport closes.
  const onInputClosed = (): void => {
    observeShutdown(close("STDIO_INPUT_CLOSED"), runtime);
  };
  process.stdin.once("end", onInputClosed);
  process.stdin.once("close", onInputClosed);
  process.stdin.once("error", onInputClosed);
  process.stdout.once("error", onInputClosed);
  runtime.logger.info("MCP stdio server ready");
}

async function serveHttp(runtime: ServerRuntime, shutdown: (reason: string) => Promise<void>): Promise<void> {
  const config = runtime.config;
  const handler = createMcpHandler(() => createMcpServer(runtime), {
    legacy: "stateless",
    responseMode: "auto",
    onerror: (error) => runtime.logger.error("MCP HTTP error", safeErrorDiagnostic(error)),
  });
  const nodeHandler = toNodeHandler(handler, { onerror: (error) => runtime.logger.error("MCP HTTP adapter error", safeErrorDiagnostic(error)) });
  const validateHost = config.http.allowRemote ? hostHeaderValidation(config.http.allowedHosts) : localhostHostValidation();
  const validateOrigin = config.http.allowRemote ? originValidation(config.http.allowedOrigins) : localhostOriginValidation();
  const activeHttpRequests = new Set<Promise<void>>();
  const activeHttpStreams = new Set<Promise<void>>();
  let accepting = true;

  const server = createServer((request, response) => {
    if (!accepting) {
      response.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
      response.end(JSON.stringify({ error: "server_shutting_down" }));
      return;
    }
    if (request.aborted) {
      return;
    }
    if (!validateHost(request, response) || !validateOrigin(request, response)) {
      return;
    }
    if (!requestPathMatches(request, config.http.path)) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (!authorized(request, config.http.token)) {
      response.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let streamPool = isPotentialHttpStream(request) ? activeHttpStreams : activeHttpRequests;
    const poolLimit = streamPool === activeHttpStreams ? MAX_HTTP_STREAM_CONCURRENCY : MAX_HTTP_CONCURRENCY;
    if (streamPool.size >= poolLimit) {
      response.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
      response.end(JSON.stringify({ error: "server_busy" }));
      return;
    }
    const slot: { pending?: Promise<void> } = {};
    const promoteToStream = (): void => {
      if (streamPool === activeHttpStreams) {
        return;
      }
      if (activeHttpStreams.size >= MAX_HTTP_STREAM_CONCURRENCY) {
        throw new AppError("HTTP_STREAM_BUSY", "The HTTP stream capacity is currently full.", { status: 503, retryable: true });
      }
      const pending = slot.pending;
      if (!pending) {
        throw new AppError("HTTP_STREAM_BUSY", "The HTTP stream could not be admitted safely.", { status: 503, retryable: true });
      }
      activeHttpRequests.delete(pending);
      activeHttpStreams.add(pending);
      streamPool = activeHttpStreams;
    };
    const pending = dispatchHttpRequest(request, response, nodeHandler, config.http.maxBodyBytes, promoteToStream);
    slot.pending = pending;
    streamPool.add(pending);
    void pending.catch((error: unknown) => {
      runtime.logger.error("MCP HTTP request failed", safeErrorDiagnostic(error));
      if (!response.headersSent) {
        const normalized = asAppError(error);
        const status = normalized.status >= 400 && normalized.status <= 599 ? normalized.status : 500;
        response.writeHead(status, { "content-type": "application/json" });
      }
      if (!response.writableEnded) {
        const normalized = asAppError(error);
        const status = normalized.status >= 400 && normalized.status <= 599 ? normalized.status : 500;
        const code = status === 413 ? "request_too_large" : status === 499 ? "request_aborted" : status === 503 ? "server_busy" : "internal_error";
        response.end(JSON.stringify({ error: code }));
      }
    }).finally(() => {
      streamPool.delete(pending);
    });
  });
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.http.port, config.http.host, () => {
      server.removeListener("error", reject);
      // Keep logging later server errors instead of crashing on an
      // EventEmitter left without any "error" handler.
      server.on("error", (error: unknown) => runtime.logger.error("MCP HTTP server error", safeErrorDiagnostic(error)));
      runtime.logger.info("MCP HTTP server ready", { host: config.http.host, port: config.http.port, path: config.http.path });
      resolve();
    });
  });

  let closePromise: Promise<void> | undefined;
  const close = async (reason: string): Promise<void> => {
    if (!closePromise) {
      closePromise = (async () => {
        accepting = false;
        try {
          await runBoundedShutdownPhase("MCP HTTP handler close", () => handler.close(), HTTP_HANDLER_SHUTDOWN_TIMEOUT_MS, runtime);
        } finally {
          await waitForHttpRequests(new Set([...activeHttpRequests, ...activeHttpStreams]), HTTP_SHUTDOWN_GRACE_MS);
          server.closeIdleConnections();
          server.closeAllConnections();
          await runBoundedShutdownPhase("MCP HTTP listener close", () => new Promise<void>((resolve) => server.close(() => resolve())), HTTP_HANDLER_SHUTDOWN_TIMEOUT_MS, runtime);
          await shutdown(reason);
        }
    })();
    }
    return closePromise;
  };
  process.once("SIGINT", () => {
    observeShutdown(close("SIGINT"), runtime);
  });
  process.once("SIGTERM", () => {
    observeShutdown(close("SIGTERM"), runtime);
  });
}

async function waitForHttpRequests(requests: Set<Promise<void>>, timeoutMs: number): Promise<void> {
  if (requests.size === 0) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...requests]).then(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer) {
    clearTimeout(timer);
  }
}

function requestPathMatches(request: IncomingMessage, expectedPath: string): boolean {
  try {
    return new URL(request.url ?? "/", "http://localhost").pathname === expectedPath;
  } catch {
    return false;
  }
}

async function dispatchHttpRequest(
  request: IncomingMessage,
  response: import("node:http").ServerResponse,
  nodeHandler: (request: IncomingMessage, response: import("node:http").ServerResponse) => Promise<void>,
  maxBodyBytes: number,
  promoteToStream?: () => void,
): Promise<void> {
  if (request.aborted) {
    throw new AppError("HTTP_REQUEST_ABORTED", "The HTTP client disconnected before the request completed.", { status: 499, retryable: true });
  }
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    // The declared length is already enough to reject this request.  Do not
    // wait for a sender that may trickle an arbitrarily large body before
    // releasing the bounded request slot.  Once the 413 response is flushed,
    // close this invalid request's connection rather than attempting reuse.
    response.once("finish", () => {
      if (!request.complete) {
        request.destroy();
      }
    });
    throw new AppError("HTTP_BODY_TOO_LARGE", `HTTP request body exceeds the ${maxBodyBytes}-byte limit.`, { status: 413 });
  }
  if (!request.method || !["POST", "PUT", "PATCH"].includes(request.method)) {
    await nodeHandler(request, response);
    return;
  }
  const body = await readRequestBody(request, maxBodyBytes);
  if (isSubscriptionRequestBody(body)) {
    promoteToStream?.();
  }
  const replay = Readable.from(body) as unknown as IncomingMessage;
  Object.assign(replay, {
    method: request.method,
    url: request.url,
    headers: request.headers,
    httpVersion: request.httpVersion,
    httpVersionMajor: request.httpVersionMajor,
    httpVersionMinor: request.httpVersionMinor,
  });
  await nodeHandler(replay, response);
}

async function readRequestBody(request: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      if (tooLarge) {
        // Continue draining without retaining additional bytes.  Destroying
        // the socket at the limit can prevent the caller from receiving the
        // intended 413 response for chunked requests.
        continue;
      }
      const nextTotal = total + buffer.byteLength;
      if (nextTotal > maxBodyBytes) {
        tooLarge = true;
        continue;
      }
      total = nextTotal;
      chunks.push(buffer);
    }
  } catch (error) {
    if (tooLarge) {
      throw new AppError("HTTP_BODY_TOO_LARGE", `HTTP request body exceeds the ${maxBodyBytes}-byte limit.`, { status: 413, cause: error });
    }
    if (request.aborted) {
      throw new AppError("HTTP_REQUEST_ABORTED", "The HTTP client disconnected before the request completed.", { status: 499, retryable: true, cause: error });
    }
    throw error;
  }
  if (tooLarge) {
    throw new AppError("HTTP_BODY_TOO_LARGE", `HTTP request body exceeds the ${maxBodyBytes}-byte limit.`, { status: 413 });
  }
  return Buffer.concat(chunks, total);
}

function isPotentialHttpStream(request: IncomingMessage): boolean {
  // POST requests are classified after their bounded body has been read so
  // the normal MCP `Accept: application/json, text/event-stream` header does
  // not make every ordinary request consume the small stream pool.
  return request.method === "GET";
}

function isSubscriptionRequestBody(body: Buffer): boolean {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (Array.isArray(parsed)) {
      return parsed.some((item) => isSubscriptionMessage(item));
    }
    return isSubscriptionMessage(parsed);
  } catch {
    return false;
  }
}

function isSubscriptionMessage(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { method?: unknown }).method === "subscriptions/listen");
}

function authorized(request: IncomingMessage, token: string | undefined): boolean {
  if (!token) {
    return true;
  }
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return false;
  }
  const presented = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

if (isMainModule()) {
  void main().catch((error: unknown) => {
    const normalized = asAppError(error);
    process.stderr.write(`${JSON.stringify(redactValue({ level: "error", message: normalized.message, code: normalized.code }))}\n`);
    process.exitCode = 1;
  });
}

function observeShutdown(promise: Promise<void>, runtime: ServerRuntime): void {
  void promise.then(
    () => {
      process.exitCode = 0;
    },
    (error: unknown) => {
      runtime.logger.error("MCP shutdown failed", safeErrorDiagnostic(error));
      process.exitCode = 1;
    },
  );
}

async function runBoundedShutdownPhase(
  label: string,
  operation: () => Promise<unknown>,
  timeoutMs: number,
  runtime: ServerRuntime,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const task = Promise.resolve()
    .then(operation)
    .then(
      () => "complete" as const,
      (error: unknown) => {
        runtime.logger.warn("MCP shutdown phase failed", { phase: label, ...safeErrorDiagnostic(error) });
        return "failed" as const;
      },
    );
  const timeout = new Promise<"timeout">((resolvePromise) => {
    timer = setTimeout(() => resolvePromise("timeout"), timeoutMs);
  });
  const result = await Promise.race([task, timeout]);
  if (timer) {
    clearTimeout(timer);
  }
  if (result === "timeout") {
    runtime.logger.warn("MCP shutdown phase timed out", { phase: label, timeoutMs });
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }
  try {
    return realpathSync(entrypoint) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
