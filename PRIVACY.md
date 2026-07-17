# Privacy Policy — open-cowork

This document describes the personal data collected by the **open-cowork**
browser extension and its companion **cockpit** dashboard: where it is stored,
what leaves your machine, how long it is kept, and how to delete it. It exists
to satisfy the transparency obligations (e.g. GDPR Art. 13/14) that apply to a
product handling browsing-derived personal data, and it backs the erasure
endpoints documented below.

## Data collected and stored

The cockpit backend persists the following user-derived data via Prisma:

- **Browsing history** (`HistoryEntry`): visited URLs and page titles.
- **Bookmarks & tab snapshots** (`Bookmark`, `Tab`): URLs, titles, favicons,
  and folder structure.
- **Form-autofill memory** (`FormMemory.formDataJson`): captured form fields.
- **Per-site memory** (`SiteMemory`): structured notes attached to origins.
- **Network request/response metadata** (`NetworkRequest`): the schema defines
  this model, but the cockpit does **not** currently ingest network data — live
  network requests stay in the extension only.
- **LLM chat content** (`ChatMessage.content`): prompts and completions.
- **Account identifier** (`User.email`): a direct personal identifier.
- **Agent run logs**: structured error/stack/message text submitted by the
  extension's log endpoint.

## What leaves your machine

- Page content, DOM/accessibility snapshots, and chat prompts are sent to the
  **user-configured LLM provider** (for example OpenAI or Anthropic) only when a
  feature explicitly invokes it.
- If a webhook integration is enabled, selected events may be delivered to an
  **arbitrary user-configured URL**.
- The cockpit itself stores data in its own database and does not transmit it
  elsewhere except as configured above. Stored bookmark/tab URLs are opened
  client-side in the browser and are never fetched server-side.

## Retention

Data is retained until deleted by the user or via the erasure endpoints below.
No automatic expiration is currently applied.

## Your rights / deletion (right to erasure & opt-out)

The following erasure endpoints let you remove stored personal data:

- `DELETE /api/cowork/history?id=<id>` or `?all=1` — erase browsing history.
- `DELETE /api/cowork/memory/site?id=<id>` — erase a per-site memory entry.
- `DELETE /api/cowork/memory/form?id=<id>` — erase a form-memory entry.
- `DELETE /api/cowork/ai/chat?messageId=<id>` or `?sessionId=<id>` — erase chat
  messages.

These are backed by the cockpit's Prisma store and can be used to exercise a
right to erasure / opt-out.

## Contact

For the data controller / operator contact details and the official privacy
notice, email **security@opencowork.dev**. (The extension is distributed as
an unpacked load from this repository — there is no Chrome Web Store listing
yet — so no store-based contact or notice exists.)
