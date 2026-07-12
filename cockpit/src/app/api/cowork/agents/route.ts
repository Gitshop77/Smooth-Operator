// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, parseLimit, badRequest } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
 // Cap `limit` to a hard max (parseLimit default 100, max 200) so a single
 // authenticated GET can't pull the entire agent-trust table in one shot.
    const limit = parseLimit(req);
 // `agentId` is forwarded straight into the Prisma `where` filter. Prisma
 // parameterizes it (no SQLi), but previously an arbitrarily long (multi-MB)
 // string was accepted and forwarded to the DB, bloating request size and
 // query-parse work. Bound it to ≤ 128 chars (consistent with the `sessionId`
 // cap on other routes) and reject control/whitespace characters. An absent
 // param or an empty value (`?agentId=`) still means "no filter", preserving
 // the prior `|| undefined` behaviour.
    const rawAgentId = req.nextUrl.searchParams.get('agentId');
    let agentId: string | undefined;
    if (rawAgentId !== null && rawAgentId !== '') {
      if (rawAgentId.length > 128 || /[\s\u0000-\u001f]/.test(rawAgentId)) {
        return badRequest('Invalid agentId; must be 1-128 chars with no control/whitespace characters');
      }
      agentId = rawAgentId;
    }
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
  });
}
