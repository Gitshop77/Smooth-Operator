/**
 * URL-triggered page loaders (port of stealthy-auto-browse's loaders.py).
 *
 * A loader is a URL-triggered automation recipe: when the agent navigates to
 * a matching URL, its `steps` are dispatched like ordinary actions. The
 * registry lives in `chrome.storage.local` under {@link LOADER_REGISTRY_KEY}
 * as `{ "<filename>": "<YAML-or-JSON text>" }` and is re-read on EVERY
 * navigation (hot-reload).
 *
 * Deliberate divergences from stealthy:
 * - At least one match field is REQUIRED — stealthy's unknown-key catch-all
 *   hazard (all-None loader matching every page) is rejected at parse time.
 * - Control nodes (`if` / `repeat` / `while`) are NOT supported in loader
 *   steps — a loader containing them is rejected rather than mis-dispatched.
 * - Loader step failures are reported HONESTLY (`allSuccess: false`), not
 *   wrapped in `success: true` like stealthy's `last_result` masking.
 *
 * The engine is browser-agnostic: `runMatchedLoaders` takes an injected
 * `dispatch` callback so it can be exercised without a live page and reused
 * by the agent loop. The navigate handler wires the runner through the
 * executor (see `tools/executor.ts`); loader-originated navigations carry
 * `fromLoader` on the action context so loaders never re-trigger themselves.
 */

import { parseScriptYaml } from "../../script-parser";
import type { ActionResult, AgentAction } from "../../types";

/** chrome.storage.local key holding the loader registry (filename → text). */
export const LOADER_REGISTRY_KEY = "open_cowork_url_loaders";

/** Match fields — at least one must be present and non-empty. */
export interface LoaderMatch {
  /** Exact hostname (www stripped on both sides, case-insensitive). */
  domain?: string;
  /** URL path prefix (startswith semantics). */
  path_prefix?: string;
  /** Substring regex searched against the raw URL. */
  regex?: string;
}

export interface LoaderDef {
  /** Optional human-readable label (falls back to the source key). */
  name?: string;
  match: LoaderMatch;
  steps: AgentAction[];
  /** Registry key (filename) — drives ordering + reporting. */
  source: string;
}

export interface LoaderRunResult {
  matched: boolean;
  /** Matched loader label (name or source key). */
  loader?: string;
  stepsRun: number;
  allSuccess: boolean;
  message: string;
}

export interface LoaderRunOptions {
  /** The URL that was navigated to. */
  url: string;
  /** Registry reader — defaults to chrome.storage.local via readLoaderRegistry. */
  readRegistry?: () => Promise<Record<string, string>>;
  /** Executes one loader step (an ordinary action). */
  dispatch: (step: AgentAction) => Promise<ActionResult>;
}

