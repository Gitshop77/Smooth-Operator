/**
 * URL-evaluator — deterministic check of the agent's final page URL against
 * a reference URL.
 *
 * Supports ` |OR| ` alternatives in the reference (any match counts). The
 * default matching rule is `"GOLD in PRED"` (the reference URL must be
 * contained in the actual URL): the reference's `netloc + path` must be a
 * substring of the prediction's `netloc + path`, AND every query-param key
 * in the reference must have at least one matching value in the prediction.
 */

/** Tag used by {@link URLEvaluator} when surfacing which check failed. */
export const URL_EVALUATOR_TAG = "url_match";

/** Inputs to {@link URLEvaluator.evaluate}. */
export interface URLEvaluatorInput {
  /** The agent's final page URL (the "prediction"). */
  prediction: string;
  /**
 * Reference URL(s). Multiple acceptable URLs may be joined with ` |OR| `.
 * The evaluator passes if ANY of them matches.
 */
  referenceUrl: string;
  /** Matching rule. Currently only `"GOLD in PRED"` is supported. */
  matchingRule?: "GOLD in PRED";
}

/** Result of a single {@link URLEvaluator.evaluate} call. */
export interface URLEvaluatorResult {
  /** 1.0 = match, 0.0 = no match. */
  score: number;
  /** Tag identifying which evaluator produced this result. */
  tag: string;
  /** Human-readable reason for a non-1.0 score (empty when score === 1). */
  reason: string;
}

/** Strip a trailing slash (so `example.com/` matches `example.com`). */
function cleanUrl(url: string): string {
  return String(url).replace(/\/+$/, "");
}

/** Recover the host portion of a `basePath` (`hostname + pathname`). */
const hostOf = (basePath: string): string => basePath.split("/")[0];

/** Percent-decode without throwing on malformed input (returns the raw string). */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A parsed URL split into its base path + query-param map. */
interface ParsedUrl {
  basePath: string;
  query: Record<string, string[]>;
}

/**
 * Parse a URL into `basePath` (`netloc + path`) + a query-param map.
 *
 * Uses the standard `URL` constructor when available (browser / Node ≥ 10).
 * Falls back to a regex parse for environments without `URL` (older test
 * runners) so the evaluator never throws on a malformed URL — it returns
 * an empty `basePath` and an empty `query` instead.
 */
export function parseUrl(url: string): ParsedUrl {
  try {
    const u = new URL(url);
    const query: Record<string, string[]> = Object.create(null);
    u.searchParams.forEach((value, key) => {
      (query[key] ??= []).push(value);
    });
 // Use `hostname` (port-stripped) for the base path so host matching is
 // port-insensitive — a reference pinned with/without a port still matches
 // the same origin (the port is not part of same-site semantics).
    return { basePath: u.hostname + u.pathname, query };
  } catch {
 // Fallback regex parse — requires a `scheme://host/path?query` form (a
 // protocol IS required; protocol-less inputs return an empty parse).
    const m = /^[a-z]+:\/\/([^/?]+)([^?]*)\??(.*)$/i.exec(url);
    if (!m) return { basePath: "", query: {} };
    const bracketedWithPort = m[1].match(/^(\[.+\]):\d+$/);
    const host = bracketedWithPort ? bracketedWithPort[1] : m[1].replace(/:\d+$/, "");
    const basePath = host + m[2];
    const query: Record<string, string[]> = Object.create(null);
    if (m[3]) {
      for (const pair of m[3].split("&")) {
        const [k, v = ""] = pair.split("=");
        (query[safeDecode(k)] ??= []).push(safeDecode(v));
      }
    }
    return { basePath, query };
  }
}

/**
 * Check whether a prediction host matches a reference host.
 *
 * The reference host must be EITHER an exact match OR a subdomain of the
 * prediction host (e.g. ref `example.com` matches pred `shop.example.com`).
 * This prevents the lookalike-domain bypass where `evil.com` would
 * substring-match `notevil.com` (or `stripe.com` → `mystripe.com`).
 */
