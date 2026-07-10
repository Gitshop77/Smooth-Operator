import { describe, it, expect, vi } from 'vitest';

const findMany = vi.fn();
const del = vi.fn();

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

describe('GET /api/cowork/memory/form (F-36)', () => {
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
          ],
        }),
      },
    ]);
    const res = await GET(fakeReq());
    const body = await res.json();
    const parsed = JSON.parse(body.memories[0].formDataJson);
    expect(parsed.entries[0].name).toBe('password');
    expect(parsed.entries[0].value).toBe('[redacted]');
    expect(parsed.entries[1].value).toBe('a@b.com'); // non-sensitive kept
  });
});

describe('DELETE /api/cowork/memory/form (F-35)', () => {
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
    const err = new Error('Record to delete does not exist. (Prisma error P2025)');
    del.mockRejectedValueOnce(err);
    const res = await DELETE(fakeReq('id=missing'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not found');
  });
});
