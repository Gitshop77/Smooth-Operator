// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, bodyJson, badRequest, parseLimit, CURSOR_ID_RE, isPrismaRecordNotFound } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

// Valid CSS hex color lengths only: 3, 4, 6, or 8 hex digits. (5/7-digit
// strings are not valid CSS colors and would be silently dropped by the browser.)
const COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

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
      if (isPrismaRecordNotFound(e)) {
        return badRequest('invalid after cursor');
      }
      throw e;
    }
 // `?total=0` skips the extra full-table count() (useful for paginated
 // `after` loads); otherwise the grand total is returned as before.
    const wantTotal = req.nextUrl.searchParams.get('total') !== '0';
    const total = wantTotal ? await db.pinboard.count() : pinboards.length;
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
