# Open Cowork — Full UI/UX Redesign Plan (v2, audited)

**Direction:** `Signal Indigo` — deep‑ink neutrals + electric indigo `#6C5CE7`, glassy
panels, subtle violet glow. Unified across **extension** (side panel + options) **and**
**cockpit** (the full website) **and** the icon.

**Scope of v2 (from review feedback):**
- Cockpit re‑positioned as the **primary debug/analysis hub** (history, logs, errors,
  cost analytics 7/30/90d, dev settings, customization).
- Extension **Options audited across all 10 tabs**, not just Agent.
- Side‑panel **collapse‑state persistence**, exact spacing rhythm, Activity also collapsible.
- Clarified the two‑surface architecture + a unification recommendation.
- Every spacing value specified; the bugs found in the preview are tracked as fixed.

`preview.html` (in repo root) is the live, interactive mock — open it to react before build.

---

## 0. Architecture: two surfaces, one config

| Surface | What it is | Today | Target |
|---|---|---|---|
| **Extension side panel** | 360px control surface while browsing | standalone | keep, polish |
| **Extension Options** | standalone Chrome settings page (gear icon) | its own save model + styles | thin **mirror** of cockpit Settings |
| **Cockpit** | the full Next.js website | passive dashboard, 14 views | **debug/analysis control room** + canonical Settings |

**Recommendation:** Cockpit Settings becomes the **canonical** config store (backend‑backed).
The extension Options page reads/writes the same config — so agent defaults, secrets,
notifications, and connections live in ONE place. This kills the current split‑brain
(global Save button saves most tabs; Prompts/Notifications auto‑persist; provider default
mismatch bug).

---

## 1. Design system (Signal Indigo) — tokens

### 1.1 Palette (single source of truth)
**Dark (primary)**
| Token | Hex | Use |
|---|---|---|
| `--bg` | `#14161C` | app background |
| `--surface` | `#1C1F27` | cards, panels, inputs |
| `--raised` | `#232732` | hover / nested |
| `--overlay` | `rgba(10,12,16,.62)` | scrims |
| `--border` | `#2A2E38` | hairline |
| `--border-hover` | `#3A3F4D` | hover/focus border |
| `--text` | `#E7E9F0` | primary text |
| `--muted` | `#9AA0B0` | secondary |
| `--dim` | `#646B7A` | tertiary/timestamps |
| `--accent` | `#6C5CE7` | CTA, active nav, focus, live |
| `--accent-hover` | `#7D6EF0` | CTA/link hover |
| `--accent-contrast` | `#FFFFFF` | text on accent |
| `--accent-subtle` | `rgba(108,92,231,.12)` | accent fills |
| `--accent-soft` | `rgba(108,92,231,.06)` | tinted wash |
| `--success` | `#4ADE80` · `--danger` `#F87171` · `--warn` `#FBBF24` · `--info` `#60A5FA` |

**Light** — bg `#F7F8FB`, surface `#FFFFFF`, raised `#EEF0F5`, border `#E2E5EC`,
border‑hover `#D2D6E0`, text `#1A1D26`, muted `#5C6273`, dim `#8A90A0`, accent `#6C5CE7`
(hover `#5A49D6`), success `#16A34A`, danger `#DC2626`, warn `#D97706`, info `#2563EB`.

**Side‑panel terminal log semantics** (distinct, indigo‑leaning): `step #93C5FD`,
`observe #5EEAD4`, `reason #C4B5FD`, `act #8B7BF2`, `ok #4ADE80`, `err #F87171`,
`info #9AA0B0`, `cost #646B7A`.

### 1.2 Radii / elevation / motion
- Radii: `--r 10px` (controls) · `--r-sm 6px` (chips/code) · `--r-lg 16px` (panels) · `--r-xl 20px` (modals).
- `--shadow-md: 0 6px 20px rgba(0,0,0,.38)`; `--glow: 0 0 0 1px rgba(108,92,231,.45), 0 8px 28px rgba(108,92,231,.22)`; `--ring: rgba(108,92,231,.55)`; `--glass: rgba(20,22,28,.72)+blur(12px)`.
- `--ease 160ms ease`; honor `prefers-reduced-motion`.

