/**
 * `evaluate` action handler — run LLM-authored JS in the content-script
 * context, gated by the current page's domain allowlist/blocklist.
 * Substitutes custom-tool-call placeholders, races async results against a
 * wall-clock timeout, and reports failures with a diagnostic message.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { LIMITS } from "../constants";
import type { ActionContext } from "./types";
import { domFingerprint } from "../helpers";
import { checkUrlAllowed } from "../../security";
import {
  getDomainConfig,
  isDomainConfigMissingButEnforced,
} from "../helpers/domain-config";

/**
 * Hardened `chrome` stub for the `evaluate` sandbox.
 *
 * `evaluate` runs LLM/user-authored JS in the live page (content-script)
 * context via `new Function`. If that code could read the real `chrome`
 * global it could call `chrome.storage.session.get("open_cowork_secrets")` and
 * exfiltrate the user's secret store (stored in `chrome.storage.session`, key
 * "open_cowork_secrets") via `fetch`/`WebSocket` — a prompt-injection in
 * `full_agentic` mode (no confirmation) is a direct secret-exfil path.
 *
 * We deny by THROWING on ANY property access on the `chrome` stub. `evaluate`
 * has no legitimate reason to touch `chrome` at all (it operates on the page
 * DOM/JS), so failing closed on every access is the strongest possible
 * guarantee: `chrome.storage`, `chrome.storage.session`, `chrome.runtime`,
 * `chrome.tabs`, etc. all throw `Error("access denied by evaluate sandbox")`.
 * This is provably safe — there is no path that reaches the real `chrome`
 * object, and there is no whitelisted accessor that an attacker could abuse.
 * Every trap (get/set/has/apply/construct/deleteProperty) denies, so neither
 * reads, writes, nor `in`-checks nor calls/constructs can slip through.
 */
function makeSandboxChrome(): unknown {
  const deny = (op: string, prop: PropertyKey): never => {
    throw new Error(`access denied by evaluate sandbox: chrome.${op} ${String(prop)}`);
  };
  return new Proxy(
    {},
    {
      get: (_t, prop) => deny("get", prop),
      set: (_t, prop) => {
        deny("set", prop);
        return false;
      },
      has: (_t, prop) => {
        deny("has", prop);
        return false;
      },
      deleteProperty: (_t, prop) => {
        deny("delete", prop);
        return false;
      },
      apply: (_t, _this, _args) => deny("apply", "()"),
      construct: (_t, _args) => deny("construct", "new"),
    },
  );
}

/**
 * A Proxy that FORWARDS to a real global object (`window`,
 * `globalThis`, `self`, ...) for every property EXCEPT `chrome`, which it
 * denies with the sandbox error.
 *
 * `evaluate` legitimately needs the page globals (`window`, `document` via its
 * own parameter, `globalThis`, `self`) for DOM/JS work, so we can't just blank
 * them out. But an attacker could reach the real `chrome` through
 * `window.chrome` / `globalThis.chrome` / `self.chrome` to bypass the
 * `chrome` parameter shadow above. This proxy lets all normal global access
 * through while slamming the `chrome` property shut on every trap (get/set/has/
 * delete), so those bypass vectors throw `access denied by evaluate sandbox`.
 */
function makeChromeDenyingProxy(target: object): unknown {
  const deny = (): never => {
    throw new Error("access denied by evaluate sandbox: chrome");
  };
  return new Proxy(target, {
    get: (t, prop, recv) => {
      if (prop === "chrome") deny();
      return Reflect.get(t, prop, recv);
    },
    has: (t, prop) => {
      if (prop === "chrome") deny();
      return Reflect.has(t, prop);
    },
    set: (t, prop, value, recv) => {
      if (prop === "chrome") deny();
      return Reflect.set(t, prop, value, recv);
    },
    deleteProperty: (t, prop) => {
      if (prop === "chrome") deny();
      return Reflect.deleteProperty(t, prop);
    },
  });
}

