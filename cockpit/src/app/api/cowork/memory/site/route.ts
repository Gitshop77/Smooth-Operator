// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, parseLimit } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    // Cap the result set so a caller can't pull the entire table in one shot
    // (F-36). Default 100, hard max 200 (see parseLimit). Support cursor
    // pagination by `id` via the `after` query param.
    const limit = parseLimit(req);
    const after = req.nextUrl.searchParams.get('after') || undefined;
    const args: Parameters<typeof db.siteMemory.findMany>[0] = {
      take: limit,
      orderBy: { createdAt: 'desc' },
    };
    if (after) {
      args.cursor = { id: after };
      args.skip = 1;
    }
    const memories = await db.siteMemory.findMany(args);
    return json({ memories });
  });
}
