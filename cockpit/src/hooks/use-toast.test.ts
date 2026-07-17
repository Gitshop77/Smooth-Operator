import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { reducer } from '@/hooks/use-toast';

type RState = ReturnType<typeof reducer>;

const idle = (toasts: RState['toasts'] = []): RState => ({ toasts });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Flush any pending removal timers tracked by the module-level map so tests
  // don't leak timers into one another.
  reducer(idle([]), { type: 'REMOVE_TOAST' });
  vi.useRealTimers();
});

describe('useToast reducer (TOAST_LIMIT=1 eviction + timer lifecycle)', () => {
  it('evicts the oldest toast and clears its pending removal timer', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    let state = idle();
    state = reducer(state, { type: 'ADD_TOAST', toast: { id: 'a', open: true } });
    expect(state.toasts.map((t) => t.id)).toEqual(['a']);

    // Dismiss 'a' so it acquires a pending removal timer.
    state = reducer(state, { type: 'DISMISS_TOAST', toastId: 'a' });
    expect(state.toasts[0].open).toBe(false);

    clearSpy.mockClear();
    state = reducer(state, { type: 'ADD_TOAST', toast: { id: 'b', open: true } });
    expect(state.toasts.map((t) => t.id)).toEqual(['b']);
    // The evicted toast's orphaned timer must have been cleared.
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('DISMISS_TOAST marks a single toast closed', () => {
    let state = idle([{ id: 'a', open: true }]);
    state = reducer(state, { type: 'DISMISS_TOAST', toastId: 'a' });
    expect(state.toasts[0].open).toBe(false);
  });

  it('DISMISS_TOAST without an id closes every toast', () => {
    let state = idle([
      { id: 'a', open: true },
      { id: 'b', open: true },
    ]);
    state = reducer(state, { type: 'DISMISS_TOAST' });
    expect(state.toasts.every((t) => t.open === false)).toBe(true);
  });

  it('REMOVE_TOAST(id) filters that toast out', () => {
    let state = idle([
      { id: 'a', open: false },
      { id: 'b', open: false },
    ]);
    state = reducer(state, { type: 'REMOVE_TOAST', toastId: 'a' });
    expect(state.toasts.map((t) => t.id)).toEqual(['b']);
  });

  it('REMOVE_TOAST() clears all toasts and their timers', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    let state = idle([
      { id: 'a', open: false },
      { id: 'b', open: false },
    ]);
    // Give both a pending removal timer.
    state = reducer(state, { type: 'DISMISS_TOAST' });
    clearSpy.mockClear();
    state = reducer(state, { type: 'REMOVE_TOAST' });
    expect(state.toasts).toEqual([]);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
