import type { NextRequest } from 'next/server';

/** Parse JSON request body.
 *
 * Returns `{}` for an empty/absent body so routes that accept optional bodies
 * keep working, but THROWS on malformed (non-empty) JSON. The throw is caught
 * by `withRouteError` and turned into a generic 400, so a malformed body can
 * no longer silently create a row with defaults (F-04b). */
export async function bodyJson(req: NextRequest): Promise<Record<string, unknown>> {
  if (!req.body) return {};
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Throw a safe, generic message (no raw parse detail) — `withRouteError`
    // maps it to a 400 via the "invalid" marker.
    throw new Error('Invalid JSON body');
  }
}

/** JSON Response helper. */
export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Plain-text Response helper. */
export function textResponse(data: string, status = 200, contentType = 'text/plain'): Response {
  return new Response(data, { status, headers: { 'content-type': contentType } });
}

/** Build a 400 response with a structured error. */
export function badRequest(error: string): Response {
  return json({ error }, 400);
}

/** Build a 500 response with a structured error. */
export function serverError(error: string): Response {
  return json({ error }, 500);
}

/** Validate that a URL string uses the http or https protocol.
 *  Returns `null` on success, or a 400 Response on failure.
 *
 * NOTE (F-17 / SSRF defense-in-depth): today the cockpit only STORES these
 * URLs (bookmarks/tabs) and never issues a server-side fetch or launch, so an
 * internal/private host is not yet an SSRF sink. When a URL from this catalog
 * is ever fetched or launched server-side, gate it with `isSsrfSafeUrl()`
 * first. We deliberately do NOT enforce `isSsrfSafeUrl` here, so that legitimate
 * localhost bookmarks keep working. */
export function validateHttpUrl(url: string): Response | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return badRequest('URL must be http or https');
    }
    return null;
  } catch {
    return badRequest('Invalid URL');
  }
}

/**
 * Returns `true` if the host of `url` is safe to fetch/launch from the server
 * — i.e. it is NOT a loopback, RFC1918 private, link-local, or cloud-metadata
 * address. Defense-in-depth guard for SSRF. The cockpit currently only stores
 * URLs (see `validateHttpUrl`), so this is not yet enforced; it is exported so
 * callers that begin issuing outbound requests or launching URLs can call it.
 */
export function isSsrfSafeUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  let host = parsed.hostname.toLowerCase();
  // Strip IPv6 bracket notation (`[::1]`) so comparisons below work.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  // Bare loopback / unspecified addresses.
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return false;
  // IPv6 link-local (fe80::/10) and unique-local (fc00::/7).
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return false;
  // IPv4 private / loopback / link-local / CGNAT ranges.
  if (isPrivateIpv4(host)) return false;
  return true;
}

function isPrivateIpv4(host: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  const parts = host.split('.').map(Number);
  if (parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (link-local, incl. cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 (CGNAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** Parse a `limit` query param with a default + max cap. */
export function parseLimit(req: NextRequest, defaultValue = 100, max = 200): number {
  return Math.max(1, Math.min(parseInt(req.nextUrl.searchParams.get('limit') || String(defaultValue), 10) || defaultValue, max));
}

function newCorrelationId(): string {
  try {
    // crypto.randomUUID is available in Node 19+ and the Edge runtime.
    return globalThis.crypto.randomUUID();
  } catch {
    return `err-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Markers indicating a client-facing validation/business error produced by our
 * own code (vs. an internal failure like a DB/FS error that may leak table or
 * column names, constraint details, or absolute filesystem paths). Only these
 * messages are safe to echo to the client (F-04a). */
const SAFE_MESSAGE_MARKERS = [
  'not found',
  'not implemented',
  'unauthorized',
  'forbidden',
  'invalid',
  'required',
  'must be',
];

/** Wrap an async route handler with try/catch that produces a JSON error. */
export async function withRouteError(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    const correlationId = newCorrelationId();
    // Always log the FULL error server-side (incl. stack) for diagnostics.
    console.error('[cowork route error]', correlationId, e instanceof Error ? (e.stack || e.message) : String(e));
    const message = e instanceof Error ? e.message : 'Internal server error';
    const lower = message.toLowerCase();

    // Map known message markers to the correct HTTP status (unchanged behavior).
    // NOTE: Prisma's internal "unique constraint"/"p2025" errors are intentionally
    // NOT mapped here — echoing them would leak table/column names (F-04a), so they
    // fall through to the generic 500 below.
    let status = 500;
    if (lower.includes('not found')) status = 404;
    else if (lower.includes('not implemented')) status = 501;
    else if (lower.includes('unauthorized') || lower.includes('forbidden')) status = 403;
    else if (lower.includes('invalid') || lower.includes('required') || lower.includes('must be')) status = 400;

    // Withhold the raw message from the client unless it is a known-safe
    // validation/business error. Internal errors get a generic keyed id so
    // operators can trace them via the server-log correlation id.
    const isSafe = SAFE_MESSAGE_MARKERS.some((m) => lower.includes(m));
    const error = isSafe ? message : 'internal_error';

    return json({ error, correlationId }, status);
  }
}
