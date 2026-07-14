/**
 * Schema sync tests — guard against the three parallel action definitions
 * drifting apart.
 *
 * The action set has historically been defined in three places:
 * 1. The Zod schemas in `src/lib/agent/tools/schema.ts` (`ActionSchema`
 * discriminated union + `Action` inferred type) — the stated source of
 * truth.
 * 2. The `AgentAction` type in `src/lib/agent/types.ts` — now an ALIAS of
 * `Action` (Approach A from Task 3B), so this drift surface is gone.
 * 3. The hand-written `ACTION_METADATA` object in `schema.ts` (one entry
 * per action: name, description, pageChanging, exclusive, params).
 *
 * This test file enforces:
 * - `AgentAction` and `Action` are the same type (sanity check — if anyone
 * reverts types.ts to a hand-written union, this fails immediately).
 * - Every `ActionSchema` variant has a matching `ACTION_METADATA` entry.
 * - Every `ACTION_METADATA` entry matches an `ActionSchema` variant.
 *
 * What it does NOT enforce (intentional, see notes in `types.ts`):
 * - Field-shape drift inside individual action variants (e.g. adding a new
 * optional field to one schema but not the others). Catching that at the
 * type level would require an `Equals`-style check, which fights Zod's
 * `.default()` semantics (defaulted fields are required in the output
 * type, optional in the input type — so a strict Equals check is too
 * noisy to be useful here).
 */

import { describe, test, expect } from "vitest";
import { ActionSchema, ACTION_METADATA } from "../src/lib/agent/tools/schema";
import type { Action } from "../src/lib/agent/tools/schema";
import type { AgentAction } from "../src/lib/agent/types";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract the `type` discriminator literal value from a single ZodObject
 * option in a `z.discriminatedUnion("type", [...])`.
 *
 * Zod 4 stores literal values on a `Set` named `.values` (previously Zod 3
 * exposed them via `.value`). We try both shapes plus the `_def.values` array
 * to stay robust across Zod versions.
 */
function getActionType(opt: unknown): string {
  const o = opt as {
    shape?: { type?: { values?: Set<unknown>; value?: unknown; def?: { values?: unknown[] } } };
    _def?: { shape?: () => { type?: { values?: Set<unknown>; value?: unknown; def?: { values?: unknown[] } } } };
  };
  const typeSchema = o.shape?.type ?? o._def?.shape?.()?.type;
  if (!typeSchema) {
    throw new Error("Could not find type discriminator on Zod option");
  }
  if (typeSchema.values instanceof Set) {
    const v = Array.from(typeSchema.values)[0];
    if (typeof v === "string") return v;
  }
  if (Array.isArray(typeSchema.def?.values)) {
    const v = typeSchema.def?.values[0];
    if (typeof v === "string") return v;
  }
  if (typeof typeSchema.value === "string") {
    return typeSchema.value;
  }
  throw new Error("Could not extract literal value from type discriminator");
}

/** All `type` discriminator values defined on `ActionSchema`. */
function schemaActionTypes(): string[] {
 // `ActionSchema.options` is the array of `ZodObject`s passed to
 // `z.discriminatedUnion("type", [...])`. Resolve it defensively so the
 // sync-guard survives Zod 3/4 internal relocations instead of throwing an
 // opaque "Cannot read properties of undefined" that fails every test.
  const schema = ActionSchema as unknown as {
    options?: unknown[];
    _def?: { options?: unknown[]; def?: { options?: unknown[] } };
  };
  const opts =
    schema.options ?? schema._def?.options ?? schema._def?.def?.options;
  if (!opts) throw new Error("Could not locate discriminatedUnion options");
  return opts.map((o) => getActionType(o));
}

// Computed once at module scope — every test below references the same value,
// avoiding repeated (fragile) Zod-internal traversal on each run.
const SCHEMA_ACTION_TYPES = schemaActionTypes();

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AgentAction <-> Action schema sync", () => {
  test("AgentAction is the same type as Action (Approach A sanity check)", () => {
 // After Task 3B, `AgentAction` in types.ts is `export type AgentAction = Action`.
 // If anyone reverts it to a hand-written union, this assignment stops
 // compiling (the hand-written union has `.default()`-affected fields as
 // OPTIONAL, while `Action` has them as REQUIRED — so the two types are no
 // longer bidirectionally assignable and the const b declaration fails).
    const a: AgentAction = { type: "click", index: 1 } as AgentAction;
 // This compiles ONLY if AgentAction === Action (or AgentAction is
 // assignable to Action, which only holds when they're identical after
 // Approach A).
    const b: Action = a;
    expect(b).toBeDefined();
    expect(b.type).toBe("click");
  });

  test("Action is assignable to AgentAction (catches new-action drift in schema)", () => {
 // If a new action variant is added to `ActionSchema` but the hand-written
 // `AgentAction` union is ever resurrected without that variant, this
 // assignment fails to compile. (Trivially true today since AgentAction IS
 // Action, but the check guards against future regressions.)
    const a: Action = { type: "click", index: 1 } as Action;
    const b: AgentAction = a;
    expect(b).toBeDefined();
  });
});

describe("ACTION_METADATA <-> ActionSchema sync", () => {
  test("every ActionSchema variant has a matching ACTION_METADATA entry", () => {
    const types = SCHEMA_ACTION_TYPES;
    const metaKeys = Object.keys(ACTION_METADATA);
 // Derived guard: the count must track ACTION_METADATA automatically rather
 // than a hand-maintained magic number (which drifts as actions are added).
    expect(types.length).toBe(metaKeys.length);
    for (const t of types) {
      expect(metaKeys).toContain(t);
    }
  });

  test("every ACTION_METADATA entry matches an ActionSchema variant", () => {
    const types = SCHEMA_ACTION_TYPES;
    const metaKeys = Object.keys(ACTION_METADATA);
    for (const k of metaKeys) {
      expect(types).toContain(k);
    }
  });

  test("ACTION_METADATA keys and ActionSchema variants are exactly equal (no extras either way)", () => {
    const types = SCHEMA_ACTION_TYPES.slice().sort();
    const metaKeys = Object.keys(ACTION_METADATA).sort();
    expect(metaKeys).toEqual(types);
  });

  test("ACTION_METADATA name field matches the type discriminator for every entry", () => {
 // Catches the case where someone copies an entry and forgets to update
 // the `name` field (or vice versa).
    for (const [key, meta] of Object.entries(ACTION_METADATA)) {
      expect(meta.name).toBe(key);
    }
  });

  test("ACTION_METADATA has no duplicate entries (object keys are unique by construction)", () => {
 // Defensive — a plain object literal can't have duplicate keys at runtime,
 // but this test documents the invariant and guards against future
 // refactors to a Map or array-of-pairs representation.
    const keys = Object.keys(ACTION_METADATA);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
