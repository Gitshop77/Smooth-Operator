// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, bodyJson, badRequest, validateHttpUrl, parseLimit, boundedString, MAX_URL_LEN, MAX_TITLE_LEN, MAX_SOURCE_LEN, sanitizeRequestId, CURSOR_ID_RE, isPrismaRecordNotFound } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const workspaceId = req.nextUrl.searchParams.get('workspaceId') || undefined;
 // Cap `limit` to a hard max of 200 so a hostile or buggy
 // caller can't ask for the entire table in one shot. Default 100.
    const limit = parseLimit(req);
    const where = workspaceId ? { workspaceId } : undefined;
 // Include the `workspace` relation so the dashboard can show
 // `workspaceName` without a second round-trip.
    const [tabs, count] = await Promise.all([
      db.tab.findMany({
        where,
        take: limit,
        orderBy: { lastAccessedAt: 'desc' },
        include: { workspace: { select: { name: true } } },
      }),
      db.tab.count({ where }),
    ]);
 // Project the workspace name onto each tab row so the legacy
 // `workspaceName` field expected by `tabs-view` is populated. Also
 // mirror `lastAccessedAt` → `lastAccessed` for the same reason.
    const projected = tabs.map((t) => ({
      ...t,
      workspaceName: t.workspace?.name ?? null,
      lastAccessed: t.lastAccessedAt,
      favIconUrl: t.favicon,
      pinned: t.isPinned,
      audiblyMuted: t.isMuted,
    }));
    const r = json({ tabs: projected, total: count });
    r.headers.set('Cache-Control', 'no-store, private');
    return r;
  }, sanitizeRequestId(req.headers?.get('x-request-id') ?? null));
}

export async function POST(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const body = await bodyJson(req);
    const url = boundedString(body.url, MAX_URL_LEN);
    const title = boundedString(body.title ?? url, MAX_TITLE_LEN);
    const workspaceId = boundedString(body.workspaceId, MAX_SOURCE_LEN, '');
    if (!url) return badRequest('url is required');
 // Validate URL scheme (prevents javascript:/data: stored-XSS via <a href>).
    const urlError = validateHttpUrl(url);
    if (urlError) return urlError;
 // NOTE: we intentionally do NOT gate on `isSsrfSafeUrl` here. Stored tab
 // URLs are opened client-side in the browser, never fetched server-side, so
 // a developer's localhost/loopback bookmark (http://localhost:3000) must
 // remain valid. The SSRF guard is reserved for genuine server-side
 // outbound fetches/launches.
 // Validate the workspace FK exists before creating the tab, so a missing
 // workspaceId surfaces as a clean 400 (does not reach create) instead of a
 // dangling-FK 500.
    if (workspaceId) {
      const ws = await db.workspace.findUnique({ where: { id: workspaceId } });
      if (!ws) return badRequest('unknown workspaceId');
    }
    const tab = await db.tab.create({
      data: {
        url,
        title,
        workspace: workspaceId ? { connect: { id: workspaceId } } : undefined,
        status: 'loading',
        source: boundedString(body.source, MAX_SOURCE_LEN, 'user'),
      },
    });
    return json({ tab }, 201);
  }, sanitizeRequestId(req.headers?.get('x-request-id') ?? null));
}

// DELETE /api/cowork/tabs?id=<tabId>
// Removes a single tab row. Gated by the same X-Cowork-Token check as
// every other /api/cowork/* data route (enforced in middleware.ts). Distinct
// from the AU-3 `?all=1` confirm:true mass-delete gate; per-id deletes are
// scoped erasure only.
export async function DELETE(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return badRequest('id is required');
    if (!CURSOR_ID_RE.test(id)) return badRequest('invalid id');
    try {
      await db.tab.delete({ where: { id } });
    } catch (e) {
 // Prisma throws P2025 (RecordNotFound) when the id does't exist. The
 // code lives in `e.code`, but a caller / driver layer may surface a
 // plain `Error` whose message still reports P2025; detect both so a
 // missing tab is a precise 404 rather than a 500 (mirrors the
 // history / memory/form delete handlers).
      if (
        isPrismaRecordNotFound(e) ||
        (e instanceof Error && /P2025/.test(e.message))
      ) {
        return json({ error: 'not found' }, 404);
      }
      throw e;
    }
    const r = json({ ok: true });
    r.headers.set('Cache-Control', 'no-store, private');
    return r;
  }, sanitizeRequestId(req.headers?.get('x-request-id') ?? null));
}
