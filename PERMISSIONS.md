# Permissions

Open Cowork is an agentic browser extension — it reads pages, reasons about them, and acts on your behalf. Every permission below exists because the agent needs it to function across any page you point it at.

## API permissions (`permissions`)

| Permission | Why it's needed |
|---|---|
| `sidePanel` | The agent's control console runs in a Chrome side panel. |
| `scripting` | Injects the content script into pages so the agent can read DOM and perform actions. |
| `tabs` | Lists and switches between open tabs; reads tab URLs for domain matching. |
| `activeTab` | Grants temporary access to the currently active tab when the user triggers a run. |
| `storage` | Stores run history, scheduled tasks, custom tools, and per-site memory; API keys and secrets are session-scoped (`chrome.storage.session`, cleared when the browser closes). The API key can optionally be remembered on this device via an opt-in checkbox (persisted unencrypted in `chrome.storage.local`); secrets always stay session-only. |
| `alarms` | Fires scheduled-task alarms; also used as a keepalive while a run is active. |
| `debugger` | Attaches Chrome DevTools Protocol to a tab for pixel-accurate input (click, press-and-hold, screenshot). Only available in the service worker. |
| `nativeMessaging` | Launches the external `lightpanda` browser for the `research` action. MV3 service workers cannot spawn processes, so native messaging is the launch bridge; available in the service worker and options page only. |
| `notifications` | Shows a desktop notification when a scheduled or background run completes. |
| `downloads` | Saves files the agent downloads (Full Agentic save-as-PDF / screenshot export). |
| `unlimitedStorage` | Run history grows without bound — `chrome.storage.local` has a default quota that would be hit quickly. |
| `power` | Keeps the machine awake during long-running tasks via `chrome.power.requestKeepAwake`. |
| `webRequest` | Monitors navigation requests for SSRF protection — blocks the agent from following attacker-supplied redirects. |
| `cookies` | Enables the agent's cookie actions (`get_cookies` / `set_cookie` / `delete_cookies`). Reads are read-only; `set_cookie` requires `url` or `domain`, and the effective URL passes the same domain allow/blocklist gate as `navigate`/`search` before any write — a cookie can never be written to a disallowed host. |

### DNS capability boundary

The packaged stable-browser manifest does not request `dns`. Chrome documents
`chrome.dns` as Dev-channel-only, so requesting it in a stable package would
misrepresent the available SSRF protection. Literal IP, scheme, credential,
and local/private target checks remain enforced. When no declared resolver is
available, untrusted hostname destinations fail closed; explicitly
user-configured provider/webhook hostname destinations retain the documented
best-effort policy and are not reported as fully DNS-rebinding-validated.

## Host permissions

| Pattern | Why it's needed |
|---|---|
| `http://*/*`, `https://*/*` | The agent works across **any** tab you open — it reads DOM, clicks, types, and navigates on whatever page you're on. Restricting host access would silently break the agent on pages outside the allowlist. A per-site restricted scope is available as an optional runtime restriction via the domain allow/block list. Note `file://` and `ftp://` are deliberately NOT included — the agent cannot act on local files. |

## Content Security Policy

| Directive | Value | Why |
|---|---|---|
| `script-src` | `'self' 'wasm-unsafe-eval'` | The Local Vision Assistant runs `@huggingface/transformers` / `onnxruntime-web` as WebAssembly inside an `OffscreenCanvas`. `wasm-unsafe-eval` is required for this — it cannot be replaced with `WebAssembly.compileStreaming` alone. |
| `object-src` | `'self'` | Blocks plugin content. |
| `base-uri` | `'self'` | Prevents base-tag injection. |
| `frame-ancestors` | `'none'` | Extension pages cannot be embedded in iframes. |

## Creep guard

`build-utils.ts` contains `lintManifestPermissions` which runs at build time. It compares the current manifest's high-risk permissions and host patterns against a reviewed baseline. Any **new** high-risk permission or universal-host entry beyond the baseline is a hard build error; permission creep cannot pass through a warning-only path.
