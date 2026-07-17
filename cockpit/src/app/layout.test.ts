import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the layout's heavy/side-effecting imports so this unit test runs in a
// plain Node environment without a Next.js build context.
vi.mock('next/font/google', () => ({
  Geist: () => ({ variable: '--font-geist-sans' }),
  Geist_Mono: () => ({ variable: '--font-geist-mono' }),
  JetBrains_Mono: () => ({
    variable: '--font-jetbrains-mono',
    weight: ['400', '500', '600'],
  }),
}));
vi.mock('next-themes', () => ({ ThemeProvider: () => null }));
vi.mock('@/components/ui/toaster', () => ({ Toaster: () => null }));
vi.mock('@/components/cowork/providers', () => ({ CoworkProviders: () => null }));
vi.mock('./globals.css', () => ({}));

// Mock `next/headers` so we can drive `getRequestLocale` without a running
// Next.js request context.
let acceptLanguage: string | null = null;
vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) => (name === 'accept-language' ? acceptLanguage : null),
  }),
}));

const { getRequestLocale, localeToDir } = await import('@/app/layout');

describe('getRequestLocale', () => {
  beforeEach(() => {
    acceptLanguage = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to "en" when the header is missing or empty', async () => {
    expect(await getRequestLocale()).toBe('en');
    acceptLanguage = '';
    expect(await getRequestLocale()).toBe('en');
  });

  it('strips quality values but keeps the primary region tag (en-US,en;q=0.9 -> en-us)', async () => {
    acceptLanguage = 'en-US,en;q=0.9';
    expect(await getRequestLocale()).toBe('en-us');
  });

  it('rejects values with invalid characters', async () => {
    acceptLanguage = '../en';
    expect(await getRequestLocale()).toBe('en');
  });

  it('rejects over-length values', async () => {
    acceptLanguage = 'a'.repeat(40);
    expect(await getRequestLocale()).toBe('en');
  });

  it('lowercases and accepts a valid BCP-47 subset', async () => {
    acceptLanguage = 'EN';
    expect(await getRequestLocale()).toBe('en');
  });
});

describe('localeToDir', () => {
  it('selects rtl for Hebrew', () => {
    expect(localeToDir('he')).toBe('rtl');
  });

  it('selects ltr for English', () => {
    expect(localeToDir('en')).toBe('ltr');
  });

  it('selects rtl for Arabic and ltr for French', () => {
    expect(localeToDir('ar')).toBe('rtl');
    expect(localeToDir('fr')).toBe('ltr');
  });
});
