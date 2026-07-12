// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { json, withRouteError, bodyJson, badRequest, parseLimit } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

// Cursor id shape used for `after` pagination. A valid id is a short, URL-safe
// token (cuid/uuid); anything else is rejected at the boundary with 400 rather
// than reaching Prisma. (Table ids are cuid strings, well within this bound.)
const CURSOR_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
 // Cap the result set so a caller can't pull the entire table in one shot
 // (default 100, hard max 200 — see parseLimit). Support cursor pagination
 // by `id` via the `after` query param, mirroring memory/site/route.ts.
    const limit = parseLimit(req);
    const after = req.nextUrl.searchParams.get('after') || undefined;
    if (after !== undefined && !CURSOR_ID_RE.test(after)) {
      return badRequest('invalid after cursor');
    }
 // Note: `args` must be typed so the literal `include` is preserved.
 // Annotating it as `Parameters<typeof db.pinboard.findMany>[0]` widens the
 // return type to the base `Pinboard` (dropping `_count`), so we use
 // `satisfies` to keep the precise type for overload resolution.
    const args = {
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { items: true } } },
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    } satisfies Parameters<typeof db.pinboard.findMany>[0];
    let pinboards;
    try {
      pinboards = await db.pinboard.findMany(args);
    } catch (e) {
 // A well-formed but stale/unknown cursor id makes Prisma throw P2025
 // (RecordNotFound); return a precise 400 instead of a generic 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        return badRequest('invalid after cursor');
      }
      throw e;
    }
    const total = await db.pinboard.count();
 // Include the `items` relation count so the dashboard can show
 // `itemCount` without a second round-trip.
    const projected = pinboards.map((pb) => ({
      ...pb,
      itemCount: pb._count?.items ?? 0,
    }));
    return json({ pinboards: projected, total });
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const body = await bodyJson(req);
 // F17-val: validate/normalize color and name.
    const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
    let name: string;
    if (body.name == null || body.name === '') {
      name = 'Untitled Pinboard';
    } else if (typeof body.name !== 'string') {
      return badRequest('name must be a string');
    } else if (body.name.length > 64) {
      return badRequest('name must be at most 64 characters');
    } else {
      name = body.name;
    }
    const rawColor = typeof body.color === 'string' ? body.color : '';
    const color = COLOR_RE.test(rawColor) ? rawColor : '#4285f4';
    const pb = await db.pinboard.create({ data: { name, color } });
    return json({ pinboard: pb }, 201);
  });
}
