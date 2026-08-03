/**
 * shared.ts — DOM helpers shared by options.ts and sidepanel.ts.
 *
 * Keeping these in one module avoids two divergent copies and lets both pages
 * use the same `$` (throw on missing) + `escapeHtml` semantics. Also re-exports
 * the canonical `redactKeyLeak` secret-masking primitive (which lives in
 * `lib/agent/redact-shared.ts` so the agent engine never imports the UI layer)
 * and registers the provider-catalog key prefixes it masks with.
 */

import { PROVIDER_META } from "./options/providers";
import {
  redactKeyLeak,
  setRedactKeyLeakProviderPatterns,
} from "../lib/agent/redact-shared";

export { redactKeyLeak };

/**
 * Get an element by id, throwing if missing (dev-time safety).
 * Generic param `T` lets callers narrow to e.g. `HTMLInputElement`.
 */
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

/** True if `v` is a non-null, non-array object. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const ESCAPE_RE = /[&<>"'/]/g;

/**
 * Escape user-supplied text for safe interpolation inside `innerHTML`.
 * Replaces the five significant XML characters: & < > " ', plus `/` (so the
 * output can never prematurely close an attribute or inject a path). Escaping
 * `/` is harmless in normal text — it renders identically — but closes a
 * latent cross-context injection hole.
 */
export function escapeHtml(s: unknown): string {
  if (s == null) return "";
  return String(s)
    .replace(/[\u0000]/g, "")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(
      ESCAPE_RE,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
          "/": "&#47;",
        })[c]!,
    );
}

// ─── Secret redaction ─────────────────────────────────────────────────────
//
// A provider error string can embed the user's API key (e.g. `401: Invalid
// API key: sk-ant-api03-...`). The same key-masking primitive is reused by the
// options test-connection path AND the live side-panel log / thinking renderers
// so a provider error surfaced through the agent loop is never shown verbatim.
// The primitive itself lives in `lib/agent/redact-shared.ts`; this module only
// derives the provider-catalog key prefixes and registers them with it.

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Derive concrete key prefixes from provider placeholders (e.g. `sk-ant-api03-...` → `sk-ant-`). */
function providerKeyPrefixes(): string[] {
  const out = new Set<string>();
  for (const p of Object.values(PROVIDER_META)) {
    const ph = p.keyPlaceholder;
    if (!ph || ph === "...") continue;
    const m = /^[A-Za-z0-9_-]+/.exec(ph);
    if (!m) continue;
    const prefix = m[0];
    // Skip obviously non-secret placeholders (provider labels, not keys).
    if (prefix === "ollama" || prefix === "your-opencode-key") continue;
    out.add(escapeRegex(prefix) + "[A-Za-z0-9_-]+");
  }
  return [...out];
}

setRedactKeyLeakProviderPatterns(providerKeyPrefixes());
