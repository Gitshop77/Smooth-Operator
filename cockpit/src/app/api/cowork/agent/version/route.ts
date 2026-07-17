import type { NextRequest } from 'next/server';
import { json, withRouteError, sanitizeRequestId } from '@/lib/cowork/api/http';
import {
  CAPABILITY_FAMILIES,
  DISCOVERY_ROUTE_AUTH,
  HTTP_TRANSPORT,
  COCKPIT_VERSION,
} from '@/lib/cowork/api/agent-bootstrap';

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    return json({
      name: 'cowork-cockpit',
      version: COCKPIT_VERSION,
      capabilityFamilies: CAPABILITY_FAMILIES,
 // Align with `/agent/manifest` (the source of truth). The cockpit is a
 // read-mostly web dashboard exposed over same-origin HTTP — there is no
 // remote HTTP transport. The `/api/cowork/mcp/tools` endpoint is a
 // STATIC CATALOG GET, not an MCP server, so it advertises no MCP
 // transport (local or remote).
      transports: HTTP_TRANSPORT,
 // This version endpoint is itself one of the 5 public discovery routes,
 // so `authMethods: []` means "this route requires no auth to access".
 // The broader API auth model is described in `dataRouteAuth` — every
 // other `/api/cowork/*` route requires the X-Cowork-Token header. Keeps
 // the discovery surface self-describing so an LLM agent that only reads
 // `/agent/version` knows it must send the token for data routes.
      ...DISCOVERY_ROUTE_AUTH,
      pairingSupported: false,
    }, 200, {
      'cache-control': 'public, max-age=300',
    });
  }, sanitizeRequestId(req?.headers.get('x-request-id') ?? null));
}
