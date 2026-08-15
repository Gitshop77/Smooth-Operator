/**
 * Research service — runs Lightpanda's own agent (`lightpanda agent --task`)
 * with the SAME provider/model/API key as the main agent, then bounds,
 * redacts, and injection-scans the synthesized answer.
 *
 * Provider config lives at src/extension/provider-config.ts (readProviderConfig).
 */
import { readProviderConfig } from "../../provider-config";
import { buildLightpandaLaunch, type ProviderConfigLike } from "../../../lib/agent/lightpanda/provider-mapping";
import { parseUsage, extractAnswer, type ResearchUsage } from "../../../lib/agent/lightpanda/usage-parse";
import { sanitizeResearchResult } from "../../../lib/agent/lightpanda/result-sanitize";
import {
  runAgentProcess,
  type AgentProcessRequest,
  type AgentProcessResult,
} from "./native-host-client";
import { readLightpandaSettings, type LightpandaSettings } from "../../lightpanda-settings";

export class ResearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchError";
  }
}

export interface ResearchRunResult {
  answer: string;
  usage: ResearchUsage | null;
  model?: string;
  timedOut: boolean;
  exitCode: number | null;
}

export interface ResearchRunOptions {
  signal?: AbortSignal;
}

export interface ResearchDeps {
  readSettings(): Promise<LightpandaSettings>;
  readProvider(): Promise<ProviderConfigLike | null>;
  readDomains(): Promise<{ allowed: string[]; blocked: string[] }>;
  run(req: AgentProcessRequest, signal?: AbortSignal): Promise<AgentProcessResult>;
}

/**
 * Build the `lightpanda agent` argv.
 * `--block-urls` takes comma-separated `*`-wildcard globs matched against the
 * full URL (UrlBlocklist.zig:95-139). `--verbosity low` silences the default
 * `.high` piped chatter; the unconditional `$usage` line still arrives.
 * `--watchdog-ms 0` disables the 30s JS-stall watchdog — pathological
 * pages must not kill valid runs; the host timeout bounds the run instead.
 */
export function buildAgentArgs(params: {
  query: string;
  provider: string;
  model?: string;
  baseUrl?: string;
  blockedDomains: string[];
}): string[] {
  const args = ["agent", "--task", params.query, "--provider", params.provider];
  if (params.model) args.push("--model", params.model);
  if (params.baseUrl) args.push("--base-url", params.baseUrl);
  if (params.blockedDomains.length > 0) {
    args.push("--block-urls", params.blockedDomains.flatMap((d) => [`*://*.${d}/*`, `*://${d}/*`]).join(","));
  }
  args.push("--verbosity", "low", "--watchdog-ms", "0");
  return args;
}

/** Realm-agnostic AbortError check — `instanceof DOMException` is false under
 * vitest/jsdom (different DOMException realm than Node). */
function isAbortError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: string }).name === "AbortError";
}

export function createResearchRunner(deps: ResearchDeps) {
  return async function runResearch(query: string, options: ResearchRunOptions = {}): Promise<ResearchRunResult> {
    if (!query || query.trim() === "") throw new ResearchError("research requires a non-empty query");
    const settings = await deps.readSettings();
    if (!settings.enabled) {
      throw new ResearchError("Lightpanda research is disabled — enable it in the extension Options (Automation tab)");
    }
    const providerConfig = await deps.readProvider();
    if (!providerConfig) {
      throw new ResearchError("no LLM provider configured — research needs the same AI as the main agent");
    }
    const built = buildLightpandaLaunch(providerConfig);
    if (!built.ok) throw new ResearchError(built.error);
    const domains = await deps.readDomains();
    if (domains.allowed.length > 0 && !domains.allowed.includes("*")) {
      throw new ResearchError("research is disabled while an explicit allowed-domains allowlist is configured (fail-closed)");
    }
    const env: Record<string, string> = {
      // Telemetry is default-ON upstream — always opt out.
      LIGHTPANDA_DISABLE_TELEMETRY: "true",
      ...built.launch.env,
    };
    if (settings.braveKey) env.BRAVE_API_KEY = settings.braveKey;
    if (settings.tavilyKey) env.TAVILY_API_KEY = settings.tavilyKey;
    const args = buildAgentArgs({
      query,
      provider: built.launch.provider,
      ...(built.launch.model ? { model: built.launch.model } : {}),
      ...(built.launch.baseUrl ? { baseUrl: built.launch.baseUrl } : {}),
      blockedDomains: domains.blocked,
    });
    let result: AgentProcessResult;
    try {
      result = await deps.run(
        { ...(settings.binaryPath ? { binary: settings.binaryPath } : {}), args, env, timeoutMs: settings.timeoutMs },
        options.signal,
      );
    } catch (e) {
      if (isAbortError(e)) throw e;
      throw new ResearchError(e instanceof Error ? e.message : String(e));
    }
    const answer = extractAnswer(result.stdout);
    if (answer === "" && result.timedOut) {
      throw new ResearchError(`lightpanda timed out after ${Math.round(settings.timeoutMs / 1000)}s without an answer`);
    }
    if (answer === "" && result.exitCode !== 0) {
      // Errors bypass the verbosity gate and can carry ANSI codes (L7) — strip
      // them before surfacing the tail.
      const tail = result.stderr.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").slice(-3).join(" | ");
      throw new ResearchError(`lightpanda exited with code ${result.exitCode} without an answer${tail ? ` (${tail})` : ""}`);
    }
    if (answer === "" && result.exitCode === 0) {
      throw new ResearchError("lightpanda returned an empty answer");
    }
    const sanitized = await sanitizeResearchResult(answer, settings.maxResultChars);
    return {
      answer: sanitized.text,
      usage: parseUsage(result.stderr),
      model: providerConfig.model,
      timedOut: result.timedOut,
      exitCode: result.exitCode,
    };
  };
}

async function readDomainPolicy(): Promise<{ allowed: string[]; blocked: string[] }> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return { allowed: [], blocked: [] };
  const stored = await chrome.storage.local.get(["allowedDomains", "blockedDomains"]);
  const asList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  return { allowed: asList(stored.allowedDomains), blocked: asList(stored.blockedDomains) };
}

/** Production entry point (default deps read chrome.*). */
export const runResearch = createResearchRunner({
  readSettings: readLightpandaSettings,
  readProvider: () => readProviderConfig(),
  readDomains: readDomainPolicy,
  run: runAgentProcess,
});
