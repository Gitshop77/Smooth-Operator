// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { json, badRequest, withRouteError, parseLimit } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    // Cap the result set so a caller can't pull the entire table in one shot
    // (Default 100, hard max 200 — see parseLimit). Support cursor
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

// DELETE /api/cowork/memory/site?id=<siteMemoryId>
// Removes a single per-site memory entry. Gated by the same X-Cowork-Token
// check as every other /api/cowork/* data route (enforced in middleware.ts).
// PII-erasure endpoint — pairs with the FormMemory DELETE handler.
export async function DELETE(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return badRequest('id is required');
    try {
      await db.siteMemory.delete({ where: { id } });
    } catch (e) {
      // Prisma throws P2025 (RecordNotFound) when the id doesn't exist. The
      // code lives in `e.code`, not the message, so test that directly.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        return json({ error: 'not found' }, 404);
      }
      throw e;
    }
    return json({ ok: true });
  });
}
