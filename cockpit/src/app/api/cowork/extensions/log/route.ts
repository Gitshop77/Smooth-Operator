import type { NextRequest } from 'next/server';
import { bodyJson, json, withRouteError, redactSecrets } from '@/lib/cowork/api/http';

// Cap each user-supplied field so a huge payload can't flood the log.
const MAX_LOG_FIELD_LEN = 4096;

// Strip CRLF from attacker-controlled log fields so a crafted `\n`/`\r` can't
// forge new log lines, and bound the length. Mirrors the SSE stream's
// existing `/[\r\n]/g` sanitization style.
function sanitizeLogField(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n]/g, ' ').slice(0, MAX_LOG_FIELD_LEN);
}

// Allowed log severities. The client's `level` is constrained to this set —
// anything unrecognized falls back to `info` rather than being stored/echoed
// verbatim (which previously made the unused-looking `LogLevel` type
// misleading, since any string was accepted at runtime).
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

// In-memory ring buffer so the Logs Explorer has a queryable feed within the
// process lifetime (it previously only wrote to stdout and persisted nothing).
// A proper cross-restart audit store would replace this, but the GET handler
// below now serves real data to the UI in the meantime.
const LOG_RING_MAX = 500;
const logRing: Array<{ ts: string; level: LogLevel; source: string; message: string; stack: string }> = [];

function pushLog(entry: { ts: string; level: LogLevel; source: string; message: string; stack: string }): void {
  logRing.push(entry);
  if (logRing.length > LOG_RING_MAX) logRing.splice(0, logRing.length - LOG_RING_MAX);
}

// Emit the structured log line at the severity the client requested, defaulting
// to `info` so informational/debug logs aren't all promoted to ERROR.
function emitLog(level: LogLevel, payload: { source: string; message: string; stack: string }): void {
  switch (level) {
    case 'debug':
      console.debug('[SW]', payload);
      break;
    case 'warn':
      console.warn('[SW]', payload);
      break;
    case 'error':
      console.error('[SW]', payload);
      break;
    case 'info':
    default:
      console.info('[SW]', payload);
      break;
  }
}

// Wrap the handler in `withRouteError` so any thrown error
// (e.g. a malformed body that somehow escapes `bodyJson`'s try/catch, or
// an internal console.error that throws on a non-string `stack`) returns
// a structured JSON 500 instead of an unhandled rejection that surfaces
// as an opaque HTML error page in the browser. Matches the pattern used
// by every other /api/cowork route.
export async function POST(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const b = await bodyJson(req);
    const {
      source,
      msg,
      stack,
      level,
    } = b as {
      source?: unknown;
      msg?: unknown;
      stack?: unknown;
      level?: unknown;
    };
 // Sanitize (CRLF-strip + length-cap) THEN redact secrets: the values have
 // already been stripped of CRLF + length-capped before redaction runs.
 // `sanitizeLogField` returns '' for any non-string input, so we fall back
 // with `||` (not `??`) — `??` would let a present non-nullish object slip
 // through un-stringified.
    const label = redactSecrets(sanitizeLogField(source) || 'SW');
    const detail = redactSecrets(sanitizeLogField(msg) || '(no message)');
    const stackField = redactSecrets(sanitizeLogField(stack));
 // Use structured (object) logging so the values can't break log-line
 // formatting. Respect the client's severity; default to info.
    const requested = typeof level === 'string' ? level.toLowerCase() : 'info';
    const lvl: LogLevel = (LOG_LEVELS as readonly string[]).includes(requested)
      ? (requested as LogLevel)
      : 'info';
    const entry = { ts: new Date().toISOString(), level: lvl, source: label, message: detail, stack: stackField };
    pushLog(entry);
    emitLog(lvl, { source: label, message: detail, stack: stackField });
    return json({ ok: true });
  }, req.headers.get('x-request-id') ?? undefined);
}

// Serve the in-memory ring buffer so the Logs Explorer can render real data
// instead of a permanently-empty standby list. Re-apply `redactSecrets` at read
// time (defense-in-depth): any secret shape the write-time regex missed is
// scrubbed here before it can be disclosed to an authenticated reader.
export async function GET(): Promise<Response> {
  return withRouteError(async () =>
    json({
      logs: logRing.map((e) => ({
        ...e,
        source: redactSecrets(e.source),
        message: redactSecrets(e.message),
        stack: redactSecrets(e.stack),
      })),
    }),
  );
}
