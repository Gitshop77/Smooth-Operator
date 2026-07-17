import type { NextRequest } from 'next/server';
import { describe, it, expect, vi, afterEach } from 'vitest';

const { create, findMany, count, findUnique, del } = vi.hoisted(() => ({
  create: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  findUnique: vi.fn(),
  del: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    tab: { create, findMany, count, delete: del },
    workspace: { findUnique },
  },
}));

import { GET, POST, DELETE } from '@/app/api/cowork/tabs/route';

afterEach(() => {
  vi.clearAllMocks();
});

function getReq(query = ''): NextRequest {
  return { nextUrl: { searchParams: new URLSearchParams(query) } } as unknown as NextRequest;
}

function reqWithBody(text: string | null): NextRequest {
  if (text === null) {
    return { body: null, headers: { get: () => null } } as unknown as NextRequest;
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
  } as unknown as NextRequest;
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

  it('rejects an unknown workspaceId with 400 (does not reach create)', async () => {
    findUnique.mockResolvedValueOnce(null);
    const res = await POST(reqWithBody('{"url":"https://example.com","workspaceId":"missing"}'));
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toBe('unknown workspaceId');
  });

  it('rejects a non-http(s) url like javascript: with 400 (does not reach create)', async () => {
    const res = await POST(reqWithBody('{"url":"javascript:alert(1)"}'));
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a data: url with 400 (does not reach create)', async () => {
    const res = await POST(reqWithBody('{"url":"data:text/html,<script>alert(1)</script>"}'));
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
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

describe('DELETE /api/cowork/tabs', () => {
  it('requires an id', async () => {
    const res = await DELETE(getReq());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('id is required');
  });

  it('rejects a malformed id with 400', async () => {
    const res = await DELETE(getReq('id=!!!bad'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid id');
  });

  it('deletes the tab by id', async () => {
    del.mockResolvedValueOnce({ id: 't1' });
    const res = await DELETE(getReq('id=t1'));
    expect(res.status).toBe(200);
    expect(del).toHaveBeenCalledWith({ where: { id: 't1' } });
    expect((await res.json()).ok).toBe(true);
  });

  it('returns 404 when the tab does not exist', async () => {
    const err = new Error('Record to delete does not exist. (Prisma error P2025)');
    del.mockRejectedValueOnce(err);
    const res = await DELETE(getReq('id=missing'));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not found');
  });
});
