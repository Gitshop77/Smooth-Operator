// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, parseLimit, parseAgentId, sanitizeRequestId } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
 // Cap `limit` to a hard max (parseLimit default 100, max 200) so a single
 // authenticated GET can't pull the entire agent-trust table in one shot.
    const limit = parseLimit(req);
 // `agentId` is forwarded straight into the Prisma `where` filter and must be
 // 1-128 chars with no control/whitespace characters (see `parseAgentId`). An
 // absent/empty param still means "no filter".
    const agentId = parseAgentId(req);
    const agents = await db.agentTrust.findMany({
      where: agentId ? { agentId } : undefined,
      orderBy: { grantedAt: 'desc' },
      take: limit,
    });
 // Project the Prisma `AgentTrust` fields onto the legacy `SampleAgent`
 // shape the `agents-view` was written against. The Prisma model has no
 // `type`/`status`/`currentTask`/`lastActive`/`tasksCompleted` columns,
 // so we derive sensible defaults.
 // - type → 'browser-extension' (the only agent kind today)
 // - status → 'idle' (no live run-state in the cockpit DB)
 // - lastActive → grantedAt (best proxy for last activity)
 // - tasksCompleted → 0 (the dashboard is read-only)
    const projected = agents.map((a) => ({
      ...a,
      type: 'browser-extension',
      status: 'idle',
      currentTask: null,
      lastActive: a.lastUsedAt ?? a.grantedAt,
      tasksCompleted: 0,
    }));
    return json({ agents: projected });
  }, sanitizeRequestId(req.headers?.get('x-request-id') ?? null));
}
