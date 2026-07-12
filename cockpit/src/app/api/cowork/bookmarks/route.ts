// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, bodyJson, validateHttpUrl, badRequest, boundedString, MAX_NAME_LEN, MAX_URL_LEN } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

// Prisma's `include: { children: true }` only fetches ONE level of
// the self-relation — grandchildren and deeper render as leaf nodes because
// their `children` property is `undefined`. Real bookmark trees routinely
// have folders within folders (Bookmarks Bar → Development → Frontend →
// React), so the single-level query silently drops most of the tree.
//
// Fix: fetch ALL bookmarks flat (one query), then assemble the tree in JS.
// O(N) build via a parentId → children map. Roots are entries with
// `parentId === null`. This returns the full nested tree to the
// `BookmarkNode` recursive renderer in `collections-view.tsx`.
type BookmarkRow = Awaited<ReturnType<typeof db.bookmark.findMany>>[number];

// Cap the number of bookmark rows returned by GET so a huge table can't be
// served unbounded in a single response.
const MAX_BOOKMARKS = 5000;

function buildBookmarkTree(rows: BookmarkRow[]): { tree: BookmarkRow[]; orphans: BookmarkRow[] } {
  // Index every bookmark by its parent id (null → root bucket).
  const byParent = new Map<string | null, BookmarkRow[]>();
  for (const row of rows) {
    const key = row.parentId ?? null;
    const bucket = byParent.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      byParent.set(key, [row]);
    }
  }
  // Recursively attach `children` arrays. The cast is safe because we're
  // mutating the row objects in place to add the `children` property that
  // Prisma's `include: { children: true }` would have set. `ancestors` tracks
  // the chain of parent ids currently on the recursion stack so a cyclic /
  // self parent reference can't cause infinite recursion (which previously
  // turned `GET /api/cowork/bookmarks` into a stack-overflow 500). On a
  // back-edge we attach an empty `children` array — the node is rendered as a
  // leaf rather than crashing the request.
  const visited = new Set<string>();
  const attach = (parentId: string | null, ancestors: Set<string>): BookmarkRow[] => {
    const kids = byParent.get(parentId) ?? [];
    const result: BookmarkRow[] = [];
    for (const k of kids) {
      visited.add(k.id);
      if (ancestors.has(k.id)) {
        (k as BookmarkRow & { children: BookmarkRow[] }).children = [];
        result.push(k);
        continue;
      }
      const next = new Set(ancestors);
      next.add(k.id);
      (k as BookmarkRow & { children: BookmarkRow[] }).children = attach(k.id, next);
      result.push(k);
    }
    return result;
  };
  const tree = attach(null, new Set());
  // Any row not reachable from a root (dangling / broken `parentId`, or a
  // node orphaned by a cycle) is reported separately instead of being silently
  // dropped — surfacing broken references so they're observable rather than
  // appearing as lost data.
  const orphans = rows.filter((r) => r.parentId !== null && !visited.has(r.id));
  if (orphans.length > 0) {
    console.warn('[cowork] bookmarks: dropping orphaned rows (broken parentId / cycle)', {
      count: orphans.length,
      ids: orphans.slice(0, 20).map((o) => o.id),
    });
  }
  return { tree, orphans };
}

export async function GET(): Promise<Response> {
  return withRouteError(async () => {
    // Single flat query — `findMany({})` returns every row, ordered by
    // `dateAdded` desc so siblings within the same parent appear in
    // recency order (matching the original sort intent). Capped so a huge
    // table can't be returned unbounded in one response.
    const all = await db.bookmark.findMany({
      orderBy: { dateAdded: 'desc' },
      take: MAX_BOOKMARKS,
    });
    const { tree, orphans } = buildBookmarkTree(all);
    return json({ bookmarks: tree, orphans });
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const body = await bodyJson(req);
    const name = boundedString(body.name, MAX_NAME_LEN, 'Untitled');
    // Coerce `parentId` through the same bounded-string path as every other
    // free-text field (a bare `String(body.parentId)` would silently persist
    // `"[object Object]"` for a non-string value, or an unbounded string).
    const rawParentId =
      body.parentId !== undefined && body.parentId !== null ? boundedString(body.parentId, 128, '') : '';
    const parentId = rawParentId.length > 0 ? rawParentId : null;
    // Validate the referenced parent bookmark exists (the analog of a
    // relation-connect). A dangling parentId is rejected with 400 rather than
    // stored as an orphan reference.
    if (parentId) {
      const parent = await db.bookmark.findUnique({ where: { id: parentId } });
      if (!parent) return badRequest('unknown parentId');
    }
    // Allow creating `type: 'folder'` bookmarks (folders have no
    // URL — they group child bookmarks in the tree). Previously the route
    // always required an http/https URL and always set `type: 'url'`, so
    // the "New Folder" affordance in collections-view could never persist
    // a folder. Now: if `body.type === 'folder'`, skip URL validation and
    // store `url: null, type: 'folder'`. For `type === 'url'` (or
    // unspecified), keep the stored-XSS guard (http/https only).
    const rawType = typeof body.type === 'string' ? body.type.toLowerCase() : 'url';
    if (rawType === 'folder') {
      const bm = await db.bookmark.create({
        data: { name, url: null, parentId, type: 'folder' },
      });
      return json({ bookmark: bm }, 201);
    }
    const url = boundedString(body.url, MAX_URL_LEN, '');
    // Validate URL scheme (prevents javascript:/data: stored-XSS via <a href>).
    const urlError = validateHttpUrl(url);
    if (urlError) return urlError;
    // NOTE: we intentionally do NOT gate on `isSsrfSafeUrl` here. Stored
    // bookmark URLs are opened client-side in the browser, never fetched
    // server-side, so a developer's localhost/loopback bookmark must remain
    // valid. The SSRF guard is reserved for genuine server-side outbound
    // fetches/launches.
    const bm = await db.bookmark.create({
      data: { name, url, parentId, type: 'url' },
    });
    return json({ bookmark: bm }, 201);
  }, req.headers.get('x-request-id') ?? undefined);
}
