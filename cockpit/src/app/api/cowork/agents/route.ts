// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const agentId = req.nextUrl.searchParams.get('agentId') || undefined;
    const agents = await db.agentTrust.findMany({
      where: agentId ? { agentId } : undefined,
      orderBy: { grantedAt: 'desc' },
    });
    // Project the Prisma `AgentTrust` fields onto the legacy `SampleAgent`
    // shape the `agents-view` was written against. The Prisma model has no
    // `type`/`status`/`currentTask`/`lastActive`/`tasksCompleted` columns,
    // so we derive sensible defaults.
    //   - type      → 'browser-extension' (the only agent kind today)
    //   - status    → 'idle' (no live run-state in the cockpit DB)
    //   - lastActive → grantedAt (best proxy for last activity)
    //   - tasksCompleted → 0 (the dashboard is read-only)
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
