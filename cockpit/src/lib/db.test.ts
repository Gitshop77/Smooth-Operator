// Data-model contract tests for the Prisma schema.
//
// These tests are intentionally DB-free (no `prisma db push`, no live SQLite).
// They guard the *contract* only:
// - F21: the string-typed "enums" have a documented, exact allowed-value set.
// - F22: HistoryEntry.url is @unique, so writes MUST upsert on url (never a
// raw create) or they throw P2002.
//
// We assert against literal arrays that mirror the inline enum comments in
// prisma/schema.prisma, and re-validate those sets through an inline zod enum
// so the contract is both documented and machine-checked. We also parse the
// schema file text to ensure the documented enums are present in the source of
// truth and that HistoryEntry.url is declared unique.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { upsertHistoryEntry } from '@/lib/cowork/api/http';

const SCHEMA_PATH = resolve(__dirname, '..', '..', 'prisma', 'schema.prisma');
let schemaText: string;
try {
  schemaText = readFileSync(SCHEMA_PATH, 'utf8');
} catch (e) {
  throw new Error(
    'db.test.ts could not read ' + SCHEMA_PATH +
      ' — ensure prisma/schema.prisma exists (run `prisma generate`). Original: ' +
      (e as Error).message,
  );
}

// ─── F21: Allowed-value sets for every string-typed "enum" ───────────────────
// These MUST stay in sync with the inline comments in prisma/schema.prisma.
const ENUM_ALLOWED_VALUES = {
  tabStatus: ['loading', 'loaded', 'crashed', 'idle'],
  securityEventType: [
    'prompt-injection',
    'script-injection',
    'network-block',
    'secret-leak',
    'behavior-critical',
    'anomaly',
    'zero-day',
    'exfiltration-attempt',
    'blocked',
    'warned',
  ],
  securityEventSeverity: ['info', 'low', 'medium', 'high', 'critical'],
  securityEventCategory: [
    'network',
    'script',
    'form',
    'outbound',
    'behavior',
    'content',
  ],
  securityEventAction: [
    'auto_block',
    'agent_block',
    'user_allowed',
    'logged',
    'flagged',
  ],
  taskStatus: [
    'pending',
    'running',
    'paused',
    'waiting-approval',
    'ready-to-resume',
    'done',
    'failed',
    'cancelled',
  ],
  extensionSource: ['chrome-import', 'gallery', 'local'],
 // trustLevel is a free String with no closed set enforced on SQLite; the
 // known values observed in the codebase are listed here for documentation.
  extensionTrustLevel: ['unknown', 'low', 'medium', 'high'],
  pinboardLayout: ['default', 'spacious', 'dense'],
  pinboardBackground: ['dark', 'light'],
} as const;

type EnumKey = keyof typeof ENUM_ALLOWED_VALUES;

describe('F21 — string-typed enum allowed-value sets', () => {
  (Object.keys(ENUM_ALLOWED_VALUES) as EnumKey[]).forEach((key) => {
    const values = ENUM_ALLOWED_VALUES[key];

    it(`${key} is a non-empty, distinct set of literal strings`, () => {
      expect(Array.isArray(values)).toBe(true);
      expect(values.length).toBeGreaterThan(0);
 // Every value must be a non-empty string.
      for (const v of values) {
        expect(typeof v).toBe('string');
        expect(v.length).toBeGreaterThan(0);
      }
 // No duplicates in the allowed set.
      expect(new Set(values).size).toBe(values.length);
    });

    it(`${key} validates via an inline zod enum (closed set)`, () => {
      const schema = z.enum([...values] as [string, ...string[]]);
 // A documented allowed value passes.
      expect(() => schema.parse(values[0])).not.toThrow();
 // An out-of-contract value is rejected (this is what the API boundary
 // should enforce, since SQLite does not enforce it).
      expect(() => schema.parse('__not_a_real_value__')).toThrow();
    });

    it(`${key} allowed values are present in prisma/schema.prisma`, () => {
 // The source of truth documents the contract; guard against drift.
 // Match the *quoted* token (e.g. `'low'`) rather than a bare substring:
 // a plain `toContain('low')` false-passes on unrelated words like
 // "below"/"allowed" that merely contain the value as a substring. The
 // schema documents every enum value as a single-quoted literal.
      for (const v of values) {
        expect(schemaText).toContain(`'${v}'`);
      }
    });
  });
});

