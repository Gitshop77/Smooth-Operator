// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { json, withRouteError, bodyJson, badRequest, parseLimit, isPrismaRecordNotFound, sanitizeRequestId } from '@/lib/cowork/api/http';
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
 // Fetch one extra record beyond `limit` so we can tell definitively whether
 // another page exists, instead of inferring it from `length === limit` (which
 // yields a spurious cursor when the table size is an exact multiple of `limit`).
      take: limit + 1,
 // `id` as a deterministic tiebreaker keeps the order a strict total order
 // (two workflows can share a `createdAt`), so cursor pagination is correct.
      orderBy: { createdAt: 'desc', id: 'desc' },
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    };
    let workflows: Awaited<ReturnType<typeof db.workflow.findMany>>;
    let total: number;
    try {
 // Run the independent findMany + count concurrently in a single round-trip.
      [workflows, total] = await Promise.all([
        db.workflow.findMany(args),
        db.workflow.count(),
      ]);
    } catch (e: unknown) {
 // A well-formed but stale/unknown cursor id makes Prisma throw P2025
 // (RecordNotFound); return a precise 400 instead of a generic 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        return badRequest('invalid after cursor');
      }
      throw e;
    }
 // Project the Prisma `Workflow` fields onto the legacy `SampleWorkflow`
 // shape the view expects: `isRecurring` → `enabled`, `lastRunAt` →
 // `lastRun`. The legacy `runs` field has no backing column and no consumer,
 // so it is intentionally omitted rather than synthesized to a misleading 0.
 // We operate on `pageItems` (the trimmed page) so the projected payload never
 // includes the extra look-ahead record fetched to detect the next page.
 // Signal whether more pages exist. Because we fetched `limit + 1` records, a
 // full page (`workflows.length > limit`) means at least one more record exists
 // past this page; otherwise this is the last page (no spurious nextCursor on an
 // exact multiple of `limit`).
    const hasMore = workflows.length > limit;
    const pageItems = hasMore ? workflows.slice(0, limit) : workflows;
    const projected = pageItems.map((wf) => ({
      ...wf,
      enabled: wf.isRecurring,
      lastRun: wf.lastRunAt,
    }));
    const last = pageItems.length ? pageItems[pageItems.length - 1] : undefined;
    const nextCursor = hasMore && last && CURSOR_ID_RE.test(last.id) ? last.id : null;
    return json({ workflows: projected, total, nextCursor });
  }, sanitizeRequestId(req.headers?.get('x-request-id') ?? null));
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
    const stepsJson = JSON.stringify(stepsResult.value);
    if (stepsJson.length > MAX_STEPS_BYTES) {
      return badRequest('steps are too large');
    }

    const isRecurring = typeof body.isRecurring === 'boolean' ? body.isRecurring : false;
 // Validate the cron expression against a strict, shell-safe grammar
 // before storing it (a future scheduler may act on this value).
    let scheduleCron: string | null = null;
    if (body.scheduleCron != null) {
      const cronResult = validateField(scheduleCronSchema, String(body.scheduleCron), 'scheduleCron');
      if (!cronResult.ok) return badRequest(cronResult.error);
      scheduleCron = cronResult.value;
    }

 // Populate the declared `variablesJson` column from the request. `variables`
 // is an arbitrary JSON-serializable value; store its serialized form, bounded.
    let variablesJson: string | null = null;
    if (body.variables != null) {
      const serialized = JSON.stringify(body.variables);
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
  }, sanitizeRequestId(req.headers?.get('x-request-id') ?? null));
}

// DELETE /api/cowork/workflows?id=<workflowId>
// Removes a single workflow row. Gated by the same X-Cowork-Token check as
// every other /api/cowork/* data route (enforced in middleware.ts). Distinct
// from the AU-3 `?all=1` confirm:true mass-delete gate; per-id deletes are
// scoped erasure only.
export async function DELETE(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return badRequest('id is required');
    if (!CURSOR_ID_RE.test(id)) return badRequest('invalid id');
    try {
      await db.workflow.delete({ where: { id } });
    } catch (e) {
      if (isPrismaRecordNotFound(e)) {
        return json({ error: 'not found' }, 404);
      }
      throw e;
    }
    const r = json({ ok: true });
    r.headers.set('Cache-Control', 'no-store, private');
    return r;
  }, sanitizeRequestId(req.headers?.get('x-request-id') ?? null));
}
