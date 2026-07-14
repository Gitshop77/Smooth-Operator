// Returns the full catalog of MCP tools.
import type { NextRequest } from 'next/server';
import { json, withRouteError } from '@/lib/cowork/api/http';

export async function GET(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    const q = (req.nextUrl.searchParams.get('q') || '').trim();
    const category = (req.nextUrl.searchParams.get('category') || '').trim();

 // The cockpit does NOT implement any of these tools yet — this is a
 // forward-looking contract only. Mark every entry `implemented: false`
 // and attach a top-level note so a consuming LLM knows NOT to call them.
    const ql = q.toLowerCase();
    const cl = category.toLowerCase();
    const tools = CATALOG.filter((t) => {
      const name = t.name.toLowerCase();
      const desc = t.description.toLowerCase();
      const mq = !ql || name.includes(ql) || desc.includes(ql);
      const mc = !cl || t.category.toLowerCase() === cl;
      return mq && mc;
    });
    return json({
      description: 'MCP tool catalog — ASPIRATIONAL, not implemented by the cockpit.',
      note: 'None of these tools are served by the cockpit yet. This catalog is published as a forward-looking contract only. Do not invoke these tools against the cockpit; they will return 404 or 501.',
      tools,
      total: tools.length,
      totalCatalog: CATALOG.length,
    });
  });
}

interface ToolEntry {
  name: string;
  category: string;
  description: string;
  readOnly: boolean;
  /** Whether the cockpit actually serves this tool. Always false today. */
  implemented?: boolean;
}

