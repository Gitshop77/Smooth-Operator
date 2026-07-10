// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, bodyJson } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

export async function GET(): Promise<Response> {
  return withRouteError(async () => {
    const sessions = await db.session.findMany({ orderBy: { createdAt: 'desc' } });
    // Project `isIncognito` → legacy `incognito` alias and synthesize
    // `cookieCount` (no column for it in the Prisma model).
    const projected = sessions.map((s) => ({
      ...s,
      incognito: s.isIncognito,
      cookieCount: 0,
    }));
    return json({ sessions: projected });
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const body = await bodyJson(req);
    const name = String(body.name || 'New Session');
    const partition = String(body.partition || `persist:${name.toLowerCase().replace(/\s+/g, '-')}`);
    const isIncognito = Boolean(body.isIncognito);
    const userAgent = body.userAgent ? String(body.userAgent) : null;
    const session = await db.session.create({ data: { name, partition, isIncognito, userAgent } });
    return json({ session }, 201);
  });
}
