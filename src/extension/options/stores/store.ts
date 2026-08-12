/**
 * options/stores/store.ts — minimal reducer-style store primitive shared by
 * every Options surface (frontend application-state rewrite).
 *
 * Each Options store is a pure reducer over typed state with deterministic
 * transitions, subscribe/notify, and a test-only reset.  Command ack helpers
 * encode the "explicit command acknowledgement (wait-for-response)" invariant:
 * a UI action moves a command through `pending → acked | failed`, and the DOM
 * never reflects an unacknowledged result.
 */

export type StoreListener<State> = (state: State, prevState: State) => void;

export interface Store<State, Action> {
  getState(): State;
  /** Run one reducer transition; listeners are notified synchronously. */
  dispatch(action: Action): void;
  /** Subscribe; the listener fires immediately with the current state. */
  subscribe(listener: StoreListener<State>): () => void;
  /** Test-only reset to the initial state (fresh Options documents start clean). */
  reset(): void;
}

export function createStore<State, Action>(
  reducer: (state: State, action: Action) => State,
  initialState: State,
): Store<State, Action> {
  let state = initialState;
  const listeners = new Set<StoreListener<State>>();
  return {
    getState: () => state,
    dispatch: (action) => {
      const next = reducer(state, action);
      if (next === state) return;
      const prev = state;
      state = next;
      for (const listener of listeners) listener(state, prev);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state, state);
      return () => listeners.delete(listener);
    },
    reset: () => {
      state = initialState;
    },
  };
}

// ─── Explicit command acknowledgement ───────────────────────────────────────

/** Lifecycle of one acknowledged background/storage command. */
export type AckState = "idle" | "pending" | "acked" | "failed";

export interface CommandAck {
  state: AckState;
  /** Failure message — already redacted/sanitized at the surface boundary. */
  error?: string;
  startedAt?: number;
  settledAt?: number;
}

export const IDLE_ACK: CommandAck = { state: "idle" };

export function beginAck(now = Date.now()): CommandAck {
  return { state: "pending", startedAt: now };
}

export function ackOk(ack: CommandAck, now = Date.now()): CommandAck {
  return { state: "acked", startedAt: ack.startedAt, settledAt: now };
}

export function ackFail(ack: CommandAck, error: string, now = Date.now()): CommandAck {
  return { state: "failed", error, startedAt: ack.startedAt, settledAt: now };
}

/** The bounded summary of the last finished command, for status line rendering. */
export interface CommandOutcome {
  kind: string;
  ok: boolean;
  taskId?: string;
  error?: string;
}
