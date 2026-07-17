import { describe, it, expect } from 'vitest';

import {
  safeHref,
  timeAgo,
  formatBytes,
  truncateMiddle,
  hostnameOf,
  safeParseJsonArray,
} from '@/lib/cowork-data/format';

describe('safeHref (XSS-safe URL binding)', () => {
  it('rejects javascript: URLs', () => {
    expect(safeHref('javascript:alert(1)')).toBe('#');
  });

  it('rejects data: URLs', () => {
    expect(safeHref('data:text/html,<b>x</b>')).toBe('#');
  });

  it('rejects data: URLs carrying a script payload', () => {
    expect(safeHref('data:text/html,<script>')).toBe('#');
  });

  it('rejects empty / whitespace / null input', () => {
    expect(safeHref('')).toBe('#');
    expect(safeHref('   ')).toBe('#');
    expect(safeHref(null)).toBe('#');
    expect(safeHref(undefined)).toBe('#');
  });

  it('strips embedded credentials from http(s) URLs', () => {
    expect(safeHref('http://user:pass@x')).toBe('http://x/');
  });

  it('strips embedded credentials from an https URL', () => {
    expect(safeHref('https://user:secret@example.com')).toBe('https://example.com/');
  });

  it('passes through valid http(s) URLs', () => {
    expect(safeHref('https://example.com/path')).toBe('https://example.com/path');
  });

  it('passes through a cloud-metadata URL unchanged (storage is scheme-only by design)', () => {
    expect(safeHref('http://169.254.169.254/')).toBe('http://169.254.169.254/');
  });

  it('rejects non-URLs', () => {
    expect(safeHref('not a url')).toBe('#');
  });

  it('rejects file: URLs', () => {
    expect(safeHref('file:///etc/passwd')).toBe('#');
  });

  it('passes through http://localhost', () => {
    expect(safeHref('http://localhost')).toBe('http://localhost/');
  });
});

describe('timeAgo', () => {
  it('returns — for the 0 sentinel', () => {
    expect(timeAgo(0)).toBe('—');
  });

  it('returns — for empty string', () => {
    expect(timeAgo('')).toBe('—');
  });

  it('returns — for null', () => {
    expect(timeAgo(null)).toBe('—');
  });

  it('formats a far-past timestamp deterministically', () => {
    const out = timeAgo(1000);
    expect(out).not.toBe('—');
    expect(out).toMatch(/\d+d$/);
  });
});

describe('formatBytes', () => {
  it('returns 0 B for zero / non-finite', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
  });

  it('formats bytes and kibibytes', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
  });
});

describe('truncateMiddle', () => {
  it('returns the string unchanged when short', () => {
    expect(truncateMiddle('abc', 10)).toBe('abc');
  });

  it('ellipsizes in the middle', () => {
    expect(truncateMiddle('abcdefghij', 6)).toBe('ab…hij');
  });
});

describe('hostnameOf', () => {
  it('extracts the hostname', () => {
    expect(hostnameOf('https://example.com/path')).toBe('example.com');
  });

  it('falls back to the raw string on parse failure', () => {
    expect(hostnameOf('not a url')).toBe('not a url');
  });
});

describe('safeParseJsonArray', () => {
  it('parses a valid JSON array string', () => {
    expect(safeParseJsonArray<number>('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('passes through an already-decoded array', () => {
    expect(safeParseJsonArray<number>([1, 2])).toEqual([1, 2]);
  });

  it('returns [] for malformed JSON', () => {
    expect(safeParseJsonArray('not json')).toEqual([]);
  });

  it('returns [] for missing / empty / non-string input', () => {
    expect(safeParseJsonArray('')).toEqual([]);
    expect(safeParseJsonArray(null)).toEqual([]);
  });
});
