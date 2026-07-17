// Wired to Prisma persistence layer.
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { json, badRequest, withRouteError, parseLimit, isPrismaRecordNotFound, CURSOR_ID_RE, sanitizeRequestId } from '@/lib/cowork/api/http';
import { db } from '@/lib/db';

// ─── Form-memory PII: write-boundary DROP (at-rest) + read-time redaction ───
//
// IMPORTANT CONTRACT — AT REST: `scrubFormMemoryInput` MUST be invoked on any
// incoming `formDataJson` BEFORE it is persisted. It removes, by field name,
// every key that matches a high-sensitivity fragment (password, passwd, pwd,
// card, cvv, otp, token, secret, ssn, email, … — see SENSITIVE_FIELD_RE),
// INCLUDING the `{ name, value }` autofill-entry shape, so high-sensitivity PII
// is NEVER stored as plaintext at rest. Non-sensitive fields persist verbatim.
// Any future POST/PATCH write handler in this route (or any other code that
// creates a `FormMemory`) must call `scrubFormMemoryInput` first; this is the
// primary safeguard for data at rest, not the response masking below.
//
// IMPORTANT CONTRACT — RESPONSE: `redactFormMemory` masks sensitive *values*
// ONLY in the JSON returned to the client. It is defense-in-depth for records
// that may already exist (prior/elsewhere writes); it is NOT a substitute for
// the write-boundary drop and does NOT protect data at rest.
//
// Field *names* are preserved by `redactFormMemory`; only values are masked.
// Matching is case-insensitive SUBSTRING against the fragment list below, so
// variants like `login`, `fullname`, `e-mail`, `cc-number`, `phone_number`
// are caught (the prior exact-anchor regex missed them all). We redact on
// suspicion: a false positive costs one masked benign value, a false negative
// leaks a secret, so we bias toward masking.
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
    'userid', 'user_id', 'login', 'userlogin',
    'passport', 'license', 'licence', 'nationalid', 'national_id', 'sin', 'taxid', 'tin',
    'pin', 'otp', 'totp',
    'account', 'routing', 'iban', 'swift', 'sortcode', 'sort_code',
    'firstname', 'lastname', 'fullname', 'middlename', 'surname', 'givenname', 'familyname', 'realname',
  ].join('|'),
  'i',
);

const REDACTED = '[redacted]';

// Heuristic: does a *scalar* value look like a secret worth masking? Used as a
// fallback for bare scalars / unparseable JSON (where no field name is available
// to match against), AND as a secondary heuristic on scalar string values inside
// objects/entries when the field name did not match a sensitive fragment. Biased
// toward masking: a value containing a secret keyword is masked regardless of
// length, while only the generic token-shape branch requires a length floor.
function looksLikeSecret(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const t = value.trim();
 // Keyword match is NOT gated by the length floor — a short but clearly
 // secret-shaped scalar (e.g. "token", "secret") must still be masked.
  if (/(password|passwd|secret|token|api[_-]?key|access[_-]?token|cvv|otp|ssn|pin)/i.test(t)) return true;
 // Common secret *shapes* that the generic charset branch below cannot catch
 // because they contain '.' (JWT) or whitespace ('Bearer ' / 'Basic '):
 //   • JSON Web Token:  eyJ…  .  payload  .  signature
 //   • Authorization header value: "Bearer <jwt>" or "Basic <base64>"
 // Mask these regardless of the field name they are stored under.
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(t)) return true;
  if (/^(Bearer|Basic)\s+/i.test(t)) return true;
 // Long base64 / hex / token-shaped value with no obvious structure. Only this
 // generic branch needs a length floor; the keyword branch above stands alone.
 // The floor is kept low (8) so short high-entropy tokens (e.g. 16-char base64)
 // are still masked even under a non-sensitive key. To avoid masking ordinary
 // dictionary words (e.g. "plainvalue"), require at least one digit or one
 // uppercase letter — a benign lowercase-only word is not a secret, whereas a
 // real token almost always mixes case or contains digits.
  return /^[A-Za-z0-9+/=_-]{8,}$/.test(t) && (/[0-9]/.test(t) || /[A-Z]/.test(t));
}

