// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, bodyJson } from '@/lib/cowork/api/http';
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
    const name = String(body.name || 'Untitled Pinboard');
    const color = String(body.color || '#4285f4');
    const pb = await db.pinboard.create({ data: { name, color } });
    return json({ pinboard: pb }, 201);
  });
}
