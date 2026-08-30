import { createServer, type IncomingMessage } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import process from "node:process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { createMcpHandler, isJsonContentType as sdkIsJsonContentType } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { loadServerConfig } from "./config";
import { AppError, asAppError, safeErrorDiagnostic } from "./errors";
import { createMcpServer } from "./mcp";
import { redactValue } from "./logger";
import { ServerRuntime } from "./runtime";
import { installHarness, planHarnessInstall, supportedHarnessTargets } from "./installer";
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
  SMOOTH_OPERATOR_BROWSER_VIEWPORT_WIDTH=1280 and SMOOTH_OPERATOR_BROWSER_VIEWPORT_HEIGHT=720
  SMOOTH_OPERATOR_BROWSER_CONNECT_TIMEOUT_MS=30000
  SMOOTH_OPERATOR_BROWSER_CDP_TIMEOUT_MS=30000
  SMOOTH_OPERATOR_ALLOWED_DOMAINS=example.com,*.example.org
  SMOOTH_OPERATOR_ALLOW_EVAL=true (default; set false to disable page JavaScript)
  SMOOTH_OPERATOR_HTTP_TOKEN=... (required for remote HTTP)
  SMOOTH_OPERATOR_HTTP_MAX_BODY_BYTES=2000000
`;

// Hard caps on concurrent in-flight requests. They are constants rather than
// environment settings so the bounds stay fixed.
const MAX_HTTP_CONCURRENCY = 32;
// Bounded pool for long-lived SSE/subscription exchanges (fewer, longer
// connections), distinct from the ordinary request pool above.
const MAX_HTTP_STREAM_CONCURRENCY = 8;
const HTTP_SHUTDOWN_GRACE_MS = 5_000;
const HTTP_HANDLER_SHUTDOWN_TIMEOUT_MS = 5_000;
const HTTP_REQUEST_TIMEOUT_MS = 120_000;
const HTTP_HEADERS_TIMEOUT_MS = 15_000;
const HTTP_BODY_READ_TIMEOUT_MS = 30_000;
const LOCALHOST_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"] as const;
const AUTHORIZATION_PATTERN = /^Bearer[ \t]+(.+)$/i;
const HTTP_NOT_FOUND_BODY = JSON.stringify({ error: "not_found" });
const HTTP_SHUTTING_DOWN_BODY = JSON.stringify({ error: "server_shutting_down" });
const HTTP_BUSY_BODY = JSON.stringify({ error: "server_busy" });
const HTTP_UNAUTHORIZED_BODY = JSON.stringify({ error: "unauthorized" });
const HTTP_UNSUPPORTED_MEDIA_BODY = JSON.stringify({
  jsonrpc: "2.0",
  error: { code: -32_000, message: "Unsupported Media Type: Content-Type must be application/json" },
});

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
    // Validate the target before touching any configuration so an unknown
    // name cannot leave a half-applied install behind.
    planHarnessInstall(harness, { homeDirectory: homedir(), environment: process.env });
    const wizardChoices = await runWizard(harness, { yes, stdin: process.stdin, stdout: process.stdout, homeDir: homedir(), env: process.env, version: SERVER_VERSION });
    await persistWizardConfig(wizardChoices, homedir());
    const installMessage = await installHarness(harness);
    const { createUi } = await import("./ui");
    const ui = createUi(process.stdout);
    if (process.stdout.isTTY) {
      ui.banner("Installation Complete", `${harness} can now drive a browser`, SERVER_VERSION);
      ui.keyValues([
        ["Config file", `${homedir()}/.smooth-operator/config.json`],
        ["Browser mode", wizardChoices.mode],
      ]);
      process.stdout.write("\n");
      ui.step(0, 2, "Next steps");
      ui.option(1, "Restart the harness", "Quit and reopen it so it picks up the new MCP server.");
      ui.option(2, "Verify", "Ask your AI to run server_health and browser_doctor.");
      ui.success(installMessage);
    } else {
      process.stdout.write(`${installMessage}\n`);
    }
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

  let handle: ReturnType<typeof serveStdio>;
  try {
    handle = serveStdio(() => createMcpServer(runtime), {
      legacy: "serve",
      onerror: (error) => runtime.logger.error("MCP stdio error", safeErrorDiagnostic(error)),
    });
  } catch (error) {
    await shutdown("STDIO_STARTUP_FAILED");
    throw error;
  }
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
  const allowedHostnames = new Set(config.http.allowRemote ? config.http.allowedHosts : LOCALHOST_HOSTNAMES);
  const allowedOriginHostnames = new Set(config.http.allowRemote ? config.http.allowedOrigins : LOCALHOST_HOSTNAMES);
  // The configured token is immutable for the lifetime of this listener.
  // Hash it once instead of re-hashing it for every authenticated request.
  const expectedAuthDigest = config.http.token ? authDigest(config.http.token) : undefined;
  const activeHttpRequests = new Set<Promise<void>>();
  const activeHttpStreams = new Set<Promise<void>>();
  let accepting = true;

  const server = createServer((request, response) => {
    response.on("error", (error: unknown) => runtime.logger.error("MCP HTTP response error", safeErrorDiagnostic(error)));
    request.on("error", (error: unknown) => runtime.logger.error("MCP HTTP request error", safeErrorDiagnostic(error)));
    if (!accepting) {
      closeIncompleteRequestAfterResponse(request, response);
      response.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
      response.end(HTTP_SHUTTING_DOWN_BODY);
      return;
    }
    if (request.aborted) {
      return;
    }
    if (!validateRequestHost(request, response, allowedHostnames) || !validateRequestOrigin(request, response, allowedOriginHostnames)) {
      return;
    }
    setCorsHeaders(request, response);
    if (!requestPathMatches(request, config.http.path)) {
      closeIncompleteRequestAfterResponse(request, response);
      response.writeHead(404, { "content-type": "application/json" });
      response.end(HTTP_NOT_FOUND_BODY);
      return;
    }
    if (request.method === "OPTIONS") {
      closeIncompleteRequestAfterResponse(request, response);
      response.writeHead(204, {
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": request.headers["access-control-request-headers"] ?? "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id",
        "access-control-expose-headers": "Mcp-Session-Id, WWW-Authenticate",
        "access-control-max-age": "600",
      });
      response.end();
      return;
    }
    if (!authorized(request, expectedAuthDigest)) {
      closeIncompleteRequestAfterResponse(request, response);
      response.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      response.end(HTTP_UNAUTHORIZED_BODY);
      return;
    }
    let streamPool = isPotentialHttpStream(request) ? activeHttpStreams : activeHttpRequests;
    const poolLimit = streamPool === activeHttpStreams ? MAX_HTTP_STREAM_CONCURRENCY : MAX_HTTP_CONCURRENCY;
    if (streamPool.size >= poolLimit) {
      closeIncompleteRequestAfterResponse(request, response);
      response.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
      response.end(HTTP_BUSY_BODY);
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
      try {
        // A disconnected client can make the adapter reject after it has
        // already torn down the response. Error reporting must not attempt a
        // second write and turn a handled request failure into an uncaught
        // ServerResponse exception.
        if (response.destroyed || response.writableEnded) {
          return;
        }
        if (response.headersSent) {
          // A handler that already started a response cannot be given a
          // second stable JSON body. Closing the connection avoids appending
          // an error object to a partially streamed MCP response.
          response.destroy();
          return;
        }
        const normalized = asAppError(error);
        const status = normalized.status >= 400 && normalized.status <= 599 ? normalized.status : 500;
        if (status === 408 || status === 413 || status === 499) {
          response.setHeader("connection", "close");
          closeIncompleteRequestAfterResponse(request, response);
        }
        response.writeHead(status, { "content-type": "application/json" });
        if (response.writableEnded || response.destroyed) {
          return;
        }
        const code = status === 408 ? "request_timeout" : status === 413 ? "request_too_large" : status === 499 ? "request_aborted" : status === 503 ? "server_busy" : "internal_error";
        response.end(JSON.stringify({ error: code }));
      } catch (responseError) {
        runtime.logger.error("MCP HTTP error response failed", safeErrorDiagnostic(responseError));
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

function validateRequestHost(request: IncomingMessage, response: import("node:http").ServerResponse, allowedHostnames: ReadonlySet<string>): boolean {
  const rawHost = request.headers.host;
  if (typeof rawHost !== "string" || !rawHost || rawHost.length > 255 || /[\u0000-\u0020/?#@]/.test(rawHost)) {
    return rejectHttpHeader(request, response, "Host header is not allowed.");
  }
  try {
    const parsed = new URL(`http://${rawHost}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || !allowedHostnames.has(parsed.hostname)) {
      return rejectHttpHeader(request, response, "Host header is not allowed.");
    }
  } catch {
    return rejectHttpHeader(request, response, "Host header is not allowed.");
  }
  return true;
}

