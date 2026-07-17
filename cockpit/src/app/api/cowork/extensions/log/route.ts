import type { NextRequest } from 'next/server';
import { bodyJson, json, withRouteError, redactSecrets, sanitizeRequestId } from '@/lib/cowork/api/http';

// Cap each user-supplied field so a huge payload can't flood the log.
const MAX_LOG_FIELD_LEN = 4096;

// Strip CRLF from attacker-controlled log fields so a crafted `\n`/`\r` can't
// forge new log lines, and bound the length. Mirrors the SSE stream's
// existing `/[\r\n]/g` sanitization style.
function sanitizeLogField(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n]/g, ' ').slice(0, MAX_LOG_FIELD_LEN);
}

// Allowed log severities; an unrecognized `level` falls back to `info`.
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

// In-memory ring buffer so the Logs Explorer has a queryable feed within the
// process lifetime. Does not persist across restarts.
const LOG_RING_MAX = 500;
const logRing: Array<{ ts: string; level: LogLevel; source: string; message: string; stack: string }> = [];

function pushLog(entry: { ts: string; level: LogLevel; source: string; message: string; stack: string }): void {
  logRing.push(entry);
  if (logRing.length > LOG_RING_MAX) logRing.shift();
}

// Emit the structured log line at the requested severity, defaulting to `info`.
function emitLog(level: LogLevel, payload: { source: string; message: string; stack: string }): void {
  const loggers: Record<LogLevel, (...args: unknown[]) => void> = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  (loggers[level] ?? console.info)('[SW]', payload);
}

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
 // Sanitize (CRLF-strip + length-cap) THEN redact secrets. `sanitizeLogField`
 // returns '' for non-string input, so `||` (not `??`) supplies the fallback.
    const label = redactSecrets(sanitizeLogField(source) || 'SW');
    const detail = redactSecrets(sanitizeLogField(msg) || '(no message)');
    const stackField = redactSecrets(sanitizeLogField(stack));
    const requested = typeof level === 'string' ? level.toLowerCase() : 'info';
    const lvl: LogLevel = (LOG_LEVELS as readonly string[]).includes(requested)
      ? (requested as LogLevel)
      : 'info';
    const entry = { ts: new Date().toISOString(), level: lvl, source: label, message: detail, stack: stackField };
    pushLog(entry);
    emitLog(lvl, { source: label, message: detail, stack: stackField });
    return json({ ok: true });
  }, sanitizeRequestId(req.headers.get('x-request-id')));
}

// Serve the in-memory ring buffer to the Logs Explorer. Re-apply `redactSecrets`
// at read time (defense-in-depth) so any secret the write-time regex missed is
// scrubbed before disclosure to an authenticated reader.
//
// SINGLE-TENANT BY DESIGN: the cockpit authenticates every caller against a
// single shared `X-Cowork-Token` (see `middleware.ts` / the ai/chat DELETE
// trust model) — there is no per-principal isolation, so this blanket
// disclosure of extension logs to any authenticated reader is an intentional,
// reviewed decision. Do NOT add per-principal scoping without revisiting that
// single-tenant design first.
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
