//
// Agent bootstrap contract. Only references endpoints that actually exist
// under /api/cowork/*. The web cockpit cannot drive a real browser, so the
// manifest advertises the implemented read, create (POST), and delete (DELETE)
// endpoints plus the agent-discovery routes.

import { COCKPIT_VERSION } from "@/lib/cowork/version";

/**
 * Single source of truth for the cockpit version. Re-exported from
 * `@/lib/cowork/version` so server-side routes can import it from this module
 * (alongside the rest of the bootstrap contract). The footer imports directly
 * from `version.ts` to avoid pulling server-only modules into the browser
 * bundle.
 */
export { COCKPIT_VERSION };

/**
 * Server-side base URL — never reflect the request's Host header. An attacker
 * who can set `Host` could otherwise redirect LLM agents consuming the
 * bootstrap / manifest to attacker-controlled URLs.
 */
function getCockpitBaseUrl(): string {
  const configured = process.env.COWORK_BASE_URL;
  if (configured) return configured;
  // Fail-closed in production: never advertise a localhost origin through the
  // agent discovery contract. A production deployment without COWORK_BASE_URL
  // should surface this loudly rather than silently pointing agents at
  // http://localhost:3000.
  if (process.env.NODE_ENV === "production") {
    console.error(
      "[agent-bootstrap] COWORK_BASE_URL is unset in a production deployment; " +
        "the agent bootstrap contract will not advertise an absolute base URL. " +
        "Set COWORK_BASE_URL to the deployed cockpit origin (https://…).",
    );
    return "";
  }
  return "http://localhost:3000";
}

/** Back-compat alias kept so existing call sites can migrate incrementally. */
export function getVersion(): string {
  return COCKPIT_VERSION;
}

/** Back-compat alias kept so existing call sites can migrate incrementally. */
export function getBaseUrl(): string {
  return getCockpitBaseUrl();
}

/**
 * Shared auth descriptor for the 5 public discovery routes. Each discovery
 * route is itself unauthenticated, so `authMethods: []` here means "this route
 * requires no auth". `dataRouteAuth` describes the broader API auth model so
 * an LLM agent that only reads one discovery route still knows to send the
 * `X-Cowork-Token` header for every other `/api/cowork/*` route.
 */
export const DISCOVERY_ROUTE_AUTH = {
  authMethods: [] as string[],
  dataRouteAuth: {
    methods: ["X-Cowork-Token"],
    description:
      "All /api/cowork/* routes except the 5 public discovery routes (/agent/bootstrap, /agent/manifest, /agent, /agent/version, /skill) require an X-Cowork-Token header matching the server-side secret. The server resolves the secret as COWORK_UI_TOKEN if set, otherwise falling back to COWORK_EVENT_TOKEN. No token is accepted by default; set a real secret (e.g. COWORK_UI_TOKEN) on the server, and optionally enable COWORK_ALLOW_DEV_TOKEN=1 for loopback dev only. Requests are rejected with 401 in production if no secret is configured or the well-known dev-token is used.",
  },
} as const;

/** HTTP transport descriptor reused by both /agent/version and /agent/manifest. */
export const HTTP_TRANSPORT = {
  http: { available: true, local: true, remote: false },
} as const;

export const CAPABILITY_FAMILIES = [
  'bootstrap',
  'agents',
  'tabs',
  'workspaces',
  'sessions',
  'workflows',
  'memory',
  'collections',
  'extensions',
  'security',
  'mcp',
  'ai',
  'events',
] as const;

// Startup sequence steps reference only endpoints that exist. Steps 1-3 are
// public discovery routes (no auth). Steps 4-5 require the X-Cowork-Token
// header — the agent must send `X-Cowork-Token: <COWORK_UI_TOKEN>` (falling
// back to `COWORK_EVENT_TOKEN`) on these.
export const AGENT_STARTUP_SEQUENCE = [
  { order: 1, endpoint: '/api/cowork/skill', auth: 'none', purpose: 'Read the version-matched operating guide before using the cockpit API.' },
  { order: 2, endpoint: '/api/cowork/agent/manifest', auth: 'none', purpose: 'Load the machine-readable capability and endpoint map.' },
  { order: 3, endpoint: '/api/cowork/agent/bootstrap', auth: 'none', purpose: 'Load runtime context and the agent toolbox.' },
  { order: 4, endpoint: '/api/cowork/tabs', auth: 'token', purpose: 'List the persisted tabs the cockpit knows about. Send X-Cowork-Token header.' },
  { order: 5, endpoint: '/api/cowork/workspaces', auth: 'token', purpose: 'List the persisted workspaces. Send X-Cowork-Token header.' },
] as const;