function hostMatches(refHost: string, predHost: string): boolean {
  if (refHost === predHost) return true;
 // Subdomain suffix: ref `example.com` matches pred `shop.example.com`
 // but NOT `notexample.com` (must be preceded by `.`).
  return predHost.endsWith("." + refHost);
}

/** Evaluate the prediction URL against the reference URL. */
export function evaluateUrl(input: URLEvaluatorInput): URLEvaluatorResult {
  const rule = input.matchingRule ?? "GOLD in PRED";
  if (rule !== "GOLD in PRED") {
    return { score: 0, tag: URL_EVALUATOR_TAG, reason: `unknown matching rule: ${rule}` };
  }
  const refUrls = input.referenceUrl.split(/\s\|OR\|\s/).map((s) => cleanUrl(s.trim()));
  const pred = cleanUrl(input.prediction);
  const predParsed = parseUrl(pred);
 // Parse each reference exactly once, then run all three checks (host, path,
 // query) against the cached parse instead of re-parsing per loop.
  const refParsedList = refUrls.map((ref) => parseUrl(ref));

 // Single pass over the references: first a host check (any reference host
 // must exact-match or be a subdomain-suffix of the prediction host — this
 // prevents lookalike-domain bypass), then a path-prefix check on the
 // host-matched references. Reasons are surfaced distinctly so the caller
 // can tell a host mismatch from a path mismatch.
  const predHost = hostOf(predParsed.basePath);
  let hostOk = false;
  let pathOk = false;
  for (const refParsed of refParsedList) {
    const refHost = hostOf(refParsed.basePath);
    if (refParsed.basePath === "" || !hostMatches(refHost, predHost)) continue;
    hostOk = true;
    const refPath = refParsed.basePath.slice(refHost.length); // "/path" or ""
    const predPath = predParsed.basePath.slice(predHost.length); // "/path" or ""
 // Empty ref path matches anything; otherwise pred path must start with ref path.
    if (refPath === "" || refPath === "/") {
      pathOk = true;
      break;
    }
 // Require a path-segment boundary after the ref path prefix.
 // `startsWith` alone allows `/foo` to match `/foobar` (false positive).
 // After the prefix, the next char must be `/`, `?`, `#`, or end-of-string.
    if (!predPath.startsWith(refPath)) continue;
    const nextChar = predPath[refPath.length];
    if (nextChar === undefined || nextChar === "/" || nextChar === "?" || nextChar === "#") {
      pathOk = true;
      break;
    }
  }
  if (!hostOk) {
    return {
      score: 0,
      tag: URL_EVALUATOR_TAG,
      reason: `host "${predHost}" does not match any reference host`,
    };
  }
  if (!pathOk) {
    return {
      score: 0,
      tag: URL_EVALUATOR_TAG,
      reason: `path "${predParsed.basePath}" does not start with any reference path`,
    };
  }

 // Query-param check: every key in the union of reference queries must
 // have at least one matching value in the prediction.
  const refQueries: Record<string, Set<string>> = {};
  for (const parsed of refParsedList) {
    for (const [k, vs] of Object.entries(parsed.query)) {
      if (!refQueries[k]) refQueries[k] = new Set();
      for (const v of vs) refQueries[k].add(v);
    }
  }
  for (const [k, acceptable] of Object.entries(refQueries)) {
    const predValues = predParsed.query[k] ?? [];
    const hasMatch = [...acceptable].some((v) => predValues.includes(v));
    if (!hasMatch) {
      return {
        score: 0,
        tag: URL_EVALUATOR_TAG,
        reason: `missing query param "${k}" with any of: ${[...acceptable].join(", ")}`,
      };
    }
  }
  return { score: 1, tag: URL_EVALUATOR_TAG, reason: "" };
}

/** OOP wrapper kept for parity with the other evaluators. */
export class URLEvaluator {
  readonly tag = URL_EVALUATOR_TAG;
  evaluate(input: URLEvaluatorInput): URLEvaluatorResult {
    return evaluateUrl(input);
  }
}
