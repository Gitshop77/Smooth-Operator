import { createConnection } from "node:net";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

const children: ChildProcess[] = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  }));
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("HTTP transport", () => {
  it("enforces auth and origin checks before completing a valid MCP initialize", async () => {
    const port = await freePort();
    const dataDir = await mkdtemp(join(tmpdir(), "smooth-operator-http-"));
    tempDirectories.push(dataDir);
    const token = "smooth-operator-test-http-token";
    const child = spawn(process.execPath, [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "src/server/main.ts", "--transport", "http"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SMOOTH_OPERATOR_BROWSER_MODE: "disabled",
        SMOOTH_OPERATOR_TRANSPORT: "http",
        SMOOTH_OPERATOR_HTTP_HOST: "127.0.0.1",
        SMOOTH_OPERATOR_HTTP_PORT: String(port),
        SMOOTH_OPERATOR_HTTP_TOKEN: token,
        SMOOTH_OPERATOR_HTTP_MAX_BODY_BYTES: "1024",
        SMOOTH_OPERATOR_DATA_DIR: dataDir,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(child);
    const ready = waitForReady(child);
    const endpoint = `http://127.0.0.1:${port}/mcp`;
    await ready;

    const slowUnauthorized = await rawSlowBodyResponse(port, "/mcp", {
      Authorization: "Bearer wrong-token",
      "content-type": "application/json",
    });
    expect(slowUnauthorized.status).toBe(401);
    expect(slowUnauthorized.body).toBe(JSON.stringify({ error: "unauthorized" }));
    expect(slowUnauthorized.closed).toBe(true);

    const slowWrongPath = await rawSlowBodyResponse(port, "/not-mcp", {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    });
    expect(slowWrongPath.status).toBe(404);
    expect(slowWrongPath.body).toBe(JSON.stringify({ error: "not_found" }));
    expect(slowWrongPath.closed).toBe(true);

    const slowPreflight = await rawSlowBodyResponse(port, "/mcp", {
      Origin: "http://localhost",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization, content-type",
    }, "OPTIONS");
    expect(slowPreflight.status).toBe(204);
    expect(slowPreflight.body).toBe("");
    expect(slowPreflight.closed).toBe(true);

    const request = (headers: Record<string, string> = {}, protocolVersion = "2026-07-28") => fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
      signal: AbortSignal.timeout(5_000),
    });
    const initializeBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });

    expect((await request()).status).toBe(401);
    expect((await request({ Authorization: `Bearer ${token}`, Origin: "https://evil.example" })).status).toBe(403);
    const rejectedHost = await rawPostResponse(port, { Host: "user:secret@evil.example", Authorization: `Bearer ${token}` }, initializeBody);
    expect(rejectedHost.status).toBe(403);
    expect(rejectedHost.body).toContain("Host header is not allowed.");
    expect(rejectedHost.body).not.toContain("secret");
    expect(rejectedHost.body).not.toContain("evil.example");
    const rejectedOrigin = await rawPostResponse(port, { Origin: "https://user:secret@evil.example/path", Authorization: `Bearer ${token}` }, initializeBody);
    expect(rejectedOrigin.status).toBe(403);
    expect(rejectedOrigin.body).toContain("Origin header is not allowed.");
    expect(rejectedOrigin.body).not.toContain("secret");
    expect(rejectedOrigin.body).not.toContain("evil.example");
    const preflight = await fetch(endpoint, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type, mcp-protocol-version",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("mcp-protocol-version");
    expect(await rawPost(port, { Host: "evil.example", Authorization: `Bearer ${token}` }, initializeBody)).toBe(403);
    const wrongPath = await fetch(`http://127.0.0.1:${port}/not-mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
    });
    expect(wrongPath.status).toBe(404);
    expect((await request({ Authorization: `Bearer ${token}` }, "2025-06-18")).status).toBe(200);
    const oversized = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: "x".repeat(2_000),
    });
    expect(oversized.status).toBe(413);
    const unsupported = await rawPostResponse(port, { Authorization: `Bearer ${token}`, "content-type": "text/plain" }, initializeBody);
    expect(unsupported.status).toBe(415);
    expect(unsupported.body).toContain("Unsupported Media Type");
    const slowOversized = await rawSlowDeclaredOversizedPost(port, { Authorization: `Bearer ${token}` });
    expect(slowOversized.status).toBe(413);
    // The sender deliberately never finishes its declared body.  A response
    // arriving promptly proves the bounded request slot is released without
    // waiting for a slow or stalled oversized sender.
    expect(slowOversized.elapsedMs).toBeLessThan(1_500);
    const slowUnsupported = await rawSlowDeclaredOversizedPost(port, { Authorization: `Bearer ${token}`, "content-type": "text/plain" });
    expect(slowUnsupported.status).toBe(415);
    expect(slowUnsupported.elapsedMs).toBeLessThan(1_500);
    expect(await rawChunkedPost(port, { Authorization: `Bearer ${token}` }, ["x".repeat(700), "y".repeat(700)])).toBe(413);
    expect(await rawChunkedRequest(port, "DELETE", { Authorization: `Bearer ${token}` }, ["x".repeat(700), "y".repeat(700)])).toBe(413);
    // The bounded reader consumes the Node request before dispatch. Malformed
    // and empty bodies must still be replayed so the adapter preserves its
    // normal parse-error behavior on this uncommon path.
    const malformed = await rawPostResponse(port, { Authorization: `Bearer ${token}` }, "{\"jsonrpc\":\"2.0\",\"id\":7");
    expect(malformed.status).toBe(400);
    expect(malformed.body).toContain("Parse error");
    const empty = await rawPostResponse(port, { Authorization: `Bearer ${token}` }, "");
    expect(empty.status).toBe(400);
    expect(empty.body).toContain("Parse error");
    await rawAbortedPost(port, { Authorization: `Bearer ${token}` });
    const valid = await request({ Authorization: `Bearer ${token}` });
    expect(valid.status).toBe(200);
    expect(valid.headers.get("content-type")).toContain("text/event-stream");
    expect(await valid.text()).toContain('"name":"SmoothOperator"');

    const caseInsensitiveAuth = await request({ authorization: `bearer ${token}`, Origin: "http://localhost" });
    expect(caseInsensitiveAuth.status).toBe(200);
    expect(caseInsensitiveAuth.headers.get("access-control-allow-origin")).toBe("http://localhost");
    await caseInsensitiveAuth.body?.cancel();

    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "http-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe("modern");
      expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(62);
      const health = await client.callTool({ name: "server_health", arguments: {} });
      expect(health.isError).not.toBe(true);
      expect(JSON.stringify(health)).toContain('"status":"ok"');
    } finally {
      await client.close().catch(() => undefined);
    }

    const legacyTransport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const legacyClient = new Client({ name: "http-legacy-test", version: "1.0.0" }, { versionNegotiation: { mode: "legacy" } });
    try {
      await legacyClient.connect(legacyTransport);
      expect(legacyClient.getProtocolEra()).toBe("legacy");
      const legacyHealth = await legacyClient.callTool({ name: "server_health", arguments: {} });
      expect(legacyHealth.isError).not.toBe(true);
      expect(JSON.stringify(legacyHealth)).toContain('"status":"ok"');
    } finally {
      await legacyClient.close().catch(() => undefined);
    }
  }, 30_000);

  it("accepts IPv6-loopback Host/Origin and rejects non-loopback hosts", async () => {
    const port = await freePort();
    const dataDir = await mkdtemp(join(tmpdir(), "smooth-operator-http-v6-"));
    tempDirectories.push(dataDir);
    const token = "smooth-operator-http-v6-token";
    const child = spawn(process.execPath, [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "src/server/main.ts", "--transport", "http"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SMOOTH_OPERATOR_BROWSER_MODE: "disabled",
        SMOOTH_OPERATOR_TRANSPORT: "http",
        // Bind the listener on the IPv6 loopback so the request must reach it
        // over ::1. The localhost allowlist still contains "[::1]".
        SMOOTH_OPERATOR_HTTP_HOST: "::1",
        SMOOTH_OPERATOR_HTTP_PORT: String(port),
        SMOOTH_OPERATOR_HTTP_TOKEN: token,
        SMOOTH_OPERATOR_HTTP_MAX_BODY_BYTES: "1024",
        SMOOTH_OPERATOR_DATA_DIR: dataDir,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(child);
    await waitForReady(child);
    const initializeBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });

    // Per the WHATWG URL spec, new URL("http://[::1]:PORT").hostname === "[::1]"
    // (brackets retained), so the localhost allowlist entry "[::1]" matches.
    const accepted = await rawPostResponseV6(port, { Host: `[::1]:${port}`, Origin: "http://[::1]", Authorization: `Bearer ${token}` }, initializeBody);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toContain('"name":"SmoothOperator"');

    // Credentials embedded in the Host are stripped by URL parsing, leaving a
    // non-loopback hostname that must be rejected.
    const rejectedHost = await rawPostResponseV6(port, { Host: "user:secret@evil.example", Authorization: `Bearer ${token}` }, initializeBody);
    expect(rejectedHost.status).toBe(403);
    expect(rejectedHost.body).toContain("Host header is not allowed.");
    expect(rejectedHost.body).not.toContain("secret");
    expect(rejectedHost.body).not.toContain("evil.example");
    const rejectedOrigin = await rawPostResponseV6(port, { Origin: "https://user:secret@evil.example/path", Authorization: `Bearer ${token}` }, initializeBody);
    expect(rejectedOrigin.status).toBe(403);
    expect(rejectedOrigin.body).toContain("Origin header is not allowed.");
    expect(rejectedOrigin.body).not.toContain("secret");
    expect(rejectedOrigin.body).not.toContain("evil.example");
  }, 30_000);
});

async function freePort(): Promise<number> {
  const server: Server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a test port");
  }
  return address.port;
}

async function rawPost(port: number, headers: Record<string, string>, body: string): Promise<number> {
  return (await rawPostResponse(port, headers, body)).status;
}

async function rawPostResponse(port: number, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "content-length": String(Buffer.byteLength(body)),
        ...headers,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.once("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      response.once("error", reject);
    });
    request.once("error", reject);
    request.end(body);
  });
}

// IPv6-loopback variant of rawPostResponse. The connection target is `::1`
// while the Host/Origin headers are set explicitly (raw http.request, unlike
// fetch, does not derive Host from the URL) so the allowlist "[::1]" path is
// exercised end to end.
async function rawPostResponseV6(port: number, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "::1",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "content-length": String(Buffer.byteLength(body)),
        ...headers,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.once("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      response.once("error", reject);
    });
    request.once("error", reject);
    request.end(body);
  });
}

async function rawChunkedPost(port: number, headers: Record<string, string>, chunks: string[]): Promise<number> {
  return rawChunkedRequest(port, "POST", headers, chunks);
}

async function rawChunkedRequest(port: number, method: string, headers: Record<string, string>, chunks: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/mcp",
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "transfer-encoding": "chunked",
        ...headers,
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
      response.once("error", reject);
    });
    request.once("error", reject);
    for (const chunk of chunks) {
      request.write(chunk);
    }
    request.end();
  });
}

async function rawAbortedPost(port: number, headers: Record<string, string>): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
    });
    const finish = (): void => resolve();
    request.once("close", finish);
    request.once("error", finish);
    request.write("x".repeat(64));
    request.destroy();
  });
}

async function rawSlowBodyResponse(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = "POST",
): Promise<{ status: number; body: string; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    let settled = false;
    let responseStatus = 0;
    let responseBody = "";
    let responseComplete = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(new Error(`Timed out waiting for slow ${method} ${path} response.`));
    }, 2_000);
    const finish = (closed: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ status: responseStatus, body: responseBody, closed });
    };
    socket.once("connect", () => {
      const requestHeaders = {
        Host: `127.0.0.1:${port}`,
        Connection: "keep-alive",
        "Content-Length": "1000000",
        ...headers,
      };
      const serializedHeaders = Object.entries(requestHeaders)
        .map(([name, value]) => `${name}: ${value}`)
        .join("\r\n");
      socket.write(`${method} ${path} HTTP/1.1\r\n${serializedHeaders}\r\n\r\n{`);
    });
    socket.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const rawResponse = Buffer.concat(chunks).toString("utf8");
      const headerEnd = rawResponse.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = rawResponse.slice(0, headerEnd);
      const body = rawResponse.slice(headerEnd + 4);
      const statusLine = header.split("\r\n", 1)[0] ?? "";
      responseStatus = Number(statusLine.split(" ")[1] ?? 0);
      if (/\r\ntransfer-encoding:\s*chunked/i.test(header)) {
        const decoded = decodeChunkedBody(body);
        if (decoded !== undefined) {
          responseBody = decoded;
          responseComplete = true;
        }
      } else {
        responseBody = body;
        const contentLength = Number(header.match(/\r\ncontent-length:\s*(\d+)/i)?.[1] ?? 0);
        responseComplete = responseStatus === 204 || body.length >= contentLength;
      }
    });
    socket.once("close", () => {
      if (!responseComplete) {
        reject(new Error(`Slow ${method} ${path} socket closed before response completed (status=${responseStatus}, bytes=${Buffer.concat(chunks).byteLength}, raw=${JSON.stringify(Buffer.concat(chunks).toString("utf8"))}).`));
        return;
      }
      finish(true);
    });
    socket.once("error", (error) => {
      if (!settled) {
        clearTimeout(timer);
        settled = true;
        reject(error);
      }
    });
  });
}

function decodeChunkedBody(body: string): string | undefined {
  let offset = 0;
  const chunks: string[] = [];
  while (true) {
    const lineEnd = body.indexOf("\r\n", offset);
    if (lineEnd < 0) {
      return undefined;
    }
    const size = Number.parseInt(body.slice(offset, lineEnd).split(";", 1)[0] ?? "", 16);
    if (!Number.isFinite(size) || size < 0) {
      return undefined;
    }
    offset = lineEnd + 2;
    if (body.length < offset + size + 2) {
      return undefined;
    }
    chunks.push(body.slice(offset, offset + size));
    offset += size;
    if (body.slice(offset, offset + 2) !== "\r\n") {
      return undefined;
    }
    offset += 2;
    if (size === 0) {
      return chunks.slice(0, -1).join("");
    }
  }
}

async function rawSlowDeclaredOversizedPost(port: number, headers: Record<string, string>): Promise<{ status: number; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    const timerRef: { value?: ReturnType<typeof setTimeout> } = {};
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        // The configured limit is 1,024 bytes.  Only a tiny prefix is sent;
        // the rest of this declared body remains intentionally unfinished.
        "content-length": "2048",
        ...headers,
      },
    }, (response) => {
      response.resume();
      response.once("end", () => {
        settled = true;
        if (timerRef.value) {
          clearTimeout(timerRef.value);
        }
        resolve({ status: response.statusCode ?? 0, elapsedMs: Date.now() - startedAt });
      });
      response.once("error", (error) => {
        if (!settled) {
          settled = true;
          if (timerRef.value) {
            clearTimeout(timerRef.value);
          }
          reject(error);
        }
      });
    });
    request.once("error", (error) => {
      if (!settled) {
        settled = true;
        if (timerRef.value) {
          clearTimeout(timerRef.value);
        }
        reject(error);
      }
    });
    request.write("x");
    timerRef.value = setTimeout(() => {
      if (!settled) {
        settled = true;
        request.destroy();
        reject(new Error("Timed out waiting for prompt oversized-body response."));
      }
    }, 5_000);
  });
}

async function waitForReady(child: ChildProcess): Promise<void> {
  const stderr = child.stderr;
  if (!stderr) {
    throw new Error("HTTP test process did not expose stderr");
  }
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`HTTP server did not start: ${output}`)), 10_000);
    const onData = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-10_000);
      if (output.includes("MCP HTTP server ready")) {
        clearTimeout(timer);
        stderr.off("data", onData);
        resolve();
      }
    };
    stderr.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      stderr.off("data", onData);
      reject(new Error(`HTTP server exited before start (${code ?? ""}/${signal ?? ""}): ${output}`));
    });
  });
}
