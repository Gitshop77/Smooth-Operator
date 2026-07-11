// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { json, badRequest, withRouteError, parseLimit } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

// Well-known sensitive autofill field names whose *values* we redact by
// default in the response. The form schema does not mark fields, so we
// redact by field-name heuristic. Field *names* are preserved; only values
// are masked.
const SENSITIVE_FIELD_RE =
  /^(password|passwd|pwd|secret|token|ssn|socialsecurity|card(?:number|no|num)?|ccv|cvv|cvc|creditcard|email|phone|mobile|address|zip|postal|dob|birth|name|firstname|lastname)$/i;

function redactValue(value: unknown): unknown {
  return typeof value === 'string' && value.length > 0 ? '[redacted]' : value;
}

// Redact sensitive autofill values in the stored `formDataJson` (a JSON string
// which the cockpit does not parse at write time). Handles both a flat
// record of fieldName -> value and the `{ entries: [{ name, value }] }` shape.
function redactFormMemory(formDataJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(formDataJson);
  } catch {
    return formDataJson;
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.entries)) {
      obj.entries = (obj.entries as Array<Record<string, unknown>>).map((entry) =>
        SENSITIVE_FIELD_RE.test(String(entry?.name ?? ''))
          ? { ...entry, value: redactValue(entry?.value) }
          : entry,
      );
    } else {
      for (const key of Object.keys(obj)) {
        if (SENSITIVE_FIELD_RE.test(key)) obj[key] = redactValue(obj[key]);
      }
    }
    return JSON.stringify(obj);
  }
  if (Array.isArray(parsed)) {
    return JSON.stringify(
      parsed.map((entry) =>
        entry && typeof entry === 'object' && 'name' in entry && SENSITIVE_FIELD_RE.test(String((entry as Record<string, unknown>).name))
          ? { ...(entry as Record<string, unknown>), value: redactValue((entry as Record<string, unknown>).value) }
          : entry,
      ),
    );
  }
  return formDataJson;
}

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    // Cap the result set + cursor pagination, same as the site route.
    const limit = parseLimit(req);
    const after = req.nextUrl.searchParams.get('after') || undefined;
    const args: Parameters<typeof db.formMemory.findMany>[0] = {
      take: limit,
      orderBy: { createdAt: 'desc' },
    };
    if (after) {
      args.cursor = { id: after };
      args.skip = 1;
    }
    const rows = await db.formMemory.findMany(args);
    const memories = rows.map((m) => ({ ...m, formDataJson: redactFormMemory(m.formDataJson) }));
    return json({ memories });
  });
}

// DELETE /api/cowork/memory/form?id=<formMemoryId>
// Removes a single form-memory entry. Gated by the same X-Cowork-Token check
// as every other /api/cowork/* data route (enforced in middleware.ts). This is
// the representative deletion endpoint for stored PII; further DELETE
// coverage (history prune, etc.) is follow-up work.
export async function DELETE(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return badRequest('id is required');
    try {
      await db.formMemory.delete({ where: { id } });
    } catch (e) {
      // Prisma throws P2025 (RecordNotFound) when the id doesn't exist.
      const msg = e instanceof Error ? e.message : '';
      const lower = msg.toLowerCase();
      if (lower.includes('not found') || lower.includes('p2025')) {
        return json({ error: 'not found' }, 404);
      }
      throw e;
    }
    return json({ ok: true });
  });
}
