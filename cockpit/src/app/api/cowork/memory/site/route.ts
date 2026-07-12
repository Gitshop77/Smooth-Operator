// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { json, badRequest, withRouteError, parseLimit } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

// Cursor id shape used for `after` pagination (table ids are cuid strings).
const CURSOR_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
 // Cap the result set so a caller can't pull the entire table in one shot
 // (Default 100, hard max 200 — see parseLimit). Support cursor
 // pagination by `id` via the `after` query param.
    const limit = parseLimit(req);
    const after = req.nextUrl.searchParams.get('after') || undefined;
    if (after !== undefined && !CURSOR_ID_RE.test(after)) {
      return badRequest('invalid after cursor');
    }
    const args: Parameters<typeof db.siteMemory.findMany>[0] = {
      take: limit,
      orderBy: { createdAt: 'desc' },
    };
    if (after) {
      args.cursor = { id: after };
      args.skip = 1;
    }
    let memories;
    try {
      memories = await db.siteMemory.findMany(args);
    } catch (e) {
 // A well-formed but stale/unknown cursor id makes Prisma throw P2025
 // (RecordNotFound); return a precise 400 instead of a generic 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        return badRequest('invalid after cursor');
      }
      throw e;
    }
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
 // code lives in `e.code`, but a caller may surface a plain Error whose
 // message still reports P2025 (e.g. certain driver/adapter layers);
 // detect both so a missing entry is a precise 404 rather than a 500.
      if (
        (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') ||
        (e instanceof Error && /P2025/.test(e.message))
      ) {
        return json({ error: 'not found' }, 404);
      }
      throw e;
    }
    return json({ ok: true });
  });
}
