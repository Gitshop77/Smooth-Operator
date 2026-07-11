import { describe, it, expect, vi } from 'vitest';

const { findMany, del, deleteMany } = vi.hoisted(() => ({
  findMany: vi.fn(),
  del: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    historyEntry: { findMany, delete: del, deleteMany },
  },
}));

import { GET, DELETE } from '@/app/api/cowork/history/route';

function fakeReq(query = '', body?: unknown): any {
  if (body !== undefined) {
    return {
      nextUrl: { searchParams: new URLSearchParams(query) },
      body: true,
      text: async () => JSON.stringify(body),
    };
  }
  return { nextUrl: { searchParams: new URLSearchParams(query) } };
}

describe('GET /api/cowork/history', () => {
  it('caps the result set via parseLimit default (50) + orderBy', async () => {
    findMany.mockResolvedValueOnce([]);
    await GET(fakeReq('limit=7'));
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 7, orderBy: { lastVisitedAt: 'desc' } }),
    );
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
    const err = new Error('Record to delete does not exist. (Prisma error P2025)');
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
    expect(deleteMany).toHaveBeenCalledWith({});
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(42);
  });
});
