// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { json, withRouteError, bodyJson, badRequest } from '@/lib/cowork/api/http';
import { boundedString, nonEmptyString, validateField, truncateTo } from '@/lib/cowork/api/validation';
import { db } from '@/lib/db';

export async function GET(): Promise<Response> {
  return withRouteError(async () => {
    const sessions = await db.session.findMany({ orderBy: { createdAt: 'desc' } });
    // Project `isIncognito` → legacy `incognito` alias. The legacy
    // `cookieCount` field has no backing column on `Session` and no real value
    // to compute, so it is intentionally omitted rather than synthesized to a
    // misleading `0`. The consuming view (sessions-view.tsx) and the shared
    // `Session` type (cowork-data/types.ts) must be updated to drop the field.
    const projected = sessions.map((s) => ({
      ...s,
      incognito: s.isIncognito,
    }));
    return json({ sessions: projected });
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const body = await bodyJson(req);
    // Bound free-form strings to reasonable max lengths.
    const nameResult = validateField(nonEmptyString(256), truncateTo(body.name || 'New Session', 256), 'name');
    if (!nameResult.ok) return badRequest(nameResult.error);
    const name = nameResult.value;
    const partitionRaw = truncateTo(body.partition || `persist:${name.toLowerCase().replace(/\s+/g, '-')}`, 256);
    const partitionResult = validateField(boundedString(256), partitionRaw, 'partition');
    if (!partitionResult.ok) return badRequest(partitionResult.error);
    const partition = partitionResult.value;
    const isIncognito = Boolean(body.isIncognito);
    // Truncate + validate userAgent (cap 512). Store the bounded value.
    let userAgent: string | null = null;
    if (body.userAgent != null) {
      if (typeof body.userAgent !== 'string') return badRequest('userAgent must be a string');
      const uaRaw = truncateTo(body.userAgent, 512);
      const uaResult = validateField(boundedString(512), uaRaw, 'userAgent');
      if (!uaResult.ok) return badRequest(uaResult.error);
      userAgent = uaResult.value;
    }
    try {
      const session = await db.session.create({ data: { name, partition, isIncognito, userAgent } });
      return json({ session }, 201);
    } catch (e) {
      // `Session.name` is `@unique`; a duplicate name throws P2002. Surface it
      // as a 400 (actionable) rather than a generic 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return badRequest('name already exists');
      }
      throw e;
    }
  });
}
