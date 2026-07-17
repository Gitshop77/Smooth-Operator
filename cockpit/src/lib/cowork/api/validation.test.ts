import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  truncateTo,
  nonEmptyString,
  scheduleCronSchema,
  validateField,
} from '@/lib/cowork/api/validation';
import { ClientError } from '@/lib/cowork/api/http';

describe('scheduleCronSchema (command-injection guard)', () => {
  it('accepts a valid 5-field cron expression', () => {
    expect(scheduleCronSchema.safeParse('*/5 * * * *').success).toBe(true);
    expect(scheduleCronSchema.safeParse('0 0 * * *').success).toBe(true);
    expect(scheduleCronSchema.safeParse('5 4 * * ?').success).toBe(true);
  });

  it('rejects a cron containing shell metacharacters', () => {
    expect(scheduleCronSchema.safeParse('; rm -rf /').success).toBe(false);
  });

  it('rejects the wrong field count', () => {
    expect(scheduleCronSchema.safeParse('* * *').success).toBe(false);
  });

  it('rejects degenerate components the grammar is designed to veto', () => {
    expect(scheduleCronSchema.safeParse('5?').success).toBe(false);
    expect(scheduleCronSchema.safeParse('*-5').success).toBe(false);
    expect(scheduleCronSchema.safeParse('-').success).toBe(false);
    expect(scheduleCronSchema.safeParse('/').success).toBe(false);
  });
});

describe('truncateTo (non-string rejection boundary)', () => {
  it('truncates a string to max chars', () => {
    expect(truncateTo('hello', 3)).toBe('hel');
  });

  it('returns "" for null/undefined', () => {
    expect(truncateTo(null, 10)).toBe('');
    expect(truncateTo(undefined, 10)).toBe('');
  });

  it('throws a ClientError (400) on a non-string value rather than coercing it', () => {
    for (const bad of [{}, 123, []]) {
      let thrown: unknown;
      try {
        truncateTo(bad, 10);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ClientError);
      expect((thrown as ClientError).status).toBe(400);
    }
  });
});

describe('nonEmptyString', () => {
  it('rejects an empty string', () => {
    expect(nonEmptyString(10).safeParse('').success).toBe(false);
  });

  it('accepts a non-empty bounded string', () => {
    expect(nonEmptyString(10).safeParse('x').success).toBe(true);
  });
});

describe('validateField (zod folding helper)', () => {
  it('folds a zod failure into { ok:false, error }', () => {
    const result = validateField(z.string(), 123, 'name');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('name is invalid');
    }
  });

  it('folds a zod success into { ok:true, value }', () => {
    const result = validateField(z.string(), 'x', 'name');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('x');
    }
  });
});
