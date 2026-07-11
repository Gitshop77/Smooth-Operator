//
// Public agent startup contract: bootstrap metadata.
// Static contract — the web cockpit has no live browser context.
// This route is PUBLIC (one of the 5 discovery routes exempted from the
// X-Cowork-Token middleware check).
import type { NextRequest } from 'next/server';
import { json, withRouteError } from '@/lib/cowork/api/http';
import {
  buildAgentBootstrapContract,
  getVersion,
  getBaseUrl,
} from '@/lib/cowork/api/agent-bootstrap';

export async function GET(req: NextRequest): Promise<Response> {
  // Thread the middleware-minted request id so a 500's correlationId matches
  // the `[cowork request]` log line and the response `x-request-id` header.
  const requestId = req.headers.get('x-request-id') ?? undefined;
  return withRouteError(async () => {
    const version = getVersion();
    const baseUrl = getBaseUrl();
    return json(buildAgentBootstrapContract(baseUrl, version));
  }, requestId);
}
