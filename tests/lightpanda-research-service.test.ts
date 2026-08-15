import { describe, it, expect } from "vitest";
import { createResearchRunner, ResearchError, buildAgentArgs } from "../src/extension/background/lightpanda/research-service";
import type { ResearchDeps } from "../src/extension/background/lightpanda/research-service";
import type { AgentProcessResult } from "../src/extension/background/lightpanda/native-host-client";

const okResult = (over: Partial<AgentProcessResult> = {}): AgentProcessResult => ({
  stdout: "Lightpanda's answer.\n",
  stderr: "$usage prompt=10 completion=5 total=15 cached=0 cache_creation=0\n",
  exitCode: 0,
  timedOut: false,
  ...over,
});

// NOTE: annotate `over` and the literal as ResearchDeps so the spread keeps
// contextual typing (TS7006 otherwise).
function makeDeps(over: Partial<ResearchDeps> = {}) {
  const deps: ResearchDeps = {
    readSettings: async () => ({ enabled: true, binaryPath: "", braveKey: "", tavilyKey: "", timeoutMs: 120_000, maxResultChars: 32_000 }),
    readProvider: async () => ({ provider: "openai", apiKey: "k", model: "gpt-5" }),
    readDomains: async () => ({ allowed: [], blocked: [] }),
    run: async () => okResult(),
    ...over,
  };
  return { run: createResearchRunner(deps), deps };
}

describe("runResearch", () => {
  it("runs lightpanda agent and sanitizes the answer", async () => {
    const { run } = makeDeps();
    const res = await run("latest news");
    expect(res.answer).toContain("Lightpanda's answer.");
    expect(res.usage).toEqual({ tokensIn: 10, tokensOut: 5, cached: 0, cacheCreation: 0 });
    expect(res.model).toBe("gpt-5");
  });

  it("builds agent argv with provider/model/base-url, --block-urls, --verbosity low and --watchdog-ms 0", () => {
    const args = buildAgentArgs({ query: "q", provider: "openai_compatible", model: "m", baseUrl: "http://x/v1", blockedDomains: ["evil.com"] });
    expect(args).toEqual([
      "agent", "--task", "q", "--provider", "openai_compatible", "--model", "m", "--base-url", "http://x/v1",
      "--block-urls", "*://*.evil.com/*,*://evil.com/*", "--verbosity", "low", "--watchdog-ms", "0",
    ]);
  });

  it("omits --model/--base-url/--block-urls when absent", () => {
    expect(buildAgentArgs({ query: "q", provider: "openai", blockedDomains: [] })).toEqual([
      "agent", "--task", "q", "--provider", "openai", "--verbosity", "low", "--watchdog-ms", "0",
    ]);
  });

  it("passes Brave/Tavily keys and disables telemetry in env", async () => {
    const { run } = makeDeps({
      readSettings: async () => ({ enabled: true, binaryPath: "", braveKey: "B", tavilyKey: "T", timeoutMs: 120_000, maxResultChars: 32_000 }),
      run: async (req) => {
        expect(req.env.BRAVE_API_KEY).toBe("B");
        expect(req.env.TAVILY_API_KEY).toBe("T");
        expect(req.env.LIGHTPANDA_DISABLE_TELEMETRY).toBe("true");
        return okResult();
      },
    });
    await run("q");
  });

  it("runs ollama without an API key (telemetry still disabled)", async () => {
    const { run } = makeDeps({
      readProvider: async () => ({ provider: "ollama", apiKey: "", model: "llama3.3" }),
      run: async (req) => { expect(req.env).toEqual({ LIGHTPANDA_DISABLE_TELEMETRY: "true" }); return okResult(); },
    });
    const res = await run("q");
    expect(res.answer).toContain("Lightpanda's answer.");
  });

  it("throws when disabled", async () => {
    const { run } = makeDeps({ readSettings: async () => ({ enabled: false, binaryPath: "", braveKey: "", tavilyKey: "", timeoutMs: 120_000, maxResultChars: 32_000 }) });
    await expect(run("q")).rejects.toThrow(/disabled/);
  });

  it("throws on allowlist (fail-closed)", async () => {
    const { run } = makeDeps({ readDomains: async () => ({ allowed: ["trusted.com"], blocked: [] }) });
    await expect(run("q")).rejects.toThrow(ResearchError);
    await expect(run("q")).rejects.toThrow(/allowlist/);
  });

  it("throws on unsupported provider", async () => {
    const { run } = makeDeps({ readProvider: async () => ({ provider: "mystery", apiKey: "k" }) });
    await expect(run("q")).rejects.toThrow(/not supported/);
  });

  it("throws when the process exits without an answer", async () => {
    const { run } = makeDeps({ run: async () => okResult({ stdout: "", exitCode: 1, stderr: "info: crash\n" }) });
    await expect(run("q")).rejects.toThrow(/code 1/);
  });

  it("throws when the process exits 0 with an empty answer", async () => {
    const { run } = makeDeps({ run: async () => okResult({ stdout: "", exitCode: 0 }) });
    await expect(run("q")).rejects.toThrow(/empty answer/);
  });

  it("throws on timeout without an answer", async () => {
    const { run } = makeDeps({ run: async () => okResult({ stdout: "", exitCode: null, timedOut: true }) });
    await expect(run("q")).rejects.toThrow(/timed out/);
  });

  it("propagates AbortError (name-based, realm-agnostic)", async () => {
    const { run } = makeDeps({ run: async (_req, signal) => { signal?.throwIfAborted(); throw new DOMException("aborted", "AbortError"); } });
    const ac = new AbortController();
    ac.abort();
    await expect(run("q", { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});