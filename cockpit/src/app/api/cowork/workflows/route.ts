// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { json, withRouteError, bodyJson, badRequest, parseLimit } from '@/lib/cowork/api/http';
import { scheduleCronSchema, truncateTo, validateField } from '@/lib/cowork/api/validation';
import { db } from '@/lib/db';

// Bound an individual workflow step and the array as a whole so a malformed or
// oversized step graph can't be persisted and only fail later (e.g. when a
// future scheduler parses it). Steps are intentionally permissive — each is an
// object — but the array length is capped and the serialized payload is
// bounded below before it is stored.
const MAX_STEPS = 500;
const MAX_STEPS_BYTES = 1_000_000;
const MAX_VARIABLES_BYTES = 100_000;
const stepSchema = z.record(z.string(), z.unknown());
const stepsSchema = z.array(stepSchema).max(MAX_STEPS);

// Cursor id shape used for `after` pagination. A valid id is a short, URL-safe
// token (cuid/uuid); anything else is rejected at the boundary with 400 rather
// than reaching Prisma. (Table ids are cuid strings, well within this bound.)
const CURSOR_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
 // Cap the result set so a caller can't pull the entire table in one shot
 // (default 100, hard max 200 — see parseLimit). Support cursor pagination
 // by `id` via the `after` query param, mirroring memory/site/route.ts.
    const limit = parseLimit(req);
    const after = req.nextUrl.searchParams.get('after') || undefined;
    if (after !== undefined && !CURSOR_ID_RE.test(after)) {
      return badRequest('invalid after cursor');
    }
    const args: Parameters<typeof db.workflow.findMany>[0] = {
      take: limit,
      orderBy: { createdAt: 'desc' },
    };
    if (after) {
      args.cursor = { id: after };
      args.skip = 1;
    }
    let workflows;
    try {
      workflows = await db.workflow.findMany(args);
    } catch (e: unknown) {
 // A well-formed but stale/unknown cursor id makes Prisma throw P2025
 // (RecordNotFound); return a precise 400 instead of a generic 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        return badRequest('invalid after cursor');
      }
      throw e;
    }
    const total = await db.workflow.count();
 // Project the Prisma `Workflow` fields onto the legacy `SampleWorkflow`
 // shape the view expects: `isRecurring` → `enabled`, `lastRunAt` →
 // `lastRun`. The legacy `runs` field has no backing column and no consumer,
 // so it is intentionally omitted rather than synthesized to a misleading 0.
    const projected = workflows.map((wf) => ({
      ...wf,
      enabled: wf.isRecurring,
      lastRun: wf.lastRunAt,
    }));
    return json({ workflows: projected, total });
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const body = await bodyJson(req);
 // Bound free-form strings so a future view can't be abused by oversized
 // stored values. `truncateTo` already rejects non-string input with a 400
 // (ClientError), so the value is always a valid, length-bounded string here.
    const name = truncateTo(body.name || 'Untitled Workflow', 256);
    const description = truncateTo(body.description || '', 2000);

 // Validate the step array against a bounded schema before serializing, so
 // a malformed/oversized graph is rejected with a 400 here instead of
 // failing later at parse time.
    const rawSteps = Array.isArray(body.steps) ? body.steps : [];
    const stepsResult = validateField(stepsSchema, rawSteps, 'steps');
    if (!stepsResult.ok) return badRequest(stepsResult.error);
    let stepsJson: string;
    try {
      stepsJson = JSON.stringify(stepsResult.value);
    } catch {
      return badRequest('steps are not serializable');
    }
    if (stepsJson.length > MAX_STEPS_BYTES) {
      return badRequest('steps are too large');
    }

    const isRecurring = Boolean(body.isRecurring);
 // Validate the cron expression against a strict, shell-safe grammar
 // before storing it (a future scheduler may act on this value).
    let scheduleCron: string | null = null;
    if (body.scheduleCron != null) {
      const cronResult = validateField(scheduleCronSchema, String(body.scheduleCron), 'scheduleCron');
      if (!cronResult.ok) return badRequest(cronResult.error);
      scheduleCron = cronResult.value;
    }

 // Populate the declared `variablesJson` column from the request so the
 // schema/contract no longer drifts (it was previously always NULL for
 // cockpit-created workflows). `variables` is an arbitrary JSON-serializable
 // value; we store its serialized form and bound its size.
    let variablesJson: string | null = null;
    if (body.variables != null) {
      let serialized: string;
      try {
        serialized = JSON.stringify(body.variables);
      } catch {
        return badRequest('variables are not serializable');
      }
      if (serialized.length > MAX_VARIABLES_BYTES) {
        return badRequest('variables are too large');
      }
      variablesJson = serialized;
    }

    const wf = await db.workflow.create({
      data: {
        name,
        description,
        stepsJson,
        variablesJson,
        isRecurring,
        scheduleCron,
      },
    });
    return json({ workflow: wf }, 201);
  });
}
