// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, bodyJson } from '@/lib/cowork/api/http';
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
    const name = String(body.name || 'Untitled');
    const emoji = String(body.emoji ?? body.icon ?? '📁');
    const color = String(body.color || '#4285f4');
    const ws = await db.workspace.create({ data: { name, emoji, color } });
    return json({ workspace: ws }, 201);
  });
}
