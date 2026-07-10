// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, parseLimit } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const q = req.nextUrl.searchParams.get('q') || undefined;
    // Cap `limit` to a hard max of 200 so a hostile or buggy
    // caller can't ask for the entire table in one shot. Default 50.
    const limit = parseLimit(req, 50);
    const entries = q
      ? await db.historyEntry.findMany({
          where: { OR: [{ url: { contains: q } }, { title: { contains: q } }] },
          take: limit,
          orderBy: { lastVisitedAt: 'desc' },
        })
      : await db.historyEntry.findMany({ take: limit, orderBy: { lastVisitedAt: 'desc' } });
    // Project `lastVisitedAt` → legacy `visitedAt` alias so the
    // `collections-view`'s history tab keeps sorting + rendering correctly.
    const projected = entries.map((h) => ({
      ...h,
      visitedAt: h.lastVisitedAt,
    }));
    return json({ history: projected });
  });
}
