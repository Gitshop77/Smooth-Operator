//
// POST /api/cowork/ai/image
// Body: { prompt: string, size?: ImageSize }
// Forwards to the cowork-events mini-service at http://localhost:3003/image
// which uses z-ai-web-dev-sdk to generate an image.
//
// Returns: { ok: true, base64, prompt, size, bytes } on success, or
// { ok: false, error } on failure.

import type { NextRequest } from 'next/server';
import { json, badRequest, serverError, withRouteError, bodyJson, redactSecrets, sanitizeRequestId, readCappedUpstream } from '@/lib/cowork/api/http';
import { getCoworkEventsToken, getValidatedEventsBase } from '@/lib/cowork/events/client';

const SUPPORTED_SIZES = [
  '1024x1024',
  '768x1344',
  '864x1152',
  '1344x768',
  '1152x864',
  '1440x720',
  '720x1440',
] as const;
type ImageSize = (typeof SUPPORTED_SIZES)[number];

interface ImageProxyBody {
  prompt?: string;
  size?: ImageSize;
}

export async function POST(req: NextRequest): Promise<Response> {
  const reqId = sanitizeRequestId(req.headers?.get('x-request-id'));
  return withRouteError(async () => {
 // `bodyJson` caps the raw body at MAX_BODY_BYTES (256KB) and rejects
 // oversize bodies with 413 *before* buffering — `req.json()` would read
 // the entire body into memory unbounded (memory-exhaustion DoS).
    const body = (await bodyJson(req)) as ImageProxyBody;

    if (!body.prompt || typeof body.prompt !== 'string' || !body.prompt.trim()) {
      return badRequest('prompt required (non-empty string)');
    }
 // Cap prompt length so an authenticated caller can't proxy a 10MB
 // prompt through to the image-generation mini-service.
    if (body.prompt.length > 4_000) {
      return badRequest('prompt must be at most 4000 chars');
    }
    if (body.size && !SUPPORTED_SIZES.includes(body.size)) {
      return badRequest(`size must be one of: ${SUPPORTED_SIZES.join(', ')}`);
    }

 // Read the token *outside* the try (mirror `client.ts`) so a missing-secret
 // failure surfaces as its true cause instead of being re-wrapped by the
 // catch below as the misleading "cowork-events unreachable".
    const coworkToken = getCoworkEventsToken();

 // Fail closed on a misconfigured relay target (mirrors `broadcastEvent`):
 // never forward the S2S token to a non-http(s) / credentialed / secret-shaped
 // base. The 60s route budget is unchanged.
    const eventsBase = getValidatedEventsBase();
    if (!eventsBase) {
      return serverError('cowork-events relay base misconfigured');
    }

    let upstream: Response;
    try {
      upstream = await fetch(`${eventsBase}/image`, {
        method: 'POST',
        signal: AbortSignal.timeout(60_000),
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          'X-Cowork-Token': coworkToken,
 // Forward the cockpit request id for correlation with the mini-service.
          ...(reqId ? { 'x-request-id': reqId } : {}),
        },
        body: JSON.stringify({ prompt: body.prompt, size: body.size }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return serverError(`cowork-events unreachable: ${msg}`);
    }

    if (!upstream.ok) {
      const text = await readCappedUpstream(upstream, 25 * 1024 * 1024).catch(() => '');
 // Do not forward raw upstream error text to the client — log server-side
 // and return a generic message.
      console.error('[cowork] /image upstream failed', { status: upstream.status, body: redactSecrets(text.slice(0, 200)) });
      return serverError(`cowork-events /image request failed (status ${upstream.status})`);
    }

 // Parse the upstream JSON payload. A 200 with a non-JSON body (HTML error
 // page, truncated payload) is an upstream contract violation, not a generic
 // 500 — surface it as such. The success path is capped the same way as the
 // error path (readCappedUpstream, 25 MiB) so a misbehaving/compromised
 // mini-service cannot exhaust cockpit worker memory with an oversized body.
    let data: unknown;
    try {
      data = JSON.parse(await readCappedUpstream(upstream, 25 * 1024 * 1024));
    } catch {
      return serverError('cowork-events /image returned a non-JSON body');
    }
    return json(data);
  }, reqId);
}

export async function GET(): Promise<Response> {
  return json({
    route: '/api/cowork/ai/image',
    method: 'POST',
    body: {
      prompt: 'string (required)',
      size: `one of: ${SUPPORTED_SIZES.join(', ')} (default 1024x1024)`,
    },
    response: '{ ok, base64, prompt, size, bytes }',
 // Intentionally do NOT disclose the internal mini-service base URL
 // (COWORK_EVENTS_BASE) — it reveals internal infrastructure topology that
 // clients do not need and that could aid network mapping.
    upstream: '(internal cowork-events endpoint)',
  });
}
