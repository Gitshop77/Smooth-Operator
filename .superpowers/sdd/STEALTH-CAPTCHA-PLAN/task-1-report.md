# Task 1 Report: Config schema + env parsing (`src/server/config.ts`)

## Status
DONE

## What I implemented

All four sub-requirements from the brief were implemented verbatim in `src/server/config.ts`:

1. **`RawConfigSchema` (1a)** — Added two optional `.strict()` top-level keys, `stealth` and `captchaSolver`, mirroring the existing `browser`/`security` pattern (exact field sets, enums, and `.trim().min().max()` bounds from the brief).

2. **`ServerConfig` interface (1b)** — Added two OPTIONAL fields (`stealth?`, `captchaSolver?`) with the exact shapes from the brief.

3. **`loadServerConfig` (1c)** — Added `nestedStealth` / `nestedCaptchaSolver` file fallbacks, built both sections following the brief's exact expressions (`parseBoolean`, `parseInteger`, `trimOptional`, file-or-env fallbacks, `behaviorEnabled` inherits `enabled`). Added the two local predicates (`isStealthConfigured`, `isCaptchaSolverConfigured`) and the conditional spreads into the `config` object, plus the conditional inclusion in the `RawConfigSchema.safeParse(...)` call.

4. **`validateConfig` (1d)** — Added profile/provider/range validation for the new sections, guarded by `if (config.captchaSolver)` and `if (config.stealth && ...)`.

The removed-switch guards (now shifted from lines 471-479 to 519-527 by the added lines) were left byte-for-byte identical (verified with `diff` against HEAD). The master switch stays `SMOOTH_OPERATOR_STEALTH_ENABLED` — no collision with the removed `SMOOTH_OPERATOR_BROWSER_STEALTH`.

## Tests + results (TDD evidence)

Added 7 tests to `tests/config-policy.test.ts`:
- opt-in stealth + solver accepted and validated (incl. `trim` on apiKey);
- sections default absent (and `enabled:false` keeps them absent);
- section stays present when only `profile` is set;
- `behaviorEnabled` inherits `enabled` and can be overridden;
- `.strict()` rejects unknown keys in both sections (via `--config`, full strict schema);
- invalid profile / provider / out-of-range timeout & maxBytes throw `CONFIG_INVALID`;
- sections validated from a JSON config file.

Results:
- `npx vitest run tests/config-policy.test.ts` → **50 passed / 0 failed**.
- `npm run typecheck` → clean (exit 0).
- `npm run lint` → clean.
- Full suite `npx vitest run` → **305 passed / 0 failed** across 18 files.
- `npm run dead-code` → only the pre-existing `ghost-cursor` unused dep (unrelated to this task; present in HEAD).
- `tests/helpers.ts` `testConfig` left **unchanged** (binding constraint satisfied).

## Files changed
- `src/server/config.ts` (+84 lines): schema, interface, loader, validator.
- `tests/config-policy.test.ts` (+88 lines): 7 new tests.

## Self-review findings
- **Bug caught during TDD:** my first `validateConfig` stealth guard used `config.stealth?.profile !== "balanced"`. With `stealth` absent, `undefined !== "balanced"` is `true`, so it threw `CONFIG_INVALID` on every default config load — breaking 8 pre-existing tests. Fixed by requiring `config.stealth &&` before the profile comparison. All 43 original tests pass again.
- **Schema-vs-validator ordering:** the `RawConfigSchema` bounds (min/max/enum) are enforced by the conditional schema parse *before* `validateConfig`, so out-of-range timeout/maxBytes and bad enums throw `"Configuration failed validation."` from the schema. The `validateConfig` range checks are therefore defense-in-depth backstops.
- **Hygiene:** no `chrome extension`, `content script`, `model provider`, or `service worker` phrases in comments (verified with grep).

## Concerns
1. **Redundant validation (reachable dead code):** Because the schema parse always includes the section whenever `config.stealth` / `config.captchaSolver` is present, the range/provider checks inside `validateConfig` are effectively unreachable through `loadServerConfig` (the schema catches the same values first). The brief explicitly required both, so I kept them for defense-in-depth, but note they are not independently exercisable via the public API.
2. **`stealth.enabled` is env-only:** Per the brief, `enabled` uses `parseBoolean(environment.SMOOTH_OPERATOR_STEALTH_ENABLED, false)` with **no** file fallback (unlike `gpu`, which falls back to `nestedStealth.gpu`). So a JSON file with `stealth.enabled: true` but no `SMOOTH_OPERATOR_STEALTH_ENABLED` env var resolves to `enabled: false` at runtime. This is intentional per the brief wording, but it is a subtle behavior worth confirming with the team — a user configuring stealth purely via file would not see it enabled.
3. **`isStealthConfigured` field coverage:** I checked profile/gpu/behaviorPresence explicitly (matching the brief's "any of profile/gpu/behaviorEnabled env-or-file set"). Note `enabled` is intentionally excluded from this predicate (the spread additionally keys off `stealth.enabled`), so a file setting only `enabled` (no other field) plus env disabled would not surface the section — consistent with the brief.

Report file path: `/Users/wasd/Projects/Smooth-Operator/smooth-operator-stealth/.superpowers/sdd/STEALTH-CAPTCHA-PLAN/task-1-report.md`
