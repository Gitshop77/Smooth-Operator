import { describe, it, expect, vi } from 'vitest';

const { create, findMany, count } = vi.hoisted(() => ({
  create: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    tab: { create, findMany, count },
  },
}));

import { GET, POST } from '@/app/api/cowork/tabs/route';
import { db } from '@/lib/db';

function getReq(query = ''): any {
  return { nextUrl: { searchParams: new URLSearchParams(query) } };
}

function reqWithBody(text: string | null): any {
  if (text === null) {
    return { body: null, headers: { get: () => null } };
  }
 // Mirror what the real route consumes: `bodyJson` reads the request via
 // `req.body.getReader()`, so the mock must expose a ReadableStream-style
 // reader that yields the encoded body once, not an unused `text()` method.
  const chunk = new TextEncoder().encode(text);
  return {
    body: {
      getReader() {
        let done = false;
        return {
          async read() {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: chunk };
          },
          async cancel() {},
        };
      },
    },
    headers: { get: () => null },
  };
}

describe('POST /api/cowork/tabs (F-04b)', () => {
  it('returns 400 (not 201) on malformed JSON instead of creating a row with defaults', async () => {
    const res = await POST(reqWithBody('{ this is not valid json'));
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('still returns 400 for a well-formed but empty body (no url)', async () => {
    const res = await POST(reqWithBody('{}'));
 // No url -> badRequest, and create is never reached.
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a tab for valid JSON with a url', async () => {
    create.mockResolvedValueOnce({ id: 't1', url: 'https://example.com' });
    const res = await POST(reqWithBody('{"url":"https://example.com"}'));
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/cowork/tabs', () => {
  it('projects fields and returns the total', async () => {
    findMany.mockResolvedValueOnce([
      {
        id: 't1',
        url: 'https://example.com',
        favicon: 'https://example.com/f.ico',
        isPinned: true,
        isMuted: false,
        lastAccessedAt: '2025-01-01T00:00:00Z',
        workspace: { name: 'Default' },
      },
    ]);
    count.mockResolvedValueOnce(1);
    const res = await GET(getReq());
    const body = await res.json();
    expect(body.total).toBe(1);
    const t = body.tabs[0];
    expect(t.workspaceName).toBe('Default');
    expect(t.lastAccessed).toBe('2025-01-01T00:00:00Z');
    expect(t.favIconUrl).toBe('https://example.com/f.ico');
    expect(t.pinned).toBe(true);
    expect(t.audiblyMuted).toBe(false);
  });
});
