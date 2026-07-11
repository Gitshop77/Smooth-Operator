// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, bodyJson, badRequest, validateHttpUrl, parseLimit, boundedString, MAX_URL_LEN, MAX_TITLE_LEN, MAX_SOURCE_LEN } from '@/lib/cowork/api/http';
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
    const tabs = await db.tab.findMany({
      where,
      take: limit,
      orderBy: { lastAccessedAt: 'desc' },
      include: { workspace: { select: { name: true } } },
    });
    const count = await db.tab.count({ where });
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
    return json({ tabs: projected, total: count });
  });
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
    // A bogus workspaceId would otherwise surface as a Prisma "not found"
    // 404 with a raw message. Validate the FK exists first and return 400.
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
  });
}
