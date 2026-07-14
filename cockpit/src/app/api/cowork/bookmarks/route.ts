// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, bodyJson, validateHttpUrl, isSsrfSafeUrl, badRequest, boundedString, MAX_NAME_LEN, MAX_URL_LEN, sanitizeRequestId } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

// Prisma's `include: { children: true }` only fetches ONE level of
// the self-relation — grandchildren and deeper render as leaf nodes because
// their `children` property is `undefined`. Real bookmark trees routinely
// have folders within folders (Bookmarks Bar → Development → Frontend →
// React), so the single-level query silently drops most of the tree.
//
// fetch ALL bookmarks flat (one query), then assemble the tree in JS.
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
    console.warn('[cowork] bookmarks: orphaned rows (broken parentId / cycle) — returned separately', {
      count: orphans.length,
      ids: orphans.slice(0, 20).map((o) => o.id),
    });
  }
  return { tree, orphans };
}

// Atomically validate the parent and create the bookmark in one transaction so a
// concurrent delete can't leave a dangling `parentId` (see the branch notes
// below). A `null` return signals the parent was missing -> 400.
async function createBookmark(
  type: 'url' | 'folder',
  name: string,
  url: string | null,
  parentId: string | null,
): Promise<BookmarkRow | null> {
  return db.$transaction(async (tx) => {
    if (parentId) {
      const parent = await tx.bookmark.findUnique({ where: { id: parentId } });
      if (!parent) return null;
    }
    return tx.bookmark.create({
      data: { name, url, parentId, type },
    });
  });
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
 // Preserve referential integrity under the recency cap. The take above only
 // returns the `MAX_BOOKMARKS` most-recent rows; any bookmark in an *older*
 // row that is the child of an in-cap parent would otherwise be silently
 // dropped (the parent renders with no children) and any in-cap row that
 // references an older parent would surface as a dangling orphan. Close the
 // parent/child references reachable from the fetched rows so every in-cap
 // node keeps its full subtree and fetched rows attach to a real parent.
 // Bounded by the total row count and converges once the connected component
 // is fully materialized.
    const known = new Map<string, BookmarkRow>(all.map((r) => [r.id, r]));
    const frontier: string[] = all.map((r) => r.id);
    while (frontier.length > 0) {
      const batch = frontier.splice(0, frontier.length);
      const related = await db.bookmark.findMany({
        where: { OR: [{ id: { in: batch } }, { parentId: { in: batch } }] },
      });
      for (const row of related) {
        if (!known.has(row.id)) {
          known.set(row.id, row);
          frontier.push(row.id);
        }
      }
    }
    const { tree, orphans } = buildBookmarkTree([...known.values()]);
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
 //
 // The existence check and the create must be ATOMIC: a bare
 // `findUnique` followed by a separate `create` lets a concurrent delete
 // remove the parent in between, producing exactly the dangling
 // `parentId` the check was meant to prevent . We therefore
 // re-validate the parent *inside* the same transaction as the create, so
 // both observe a consistent snapshot. A `null` result from the
 // transaction signals the parent was missing → 400.
 // Allow creating `type: 'folder'` bookmarks (folders have no
 // URL — they group child bookmarks in the tree). Previously the route
 // always required an http/https URL and always set `type: 'url'`, so
 // the "New Folder" affordance in collections-view could never persist
 // a folder. Now: if `body.type === 'folder'`, skip URL validation and
 // store `url: null, type: 'folder'`. For `type === 'url'` (or
 // unspecified), keep the stored-XSS guard (http/https only).
    const rawType = typeof body.type === 'string' ? body.type.toLowerCase() : 'url';
 // Reject unknown types instead of silently coercing them to `'url'`. An
 // unrecognized `type` is almost certainly a caller/contract bug, not a
 // folder without a URL, so a clear 400 beats a mislabeled bookmark.
    if (rawType !== 'url' && rawType !== 'folder') {
      return badRequest('type must be "url" or "folder"');
    }
    if (rawType === 'folder') {
      const bm = await createBookmark('folder', name, null, parentId);
      if (!bm) return badRequest('unknown parentId');
      return json({ bookmark: bm }, 201);
    }
    const url = boundedString(body.url, MAX_URL_LEN, '');
 // Validate URL scheme (prevents javascript:/data: stored-XSS via <a href>).
    const urlError = validateHttpUrl(url);
    if (urlError) return urlError;
 // SSRF gate: bookmarks are stored here but the assistant can later *launch*
 // them server-side, so we must reject loopback / RFC1918 / link-local /
 // cloud-metadata hosts at storage time. This is the one storage route that
 // needs the guard because bookmark URLs are actionable server-side, unlike
 // plain tab URLs that are only ever opened in the user's browser. A
 // developer's `localhost` bookmark is therefore rejected (400) here.
    if (!isSsrfSafeUrl(url)) return badRequest('URL host is not allowed');
    const bm = await createBookmark('url', name, url, parentId);
    if (!bm) return badRequest('unknown parentId');
    return json({ bookmark: bm }, 201);
  }, sanitizeRequestId(req.headers.get('x-request-id')));
}
