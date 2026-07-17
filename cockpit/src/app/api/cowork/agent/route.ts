import type { NextRequest } from 'next/server';
import { textResponse, withRouteError, sanitizeRequestId } from '@/lib/cowork/api/http';
import {
  AGENT_OPERATING_RULES,
  AGENT_STARTUP_SEQUENCE,
  CAPABILITY_FAMILIES,
  getVersion,
  getBaseUrl,
  withBaseUrl,
} from '@/lib/cowork/api/agent-bootstrap';

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const version = getVersion();
    const baseUrl = getBaseUrl();
    const md = `# Cowork Cockpit — Agent Bootstrap

**Version:** ${version}
**Base URL:** \`${baseUrl}\`
**Role:** Read-mostly web dashboard for persisted cowork data.

The web cockpit is a Next.js app backed by Prisma/SQLite. It does **not** drive
a live browser — there is no \`/status\`, \`/browser/navigate\`, \`/snapshots\`,
\`/devtools/*\`, or \`/network/*\` endpoint. Those capabilities live in the
browser extension. The cockpit exposes only the REST routes listed in the
manifest.

## Required agent startup sequence

${withBaseUrl(baseUrl, AGENT_STARTUP_SEQUENCE).map(step => `${step.order}. \`GET ${step.url}\` - ${step.purpose}`).join('\n')}

## Operating rules
${AGENT_OPERATING_RULES.map(rule => `- ${rule}`).join('\n')}

## Using the cockpit API

All endpoints live under \`${baseUrl}/api/cowork\`. **All \`/api/cowork/*\` routes
except the 5 public discovery routes require an \`X-Cowork-Token\` header.** Requests
without a valid token are rejected with 401. Obtain the token from the cockpit
operator. The 5 public discovery routes (no auth required) are: \`/agent/bootstrap\`,
\`/agent/manifest\`, \`/agent\`, \`/agent/version\`, and \`/skill\`. POST
endpoints create rows in SQLite; DELETE endpoints exist for \`/history\`,
\`/memory/site\`, \`/memory/form\`, and \`/ai/chat\` (see Operating rules for the
mass-deletion caution below).

### Data you can read
- \`GET ${baseUrl}/api/cowork/tabs\` — persisted tabs
- \`GET ${baseUrl}/api/cowork/workspaces\` — workspaces
- \`GET ${baseUrl}/api/cowork/sessions\` — sessions
- \`GET ${baseUrl}/api/cowork/agents\` — agent trust grants
- \`GET ${baseUrl}/api/cowork/agents/tasks\` — agent tasks
- \`GET ${baseUrl}/api/cowork/workflows\` — workflows
- \`GET ${baseUrl}/api/cowork/memory/site\` — per-site structured memory
- \`GET ${baseUrl}/api/cowork/memory/form\` — per-site form memory
- \`GET ${baseUrl}/api/cowork/bookmarks\` — bookmark tree
- \`GET ${baseUrl}/api/cowork/history\` — browsing history
- \`GET ${baseUrl}/api/cowork/pinboards\` — pinboards
- \`GET ${baseUrl}/api/cowork/extensions\` — installed extensions
- \`GET ${baseUrl}/api/cowork/security/events\` — security event feed
- \`GET ${baseUrl}/api/cowork/mcp/tools\` — MCP tool catalog

### Data you can create (POST)
- \`POST ${baseUrl}/api/cowork/tabs\` — persist a tab
- \`POST ${baseUrl}/api/cowork/workspaces\` — create a workspace
- \`POST ${baseUrl}/api/cowork/sessions\` — create a session
- \`POST ${baseUrl}/api/cowork/workflows\` — create a workflow
- \`POST ${baseUrl}/api/cowork/bookmarks\` — add a bookmark
- \`POST ${baseUrl}/api/cowork/pinboards\` — create a pinboard
- \`POST ${baseUrl}/api/cowork/extensions/log\` — append an extension log entry

### Data you can delete (DELETE)
- \`DELETE ${baseUrl}/api/cowork/history?id=<historyEntryId>\` — erase one history entry
- \`DELETE ${baseUrl}/api/cowork/memory/site?id=<id>\` — erase one per-site memory entry
- \`DELETE ${baseUrl}/api/cowork/memory/form?id=<id>\` — erase one form-memory entry
- \`DELETE ${baseUrl}/api/cowork/ai/chat?messageId=<id>\` or \`?sessionId=<id>\` — erase chat message(s)

**Mass-deletion hazard:** Bulk erasure of stored data requires explicit server-side confirmation; the agent must never autoconfirm a bulk erase.

### AI proxy
- \`POST ${baseUrl}/api/cowork/ai/chat\` — chat completion (proxied to cowork-events)
- \`POST ${baseUrl}/api/cowork/ai/image\` — image generation (proxied to cowork-events)

## Discovery
- \`GET ${baseUrl}/api/cowork/agent/bootstrap\` — this contract as JSON
- \`GET ${baseUrl}/api/cowork/agent/manifest\` — full machine-readable manifest (JSON)
- \`GET ${baseUrl}/api/cowork/agent/version\` — version and capability summary (JSON)
- \`GET ${baseUrl}/api/cowork/skill\` — version-matched usage guide

## Capability families
${CAPABILITY_FAMILIES.map(f => `- ${f}`).join('\n')}
`;
    return textResponse(md, 200, 'text/markdown; charset=utf-8', {
      'cache-control': 'public, max-age=300',
    });
  }, sanitizeRequestId(req.headers.get('x-request-id')));
}
