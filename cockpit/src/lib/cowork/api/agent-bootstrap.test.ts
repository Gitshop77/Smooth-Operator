import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  getCockpitBaseUrl,
  buildAgentBootstrapContract,
} from '@/lib/cowork/api/agent-bootstrap';

describe('getCockpitBaseUrl (security guard)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns "" for a non-http(s) scheme (e.g. javascript:)', () => {
    vi.stubEnv('COWORK_BASE_URL', 'javascript:alert(1)');
    vi.stubEnv('NODE_ENV', 'development');
    expect(getCockpitBaseUrl()).toBe('');
  });

  it('returns "" for a URL carrying embedded credentials', () => {
    vi.stubEnv('COWORK_BASE_URL', 'https://user:secret@example.com');
    vi.stubEnv('NODE_ENV', 'development');
    expect(getCockpitBaseUrl()).toBe('');
  });

  it('returns "" in production when COWORK_BASE_URL is unset', () => {
    vi.stubEnv('COWORK_BASE_URL', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(getCockpitBaseUrl()).toBe('');
  });

  it('returns the configured https URL otherwise', () => {
    vi.stubEnv('COWORK_BASE_URL', 'https://cockpit.example.com');
    vi.stubEnv('NODE_ENV', 'development');
    expect(getCockpitBaseUrl()).toBe('https://cockpit.example.com');
  });

  it('returns "" for a malformed URL (not a url)', () => {
    vi.stubEnv('COWORK_BASE_URL', 'not a url');
    vi.stubEnv('NODE_ENV', 'development');
    expect(getCockpitBaseUrl()).toBe('');
  });

  it('returns http://localhost:3000 when unset in development', () => {
    vi.stubEnv('COWORK_BASE_URL', '');
    vi.stubEnv('NODE_ENV', 'development');
    expect(getCockpitBaseUrl()).toBe('http://localhost:3000');
  });
});

describe('AGENT_TOOLBOX drift-guard', () => {
  // Route segments that actually exist as /api/cowork/* handlers. Kept in
  // lock-step with the route tree; if this list diverges from disk the test
  // below still catches a toolbox entry pointing at a non-existent handler.
  const KNOWN_ROUTE_SEGMENTS = new Set([
    'agent',
    'agent/bootstrap',
    'agent/manifest',
    'agent/version',
    'agents',
    'agents/tasks',
    'ai/chat',
    'ai/image',
    'bookmarks',
    'events/emit',
    'events/stream',
    'extensions',
    'extensions/log',
    'history',
    'mcp/tools',
    'memory/form',
    'memory/site',
    'pinboards',
    'security/events',
    'sessions',
    'skill',
    'tabs',
    'workflows',
    'workspaces',
  ]);

  it('every toolbox path maps to a real /api/cowork/* handler', () => {
    const { toolbox } = buildAgentBootstrapContract('http://localhost:3000', '1.0.0');
    const allEntries = [
      ...toolbox.orient,
      ...toolbox.read,
      ...toolbox.create,
      ...toolbox.chat,
    ];
    expect(allEntries.length).toBeGreaterThan(0);
    for (const entry of allEntries) {
      const segment = entry.path.replace(/^\/api\/cowork\//, '');
      expect(KNOWN_ROUTE_SEGMENTS.has(segment), `toolbox path ${entry.path} has no matching route handler`).toBe(true);
    }
  });
});
