# Open Cowork

**Tell your browser what to do. It does the rest, privately, on your own machine.**

[![License: MIT](https://img.shields.io/badge/license-MIT-brightgreen.svg)](https://opensource.org/licenses/MIT)
[![Chrome 116+](https://img.shields.io/badge/chrome-116%2B-blue.svg)](https://www.google.com/chrome/)
[![Node 22+](https://img.shields.io/badge/node-22%2B-blue.svg)](https://nodejs.org/)

Open Cowork is a Chrome extension that turns your browser into an agent you talk to. Describe a task in plain English and it reads the page, plans the steps, and acts on them across your open tabs. Your API key stays on your machine and your page data only goes to the AI provider you choose. No account, no cloud, no telemetry.

> [!WARNING]
> Automating a website is still subject to that site's terms of service. Whether a particular use is allowed is on you to check.

## How to get started

### You'll need

- Node.js 22 or later
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

If you only want the browser agent, run npm run build:extension instead. It is much faster.

### Load the extension into Chrome

1. Go to chrome://extensions
2. Turn on Developer mode (top right)
3. Click Load unpacked and pick the chrome-extension folder
4. Pin Open Cowork to your toolbar

### Connect a model

1. Click the Open Cowork icon, then Settings
2. Pick your provider and paste your API key (it stays on your machine)
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

Then start it:

```bash
npm run dev:cockpit
```

Keep that terminal open, then click Open cockpit dashboard from the side panel.

> [!IMPORTANT]
> Skip the npx prisma db push step and the dashboard will build fine but error on every page, because its database tables do not exist yet.

## How it works

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

## License

MIT. Do what you want with it. The shipped extension bundle also includes Apache-2.0 licensed components (notably @huggingface/transformers for the optional on-device vision). Attribution is in the extension's NOTICE file.
