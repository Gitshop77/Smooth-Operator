// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, withRouteError, bodyJson, badRequest } from '@/lib/cowork/api/http';
import { boundedString, nonEmptyString, scheduleCronSchema, validateField, truncateTo } from '@/lib/cowork/api/validation';
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
    // Bound free-form strings so a future view can't be abused by
    // oversized stored values.
    const nameResult = validateField(nonEmptyString(256), truncateTo(body.name || 'Untitled Workflow', 256), 'name');
    if (!nameResult.ok) return badRequest(nameResult.error);
    const name = nameResult.value;
    const description = truncateTo(body.description || '', 2000);
    const descResult = validateField(boundedString(2000), description, 'description');
    if (!descResult.ok) return badRequest(descResult.error);
    const steps = Array.isArray(body.steps) ? body.steps : [];
    const isRecurring = Boolean(body.isRecurring);
    // Validate the cron expression against a strict, shell-safe grammar
    // before storing it (a future scheduler may act on this value).
    let scheduleCron: string | null = null;
    if (body.scheduleCron != null) {
      const cronResult = validateField(scheduleCronSchema, String(body.scheduleCron), 'scheduleCron');
      if (!cronResult.ok) return badRequest(cronResult.error);
      scheduleCron = cronResult.value;
    }
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