// Redact an object that carries a `name` key (the `{ name, value }` entry shape).
// If its field name matches a sensitive fragment (case-insensitive substring), the
// associated `value` is masked regardless of the value's type. In addition, EVERY
// other key of the object is inspected in its own right: a key that matches a
// sensitive fragment is masked, otherwise its value is recursed into. This ensures
// sibling sensitive keys (e.g. `{ name: "form1", password: "hunter2" }`) are never
// leaked just because the object happened to expose a `name` field.
function redactEntry(entry: unknown): unknown {
  if (!entry || typeof entry !== 'object') return entry;
  const e = entry as Record<string, unknown>;
  const nameIsSensitive = SENSITIVE_FIELD_RE.test(String(e.name ?? ''));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(e)) {
    if (key === 'name') {
      out[key] = e.name;
    } else if (SENSITIVE_FIELD_RE.test(key)) {
      out[key] = REDACTED;
    } else if (nameIsSensitive) {
      out[key] = REDACTED;
    } else {
      const v = e[key];
      out[key] = (typeof v === 'string' && looksLikeSecret(v)) ? REDACTED : redactNode(v);
    }
  }
  return out;
}

// Recursively mask sensitive values in any parsed shape:
// • arrays → recurse element-wise (covers bare arrays of `{ name, value }`);
// • objects with a `name` key → treated as an entry (`redactEntry`);
// • other objects → if a key matches a sensitive fragment the value is masked,
// otherwise the value is recursed so nested sensitive keys are still caught;
// • primitive/scalar values → returned as-is.
function redactNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((v) => (typeof v === 'string' && looksLikeSecret(v) ? REDACTED : redactNode(v)));
  }
  if (node && typeof node === 'object') {
    if ('name' in node) {
      return redactEntry(node);
    }
    const obj = node as Record<string, unknown>;
 // Mutate in place on the freshly-parsed local copy (avoids extra allocations).
 // Safe because we only ever operate on a local produced by JSON.parse above.
    for (const key of Object.keys(obj)) {
      if (SENSITIVE_FIELD_RE.test(key)) {
        obj[key] = REDACTED;
      } else {
        const v = obj[key];
        obj[key] = (typeof v === 'string' && looksLikeSecret(v)) ? REDACTED : redactNode(v);
      }
    }
    return obj;
  }
  return node;
}

// Mask sensitive autofill values in the *response copy* of `formDataJson` (a JSON
// string which the cockpit does not parse at write time). Handles a flat record
// of fieldName → value, the `{ entries: [{ name, value }] }` shape, AND a bare
// array of `{ name, value }` entries, recursing into nested objects/arrays so a
// sensitive key is never leaked regardless of depth.
//
// NOTE: field-name masking only applies to parseable object/array shapes. When
// `formDataJson` is unparseable or a bare scalar, field names are unavailable, so
// the value is returned unchanged UNLESS it `looksLikeSecret` (then it is masked).
// This is response-only masking — NOT at-rest protection; see the file header.
function redactFormMemory(formDataJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(formDataJson);
  } catch {
 // Unparseable stored value: cannot match by field name. Mask it only if it
 // looks secret-shaped; otherwise return unchanged (no 500 for malformed data).
    return looksLikeSecret(formDataJson) ? REDACTED : formDataJson;
  }
  if (parsed === null || typeof parsed !== 'object') {
 // Scalar (string/number/boolean) or null: no field name to match against.
    return looksLikeSecret(parsed) ? REDACTED : JSON.stringify(parsed);
  }
  return JSON.stringify(redactNode(parsed));
}

// ─── Write-boundary sensitive-field DROP (at-rest protection) ───
//
// Called on the *incoming* `formDataJson` BEFORE it is written to SQLite.
// Removes entirely (field name AND value) any key matching SENSITIVE_FIELD_RE,
// recursing into nested objects/arrays so a sensitive key is dropped at any
// depth. The `{ name, value }` autofill-entry shape is handled specially: when
// an entry's `name` matches a sensitive fragment the WHOLE entry is dropped,
// since the secret lives under `value` while the field name is under `name`.
// Non-sensitive fields are preserved verbatim. High-sensitivity PII is thus
// never persisted as plaintext at rest. `redactFormMemory` remains as
// defense-in-depth for any already-stored records.
//
// NOTE: exported so the (currently absent) write handler — or any other caller
// that creates a `FormMemory` — can enforce the write-boundary drop. There is
// no write handler in this route today, but the helper is ready so the write
// path cannot accidentally persist verbatim secrets.
export function scrubFormMemoryInput(formDataJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(formDataJson);
  } catch {
    // Unparseable input: cannot match by field name. If the bare value looks
    // secret-shaped, drop it entirely (persist nothing) rather than risk a
    // plaintext secret at rest; otherwise pass through unchanged.
    return looksLikeSecret(formDataJson) ? '{}' : formDataJson;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return looksLikeSecret(parsed) ? '{}' : formDataJson;
  }
  const scrubbed = stripSensitiveKeys(parsed);
  if (scrubbed === undefined) return '{}';
  return JSON.stringify(scrubbed);
}

