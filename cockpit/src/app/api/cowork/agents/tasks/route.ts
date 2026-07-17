// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, parseLimit, badRequest, parseAgentId, sanitizeRequestId } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

// Mirrors the closed `status` enum documented on the `Task` model in
// prisma/schema.prisma. SQLite has no native enum, so the contract is enforced
// here at the API boundary (same approach as the `severity` guard in
// security/events/route.ts).
const ALLOWED_TASK_STATUSES = [
  'pending',
  'running',
  'paused',
  'waiting-approval',
  'ready-to-resume',
  'done',
  'failed',
  'cancelled',
] as const;
type TaskStatus = (typeof ALLOWED_TASK_STATUSES)[number];

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
 // Cap `limit` to a hard max (parseLimit default 100, max 200) so a single
 // authenticated GET can't pull the entire task table in one shot.
    const limit = parseLimit(req);
    const status = req.nextUrl.searchParams.get('status');
    const agentId = parseAgentId(req);
 // Reject junk `status` values with 400 instead of silently returning an
 // empty set. Prisma parameterizes the input (not an injection risk), but an
 // unvalidated string yields a confusing empty result for non-matching input.
 // An absent or empty param (`?status=` or no param) falls back to "no
 // filter", preserving the prior `|| undefined` behaviour.
    if (status !== null && status !== '' && !ALLOWED_TASK_STATUSES.includes(status as TaskStatus)) {
      return badRequest(
        `Invalid status "${status}"; allowed values: ${ALLOWED_TASK_STATUSES.join(', ')}`,
      );
    }
 // AND-combine filters so `?status=running&agentId=agent-7` returns running
 // tasks for agent-7. An empty `where` (no filters) is equivalent to `findMany({})`.
    const where: { status?: TaskStatus; agentId?: string } = {};
    if (status) where.status = status as TaskStatus;
    if (agentId) where.agentId = agentId;
    const tasks = await db.task.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return json({ tasks });
  }, sanitizeRequestId(req.headers?.get('x-request-id') ?? null));
}