function validateRequestOrigin(request: IncomingMessage, response: import("node:http").ServerResponse, allowedOriginHostnames: ReadonlySet<string>): boolean {
  const rawOrigin = request.headers.origin;
  if (rawOrigin === undefined || rawOrigin === "") {
    return true;
  }
  if (typeof rawOrigin !== "string" || rawOrigin.length > 2_048 || /[\u0000-\u0020\u007f]/.test(rawOrigin)) {
    return rejectHttpHeader(request, response, "Origin header is not allowed.");
  }
  try {
    const parsed = new URL(rawOrigin);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || !allowedOriginHostnames.has(parsed.hostname)) {
      return rejectHttpHeader(request, response, "Origin header is not allowed.");
    }
  } catch {
    return rejectHttpHeader(request, response, "Origin header is not allowed.");
  }
  return true;
}

function rejectHttpHeader(request: IncomingMessage, response: import("node:http").ServerResponse, message: string): false {
  response.setHeader("connection", "close");
  closeIncompleteRequestAfterResponse(request, response);
  response.writeHead(403, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32_000, message }, id: null }));
  return false;
}

function setCorsHeaders(request: IncomingMessage, response: import("node:http").ServerResponse): void {
  const origin = request.headers.origin;
  if (!origin || Array.isArray(origin)) {
    return;
  }
  // Origin has already passed the configured host allowlist. Echoing the
  // validated value keeps browser-based MCP hosts compatible without ever
  // widening the allowlist to `*`.
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "Origin");
}