// Recursively remove any object key matching SENSITIVE_FIELD_RE and recurse
// into remaining values. Returns `undefined` for an entry that is dropped so
// the caller can omit it.
function stripSensitiveKeys(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(stripSensitiveKeys).filter((v) => v !== undefined);
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    // `{ name, value }` entry shape: if the entry's field name is sensitive,
    // drop the entire entry (name + value) so nothing about it is persisted.
    if ('name' in obj && SENSITIVE_FIELD_RE.test(String(obj.name ?? ''))) {
      return undefined;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      if (SENSITIVE_FIELD_RE.test(key)) continue; // drop sensitive key entirely
      const v = stripSensitiveKeys(obj[key]);
      if (v === undefined) continue;
      out[key] = v;
    }
    return out;
  }
  return node;
}

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
 // Cap the result set + cursor pagination, same as the site route.
    const limit = parseLimit(req);
    const after = req.nextUrl.searchParams.get('after') || undefined;
    if (after !== undefined && !CURSOR_ID_RE.test(after)) {
      return badRequest('invalid after cursor');
    }
    const args: Parameters<typeof db.formMemory.findMany>[0] = {
      take: limit,
      orderBy: { createdAt: 'desc', id: 'desc' },
    };
    if (after) {
      args.cursor = { id: after };
      args.skip = 1;
    }
    let rows;
    try {
      rows = await db.formMemory.findMany(args);
    } catch (e) {
 // A well-formed but stale/unknown cursor id makes Prisma throw P2025
 // (RecordNotFound); return a precise 400 instead of a generic 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        return badRequest('invalid after cursor');
      }
      throw e;
    }
    const memories = rows.map((m) => ({ ...m, formDataJson: redactFormMemory(m.formDataJson ?? '') }));
 // Signal whether more pages exist (only when a full page was returned and the
 // cursor id is well-formed) so the UI can drive cursor-based "load more".
    const last = rows.length === limit ? rows[rows.length - 1] : undefined;
    const nextCursor = last && CURSOR_ID_RE.test(last.id) ? last.id : null;
    const r = json({ memories, nextCursor });
 // Form-memory holds autofill PII; never let browsers/proxies/CDNs cache it.
    r.headers.set('Cache-Control', 'no-store, private');
    return r;
  }, sanitizeRequestId(req.headers?.get('x-request-id') ?? null));
}

// DELETE /api/cowork/memory/form?id=<formMemoryId>
// Removes a single form-memory entry. Gated by the same X-Cowork-Token check
// as every other /api/cowork/* data route (enforced in middleware.ts). This is
// the representative deletion endpoint for stored PII; further DELETE
// coverage (history prune, etc.) is follow-up work.
export async function DELETE(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) {
      const r = badRequest('id is required');
      r.headers.set('Cache-Control', 'no-store, private');
      return r;
    }
    if (!CURSOR_ID_RE.test(id)) {
      const r = badRequest('invalid id');
      r.headers.set('Cache-Control', 'no-store, private');
      return r;
    }
    try {
      await db.formMemory.delete({ where: { id } });
    } catch (e) {
 // Prisma throws P2025 (RecordNotFound) when the id doesn't exist. The
 // code lives in `e.code`, but a caller may surface a plain Error whose
 // message still reports P2025 (e.g. certain driver/adapter layers);
 // detect both so a missing entry is a precise 404 rather than a 500.
      if (
        isPrismaRecordNotFound(e) ||
        (e instanceof Error && /P2025/.test(e.message))
      ) {
        const r = json({ error: 'not found' }, 404);
        r.headers.set('Cache-Control', 'no-store, private');
        return r;
      }
      throw e;
    }
    const ok = json({ ok: true });
    ok.headers.set('Cache-Control', 'no-store, private');
    return ok;
  }, sanitizeRequestId(req.headers?.get('x-request-id') ?? null));
}
