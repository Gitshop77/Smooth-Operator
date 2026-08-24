import { createServer } from "node:http";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ITERATIONS = 10;
const TEXT_ENCODER = new TextEncoder();
const TSX_ENTRY = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SOURCE_SERVER_ENTRY = join(ROOT, "src", "server", "main.ts");
const DIST_SERVER_ENTRY = join(ROOT, "dist", "smooth-operator.mjs");
const FIXTURE_HTML = `<!doctype html><html><head><title>SmoothOperator benchmark fixture</title></head><body><main id="benchmark-fixture"><h1>Benchmark fixture</h1><p>Deterministic browser evidence for MCP measurements.</p><button id="fixture-button">Continue</button><input aria-label="Fixture input" value="ready"></main></body></html>`;

function usage() {
  return `Usage: npm run benchmark:mcp [-- --iterations N --timeout-ms N] [--dist]
       npm run benchmark:mcp:live [-- --iterations N --timeout-ms N] [--dist]

The default run uses a disabled browser and measures deterministic protocol and
fail-closed error paths. --live requires SMOOTH_OPERATOR_BENCHMARK_BROWSER_EXECUTABLE
and launches an isolated Chromium profile against a local fixture server.
Reports are emitted as JSON on stdout; no report file is created.`;
}

function parseArguments(rawArguments) {
  const options = { live: false, dist: false, iterations: 1, timeoutMs: DEFAULT_TIMEOUT_MS, help: false };
  for (let index = 0; index < rawArguments.length; index += 1) {
    const argument = rawArguments[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--live") {
      options.live = true;
      continue;
    }
    if (argument === "--dist") {
      options.dist = true;
      continue;
    }
    if (argument === "--iterations" || argument === "--timeout-ms") {
      const value = rawArguments[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value.`);
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${argument} must be a positive integer.`);
      }
      if (argument === "--iterations") {
        if (parsed > MAX_ITERATIONS) {
          throw new Error(`--iterations must be at most ${MAX_ITERATIONS}.`);
        }
        options.iterations = parsed;
      } else {
        options.timeoutMs = parsed;
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown benchmark option '${argument}'.`);
  }
  return options;
}

function benchmarkEnvironment(options, dataDirectory, userDataDirectory) {
  const environment = {};
  for (const key of ["HOME", "PATH", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key] !== undefined) {
      environment[key] = process.env[key];
    }
  }
  environment.SMOOTH_OPERATOR_TRANSPORT = "stdio";
  environment.SMOOTH_OPERATOR_BROWSER_MODE = options.live ? "launch" : "disabled";
  environment.SMOOTH_OPERATOR_DATA_DIR = dataDirectory;
  environment.SMOOTH_OPERATOR_LOG_LEVEL = "error";
  if (options.live) {
    environment.SMOOTH_OPERATOR_BROWSER_EXECUTABLE = options.executable;
    environment.SMOOTH_OPERATOR_BROWSER_USER_DATA_DIR = userDataDirectory;
    environment.SMOOTH_OPERATOR_BROWSER_HEADLESS = "true";
  }
  return environment;
}

function errorCode(error) {
  if (error && typeof error === "object" && typeof error.code === "string") {
    return error.code;
  }
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return "ERROR";
}

function resultStats(result) {
  const outputBytes = TEXT_ENCODER.encode(JSON.stringify(result)).byteLength;
  const structured = result && typeof result === "object" && result.structuredContent && typeof result.structuredContent === "object"
    ? result.structuredContent
    : undefined;
  const error = structured && typeof structured === "object" && structured.error && typeof structured.error === "object"
    ? structured.error
    : undefined;
  return {
    status: result?.isError ? "mcp_error" : "ok",
    outputBytes,
    ...(error && typeof error.code === "string" ? { errorCode: error.code } : {}),
  };
}

async function measure(operation, timeoutMs, extra = {}) {
  const startedAt = performance.now();
  const operationPromise = Promise.resolve().then(operation);
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("Benchmark operation timed out."), { code: "BENCHMARK_TIMEOUT" })), timeoutMs);
  });
  try {
    const value = await Promise.race([operationPromise, timeoutPromise]);
    return { ...extra, status: "ok", durationMs: round(performance.now() - startedAt), value };
  } catch (error) {
    operationPromise.catch(() => undefined);
    return { ...extra, status: "error", durationMs: round(performance.now() - startedAt), errorCode: errorCode(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function measureCall(client, name, arguments_, timeoutMs, expectedStatus) {
  const measured = await measure(() => client.callTool({ name, arguments: arguments_ }), timeoutMs, { expectedStatus });
  if (measured.status !== "ok") {
    return { ...omitValue(measured), actualStatus: "transport_error", statusMismatch: true };
  }
  const stats = resultStats(measured.value);
  return { ...omitValue(measured), ...stats, statusMismatch: stats.status !== expectedStatus };
}

async function measureList(operation, timeoutMs, counts = () => ({})) {
  const measured = await measure(operation, timeoutMs);
  if (measured.status !== "ok") {
    return omitValue(measured);
  }
  return { ...omitValue(measured), status: "ok", outputBytes: TEXT_ENCODER.encode(JSON.stringify(measured.value)).byteLength, ...counts(measured.value) };
}

function omitValue(value) {
  const { value: _value, ...result } = value;
  return result;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

async function createFixtureServer() {
  const server = createServer((request, response) => {
    if (request.url !== "/fixture") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(FIXTURE_HTML) });
    response.end(FIXTURE_HTML);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Could not allocate the benchmark fixture port.");
  }
  return { server, url: `http://127.0.0.1:${address.port}/fixture` };
}

async function closeServer(server) {
  await new Promise((resolveClose) => server.close(() => resolveClose()));
}

async function runIteration(options, fixtureUrl) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "smooth-operator-benchmark-"));
  const userDataDirectory = join(dataDirectory, "browser-profile");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: options.dist ? [DIST_SERVER_ENTRY] : [TSX_ENTRY, SOURCE_SERVER_ENTRY],
    cwd: ROOT,
    env: benchmarkEnvironment(options, dataDirectory, userDataDirectory),
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "smooth-operator-benchmark", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  let connected = false;
  try {
    const coldStartup = await measure(() => client.connect(transport), options.timeoutMs);
    if (coldStartup.status !== "ok") {
      return { coldStartup: omitValue(coldStartup), cleanup: "completed" };
    }
    connected = true;
    const toolsList = await measureList(() => client.listTools(), options.timeoutMs, (value) => ({ toolCount: value.tools.length }));
    const resourcesList = await measureList(() => client.listResources(), options.timeoutMs, (value) => ({ resourceCount: value.resources.length }));
    const resourceTemplatesList = await measureList(() => client.listResourceTemplates(), options.timeoutMs, (value) => ({ resourceTemplateCount: value.resourceTemplates.length }));
    const promptsList = await measureList(() => client.listPrompts(), options.timeoutMs, (value) => ({ promptCount: value.prompts.length }));
    const expectedBrowserStatus = options.live ? "ok" : "mcp_error";
    const probes = {
      health: await measureCall(client, "server_health", {}, options.timeoutMs, "ok"),
      lazyBrowserStartup: await measureCall(client, "browser_tabs", {}, options.timeoutMs, expectedBrowserStatus),
      snapshot: await measureCall(client, "browser_snapshot", {}, options.timeoutMs, expectedBrowserStatus),
      extract: await measureCall(client, "browser_extract", { selector: "#benchmark-fixture", maxChars: 1_000 }, options.timeoutMs, expectedBrowserStatus),
      batch: await measureCall(client, "browser_batch", { actions: [{ action: "wait", milliseconds: 0 }, { action: "get_page_info" }] }, options.timeoutMs, expectedBrowserStatus),
      error: await measureCall(client, "browser_close_session", { session_id: "benchmark-missing-session" }, options.timeoutMs, "mcp_error"),
    };
    if (options.live) {
      probes.navigate = await measureCall(client, "browser_navigate", { url: fixtureUrl }, options.timeoutMs, "ok");
      probes.snapshot = await measureCall(client, "browser_snapshot", {}, options.timeoutMs, "ok");
      probes.extract = await measureCall(client, "browser_extract", { selector: "#benchmark-fixture", maxChars: 1_000 }, options.timeoutMs, "ok");
      probes.batch = await measureCall(client, "browser_batch", { actions: [{ action: "wait", milliseconds: 0 }, { action: "get_page_info" }] }, options.timeoutMs, "ok");
    }
    return {
      protocolEra: typeof client.getProtocolEra === "function" ? client.getProtocolEra() : "unknown",
      entry: options.dist ? "dist" : "source",
      coldStartup: omitValue(coldStartup),
      toolsList,
      resourcesList,
      resourceTemplatesList,
      promptsList,
      probes,
      cleanup: "completed",
    };
  } finally {
    if (connected) {
      await client.close().catch(() => undefined);
    }
    await transport.close().catch(() => undefined);
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

function summarize(iterations) {
  const metrics = ["coldStartup", "toolsList", "resourcesList", "resourceTemplatesList", "promptsList"];
  const summary = {};
  for (const metric of metrics) {
    const samples = iterations.map((iteration) => iteration[metric]?.durationMs).filter((value) => typeof value === "number");
    summary[metric] = { samples: samples.length, medianMs: samples.length ? median(samples) : null };
  }
  return summary;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.dist) {
    await access(DIST_SERVER_ENTRY).catch(() => {
      throw new Error("--dist requires dist/smooth-operator.mjs. Run npm run build first.");
    });
  }
  if (options.live) {
    options.executable = process.env.SMOOTH_OPERATOR_BENCHMARK_BROWSER_EXECUTABLE ?? process.env.SMOOTH_OPERATOR_BROWSER_EXECUTABLE;
    if (!options.executable) {
      throw new Error("--live requires SMOOTH_OPERATOR_BENCHMARK_BROWSER_EXECUTABLE.");
    }
  }
  const fixture = options.live ? await createFixtureServer() : undefined;
  try {
    const iterations = [];
    for (let index = 0; index < options.iterations; index += 1) {
      iterations.push(await runIteration(options, fixture?.url));
    }
    const report = {
      schemaVersion: 1,
      server: "SmoothOperator",
      entry: options.dist ? "dist" : "source",
      mode: options.live ? "live" : "disabled-browser",
      iterations: options.iterations,
      timeoutMs: options.timeoutMs,
      workload: ["cold startup + initialize", "tools/list", "resource/prompt discovery", "lazy browser startup", "snapshot", "extract", "batch", "application error"],
      results: iterations,
      summary: summarize(iterations),
    };
    const transportFailures = iterations.flatMap((iteration, iterationIndex) => ["coldStartup", "toolsList", "resourcesList", "resourceTemplatesList", "promptsList"]
      .filter((metric) => iteration[metric]?.status === "error")
      .map((metric) => ({ iteration: iterationIndex + 1, metric })));
    const mismatches = iterations.flatMap((iteration, iterationIndex) => Object.entries(iteration.probes ?? {})
      .filter(([, probe]) => probe && typeof probe === "object" && probe.statusMismatch === true)
      .map(([probeName]) => ({ iteration: iterationIndex + 1, probe: probeName })));
    report.validation = { passed: transportFailures.length === 0 && mismatches.length === 0, transportFailures, mismatches };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (transportFailures.length > 0 || mismatches.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (fixture) {
      await closeServer(fixture.server);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
