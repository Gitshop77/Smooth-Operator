# Open Cowork

**Tell your browser what to do. It does the rest — privately, on your own machine.**

[![License: MIT](https://img.shields.io/badge/license-MIT-brightgreen.svg)](https://opensource.org/licenses/MIT)
[![Chrome 116+](https://img.shields.io/badge/chrome-116%2B-blue.svg)](https://www.google.com/chrome/)
[![Node 22+](https://img.shields.io/badge/node-22%2B-blue.svg)](https://nodejs.org/)

Open Cowork is a Chrome extension that turns your browser into an agent you talk to
instead of click through. Say *"fill out this form"* or *"summarize this page,"* and it
reads what's on screen, figures out the steps, and does them — across as many tabs as
you have open.

Everything runs on your own machine, using your own API key from whichever AI provider
you like. There's an optional dashboard called **Cockpit** for watching runs and tracking
costs, but the extension works fine on its own.

> [!WARNING]
> Automating a website is still subject to *that site's* terms of service. Open Cowork
> gives you the tool — whether a particular use is allowed is on you to check.

---

## Inspired by

Open Cowork stands on the shoulders of some great open-source projects:

- [nanobrowser](https://github.com/nanobrowser/nanobrowser) — planner/navigator split with numbered marks on screenshots
- [browser-use](https://github.com/browser-use/browser-use) — reading a page through the DOM and accessibility tree together
- [agent-browser](https://github.com/vercel-labs/agent-browser) — side-panel layout with the agent's thinking shown live
- [AIPex](https://github.com/AIPexStudio/AIPex) — bring-your-own-key agent with a reliable loop
- [Stagehand](https://github.com/browserbase/stagehand) — pointing the model at page elements and replaying steps
- [Skyvern](https://github.com/Skyvern-AI/skyvern) — a check that a task really finished, plus cost guardrails
- [UI-TARS](https://github.com/bytedance/UI-TARS) — finding on-screen elements from a screenshot (shaped our local vision helper)
- [steel-browser](https://github.com/steel-dev/steel-browser) — a clean live event stream for watching a session

---

## What it does

- **You talk, it works.** Describe a task in plain English and the agent observes the page, plans, acts, checks its work, and repeats — no brittle scripts.
- **It's yours and it's private.** Your API key stays on your machine, and your page data only goes to the AI provider you pick. No account, no cloud middleman, no telemetry.
- **Use any model.** Works with OpenAI, Anthropic, Google Gemini, DeepSeek, Groq, Mistral, xAI, Ollama (local and free), OpenRouter, and any OpenAI-compatible provider.
- **It reads pages like a person.** It understands page structure and text, and can optionally use a vision model for image-heavy or canvas-based sites — including a small vision helper that runs entirely on your own computer.
- **You stay in control.** Three modes let you decide how much freedom the agent has, and it pauses to hand back to you for logins, payments, and CAPTCHAs.
- **Set it and forget it.** Schedule tasks to run on an interval, daily, or weekly.
- **The Cockpit dashboard (optional).** A companion web app for run history, live views, cost tracking, and audit logs.

---

## Getting started

### You'll need

- [Node.js](https://nodejs.org/) 22 or later (comes with npm) — required by the Cockpit's Prisma 7 dependency (`@prisma/streams-local` needs Node >= 22)
- [Chrome](https://www.google.com/chrome/) 116 or later
- An API key from any supported provider

> [!TIP]
> Prefer Bun? Swap `npm` for `bun` in any command below — nothing else changes.

### Install and build

```bash
git clone https://github.com/Gitshop77/open-cowork-chrome-extension.git
cd open-cowork-chrome-extension
npm install
npm run bootstrap                       # install the dashboard + events sub-package deps
npm run build:all
```

`build:all` builds both the extension and the Cockpit dashboard. If you only want the
browser agent, run `npm run build:extension` instead — it's much faster.

### Load the extension into Chrome

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick the `chrome-extension/` folder
4. Pin **Open Cowork** to your toolbar

### Connect a model

1. Click the Open Cowork icon, then **Settings**
2. Pick your provider and paste in your API key (it stays on your machine)
3. Type a model name — it suggests current models as you type
4. Click **Save**

### Give it a task

1. Open a web page
2. Click the icon or press `Ctrl+E` (`Cmd+E` on Mac)
3. Type what you want done and pick a mode:
   - **Restricted** — current tab only; the safest option
   - **Standard** (default) — can open tabs and browse freely
   - **Full Agentic** — full freedom, including running JavaScript and uploads
4. Click **Run Agent** and watch it work. Hit **Stop** any time to take back control.

### Start the Cockpit dashboard (optional)

The dashboard is a separate local web app and doesn't start on its own. First-time setup:

```bash
npm run bootstrap                        # install the dashboard's dependencies once
cd cockpit && npx prisma db push         # create its local database once
```

> [!NOTE]
> `npm run build:cockpit` already applies the committed Prisma migration via `db:apply`
> (`prisma migrate deploy`), so the `db push` step above is just an alternative for
> standing up a fresh local database from scratch. Either approach is fine — the
> dashboard's tables just need to exist before it runs.

Then start it:

```bash
npm run dev:cockpit                       # runs at http://localhost:3000
```

Keep that terminal open, then click **Open cockpit dashboard** from the side panel.

> [!IMPORTANT]
> Skip the `npx prisma db push` step and the dashboard will build fine but error on
> every page, because its database tables don't exist yet.

---

## A note on privacy and safety

Open Cowork is built to be safe first. Your API key stays local, secrets are swapped in
only at the moment they're needed and kept out of logs and the model's view, and risky
actions — logins, payments, running JavaScript — are gated behind modes you choose. For
anything high-stakes, use **Restricted** mode. Page content is never trusted blindly.

---

## Model catalog

Open Cowork ships with the **full models.dev database bundled offline** — every
provider, every model, every `api` base URL, and full pricing — so the provider
dropdown, model autocomplete, pricing, context-window info, and vision detection
all work with no network.

- **Bundled full dataset (offline-first).** `scripts/build-models-catalog.ts`
  parses the downloaded [models.dev](https://models.dev) dataset and generates
  `src/lib/agent/llm/catalog-bundled.json` + `catalog-bundled.ts` (committed).
  This is the entire catalog — all 168 providers, every model, every `api`
  endpoint, and complete `cost` (input/output/cache_read/cache_write) data.
- **Live refresh (merge layer).** On startup and whenever your provider / API key
  / model settings change, the extension fetches `https://models.dev/api.json`
  and merges any newer entries on top of the bundled snapshot. The merge is
  additive and cached for 5 minutes, so new providers/models/pricing appear
  automatically without a release. A failed refresh just falls back to the
  bundled snapshot.
- **The provider dropdown is generated from the catalog.** Options no longer
  hardcodes a fixed list. Every provider in the bundled catalog that exposes an
  `api` endpoint (plus any provider in the known facade/profile set) is listed
  automatically, each with its catalog `api` base URL, key env name, and docs
  link. `src/extension/options/providers.ts` still defines the recognized
  facades/profiles, but the visible dropdown is built from the catalog.
- **`buildProvider` is generic.** It has dedicated facades for
  `anthropic` / `google` / `azure` / `openai` / `openrouter` / `xai`. For any
  other provider that has a catalog `api` URL, it builds an OpenAI-compatible
  client against that URL; known OpenAI-compatible providers without an `api`
  field fall back to the `profiles` table.
- **Defaults self-update.** `getDefaultModelForProvider` derives the newest
  non-deprecated model from the catalog, so the default model for a provider
  updates on its own as the dataset changes.

### Test connection

The **Test connection** button in Settings validates your API key by calling the
provider's **`/models`** endpoint (provider-aware — e.g. OpenAI `/v1/models`,
Anthropic `/v1/models`, OpenRouter `/api/v1/models`). It does **not** send a chat
completion, so it never fails with a `404` when the configured default model id
is wrong or unavailable — it only checks that the key is accepted. OpenRouter
model ids use dots (`anthropic/claude-3.5-sonnet`), not hyphens.

### Regenerating the catalog

To refresh the bundled snapshot against the latest models.dev dataset, run:

```bash
npx tsx scripts/build-models-catalog.ts
```

It parses the local dataset (falling back to fetching `api.json` if needed) and
rewrites `src/lib/agent/llm/catalog-bundled.json` + `catalog-bundled.ts`. Commit
the result.

### Model id format tip

Provider/model ids are exact strings. On **OpenRouter** the correct form uses
dots — `anthropic/claude-3.5-sonnet` — not hyphens (`claude-3-5-sonnet`, which
is the Anthropic-direct id). The model picker shows the exact id to copy.

---

## Contributing

Issues and pull requests are welcome. If you're adding a new model provider or a
site-specific skill, the existing ones under `src/lib/agent/` are the best examples to
copy from.

For the full contribution, security, and privacy guidance, see [`AGENTS.md`](AGENTS.md) —
it is the consolidated source of truth for this repo (it replaced `SECURITY.md`,
`CONTRIBUTING.md`, and `PRIVACY.md`).

## License

MIT — do what you want with it.

The Open Cowork project is distributed under the MIT License (see
[`LICENSE`](LICENSE)). The shipped browser-extension **bundle** additionally includes
Apache-2.0–licensed components — notably
[`@huggingface/transformers`](https://github.com/huggingface/transformers) (used by the
optional on-device Local Vision stack). Per Apache-2.0 §4(d), those bundled components
retain their license and attribution, which is recorded in the extension's `NOTICE` file
(and the full Apache-2.0 text in `LICENSE-APACHE`). No personal data is involved in that
third-party code.