### 1.3 ⭐ Spacing rhythm (the detail pass)
These exact values are used **everywhere** so nothing drifts:
```
--gap-label:   6px   /* label → control */
--gap-field:  18px   /* control → next field (vertical) */
--gap-section:24px   /* section → section */
--pad-input:  10px 12px
--pad-card:   16px 20px
```
Rules:
- Side‑by‑side fields use `align-items:flex-start` (NOT `flex-end`) so inputs top‑align;
  both fields get equal bottom margin via `--gap-field`. **Fixes the "Max steps box sits
  higher than Default model" bug.**
- The `small` helper text sits `--gap-label` under its input; the **next** field starts
  `--gap-field` below that, so helper‑text never collides with the next label
  (**fixes "hard stop…" text crowding the Vision‑mode subtitle**).
- Cockpit mirrors this with Tailwind spacing scale (`gap-4`≈16, `gap-6`≈24, `p-4/p-5`).

### 1.4 Typography
Geist Sans / Geist Mono / JetBrains Mono (cockpit); system sans+mono (extension).
Scale (sentence case, never ALLCAPS): display 18/600 · h1 16/600 · h2 15/600 · h3 13/600 ·
body 13/1.55 · small 12 · micro 11. **Mono only for data values** (time, tokens, host,
version) via `.cw-mono` / `.cowork-mono`. Eyebrow `.cowork-eyebrow` 11/500 muted.

### 1.5 Scrollbars
Both WebKit **and** Firefox (`scrollbar-width:thin; scrollbar-color:…`). Current side
panel is WebKit‑only — fixed.

---

## 2. Icon & brand (delivered as artifact)
- `src/extension/icons/icon.svg` (node‑graph mark) + generated `icon-16/32/48/128.png`
  (the old icon was a **JPEG renamed .png** — replaced). Wire per‑size into both
  `manifest.json` files.
- `cockpit/public/logo.svg` — replaced the unrelated "Z" mark.
- Side‑panel header `.mark` → inline SVG node‑graph tile (28×28).
- Product name unified to **"Open Cowork"** across side panel, options, cockpit sidebar/
  footer/`<title>`, `layout.tsx` metadata.

---

## 3. Extension — Side Panel (full audit)

**Layout (top→bottom):** header (mark + title + tagline) → main (scroll) → footer.

1. `Open cockpit dashboard` ghost button
2. Mission `textarea` (labeled) + `Solve test / Fill form / Summarize` preset pills
3. Agent mode `select` (Restricted / Standard / Full agentic)
4. Status row: spinner + lifecycle label + `running` badge (indigo)
5. `▶ Run` (primary, glow on hover) / `⏸ Pause` / `■ Stop` (danger‑tinted)
6. Model‑switch input + Switch
7. Takeover banner (warn tint) + Resume — **fix double‑injected reason text** (clear before set)
8. Progress `step n / max` + bar + element count; cost row (mono, tabular‑nums)
9. **Reasoning** `<details>` — collapsible, persisted
10. **Activity** `<details>` — collapsible, persisted (was not collapsible before)
11. Debug hint + Debug‑highlights toggle

**Fixes carried from review:**
- [x] Both Reasoning **and** Activity collapsible; **collapse state persisted** to
  `chrome.storage.local` (reopen → remembers). Shown working in `preview.html`.
- [x] `main{overflow:hidden}` → allow scroll when panel is short (no clipped controls).
- [x] Replace hard‑coded `step 0 / 100` with `data-max`‑driven label.
- [x] Widen log `.lb` label column (`min-width` + nowrap) so `act 3/4` no longer wraps.
- [x] `.paused` gets a real visual state (dim + "Resume" text swap), not inert.
- [x] Uniform focus rings via `--ring`; WebKit+Firefox scrollbars.
- [~] Icon set: propose replacing the emoji‑soup (🧠👁🖱▸✓⚠$) with **one consistent
  inline‑SVG glyph set** (lucide‑style) for OS‑consistent crispness; keep meaning map.

---

## 4. Extension — Options (all 10 tabs audited)

