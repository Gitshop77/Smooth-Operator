// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const status = req.nextUrl.searchParams.get('status') || undefined;
    const agentId = req.nextUrl.searchParams.get('agentId') || undefined;
    // AND-combine filters so `?status=running&agentId=agent-7`
    // returns tasks for agent-7 that are running (previously the exclusive
    // if/else if silently dropped `agentId` whenever `status` was present).
    // Building the `where` object conditionally keeps the empty-object case
    // (no filters) equivalent to `findMany({})` — same as the prior fallback.
    const where: { status?: string; agentId?: string } = {};
    if (status) where.status = status;
    if (agentId) where.agentId = agentId;
    const tasks = await db.task.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    return json({ tasks });
  });
}
