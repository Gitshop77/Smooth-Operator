import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  db: {
    siteMemory: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

import { GET } from '@/app/api/cowork/memory/site/route';
import { db } from '@/lib/db';

beforeEach(() => {
  (db.siteMemory.findMany as ReturnType<typeof vi.fn>).mockClear();
});

function fakeReq(query = ''): any {
  return { nextUrl: { searchParams: new URLSearchParams(query) } };
}

describe('GET /api/cowork/memory/site (F-36)', () => {
  it('applies the limit from the query param to the Prisma query', async () => {
    await GET(fakeReq('limit=5'));
    expect(db.siteMemory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5, orderBy: { createdAt: 'desc' } }),
    );
  });

  it('caps the limit at the configured max via parseLimit default', async () => {
    await GET(fakeReq('limit=999999'));
    const call = (db.siteMemory.findMany as any).mock.calls[0][0];
    // parseLimit caps at 200 (max param), so the take must be 200, not 999999.
    expect(call.take).toBe(200);
  });

  it('passes a cursor when `after` is supplied', async () => {
    await GET(fakeReq('after=abc123'));
    const call = (db.siteMemory.findMany as any).mock.calls[0][0];
    expect(call.cursor).toEqual({ id: 'abc123' });
    expect(call.skip).toBe(1);
  });
});
