# Open Cowork

**Tell your browser what to do. It does the rest, privately, on your own machine.**

[![License: MIT](https://img.shields.io/badge/license-MIT-brightgreen.svg)](https://opensource.org/licenses/MIT)
[![Chrome 116+](https://img.shields.io/badge/chrome-116%2B-blue.svg)](https://www.google.com/chrome/)
[![Node 22+](https://img.shields.io/badge/node-22%2B-blue.svg)](https://nodejs.org/)

Open Cowork is a Chrome extension that turns your browser into an agent you talk to instead of click through. Say "fill out this form" or "summarize this page" and it reads what is on screen, figures out the steps, and does them across as many tabs as you have open.

Everything runs on your own machine using your own API key from whichever AI provider you like. There is an optional dashboard called Cockpit for watching runs and tracking costs, but the extension works fine on its own.

> [!WARNING]
> Automating a website is still subject to that site's terms of service. Open Cowork gives you the tool. Whether a particular use is allowed is on you to check.

---

## Inspired by

Open Cowork stands on the shoulders of some great open-source projects:

- nanobrowser, a planner/navigator split with numbered marks on screenshots
- browser-use, reading a page through the DOM and accessibility tree together
- agent-browser, a side-panel layout with the agent's thinking shown live
- AIPex, a bring-your-own-key agent with a reliable loop
- Stagehand, pointing the model at page elements and replaying steps
- Skyvern, a check that a task really finished, plus cost guardrails
- UI-TARS, finding on-screen elements from a screenshot (shaped our local vision helper)
- steel-browser, a clean live event stream for watching a session

---

## What it does

- You talk, it works. Describe a task in plain English and the agent observes the page, plans, acts, checks its work, and repeats. No brittle scripts.
- It's yours and it's private. Your API key stays on your machine and your page data only goes to the AI provider you pick. No account, no cloud middleman, no telemetry.
- Use any model. Works with OpenAI, Anthropic, Google Gemini, DeepSeek, Groq, Mistral, xAI, Ollama (local and free), OpenRouter, and any OpenAI-compatible provider.
- It reads pages like a person. It understands page structure and text, and can use a vision model for image-heavy or canvas-based sites. This includes a small vision helper that runs entirely on your own computer.
- You stay in control. Three modes let you decide how much freedom the agent has, and it pauses to hand back to you for logins, payments, and CAPTCHAs.
- Set it and forget it. Schedule tasks to run on an interval, daily, or weekly.
- The Cockpit dashboard (optional). A companion web app for run history, live views, cost tracking, and audit logs.

---

## Getting started

### You'll need

- Node.js 22 or later (comes with npm), required by the Cockpit's Prisma 7 dependency
- Chrome 116 or later
- An API key from any supported provider

> [!TIP]
> Prefer Bun? Swap npm for bun in any command below. Nothing else changes.

### Install and build

```bash
git clone https://github.com/Gitshop77/open-cowork-chrome-extension.git
cd open-cowork-chrome-extension
npm install
npm run bootstrap
npm run build:all
```

build:all builds both the extension and the Cockpit dashboard. If you only want the browser agent, run npm run build:extension instead. It is much faster.

### Load the extension into Chrome

1. Go to chrome://extensions
2. Turn on Developer mode (top right)
3. Click Load unpacked and pick the chrome-extension folder
4. Pin Open Cowork to your toolbar

### Connect a model

1. Click the Open Cowork icon, then Settings
2. Pick your provider and paste in your API key (it stays on your machine)
3. Type a model name. It suggests current models as you type
4. Click Save

### Give it a task

1. Open a web page
2. Click the icon or press Ctrl+E (Cmd+E on Mac)
3. Type what you want done and pick a mode:
   - Restricted. Current tab only, the safest option
   - Standard (default). Can open tabs and browse freely
   - Full Agentic. Full freedom, including running JavaScript and uploads
4. Click Run Agent and watch it work. Hit Stop any time to take back control.

### Start the Cockpit dashboard (optional)

The dashboard is a separate local web app and does not start on its own. First-time setup:

```bash
npm run bootstrap
cd cockpit && npx prisma db push
```

> [!NOTE]
> npm run build:cockpit already applies the committed Prisma migration, so the db push step above is just an alternative for standing up a fresh local database. Either approach is fine. The dashboard's tables just need to exist before it runs.

Then start it:

```bash
npm run dev:cockpit
```

Keep that terminal open, then click Open cockpit dashboard from the side panel.

> [!IMPORTANT]
> Skip the npx prisma db push step and the dashboard will build fine but error on every page, because its database tables do not exist yet.

---

## A note on privacy and safety

Open Cowork is built to be safe first. Your API key stays local. Secrets are swapped in only at the moment they are needed and kept out of logs and the model's view. Risky actions like logins, payments, and running JavaScript are gated behind modes you choose. For anything high-stakes, use Restricted mode. Page content is never trusted blindly.

---

## Model catalog

Open Cowork ships with the entire models.dev database built in, so it works fully offline. Every provider, every model, every API address, and full pricing are included. That powers the provider dropdown, model suggestions, pricing, context size, and vision detection with no network needed.

The bundle currently holds 167 providers and 5,578 models. It follows the live dataset, so those numbers keep growing.

- Works offline. The full list is bundled into the extension. When you are offline or a live check fails, it just uses what it already has.
- Stays current. On startup and whenever you change your provider, key, or model, it fetches the latest models and merges them in. New providers, models, and prices show up without a new release.
- Refresh anytime. Settings has a Refresh models from models.dev button that pulls the latest list on demand and updates the picker right away. No restart needed.
- The provider list builds itself. Every provider in the catalog that offers an API appears automatically, each with its address, key name, and docs link.
- Defaults keep up. Each provider's default model updates to the newest available as the dataset changes.

### Test connection

The Test connection button in Settings checks your API key by calling the provider's models endpoint. It is provider-aware, for example OpenAI, Anthropic, and OpenRouter each use their own path. It does not send a chat message, so it never errors just because a model name is wrong. It only confirms the key works.

That check also locks the request to the provider's own host and refuses redirects, so a bad address can never sneak your key off to an attacker.

On OpenRouter, model ids use dots like anthropic/claude-3.5-sonnet, not hyphens.

### Update the bundled list yourself

To refresh the built-in list against the latest models.dev data, run:

```bash
npx tsx scripts/build-models-catalog.ts
```

It rewrites the bundled catalog file. Commit the result.

---

## Contributing

Issues and pull requests are welcome. If you are adding a new model provider or a site-specific skill, the existing ones under src/lib/agent/ are the best examples to copy from.

For the full contribution, security, and privacy guidance, see AGENTS.md. It is the consolidated source of truth for this repo (it replaced SECURITY.md, CONTRIBUTING.md, and PRIVACY.md).

## License

MIT. Do what you want with it.

The Open Cowork project is distributed under the MIT License (see LICENSE). The shipped browser-extension bundle additionally includes Apache-2.0 licensed components, notably @huggingface/transformers (used by the optional on-device Local Vision stack). Per Apache-2.0 4(d), those bundled components retain their license and attribution, which is recorded in the extension's NOTICE file (and the full Apache-2.0 text in LICENSE-APACHE). No personal data is involved in that third-party code.
