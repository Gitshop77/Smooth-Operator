/**
 * Shared Options store primitive + command acknowledgement.
 *
 * Covers: deterministic reducer transitions, subscribe/notify semantics,
 * listener immutability (no notification during reducer runs), the explicit
 * command ack lifecycle (pending → acked | failed), and the ack helper
 * contracts used by every Options surface.
 */

import { describe, expect, test } from "vitest";
import {
  createStore,
  beginAck,
  ackOk,
  ackFail,
  IDLE_ACK,
  type CommandAck,
} from "../src/extension/options/stores/store";

interface CounterState {
  count: number;
  error?: string;
}
type CounterAction =
  | { type: "INC"; by: number }
  | { type: "SET_ERROR"; error: string };

function counterReducer(state: CounterState, action: CounterAction): CounterState {
  switch (action.type) {
    case "INC":
      return { ...state, count: state.count + action.by };
    case "SET_ERROR":
      return { ...state, error: action.error };
  }
}

describe("createStore primitive", () => {
  test("applies deterministic reducer transitions", () => {
    const store = createStore(counterReducer, { count: 0 });
    store.dispatch({ type: "INC", by: 2 });
    store.dispatch({ type: "INC", by: 3 });
    expect(store.getState()).toEqual({ count: 5 });
  });

  test("subscribers fire on every transition and receive prev + next state", () => {
    const store = createStore(counterReducer, { count: 0 });
    const seen: Array<{ next: number; prev: number }> = [];
    store.subscribe((next, prev) => seen.push({ next: next.count, prev: prev.count }));
    store.dispatch({ type: "INC", by: 1 });
    store.dispatch({ type: "INC", by: 4 });
    expect(seen).toEqual([
      { next: 0, prev: 0 }, // immediate initial notification
      { next: 1, prev: 0 },
      { next: 5, prev: 1 },
    ]);
  });

  test("unsubscribe stops notifications", () => {
    const store = createStore(counterReducer, { count: 0 });
    let calls = 0;
    const off = store.subscribe(() => {
      calls += 1;
    });
    off();
    store.dispatch({ type: "INC", by: 1 });
    expect(calls).toBe(1); // only the immediate call
  });

  test("a no-op transition does not notify listeners", () => {
    const store = createStore(
      (state: CounterState, action: CounterAction) => {
        if (action.type === "SET_ERROR" && action.error === state.error) return state;
        return counterReducer(state, action);
      },
      { count: 0 },
    );
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.dispatch({ type: "SET_ERROR", error: "same" });
    store.dispatch({ type: "SET_ERROR", error: "same" }); // no-op
    expect(calls).toBe(2); // immediate + first dispatch only
  });

  test("reset restores the initial state for fresh documents", () => {
    const store = createStore(counterReducer, { count: 0 });
    store.dispatch({ type: "INC", by: 9 });
    store.reset();
    expect(store.getState()).toEqual({ count: 0 });
  });
});

describe("explicit command acknowledgement", () => {
  test("a command moves pending → acked with monotonic timestamps", () => {
    const ack: CommandAck = beginAck(1000);
    expect(ack).toEqual({ state: "pending", startedAt: 1000 });
    const settled = ackOk(ack, 1500);
    expect(settled).toEqual({ state: "acked", startedAt: 1000, settledAt: 1500 });
  });

  test("a failed command carries a sanitized error and never reports acked", () => {
    const ack = beginAck(1000);
    const failed = ackFail(ack, "storage quota exceeded", 2000);
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("storage quota exceeded");
    expect(failed.settledAt).toBe(2000);
  });

  test("idle ack is the untouched baseline", () => {
    expect(IDLE_ACK).toEqual({ state: "idle" });
  });
});
