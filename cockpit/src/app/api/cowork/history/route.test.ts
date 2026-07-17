import type { NextRequest } from 'next/server';
import { describe, it, expect, vi, afterEach } from 'vitest';

interface UpsertInput {
  where: { url: string };
  create: { url: string; title: string };
  update: { title: string };
}

const { findMany, del, deleteMany, upsert, historyStore, PrismaClientKnownRequestError } = vi.hoisted(() => {
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'PrismaClientKnownRequestError';
      this.code = code;
    }
  }
 // In-memory `historyEntry` table that enforces the url @unique contract: a
 // revisit upserts (visitCount++) rather than inserting a second row. This is
 // what the real Prisma upsert does, so the POST contract test below exercises
 // the actual write path instead of a hand-rolled in-test simulation.
  const historyStore = new Map<string, { id: string; url: string; title: string; visitCount: number }>();
  const upsert = vi.fn(async ({ where, create, update }: UpsertInput) => {
    const existing = historyStore.get(where.url);
    if (existing) {
      existing.visitCount += 1;
      existing.title = update.title;
      return { ...existing };
    }
    const row = { id: String(historyStore.size + 1), url: create.url, title: create.title, visitCount: 1 };
    historyStore.set(where.url, row);
    return { ...row };
  });
  return {
    findMany: vi.fn(),
    del: vi.fn(),
    deleteMany: vi.fn(),
    upsert,
    historyStore,
    PrismaClientKnownRequestError,
  };
});

vi.mock('@prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError },
}));

vi.mock('@/lib/db', () => ({
  db: {
    historyEntry: { findMany, delete: del, deleteMany, upsert },
  },
}));

import { GET, POST, DELETE } from '@/app/api/cowork/history/route';

afterEach(() => {
  vi.clearAllMocks();
  historyStore.clear();
});

function fakeReq(query = '', body?: unknown): NextRequest {
  const headers = new Headers();
  if (body !== undefined) {
    return {
      nextUrl: { searchParams: new URLSearchParams(query) },
      headers,
      body: body === null ? null : new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
          controller.close();
        },
      }),
    } as unknown as NextRequest;
  }
  return { nextUrl: { searchParams: new URLSearchParams(query) }, headers } as unknown as NextRequest;
}

describe('GET /api/cowork/history', () => {
  it('honors an explicit limit param (limit=7)', async () => {
    findMany.mockResolvedValueOnce([]);
    await GET(fakeReq('limit=7'));
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 7, orderBy: { lastVisitedAt: 'desc' } }),
    );
  });

  // This route calls `parseLimit(req, 50)` — its per-route default is 50
  // (distinct from extensions/route, which uses the helper's 100 default).
  it('falls back to the per-route default (50) when limit is omitted', async () => {
    findMany.mockResolvedValueOnce([]);
    await GET(fakeReq());
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50, orderBy: { lastVisitedAt: 'desc' } }),
    );
  });

  it('clamps an over-large limit to the max (200)', async () => {
    findMany.mockResolvedValueOnce([]);
    await GET(fakeReq('limit=9999'));
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200, orderBy: { lastVisitedAt: 'desc' } }),
    );
  });

  it('builds a bounded OR contains where-clause for a q search term', async () => {
    findMany.mockResolvedValueOnce([]);
    await GET(fakeReq('q=hello'));
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ url: { contains: 'hello' } }, { title: { contains: 'hello' } }] },
      }),
    );
  });

  it('truncates an over-256-char q before it reaches the query', async () => {
    findMany.mockResolvedValueOnce([]);
    const longQ = 'a'.repeat(500);
    await GET(fakeReq(`q=${longQ}`));
    const callArg = findMany.mock.calls[0][0] as { where: { OR: Array<{ url?: { contains: string } }> } };
    expect(callArg.where.OR[0].url?.contains.length).toBe(256);
  });
});

