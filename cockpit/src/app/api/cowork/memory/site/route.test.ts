import { describe, it, expect, vi } from 'vitest';

const { findMany, del } = vi.hoisted(() => ({ findMany: vi.fn(), del: vi.fn() }));

vi.mock('@/lib/db', () => ({
  db: {
    siteMemory: { findMany, delete: del },
  },
}));

import { GET, DELETE } from '@/app/api/cowork/memory/site/route';

function fakeReq(query = ''): any {
  return { nextUrl: { searchParams: new URLSearchParams(query) } };
}

describe('GET /api/cowork/memory/site', () => {
  it('applies the limit + cursor pagination', async () => {
    findMany.mockResolvedValueOnce([]);
    await GET(fakeReq('limit=5&after=abc'));
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5, orderBy: { createdAt: 'desc' }, cursor: { id: 'abc' }, skip: 1 }),
    );
  });

  it('rejects an invalid after cursor with 400', async () => {
    const res = await GET(fakeReq('after=!!!bad'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid after cursor');
  });

  it('returns the memories envelope', async () => {
    findMany.mockResolvedValueOnce([{ id: 's1', domain: 'example.com' }]);
    const res = await GET(fakeReq('limit=5'));
    expect(await res.json()).toEqual({ memories: [{ id: 's1', domain: 'example.com' }] });
  });
});

describe('DELETE /api/cowork/memory/site', () => {
  it('requires an id', async () => {
    const res = await DELETE(fakeReq());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('id is required');
  });

  it('deletes the site-memory entry by id', async () => {
    del.mockResolvedValueOnce({ id: 's1' });
    const res = await DELETE(fakeReq('id=s1'));
    expect(res.status).toBe(200);
    expect(del).toHaveBeenCalledWith({ where: { id: 's1' } });
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
});
