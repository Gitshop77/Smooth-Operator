import { describe, it, expect } from 'vitest';

import { resolveInitialView } from '@/hooks/use-cowork-store';

describe('resolveInitialView (cold-open clamp)', () => {
  it('clamps an extension-only view (tabs) to overview', () => {
    expect(resolveInitialView('tabs')).toBe('overview');
  });

  it('keeps a built-in view (agents) unchanged', () => {
    expect(resolveInitialView('agents')).toBe('agents');
  });

  it('clamps an unknown/drifted value to overview', () => {
    expect(resolveInitialView('bogus' as never)).toBe('overview');
  });

  it('clamps undefined to overview', () => {
    expect(resolveInitialView(undefined)).toBe('overview');
  });
});
