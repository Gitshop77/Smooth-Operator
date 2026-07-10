//
// POST /api/cowork/ai/image
//   Body: { prompt: string, size?: ImageSize }
//   Forwards to the cowork-events mini-service at http://localhost:3003/image
//   which uses z-ai-web-dev-sdk to generate an image.
//
// Returns: { ok: true, base64, prompt, size, bytes } on success, or
//          { ok: false, error } on failure.

import type { NextRequest } from 'next/server';
import { json, badRequest, serverError, withRouteError } from '@/lib/cowork/api/http';
import { COWORK_EVENTS_BASE, COWORK_EVENTS_TOKEN } from '@/lib/cowork/events/client';

type ImageSize =
  | '1024x1024'
  | '768x1344'
  | '864x1152'
  | '1344x768'
  | '1152x864'
  | '1440x720'
  | '720x1440';

interface ImageProxyBody {
  prompt?: string;
  size?: ImageSize;
}

const SUPPORTED_SIZES: ImageSize[] = [
  '1024x1024',
  '768x1344',
  '864x1152',
  '1344x768',
  '1152x864',
  '1440x720',
  '720x1440',
];

export async function POST(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    let body: ImageProxyBody;
    try {
      body = (await req.json()) as ImageProxyBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

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

    let upstream: Response;
    try {
      upstream = await fetch(`${COWORK_EVENTS_BASE}/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Cowork-Token': COWORK_EVENTS_TOKEN },
        body: JSON.stringify({ prompt: body.prompt, size: body.size }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return serverError(`cowork-events unreachable: ${msg}`);
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return serverError(`cowork-events /image ${upstream.status}: ${text.slice(0, 200)}`);
    }

    const data = await upstream.json();
    return json(data);
  });
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
    upstream: `${COWORK_EVENTS_BASE}/image`,
  });
}
