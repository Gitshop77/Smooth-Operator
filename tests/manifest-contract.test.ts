/**
 * Extension-shell contract tests — the manifest, HTML meta-CSP, and entry
 * shims are asserted nowhere else in the suite. These tests pin:
 *
 * - manifest.json parses, is MV3, and its permission set matches the
 *   reviewed baseline (PERMISSIONS.md)
 * - every icon reference resolves to a real file
 * - the meta CSP on options.html and sidepanel.html keeps `wasm-unsafe-eval`
 *   (the manifest grants it; a meta CSP is enforced on extension pages, so
 *   dropping it there would disable the vision WASM fallback)
 * - the esbuild entry shims resolve to their index modules
 * - the MAIN-world content script (content-main.js) is declared with
 *   `world: "MAIN"` + `run_at: "document_start"` and the source file exists
 */

import { describe, test, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const EXT = path.join(process.cwd(), "src/extension");
const read = (rel: string): string => readFileSync(path.join(EXT, rel), "utf8");

/** Reviewed permission baseline — mirrors PERMISSIONS.md. */
const BASELINE_PERMISSIONS = [
  "sidePanel",
  "scripting",
  "tabs",
  "activeTab",
  "storage",
  "alarms",
  "debugger",
  "nativeMessaging",
  "notifications",
  "downloads",
  "unlimitedStorage",
  "power",
  "webRequest",
  "cookies",
] as const;

const BASELINE_HOST_PERMISSIONS = ["http://*/*", "https://*/*"] as const;

interface Manifest {
  manifest_version: number;
  permissions: string[];
  host_permissions: string[];
  content_security_policy: { extension_pages: string };
  content_scripts?: Array<{
    matches: string[];
    js: string[];
    run_at: string;
    world?: string;
  }>;
  icons: Record<string, string>;
  action?: { default_icon: Record<string, string> };
  side_panel: { default_path: string };
  options_ui: { page: string };
  background: { service_worker: string };
}

let manifest: Manifest;

describe("manifest contract", () => {
  beforeAll(() => {
    manifest = JSON.parse(read("manifest.json")) as Manifest;
  });

  test("is Manifest V3", () => {
    expect(manifest.manifest_version).toBe(3);
  });

  test("permission set matches the reviewed baseline (PERMISSIONS.md)", () => {
    expect([...manifest.permissions].sort()).toEqual([...BASELINE_PERMISSIONS].sort());
    // chrome.dns is officially Dev-channel-only. Stable packaged candidates
    // must not request it or claim that the permission enables full DNS
    // rebinding validation.
    expect(manifest.permissions).not.toContain("dns");
  });

  test("host permissions match the reviewed baseline", () => {
    expect([...manifest.host_permissions].sort()).toEqual(
      [...BASELINE_HOST_PERMISSIONS].sort(),
    );
  });

  test("extension_pages CSP keeps 'wasm-unsafe-eval' for the vision WASM fallback", () => {
    expect(manifest.content_security_policy.extension_pages).toContain("'wasm-unsafe-eval'");
    expect(manifest.content_security_policy.extension_pages).toContain("script-src 'self'");
  });

  test("extension_pages CSP permits configured direct-provider transports", () => {
    const policy = manifest.content_security_policy.extension_pages;
    expect(policy).toContain("connect-src");
    expect(policy).toContain("http:");
    expect(policy).toContain("https:");
    expect(policy).toContain("ws:");
    expect(policy).toContain("wss:");
  });

  test("every referenced icon file exists on disk", () => {
    const refs = [
      ...Object.values(manifest.icons),
      ...Object.values(manifest.action?.default_icon ?? {}),
    ];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(existsSync(`${EXT}/${ref}`), `missing icon ${ref}`).toBe(true);
    }
    // Notification iconUrl (background/task-queue.ts) — also copied by the build.
    expect(existsSync(`${EXT}/icons/icon.png`)).toBe(true);
  });

  test("shell pages and service worker are wired", () => {
    expect(manifest.side_panel.default_path).toBe("sidepanel.html");
    expect(manifest.options_ui.page).toBe("options.html");
    expect(manifest.background.service_worker).toBe("background.js");
  });

  test("entry shims resolve to their index modules", () => {
    expect(read("background.ts")).toContain('import "./background/index";');
    expect(read("options.ts")).toContain('import "./options/index";');
    expect(read("sidepanel.ts")).toContain('import "./sidepanel/index";');
  });

  test("MAIN-world shadow-piercer content script is declared for all pages at document_start", () => {
    expect(manifest.content_scripts).toHaveLength(1);
    const cs = manifest.content_scripts![0];
    expect([...cs.matches].sort()).toEqual([...BASELINE_HOST_PERMISSIONS].sort());
    expect(cs.js).toEqual(["content-main.js"]);
    expect(cs.run_at).toBe("document_start");
    expect(cs.world).toBe("MAIN");
  });

  test("content-main.ts exists and installs the piercer from the canonical module", () => {
    const src = read("content-main.ts");
    expect(src).toContain('installShadowPiercer');
    expect(src).toContain('@/lib/agent/dom/annotation/shadow-piercer');
  });
});

describe("meta CSP on extension pages", () => {
  test("options.html meta script-src keeps 'wasm-unsafe-eval'", () => {
    const csp = read("options.html").match(
      /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/,
    );
    expect(csp).not.toBeNull();
    expect(csp![1]).toContain("script-src 'self' 'wasm-unsafe-eval'");
  });

  test("sidepanel.html meta script-src keeps 'wasm-unsafe-eval'", () => {
    const csp = read("sidepanel.html").match(
      /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/,
    );
    expect(csp).not.toBeNull();
    expect(csp![1]).toContain("script-src 'self' 'wasm-unsafe-eval'");
  });

  test("Options declares its direct-provider connect policy explicitly", () => {
    const csp = read("options.html").match(
      /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/,
    );
    expect(csp).not.toBeNull();
    // This is a characterization, not an endorsement of broad direct network
    // access. Replacing the current policy with a browser-valid,
    // reviewed provider/loopback policy. Until then, do not let a markup edit
    // silently delete the only declared connection boundary.
    expect(csp![1]).toContain("connect-src");
    expect(csp![1]).toContain("https://*");
    expect(csp![1]).toContain("http://localhost:*");
    expect(csp![1]).toContain("http://127.0.0.1:*");
  });

  test("Options CSP excludes Chromium's invalid IPv6 wildcard source", () => {
    const csp = read("options.html").match(
      /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/,
    );
    expect(csp).not.toBeNull();
    // Chromium rejects this IPv6 wildcard source in extension-page CSP. Keep
    // the valid localhost/IPv4 loopback policy above and never reintroduce it
    // as a false local-provider compatibility claim.
    expect(csp![1]).not.toContain("http://[::1]:*");
  });
});