// Static catalog of the MCP tools exposed by the cockpit.
const MCP_TOOL_CATALOG: ToolEntry[] = [
 // agent-trust (3)
  { name: 'agent_trust_list', category: 'agent-trust', description: 'List all agent trust grants and their current scopes', readOnly: true },
  { name: 'agent_trust_grant', category: 'agent-trust', description: 'Grant a trust window (domain or global) to an agent', readOnly: false },
  { name: 'agent_trust_revoke', category: 'agent-trust', description: 'Revoke a previously granted trust window', readOnly: false },
 // auth (6)
  { name: 'auth_state_get', category: 'auth', description: 'Get the authentication state for the current session', readOnly: true },
  { name: 'auth_login', category: 'auth', description: 'Attempt a login on the current page using provided credentials', readOnly: false },
  { name: 'auth_logout', category: 'auth', description: 'Log out of the current site by clearing session cookies', readOnly: false },
  { name: 'auth_credentials_get', category: 'auth', description: 'Retrieve stored credentials for the current domain', readOnly: true },
  { name: 'auth_cookies_get', category: 'auth', description: 'Get all cookies for the current session', readOnly: true },
  { name: 'auth_cookies_clear', category: 'auth', description: 'Clear all cookies for the current session', readOnly: false },
 // awareness (2)
  { name: 'awareness_digest', category: 'awareness', description: 'Get an activity digest summarizing recent user actions', readOnly: true },
  { name: 'awareness_focus', category: 'awareness', description: 'Get real-time focus detection — what the user is currently doing', readOnly: true },
 // bookmarks (8)
  { name: 'bookmarks_list', category: 'bookmarks', description: 'List all bookmarks as a flat array', readOnly: true },
  { name: 'bookmarks_tree', category: 'bookmarks', description: 'List bookmarks as a nested folder tree', readOnly: true },
  { name: 'bookmarks_add', category: 'bookmarks', description: 'Add a new bookmark', readOnly: false },
  { name: 'bookmarks_add_folder', category: 'bookmarks', description: 'Add a new bookmark folder', readOnly: false },
  { name: 'bookmarks_remove', category: 'bookmarks', description: 'Remove a bookmark or folder by id', readOnly: false },
  { name: 'bookmarks_update', category: 'bookmarks', description: 'Update a bookmark name or URL', readOnly: false },
  { name: 'bookmarks_move', category: 'bookmarks', description: 'Move a bookmark to a different parent folder', readOnly: false },
  { name: 'bookmarks_search', category: 'bookmarks', description: 'Search bookmarks by name or URL', readOnly: true },
 // chat (8)
  { name: 'chat_send', category: 'chat', description: 'Send a message to the wingman chat panel', readOnly: false },
  { name: 'chat_history', category: 'chat', description: 'Get recent chat messages from the wingman panel', readOnly: true },
  { name: 'chat_clear', category: 'chat', description: 'Clear the wingman chat history', readOnly: false },
  { name: 'chat_inject', category: 'chat', description: 'Inject a message into the chat panel without user echo', readOnly: false },
  { name: 'chat_typing', category: 'chat', description: 'Show or hide a typing indicator in the chat panel', readOnly: false },
  { name: 'chat_set_mode', category: 'chat', description: 'Set the chat mode (agent/manual/preview)', readOnly: false },
  { name: 'chat_get_mode', category: 'chat', description: 'Get the current chat mode', readOnly: true },
  { name: 'chat_stream', category: 'chat', description: 'Stream a long response into the chat panel token-by-token', readOnly: false },
 // clipboard (3)
  { name: 'clipboard_read', category: 'clipboard', description: 'Read the current system clipboard contents', readOnly: true },
  { name: 'clipboard_write_text', category: 'clipboard', description: 'Write text to the system clipboard', readOnly: false },
  { name: 'clipboard_write_image', category: 'clipboard', description: 'Write an image (base64 PNG) to the system clipboard', readOnly: false },
 // content (8)
  { name: 'content_extract', category: 'content', description: 'Extract structured content from the current page (article/product/profile)', readOnly: true },
  { name: 'content_extract_url', category: 'content', description: 'Extract structured content from a URL via headless fetch', readOnly: true },
  { name: 'content_get_html', category: 'content', description: 'Get the full HTML of the current page', readOnly: true },
  { name: 'content_get_text', category: 'content', description: 'Get the visible text content of the current page', readOnly: true },
  { name: 'content_get_markdown', category: 'content', description: 'Get the page content as Markdown', readOnly: true },
  { name: 'content_get_links', category: 'content', description: 'Get all links on the current page', readOnly: true },
  { name: 'content_get_forms', category: 'content', description: 'Get all forms on the current page with their fields', readOnly: true },
  { name: 'content_get_metadata', category: 'content', description: 'Get page metadata (title, description, OG tags, JSON-LD)', readOnly: true },
 // context (5)
  { name: 'context_recent', category: 'context', description: 'Get recent context-bridge entries (pages visited + notes)', readOnly: true },
  { name: 'context_search', category: 'context', description: 'Search the context bridge by keyword', readOnly: true },
  { name: 'context_get_page', category: 'context', description: 'Get a stored context-bridge page by URL', readOnly: true },
  { name: 'context_summary', category: 'context', description: 'Get a rolling summary of recent browsing context', readOnly: true },
  { name: 'context_add_note', category: 'context', description: 'Add a user note to a visited page in the context bridge', readOnly: false },
 // data (16)
  { name: 'data_export_all', category: 'data', description: 'Export all Cowork data (tabs, bookmarks, history, etc.) as a ZIP', readOnly: true },
  { name: 'data_import', category: 'data', description: 'Import a previously exported Cowork data ZIP', readOnly: false },
  { name: 'data_export_bookmarks', category: 'data', description: 'Export bookmarks as HTML (Netscape format)', readOnly: true },
  { name: 'data_import_bookmarks', category: 'data', description: 'Import bookmarks from HTML', readOnly: false },
  { name: 'data_export_history', category: 'data', description: 'Export history as JSON', readOnly: true },
  { name: 'data_import_history', category: 'data', description: 'Import history from JSON', readOnly: false },
  { name: 'data_export_cookies', category: 'data', description: 'Export cookies for a session as JSON', readOnly: true },
  { name: 'data_import_cookies', category: 'data', description: 'Import cookies from JSON into a session', readOnly: false },
  { name: 'data_export_config', category: 'data', description: 'Export the Cowork config as JSON', readOnly: true },
  { name: 'data_import_config', category: 'data', description: 'Import a Cowork config JSON', readOnly: false },
  { name: 'data_browser_status', category: 'data', description: 'Get the overall browser status (uptime, tab count, memory)', readOnly: true },
  { name: 'data_clear_cache', category: 'data', description: 'Clear the browser cache for a session', readOnly: false },
  { name: 'data_clear_storage', category: 'data', description: 'Clear local storage, session storage, and IndexedDB for a tab', readOnly: false },
  { name: 'data_reset', category: 'data', description: 'Factory-reset the Cowork profile (destructive)', readOnly: false },
 // devices (4)
  { name: 'device_emulate', category: 'devices', description: 'Emulate a device (iPhone, iPad, etc.) on the current tab', readOnly: false },
  { name: 'device_emulate_custom', category: 'devices', description: 'Emulate a custom viewport and user agent', readOnly: false },
  { name: 'device_reset', category: 'devices', description: 'Reset device emulation on the current tab', readOnly: false },
  { name: 'device_list', category: 'devices', description: 'List available device presets', readOnly: true },
 // devtools (15)
  { name: 'devtools_console_get', category: 'devtools', description: 'Get console logs for a tab', readOnly: true },
  { name: 'devtools_console_clear', category: 'devtools', description: 'Clear console logs for a tab', readOnly: false },
  { name: 'devtools_network_get', category: 'devtools', description: 'Get network requests captured by DevTools', readOnly: true },
  { name: 'devtools_network_clear', category: 'devtools', description: 'Clear the DevTools network log', readOnly: false },
  { name: 'devtools_dom_query', category: 'devtools', description: 'Run a DOM query (querySelector/all) via DevTools', readOnly: true },
  { name: 'devtools_xpath', category: 'devtools', description: 'Run an XPath query via DevTools', readOnly: true },
  { name: 'devtools_evaluate', category: 'devtools', description: 'Evaluate a JS expression in a tab via DevTools', readOnly: false },
  { name: 'devtools_perf_get', category: 'devtools', description: 'Get performance metrics for a tab', readOnly: true },
  { name: 'devtools_perf_start', category: 'devtools', description: 'Start a performance trace', readOnly: false },
  { name: 'devtools_perf_stop', category: 'devtools', description: 'Stop a performance trace and return the recording', readOnly: false },
  { name: 'devtools_storage_get', category: 'devtools', description: 'Get local/session storage entries for a tab', readOnly: true },
  { name: 'devtools_storage_set', category: 'devtools', description: 'Set a local/session storage entry', readOnly: false },
  { name: 'devtools_storage_clear', category: 'devtools', description: 'Clear local/session storage for a tab', readOnly: false },
  { name: 'devtools_cdp_raw', category: 'devtools', description: 'Send a raw CDP (Chrome DevTools Protocol) command', readOnly: false },
  { name: 'devtools_screenshot_element', category: 'devtools', description: 'Screenshot a specific element by selector', readOnly: true },
 // events (5)
  { name: 'events_recent', category: 'events', description: 'Get recent browser events (tabs, navigations, downloads, etc.)', readOnly: true },
  { name: 'events_subscribe', category: 'events', description: 'Subscribe to a stream of browser events (SSE)', readOnly: true },
  { name: 'events_unsubscribe', category: 'events', description: 'Unsubscribe from an event stream', readOnly: false },
  { name: 'events_filter', category: 'events', description: 'Set a filter on an active event subscription', readOnly: false },
  { name: 'events_replay', category: 'events', description: 'Replay the last N events from the event buffer', readOnly: true },
 // extensions (13)
  { name: 'extensions_list', category: 'extensions', description: 'List all installed extensions', readOnly: true },
  { name: 'extensions_load', category: 'extensions', description: 'Load an unpacked extension from a directory', readOnly: false },
  { name: 'extensions_install', category: 'extensions', description: 'Install an extension from a .crx or .zip file', readOnly: false },
  { name: 'extensions_uninstall', category: 'extensions', description: 'Uninstall an extension by id', readOnly: false },
  { name: 'extensions_enable', category: 'extensions', description: 'Enable a disabled extension', readOnly: false },
  { name: 'extensions_disable', category: 'extensions', description: 'Disable an enabled extension', readOnly: false },
  { name: 'extensions_reload', category: 'extensions', description: 'Reload an extension (useful after editing its code)', readOnly: false },
  { name: 'extensions_get_manifest', category: 'extensions', description: 'Get the manifest.json of an extension', readOnly: true },
  { name: 'extensions_chrome_import', category: 'extensions', description: 'Import extensions from the local Chrome installation', readOnly: false },
  { name: 'extensions_gallery', category: 'extensions', description: 'List extensions in the Cowork extension gallery', readOnly: true },
  { name: 'extensions_check_updates', category: 'extensions', description: 'Check for extension updates', readOnly: true },
  { name: 'extensions_update', category: 'extensions', description: 'Update a specific extension to the latest version', readOnly: false },
  { name: 'extensions_conflicts', category: 'extensions', description: 'List conflicts between installed extensions', readOnly: true },
 // forms (3)
  { name: 'forms_fill', category: 'forms', description: 'Fill a form on the current page with provided data', readOnly: false },
  { name: 'forms_submit', category: 'forms', description: 'Submit a form by selector or index', readOnly: false },
  { name: 'forms_remember', category: 'forms', description: 'Save the current form data to form memory for the domain', readOnly: false },
 // handoffs (9)
  { name: 'handoff_create', category: 'handoffs', description: 'Create a handoff back to the human user', readOnly: false },
  { name: 'handoff_list', category: 'handoffs', description: 'List active handoffs awaiting human action', readOnly: true },
  { name: 'handoff_get', category: 'handoffs', description: 'Get a handoff by id', readOnly: true },
  { name: 'handoff_resolve', category: 'handoffs', description: 'Resolve a handoff (mark as completed by the human)', readOnly: false },
  { name: 'handoff_cancel', category: 'handoffs', description: 'Cancel a handoff', readOnly: false },
  { name: 'handoff_add_note', category: 'handoffs', description: 'Add a note to an existing handoff', readOnly: false },
  { name: 'handoff_attach_screenshot', category: 'handoffs', description: 'Attach a screenshot to a handoff', readOnly: false },
  { name: 'handoff_set_priority', category: 'handoffs', description: 'Set the priority of a handoff (low/normal/high/urgent)', readOnly: false },
  { name: 'handoff_assign', category: 'handoffs', description: 'Assign a handoff to a specific agent', readOnly: false },
 // headless (6)
  { name: 'headless_open', category: 'headless', description: 'Open a new headless browser session', readOnly: false },
  { name: 'headless_close', category: 'headless', description: 'Close a headless browser session', readOnly: false },
  { name: 'headless_navigate', category: 'headless', description: 'Navigate a headless session to a URL', readOnly: false },
  { name: 'headless_evaluate', category: 'headless', description: 'Evaluate JS in a headless session', readOnly: false },
  { name: 'headless_screenshot', category: 'headless', description: 'Take a screenshot in a headless session', readOnly: true },
  { name: 'headless_extract', category: 'headless', description: 'Extract structured content from a headless session', readOnly: true },
 // history (8)
  { name: 'history_list', category: 'history', description: 'List recent history entries', readOnly: true },
  { name: 'history_search', category: 'history', description: 'Search history by keyword', readOnly: true },
  { name: 'history_get', category: 'history', description: 'Get a single history entry by id', readOnly: true },
  { name: 'history_add', category: 'history', description: 'Manually add a history entry', readOnly: false },
  { name: 'history_remove', category: 'history', description: 'Remove a history entry by id', readOnly: false },
  { name: 'history_clear', category: 'history', description: 'Clear all history', readOnly: false },
  { name: 'history_clear_range', category: 'history', description: 'Clear history in a date range', readOnly: false },
  { name: 'history_count', category: 'history', description: 'Get the total history count', readOnly: true },
 // media (16)
  { name: 'media_voice_start', category: 'media', description: 'Start voice input via Web Speech API', readOnly: false },
  { name: 'media_voice_stop', category: 'media', description: 'Stop voice input', readOnly: false },
  { name: 'media_voice_status', category: 'media', description: 'Get voice input status', readOnly: true },
  { name: 'media_audio_record_start', category: 'media', description: 'Start audio recording', readOnly: false },
  { name: 'media_audio_record_stop', category: 'media', description: 'Stop audio recording and return the file', readOnly: true },
  { name: 'media_audio_play', category: 'media', description: 'Play an audio file in the browser', readOnly: false },
  { name: 'media_audio_stop', category: 'media', description: 'Stop audio playback', readOnly: false },
  { name: 'media_screenshot', category: 'media', description: 'Take a screenshot of the current tab', readOnly: true },
  { name: 'media_screenshot_full', category: 'media', description: 'Take a full-page screenshot', readOnly: true },
  { name: 'media_screenshot_region', category: 'media', description: 'Take a screenshot of a specific region', readOnly: true },
  { name: 'media_screenshot_annotated', category: 'media', description: 'Take a screenshot with annotations', readOnly: true },
  { name: 'media_panel_show', category: 'media', description: 'Show the wingman panel', readOnly: false },
  { name: 'media_panel_hide', category: 'media', description: 'Hide the wingman panel', readOnly: false },
  { name: 'media_panel_toggle', category: 'media', description: 'Toggle the wingman panel', readOnly: false },
  { name: 'media_stream_start', category: 'media', description: 'Start a media stream (screen share or camera)', readOnly: false },
  { name: 'media_stream_stop', category: 'media', description: 'Stop a media stream', readOnly: false },
 // navigation (10)
  { name: 'navigate', category: 'navigation', description: 'Navigate the active tab to a URL', readOnly: false },
  { name: 'navigate_back', category: 'navigation', description: 'Go back in history', readOnly: false },
  { name: 'navigate_forward', category: 'navigation', description: 'Go forward in history', readOnly: false },
  { name: 'navigate_reload', category: 'navigation', description: 'Reload the current page', readOnly: false },
  { name: 'navigate_stop', category: 'navigation', description: 'Stop loading the current page', readOnly: false },
  { name: 'click', category: 'navigation', description: 'Click an element by selector or snapshot ref', readOnly: false },
  { name: 'type', category: 'navigation', description: 'Type text into a focused or specified element', readOnly: false },
  { name: 'scroll', category: 'navigation', description: 'Scroll the page or a specific element', readOnly: false },
  { name: 'press_key', category: 'navigation', description: 'Press a keyboard key', readOnly: false },
  { name: 'wait', category: 'navigation', description: 'Wait for a condition (selector, load, or fixed delay)', readOnly: true },
 // network (9)
  { name: 'network_list', category: 'network', description: 'List recent network requests', readOnly: true },
  { name: 'network_get', category: 'network', description: 'Get details of a specific network request', readOnly: true },
  { name: 'network_search', category: 'network', description: 'Search network requests by URL or method', readOnly: true },
  { name: 'network_api_discover', category: 'network', description: 'Discover API endpoints called by the current page', readOnly: true },
  { name: 'network_har_export', category: 'network', description: 'Export the network log as a HAR file', readOnly: true },
  { name: 'network_mock_add', category: 'network', description: 'Add a network request mock', readOnly: false },
  { name: 'network_mock_remove', category: 'network', description: 'Remove a network request mock', readOnly: false },
  { name: 'network_mock_list', category: 'network', description: 'List active network mocks', readOnly: true },
  { name: 'network_block', category: 'network', description: 'Block network requests matching a pattern', readOnly: false },
 // pinboards (10)
  { name: 'pinboards_list', category: 'pinboards', description: 'List all pinboards', readOnly: true },
  { name: 'pinboards_create', category: 'pinboards', description: 'Create a new pinboard', readOnly: false },
  { name: 'pinboards_delete', category: 'pinboards', description: 'Delete a pinboard', readOnly: false },
  { name: 'pinboards_rename', category: 'pinboards', description: 'Rename a pinboard', readOnly: false },
  { name: 'pinboards_add_item', category: 'pinboards', description: 'Add a tab or URL to a pinboard', readOnly: false },
  { name: 'pinboards_remove_item', category: 'pinboards', description: 'Remove an item from a pinboard', readOnly: false },
  { name: 'pinboards_list_items', category: 'pinboards', description: 'List items in a pinboard', readOnly: true },
  { name: 'pinboards_open_all', category: 'pinboards', description: 'Open all items in a pinboard as tabs', readOnly: false },
  { name: 'pinboards_move_item', category: 'pinboards', description: 'Move an item to a different pinboard', readOnly: false },
  { name: 'pinboards_clear', category: 'pinboards', description: 'Clear all items from a pinboard', readOnly: false },
 // previews (4)
  { name: 'preview_create', category: 'previews', description: 'Create a live HTML preview page in the browser', readOnly: false },
  { name: 'preview_update', category: 'previews', description: 'Update the HTML of an existing preview page', readOnly: false },
  { name: 'preview_close', category: 'previews', description: 'Close a preview page', readOnly: false },
  { name: 'preview_list', category: 'previews', description: 'List all open preview pages', readOnly: true },
 // scripts (10)
  { name: 'scripts_list', category: 'scripts', description: 'List all registered user scripts', readOnly: true },
  { name: 'scripts_add', category: 'scripts', description: 'Register a new user script', readOnly: false },
  { name: 'scripts_remove', category: 'scripts', description: 'Remove a user script', readOnly: false },
  { name: 'scripts_enable', category: 'scripts', description: 'Enable a user script', readOnly: false },
  { name: 'scripts_disable', category: 'scripts', description: 'Disable a user script', readOnly: false },
  { name: 'scripts_styles_list', category: 'scripts', description: 'List all registered user styles', readOnly: true },
  { name: 'scripts_styles_add', category: 'scripts', description: 'Register a new user style (CSS)', readOnly: false },
  { name: 'scripts_styles_remove', category: 'scripts', description: 'Remove a user style', readOnly: false },
  { name: 'scripts_styles_enable', category: 'scripts', description: 'Enable a user style', readOnly: false },
  { name: 'scripts_styles_disable', category: 'scripts', description: 'Disable a user style', readOnly: false },
 // sessions (8)
  { name: 'sessions_list', category: 'sessions', description: 'List all isolated browser sessions', readOnly: true },
  { name: 'sessions_create', category: 'sessions', description: 'Create a new isolated session', readOnly: false },
  { name: 'sessions_delete', category: 'sessions', description: 'Delete a session (clears its cookies and storage)', readOnly: false },
  { name: 'sessions_switch', category: 'sessions', description: 'Switch the active tab to a different session', readOnly: false },
  { name: 'sessions_get', category: 'sessions', description: 'Get details of a session', readOnly: true },
  { name: 'sessions_clone', category: 'sessions', description: 'Clone a session (copy cookies to a new partition)', readOnly: false },
  { name: 'sessions_fetch', category: 'sessions', description: 'Fetch a URL using a session cookie jar', readOnly: true },
  { name: 'sessions_export', category: 'sessions', description: 'Export a session cookies and storage as JSON', readOnly: true },
 // sidebar (6)
  { name: 'sidebar_show', category: 'sidebar', description: 'Show the sidebar', readOnly: false },
  { name: 'sidebar_hide', category: 'sidebar', description: 'Hide the sidebar', readOnly: false },
  { name: 'sidebar_toggle', category: 'sidebar', description: 'Toggle the sidebar', readOnly: false },
  { name: 'sidebar_set_view', category: 'sidebar', description: 'Set the active sidebar view', readOnly: false },
  { name: 'sidebar_get_view', category: 'sidebar', description: 'Get the active sidebar view', readOnly: true },
  { name: 'sidebar_configure', category: 'sidebar', description: 'Configure sidebar panels and order', readOnly: false },
 // snapshots (8)
  { name: 'snapshot_get', category: 'snapshots', description: 'Get the accessibility snapshot of a tab', readOnly: true },
  { name: 'snapshot_click', category: 'snapshots', description: 'Click an element by snapshot ref (@eN)', readOnly: false },
  { name: 'snapshot_fill', category: 'snapshots', description: 'Fill an element by snapshot ref', readOnly: false },
  { name: 'snapshot_text', category: 'snapshots', description: 'Get text of an element by snapshot ref', readOnly: true },
  { name: 'snapshot_find', category: 'snapshots', description: 'Find elements in the snapshot by role/text/label', readOnly: true },
  { name: 'snapshot_find_click', category: 'snapshots', description: 'Find and click an element in one call', readOnly: false },
  { name: 'snapshot_find_fill', category: 'snapshots', description: 'Find and fill an element in one call', readOnly: false },
  { name: 'snapshot_find_all', category: 'snapshots', description: 'Find all matching elements in the snapshot', readOnly: true },
 // system (6)
  { name: 'system_status', category: 'system', description: 'Get the overall browser system status', readOnly: true },
  { name: 'system_headless_mode', category: 'system', description: 'Toggle or set headless mode', readOnly: false },
  { name: 'system_google_photos', category: 'system', description: 'Upload a screenshot to Google Photos', readOnly: false },
  { name: 'system_security_overrides', category: 'system', description: 'List or set security overrides', readOnly: false },
  { name: 'system_restart', category: 'system', description: 'Restart the browser', readOnly: false },
  { name: 'system_quit', category: 'system', description: 'Quit the browser', readOnly: false },
 // tabs (7)
  { name: 'tabs_list', category: 'tabs', description: 'List all open tabs', readOnly: true },
  { name: 'tabs_open', category: 'tabs', description: 'Open a new tab with a URL', readOnly: false },
  { name: 'tabs_close', category: 'tabs', description: 'Close a tab by id', readOnly: false },
  { name: 'tabs_focus', category: 'tabs', description: 'Focus a tab by id', readOnly: false },
  { name: 'tabs_reload', category: 'tabs', description: 'Reload a tab', readOnly: false },
  { name: 'tabs_get', category: 'tabs', description: 'Get details of a specific tab', readOnly: true },
  { name: 'tabs_set_emoji', category: 'tabs', description: 'Set an emoji badge on a tab', readOnly: false },
 // tasks (14)
  { name: 'tasks_list', category: 'tasks', description: 'List all agent tasks', readOnly: true },
  { name: 'tasks_get', category: 'tasks', description: 'Get a task by id', readOnly: true },
  { name: 'tasks_create', category: 'tasks', description: 'Create a new multi-step task', readOnly: false },
  { name: 'tasks_cancel', category: 'tasks', description: 'Cancel a running task', readOnly: false },
  { name: 'tasks_approve', category: 'tasks', description: 'Approve a task step awaiting human approval', readOnly: false },
  { name: 'tasks_reject', category: 'tasks', description: 'Reject a task step awaiting human approval', readOnly: false },
  { name: 'tasks_mark_running', category: 'tasks', description: 'Mark a task as running', readOnly: false },
  { name: 'tasks_mark_done', category: 'tasks', description: 'Mark a task as completed', readOnly: false },
  { name: 'tasks_mark_failed', category: 'tasks', description: 'Mark a task as failed', readOnly: false },
  { name: 'tasks_step_update', category: 'tasks', description: 'Update the status of a task step', readOnly: false },
  { name: 'tasks_emergency_stop', category: 'tasks', description: 'Emergency-stop all running tasks', readOnly: false },
  { name: 'tasks_autonomy_get', category: 'tasks', description: 'Get the current autonomy settings', readOnly: true },
  { name: 'tasks_autonomy_set', category: 'tasks', description: 'Update the autonomy settings', readOnly: false },
  { name: 'tasks_activity_log', category: 'tasks', description: 'Get the agent activity log', readOnly: true },
 // watches (4)
  { name: 'watches_list', category: 'watches', description: 'List all active page watches', readOnly: true },
  { name: 'watches_add', category: 'watches', description: 'Add a new page watch (URL + selector + interval)', readOnly: false },
  { name: 'watches_remove', category: 'watches', description: 'Remove a page watch', readOnly: false },
  { name: 'watches_check', category: 'watches', description: 'Manually trigger a watch check', readOnly: false },
 // window (1)
  { name: 'window_research', category: 'window', description: 'Open an autonomous research window for a query', readOnly: false },
 // workflows (7)
  { name: 'workflows_list', category: 'workflows', description: 'List all workflows', readOnly: true },
  { name: 'workflows_get', category: 'workflows', description: 'Get a workflow by id', readOnly: true },
  { name: 'workflows_create', category: 'workflows', description: 'Create a new workflow', readOnly: false },
  { name: 'workflows_update', category: 'workflows', description: 'Update a workflow', readOnly: false },
  { name: 'workflows_delete', category: 'workflows', description: 'Delete a workflow', readOnly: false },
  { name: 'workflows_run', category: 'workflows', description: 'Run a workflow immediately', readOnly: false },
  { name: 'workflows_history', category: 'workflows', description: 'Get the run history of a workflow', readOnly: true },
 // workspaces (6)
  { name: 'workspaces_list', category: 'workspaces', description: 'List all workspaces', readOnly: true },
  { name: 'workspaces_create', category: 'workspaces', description: 'Create a new workspace', readOnly: false },
  { name: 'workspaces_update', category: 'workspaces', description: 'Update a workspace name/icon/color', readOnly: false },
  { name: 'workspaces_delete', category: 'workspaces', description: 'Delete a workspace', readOnly: false },
  { name: 'workspaces_switch', category: 'workspaces', description: 'Switch to a workspace', readOnly: false },
  { name: 'workspaces_move_tab', category: 'workspaces', description: 'Move a tab to a different workspace', readOnly: false },
];

// The cockpit does NOT implement any of these tools yet — this is a
// forward-looking contract only. Materialize the `implemented: false` flag
// once at module scope rather than rebuilding the catalog on every request.
const CATALOG: ToolEntry[] = MCP_TOOL_CATALOG.map((t) => ({ ...t, implemented: false }));
