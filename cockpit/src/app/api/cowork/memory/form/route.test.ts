import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const { findMany, del } = vi.hoisted(() => ({ findMany: vi.fn(), del: vi.fn() }));

vi.mock('@/lib/db', () => ({
  db: {
    formMemory: {
      findMany,
      delete: del,
    },
  },
}));

import { GET, DELETE } from '@/app/api/cowork/memory/form/route';

function fakeReq(query = ''): any {
  return { nextUrl: { searchParams: new URLSearchParams(query) } };
}

describe('GET /api/cowork/memory/form', () => {
  it('applies the limit from the query param', async () => {
    findMany.mockResolvedValueOnce([]);
    await GET(fakeReq('limit=3'));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }));
  });

  it('redacts sensitive form field values but keeps field names', async () => {
    findMany.mockResolvedValueOnce([
      {
        id: '1',
        domain: 'example.com',
        formDataJson: JSON.stringify({
          entries: [
            { name: 'password', value: 'hunter2' },
            { name: 'email', value: 'a@b.com' },
            { name: 'username', value: 'bob' },
          ],
        }),
      },
    ]);
    const res = await GET(fakeReq());
    const body = await res.json();
    const parsed = JSON.parse(body.memories[0].formDataJson);
    expect(parsed.entries[0].name).toBe('password');
    expect(parsed.entries[0].value).toBe('[redacted]');
    expect(parsed.entries[1].name).toBe('email');
    expect(parsed.entries[1].value).toBe('[redacted]'); // email now redacted (F18)
    expect(parsed.entries[2].name).toBe('username');
    expect(parsed.entries[2].value).toBe('bob'); // non-sensitive kept
  });

  it('rejects an invalid after cursor with 400', async () => {
    const res = await GET(fakeReq('after=!!!bad'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid after cursor');
  });

  it('redacts a sibling sensitive key on the entry shape', async () => {
    findMany.mockResolvedValueOnce([
      { id: '1', domain: 'example.com', formDataJson: JSON.stringify({ name: 'form1', password: 'hunter2' }) },
    ]);
    const res = await GET(fakeReq());
    const parsed = JSON.parse((await res.json()).memories[0].formDataJson);
    expect(parsed.name).toBe('form1');
    expect(parsed.password).toBe('[redacted]');
  });

  it('redacts a flat record by field name', async () => {
    findMany.mockResolvedValueOnce([
      { id: '1', domain: 'example.com', formDataJson: JSON.stringify({ password: 'x', username: 'bob' }) },
    ]);
    const res = await GET(fakeReq());
    const parsed = JSON.parse((await res.json()).memories[0].formDataJson);
    expect(parsed.password).toBe('[redacted]');
    expect(parsed.username).toBe('bob');
  });

  it('redacts a bare array of entries', async () => {
    findMany.mockResolvedValueOnce([
      { id: '1', domain: 'example.com', formDataJson: JSON.stringify([{ name: 'email', value: 'a@b.com' }]) },
    ]);
    const res = await GET(fakeReq());
    const parsed = JSON.parse((await res.json()).memories[0].formDataJson);
    expect(parsed[0].name).toBe('email');
    expect(parsed[0].value).toBe('[redacted]');
  });

  it('returns 400 for a stale after cursor (P2025)', async () => {
    const err = new Prisma.PrismaClientKnownRequestError('Record does not exist', {
      code: 'P2025',
      clientVersion: 'unknown',
    });
    findMany.mockRejectedValueOnce(err);
    const res = await GET(fakeReq('after=abc'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid after cursor');
  });
});

describe('DELETE /api/cowork/memory/form', () => {
  it('requires an id', async () => {
    const res = await DELETE(fakeReq());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('id is required');
  });

  it('deletes the form-memory entry by id', async () => {
    del.mockResolvedValueOnce({ id: 'x' });
    const res = await DELETE(fakeReq('id=x'));
    expect(res.status).toBe(200);
    expect(del).toHaveBeenCalledWith({ where: { id: 'x' } });
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('returns 404 when the entry does not exist', async () => {
    const err = Object.assign(new Error('Record to delete does not exist.'), {
      code: 'P2025',
      name: 'PrismaClientKnownRequestError',
    });
    del.mockRejectedValueOnce(err);
    const res = await DELETE(fakeReq('id=missing'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not found');
  });
});
