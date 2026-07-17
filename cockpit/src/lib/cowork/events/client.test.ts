import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  broadcastEvent,
  getCoworkEventsToken,
  getValidatedEventsBase,
} from '@/lib/cowork/events/client';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('broadcastEvent (relay error/timeout contract)', () => {
  it('maps a non-200 response to { ok:false, error: HTTP n: <body> }', async () => {
    vi.stubEnv('COWORK_UI_TOKEN', 'tok');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('boom', { status: 500, headers: { 'content-type': 'text/plain' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await broadcastEvent('tab:updated', { id: 1 });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^HTTP 500: /);
    expect(res.channel).toBe('tab:updated');
  });

  it('maps an AbortError to { ok:false, error: "timeout" }', async () => {
    vi.stubEnv('COWORK_UI_TOKEN', 'tok');
    const aborted = new Error('The operation was aborted');
    aborted.name = 'AbortError';
    const fetchMock = vi.fn().mockRejectedValue(aborted);
    vi.stubGlobal('fetch', fetchMock);

    const res = await broadcastEvent('tab:updated', {});

    expect(res.ok).toBe(false);
    expect(res.error).toBe('timeout');
  });

  it('never leaks transport detail on a generic network error', async () => {
    vi.stubEnv('COWORK_UI_TOKEN', 'tok');
    const fetchMock = vi.fn().mockRejectedValue(
      new Error('connect ECONNREFUSED 127.0.0.1:3003'),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await broadcastEvent('tab:updated', {});

    expect(res.ok).toBe(false);
    // Generic message only — no host:port leak.
    expect(res.error).toBe('event relay failed');
    expect(res.error).not.toContain('127.0.0.1');
  });

  it('returns the acknowledgement on a successful relay', async () => {
    vi.stubEnv('COWORK_UI_TOKEN', 'tok');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, id: 7, channel: 'tab:updated' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await broadcastEvent('tab:updated', { id: 1 });

    expect(res.ok).toBe(true);
    expect(res.id).toBe(7);
    expect(res.channel).toBe('tab:updated');
  });
});

describe('getCoworkEventsToken (resolution order — must match middleware.ts)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers COWORK_UI_TOKEN over COWORK_EVENT_TOKEN', () => {
    vi.stubEnv('COWORK_UI_TOKEN', 'ui-tok');
    vi.stubEnv('COWORK_EVENT_TOKEN', 'evt-tok');
    expect(getCoworkEventsToken()).toBe('ui-tok');
  });

  it('falls back to COWORK_EVENT_TOKEN when COWORK_UI_TOKEN is empty', () => {
    vi.stubEnv('COWORK_UI_TOKEN', '');
    vi.stubEnv('COWORK_EVENT_TOKEN', 'evt-tok');
    expect(getCoworkEventsToken()).toBe('evt-tok');
  });

  it('returns "" when both tokens are unset', () => {
    vi.stubEnv('COWORK_UI_TOKEN', '');
    vi.stubEnv('COWORK_EVENT_TOKEN', '');
    expect(getCoworkEventsToken()).toBe('');
  });
});

describe('getValidatedEventsBase (relay-target SSRF fail-closed contract)', () => {
  it('refuses non-http(s) schemes', () => {
    expect(getValidatedEventsBase('javascript:alert(1)')).toBe('');
    expect(getValidatedEventsBase('file:///etc/passwd')).toBe('');
  });

  it('refuses embedded userinfo (credentialed base)', () => {
    expect(getValidatedEventsBase('http://user:pass@example.com')).toBe('');
  });

  it('refuses a secret-shaped query', () => {
    expect(getValidatedEventsBase('https://events.internal/?token=abc')).toBe('');
    expect(getValidatedEventsBase('https://events.internal/?api_key=xyz')).toBe('');
  });

  it('passes a benign http(s) origin', () => {
    expect(getValidatedEventsBase('http://localhost:3003')).toBe('http://localhost:3003');
    expect(getValidatedEventsBase('https://events.internal:3003')).toBe(
      'https://events.internal:3003',
    );
  });
});
