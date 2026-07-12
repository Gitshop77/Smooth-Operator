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
 * This is the first (and primary) layer of defense — there is no whitelisted
 * accessor that an attacker could abuse. Every trap (get/set/has/apply/
 * construct/deleteProperty) denies, so neither reads, writes, nor `in`-checks
 * nor calls/constructs can slip through. (Layered with the `Function`/`eval`
 * and `document` hardening below for defense-in-depth.)
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
 * `globalThis`, `self`, ...) for every property EXCEPT a small deny-list of
 * dangerous properties, which it denies with the sandbox error.
 *
 * `evaluate` legitimately needs the page globals (`window`, `document` via its
 * own parameter, `globalThis`, `self`) for DOM/JS work, so we can't just blank
 * them out. But an attacker could reach the real `chrome` through
 * `window.chrome` / `globalThis.chrome` / `self.chrome` to bypass the
 * `chrome` parameter shadow above. This proxy lets all normal global access
 * through while slamming the `chrome` property shut on every trap (get/set/has/
 * delete), so those bypass vectors throw `access denied by evaluate sandbox`.
 *
 * It ALSO denies `Function` and `eval` (and their `in`-checks), because a
 * sandboxed script can escape the parameter shadowing by calling
 * `new Function(...)` / `eval(...)` / indirect `(0, eval)(...)` — those build a
 * function in the GLOBAL scope, where the free identifier `Function`/`eval`
 * resolves to the REAL global constructor, not our throwing parameter stub. By
 * denying `Function`/`eval` on the window/globalThis/self proxies, the
 * `window.Function(...)` / `globalThis.eval(...)` escape vectors are also
 * closed (finding: evaluate sandbox is bypassable via new Function / indirect
 * eval). The direct `Function`/`eval` identifiers are additionally shadowed as
 * throwing parameters on the generated function (see below).
 */
const SANDBOX_DENIED_PROPS = new Set(["chrome", "Function", "eval"]);

/** A prop → lazy-value map. When a denied/redirected prop is accessed on a
 * hardened proxy, the getter is invoked and its result returned instead of the
 * real property. Used to recursively harden window-traversal properties so the
 * evaluated code cannot climb out of the isolated world to the real `chrome`. */
type RedirectMap = Record<string, () => unknown>;

function makeChromeDenyingProxy(target: object, redirect?: RedirectMap): unknown {
  const deny = (prop: PropertyKey): never => {
    throw new Error(`access denied by evaluate sandbox: ${String(prop)}`);
  };
  return new Proxy(target, {
    get: (t, prop, recv) => {
      if (typeof prop === "string") {
        if (SANDBOX_DENIED_PROPS.has(prop)) deny(prop);
        if (redirect && prop in redirect) return redirect[prop]();
      }
      return Reflect.get(t, prop, recv);
    },
    has: (t, prop) => {
      if (typeof prop === "string") {
        if (SANDBOX_DENIED_PROPS.has(prop)) return false;
        if (redirect && prop in redirect) return true;
      }
      return Reflect.has(t, prop);
    },
    set: (t, prop, value, recv) => {
      if (typeof prop === "string" && SANDBOX_DENIED_PROPS.has(prop)) deny(prop);
      return Reflect.set(t, prop, value, recv);
    },
    deleteProperty: (t, prop) => {
      if (typeof prop === "string" && SANDBOX_DENIED_PROPS.has(prop)) deny(prop);
      return Reflect.deleteProperty(t, prop);
    },
  });
}

/**
 * Recursively-hardened window-like proxy (used for `window`, `globalThis`,
 * `self` and their `top`/`parent`/`opener` ancestors). Denies `chrome`,
 * `Function`, and `eval` at every level AND redirects window-traversal
 * properties to likewise-hardened objects, so the code cannot reach the REAL
 * extension `chrome` global through `window.document.defaultView.chrome`,
 * `window.top.chrome`, `window.parent.chrome`, etc. (finding: evaluate sandbox
 * correctness depends on content-script isolation semantics — this makes the
 * guarantee independent of Chrome's internals).
 */
