import type { NextRequest } from 'next/server';
import { bodyJson, json, withRouteError } from '@/lib/cowork/api/http';

// Wrap the handler in `withRouteError` so any thrown error
// (e.g. a malformed body that somehow escapes `bodyJson`'s try/catch, or
// an internal console.error that throws on a non-string `stack`) returns
// a structured JSON 500 instead of an unhandled rejection that surfaces
// as an opaque HTML error page in the browser. Matches the pattern used
// by every other /api/cowork route.
export async function POST(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const b = await bodyJson(req);
    const { source, error, msg, stack } = b as { source?: string; error?: string; msg?: string; stack?: string };
    const label = source ?? error ?? 'SW';
    const detail = msg ?? '(no message)';
    console.error(`[SW:${label}] ${detail}${stack ? `\n  ${stack}` : ''}`);
    return json({ ok: true });
  });
}
