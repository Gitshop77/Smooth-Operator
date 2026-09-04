import { AppError } from "./errors";
import { RESEARCH_MAX_CHARS, RESEARCH_MAX_RESULTS, RESEARCH_MIN_CHARS, RESEARCH_QUERY_MAX_CHARS } from "./contracts";
import { Logger, redactValue } from "./logger";
import { SecurityPolicy } from "./policy";
import { wrapUntrustedText } from "./security";
import { sanitizeUrl } from "./browser/utils";

const MAX_QUERY_CHARS = RESEARCH_QUERY_MAX_CHARS;
const MAX_RESPONSE_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = RESEARCH_MAX_RESULTS;
const MIN_MAX_CHARS = RESEARCH_MIN_CHARS;
const MAX_MAX_CHARS = RESEARCH_MAX_CHARS;
const MAX_RESULT_TITLE_CHARS = 500;
const MAX_RESULT_SNIPPET_CHARS = 4_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 2_000;
const MAX_CONCURRENT_RESEARCH = 4;
const MAX_RESEARCH_QUEUE = 16;
const ZERO_WIDTH_PATTERN = /[\u200B-\u200D\u2060\uFEFF]/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const ANTI_BOT_PATTERN = /(?:captcha|challenge|unusual\s+traffic|automated\s+(?:queries|requests)|access\s+denied|temporarily\s+blocked|too\s+many\s+requests)/i;
const RESULT_ANCHOR_PATTERN = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
const RESULT_CLASS_ATTRIBUTE_PATTERN = /\bclass\s*=\s*(["'])([^"']*)\1/i;
const RESULT_HREF_ATTRIBUTE_PATTERN = /\bhref\s*=\s*(["'])([^"']*)\1/i;
const NEXT_RESULT_PATTERN = /<a\b[^>]*\bclass\s*=\s*(["'])[^"']*\bresult__a\b[^"']*\1/i;
const RESULT_SNIPPET_PATTERN = /\bclass\s*=\s*(["'])[^"']*\bresult__snippet\b[^"']*\1[^>]*>([\s\S]*?)<\/[^>]+>/i;

type ResearchItem = { title: string; url: string; untrustedUrl: string; snippet: string };

export interface ResearchResult {
  query: string;
  source: "duckduckgo";
  fetchedAt: string;
  attempts: number;
  requestedMaxResults: number;
  returnedResults: number;
  hasMore: boolean;
  resultsTruncated: boolean;
  textTruncated?: boolean;
  results: ResearchItem[];
  warning?: string;
}

interface ParsedResults {
  results: ResearchItem[];
  hasMore: boolean;
  textTruncated: boolean;
}

interface ResultCandidate {
  title: string;
  titleTruncated: boolean;
  url: string;
  snippet: string;
  snippetTruncated: boolean;
}

interface ResearchWaiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  abortError: () => AppError;
}

class ResearchAdmission {
  private active = 0;
  private closed = false;
  private readonly queue: ResearchWaiter[] = [];

  acquire(signal?: AbortSignal, abortError: () => AppError = cancelledResearchError): Promise<() => void> {
    if (this.closed) {
      return Promise.reject(researchClosingError());
    }
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }
    if (this.active < MAX_CONCURRENT_RESEARCH) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }
    if (this.queue.length >= MAX_RESEARCH_QUEUE) {
      return Promise.reject(new AppError("RESEARCH_BUSY", "The research service is busy; retry later.", {
        retryable: true,
        status: 503,
        details: { classification: "overloaded" },
      }));
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: ResearchWaiter = { resolve, reject, signal, abortError };
      const onAbort = (): void => {
        const index = this.queue.indexOf(waiter);
        if (index < 0) {
          return;
        }
        this.queue.splice(index, 1);
        signal?.removeEventListener("abort", onAbort);
        reject(abortError());
      };
      waiter.onAbort = onAbort;
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
      if (signal?.aborted) {
        onAbort();
      }
    });
  }

  close(): void {
    this.closed = true;
    const error = researchClosingError();
    while (this.queue.length > 0) {
      const waiter = this.queue.shift();
      if (!waiter) {
        continue;
      }
      waiter.signal?.removeEventListener("abort", waiter.onAbort as () => void);
      waiter.reject(error);
    }
  }

  private createRelease(): () => void {
    let released = false;
    return (): void => {
      if (released) {
        return;
      }
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain(): void {
    if (this.closed) {
      return;
    }
    while (this.active < MAX_CONCURRENT_RESEARCH && this.queue.length > 0) {
      const waiter = this.queue.shift();
      if (!waiter) {
        return;
      }
      waiter.signal?.removeEventListener("abort", waiter.onAbort as () => void);
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.abortError());
        continue;
      }
      this.active += 1;
      waiter.resolve(this.createRelease());
    }
  }
}

export class ResearchService {
  private readonly admission = new ResearchAdmission();
  private readonly activeControllers = new Set<AbortController>();
  private closed = false;

  constructor(
    private readonly policy: SecurityPolicy,
    private readonly logger: Logger,
  ) {}

  /** Stop accepting research work and abort every in-flight request. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.admission.close();
    for (const controller of this.activeControllers) {
      controller.abort();
    }
  }

  async research(query: string, options: { maxResults?: number; maxChars?: number } = {}, signal?: AbortSignal): Promise<ResearchResult> {
    if (this.closed) {
      throw researchClosingError();
    }
    if (typeof query !== "string") {
      throw new AppError("RESEARCH_INVALID", "A non-empty research query is required.");
    }
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new AppError("RESEARCH_INVALID", "Research options must be an object.");
    }
    let normalizedQuery: string;
    try {
      normalizedQuery = normalizeResearchQuery(query);
    } catch (error) {
      throw new AppError("RESEARCH_INVALID", "Research queries must contain valid Unicode text.", { cause: error });
    }
    if (!normalizedQuery) {
      throw new AppError("RESEARCH_INVALID", "A non-empty research query is required.");
    }
    if (normalizedQuery.length > MAX_QUERY_CHARS) {
      throw new AppError("RESEARCH_INVALID", `Research queries must be ${MAX_QUERY_CHARS} characters or shorter.`);
    }
    const maxResults = boundedInteger(options.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS);
    // maxChars is an aggregate budget for textual fields only.
    const maxChars = boundedInteger(options.maxChars, MAX_MAX_CHARS, MIN_MAX_CHARS, MAX_MAX_CHARS);
    let encodedQuery: string;
    try {
      encodedQuery = encodeURIComponent(normalizedQuery);
    } catch (error) {
      throw new AppError("RESEARCH_INVALID", "Research queries must contain valid Unicode text.", { cause: error });
    }
    if (signal?.aborted) {
      throw new AppError("CANCELLED", "The research request was cancelled.");
    }
    const controller = new AbortController();
    this.activeControllers.add(controller);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let release: (() => void) | undefined;
    try {
      if (signal?.aborted) {
        controller.abort();
        throw new AppError("CANCELLED", "The research request was cancelled.");
      }
      if (this.closed) {
        throw researchClosingError();
      }
      const abortError = (): AppError => signal?.aborted
        ? new AppError("CANCELLED", "The research request was cancelled.")
        : this.closed
          ? researchClosingError()
        : new AppError("RESEARCH_TIMEOUT", `The research request exceeded its ${REQUEST_TIMEOUT_MS / 1_000}-second timeout.`, {
          retryable: true,
          details: { classification: "timeout", timeoutMs: REQUEST_TIMEOUT_MS },
        });
      release = await this.admission.acquire(controller.signal, abortError);
      if (controller.signal.aborted) {
        controller.abort();
        throw abortError();
      }
      // Policy admission can perform DNS work before fetch starts. Race it
      // against the same deadline as the outbound request so a resolver that
      // never settles cannot hold the research call indefinitely.
      const url = await awaitWithAbort(
        this.policy.assertNavigationAllowedAsync(`https://html.duckduckgo.com/html/?q=${encodedQuery}`),
        controller.signal,
      );
      // The caller can abort while the asynchronous URL policy check is in
      // flight. Re-check after installing the listener so that this race
      // cannot start an outbound request after cancellation.
      if (signal?.aborted) {
        controller.abort();
        throw new AppError("CANCELLED", "The research request was cancelled.");
      }
      const fetched = await fetchWithRetry(url, controller.signal);
      const response = fetched.response;
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        discardResponseBody(response);
        throw new AppError("RESEARCH_RESPONSE_TOO_LARGE", "The search response exceeded the safety limit.", {
          details: { classification: "response_too_large", attempts: fetched.attempts },
        });
      }
      const html = await readBoundedResponseText(response, MAX_RESPONSE_BYTES, controller.signal);
      // `redirect: error` keeps the fetch target bounded, while the response
      // URL still gives the parser the correct origin for protocol-relative
      // and relative result links in DuckDuckGo's HTML.
      const resultOrigin = safeResponseOrigin(response.url, url.toString());
      const parsed = parseResults(html, maxResults, maxChars, resultOrigin);
      if (parsed.results.length === 0 && isAntiBotResponse(html)) {
        throw new AppError("SEARCH_BLOCKED", "The search provider returned an anti-bot or access challenge; complete it manually or retry later.", {
          details: { classification: "anti_bot", attempts: fetched.attempts },
        });
      }
      this.logger.info("Research completed", { resultCount: parsed.results.length, attempts: fetched.attempts });
      const warnings: string[] = [];
      if (parsed.results.length === 0) {
        warnings.push("No parseable search results were returned.");
      }
      if (parsed.hasMore) {
        warnings.push("Additional search results were omitted by the bounded result or text limit.");
      }
      if (parsed.textTruncated) {
        warnings.push("Some result text was shortened to stay within the requested text budget.");
      }
      return {
        query: safeResearchQuery(normalizedQuery),
        source: "duckduckgo",
        fetchedAt: new Date().toISOString(),
        attempts: fetched.attempts,
        requestedMaxResults: maxResults,
        returnedResults: parsed.results.length,
        hasMore: parsed.hasMore,
        resultsTruncated: parsed.hasMore,
        ...(parsed.textTruncated ? { textTruncated: true } : {}),
        results: parsed.results,
        ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
      };
    } catch (error) {
      if (signal?.aborted) {
        throw new AppError("CANCELLED", "The research request was cancelled.", { cause: error });
      }
      if (this.closed) {
        throw researchClosingError(error);
      }
      if (timedOut) {
        throw new AppError("RESEARCH_TIMEOUT", `The research request exceeded its ${REQUEST_TIMEOUT_MS / 1_000}-second timeout.`, {
          retryable: true,
          details: { classification: "timeout", timeoutMs: REQUEST_TIMEOUT_MS },
          cause: error,
        });
      }
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError("RESEARCH_FAILED", "The research request failed.", {
        retryable: true,
        details: { classification: "unexpected", attempts: 1 },
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      release?.();
      this.activeControllers.delete(controller);
    }
  }
}

function cancelledResearchError(): AppError {
  return new AppError("CANCELLED", "The research request was cancelled.");
}

function researchClosingError(cause?: unknown): AppError {
  return new AppError("SERVER_CLOSING", "The research service is shutting down.", { retryable: true, cause });
}

async function fetchWithRetry(url: URL, signal: AbortSignal): Promise<{ response: Response; attempts: number }> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (signal.aborted) {
      throw new Error("Operation aborted");
    }
    let response: Response;
    try {
      response = await awaitWithAbort(
        fetch(url, { signal, redirect: "error", headers: { accept: "text/html" } }),
        signal,
      );
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      if (attempt >= MAX_ATTEMPTS) {
        throw new AppError("RESEARCH_FAILED", "The search request failed after bounded retries.", {
          retryable: true,
          details: { classification: "network", attempts: attempt, maxAttempts: MAX_ATTEMPTS },
          cause: error,
        });
      }
      await waitForRetry(retryDelayMs(undefined, attempt), signal);
      continue;
    }

    if (response.ok) {
      return { response, attempts: attempt };
    }

    const error = searchHttpError(response.status, attempt);
    discardResponseBody(response);
    if (!error.retryable || attempt >= MAX_ATTEMPTS) {
      throw error;
    }
    await waitForRetry(retryDelayMs(response.headers, attempt), signal);
  }

  // Defensive fallback ensures callers never receive an undefined response.
  throw new AppError("RESEARCH_FAILED", "The search request failed.", {
    retryable: true,
    details: { classification: "unexpected", attempts: MAX_ATTEMPTS },
  });
}

function searchHttpError(status: number, attempt: number): AppError {
  const normalizedStatus = Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : 0;
  const classification = normalizedStatus === 429
    ? "rate_limited"
    : normalizedStatus === 401 || normalizedStatus === 403 || normalizedStatus === 451
      ? "blocked"
      : normalizedStatus === 408 || normalizedStatus === 425 || normalizedStatus >= 500
        ? "transient"
        : "http_error";
  const retryable = classification === "rate_limited" || classification === "transient";
  const message = classification === "rate_limited"
    ? `The search provider rate-limited the request (HTTP ${normalizedStatus}); retry later.`
    : classification === "blocked"
      ? `The search provider blocked the request (HTTP ${normalizedStatus}); retry later or use a human browser check.`
      : `Search request returned HTTP ${normalizedStatus}.`;
  return new AppError("SEARCH_HTTP_ERROR", message, {
    retryable,
    details: { classification, status: normalizedStatus, attempts: attempt, maxAttempts: MAX_ATTEMPTS },
  });
}

function retryDelayMs(headers: Headers | undefined, attempt: number): number {
  const fallback = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1)));
  const retryAfter = parseRetryAfter(headers?.get("retry-after"));
  return Math.min(RETRY_MAX_DELAY_MS, retryAfter ?? fallback);
}

function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(0, Math.trunc(seconds * 1_000));
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return Math.max(0, timestamp - Date.now());
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw new Error("Operation aborted");
  }
  if (delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(resolve), delayMs);
    const onAbort = (): void => finish(() => reject(new Error("Operation aborted")));
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

function discardResponseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // A test double or non-standard Response body must not affect retry flow.
  }
}

function normalizeResearchQuery(query: string): string {
  return query
    .normalize("NFKC")
    .replace(CONTROL_CHARACTER_PATTERN, " ")
    .replace(ZERO_WIDTH_PATTERN, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function safeResearchQuery(query: string): string {
  const redacted = redactValue(query);
  return typeof redacted === "string" ? redacted : "[REDACTED]";
}

function isAntiBotResponse(html: string): boolean {
  // Only classify a response with no usable results. This avoids treating a
  // legitimate result about CAPTCHAs or rate limiting as a provider block.
  return ANTI_BOT_PATTERN.test(html.slice(0, MAX_RESPONSE_BYTES));
}

async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    throw new Error("Operation aborted");
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(new Error("Operation aborted")));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function parseResults(html: string, maxResults: number, maxChars: number, baseUrl: string): ParsedResults {
  // Parse one extra usable candidate so the response can explicitly tell the
  // caller that the result limit hid more data. Unsafe and duplicate links do
  // not consume that candidate slot.
  const candidates = parseResultCandidates(html, maxResults + 1, baseUrl);
  const results: ResearchItem[] = [];
  let textUsed = 0;
  let textTruncated = false;

  for (let index = 0; index < candidates.length && index < maxResults; index += 1) {
    const candidate = candidates[index];
    if (!candidate) continue;
    textTruncated ||= candidate.titleTruncated || candidate.snippetTruncated;
    const remaining = maxChars - textUsed;
    if (remaining <= 0) {
      textTruncated = true;
      break;
    }
    const boundedTitle = candidate.title.slice(0, remaining);
    textTruncated ||= boundedTitle.length < candidate.title.length;
    textUsed += boundedTitle.length;
    const snippetRemaining = Math.max(0, maxChars - textUsed);
    const boundedSnippet = candidate.snippet.slice(0, snippetRemaining);
    textTruncated ||= boundedSnippet.length < candidate.snippet.length;
    textUsed += boundedSnippet.length;
    results.push({
      title: wrapUntrustedText("research_title", boundedTitle, MAX_RESULT_TITLE_CHARS),
      url: candidate.url,
      untrustedUrl: wrapUntrustedText("research_url", safeResearchText(candidate.url, 4_096), 4_096),
      snippet: wrapUntrustedText("research_snippet", boundedSnippet, MAX_RESULT_SNIPPET_CHARS),
    });
  }

  return {
    results,
    hasMore: candidates.length > results.length,
    textTruncated,
  };
}

function parseResultCandidates(html: string, maxCandidates: number, baseUrl: string): ResultCandidate[] {
  const candidates: ResultCandidate[] = [];
  const seenUrls = new Set<string>();
  // Do not rely on a particular attribute order. DuckDuckGo has emitted both
  // `class`-before-`href` and `href`-before-`class` variants over time.
  // Reset the module-level scanner because this parser is synchronous and may
  // be called repeatedly for independent bounded responses.
  RESULT_ANCHOR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while (candidates.length < maxCandidates && (match = RESULT_ANCHOR_PATTERN.exec(html))) {
    const anchor = match[0];
    const tagEnd = anchor.indexOf(">");
    if (tagEnd < 0) {
      continue;
    }
    const openingTag = anchor.slice(0, tagEnd + 1);
    const classMatch = RESULT_CLASS_ATTRIBUTE_PATTERN.exec(openingTag);
    if (!classMatch?.[2].split(/\s+/).includes("result__a")) {
      continue;
    }
    const hrefMatch = RESULT_HREF_ATTRIBUTE_PATTERN.exec(openingTag);
    if (!hrefMatch) {
      continue;
    }
    const rawUrl = decodeEntities(hrefMatch[2]);
    const url = normalizeResultUrl(rawUrl, baseUrl);
    if (!url || seenUrls.has(url)) {
      continue;
    }
    seenUrls.add(url);
    const titleContent = anchor.slice(tagEnd + 1).replace(/<\/a>\s*$/i, "");
    const title = boundedResearchText(decodeEntities(stripTags(titleContent)).trim(), MAX_RESULT_TITLE_CHARS);
    const tailWindow = html.slice(match.index + match[0].length, match.index + match[0].length + 3_000);
    const nextResult = NEXT_RESULT_PATTERN.exec(tailWindow);
    const tail = nextResult ? tailWindow.slice(0, nextResult.index) : tailWindow;
    const snippetMatch = RESULT_SNIPPET_PATTERN.exec(tail);
    const snippet = snippetMatch
      ? boundedResearchText(decodeEntities(stripTags(snippetMatch[2])).trim(), MAX_RESULT_SNIPPET_CHARS)
      : { value: "", truncated: false };
    candidates.push({ title: title.value, titleTruncated: title.truncated, url, snippet: snippet.value, snippetTruncated: snippet.truncated });
  }
  return candidates;
}

function safeResearchText(value: string, maxChars: number): string {
  const redacted = redactValue(value);
  return typeof redacted === "string" ? redacted.slice(0, maxChars) : "";
}

function boundedResearchText(value: string, maxChars: number): { value: string; truncated: boolean } {
  const redacted = redactValue(value);
  const safe = typeof redacted === "string" ? redacted : "";
  return { value: safe.slice(0, maxChars), truncated: safe.length > maxChars };
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// Decode exactly once: named/numeric/hex entities first and `&amp;` last, so
// an escaped entity like `&amp;lt;` never collapses into a raw `<`.
function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code: string) => decodeCodePoint(code))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => decodeCodePoint(code, 16))
    .replace(/&amp;/g, "&");
}

function normalizeResultUrl(rawUrl: string, baseUrl: string): string | undefined {
  if (rawUrl.length > 16_384) {
    return undefined;
  }
  try {
    const url = new URL(rawUrl, baseUrl);
    const destination = url.searchParams.get("uddg");
    const resolved = destination === null ? url : new URL(destination, url.origin);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return undefined;
    }
    if (resolved.username || resolved.password) {
      // Credentials are not useful search-result evidence and must not be
      // passed through to a client, even in redacted form.
      resolved.username = "";
      resolved.password = "";
    }
    const sanitized = sanitizeUrl(resolved.toString());
    return sanitized.startsWith("[") || sanitized.length > 4_096 ? undefined : sanitized;
  } catch {
    return undefined;
  }
}

function safeResponseOrigin(responseUrl: string | undefined, fallback: string): string {
  let fallbackOrigin: URL | undefined;
  try {
    fallbackOrigin = new URL(fallback);
  } catch {
    // The fallback is generated from the policy-checked URL, but retain the
    // defensive default below if a non-standard policy test double returns an
    // invalid value.
  }
  for (const candidate of [responseUrl, fallback]) {
    if (!candidate) {
      continue;
    }
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") {
        if (fallbackOrigin && url.origin !== fallbackOrigin.origin) {
          continue;
        }
        return url.toString();
      }
    } catch {
      // Use the known policy-checked fallback below.
    }
  }
  return "https://html.duckduckgo.com/";
}

function decodeCodePoint(value: string, radix = 10): string {
  const codePoint = Number.parseInt(value, radix);
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "�";
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

async function readBoundedResponseText(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  if (!response.body) {
    // A network Response normally exposes a stream. Treat a body-less
    // response as empty instead of calling response.text(), whose fallback
    // implementation has no way to enforce a byte limit before allocation.
    return "";
  }
  const reader = response.body.getReader();
  const initialSize = Math.min(64 * 1024, maxBytes + 1);
  let buffer = new Uint8Array(Math.max(1, initialSize));
  let offset = 0;
  let cancelReader = false;
  try {
    while (true) {
      const result = await awaitWithAbort(reader.read(), signal);
      if (result.done) {
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        cancelReader = true;
        throw new AppError("RESEARCH_RESPONSE_INVALID", "The search response body was invalid.", {
          details: { classification: "invalid_response" },
        });
      }
      const chunk = result.value;
      // Check the complete chunk before copying so an overflowing response
      // cannot partially populate a retained buffer.
      if (chunk.byteLength > maxBytes - offset) {
        cancelReader = true;
        throw new AppError("RESEARCH_RESPONSE_TOO_LARGE", "The search response exceeded the safety limit.", {
          details: { classification: "response_too_large", maxBytes },
        });
      }
      const required = offset + chunk.byteLength;
      if (required > buffer.byteLength) {
        let nextLength = buffer.byteLength;
        while (nextLength < required) {
          nextLength = Math.min(maxBytes + 1, Math.max(nextLength * 2, required));
        }
        const expanded = new Uint8Array(nextLength);
        expanded.set(buffer.subarray(0, offset));
        buffer = expanded;
      }
      buffer.set(chunk, offset);
      offset = required;
    }
  } catch (error) {
    cancelReader = true;
    throw error;
  } finally {
    if (cancelReader) {
      void reader.cancel().catch(() => undefined);
    }
    try {
      reader.releaseLock();
    } catch {
      // Preserve the original response/abort error if a non-cooperative body
      // still has a pending read when its lock is released.
    }
  }
  return new TextDecoder().decode(buffer.subarray(0, offset));
}
