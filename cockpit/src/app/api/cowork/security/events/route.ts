// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, parseLimit } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    // Cap `limit` to a hard max of 200 so a hostile or buggy
    // caller can't ask for the entire table in one shot. Default 100.
    const limit = parseLimit(req);
    const severity = req.nextUrl.searchParams.get('severity') || undefined;
    const events = severity
      ? await db.securityEvent.findMany({ where: { severity }, take: limit, orderBy: { createdAt: 'desc' } })
      : await db.securityEvent.findMany({ take: limit, orderBy: { createdAt: 'desc' } });
    const count = await db.securityEvent.count({ where: severity ? { severity } : {} });
    // Project the Prisma `SecurityEvent` fields onto the legacy
    // `SampleSecurityEvent` shape the view expects: `createdAt` →
    // `timestamp` and `details` → `description`.
    const projected = events.map((e) => ({
      ...e,
      timestamp: e.createdAt,
      description: e.details ?? '',
    }));
    return json({ events: projected, total: count });
  });
}
