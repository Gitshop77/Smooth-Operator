// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { json, withRouteError, bodyJson, badRequest, parseLimit, MAX_NAME_LEN, MAX_TITLE_LEN, CURSOR_ID_RE, isPrismaRecordNotFound, sanitizeRequestId } from '@/lib/cowork/api/http';
import { boundedString, validateField, truncateTo } from '@/lib/cowork/api/validation';
import { db } from '@/lib/db';

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
 // Cap `limit` to a hard max of 200 so a single response can't return the
 // entire table. Default 100 (see parseLimit).
    const limit = parseLimit(req);
    const sessions = await db.session.findMany({ take: limit, orderBy: { createdAt: 'desc' } });
 // Project `isIncognito` → legacy `incognito` alias. The legacy
 // `cookieCount` field has no backing column on `Session` and no real value
 // to compute, so it is intentionally omitted rather than synthesized to a
 // misleading `0`. The consuming view (sessions-view.tsx) and the shared
 // `Session` type (cowork-data/types.ts) must be updated to drop the field.
    const projected = sessions.map((s) => ({
      ...s,
      incognito: s.isIncognito,
 // `Session` has no cookie-count column, so there is no real value to
 // compute; project a stable `0` to match the consumer type
 // (`SampleSession.cookieCount`) and the view that renders it (rather than
 // leaving the field undefined).
      cookieCount: 0,
    }));
    const r = json({ sessions: projected });
    r.headers.set('Cache-Control', 'no-store, private');
    return r;
  }, sanitizeRequestId(req.headers?.get('x-request-id') ?? null));
}

export async function POST(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const body = await bodyJson(req);
 // Bound free-form strings to reasonable max lengths. `name` is required-ish:
 // when entirely absent (null/undefined) it defaults to 'New Session'; when
 // present it must be a real, non-blank, length-bounded string. We reject
 // whitespace-only and non-string input explicitly (matching the userAgent
 // path below) instead of silently coercing or substituting the default, so a
 // present-but-blank name surfaces a 400 rather than a confusing
 // "name already exists" collision (P2002).
    let name: string;
    if (body.name == null) {
      name = 'New Session';
    } else if (typeof body.name !== 'string') {
      return badRequest('name must be a string');
    } else {
      const trimmed = body.name.trim();
      if (trimmed.length === 0) return badRequest('name is invalid');
      const nameResult = validateField(boundedString(MAX_NAME_LEN), truncateTo(trimmed, MAX_NAME_LEN), 'name');
      if (!nameResult.ok) return badRequest(nameResult.error);
      name = nameResult.value;
    }
    const partitionRaw = truncateTo(body.partition || `persist:${name.toLowerCase().replace(/\s+/g, '-')}`, MAX_NAME_LEN);
    const partitionResult = validateField(boundedString(MAX_NAME_LEN), partitionRaw, 'partition');
    if (!partitionResult.ok) return badRequest(partitionResult.error);
    const partition = partitionResult.value;
    const isIncognito = Boolean(body.isIncognito);
 // Truncate + validate userAgent (cap 512). Store the bounded value.
    let userAgent: string | null = null;
    if (body.userAgent != null) {
      if (typeof body.userAgent !== 'string') return badRequest('userAgent must be a string');
      const uaRaw = truncateTo(body.userAgent, MAX_TITLE_LEN);
      const uaResult = validateField(boundedString(MAX_TITLE_LEN), uaRaw, 'userAgent');
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
  }, sanitizeRequestId(req.headers?.get('x-request-id') ?? null));
}

// DELETE /api/cowork/sessions?id=<sessionId>
// Removes a single session row. Gated by the same X-Cowork-Token check as
// every other /api/cowork/* data route (enforced in middleware.ts). Distinct
// from the AU-3 `?all=1` confirm:true mass-delete gate; per-id deletes are
// scoped erasure only.
export async function DELETE(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return badRequest('id is required');
    if (!CURSOR_ID_RE.test(id)) return badRequest('invalid id');
    try {
      await db.session.delete({ where: { id } });
    } catch (e) {
 // A well-formed but non-existent id makes Prisma throw P2025
 // (RecordNotFound); return a precise 404 instead of a generic 500.
      if (isPrismaRecordNotFound(e)) {
        return json({ error: 'not found' }, 404);
      }
      throw e;
    }
    const r = json({ ok: true });
    r.headers.set('Cache-Control', 'no-store, private');
    return r;
  }, sanitizeRequestId(req.headers?.get('x-request-id') ?? null));
}
