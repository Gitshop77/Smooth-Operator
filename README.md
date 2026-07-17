# Open Cowork

**Type what you want done. Your browser does the rest.**

[![License: MIT](https://img.shields.io/badge/license-MIT-brightgreen.svg)](https://opensource.org/licenses/MIT)
[![Chrome 116+](https://img.shields.io/badge/chrome-116%2B-blue.svg)](https://www.google.com/chrome/)
[![Node 20.9+](https://img.shields.io/badge/node-20.9%2B-blue.svg)](https://nodejs.org/)
[![GitHub stars](https://img.shields.io/github/stars/Gitshop77/open-cowork-chrome-extension?style=flat)](https://github.com/Gitshop77/open-cowork-chrome-extension)

Open Cowork is a Chrome extension you talk to instead of click through. Tell it "fill out this form" or "summarize this page," and it reads what's on screen, works out what needs clicking or typing, and does it — across as many tabs as you've got open.

It runs entirely on your machine. Bring your own API key from whichever LLM provider you like. No cloud relay, no subscription, nobody in the middle.


> [!WARNING]
> Automating another site is still subject to *that site's* Terms of Service — Open Cowork just gives you the tool. Whether a particular use is allowed is on you to check.

> [!NOTE]
> **Anti-detection / stealth patches are opt-in and OFF by default.** Open Cowork includes 13 MAIN-world "stealth" patches (spoofing `navigator.webdriver`, `window.chrome`, WebGL vendor/renderer, screen geometry, and more) that reduce bot-detection cues on the pages the agent visits. Circumventing a site's automation/bot-detection defenses can violate that site's Terms of Service — especially when the agent runs with real API keys and real money at stake. The patches are therefore **disabled unless you explicitly enable them** via the `stealthEnabled` option in the extension's Settings page. No flag, a `false` flag, or any non-`true` value leaves them off. Enable them only for sites you are authorized to automate, and accept the ToS responsibility yourself.

## Inspired by

Open Cowork wouldn't exist without their work:

| Project | Stars | What we took from it |
|---|---|---|
| [Cowork (official)](https://chromewebstore.google.com/detail/open-cowork/fcoeoabgfenejglbffodgkkbkcdhcgfn) | — | We took apart the official extension to understand its manifest, its `Ctrl+E` shortcut, the `tabGroups`/`unlimitedStorage` permissions it asks for, and how its side panel behaves |
| [nanobrowser](https://github.com/nanobrowser/nanobrowser) | ![stars](https://img.shields.io/github/stars/nanobrowser/nanobrowser?style=social) | The planner/navigator split, and marking element numbers directly onto screenshots |
| [browser-use](https://github.com/browser-use/browser-use) | ![stars](https://img.shields.io/github/stars/browser-use/browser-use?style=social) | Reading a page through the DOM and the accessibility tree at the same time, plus a clean way to name actions |
| [OpenCode](https://github.com/anomalyco/opencode) | ![stars](https://img.shields.io/github/stars/anomalyco/opencode?style=social) | A clean abstraction for swapping LLM providers, and composable auth patterns |
| [agentuse](https://github.com/agentuse/agentuse) | ![stars](https://img.shields.io/github/stars/agentuse/agentuse?style=social) | The plugin system — letting people register their own JavaScript tools |
| [agent-browser](https://github.com/vercel-labs/agent-browser) | ![stars](https://img.shields.io/github/stars/vercel-labs/agent-browser?style=social) | The side panel layout, and showing the agent's reasoning live as it works |
| [open-operator](https://github.com/browserbase/open-operator) | ![stars](https://img.shields.io/github/stars/browserbase/open-operator?style=social) | Falling back to raw Chrome DevTools Protocol clicks, and anti-detection tricks |
| [open-cowork](https://github.com/OpenCoworkAI/open-cowork) | ![stars](https://img.shields.io/github/stars/OpenCoworkAI/open-cowork?style=social) | The name, the original concept, and the design behind scheduled tasks |
| [BrowserAI](https://github.com/sauravpanda/BrowserAI) | ![stars](https://img.shields.io/github/stars/sauravpanda/BrowserAI?style=social) | The local-first mindset, and running models directly in the browser |
| [OpenBrowser](https://github.com/OpenBrowserAI/openbrowser) | ![stars](https://img.shields.io/github/stars/OpenBrowserAI/openbrowser?style=social) | Detecting vision support per model, and pulling live data from the models.dev catalog |

## Getting started

### Before you start

You'll need:
- **npm**, which comes with [Node.js](https://nodejs.org/) 20.9 or later
- [Chrome](https://www.google.com/chrome/) 116 or later
- An API key from any provider below

```bash
# Check you have npm
npm --version
```

> [!TIP]
> Prefer Bun? It's a drop-in replacement here — swap `npm` for `bun` in every command below and nothing else changes.

### Get the code

```bash
git clone https://github.com/Gitshop77/open-cowork-chrome-extension.git
cd open-cowork-chrome-extension
npm install
```

### Build everything

```bash
npm run build:all
```

This builds the Chrome extension (esbuild, ~2s) and the Cockpit dashboard (Next.js, ~60s) in one step. The extension is what you load into Chrome; the Cockpit is the optional companion dashboard for real-time observability — both are built together so you're ready for either.

> [!TIP]
> Only want the browser agent and don't need the dashboard? Run `npm run build:extension` instead — it skips the Cockpit build and finishes in ~2 seconds.

### Load the extension

In Chrome:
1. Go to `chrome://extensions`
2. Turn on **Developer mode**, top right corner
3. Click **Load unpacked** and select the `chrome-extension/` folder
4. Pin **Open Cowork** to your toolbar

### Start the Cockpit dashboard (optional)

The Cockpit dashboard runs as a separate local web server. It does **not** start automatically when you load the extension — you need to start it manually:

```bash
npm run dev:cockpit
```

This starts the Next.js dev server on `http://localhost:3000`. Keep this terminal window open while you use the dashboard. Click **Open cockpit dashboard** in the side panel to open it in a new tab.

> [!IMPORTANT]
> The Cockpit keeps its data in a local SQLite database that is **not** created by `npm run dev:cockpit` or `npm run build:cockpit` on their own. Before the dashboard works you must:
> 1. Install the sub-package dependencies once with `npm run bootstrap` (the `npm install` at the top installs only the repo-root packages).
> 2. Create the database schema once with `cd cockpit && npx prisma db push` (the CI pipeline runs this for you; a local first run does not).
>
> Skipping step 2 gives a dashboard that builds fine but returns 500 on every query because the tables don't exist yet.

For production use (faster page loads, no hot-reload):

```bash
npm run build:cockpit
cd cockpit && npm start
```

### Connect a model

The extension talks to your LLM provider directly.

1. Click the Open Cowork icon, then **Settings**
2. Pick a **Provider**
3. Paste in your **API key** — it stays on your machine and only ever goes to the provider you chose
4. Type a **model** name — it searches the live models.dev catalog as you type, showing price, context length, and whether it handles images
5. On an OpenAI-compatible provider (DeepSeek, Qwen, Groq, Ollama, etc.), the **Base URL** fills itself in
6. Click **Save**

| Provider | Example model IDs (verify vs. your provider; the field auto-suggests live models) | Vision-capable models | Get a key |
|---|---|---|---|
| **Ollama** (local, free) | `llama3.3`, `qwen3-vl`, `phi4` | qwen3-vl, llama3.2-vision, minicpm-v | [ollama.com](https://ollama.com) |
| **OpenCode** | any of 75+ routed models | varies by model | [opencode.ai/docs/providers](https://opencode.ai/docs/providers) |
| **OpenAI** | `gpt-5.5` | every gpt-5 model | [platform.openai.com](https://platform.openai.com/api-keys) |
| **Anthropic** | `claude-sonnet-5`, `claude-opus-4.8` | every Claude model | [console.anthropic.com](https://console.anthropic.com/) |
| **Google Gemini** | `gemini-3.5-flash`, `gemini-3.1-pro` | every Gemini model | [aistudio.google.com](https://aistudio.google.com/apikey) |
| **Google (Vertex)** | `gemini-3.5-flash`, `gemini-3.1-pro` | every Gemini model | [console.cloud.google.com/vertex-ai](https://console.cloud.google.com/vertex-ai) |
| **DeepSeek** | `deepseek-v4-pro`, `deepseek-v4-flash` | DeepSeek-VL2 (V4 itself doesn't have confirmed vision yet) | [platform.deepseek.com](https://platform.deepseek.com) |
| **Qwen / Alibaba** | `qwen3.6`, `qwen3-vl` | qwen3-vl | [dashscope.aliyun.com](https://dashscope.aliyun.com) |
| **Groq** | `openai/gpt-oss-120b`, `qwen/qwen3.6-27b` | `llama-4-scout-17b-16e-instruct`, `llama-4-maverick-17b-128e-instruct` | [console.groq.com](https://console.groq.com) |
| **Together AI** | `Llama-4-Maverick-17B-128E-Instruct-FP8` | same model — Llama 4 is natively multimodal | [api.together.xyz](https://api.together.xyz) |
| **Mistral** | `mistral-large-latest`, `mistral-small-latest` | Mistral Small 4, Mistral Medium 3.5 | [console.mistral.ai](https://console.mistral.ai) |
| **Cerebras** | `llama-4-scout`, `gemma-4` | Gemma 4 | [cerebras.ai](https://cerebras.ai) |
| **OpenRouter** | 300+ models | routes to any vision model | [openrouter.ai](https://openrouter.ai) |
| **LiteLLM** | whatever your proxy routes to | varies by routed model | [github.com/BerriAI/litellm](https://github.com/BerriAI/litellm) |
| **Azure OpenAI** | `gpt-5.5` | gpt-5.5 | [portal.azure.com](https://portal.azure.com) |
| **xAI (Grok)** | `grok-2` | varies by model | [x.ai/api](https://x.ai/api) |

> [!NOTE]
> The OpenAI-compatible profile in `src/lib/agent/llm/providers/openai-compatible-profile.ts` also ships ready-made configurations for **baseten**, **deepinfra**, **fireworks**, and **xAI** (Grok). Pick the matching provider ID in Settings and the Base URL fills itself in — bring your own API key from each provider's dashboard.

> [!NOTE]
> The extension's background service worker calls your LLM directly with `fetch`. Chrome's `host_permissions: ["http://*/*", "https://*/*"]` is what lets it reach any provider without hitting CORS errors. Your key lives in `chrome.storage.local` and never goes anywhere except the provider you configured.

### Give it something to do

Three modes control how much freedom the agent has:

| Mode | What it's allowed to touch |
|---|---|
| **Restricted** | Only the current tab — no new tabs, no navigating away. The safest option. |
| **Standard** (default) | Can open tabs, navigate, and browse freely. |
| **Full Agentic** | Everything — JS evaluation, uploads, downloads, up to 500 steps. |

1. Open a web page
2. Click the icon, or press `Ctrl+E` (`Cmd+E` on Mac)
3. Type what you want done — "fill out this form," "summarize this page," whatever it is
4. Pick a mode and click **Run Agent**
5. Watch it work: observe, plan, act, verify, repeat
6. Click **Stop** any time you want to take back control

## Do you actually need a vision model?

Every model reads webpages as text first using the DOM and accessibility tree. For many sites, this is enough. A vision model adds screenshot understanding, allowing the agent to interpret colors, layouts, images, and interfaces that markup alone can't describe, while also enabling interaction with canvas- or WebGL-based applications that have no readable DOM.

The **Local Vision Assistant** bridges this gap by running **NVIDIA's LocateAnything-3B**, a lightweight model specialized for locating UI elements in screenshots. It runs entirely **locally over WebGPU**, so **nothing leaves your machine**, while delivering strong UI element detection despite its small size.

Turn it on under **Settings → Behavior**. You'll need:

- **Chrome or Edge 121+**
- **~3 GB of free VRAM**
- **One-time 2.1 GB model download**

> [!TIP]
> **Model:** **NVIDIA LocateAnything-3B**  
> https://huggingface.co/nvidia/LocateAnything-3B
>
> Runs entirely on your machine using **WebGPU**—no screenshots or data are sent to external servers.

## The 32 things it can do

Every action the agent has access to, grouped by what it's actually doing:

| What it's doing | Actions |
|---|---|
| Interacting with the page | `click` `input` `select_dropdown` `hover` `press_and_hold` `send_keys` `upload_file` |
| Getting around | `navigate` `scroll` `switch_tab` `close_tab` `go_back` `wait` |
| Reading what's there | `find_text` `find_elements` `extract` `search` `search_page` `dropdown_options` |
| Saving proof | `screenshot` `save_as_pdf` |
| Handling popups | `alert_accept` `alert_dismiss` `alert_get_text` `alert_send_keys` |
| Going off-script | `evaluate` `load_skill` `detect_visual` |
| Handing back to you | `ask_human` `takeover` |
| Wrapping up | `verify` `done` |

## Why it asks for these permissions

| Permission | What it's actually for |
|---|---|
| `sidePanel` | Opens the agent's control panel in Chrome's side panel |
| `scripting` | Injects the script that reads the page and carries out actions |
| `tabs` | Lists, switches between, opens, and closes tabs |
| `activeTab` | Reads the current tab for screenshots and DOM extraction |
| `storage` | Saves your API key, settings, run history, secrets, and scheduled tasks |
| `alarms` | Powers the keepalive ping and scheduled-task triggers |
| `debugger` | Falls back to pixel-perfect clicks (via CDP) when a normal click doesn't register — common on React, jQuery, or shadow-DOM sites |
| `downloads` | Saves screenshots and PDFs to your Downloads folder |
| `notifications` | Shows a desktop notification when a run, or a scheduled task, finishes |
| `unlimitedStorage` | Lifts the default 10 MB cap so run history has room to grow |
| `power` | Keeps your computer awake while a scheduled task is waiting to fire |
| `webRequest` | Observes network responses so the agent can detect anti-bot / challenge pages (Cloudflare, hCaptcha, reCAPTCHA) and back off |
| `http://*/*` + `https://*/*` | Lets the extension call any LLM's API directly, without CORS issues, and inject its content script on any web page (narrower than `<all_urls>` — `file://` and `data:` URLs are blocked by design) |

## Security

- Prompt injection defense — page content is wrapped in `<untrusted_page_data>` tags and screened by a 10-pattern classifier before it ever reaches the model
- A strict chain of command — the system prompt outranks your request, and your request always outranks anything found on a page
- Every action gets classified as REGULAR, EXPLICIT-PERMISSION, or PROHIBITED
- Secrets stay secret — `%varName%` placeholders are swapped for real values only at the moment of execution; the model itself never sees them
- You control where it can go, with an allowlist or blocklist of domains
- Sensitive moments pause for you — logins, payments, and CAPTCHAs trigger takeover mode automatically

API keys live in `chrome.storage.local` and persist across restarts. Your secrets live in `chrome.storage.session` and clear the moment you close the browser. Page content is never trusted by default. For anything high-stakes, use **Restricted** mode.

## Build and test commands

```bash
# One-command dev — starts everything at once (cross-platform: Windows / Linux / macOS)
npm install && npm run bootstrap && npm run dev
#   └─ dev runs 3 processes in parallel via `concurrently`:
#        [ext]      extension watch-build (esbuild --watch)
#        [cockpit]  Next.js cockpit dashboard → http://localhost:3000
#        [events]   cowork-events mini-service → http://localhost:3003
#      `npm run bootstrap` installs the cockpit + mini-service sub-packages.
#      Ctrl+C stops all three at once.

npm run lint             # ESLint
npm run test             # Vitest
npm run test:watch       # Vitest watch mode
npm run test:coverage    # Vitest with coverage
npm run build:extension  # Build Chrome extension (esbuild, one-shot)
npm run build:cockpit    # Build the Next.js cockpit dashboard
npm run dev:ext          # Extension watch-build only
npm run dev:cockpit      # Cockpit dev server only (port 3000)
npm run dev:events       # Cowork-events mini-service only (port 3003)
npm run build:all        # Build extension + cockpit
```

## How the code is organized

```
open-cowork-chrome-extension/
├── src/
│   ├── lib/agent/           Core agentic engine
│   │   ├── llm/             4-layer LLM provider architecture (16 providers)
│   │   ├── loop/            Planner + Navigator orchestration
│   │   ├── tools/           32 actions + executor + registry
│   │   ├── prompts/         Navigator + Planner system prompts
│   │   ├── dom/             DOM extraction + AX tree + Set-of-Marks
│   │   └── ...              Security, modes, secrets, skills, memory
│   └── extension/           Chrome extension (MV3)
│       ├── background/      Service worker (agent loop + screenshots)
│       ├── content.ts       Content script (DOM + actions)
│       ├── sidepanel/       Side panel UI
│       ├── options/         Settings page (10 tabs)
│       └── vision-assistant/ Local Vision Assistant (LocateAnything-3B)
├── cockpit/                 Next.js 16 dashboard (Prisma/SQLite)
├── mini-services/
│   └── cowork-events/       WebSocket + AI-proxy service (port 3003)
├── tests/                   Vitest suites (root + cockpit + events)
├── .github/                 CI (npm) + Dependabot
├── docs/safety.md           12 trust-boundary rules
└── package.json
```

## Roadmap

### Shipped
- [x] Planner + Navigator multi-agent architecture
- [x] 32 actions (click, input, scroll, navigate, evaluate, and more)
- [x] 16 LLM providers (OpenAI, Anthropic, Google Gemini, Google Vertex, DeepSeek, Ollama, and more)
- [x] Set-of-Marks annotated screenshots for vision models
- [x] Per-model vision detection via the models.dev catalog
- [x] Prompt-injection defense (10-pattern classifier + NFKC normalization)
- [x] Domain skills for GitHub, Gmail, Amazon, Google, Twitter, LinkedIn, Reddit
- [x] Scheduled tasks (interval / daily / weekly) with keep-awake support
- [x] Run history with full transcripts and cost/token tracking
- [x] Secret substitution (`%varName%` — the model never sees real values)
- [x] Anti-detection (13 stealth patches: webdriver, plugins, WebGL, and more) — **opt-in, OFF by default** (see note below)
- [x] Anti-bot challenge detection (Cloudflare, hCaptcha, reCAPTCHA)
- [x] CDP pixel-perfect click fallback (5-strategy click)
- [x] Loop detection (repeated actions, stagnant pages, goal-level stalls)
- [x] Context compaction — old history gets summarized as context grows
- [x] An independent judge pass that verifies a task actually finished
- [x] Custom tool plugins (bring your own JavaScript)
- [x] Cowork Cockpit dashboard (Next.js + Prisma/SQLite)
- [x] WebSocket mini-service (socket.io + AI proxy)
- [x] Keyboard shortcut (`Ctrl+E` / `Cmd+E`)
- [x] Local Vision Assistant (LocateAnything-3B via WebGPU, 2.1 GB, INT4)
- [x] npm as the default runtime across CI, scripts, and docs
- [x] Vitest test suites passing (root + cockpit + events)

### Building now
- [ ] Real-time tab/agent view in the Cockpit dashboard (currently read-mostly)
- [ ] Live WebSocket sync between Cockpit and the extension
- [ ] More domain skills — Notion, Slack, Jira, Salesforce

### On the horizon
- [ ] A native messaging host so scheduled tasks can wake a sleeping computer
- [ ] WebGPU-based screenshot annotation for faster rendering
- [ ] Running multiple agents in parallel, across tabs
- [ ] Firefox support (MV3 → MV2, plus Firefox's own APIs)
- [ ] A mobile companion app to watch runs from your phone
- [ ] A plugin marketplace for community-built skills and tools
- [ ] A small, purpose-built model for page understanding, instead of leaning on LocateAnything
- [ ] Voice control, maybe
- [ ] A visual action recorder — record a workflow once, replay it as a scheduled task

## Contributing

Issues and pull requests are welcome. If you're adding a new domain skill or LLM provider, the existing ones under `src/lib/agent/` are the best reference for the pattern to follow.

## License

MIT — do what you want with it. Dependency licenses are governed by each package's own license (see `package.json`, `cockpit/package.json`, `mini-services/cowork-events/package.json`, and the installed `node_modules`).