describe('DELETE /api/cowork/history', () => {
  it('requires an id or ?all=1', async () => {
    const res = await DELETE(fakeReq());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('id is required');
  });

  it('deletes a single entry by id', async () => {
    del.mockResolvedValueOnce({ id: 'h1' });
    const res = await DELETE(fakeReq('id=h1'));
    expect(res.status).toBe(200);
    expect(del).toHaveBeenCalledWith({ where: { id: 'h1' } });
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('returns 404 when the entry does not exist', async () => {
    const err = new PrismaClientKnownRequestError(
      'Record to delete does not exist.',
      'P2025',
    );
    del.mockRejectedValueOnce(err);
    const res = await DELETE(fakeReq('id=missing'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not found');
  });

  it('requires explicit server-side confirmation for ?all=1', async () => {
    const res = await DELETE(fakeReq('all=1'));
    expect(res.status).toBe(400);
    expect(deleteMany).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toBe('confirmation required');
  });

  it('clears all entries with ?all=1 when confirm:true is supplied', async () => {
    deleteMany.mockResolvedValueOnce({ count: 42 });
    const res = await DELETE(fakeReq('all=1', { confirm: true }));
    expect(res.status).toBe(200);
    expect(deleteMany).toHaveBeenCalledWith({ where: {} });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(42);
  });

  it('logs the initiating principal (clientIp) for a ?all=1 confirm:true wipe (AU-3)', async () => {
    deleteMany.mockResolvedValueOnce({ count: 3 });
    const req = fakeReq('all=1', { confirm: true });
    req.headers.set('x-forwarded-for', '203.0.113.7, 10.0.0.1');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await DELETE(req);
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ clientIp: '203.0.113.7', confirm: true }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('scopes a ?all=1 wipe to olderThan (lastVisitedAt.lt)', async () => {
    deleteMany.mockResolvedValueOnce({ count: 7 });
    const res = await DELETE(fakeReq('all=1', { confirm: true, olderThan: '2020-01-01T00:00:00Z' }));
    expect(res.status).toBe(200);
    expect(deleteMany).toHaveBeenCalledTimes(1);
    const callArg = deleteMany.mock.calls[0][0] as { where: { lastVisitedAt?: { lt: Date } } };
    expect(callArg.where.lastVisitedAt).toBeDefined();
    expect(callArg.where.lastVisitedAt?.lt).toBeInstanceOf(Date);
    expect(callArg.where.lastVisitedAt?.lt.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    const body = await res.json();
    expect(body.deleted).toBe(7);
  });

  it('rejects a non-ISO olderThan with 400 (confirm still required)', async () => {
    const res = await DELETE(fakeReq('all=1', { confirm: true, olderThan: 'not-a-date' }));
    expect(res.status).toBe(400);
    expect(deleteMany).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toContain('olderThan must be an ISO-8601 timestamp');
  });
});

// F22 write-contract (integration): exercising the REAL POST route so a
// regression that swapped the upsert for a raw create (which would throw P2002
// on the first revisit) is caught here, not against an in-test simulation.
describe('POST /api/cowork/history — F22 upsert-on-url contract', () => {
  it('revisiting a url updates the existing row (visitCount++) without creating a second', async () => {
    const first = await POST(fakeReq('', { url: 'https://example.com', title: 'Example' }));
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { entry: { visitCount: number } };
    expect(firstBody.entry.visitCount).toBe(1);

    const second = await POST(fakeReq('', { url: 'https://example.com', title: 'Example v2' }));
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { entry: { visitCount: number; title: string } };
    expect(historyStore.size).toBe(1);
    expect(secondBody.entry.visitCount).toBe(2);
    expect(secondBody.entry.title).toBe('Example v2');
  });

  it('creates distinct rows for distinct urls', async () => {
    await POST(fakeReq('', { url: 'https://a.com' }));
    await POST(fakeReq('', { url: 'https://b.com' }));
    expect(historyStore.size).toBe(2);
  });
});

// Regression guards for the POST scheme + title-type validation that prevent a
// stored-XSS (`javascript:`) URL or a persisted `[object Object]` title from
// reaching the browser. These exercise the real `validateHttpUrl` and
// `boundedString` paths the route funnels through.
describe('POST /api/cowork/history — scheme + title-type guards', () => {
  it('rejects a non-http scheme (stored-XSS guard) with 400', async () => {
    const res = await POST(fakeReq('', { url: 'javascript:alert(1)' }));
    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toBe('URL must be http or https');
  });

  it('rejects a missing/empty url with 400', async () => {
    const res = await POST(fakeReq('', { url: '' }));
    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toBe('url required (non-empty string)');
  });

  it('rejects a non-string object title with 400', async () => {
    const res = await POST(fakeReq('', { url: 'https://example.com', title: {} }));
    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toBe('field must be a string');
  });

  it('rejects a non-string array title with 400', async () => {
    const res = await POST(fakeReq('', { url: 'https://example.com', title: ['x'] }));
    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toBe('field must be a string');
  });
});
