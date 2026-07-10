// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, bodyJson } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

export async function GET(): Promise<Response> {
  return withRouteError(async () => {
    const workflows = await db.workflow.findMany({ orderBy: { createdAt: 'desc' } });
    // Project the Prisma `Workflow` fields onto the legacy `SampleWorkflow`
    // shape the view expects: `isRecurring` → `enabled`, `lastRunAt` →
    // `lastRun`, and synthesize `runs` (no column for it).
    const projected = workflows.map((wf) => ({
      ...wf,
      enabled: wf.isRecurring,
      runs: 0,
      lastRun: wf.lastRunAt,
    }));
    return json({ workflows: projected });
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const body = await bodyJson(req);
    const name = String(body.name || 'Untitled Workflow');
    const description = String(body.description || '');
    const steps = body.steps || [];
    const isRecurring = Boolean(body.isRecurring);
    const scheduleCron = body.scheduleCron ? String(body.scheduleCron) : null;
    const wf = await db.workflow.create({
      data: {
        name,
        description,
        stepsJson: JSON.stringify(steps),
        isRecurring,
        scheduleCron,
      },
    });
    return json({ workflow: wf }, 201);
  });
}
