import { createServer } from "node:http";
import { once } from "node:events";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ITERATIONS = 30;
const TEXT_ENCODER = new TextEncoder();
const TSX_ENTRY = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SOURCE_SERVER_ENTRY = join(ROOT, "src", "server", "main.ts");
const DIST_SERVER_ENTRY = join(ROOT, "dist", "smooth-operator.mjs");
const FIXTURE_HTML = `<!doctype html><html><head><title>SmoothOperator benchmark fixture</title><style>body{font-family:sans-serif}#fixture-button{margin:8px}#fixture-output{display:block;margin:8px}</style></head><body><main id="benchmark-fixture"><h1>Benchmark fixture</h1><p>Deterministic browser evidence for MCP measurements.</p><button id="fixture-button" type="button">Continue</button><input aria-label="Fixture input" value="ready"><output id="fixture-output">ready</output><section id="pagination-fixture">${"pagination evidence ".repeat(100)}</section></main><script>document.querySelector('#fixture-button').addEventListener('click',()=>{document.querySelector('#fixture-output').textContent='clicked';});</script></body></html>`;

function usage() {
  return `Usage: npm run benchmark:mcp [-- --iterations N --timeout-ms N] [--dist] [--output PATH]
       npm run benchmark:mcp:live [-- --iterations N --timeout-ms N] [--dist] [--output PATH]

The default run uses a disabled browser and measures deterministic protocol and
fail-closed error paths. --live requires SMOOTH_OPERATOR_BENCHMARK_BROWSER_EXECUTABLE
and launches an isolated Chromium profile against a local fixture server.
Reports are emitted as JSON on stdout. --output (or --json) also writes the
same bounded report to a JSON file for CI artifacts.`;
}

