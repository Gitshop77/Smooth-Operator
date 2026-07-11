// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { json, badRequest, withRouteError, parseLimit } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

// ─── Response-only PII redaction (defense-in-depth, NOT at-rest protection) ───
//
// IMPORTANT CONTRACT: this route NEVER redacts the stored `formDataJson`. The
// raw autofill values (including passwords/emails) are persisted verbatim by
// the write path; `redactFormMemory` masks sensitive *values* ONLY in the JSON
// returned to the client. Any other reader — the extension, a DB dump, the
// `/sync` path, other routes — still sees plaintext. Treat this masking purely
// as defense-in-depth against accidental exposure in API responses; it is NOT
// a safeguard for data at rest, and high-sensitivity values (passwords,
// card numbers, OTPs) ideally should not be persisted at all.
//
// Field *names* are preserved; only values are masked. Matching is
// case-insensitive SUBSTRING against the fragment list below, so variants like
// `username`, `fullname`, `e-mail`, `cc-number`, `phone_number` are caught
// (the prior exact-anchor regex missed them all). We redact on suspicion: a
// false positive costs one masked benign value, a false negative leaks a
// secret, so we bias toward masking.
const SENSITIVE_FIELD_RE = new RegExp(
  [
    'password', 'passwd', 'pwd',
    'secret', 'token', 'apikey', 'api_key', 'accesstoken', 'csrftoken',
    'ssn', 'social', 'socialsecurity',
    'card', 'creditcard', 'credit', 'cardnumber', 'cardno',
    'ccnum', 'cc-number', 'cc-num', 'ccv', 'cvv', 'cvc', 'cvc2', 'cvv2',
    'email', 'e-mail',
    'phone', 'mobile', 'cellphone', 'cell', 'tel', 'fax',
    'address', 'street', 'zip', 'zipcode', 'postcode', 'postal',
    'dob', 'birth', 'birthday', 'birthdate',
    'username', 'userid', 'user_id', 'login', 'userlogin',
    'passport', 'license', 'licence', 'nationalid', 'national_id', 'sin', 'taxid', 'tin',
    'pin', 'otp', 'totp',
    'account', 'routing', 'iban', 'swift', 'sortcode', 'sort_code',
    'firstname', 'lastname', 'fullname', 'middlename', 'surname', 'givenname', 'familyname', 'realname',
  ].join('|'),
  'i',
);

function redactValue(value: unknown): unknown {
  return typeof value === 'string' && value.length > 0 ? '[redacted]' : value;
}

// Mask sensitive autofill values in the *response copy* of `formDataJson`
// (a JSON string which the cockpit does not parse at write time). Handles a
// flat record of fieldName -> value, the `{ entries: [{ name, value }] }`
// shape, and a bare array of `{ name, value }` entries. Returns the input
// unchanged if it cannot be parsed (the caller should not observe a 500 for a
// malformed stored value).
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
      // Prisma throws P2025 (RecordNotFound) when the id doesn't exist. The
      // code lives in `e.code`, not the message, so test that directly.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        return json({ error: 'not found' }, 404);
      }
      throw e;
    }
    return json({ ok: true });
  });
}
