// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, bodyJson, badRequest } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

export async function GET(): Promise<Response> {
  return withRouteError(async () => {
 // Include the `tabs` relation count so the dashboard can derive
 // `tabCount` without a second round-trip.
    const workspaces = await db.workspace.findMany({
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
    return json({ workspaces: projected });
  });
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
  });
}
