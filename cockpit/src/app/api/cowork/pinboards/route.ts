// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, bodyJson, badRequest } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

export async function GET(): Promise<Response> {
  return withRouteError(async () => {
    // Include the `items` relation count so the dashboard can show
    // `itemCount` without a second round-trip.
    const pinboards = await db.pinboard.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { items: true } } },
    });
    const projected = pinboards.map((pb) => ({
      ...pb,
      itemCount: pb._count?.items ?? 0,
    }));
    return json({ pinboards: projected });
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