const MATCH_FIELDS = new Set(["domain", "path_prefix", "regex"] as const);
const CONTROL_STEP_KEYS = new Set(["if", "repeat", "while"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripWww(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/**
 * Parse + validate the loader registry. Entries are sorted by source key
 * (filename) so `matchLoader`'s first-match-wins is deterministic. Malformed
 * entries are reported in `errors`, never silently dropped.
 */
export function parseLoaderRegistry(entries: Record<string, string>): {
  loaders: LoaderDef[];
  errors: string[];
} {
  const loaders: LoaderDef[] = [];
  const errors: string[] = [];
  for (const source of Object.keys(entries).sort()) {
    const error = parseLoaderEntry(entries[source], source, loaders);
    if (error) errors.push(`${source}: ${error}`);
  }
  return { loaders, errors };
}

function parseLoaderEntry(text: string, source: string, out: LoaderDef[]): string | undefined {
  let parsed: unknown;
  try {
    parsed = parseScriptYaml(text);
  } catch (e) {
    return `unparseable YAML/JSON: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (parsed === null || !isRecord(parsed)) {
    return "expected a YAML/JSON mapping";
  }
  const match = parsed.match;
  if (!isRecord(match)) {
    return "loader requires a match block with at least one of domain/path_prefix/regex";
  }
  const unknownFields = Object.keys(match).filter((k) => !MATCH_FIELDS.has(k as keyof LoaderMatch));
  if (unknownFields.length > 0) {
    return `unknown match field(s): ${unknownFields.join(", ")}`;
  }
  const knownFields = Object.keys(match).filter((k) => MATCH_FIELDS.has(k as keyof LoaderMatch));
  if (knownFields.length === 0) {
    return "loader requires at least one of domain/path_prefix/regex";
  }
  const cleanMatch: LoaderMatch = {};
  for (const key of knownFields) {
    const value = match[key];
    if (typeof value !== "string" || value === "") {
      return `match field '${key}' must be a non-empty string`;
    }
    cleanMatch[key as keyof LoaderMatch] = value;
  }
  const steps = parsed.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return "steps must be a non-empty list";
  }
  const cleanSteps: AgentAction[] = [];
  for (const step of steps) {
    if (!isRecord(step)) {
      return "every step must be a mapping";
    }
    const controlKeys = Object.keys(step).filter((k) => CONTROL_STEP_KEYS.has(k));
    if (controlKeys.length > 0) {
      return `control nodes are not supported in loader steps (found: ${controlKeys.join(", ")})`;
    }
    if (typeof step.type !== "string" || step.type === "") {
      return "every step requires a non-empty 'type'";
    }
    cleanSteps.push(step as unknown as AgentAction);
  }
  const name = parsed.name;
  if (name !== undefined && (typeof name !== "string" || name === "")) {
    return "'name' must be a non-empty string";
  }
  out.push({
    name: typeof name === "string" ? name : undefined,
    match: cleanMatch,
    steps: cleanSteps,
    source,
  });
  return undefined;
}

/**
 * First-match-wins selection over the (sorted) loader list. `domain` is
 * compared with `www.` stripped on BOTH sides and lowercased; `path_prefix`
 * uses startswith; `regex` uses substring search; all provided fields AND.
 */
export function matchLoader(defs: LoaderDef[], url: string): LoaderDef | undefined {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  const host = stripWww(target.hostname);
  for (const def of defs) {
    const m = def.match;
    let ok = true;
    if (m.domain !== undefined && stripWww(m.domain) !== host) ok = false;
    if (ok && m.path_prefix !== undefined && !target.pathname.startsWith(m.path_prefix)) ok = false;
    if (ok && m.regex !== undefined) {
      try {
        if (!new RegExp(m.regex).test(url)) ok = false;
      } catch {
        ok = false;
      }
    }
    if (ok) return def;
  }
  return undefined;
}

/**
 * Substitute `${url}` in TOP-LEVEL string values of each step. Nested
 * values are exempt (mirrors stealthy loaders.py:96-104).
 */
export function expandLoaderSteps(def: LoaderDef, url: string): AgentAction[] {
  return def.steps.map((step) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(step as Record<string, unknown>)) {
      out[key] = typeof value === "string" ? value.replaceAll("${url}", url) : value;
    }
    return out as AgentAction;
  });
}

/** Read the registry from chrome.storage.local; `{}` without an extension context. */
export async function readLoaderRegistry(): Promise<Record<string, string>> {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return {};
    const res = await chrome.storage.local.get(LOADER_REGISTRY_KEY);
    const raw = res?.[LOADER_REGISTRY_KEY];
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Run the loader matching `url`, dispatching each expanded step through
 * `opts.dispatch`. Stops on the first failed step and reports the failure
 * honestly (`allSuccess: false`) — no success-masking.
 */
export async function runMatchedLoaders(opts: LoaderRunOptions): Promise<LoaderRunResult> {
  const entries = opts.readRegistry ? await opts.readRegistry() : await readLoaderRegistry();
  const { loaders } = parseLoaderRegistry(entries);
  const matched = matchLoader(loaders, opts.url);
  if (!matched) {
    return { matched: false, stepsRun: 0, allSuccess: true, message: "no loader matched" };
  }
  const label = matched.name ?? matched.source;
  const steps = expandLoaderSteps(matched, opts.url);
  let stepsRun = 0;
  for (let i = 0; i < steps.length; i++) {
    stepsRun++;
    let result: ActionResult;
    try {
      result = await opts.dispatch(steps[i]);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return {
        matched: true,
        loader: label,
        stepsRun,
        allSuccess: false,
        message: `loader '${label}' FAILED: step ${i + 1} dispatch error: ${reason}`,
      };
    }
    if (!result.success) {
      return {
        matched: true,
        loader: label,
        stepsRun,
        allSuccess: false,
        message: `loader '${label}' FAILED: step ${i + 1} failed: ${result.message}`,
      };
    }
  }
  return {
    matched: true,
    loader: label,
    stepsRun,
    allSuccess: true,
    message: `loader '${label}': ran ${stepsRun} step(s)`,
  };
}