> Every tab gets: a `ViewHeader`‑style title + subtitle, consistent field rhythm (§1.3),
> one `.btn` system (kill the duplicated Save/Test/Add/Danger CSS), **styled modal** in
> place of native `alert()`/`confirm()`, and proper `<label>`/aria on every control.
> Tabs switch via JS (no full reload) — shown working in `preview.html`.

| # | Tab | Content | Notes / fixes |
|---|---|---|---|
| 1 | **Connection** | Cockpit URL, Provider select, API key, Test‑connection + live result | fix default‑provider mismatch (load vs first option) |
| 2 | **Agent** | Max steps, Default model, Vision mode (radios), Allowed/Blocked domains, **Local Vision Assistant** callout | copy: **"uses ~2.5 GB of memory, recommended for text‑only LLMs"**; fix row2 alignment + spacing (§1.3) |
| 3 | **Secrets** | CRUD list (name/value, masked) + Add | dedupe status‑color defs into one module |
| 4 | **Schedule** | Recurring tasks (mission + time + repeat) + enable/disable | |
| 5 | **Tools** | Custom tools (name/desc/schema) + manifest‑permission badges | |
| 6 | **Skills** | Skills list — **stop reusing `.secret-item`**; own markup | |
| 7 | **Prompts** | Default system prompt + quick‑prompt CRUD | auto‑persist, but show "Saved" cue consistently |
| 8 | **History** | Past runs (mission, status badge, cost, time) → **in‑page modal transcript** (not Blob new‑tab) | |
| 9 | **Notify** | Toggle rules: on error / complete / takeover + channels | |
| 10 | **About** | Version, links, license | |

**Cross‑tab fixes:** remove inline `style=` spacing; single Save model (or clear auto‑save
cues everywhere); in‑page history viewer; remove JS‑injected `display` toggles → class state.

---

## 5. Cockpit — repositioned as the debug/analysis hub

Existing 14 views are kept but **regrouped and extended**. New/richer pieces in **bold**.

### 5.1 Information architecture (sidebar groups)
- **Observe** — **Overview**, **Runs & History**, **Logs Explorer**, **Errors & Incidents**,
  **Cost & Usage**, Live: Sessions, Tabs, Workspaces, Network*, Snapshots*, DevTools*
- **Build** — Agents, Workflows, MCP Tools, Skills, Prompts, Memory, Collections, Extensions
- **Secure** — Security
- **Settings** — Appearance, Agent defaults, Debugging, Connections, Notifications, Data, About

(\* = extension‑only; same consistent "standby" panel via shared `ExtensionOnly` component)

### 5.2 New / substantially expanded views
- **Overview (new home):** KPI cards — active agents, runs today / 7d, success rate,
  spend 7d & 30d (sparkline), open errors; live status strip; recent runs; recent errors.
- **Runs & History (expand existing):** full run list (mission, status, duration, steps,
  cost, model, started) with date‑range + status + agent filters. **Run detail:** aggregated
  timeline (the side‑panel Activity log, but across the run), screenshot thumbnails,
  reasoning, tool calls, cost breakdown, **export JSON**.
- **Logs Explorer (new):** every log across all agents; filter by level
  (debug/info/warn/error), source (planner/navigator/tool/observer), agent, time range;
  full‑text search; streaming tail; export.
- **Errors & Incidents (expand Security/errors):** aggregated errors grouped by type,
  frequency, stack/trace, affected runs, **"challenge detected"** events, resolution state,
  retry action.
- **Cost & Usage Analytics (new):** range selector **7d / 30d / 90d / custom**; total spend
  + tokens; trend chart; breakdown **by agent / model / domain**; budget warnings &
  projections; top‑expensive runs; **export CSV**. *This is the "past 7 days / past 30 days"
  view you asked for, plus 90d and by‑dimension slices.*
- **Sessions (expand):** list + **replay** — scrubable timeline of screenshots/steps
  reconstructing what the agent did.
- **Settings (new, big — see 5.3).**

### 5.3 Settings (the canonical config — replaces split‑brain)
- **Appearance:** theme (dark/light/system), **accent color** (default indigo; allow custom
  for power users), density (comfortable/compact), base font size, reduce‑motion.
