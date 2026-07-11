// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, bodyJson, badRequest, validateHttpUrl, isSsrfSafeUrl, parseLimit } from '@/lib/cowork/api/http';
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
    const url = String(body.url || '');
    const title = String(body.title || url);
    const workspaceId = String(body.workspaceId || '');
    if (!url) return badRequest('url is required');
    // Validate URL scheme (prevents javascript:/data: stored-XSS via <a href>).
    const urlError = validateHttpUrl(url);
    if (urlError) return urlError;
    // Enforce the SSRF boundary on stored URLs so a private/loopback host
    // can never later become an SSRF sink if this URL is fetched/launched
    // server-side.
    if (!isSsrfSafeUrl(url)) return badRequest('url host is not allowed (private/loopback address)');
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
        source: String(body.source || 'user'),
      },
    });
    return json({ tab }, 201);
  });
}
