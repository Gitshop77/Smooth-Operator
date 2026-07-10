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

export async function POST(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const body = await bodyJson(req);
    // F17-val: validate/normalize color, name, and emoji.
    const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
    let name: string;
    if (body.name == null || body.name === '') {
      name = 'Untitled';
    } else if (typeof body.name !== 'string') {
      return badRequest('name must be a string');
    } else if (body.name.length > 64) {
      return badRequest('name must be at most 64 characters');
    } else {
      name = body.name;
    }
    const emojiSrc = body.emoji ?? body.icon;
    let emoji: string;
    if (emojiSrc == null || emojiSrc === '') {
      emoji = '📁';
    } else if (typeof emojiSrc !== 'string') {
      return badRequest('emoji must be a string');
    } else if (emojiSrc.length > 8) {
      return badRequest('emoji must be at most 8 characters');
    } else {
      emoji = emojiSrc;
    }
    const rawColor = typeof body.color === 'string' ? body.color : '';
    const color = COLOR_RE.test(rawColor) ? rawColor : '#4285f4';
    const ws = await db.workspace.create({ data: { name, emoji, color } });
    return json({ workspace: ws }, 201);
  });
}