function closeIncompleteRequestAfterResponse(request: IncomingMessage, response: import("node:http").ServerResponse): void {
  const closeRequest = (): void => {
    if (!request.complete) {
      request.destroy();
    }
  };
  response.once("finish", closeRequest);
}

async function dispatchHttpRequest(
  request: IncomingMessage,
  response: import("node:http").ServerResponse,
  nodeHandler: (request: IncomingMessage, response: import("node:http").ServerResponse, parsedBody?: unknown) => Promise<void>,
  maxBodyBytes: number,
  promoteToStream?: () => void,
): Promise<void> {
  if (request.aborted) {
    throw new AppError("HTTP_REQUEST_ABORTED", "The HTTP client disconnected before the request completed.", { status: 499, retryable: true });
  }
  // The MCP adapter rejects non-JSON POSTs before it reads or parses their
  // body. Mirror that gate here so a slow or oversized unsupported request
  // cannot occupy a bounded request slot until the body timeout expires.
  const contentType = request.headers["content-type"];
  if (request.method?.toUpperCase() === "POST" && (typeof contentType !== "string" || !sdkIsJsonContentType(contentType))) {
    response.setHeader("connection", "close");
    closeIncompleteRequestAfterResponse(request, response);
    response.writeHead(415, { "content-type": "application/json" });
    response.end(HTTP_UNSUPPORTED_MEDIA_BODY);
    return;
  }
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    // The declared length is already enough to reject this request.  Do not
    // wait for a sender that may trickle an arbitrarily large body before
    // releasing the bounded request slot.  Once the 413 response is flushed,
    // close this invalid request's connection rather than attempting reuse.
    closeIncompleteRequestAfterResponse(request, response);
    throw new AppError("HTTP_BODY_TOO_LARGE", `HTTP request body exceeds the ${maxBodyBytes}-byte limit.`, { status: 413 });
  }
  const method = request.method?.toUpperCase();
  const hasDeclaredBody = contentLength > 0 || request.headers["transfer-encoding"] !== undefined;
  if ((method === "GET" || method === "HEAD") && !hasDeclaredBody) {
    await nodeHandler(request, response);
    return;
  }
  const body = await readRequestBody(request, maxBodyBytes, HTTP_BODY_READ_TIMEOUT_MS);
  const parsedBody = parseRequestBody(body);
  if (parsedBody !== undefined && isSubscriptionRequestBody(parsedBody)) {
    promoteToStream?.();
  }
  // Pass the parsed body through the adapter's documented fast path. This
  // avoids replaying the buffered request through a second stream and avoids
  // another UTF-8 decode/JSON parse inside createMcpHandler. Invalid or empty
  // bodies retain the replay path so the adapter emits its normal parse
  // errors and legacy routing behavior.
  if (parsedBody !== undefined) {
    await nodeHandler(request, response, parsedBody);
    return;
  }
  // The original request stream has already been consumed by the bounded
  // reader. Recreate it only for malformed/empty bodies, preserving the
  // adapter's parse-error and legacy-routing behavior without paying this
  // replay cost on valid MCP traffic.
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

