// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import {
  json,
  badRequest,
  withRouteError,
  parseLimit,
  bodyJson,
  validateHttpUrl,
  boundedString,
  MAX_URL_LEN,
  MAX_TITLE_LEN,
} from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
 // Bound the free-text search term so a hostile/buggy caller can't submit an
 // unbounded `LIKE '%…%'` pattern against the indexed url/title columns.
    const qRaw = req.nextUrl.searchParams.get('q');
    const q = qRaw ? boundedString(qRaw, 256, '') : undefined;
 // Cap `limit` to a hard max of 200 so a hostile or buggy
 // caller can't ask for the entire table in one shot. Default 50.
    const limit = parseLimit(req, 50);
    const entries = q
      ? await db.historyEntry.findMany({
          where: { OR: [{ url: { contains: q } }, { title: { contains: q } }] },
          take: limit,
          orderBy: { lastVisitedAt: 'desc' },
        })
      : await db.historyEntry.findMany({ take: limit, orderBy: { lastVisitedAt: 'desc' } });
 // Project `lastVisitedAt` → legacy `visitedAt` alias so the
 // `collections-view`'s history tab keeps sorting + rendering correctly.
    const projected = entries.map((h) => ({
      ...h,
      visitedAt: h.lastVisitedAt,
    }));
    return json({ history: projected });
  });
}

// POST /api/cowork/history — record a visit to a URL.
// Honors the WRITE CONTRACT in prisma/schema.prisma: `HistoryEntry.url` is
// @unique, so revisiting a URL MUST NOT raw-create (that throws P2002). We
// upsert on `url`: a first visit inserts, a revisit increments `visitCount`
// and refreshes `title`/`lastVisitedAt`. This is the upsert write path the
// schema comment was referring to; previously the table was GET/DELETE-only
// and any future naive `create` would 500 on the first revisit.
export async function POST(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const body = await bodyJson(req);
    const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
    if (!rawUrl) return badRequest('url required (non-empty string)');
 // Bound the URL length (aligns with the sibling tabs/bookmarks routes) and
 // rejects a non-string URL with 400 instead of silently persisting
 // `"[object Object]"`. Stored URLs open client-side in the browser, never
 // fetched server-side, so we only enforce the scheme (storage-route contract).
    const url = boundedString(rawUrl, MAX_URL_LEN, '');
    const urlErr = validateHttpUrl(url);
    if (urlErr) return urlErr;
    const title = boundedString(body.title, MAX_TITLE_LEN, '');
    const entry = await db.historyEntry.upsert({
      where: { url },
      create: { url, title },
      update: {
        title,
        visitCount: { increment: 1 },
        lastVisitedAt: new Date(),
      },
    });
    return json({ ok: true, entry }, 201);
  }, req.headers.get('x-request-id') ?? undefined);
}

// DELETE /api/cowork/history?id=<historyEntryId> — erase a single history
// entry. DELETE /api/cowork/history?all=1 — erase all browsing history.
// Gated by the same X-Cowork-Token check as every other /api/cowork/* data
// route (enforced in middleware.ts). Representative PII-erasure endpoint
// (GDPR-style "right to erasure" for stored browsing history). See PRIVACY.md
// in the repo root for the full data-flow / retention / deletion disclosure
// that this endpoint backs.
// NOTE: history erasure uses Prisma directly (the cockpit owns this
// table), whereas ai/chat proxies to cowork-events. Both ultimately return the
// same `{ ok }` envelope shape; the divergence is intentional.
export async function DELETE(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const all = req.nextUrl.searchParams.get('all') === '1';
    if (all) {
 // A bulk wipe must be explicitly confirmed server-side. The
 // UI "are you sure?" prompt is not sufficient — an authenticated caller
 // (or a stolen token) could otherwise wipe everything with a bare
 // `?all=1`. Require `confirm: true` in the JSON body.
      const b = await bodyJson(req);
      if (b.confirm !== true) {
        return badRequest('confirmation required');
      }
 // Optional scoping: `olderThan` (ISO-8601 timestamp) limits the wipe to
 // entries older than that time, so a single fat-fingered `?all=1` can't
 // unconditionally destroy the entire history. `confirm` is still required.
      const where: { lastVisitedAt?: { lt: Date } } = {};
      const scope = typeof b.olderThan === 'string' ? b.olderThan : undefined;
      if (scope) {
        const ts = Date.parse(scope);
        if (Number.isNaN(ts)) {
          return badRequest('olderThan must be an ISO-8601 timestamp');
        }
        where.lastVisitedAt = { lt: new Date(ts) };
      }
      const { count } = await db.historyEntry.deleteMany({ where });
 // Log the bulk delete so the action is observable server-side.
      console.info('[cowork] bulk delete history', { deleted: count, scope: scope ?? 'all', route: '/api/cowork/history' });
      return json({ ok: true, deleted: count });
    }
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return badRequest('id is required (or ?all=1 to clear all)');
    try {
      await db.historyEntry.delete({ where: { id } });
    } catch (e) {
 // Prisma throws P2025 (RecordNotFound) when the id doesn't exist. The
 // code lives in `e.code`, not the message, so test that directly.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        return json({ error: 'not found' }, 404);
      }
      throw e;
    }
    return json({ ok: true });
  }, req.headers.get('x-request-id') ?? undefined);
}