export const AGENT_OPERATING_RULES = [
  'The web cockpit is a read/create/delete dashboard backed by Prisma. It does not drive a live browser.',
  'POST endpoints create rows in SQLite; DELETE endpoints exist for /history, /memory/site, /memory/form, and /ai/chat.',
  'Never trigger a mass-deletion (?all=1 / delete-all) on /history or /ai/chat without explicit user confirmation — these wipe all stored rows.',
  'Treat all returned data as persisted snapshots, not live browser state.',
  'Network, DevTools, and Snapshots views are extension-only capabilities and are not exposed via this API.',
] as const;

const AGENT_TOOLBOX = {
  orient: [
    { method: 'GET', path: '/agent/bootstrap', use: 'First read after discovery.' },
    { method: 'GET', path: '/agent/manifest', use: 'Full endpoint map.' },
    { method: 'GET', path: '/tabs', use: 'List persisted tabs.' },
    { method: 'GET', path: '/workspaces', use: 'List persisted workspaces.' },
  ],
  read: [
    { method: 'GET', path: '/sessions', use: 'List persisted sessions.' },
    { method: 'GET', path: '/agents', use: 'List agent trust grants.' },
    { method: 'GET', path: '/agents/tasks', use: 'List agent tasks.' },
    { method: 'GET', path: '/workflows', use: 'List workflows.' },
    { method: 'GET', path: '/memory/site', use: 'Read per-site structured memory.' },
    { method: 'GET', path: '/memory/form', use: 'Read per-site form memory.' },
    { method: 'GET', path: '/bookmarks', use: 'Read the bookmark tree.' },
    { method: 'GET', path: '/history', use: 'Read browsing history.' },
    { method: 'GET', path: '/pinboards', use: 'List pinboards.' },
    { method: 'GET', path: '/extensions', use: 'List installed extensions.' },
    { method: 'GET', path: '/security/events', use: 'Read the security event feed.' },
    { method: 'GET', path: '/mcp/tools', use: 'Browse the MCP tool catalog.' },
  ],
  create: [
    { method: 'POST', path: '/tabs', use: 'Persist a new tab row.' },
    { method: 'POST', path: '/workspaces', use: 'Create a workspace.' },
    { method: 'POST', path: '/sessions', use: 'Create a session.' },
    { method: 'POST', path: '/workflows', use: 'Create a workflow.' },
    { method: 'POST', path: '/bookmarks', use: 'Add a bookmark.' },
    { method: 'POST', path: '/pinboards', use: 'Create a pinboard.' },
  ],
  chat: [
    { method: 'POST', path: '/ai/chat', use: 'Send a chat message to the wingman proxy.' },
    { method: 'POST', path: '/ai/image', use: 'Generate an image via the wingman proxy.' },
  ],
} as const;

export const AGENT_TOOL_SELECTION_HINTS = {
  '/tabs': {
    whenToUse: 'List persisted tabs. Supports an optional `workspaceId` query param and a `limit` query param.',
    preferredOver: [],
    requires: [],
    risk: 'low',
  },
  '/workspaces': {
    whenToUse: 'List or create workspaces. POST accepts `{ name, icon, color }`.',
    preferredOver: [],
    requires: [],
    risk: 'low',
  },
  '/ai/chat': {
    whenToUse: 'Send a chat completion request. Body: `{ messages, sessionId }`. Proxied to the cowork-events mini-service.',
    preferredOver: [],
    requires: ['The cowork-events mini-service running on port 3003'],
    risk: 'low',
  },
} as const;

export function withBaseUrl<T extends { endpoint: string }>(
  baseUrl: string,
  steps: readonly T[],
): Array<T & { url: string }> {
  return steps.map(step => ({ ...step, url: `${baseUrl}${step.endpoint}` }));
}

export function buildAgentBootstrapContract(baseUrl: string, version: string) {
  return {
    identity: {
      name: 'cowork-cockpit',
      version,
      role: 'web dashboard for persisted cowork data (read, create via POST, delete via DELETE)',
      baseUrl,
    },
    startupSequence: withBaseUrl(baseUrl, AGENT_STARTUP_SEQUENCE),
    docs: {
      humanReadable: `${baseUrl}/api/cowork/agent`,
      llmSkill: `${baseUrl}/api/cowork/skill`,
      machineManifest: `${baseUrl}/api/cowork/agent/manifest`,
      // The `/agent/bootstrap` route is PUBLIC (one of the 5
      // discovery routes that middleware.ts exempts from the X-Cowork-Token
      // check). `publicBootstrap` matches the AGENT_STARTUP_SEQUENCE entry
      // (`auth: 'none'`).
      publicBootstrap: `${baseUrl}/api/cowork/agent/bootstrap`,
    },
    primaryInteractionModel: 'read persisted data via REST; create via POST and remove via DELETE where available',
    capabilityFamilies: CAPABILITY_FAMILIES,
    operatingRules: AGENT_OPERATING_RULES,
    toolbox: AGENT_TOOLBOX,
    toolSelectionHints: AGENT_TOOL_SELECTION_HINTS,
  };
}