function makeHardenedWindowLike(target: object, hardenedDoc: Document): object {
  const redirect: RedirectMap = {
    // Route `document` (and `defaultView`/`self`) back to the already-hardened
    // document, which itself denies `defaultView`/`forms`/`frames`/`top`/
    // `parent`/`opener`/`window` — closing the `window.document.defaultView
    // .chrome` escape that would expose the real `chrome` in a content script.
    document: () => hardenedDoc,
    defaultView: () => makeHardenedWindowLike(target, hardenedDoc),
    self: () => makeHardenedWindowLike(target, hardenedDoc),
    // `window` and `globalThis` MUST also redirect to a hardened proxy. In a
    // content-script isolated world `window.window === window` (the raw,
    // un-hardened target), so `window.window` / `globalThis.window` /
    // `globalThis.globalThis` fall through `Reflect.get(t, prop)` to the REAL
    // window/globalThis whose `.chrome` is the real extension `chrome`. Without
    // these redirects the sandbox escape via `window.window.chrome` /
    // `globalThis.window.chrome` is OPEN (finding: evaluate sandbox escape via
    // window.window.chrome). Redirecting forces every traversal back through a
    // hardened proxy that denies `chrome`/`Function`/`eval`.
    window: () => makeHardenedWindowLike(target, hardenedDoc),
    globalThis: () => makeHardenedWindowLike(target, hardenedDoc),
    top: () =>
      makeHardenedWindowLike(
        ((target as Window).top ?? target) as object,
        hardenedDoc,
      ),
    parent: () =>
      makeHardenedWindowLike(
        ((target as Window).parent ?? target) as object,
        hardenedDoc,
      ),
    opener: () => {
      const o = (target as Window).opener;
      return o ? makeHardenedWindowLike(o as object, hardenedDoc) : null;
    },
    frames: () =>
      makeHardenedWindowLike(
        (target as Window).frames as unknown as object,
        hardenedDoc,
      ),
  };
  return makeChromeDenyingProxy(target, redirect) as object;
}

/**
 * A fully-throwing stub used to shadow the `Function` and `eval` identifiers
 * passed as parameters to the generated function. Any property access, call,
 * construct, or assignment throws `access denied by evaluate sandbox`, so even
 * a direct `new Function(...)` / `eval(...)` reference inside the evaluated code
 * (not just the `window.Function` form) is blocked.
 */
function makeThrowingStub(name: string): unknown {
  const deny = (op: string, prop: PropertyKey): never => {
    throw new Error(`access denied by evaluate sandbox: ${name}.${op} ${String(prop)}`);
  };
  return new Proxy(
    {},
    {
      get: (_t, prop) => deny("get", prop),
      set: (_t, prop) => { deny("set", prop); return false; },
      has: (_t, prop) => { deny("has", prop); return false; },
      deleteProperty: (_t, prop) => { deny("deleteProperty", prop); return false; },
      apply: () => deny("apply", "()"),
      construct: () => deny("construct", "new"),
    },
  );
}

/**
 * Hardened `document` proxy. Forwards every DOM access EXCEPT a set of
 * window-traversal properties that could otherwise reach the REAL extension
 * `chrome` (which lives in the page's window, not the content-script's). This
 * is defense-in-depth: `document.defaultView.chrome`, `document.forms`,
 * `document.frames`, `document.top`, `document.parent`, `document.opener` are
 * all denied so a sandboxed script cannot climb out of the isolated world to
 * the extension's `chrome.storage.session` secret store (finding: evaluate
 * sandbox correctness depends on content-script isolation semantics).
 */