- **Agent defaults:** default model, max steps, vision mode, modes, domain allow/block —
  **mirrors the extension Agent tab** (one source).
- **Debugging:** log verbosity, debug‑highlights default, capture‑screenshots toggle,
  record full DOM snapshots, experimental‑features flag, export telemetry.
- **Connections:** cockpit URL, provider config, API keys (mirror Secrets).
- **Notifications:** rules (mirror extension Notify).
- **Data:** retention policy, export all, import, clear history (styled confirm), storage usage.
- **About:** version, build, licenses.

### 5.4 Existing views — consistency fixes
- `agents-view` empty state → use `EmptyState` (not raw Card).
- `collections-view` / `memory-view` hand‑rolled tables → migrate to `DataTable`.
- `mcp-tools-view` → **add `aria-label`** to `Select` + search.
- `devtools` / `snapshots` → shared `ExtensionOnly` standby (no more bare empty state).
- `security` / `tabs` divergent summary cards → shared `StatCard`.
- Add shared `SearchInput` (dedupe 4 copies) + `StatusPill` `info` gets distinct blue.
- Delete dead `cowork-severity-*` CSS; focus rings → indigo `--ring`.

---

## 6. Accessibility (acceptance)
- [ ] Every input/select labeled or `aria-label` (fixes 4 search inputs + MCP Select).
- [ ] Visible focus ring (indigo) on all interactive elements.
- [ ] Color never the only signal (icon + text + optional border).
- [ ] `prefers-reduced-motion` disables pulse/glow/transition.
- [ ] Modal: focus trap + `aria-modal` + Esc + focus return; **no native alert/confirm**.
- [ ] Collapse state persisted & announced; `<main>` gets `id`+`aria-label`; skip link.
- [ ] Icon `role="img"`+`aria-label`; sufficient contrast both themes.

---

## 7. Execution phases
- **P0 Token foundation** — `globals.css` + both extension CSS → Signal Indigo; spacing vars;
  delete dead CSS; `docs/design-system.md`.
- **P1 Icon & brand** — wire PNG set into manifests; side‑panel mark; unify name.
- **P2 Side panel** — markup restructure, both collapsibles + persistence, scroll/clip fix,
  glyph consistency, spacing rhythm.
- **P3 Options** — all 10 tabs (§4), styled modals, single save model, in‑page history.
- **P4 Cockpit shell** — active‑nav contrast, double‑border, width unify (240px), palette‑
  aware overlays, connection‑status comment fix.
- **P5 Primitives & shared** — indigo rings, `SearchInput`, `StatCard`, `ExtensionOnly`,
  `StatusPill` info tone, `DataTable` migration.
- **P6 Cockpit views** — regroup IA (§5.1); build **Overview, Logs Explorer, Errors &
  Incidents, Cost & Usage, Run detail, Session replay, Settings**; extend existing.
- **P7 Verify** — `grep` for old hex (`#D97757 #262624 #30302E #A8A6A0 #3D3B38 #F5F4EE
  #ECEBE6`) → zero; `npm --prefix cockpit run build` + lint + tests green; load extension,
  screenshot dark+light; visual diff confirms one Signal‑Indigo family.

---

## 8. Preview bugs found & status (from review)
| # | Issue | Status |
|---|---|---|
| 1 | Options tabs not clickable | ✅ fixed — all 10 switch in `preview.html` |
| 2 | "Options vs cockpit?" confusion | ✅ clarified §0; unification recommended |
| 3 | Activity not collapsible + no persist | ✅ both collapsible + persisted (localStorage demo) |
| 4 | Spacing not audited | ✅ spacing rhythm §1.3 spec |
| 5 | Vision copy | ✅ "~2.5 GB… recommended for text‑only LLMs" |
| 6 | Max‑steps/Default‑model misalign + tight | ✅ `align-items:flex-start` + rhythm vars |
| 7 | Only Agent tab shown | ✅ all 10 tabs authored in preview |

*Plan is phase‑by‑phase executable. P0–P1 first (tokens+icon), then surfaces, then P7 verify.*
