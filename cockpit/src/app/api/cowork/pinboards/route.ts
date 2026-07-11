// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, bodyJson, badRequest, parseLimit } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    // Cap the result set so a caller can't pull the entire table in one shot
    // (default 100, hard max 200 — see parseLimit). Support cursor pagination
    // by `id` via the `after` query param, mirroring memory/site/route.ts.
    const limit = parseLimit(req);
    const after = req.nextUrl.searchParams.get('after') || undefined;
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
    const [pinboards, total] = await Promise.all([
      db.pinboard.findMany(args),
      db.pinboard.count(),
    ]);
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