const DOCUMENT_DENIED_PROPS = new Set([
  "defaultView", "forms", "frames", "top", "parent", "opener", "window",
]);
function makeHardenedDocument(target: Document): Document {
  return new Proxy(target, {
    get: (t, prop, recv) => {
      if (DOCUMENT_DENIED_PROPS.has(prop as string)) {
        throw new Error(`access denied by evaluate sandbox: document.${String(prop)}`);
      }
      return Reflect.get(t, prop, recv);
    },
    has: (t, prop) => {
      if (DOCUMENT_DENIED_PROPS.has(prop as string)) return false;
      return Reflect.has(t, prop);
    },
  }) as Document;
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
      // Substitution is a security-relevant transform: it inlines stored
      // custom-tool code in place of the LLM-authored `__opencowork_custom_tool()`
      // placeholders. If the registry can't be loaded we must NOT silently fall
      // through to executing the UNMODIFIED LLM-authored code — that would skip
      // the substitution the caller expected and run raw model output. Fail
      // closed: block the evaluate action and report why. (Previous behaviour
      // logged a warning and then ran the unmodified code, which was
      // contradictory and unsafe — finding: substituteCustomToolCalls import
      // failure runs UNMODIFIED code despite contradictory comment.)
      console.error("[executor] substituteCustomToolCalls import failed:", e);
      return {
        action,
        success: false,
        message: `BLOCKED evaluate: custom-tool substitution unavailable (${
          e instanceof Error ? e.message : String(e)
        }). Refusing to run unmodified LLM-authored code.`,
      };
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
    // We pass `chrome`, `window`, `document`, `globalThis`, `self`, `Function`,
    // and `eval` as PARAMETERS to the generated function, so the code's *free*
    // references to those identifiers resolve to our hardened stubs instead of
    // the real extension globals.
    //   * `chrome` is replaced by a Proxy that THROWS on ANY property access
    //     (see {@link makeSandboxChrome}) — `evaluate` has no legitimate reason
    //     to touch `chrome` at all, so failing closed on every access is the
    //     strongest guarantee against reaching the real `chrome` object.
    //   * `window`, `globalThis`, and `self` are replaced by forwarding Proxies
    //     (see {@link makeChromeDenyingProxy}) that pass EVERYTHING through to
    //     the real globals EXCEPT `chrome` AND `Function`/`eval`, which they also
    //     deny. This closes the `window.chrome` / `globalThis.chrome` /
    //     `self.chrome` bypass vectors AND the `window.Function(...)` /
    //     `globalThis.eval(...)` escape vectors (the real `chrome` would
    //     otherwise be reachable through them) while keeping legitimate
    //     page-global usage working.
    //   * `document` is replaced by a hardened Proxy (see {@link
    //     makeHardenedDocument}) that denies `defaultView` / `forms` / `frames`
    //     / `top` / `parent` / `opener` / `window` so the code cannot climb out
    //     of the isolated world to the page's real `chrome` (defense-in-depth:
    //     the guarantee no longer depends solely on Chrome's content-script
    //     isolation semantics).
    //   * `Function` and `eval` are replaced by fully-throwing stubs (see
    //     {@link makeThrowingStub}) so a direct `new Function(...)` / `eval(...)`
    //     reference inside the code cannot build a function in the global scope
    //     to escape the sandbox (finding: evaluate sandbox is bypassable via new
    //     Function / indirect eval).
    //
    // RESIDUAL RISK (finding: evaluate sandbox bypassable via the Function-
    // constructor escape): the parameter/proxy shadowing above CANNOT stop code
    // from reaching the REAL `Function` constructor through any object's
    // prototype chain — e.g. `[].constructor.constructor`,
    // `({}).constructor.constructor`, or `(async function(){}).constructor` (the
    // `AsyncFunction` equivalent). Those build functions in the live
    // content-script global, where the free identifiers `chrome`/`globalThis`
    // resolve to the real extension globals, defeating the `chrome` hardening
    // above and re-opening the secret-exfil path. Static string-scrubbing of
    // `constructor`/`prototype` is unreliable and is deliberately NOT used. The
    // ONLY robust fix is architectural: run `evaluate` in a realm that has no
    // `chrome` binding AND no reachable `Function` returning the privileged
    // global (a sandboxed same-origin iframe / Web Worker / `ShadowRealm` whose
    // global truly lacks `chrome`), OR — strongly preferred — never place
    // `open_cowork_secrets` where content-script-scope code can read it: keep the
    // secret store in the background service worker and expose it only via
    // message passing. Until that cross-cutting change lands (it spans the
    // executor, `secrets.ts`, and the background page — outside this file's
    // ownership), treat the `chrome`-hardening here as defense-in-depth and rely
    // on the secret store being unreachable from content-script scope
    // (see SECURITY.md).
    const denyChrome = makeSandboxChrome();
    // `hardenedDocument` is created first so the window/global proxies can
    // redirect `document` to it — this closes the `window.document.defaultView
    // .chrome` escape that would otherwise reach the real extension `chrome`
    // global in a content-script context (see makeHardenedDocument). The
    // window/global/self proxies are recursively hardened so traversal
    // properties (`top`/`parent`/`opener`/`frames`/`self`) cannot expose the
    // real `chrome` either (finding: evaluate sandbox correctness depends on
    // content-script isolation semantics).
    const hardenedDocument = makeHardenedDocument(document);
    const makeWindowProxy = (target: object): object =>
      makeHardenedWindowLike(target, hardenedDocument);
    const sandboxWindow = makeWindowProxy(
      typeof window !== "undefined" ? (window as object) : (globalThis as object),
    );
    const sandboxGlobal = makeWindowProxy(globalThis as object);
    const sandboxSelf = makeWindowProxy(
      typeof self !== "undefined" ? (self as object) : (globalThis as object),
    );
    // We deliberately do NOT inject `"use strict";` into the wrapper body.
    // `eval`/`arguments` are reserved parameter names under strict mode, so a
    // strict function cannot declare an `eval` parameter — `new Function(...)`
    // throws `SyntaxError: Unexpected eval or arguments in strict mode` at
    // *creation* time, which previously broke EVERY `evaluate` call in
    // `full_agentic` mode (finding: evaluate handler broken by strict-mode eval
    // parameter). We instead run the wrapper in SLOPPY mode and neutralize the
    // `this` escape (sloppy-mode `this` would otherwise be the content-script
    // global, re-exposing the real `chrome`/`Function`/`eval`) by binding `this`
    // to the hardened window proxy in the `fn.call(...)` below. `Function` and
    // `eval` are still shadowed as throwing parameters, so direct
    // `new Function(...)` / `eval(...)` references inside the code are blocked.
    // Ensure the evaluated body never runs in strict mode. The generated
    // function declares `eval` (and `Function`) as PARAMETERS so bare
    // references resolve to our throwing stubs; under strict mode `eval`/
    // `arguments` are illegal parameter names and `new Function` would throw
    // `SyntaxError: Unexpected eval or arguments in strict mode` at creation
    // time, breaking EVERY evaluate call (finding: evaluate handler broken by
    // strict-mode eval parameter). We don't inject "use strict" ourselves, but
    // LLM/user code could place a "use strict" directive at the top of `code`,
    // which would re-trigger that same SyntaxError. Strip a leading directive
    // (after first removing any leading line/block comments — a strict snippet
    // that begins with a comment like `// generated\n"use strict";` would
    // otherwise keep its directive, the wrapper would become strict, and
    // `new Function` would throw `SyntaxError: Unexpected eval or arguments in
    // strict mode` because we declare `eval`/`Function` as parameters;
    // finding: incomplete "use strict" stripping breaks valid strict-mode code
    // with a leading comment) so the body stays sloppy and the `eval`/`Function`
    // parameter shadows stay valid (and keep blocking bare `new Function(...)`
    // / `eval(...)` escapes). We only remove the directive and any leading
    // comments; the executed logic is otherwise unchanged. (We keep the
    // `eval`/`Function` parameter names rather than renaming them, because they
    // are what shadow the bare `eval`/`Function` identifiers to throwing stubs
    // — renaming them would re-open the direct `eval(...)` escape.)
    const strippedCode = code
      .replace(/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*\s*/, "")
      .replace(/^\s*["']use strict["']\s*;?/, "");
    const fn = new Function(
      "chrome",
      "window",
      "document",
      "globalThis",
      "self",
      "Function",
      "eval",
      strippedCode,
    ) as (
      c: unknown, w: unknown, d: unknown, g: unknown, s: unknown, f: unknown, ev: unknown,
    ) => unknown;
    // `Function` and `eval` are shadowed as throwing parameter stubs so a direct
    // `new Function(...)` / `eval(...)` reference inside the code cannot escape
    // the sandbox by building a function in the global scope (finding: evaluate
    // sandbox is bypassable via new Function / indirect eval). We bind `this` to
    // the hardened window proxy so `this.chrome` / `this.Function` / `this.eval`
    // cannot reach the real globals — `window`/`document`/`globalThis`/`self`
    // remain readable on `this` through the denying/redirecting proxy.
    const syncResult = fn.call(
      sandboxWindow,
      denyChrome,
      sandboxWindow,
      hardenedDocument,
      sandboxGlobal,
      sandboxSelf,
      makeThrowingStub("Function"),
      makeThrowingStub("eval"),
    );
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
