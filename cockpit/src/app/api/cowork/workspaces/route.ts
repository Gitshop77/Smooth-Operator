// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, bodyJson, badRequest, parseLimit, CURSOR_ID_RE, isPrismaRecordNotFound, isPrismaForeignKeyConstraint, sanitizeRequestId } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
 // Cap `limit` to a hard max of 200 so a single response can't return the
 // entire table. Default 100 (see parseLimit).
    const limit = parseLimit(req);
 // Include the `tabs` relation count so the dashboard can derive
 // `tabCount` without a second round-trip.
    const workspaces = await db.workspace.findMany({
      take: limit,
      orderBy: { order: 'asc' },
      include: { _count: { select: { tabs: true } } },
    });
 // Project the tab count + a legacy `icon` alias (== emoji) so the
 // existing `workspaces-view` keeps rendering without code changes.
    const projected = workspaces.map((ws) => ({
      ...ws,
      tabCount: ws._count?.tabs ?? 0,
      icon: ws.emoji,
    }));
    const r = json({ workspaces: projected });
    r.headers.set('Cache-Control', 'no-store, private');
    return r;
  }, sanitizeRequestId(req.headers?.get('x-request-id') ?? null));
}

// Validate/normalize an optional free-text field (used for `name` and `emoji`).
// Returns the (optionally trimmed) string, or a 400 Response when the type or
// length is invalid, or the caller-supplied `fallback` when empty/absent.
function coerceTextField(
  value: unknown,
  opts: { max: number; fallback: string; field: string; trim?: boolean },
): string | Response {
  if (value == null || value === '') return opts.fallback;
  if (typeof value !== 'string') return badRequest(`${opts.field} must be a string`);
  const candidate = opts.trim ? value.trim() : value;
  if (candidate === '') return opts.fallback;
  if (Array.from(candidate).length > opts.max) {
    return badRequest(`${opts.field} must be at most ${opts.max} characters`);
  }
  return candidate;
}

export async function POST(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const body = await bodyJson(req);
 // F17-val: validate/normalize color, name, and emoji.
 // Only valid CSS hex lengths (3/4/6/8 digits) are accepted; 5/7-digit
 // strings are not real colors and would render broken in the UI.
    const COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
    const nameResult = coerceTextField(body.name, {
      max: 64,
      fallback: 'Untitled',
      field: 'name',
      trim: true,
    });
    if (nameResult instanceof Response) return nameResult;
    const name = nameResult;
    const emojiSrc = body.emoji ?? body.icon;
    const emojiResult = coerceTextField(emojiSrc, { max: 8, fallback: '📁', field: 'emoji' });
    if (emojiResult instanceof Response) return emojiResult;
    const emoji = emojiResult;
    const rawColor = typeof body.color === 'string' ? body.color : '';
    const color = COLOR_RE.test(rawColor) ? rawColor : '#4285f4';
    const ws = await db.workspace.create({ data: { name, emoji, color } });
    return json({ workspace: ws }, 201);
  }, sanitizeRequestId(req.headers?.get('x-request-id') ?? null));
}

// DELETE /api/cowork/workspaces?id=<workspaceId>
// Removes a single workspace row. Gated by the same X-Cowork-Token check as
// every other /api/cowork/* data route (enforced in middleware.ts). Distinct
// from the AU-3 `?all=1` confirm:true mass-delete gate; per-id deletes are
// scoped erasure only.
export async function DELETE(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return badRequest('id is required');
    if (!CURSOR_ID_RE.test(id)) return badRequest('invalid id');
    try {
      await db.workspace.delete({ where: { id } });
    } catch (e) {
      if (isPrismaRecordNotFound(e)) {
        return json({ error: 'not found' }, 404);
      }
      if (isPrismaForeignKeyConstraint(e)) {
        return json(
          { error: 'workspace still has tabs; move or delete them first' },
          409,
        );
      }
      throw e;
    }
    const r = json({ ok: true });
    r.headers.set('Cache-Control', 'no-store, private');
    return r;
  }, sanitizeRequestId(req.headers?.get('x-request-id') ?? null));
}
