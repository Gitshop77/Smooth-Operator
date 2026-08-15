# Wave Workflow — full-codebase review/refine/audit

Phase 1 (this): multi-wave parallel agents. Phase 2 (after all waves): plan + execute.

## Wave structure (Phase 1)

Each wave dispatches agents IN PARALLEL (one message). Non-overlapping file ownership.
Agents never commit; the controller runs the full gate (tsc + vitest + lint + build +
verify:baseline) and commits after each wave.

### Wave 1 — 4 agents
| Agent | Type | Scope (owned files) | Output |
|---|---|---|---|
| FE-1 sidepanel | implement | `src/extension/sidepanel.ts`, `src/extension/sidepanel/` (15 ts), `src/extension/sidepanel.html`, `src/extension/sidepanel.css`, `src/extension/tokens.css`, `src/extension/components.css` | fixes implemented + report |
| FE-2 options | implement | `src/extension/options.ts`, `src/extension/options/` (incl. `stores/`), `src/extension/options.html`, `src/extension/options.css`, `src/extension/options-platform-contract.ts`, `src/extension/storage-access.ts`, `src/extension/lightpanda-settings.ts` | fixes implemented + report |
| AUD-1 loop+prompts | review only | `src/lib/agent/loop/**` (incl. `phases/`, `helpers/`), `src/lib/agent/prompts/**` | findings → `docs/findings/wave1-loop-prompts.md` |
| AUD-2 security+tools+llm | review only | `src/lib/agent/security*.ts`, `src/lib/agent/tools/**` (incl. `helpers/`), `src/lib/agent/llm/providers/**`, `src/lib/agent/llm/protocols/**` | findings → `docs/findings/wave1-security-tools-llm.md` |

### Waves 2+ — 2 audit agents per wave (front end covered in wave 1)
Remaining codebase, split balanced + non-overlapping:
- Wave 2: `src/extension/background/**` (43) | `src/extension/*.ts` root (21)
- Wave 3: `src/lib/agent/llm/**` root (13) + `src/lib/agent/dom/**` (28) | `src/lib/agent/` root (46) + `src/lib/` (1)
- Stop when every src file has been reviewed once.

## Findings format (compact, minimal)

`docs/findings/<wave>-<agent>.md`:
```md
# Wave <N> — <agent> — <scope>
- [C] file.ts:NN — one-line finding
- [I] ...
- [M] ...
```
Severity: C = Critical (correctness/security/data), I = Important (robustness/perf),
M = Minor (style/cleanup). No code changes by audit agents.

## Phase 2 (after all waves)

1. writing-plans skill: compile ALL findings into one implementation plan
   (`docs/superpowers/plans/YYYY-MM-DD-audit-findings.md`), task-granular, TDD.
2. Execute via subagent-driven-development (+ systematic-debugging for any
   failure during execution).
3. Full gate + commit. Push only when explicitly requested.

## Standing rules

- Gate = tsc --noEmit, vitest run, lint, build:extension, verify:baseline.
- Full suite is 289 files / ~4000 tests — agents run tsc + AREA tests only; the
  controller runs the full gate after each wave.
- No agent edits outside its owned scope. Shared contracts (message types,
  storage keys, schema) are read-only unless the change is flagged to the
  controller.
- Console debug output: use `void console.debug/log` conventions; never `debugger`.