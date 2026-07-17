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
export function getCockpitBaseUrl(): string {
  let configured = process.env.COWORK_BASE_URL;
  if (configured) {
 // Defense-in-depth: the value is concatenated into agent-facing URLs. Reject
 // a non-http(s) scheme (e.g. `javascript:`) the same way the rest of the
 // codebase gates outbound URLs, failing closed rather than echoing a
 // dangerous origin through to consuming LLM agents.
    try {
      const parsed = new URL(configured);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        console.error(
          "[agent-bootstrap] COWORK_BASE_URL has a non-http(s) scheme; " +
            "refusing to advertise it through the agent bootstrap contract.",
        );
        return "";
      }
 // Fail-closed on embedded credentials: a base URL like
 // `https://user:secret@example.com` would otherwise be concatenated into
 // agent-facing URLs and leak the secret through logs/LLM agents. This parallels
 // the existing non-http(s) rejection.
      if (parsed.username || parsed.password) {
        console.error(
          "[agent-bootstrap] COWORK_BASE_URL contains credentials; refusing " +
            "to advertise it through the agent bootstrap contract.",
        );
        return "";
      }
 // Fail-closed on embedded query/fragment in the base URL: a URL such as
 // `https://cockpit.internal?apikey=SECRET` would otherwise be concatenated
 // into every agent-facing URL, leaking the secret through logs/LLM agents and
 // producing a malformed request target (`?apikey=SECRET/api/cowork/tabs`).
 // Strip benign query strings (and fragments, which break concatenation the
 // same way), but refuse and fail closed when the query looks secret-shaped —
 // paralleling the userinfo rejection above.
      if (parsed.search) {
        if (
          /[?&](api[_-]?key|token|access[_-]?token|secret|password|auth(entication|orization)?|client[_-]?secret|bearer|session[_-]?id)=/i.test(
            parsed.search,
          )
        ) {
          console.error(
            "[agent-bootstrap] COWORK_BASE_URL embeds a secret-shaped query " +
              "parameter; refusing to advertise it through the agent bootstrap contract.",
          );
          return "";
        }
        configured = parsed.origin + parsed.pathname;
      } else if (parsed.hash) {
        configured = parsed.origin + parsed.pathname;
      }
    } catch {
      console.error(
        "[agent-bootstrap] COWORK_BASE_URL is not a valid URL; " +
          "refusing to advertise it through the agent bootstrap contract.",
      );
      return "";
    }
    return configured;
  }
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
      "All /api/cowork/* routes except the 5 public discovery routes (/api/cowork/agent/bootstrap, /api/cowork/agent/manifest, /api/cowork/agent, /api/cowork/agent/version, /api/cowork/skill) require an X-Cowork-Token header matching the server-side secret. Obtain the token from the cockpit operator. Requests without a valid token are rejected with 401.",
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
// header — the agent must send `X-Cowork-Token: <COWORK_UI_TOKEN>` (the
// browser-facing token the operator provides), on these.
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
  'Never trigger a mass-deletion of all /history or /ai/chat rows without explicit user confirmation — these wipe all stored rows.',
  'Treat all returned data as persisted snapshots, not live browser state.',
  'Network, DevTools, and Snapshots views are extension-only capabilities and are not exposed via this API.',
] as const;

const AGENT_TOOLBOX = {
  orient: [
    { method: 'GET', path: '/api/cowork/agent/bootstrap', use: 'First read after discovery.' },
    { method: 'GET', path: '/api/cowork/agent/manifest', use: 'Full endpoint map.' },
    { method: 'GET', path: '/api/cowork/tabs', use: 'List persisted tabs.' },
    { method: 'GET', path: '/api/cowork/workspaces', use: 'List persisted workspaces.' },
  ],
  read: [
    { method: 'GET', path: '/api/cowork/sessions', use: 'List persisted sessions.' },
    { method: 'GET', path: '/api/cowork/agents', use: 'List agent trust grants.' },
    { method: 'GET', path: '/api/cowork/agents/tasks', use: 'List agent tasks.' },
    { method: 'GET', path: '/api/cowork/workflows', use: 'List workflows.' },
    { method: 'GET', path: '/api/cowork/memory/site', use: 'Read per-site structured memory.' },
    { method: 'GET', path: '/api/cowork/memory/form', use: 'Read per-site form memory.' },
    { method: 'GET', path: '/api/cowork/bookmarks', use: 'Read the bookmark tree.' },
    { method: 'GET', path: '/api/cowork/history', use: 'Read browsing history.' },
    { method: 'GET', path: '/api/cowork/pinboards', use: 'List pinboards.' },
    { method: 'GET', path: '/api/cowork/extensions', use: 'List installed extensions.' },
    { method: 'GET', path: '/api/cowork/security/events', use: 'Read the security event feed.' },
    { method: 'GET', path: '/api/cowork/mcp/tools', use: 'Browse the MCP tool catalog.' },
  ],
  create: [
    { method: 'POST', path: '/api/cowork/tabs', use: 'Persist a new tab row.' },
    { method: 'POST', path: '/api/cowork/workspaces', use: 'Create a workspace.' },
    { method: 'POST', path: '/api/cowork/sessions', use: 'Create a session.' },
    { method: 'POST', path: '/api/cowork/workflows', use: 'Create a workflow.' },
    { method: 'POST', path: '/api/cowork/bookmarks', use: 'Add a bookmark.' },
    { method: 'POST', path: '/api/cowork/pinboards', use: 'Create a pinboard.' },
  ],
  chat: [
    { method: 'POST', path: '/api/cowork/ai/chat', use: 'Send a chat message to the wingman proxy.' },
    { method: 'POST', path: '/api/cowork/ai/image', use: 'Generate an image via the wingman proxy.' },
  ],
} as const;

export const AGENT_TOOL_SELECTION_HINTS = {
  '/api/cowork/tabs': {
    whenToUse: 'List persisted tabs. Supports an optional `workspaceId` query param and a `limit` query param.',
    preferredOver: [],
    requires: [],
    risk: 'low',
  },
  '/api/cowork/workspaces': {
    whenToUse: 'List or create workspaces. POST accepts `{ name, icon, color }`.',
    preferredOver: [],
    requires: [],
    risk: 'low',
  },
  '/api/cowork/ai/chat': {
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
  const normalized = baseUrl.replace(/\/+$/, "");
  return steps.map(step => ({ ...step, url: `${normalized}${step.endpoint}` }));
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
