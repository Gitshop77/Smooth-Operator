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

 // Simulate the contract: a pure upsert-on-url helper must never call a raw
 // create when the url already exists. This models the behavior the extension
 // write path is required to follow.
  it('upsert-on-url helper updates instead of throwing on revisit', () => {
    type Row = { url: string; visitCount: number; title: string };
    const store = new Map<string, Row>();

    const upsertHistory = (url: string, title: string) => {
      const existing = store.get(url);
      if (existing) {
        existing.visitCount += 1;
        existing.title = title;
        return existing;
      }
      const row: Row = { url, visitCount: 1, title };
      store.set(url, row);
      return row;
    };

    upsertHistory('https://example.com', 'Example');
    const second = upsertHistory('https://example.com', 'Example v2');

 // A revisited URL does not create a duplicate row (which would be the P2002
 // failure mode for a raw create) — it updates the existing row instead.
    expect(store.size).toBe(1);
    expect(second.visitCount).toBe(2);
    expect(second.title).toBe('Example v2');
  });
});
