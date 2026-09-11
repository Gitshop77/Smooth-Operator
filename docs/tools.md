# Tools, resources, and prompts

The public surface is locked in `src/server/catalog.ts` and
`tests/contract-snapshot.test.ts`. `tools/list` is 57 one-job tools.
Compatibility aliases and retired `browser_logs` are unlisted catalog maps.

Operations: cookies `get`/`set`/`delete`; storage and resource-blocking
`get`/`set`/`clear`; network and console logs
`enable`/`disable`/`read`/`clear`/`read_and_clear`; dialogs
`get_text`/`accept`/`dismiss`/`send_keys`. Element tools take exactly one of
`target`, `ref`, `selector`, or `index` and have no `operation`.
`browser_click`, `browser_move`, and `browser_press_and_hold` also accept
`coordinateX`/`coordinateY` (hold also start/end coordinates or a path).
`browser_challenge` is detect-only; solve is `browser_solve_challenge`.

Canonical tools: `browser_tabs`, `browser_snapshot`, `browser_input`,
`browser_back`, `browser_close`, `browser_extract`, `browser_wait`,
`browser_network_log`, `browser_challenge`, `browser_batch`.

## Unlisted catalog maps

Compatibility aliases (`browser_list_tabs`, `browser_get_state`,
`browser_type`, `browser_extract_content`, `browser_go_back`,
`browser_close_all`, `browser_exec`) plus retired `browser_logs` are not in
`tools/list`.

| Unlisted name | Canonical call |
|---|---|
| `browser_list_tabs` | `browser_tabs` |
| `browser_get_state` | `browser_snapshot` |
| `browser_type` | `browser_input` |
| `browser_extract_content` | `browser_extract` |
| `browser_go_back` | `browser_back` |
| `browser_close_all` | `browser_close` |
| `browser_exec` | `browser_batch` (`actions` is a validated array, never a shell) |
| `browser_logs` | `browser_network_log` `{ operation: "read" }` |

## Observation

`browser_snapshot`, `browser_tabs`, `browser_list_sessions`,
`browser_page_info`, `browser_interactive`, `browser_frames`,
`browser_accessibility_snapshot`, `browser_extract`,
`browser_find_text`, `browser_search_page`, `browser_find_elements`,
`browser_inspect_element`, `browser_dropdown_options`, `browser_computed_style`,
`browser_page_next`, `browser_get_html`, `browser_search_network_log`,
`browser_challenge`, `browser_doctor`, `server_health`.

Refs (`e5` / `ref:e5`), indexes, and coordinates are observation-bound. Refresh
them after navigation or DOM changes. Snapshot refs are page/frame/revision-bound.

## Navigation and interaction

`browser_navigate`, `browser_back`, `browser_forward`,
`browser_reload`, `browser_switch_tab`, `browser_close_tab`, `browser_click`,
`browser_input`, `browser_select`, `browser_scroll`, `browser_scroll_to_bottom`,
`browser_key`, `browser_wait`, `browser_wait_for_element`,
`browser_wait_for_text`, `browser_wait_for_url`, `browser_wait_for_network_idle`,
`browser_hover`, `browser_move`, `browser_press_and_hold`, `browser_close`.

Also: `browser_upload`, `browser_screenshot`, `browser_pdf`, `browser_downloads`,
`browser_evaluate`, `browser_batch`, `browser_dialog`,
`browser_cookies`, `browser_storage`, `browser_network_log`,
`browser_console_log`, `browser_resource_blocking`, `browser_solve_challenge`,
`browser_wait_for_human`, `web_search`, `browser_close_session`.

`includeSnapshot=true` on a mutation returns one trailing snapshot. Destructive
batches require `confirmDestructive=true`. `browser_batch` accepts validated JSON
actions only.

## Envelope

Success and error results set `content[0].text` to the JSON of `structuredContent`
(non-objects wrapped as `{ value }`). Errors are
`{ ok: false, error: { code, message, retryable, details?, recovery? } }`.
Truncation flags are explicit. Screenshot bytes travel as MCP image content,
not inside the JSON record.

## Resources

- `smooth-operator://server/capabilities`
- `smooth-operator://browser/tabs`
- `smooth-operator://browser/page/current`
- `smooth-operator://browser/page/{pageId}`
- `smooth-operator://browser/downloads`
- `smooth-operator://browser/logs/network`
- `smooth-operator://browser/logs/console`

## Prompts

`agent-chrome-setup`, `browser-workflow`, `extract-page`, `research-question`.
