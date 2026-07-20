// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, badRequest, withRouteError, parseLimit, CURSOR_ID_RE, isPrismaRecordNotFound, sanitizeRequestId, redactSecrets } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
 // Cap the result set so a caller can't pull the entire table in one shot
 // (Default 100, hard max 200 — see parseLimit). Support cursor
 // pagination by `id` via the `after` query param.
    const limit = parseLimit(req);
    const after = req.nextUrl.searchParams.get('after') || undefined;
    if (after !== undefined && !CURSOR_ID_RE.test(after)) {
      return badRequest('invalid after cursor');
    }
    const args: Parameters<typeof db.siteMemory.findMany>[0] = {
      take: limit,
      orderBy: { createdAt: 'desc', id: 'desc' },
    };
    if (after) {
      args.cursor = { id: after };
      args.skip = 1;
    }
    let rows;
    try {
      rows = await db.siteMemory.findMany(args);
    } catch (e) {
 // A well-formed but stale/unknown cursor id makes Prisma throw P2025
 // (RecordNotFound); return a precise 400 instead of a generic 500.
      if (
        isPrismaRecordNotFound(e) ||
        (e instanceof Error && /P2025/.test(e.message))
      ) {
        return badRequest('invalid after cursor');
      }
      throw e;
    }
 // READ-TIME REDACTION. `SiteMemory.dataJson` may capture page content, form
 // values, PII, credentials, tokens, or other secrets (see the REDACTION
 // CONTRACT in schema.prisma). Scrub secret shapes from the JSON-encoded
 // `dataJson` before it leaves the server; structure is preserved, only
 // secret-shaped values are masked.
    const memories = rows.map((m) => ({
      ...m,
      dataJson: redactSecrets(m.dataJson ?? ''),
    }));
 // Signal whether more pages exist (only when a full page was returned and
 // the cursor id is well-formed) so the UI can drive cursor-based "load
 // more" — matches the form-memory GET contract.
    const last = rows.length === limit ? rows[rows.length - 1] : undefined;
    const nextCursor = last && CURSOR_ID_RE.test(last.id) ? last.id : null;
    const r = json({ memories, nextCursor });
 // Per-site memory is user data; never let browsers/proxies/CDNs cache it
 // (mirrors the form-memory GET).
    r.headers.set('Cache-Control', 'no-store, private');
    return r;
  }, sanitizeRequestId(req.headers?.get('x-request-id') ?? null));
}

// DELETE /api/cowork/memory/site?id=<siteMemoryId>
// Removes a single per-site memory entry. Gated by the same X-Cowork-Token
// check as every other /api/cowork/* data route (enforced in middleware.ts).
// PII-erasure endpoint — pairs with the FormMemory DELETE handler.
export async function DELETE(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return badRequest('id is required');
    if (!CURSOR_ID_RE.test(id)) return badRequest('invalid id');
    try {
      await db.siteMemory.delete({ where: { id } });
    } catch (e) {
 // A well-formed but non-existent id makes Prisma throw P2025
 // (RecordNotFound). The code lives in `e.code`, but a caller may surface
 // a plain Error whose message still reports P2025 (e.g. certain driver/
 // adapter layers); detect both so a missing entry is a precise 404 rather
 // than a 500. No internal detail is echoed — the response is generic.
      if (
        isPrismaRecordNotFound(e) ||
        (e instanceof Error && /P2025/.test(e.message))
      ) {
        return json({ error: 'not found' }, 404);
      }
      throw e;
    }
    return json({ ok: true });
  }, sanitizeRequestId(req.headers?.get('x-request-id') ?? null));
}
