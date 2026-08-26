import { AppError } from "./errors";
import { Logger } from "./logger";
import { SecurityPolicy } from "./policy";
import { redactSecretPlaceholders, wrapUntrustedText } from "./security";
import { sanitizeUrl } from "./browser/utils";

const MAX_QUERY_CHARS = 4_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 30_000;

interface ResearchResult {
  query: string;
  source: "duckduckgo";
  fetchedAt: string;
  results: Array<{ title: string; url: string; untrustedUrl: string; snippet: string }>;
  warning?: string;
}

export class ResearchService {
  constructor(
    private readonly policy: SecurityPolicy,
    private readonly logger: Logger,
  ) {}

  async research(query: string, options: { maxResults?: number; maxChars?: number } = {}, signal?: AbortSignal): Promise<ResearchResult> {
    if (typeof query !== "string") {
      throw new AppError("RESEARCH_INVALID", "A non-empty research query is required.");
    }
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new AppError("RESEARCH_INVALID", "A non-empty research query is required.");
    }
    if (normalizedQuery.length > MAX_QUERY_CHARS) {
      throw new AppError("RESEARCH_INVALID", `Research queries must be ${MAX_QUERY_CHARS} characters or shorter.`);
    }
    const maxResults = boundedInteger(options.maxResults, 5, 1, 10);
    // maxChars is an aggregate budget for textual fields only.
    const maxChars = boundedInteger(options.maxChars, 20_000, 500, 50_000);
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
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
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
      const response = await awaitWithAbort(
        fetch(url, { signal: controller.signal, redirect: "error", headers: { accept: "text/html" } }),
        controller.signal,
      );
      if (!response.ok) {
        throw new AppError("SEARCH_HTTP_ERROR", `Search request returned HTTP ${response.status}.`, { retryable: response.status >= 500 });
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw new AppError("RESEARCH_RESPONSE_TOO_LARGE", "The search response exceeded the safety limit.");
      }
      const html = await readBoundedResponseText(response, MAX_RESPONSE_BYTES, controller.signal);
      // `redirect: error` keeps the fetch target bounded, while the response
      // URL still gives the parser the correct origin for protocol-relative
      // and relative result links in DuckDuckGo's HTML.
      const resultOrigin = safeResponseOrigin(response.url, url.toString());
      const results = parseResults(html, maxResults, maxChars, resultOrigin);
      this.logger.info("Research completed", { resultCount: results.length });
      return {
        query: normalizedQuery,
        source: "duckduckgo",
        fetchedAt: new Date().toISOString(),
        results,
        ...(results.length === 0 ? { warning: "No parseable search results were returned." } : {}),
      };
    } catch (error) {
      if (signal?.aborted) {
        throw new AppError("CANCELLED", "The research request was cancelled.", { cause: error });
      }
      if (timedOut) {
        throw new AppError("RESEARCH_TIMEOUT", `The research request exceeded its ${REQUEST_TIMEOUT_MS / 1_000}-second timeout.`, { retryable: true, cause: error });
      }
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError("RESEARCH_FAILED", "The research request failed.", { retryable: true, cause: error });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
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

function parseResults(html: string, maxResults: number, maxChars: number, baseUrl: string): Array<{ title: string; url: string; untrustedUrl: string; snippet: string }> {
  const results: Array<{ title: string; url: string; untrustedUrl: string; snippet: string }> = [];
  let textUsed = 0;
  // Do not rely on a particular attribute order.  DuckDuckGo has emitted
  // both `class`-before-`href` and `href`-before-`class` variants over time.
  const pattern = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  let match: RegExpExecArray | null;
  while (results.length < maxResults && (match = pattern.exec(html))) {
    const anchor = match[0];
    const tagEnd = anchor.indexOf(">");
    if (tagEnd < 0) {
      continue;
    }
    const openingTag = anchor.slice(0, tagEnd + 1);
    const classMatch = /\bclass\s*=\s*(["'])([^"']*)\1/i.exec(openingTag);
    if (!classMatch?.[2].split(/\s+/).includes("result__a")) {
      continue;
    }
    const hrefMatch = /\bhref\s*=\s*(["'])([^"']*)\1/i.exec(openingTag);
    if (!hrefMatch) {
      continue;
    }
    const rawUrl = decodeEntities(hrefMatch[2]);
    const url = normalizeResultUrl(rawUrl, baseUrl);
    if (!url) {
      continue;
    }
    const titleContent = anchor.slice(tagEnd + 1).replace(/<\/a>\s*$/i, "");
    const title = redactSecretPlaceholders(decodeEntities(stripTags(titleContent)).trim()).slice(0, 500);
    const tailWindow = html.slice(match.index + match[0].length, match.index + match[0].length + 3_000);
    const nextResult = /<a\b[^>]*\bclass\s*=\s*(["'])[^"']*\bresult__a\b[^"']*\1/i.exec(tailWindow);
    const tail = nextResult ? tailWindow.slice(0, nextResult.index) : tailWindow;
    const snippetMatch = /\bclass\s*=\s*(["'])[^"']*\bresult__snippet\b[^"']*\1[^>]*>([\s\S]*?)<\/[^>]+>/i.exec(tail);
    const snippet = snippetMatch ? redactSecretPlaceholders(decodeEntities(stripTags(snippetMatch[2])).trim()).slice(0, 4_000) : "";
    const remaining = maxChars - textUsed;
    if (remaining <= 0) {
      break;
    }
    const boundedTitle = title.slice(0, remaining);
    textUsed += boundedTitle.length;
    const snippetRemaining = maxChars - textUsed;
    const boundedSnippet = snippet.slice(0, Math.max(0, snippetRemaining));
    textUsed += boundedSnippet.length;
    results.push({
      title: wrapUntrustedText("research_title", boundedTitle, 500),
      url,
      untrustedUrl: wrapUntrustedText("research_url", redactSecretPlaceholders(url), 4_096),
      snippet: wrapUntrustedText("research_snippet", boundedSnippet, 4_000),
    });
  }
  return results;
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
    return sanitized.startsWith("[") ? undefined : sanitized;
  } catch {
    return undefined;
  }
}

function safeResponseOrigin(responseUrl: string | undefined, fallback: string): string {
  for (const candidate of [responseUrl, fallback]) {
    if (!candidate) {
      continue;
    }
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") {
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
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancelReader = false;
  try {
    while (true) {
      const result = await awaitWithAbort(reader.read(), signal);
      if (result.done) {
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        cancelReader = true;
        throw new AppError("RESEARCH_RESPONSE_INVALID", "The search response body was invalid.");
      }
      total += result.value.byteLength;
      if (total > maxBytes) {
        cancelReader = true;
        throw new AppError("RESEARCH_RESPONSE_TOO_LARGE", "The search response exceeded the safety limit.");
      }
      chunks.push(result.value);
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
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