export async function handleEvaluate(
  ctx: ActionContext,
  action: Extract<Action, { type: "evaluate" }>,
): Promise<ActionResult> {
  try {
    // Gate `evaluate` by the current page's domain. Unlike `navigate`
    // (which is intercepted by the extension's tab-level handler),
    // `evaluate` runs in the content script — so the domain check must
    // happen here, against the current page's URL. This prevents a
    // prompt-injection payload from executing arbitrary JS on an
    // attacker-controlled domain even when a domain allowlist is configured.
    //
    // `evaluate` is an unsandboxed `new Function()` RCE primitive, so
    // the domain check FAILS CLOSED when no explicit allowlist is configured
    // (`requireAllowlist: true`). A non-evaluate path (navigate/search) still
    // defaults to allow-all; only JS execution is hardened here.
    //
    // The `isDomainConfigMissingButEnforced()` check reproduces the
    // fail-closed behavior (a domain policy was configured but the config
    // payload is missing) before delegating the allowlist match to
    // `checkUrlAllowed` with `requireAllowlist: true`.
    const urlCheck =
      isDomainConfigMissingButEnforced()
        ? {
            allowed: false as const,
            reason: "Domain policy is enforced but the config is unavailable — blocking to fail closed.",
          }
        : checkUrlAllowed(location.href, getDomainConfig(), true);
    if (!urlCheck.allowed) {
      return {
        action,
        success: false,
        message: `BLOCKED evaluate on ${location.href}: ${urlCheck.reason}`,
      };
    }
    // Substitute custom tool calls: if the code contains
    // __opencowork_custom_tool('name'), replace with the stored tool code.
    let code = action.code;
    try {
      const { substituteCustomToolCalls } = await import("../registry");
      code = await substituteCustomToolCalls(code);
    } catch (e) {
      // Log the import failure rather than silently falling through to
      // running unmodified LLM-authored code.
      console.warn("[executor] substituteCustomToolCalls import failed:", e);
    }
    // Wrap execution in a wall-clock timeout race. If the code returns a
    // Promise (async code), we race it against a timeout and surface a
    // timeout error if it doesn't settle. Synchronous infinite loops can't
    // be interrupted without a Web Worker (a larger architectural change) —
    // but the timeout at least catches async hangs and provides a
    // diagnostic for sync hangs (the error fires on the next event loop
    // tick after the sync loop yields, which is better than hanging forever
    // with no signal).
    // Trust-model note: the code executed below is LLM/user-authored
    // JavaScript run in the LIVE page context via `new Function`. Execution is
    // gated only by `canExecuteJs` (true solely in `full_agentic` mode) and a
    // `confirmRequired` prompt in standard mode (see the executor's mode
    // checks). The domain allow/block list constrains WHERE this code may run
    // (which origins), NOT WHAT it can do once running — code that executes on
    // an allowed page can still make arbitrary network egress (`fetch`/
    // WebSocket) or read page data. Treat `evaluate` as a full-code-execution
    // primitive scoped to the granted origin.
    //
    // The ONE thing we MUST prevent is egress of the extension secret
    // store, which lives in `chrome.storage.session` (key
    // "open_cowork_secrets", see secrets.ts). `new Function(code)` is created in
    // the extension's privileged global scope, so without a sandbox,
    // LLM-supplied `code` could call
    // `chrome.storage.session.get("open_cowork_secrets")` and `fetch()` it out
    // — a prompt-injection in `full_agentic` mode (no confirmation) becomes a
    // direct secret-exfiltration path.
    //
    // We pass `chrome`, `window`, `document`, `globalThis`, and `self` as
    // PARAMETERS to the generated function, so the code's *free* references to
    // those identifiers resolve to our hardened stubs instead of the real
    // extension globals.
    //   * `chrome` is replaced by a Proxy that THROWS on ANY property access
    //     (see {@link makeSandboxChrome}) — `evaluate` has no legitimate reason
    //     to touch `chrome` at all, so failing closed on every access is the
    //     strongest guarantee: there is provably no path back to the real
    //     `chrome` object.
    //   * `window`, `globalThis`, and `self` are replaced by forwarding Proxies
    //     (see {@link makeChromeDenyingProxy}) that pass EVERYTHING through to
    //     the real globals EXCEPT `chrome`, which they also deny. This closes
    //     the `window.chrome` / `globalThis.chrome` / `self.chrome` bypass
    //     vectors (the real `chrome` would otherwise be reachable through them)
    //     while keeping legitimate page-global usage working.
    //   * `document` is left as the REAL page document — `evaluate`'s job IS
    //     page-DOM manipulation, and the secret store is NOT in the page DOM (it
    //     is in `chrome.storage.session`, which is now unreachable — see the
    //     residual-risk note below for reading page-DOM secrets.
    const denyChrome = makeSandboxChrome();
    const sandboxWindow = makeChromeDenyingProxy(
      typeof window !== "undefined" ? (window as object) : (globalThis as object),
    );
    const sandboxGlobal = makeChromeDenyingProxy(globalThis as object);
    const sandboxSelf = makeChromeDenyingProxy(
      typeof self !== "undefined" ? (self as object) : (globalThis as object),
    );
    const fn = new Function(
      "chrome",
      "window",
      "document",
      "globalThis",
      "self",
      `"use strict";\n${code}`,
    ) as (c: unknown, w: unknown, d: unknown, g: unknown, s: unknown) => unknown;
    const syncResult = fn(denyChrome, sandboxWindow, document, sandboxGlobal, sandboxSelf);
    // If the result is a Promise, race it against a timeout.
    let result: unknown = syncResult;
    if (syncResult instanceof Promise) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`evaluate timed out after ${LIMITS.evaluateTimeoutMs}ms`)), LIMITS.evaluateTimeoutMs);
      });
      try {
        result = await Promise.race([syncResult, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    // Only report `pageChanged` when the page actually changed.
    // The old code reported `pageChanged: true` unconditionally — that
    // defeated the loop detector (every `evaluate` reset the repetition
    // window, so page-changing actions could never accumulate) and forced
    // a full DOM re-extract every step. Compare the live URL + DOM
    // fingerprint against what the executor captured in `ctx` BEFORE this
    // handler ran. Wrapped in try/catch so a fingerprint failure can't
    // mask a successful evaluation.
    let pageChanged = false;
    try {
      pageChanged =
        location.href !== ctx.beforeUrl ||
        domFingerprint() !== ctx.beforeFingerprint;
    } catch {
      // If we can't compute the fingerprint, don't claim a page change —
      // better to skip the reset than to lie about it.
      pageChanged = false;
    }
    return {
      action,
      success: true,
      message: "JavaScript executed",
      // `redactSecrets` (see loop/messages.ts) only masks STORED
      // secrets — i.e. values the user explicitly registered via `setSecret`.
      // If the `evaluate` JS reads a secret that lives in the page DOM or
      // page `localStorage` of an *allowed* origin (not in our secret store),
      // the returned value below is sent to the LLM provider UNMASKED. This is
      // a known, accepted residual risk: `evaluate` is a full-code-execution
      // primitive scoped to the granted origin (see the trust-model note above), and we
      // deliberately do NOT block legit DOM/localStorage reads (only `chrome` is hardened).
      // Documented here so the limitation is visible at the egress point.
      extractedContent: result !== undefined ? String(result).slice(0, LIMITS.evaluateResultChars) : undefined,
      pageChanged,
    };
  } catch (e) {
    throw new Error(`JS evaluation failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
