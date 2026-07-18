# Open Cowork

**Type what you want done. Your browser does the rest — privately, on your own machine.**

[![License: MIT](https://img.shields.io/badge/license-MIT-brightgreen.svg)](https://opensource.org/licenses/MIT)
[![Chrome 116+](https://img.shields.io/badge/chrome-116%2B-blue.svg)](https://www.google.com/chrome/)
[![Node 20.9+](https://img.shields.io/badge/node-20.9%2B-blue.svg)](https://nodejs.org/)

Open Cowork is a Chrome extension that turns your browser into an Agent you talk to instead of click through. Tell it *"fill out this form"* or *"summarize this page,"* and the agent reads what's on screen, figures out the steps, and does them for you — across as many tabs as you have open.

It runs on your own machine and uses your own API key from whichever AI provider you like. There's an optional dashboard called the **Cockpit** for watching runs and tracking costs, but the extension works fine on its own.

> [!WARNING]
> Automating a website is still subject to *that site's* terms of service. Open Cowork gives you the tool — whether a particular use is allowed is on you to check.

---

## Inspired by


- [nanobrowser](https://github.com/nanobrowser/nanobrowser) ![stars](https://img.shields.io/github/stars/nanobrowser/nanobrowser?style=social) — a Chrome extension agent with a planner/navigator split and numbered marks drawn onto screenshots
- [browser-use](https://github.com/browser-use/browser-use) ![stars](https://img.shields.io/github/stars/browser-use/browser-use?style=social) — reading a page through the DOM and the accessibility tree together, with a clean set of named actions
- [agent-browser](https://github.com/vercel-labs/agent-browser) ![stars](https://img.shields.io/github/stars/vercel-labs/agent-browser?style=social) — the side-panel layout and showing the agent's thinking live as it works
- [AIPex](https://github.com/AIPexStudio/AIPex) ![stars](https://img.shields.io/github/stars/AIPexStudio/AIPex?style=social) — a bring-your-own-key browser agent that keeps its loop running reliably
- [Stagehand](https://github.com/browserbase/stagehand) ![stars](https://img.shields.io/github/stars/browserbase/stagehand?style=social) — a tidy way to point the model at page elements and replay steps without asking it again
- [Skyvern](https://github.com/Skyvern-AI/skyvern) ![stars](https://img.shields.io/github/stars/Skyvern-AI/skyvern?style=social) — a separate check that a task really finished, plus guardrails for runs that cost real money
- [UI-TARS](https://github.com/bytedance/UI-TARS) ![stars](https://img.shields.io/github/stars/bytedance/UI-TARS?style=social) — finding on-screen elements from a screenshot, which shaped the optional local vision helper
- [steel-browser](https://github.com/steel-dev/steel-browser) ![stars](https://img.shields.io/github/stars/steel-dev/steel-browser?style=social) — a clean live event stream for watching a browser session

---

## What it does

- **You talk, it works.** Describe a task in plain English and the agent observes the page, plans, acts, checks its work, and repeats — no brittle scripts.
- **It's yours and it's private.** Your API key stays on your machine and your page data only ever goes to the AI provider you pick. No account, no cloud middleman, no telemetry.
- **Use any model.** Works with OpenAI, Anthropic, Google Gemini, DeepSeek, Groq, Mistral, xAI, Ollama (local and free), OpenRouter, and any OpenAI-compatible provider.
- **It reads pages like a person.** It understands page structure and text, and can optionally use a vision model for image-heavy or canvas-based sites — including a small vision helper that runs entirely on your own computer.
- **You stay in control.** Three modes let you decide how much freedom the agent has, and it pauses and hands back to you for logins, payments, and CAPTCHAs.
- **Set it and forget it.** Schedule tasks to run on an interval, daily, or weekly.
- **The Cockpit dashboard (optional).** A companion web app for run history, live views, cost tracking, and audit logs.

---

## Getting started

### You'll need

- [Node.js](https://nodejs.org/) 20.9 or later (comes with npm)
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

`build:all` builds both the extension and the Cockpit dashboard. If you only want the browser agent, run `npm run build:extension` instead — it's much faster.

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

Then start it:

```bash
npm run dev:cockpit                       # runs at http://localhost:3000
```

Keep that terminal open, then click **Open cockpit dashboard** from the side panel.

> [!IMPORTANT]
> Skip the `npx prisma db push` step and the dashboard will build fine but return errors on every page, because its database tables don't exist yet.

---

## A note on privacy and safety

Open Cowork is built to be safe first. Your API key stays local, secrets are swapped in only at the moment they're needed and are kept out of logs and the model's view, and risky actions — logins, payments, running JavaScript — are gated behind modes you choose. For anything high-stakes, use **Restricted** mode. Page content is never trusted blindly.

---

## Contributing

Issues and pull requests are welcome. If you're adding a new model provider or a site-specific skill, the existing ones under `src/lib/agent/` are the best examples to copy from.

## License

MIT — do what you want with it.

The Open Cowork project is distributed under the MIT License (see
[`LICENSE`](LICENSE)). The shipped browser-extension **bundle** additionally
includes Apache-2.0–licensed components — notably
[`@huggingface/transformers`](https://github.com/huggingface/transformers)
(used by the optional on-device Local Vision stack). Per Apache-2.0 §4(d),
those bundled components retain their license and attribution, which is
recorded in the extension's `NOTICE` file (and the full Apache-2.0 text in
`LICENSE-APACHE`). No personal data is involved in that third-party code.
