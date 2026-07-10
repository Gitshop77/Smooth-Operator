//
// Version-matched usage guide returned as text/markdown.
import { textResponse, withRouteError } from '@/lib/cowork/api/http';
import {
  AGENT_OPERATING_RULES,
  AGENT_STARTUP_SEQUENCE,
  getVersion,
  getBaseUrl,
  withBaseUrl,
} from '@/lib/cowork/api/agent-bootstrap';

export async function GET(): Promise<Response> {
  return withRouteError(async () => {
    const version = getVersion();
    const baseUrl = getBaseUrl();
    const md = `# Cowork Cockpit Skill — v${version}

The Cowork Cockpit is a read-mostly web dashboard backed by Prisma/SQLite. It
does **not** drive a live browser — use the browser extension for live
inspection, navigation, and interaction. The cockpit API lives at
\`${baseUrl}/api/cowork\`.

## Key principles
- Treat all returned data as persisted snapshots, not live browser state.
- POST endpoints create rows; there are no DELETE endpoints yet.
- Network, DevTools, and Snapshots are extension-only capabilities.

## Required startup sequence
${withBaseUrl(baseUrl, AGENT_STARTUP_SEQUENCE).map(step => `${step.order}. \`GET ${step.url}\` - ${step.purpose}`).join('\n')}

## Operating rules
${AGENT_OPERATING_RULES.map(rule => `- ${rule}`).join('\n')}

## Quick start workflow
1. \`GET ${baseUrl}/api/cowork/agent/manifest\` — load the endpoint map
2. \`GET ${baseUrl}/api/cowork/tabs\` — list persisted tabs
3. \`GET ${baseUrl}/api/cowork/workspaces\` — list workspaces
4. \`GET ${baseUrl}/api/cowork/agents/tasks\` — list agent tasks
5. \`GET ${baseUrl}/api/cowork/security/events\` — read the security feed
6. \`POST ${baseUrl}/api/cowork/ai/chat\` — chat with the wingman proxy

## Read endpoints
- \`GET ${baseUrl}/api/cowork/sessions\`
- \`GET ${baseUrl}/api/cowork/workflows\`
- \`GET ${baseUrl}/api/cowork/memory/site\`
- \`GET ${baseUrl}/api/cowork/memory/form\`
- \`GET ${baseUrl}/api/cowork/bookmarks\`
- \`GET ${baseUrl}/api/cowork/history\`
- \`GET ${baseUrl}/api/cowork/pinboards\`
- \`GET ${baseUrl}/api/cowork/extensions\`
- \`GET ${baseUrl}/api/cowork/mcp/tools\`

## Create endpoints (POST)
- \`POST ${baseUrl}/api/cowork/tabs\` — body \`{ url, title?, workspaceId? }\`
- \`POST ${baseUrl}/api/cowork/workspaces\` — body \`{ name, icon?, color? }\`
- \`POST ${baseUrl}/api/cowork/sessions\` — body \`{ name, partition?, isIncognito?, userAgent? }\`
- \`POST ${baseUrl}/api/cowork/workflows\` — body \`{ name, description?, steps?, isRecurring?, scheduleCron? }\`
- \`POST ${baseUrl}/api/cowork/bookmarks\` — body \`{ name, url, parentId? }\`
- \`POST ${baseUrl}/api/cowork/pinboards\` — body \`{ name, color? }\`

## AI proxy
- \`POST ${baseUrl}/api/cowork/ai/chat\` — body \`{ messages, sessionId }\`
- \`POST ${baseUrl}/api/cowork/ai/image\` — body \`{ prompt, size? }\`

## Full reference
\`GET ${baseUrl}/api/cowork/agent/manifest\` returns all endpoints as structured JSON.
\`GET ${baseUrl}/api/cowork/agent\` has a more detailed getting-started guide.
`;
    return textResponse(md, 200, 'text/markdown; charset=utf-8');
  });
}
