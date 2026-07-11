import type { NextRequest } from 'next/server';
import { bodyJson, json, withRouteError } from '@/lib/cowork/api/http';

// Cap each user-supplied field so a huge payload can't flood the log.
const MAX_LOG_FIELD_LEN = 4096;

// Strip CRLF from attacker-controlled log fields so a crafted `\n`/`\r` can't
// forge new log lines, and bound the length. Mirrors the SSE stream's
// existing `/[\r\n]/g` sanitization style.
function sanitizeLogField(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n]/g, ' ').slice(0, MAX_LOG_FIELD_LEN);
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
    const { source, error, msg, stack } = b as { source?: unknown; error?: unknown; msg?: unknown; stack?: unknown };
    const label = sanitizeLogField(source ?? error ?? 'SW');
    const detail = sanitizeLogField(msg ?? '(no message)');
    const stackField = sanitizeLogField(stack);
    // Use structured (object) logging so the values can't break log-line
    // formatting, and they've already been stripped of CRLF + length-capped.
    console.error('[SW]', { source: label, message: detail, stack: stackField });
    return json({ ok: true });
  });
}
