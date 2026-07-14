//
// Machine-readable manifest of the implemented endpoints under /api/cowork/*.
// The web cockpit is a dashboard backed by Prisma that supports reads, POST
// creates, and DELETE removals; it does not drive a live browser. This list is
// kept in sync with CAPABILITY_FAMILIES below: every advertised family has a
// matching entry under `endpoints`, and every entry here corresponds to a real
// route on disk, so agents that consume this manifest will never hit a 404.
import { json, withRouteError, sanitizeRequestId } from '@/lib/cowork/api/http';
import type { NextRequest } from 'next/server';
import {
  AGENT_OPERATING_RULES,
  AGENT_STARTUP_SEQUENCE,
  AGENT_TOOL_SELECTION_HINTS,
  CAPABILITY_FAMILIES,
  DISCOVERY_ROUTE_AUTH,
  HTTP_TRANSPORT,
  getVersion,
  getBaseUrl,
  withBaseUrl,
} from '@/lib/cowork/api/agent-bootstrap';

export async function GET(req?: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const version = getVersion();
    const baseUrl = getBaseUrl();
    const P = '/api/cowork';
    return json({
      name: 'cowork-cockpit',
      version,
      baseUrl,
      role: 'web dashboard for persisted cowork data (read, create via POST, delete via DELETE)',
 // This manifest endpoint is itself one of the 5 public discovery routes,
 // so `authMethods: []` here means "this route requires no auth to
 // access". The broader API auth model is described in `dataRouteAuth`
 // below — every other `/api/cowork/*` route requires the X-Cowork-Token
 // header.
      transports: HTTP_TRANSPORT,
      ...DISCOVERY_ROUTE_AUTH,
      pairingSupported: false,
      startupSequence: withBaseUrl(baseUrl, AGENT_STARTUP_SEQUENCE),
      primaryInteractionModel: 'read persisted data via REST; create via POST and remove via DELETE where available',
      operatingRules: AGENT_OPERATING_RULES,
      toolSelectionHints: AGENT_TOOL_SELECTION_HINTS,
      capabilityFamilies: CAPABILITY_FAMILIES,
      endpoints: {
        bootstrap: {
          agent: { method: 'GET', path: `${P}/agent`, description: 'Human-readable bootstrap page' },
          version: { method: 'GET', path: `${P}/agent/version`, description: 'Version and capability summary' },
          bootstrap: { method: 'GET', path: `${P}/agent/bootstrap`, description: 'Agent bootstrap contract with runtime context' },
          manifest: { method: 'GET', path: `${P}/agent/manifest`, description: 'This manifest' },
          skill: { method: 'GET', path: `${P}/skill`, description: 'Version-matched usage guide' },
        },
        tabs: {
          list: { method: 'GET', path: `${P}/tabs`, description: 'List persisted tabs (optional `workspaceId`, `limit`)' },
          open: { method: 'POST', path: `${P}/tabs`, description: 'Persist a new tab row (body: `{ url, title?, workspaceId? }`)' },
        },
        workspaces: {
          list: { method: 'GET', path: `${P}/workspaces`, description: 'List persisted workspaces' },
          create: { method: 'POST', path: `${P}/workspaces`, description: 'Create a workspace (body: `{ name, icon?, color? }`)' },
        },
        sessions: {
          list: { method: 'GET', path: `${P}/sessions`, description: 'List persisted sessions' },
          create: { method: 'POST', path: `${P}/sessions`, description: 'Create a session (body: `{ name, partition?, isIncognito?, userAgent? }`)' },
        },
        agents: {
          list: { method: 'GET', path: `${P}/agents`, description: 'List agent trust grants (optional `agentId`)' },
          tasks: { method: 'GET', path: `${P}/agents/tasks`, description: 'List agent tasks (optional `status`, `agentId`)' },
        },
        workflows: {
          list: { method: 'GET', path: `${P}/workflows`, description: 'List workflows' },
          create: { method: 'POST', path: `${P}/workflows`, description: 'Create a workflow (body: `{ name, description?, steps?, isRecurring?, scheduleCron? }`)' },
        },
        memory: {
          site: { method: 'GET', path: `${P}/memory/site`, description: 'Read per-site structured memory' },
          deleteSite: { method: 'DELETE', path: `${P}/memory/site`, description: 'Erase one per-site memory entry (?id=<id>)' },
          form: { method: 'GET', path: `${P}/memory/form`, description: 'Read per-site form memory' },
          deleteForm: { method: 'DELETE', path: `${P}/memory/form`, description: 'Erase one form-memory entry (?id=<id>)' },
        },
        collections: {
          bookmarks: { method: 'GET', path: `${P}/bookmarks`, description: 'Read the bookmark tree' },
          addBookmark: { method: 'POST', path: `${P}/bookmarks`, description: 'Add a bookmark or folder (body: `{ name, url?, parentId?, type?: "url" | "folder" }`)' },
          history: { method: 'GET', path: `${P}/history`, description: 'Read browsing history' },
          deleteHistory: { method: 'DELETE', path: `${P}/history`, description: 'Erase one browsing-history entry (?id=<id>)' },
          pinboards: { method: 'GET', path: `${P}/pinboards`, description: 'List pinboards' },
          addPinboard: { method: 'POST', path: `${P}/pinboards`, description: 'Create a pinboard (body: `{ name, color? }`)' },
        },
        extensions: {
          list: { method: 'GET', path: `${P}/extensions`, description: 'List installed extensions (optional `enabled`)' },
          log: { method: 'POST', path: `${P}/extensions/log`, description: 'Append an extension log entry' },
        },
        security: {
          events: { method: 'GET', path: `${P}/security/events`, description: 'Read the security event feed' },
        },
        mcp: {
          tools: { method: 'GET', path: `${P}/mcp/tools`, description: 'Browse the MCP tool catalog' },
        },
        ai: {
          chat: { method: 'POST', path: `${P}/ai/chat`, description: 'Send a chat completion (body: `{ messages, sessionId }`)' },
          deleteChat: { method: 'DELETE', path: `${P}/ai/chat`, description: 'Erase chat messages: ?messageId=<id> or ?sessionId=<id>' },
          image: { method: 'POST', path: `${P}/ai/image`, description: 'Generate an image (body: `{ prompt, size? }`)' },
        },
        events: {
          emit: { method: 'POST', path: `${P}/events/emit`, description: 'Emit an event to a channel (body: `{ channel, payload? }`)' },
          stream: { method: 'GET', path: `${P}/events/stream`, description: 'Subscribe to the SSE event stream (requires the X-Cowork-Token header)' },
        },
      },
    }, 200, {
      'cache-control': 'public, max-age=300, stale-while-revalidate=60',
    });
  }, sanitizeRequestId(req?.headers.get('x-request-id') ?? null));
}