function parseRequestBody(body: Buffer): unknown | undefined {
  if (body.byteLength === 0) {
    return undefined;
  }
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function readRequestBody(request: IncomingMessage, maxBodyBytes: number, timeoutMs: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let discardChunks = false;
  let bodyPromise: Promise<Buffer> | undefined;
  const read = async (): Promise<Buffer> => {
    for await (const chunk of request) {
      if (discardChunks) {
        continue;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      const nextTotal = total + buffer.byteLength;
      if (nextTotal > maxBodyBytes) {
        throw new AppError("HTTP_BODY_TOO_LARGE", `HTTP request body exceeds the ${maxBodyBytes}-byte limit.`, { status: 413 });
      }
      total = nextTotal;
      chunks.push(buffer);
    }
    // Most MCP requests fit in one incoming chunk. Returning it directly
    // avoids an extra full-body copy while retaining the same bounded buffer
    // accounting for multi-chunk requests.
    if (chunks.length === 0) {
      return Buffer.alloc(0);
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
  };
  try {
    bodyPromise = read();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new AppError("HTTP_BODY_TIMEOUT", "The HTTP request body took too long to arrive.", { status: 408, retryable: true }));
      }, timeoutMs);
    });
    return await Promise.race([bodyPromise, timeout]);
  } catch (error) {
    discardChunks = true;
    bodyPromise?.catch(() => undefined);
    if (timedOut) {
      request.pause();
      throw error;
    }
    if (error instanceof AppError && (error.code === "HTTP_BODY_TOO_LARGE" || error.code === "HTTP_BODY_TIMEOUT")) {
      throw error;
    }
    if (request.aborted) {
      throw new AppError("HTTP_REQUEST_ABORTED", "The HTTP client disconnected before the request completed.", { status: 499, retryable: true, cause: error });
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function isPotentialHttpStream(request: IncomingMessage): boolean {
  // POST requests are classified after their bounded body has been read so
  // the normal MCP `Accept: application/json, text/event-stream` header does
  // not make every ordinary request consume the small stream pool.
  return request.method === "GET";
}

function isSubscriptionRequestBody(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some((item) => isSubscriptionMessage(item));
  }
  return isSubscriptionMessage(body);
}

function isSubscriptionMessage(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { method?: unknown }).method === "subscriptions/listen");
}

function authDigest(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function authorized(request: IncomingMessage, expectedDigest: Buffer | undefined): boolean {
  if (!expectedDigest) {
    return true;
  }
  const header = request.headers.authorization;
  if (typeof header !== "string") {
    return false;
  }
  const match = AUTHORIZATION_PATTERN.exec(header);
  if (!match) {
    return false;
  }
  const presentedDigest = authDigest(match[1]);
  return presentedDigest.length === expectedDigest.length && timingSafeEqual(presentedDigest, expectedDigest);
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
