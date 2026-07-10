// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, bodyJson, validateHttpUrl } from '@/lib/cowork/api/http';
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

function buildBookmarkTree(rows: BookmarkRow[]): BookmarkRow[] {
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
  // Prisma's `include: { children: true }` would have set.
  const attach = (parentId: string | null): BookmarkRow[] => {
    const kids = byParent.get(parentId) ?? [];
    for (const k of kids) {
      (k as BookmarkRow & { children: BookmarkRow[] }).children = attach(k.id);
    }
    return kids;
  };
  return attach(null);
}

export async function GET(): Promise<Response> {
  return withRouteError(async () => {
    // Single flat query — `findMany({})` returns every row, ordered by
    // `dateAdded` desc so siblings within the same parent appear in
    // recency order (matching the original sort intent).
    const all = await db.bookmark.findMany({
      orderBy: { dateAdded: 'desc' },
    });
    const tree = buildBookmarkTree(all);
    return json({ bookmarks: tree });
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const body = await bodyJson(req);
    const name = String(body.name || 'Untitled');
    const parentId = body.parentId ? String(body.parentId) : null;
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
    const url = String(body.url || '');
    // Validate URL scheme (prevents javascript:/data: stored-XSS via <a href>).
    const urlError = validateHttpUrl(url);
    if (urlError) return urlError;
    const bm = await db.bookmark.create({
      data: { name, url, parentId, type: 'url' },
    });
    return json({ bookmark: bm }, 201);
  });
}
