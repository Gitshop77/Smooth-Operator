/**
 * content-main.ts — MAIN-world content script entry (manifest `world: "MAIN"`).
 *
 * Installs the shadow-DOM piercer into the page at document_start, before any
 * page script can remove it. Runs in the MAIN world so it survives the page's
 * own DOM handling; the isolated-world `content.ts` script coordinates with it
 * through the custom `open-cowork-piercer` event.
 *
 * Also installs the console capture here so `window.console` IS the page's
 * real console — the captured calls are relayed to the isolated world via the
 * `open-cowork-console-log` event, which `content.ts` forwards to the SW ring.
 */

import { installShadowPiercer } from "@/lib/agent/dom/annotation/shadow-piercer";
import { installConsoleCapture } from "@/lib/agent/dom/console-capture";

installShadowPiercer({ tagExisting: true });
installConsoleCapture();
