import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';

// Mark the environment as an act() environment so React flushes the createRoot
// renders synchronously (removes the "not configured to support act" warning).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom does not implement matchMedia; provide a controllable stub. The hook
// caches a single MediaQueryList per module instance, so each scenario reloads
// the module (vi.resetModules) with a fresh matchMedia before the first render.
function installMatchMedia(matches: boolean) {
  const mql: MediaQueryList = {
    matches,
    media: '(max-width: 767px)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as Partial<MediaQueryList> as MediaQueryList;
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = vi.fn(() => mql);
  return mql;
}

async function load(matches: boolean) {
  vi.resetModules();
  const mql = installMatchMedia(matches);
  const { useIsMobile } = await import('@/hooks/use-mobile');
  return { useIsMobile, mql };
}

describe('useIsMobile', () => {
  it('SSR snapshot is false (avoids hydration mismatch)', async () => {
    const { useIsMobile } = await load(true);
    const Probe = () => <span>{String(useIsMobile())}</span>;
    expect(renderToString(<Probe />)).toContain('false');
  });

  it('client render reflects matchMedia.matches and subscribes then unsubscribes', async () => {
    const { useIsMobile, mql } = await load(true);
    const Probe = () => <span>{String(useIsMobile())}</span>;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => { root.render(<Probe />); });
    expect(container.textContent).toBe('true');
    expect(mql.addEventListener).toHaveBeenCalled();
    act(() => { root.unmount(); });
    expect(mql.removeEventListener).toHaveBeenCalled();
    container.remove();
  });

  it('client render is false when the media query does not match', async () => {
    const { useIsMobile } = await load(false);
    const Probe = () => <span>{String(useIsMobile())}</span>;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => { root.render(<Probe />); });
    expect(container.textContent).toBe('false');
    act(() => { root.unmount(); });
    container.remove();
  });
});