function parseArguments(rawArguments) {
  const options = { live: false, dist: false, iterations: 1, timeoutMs: DEFAULT_TIMEOUT_MS, outputPath: undefined, help: false };
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
    if (argument === "--iterations" || argument === "--timeout-ms" || argument === "--output" || argument === "--json") {
      const value = rawArguments[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value.`);
      }
      if (argument === "--output" || argument === "--json") {
        options.outputPath = resolve(process.cwd(), value);
        index += 1;
        continue;
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
  environment.SMOOTH_OPERATOR_BENCHMARK_COUNTERS = "true";
  if (options.live) {
    environment.SMOOTH_OPERATOR_BROWSER_EXECUTABLE = options.executable;
    environment.SMOOTH_OPERATOR_BROWSER_USER_DATA_DIR = userDataDirectory;
    environment.SMOOTH_OPERATOR_BROWSER_HEADLESS = "true";
    environment.SMOOTH_OPERATOR_ALLOW_PRIVATE_NETWORK = "true";
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

function structuredValue(result) {
  if (result && typeof result === "object" && result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  return undefined;
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

async function measureCall(client, name, arguments_, timeoutMs, expectedStatus, options = {}) {
  const measured = await measure(() => client.callTool({ name, arguments: arguments_ }), timeoutMs, { expectedStatus });
  if (measured.status !== "ok") {
    return {
      ...omitValue(measured),
      actualStatus: "transport_error",
      statusMismatch: true,
      failure: true,
      ...(options.includeStructured ? { structured: undefined } : {}),
    };
  }
  const stats = resultStats(measured.value);
  return {
    ...omitValue(measured),
    ...stats,
    statusMismatch: stats.status !== expectedStatus,
    failure: stats.status !== expectedStatus,
    ...(options.includeStructured ? { structured: structuredValue(measured.value) } : {}),
  };
}

async function measureCancellation(client, name, arguments_, timeoutMs, mode) {
  const controller = new AbortController();
  const measured = await measure(async () => {
    const timer = setTimeout(() => controller.abort(), 25);
    try {
      // The late-settlement probe deliberately omits the signal so the
      // operation completes after the local caller has stopped waiting. This
      // gives the report a deterministic ignored-cancellation baseline.
      return await client.callTool({ name, arguments: arguments_ }, mode === "cooperative" ? { signal: controller.signal } : undefined);
    } finally {
      clearTimeout(timer);
    }
  }, timeoutMs, { expectedStatus: mode === "cooperative" ? "cancelled" : "late_settlement", cancellationMode: mode });
  if (mode === "cooperative") {
    const cancelled = measured.status === "error";
    return { ...omitValue(measured), actualStatus: cancelled ? "cancelled" : "completed", statusMismatch: !cancelled, failure: !cancelled };
  }
  const completed = measured.status === "ok";
  const stats = completed ? resultStats(measured.value) : undefined;
  return {
    ...omitValue(measured),
    ...(stats ?? { actualStatus: "transport_error" }),
    actualStatus: completed ? stats.status : "transport_error",
    statusMismatch: !completed,
    failure: !completed,
  };
}

async function measureList(operation, timeoutMs, counts = () => ({})) {
  const measured = await measure(operation, timeoutMs);
  if (measured.status !== "ok") {
    return { ...omitValue(measured), failure: true, statusMismatch: false };
  }
  return { ...omitValue(measured), status: "ok", outputBytes: TEXT_ENCODER.encode(JSON.stringify(measured.value)).byteLength, failure: false, statusMismatch: false, ...counts(measured.value) };
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
      return { coldStartup: { ...omitValue(coldStartup), failure: true, statusMismatch: false }, cleanup: "completed" };
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
      probes.navigate = await measureCall(client, "browser_navigate", { url: fixtureUrl }, options.timeoutMs, "ok", { includeStructured: true });
      probes.snapshot = await measureCall(client, "browser_snapshot", {}, options.timeoutMs, "ok");
      probes.click = await measureCall(client, "browser_click", { target: "#fixture-button" }, options.timeoutMs, "ok");
      probes.input = await measureCall(client, "browser_input", { target: 'input[aria-label="Fixture input"]', text: "benchmark" }, options.timeoutMs, "ok");
      probes.pageLookup = await measureCall(client, "browser_page_info", {}, options.timeoutMs, "ok");
      probes.extract = await measureCall(client, "browser_extract", { selector: "#pagination-fixture", maxChars: 120, includeLinks: true }, options.timeoutMs, "ok", { includeStructured: true });
      const extracted = probes.extract.structured && typeof probes.extract.structured === "object" ? probes.extract.structured : {};
      probes.pagination = await measureCall(client, "browser_page_next", {
        offset: typeof extracted.nextOffset === "number" ? extracted.nextOffset : 0,
        revision: typeof extracted.revision === "number" ? extracted.revision : undefined,
        maxChars: 120,
      }, options.timeoutMs, "ok");
      probes.batch10 = await measureCall(client, "browser_batch", { actions: Array.from({ length: 10 }, () => ({ action: "wait", milliseconds: 0 })) }, options.timeoutMs, "ok");
      probes.cooperativeCancellation = await measureCancellation(client, "browser_wait", { milliseconds: 5_000 }, options.timeoutMs, "cooperative");
      probes.ignoredCancellation = await measureCancellation(client, "browser_wait", { milliseconds: 100 }, options.timeoutMs, "ignored");
      const finalHealth = await measureCall(client, "server_health", {}, options.timeoutMs, "ok", { includeStructured: true });
      probes.runtimeCounters = finalHealth;
    }
    const runtimeCounters = probes.runtimeCounters?.structured && typeof probes.runtimeCounters.structured === "object"
      ? probes.runtimeCounters.structured.capabilities?.browser?.runtime?.benchmarkCounters
      : undefined;
    return {
      protocolEra: typeof client.getProtocolEra === "function" ? client.getProtocolEra() : "unknown",
      entry: options.dist ? "dist" : "source",
      coldStartup: { ...omitValue(coldStartup), failure: false, statusMismatch: false },
      toolsList,
      resourcesList,
      resourceTemplatesList,
      promptsList,
      probes,
      counters: runtimeCounters ?? null,
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
  const metrics = new Map();
  for (const iteration of iterations) {
    for (const metric of ["coldStartup", "toolsList", "resourcesList", "resourceTemplatesList", "promptsList"]) {
      addMetricSample(metrics, metric, iteration[metric]);
    }
    for (const [probeName, probe] of Object.entries(iteration.probes ?? {})) {
      addMetricSample(metrics, `probe.${probeName}`, probe);
    }
  }
  const summary = {};
  for (const [metric, records] of metrics) {
    const durations = records.map((record) => record.durationMs).filter((value) => typeof value === "number");
    const outputBytes = records.map((record) => record.outputBytes).filter((value) => typeof value === "number");
    summary[metric] = {
      samples: records.length,
      medianMs: durations.length ? median(durations) : null,
      p95Ms: durations.length ? percentile(durations, 0.95) : null,
      medianOutputBytes: outputBytes.length ? median(outputBytes) : null,
      p95OutputBytes: outputBytes.length ? percentile(outputBytes, 0.95) : null,
      failures: records.filter((record) => record.failure === true).length,
      statusMismatches: records.filter((record) => record.statusMismatch === true).length,
    };
  }
  return summary;
}

function addMetricSample(metrics, name, record) {
  if (!record || typeof record !== "object") {
    return;
  }
  const existing = metrics.get(name) ?? [];
  existing.push(record);
  metrics.set(name, existing);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  const position = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return round(sorted[position]);
}

function summarizeCounters(iterations) {
  const names = ["browserOperations", "pageLookups", "pageEnumerations", "pageEvaluations", "cdpCommands"];
  return Object.fromEntries(names.map((name) => {
    const samples = iterations.map((iteration) => iteration.counters?.[name]).filter((value) => typeof value === "number");
    return [name, { samples: samples.length, median: samples.length ? median(samples) : null, p95: samples.length ? percentile(samples, 0.95) : null }];
  }));
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
      schemaVersion: 2,
      server: "SmoothOperator",
      entry: options.dist ? "dist" : "source",
      mode: options.live ? "live" : "disabled-browser",
      baseline: `${options.dist ? "bundle" : "source"}/${options.live ? "live" : "disabled"}`,
      iterations: options.iterations,
      timeoutMs: options.timeoutMs,
      workload: ["cold startup + initialize", "tools/list", "resource/prompt discovery", "lazy browser startup", "navigation", "snapshot", "click", "input", "page lookup", "pagination", "10-step batch", "cooperative cancellation", "ignored cancellation", "application error"],
      results: iterations,
      summary: summarize(iterations),
      counterSummary: summarizeCounters(iterations),
    };
    const failures = iterations.flatMap((iteration, iterationIndex) => {
      const records = ["coldStartup", "toolsList", "resourcesList", "resourceTemplatesList", "promptsList"].map((metric) => [metric, iteration[metric]])
        .concat(Object.entries(iteration.probes ?? {}).map(([probeName, probe]) => [`probe.${probeName}`, probe]));
      return records.filter(([, record]) => record && record.failure === true).map(([metric]) => ({ iteration: iterationIndex + 1, metric }));
    });
    const mismatches = iterations.flatMap((iteration, iterationIndex) => {
      const records = ["coldStartup", "toolsList", "resourcesList", "resourceTemplatesList", "promptsList"].map((metric) => [metric, iteration[metric]])
        .concat(Object.entries(iteration.probes ?? {}).map(([probeName, probe]) => [`probe.${probeName}`, probe]));
      return records.filter(([, record]) => record && record.statusMismatch === true).map(([metric]) => ({ iteration: iterationIndex + 1, metric }));
    });
    report.validation = { passed: failures.length === 0 && mismatches.length === 0, failures, transportFailures: failures, mismatches, statusMismatches: mismatches };
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.outputPath) {
      await writeFile(options.outputPath, serialized, { mode: 0o600 });
    }
    process.stdout.write(serialized);
    if (failures.length > 0 || mismatches.length > 0) {
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