// ─── F21 (reverse) — schema→test drift guard ─────────────────────────────────
// The forward suite above catches test→schema drift (a value in
// ENUM_ALLOWED_VALUES missing from schema.prisma). This catches the reverse:
// a value added to a schema enum that ENUM_ALLOWED_VALUES never learned about,
// which would silently diverge the API's zod closed set from the DB. We parse
// the documented single-quoted literals straight from each enum's inline comment
// block and assert exact set equality. `extensionTrustLevel` is intentionally
// excluded — it is a documented *free* String with no closed set, so equality
// does not apply to it.
const SCHEMA_ENUM_ANCHORS: Partial<Record<EnumKey, string>> = {
  tabStatus: 'loading',
  securityEventType: 'prompt-injection',
  securityEventSeverity: 'critical',
  securityEventCategory: 'outbound',
  securityEventAction: 'auto_block',
  taskStatus: 'waiting-approval',
  extensionSource: 'chrome-import',
  pinboardLayout: 'spacious',
  pinboardBackground: 'light',
};

// Collect the single-quoted literals documented in the pipe-delimited enum
// comment block that contains `'<anchor>'`. The block is the comment line that
// holds the anchor plus any immediately-following `// |` continuation lines.
function documentedEnumValues(text: string, anchor: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.includes(`'${anchor}'`));
  if (start === -1) return [];
  const block: string[] = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\/\/\s*\|/.test(lines[i])) block.push(lines[i]);
    else break;
  }
  const tokens: string[] = [];
  const re = /'([^']+)'/g;
  for (const line of block) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) tokens.push(m[1]);
  }
  return tokens;
}

describe('F21 (reverse) — documented schema enum set exactly equals ENUM_ALLOWED_VALUES', () => {
  (Object.keys(SCHEMA_ENUM_ANCHORS) as EnumKey[]).forEach((key) => {
    it(`${key} — no schema→test drift (set equality)`, () => {
      const documented = documentedEnumValues(schemaText, SCHEMA_ENUM_ANCHORS[key]!);
      const expected = ENUM_ALLOWED_VALUES[key];
      expect(documented.length).toBeGreaterThan(0);
      expect(new Set(documented)).toEqual(new Set(expected));
      expect(documented.length).toBe(expected.length);
    });
  });
});

// Brace-balanced model extractor — tracks `{`/`}` depth so a `//` comment or any
// stray `}`-starting line inside the model region cannot truncate the captured
// block (which would give the F22 @unique assertion a false PASS/FAIL).
function extractModelBlock(text: string, name: string): string {
  const start = text.indexOf(`model ${name} {`);
  if (start === -1) return '';
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

// ─── F22: HistoryEntry.url uniqueness → writes MUST upsert ───────────────────
describe('F22 — HistoryEntry.url @unique write contract', () => {
  it('declares url as @unique in the schema', () => {
    const model = extractModelBlock(schemaText, 'HistoryEntry');
    expect(model).toMatch(/url\s+String\s+@unique/);
  });

  it('documents the upsert-only write contract (no raw create on url)', () => {
 // The contract lives in the `// ─── History` section comment above the
 // HistoryEntry model, so assert against the whole file content.
    expect(schemaText).toContain('WRITE CONTRACT');
    expect(schemaText).toContain('upsert');
    expect(schemaText).toContain('P2002');
  });

 // Exercise the real shared write path (the helper the history route and the
 // extension sync actually call). A revisit MUST route through `upsert`, never
 // a raw `create` — that's the P2002 failure mode the @unique url would
 // otherwise trigger.
  it('upsert-on-url write path calls upsert (never create) on revisit', async () => {
    const calls: string[] = [];
    const fakePrisma = {
      historyEntry: {
        upsert: async () => {
          calls.push('upsert');
          return { id: '1', url: 'https://example.com', title: 'Example v2', visitCount: 2 };
        },
        create: async () => {
          calls.push('create');
          return {};
        },
      },
    };

    await upsertHistoryEntry(fakePrisma, 'https://example.com', 'Example');
    await upsertHistoryEntry(fakePrisma, 'https://example.com', 'Example v2');

   // A revisit does not call a raw create (the P2002 failure mode) — it upserts.
    expect(calls).toEqual(['upsert', 'upsert']);
    expect(calls).not.toContain('create');
  });
});
