/**
 * Sandbox/proxy infrastructure and `runSandboxedCode` for the `evaluate`
 * action handler. Extracted from evaluate.ts for maintainability.
 */

import { domFingerprint } from "../helpers";

/**
 * A fully-throwing Proxy used to shadow dangerous globals (`chrome`,
 * `Function`, `eval`) passed as parameters to the generated function. ANY
 * property access, call, construct, or assignment throws `access denied by
 * evaluate sandbox`, so even a direct `new Function(...)` / `eval(...)` /
 * `chrome.x` reference inside the evaluated code is blocked. The `name` is
 * embedded in the thrown message (e.g. `chrome.get`, `Function.apply`) so the
 * source of a denial is diagnosable.
 */
function makeThrowingProxy(name: string): unknown {
  const deny = (op: string, prop: PropertyKey): never => {
    throw new Error(`access denied by evaluate sandbox: ${name}.${op} ${String(prop)}`);
  };
  return new Proxy(
    function () {},
    {
      get: (_t, prop) => deny("get", prop),
      set: (_t, prop) => deny("set", prop),
      has: (_t, prop) => deny("has", prop),
      deleteProperty: (_t, prop) => deny("deleteProperty", prop),
      apply: () => deny("apply", "()"),
      construct: () => deny("construct", "new"),
    },
  );
}

/**
 * Decode `\uXXXX` and `\u{XXXXX}` escape sequences in source code to their
 * actual characters. This must run BEFORE the code-string escape scanner so
 * that encoded patterns like `\u002econstructor` (→ `.constructor`) or
 * `\u005f\u005fproto\u005f\u005f` (→ `__proto__`) are visible to the regex
 * checks that only look for literal substrings.
 *
 * A `\u` escape preceded by an ODD number of backslashes is itself escaped
 * (the preceding `\\` already consumed the escape) and denotes literal text —
 * `'\\u002econstructor'` is harmless string data, not a `.constructor`
 * reference. Decoding it would produce a false-positive block.
 */
function normalizeUnicodeEscapes(src: string): string {
  return src.replace(
    /\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g,
    (match, hex1: string | undefined, hex2: string | undefined, offset: number, whole: string) => {
      let backslashes = 0;
      for (let k = offset - 1; k >= 0 && whole[k] === "\\"; k--) backslashes++;
      if (backslashes % 2 === 1) return match;
      return String.fromCodePoint(parseInt(hex1 ?? hex2 ?? "0", 16));
    },
  );
}

// Stateless throwing stubs for the dangerous globals passed as parameters to
// the generated function. These are identical on every `handleEvaluate` call,
// so build them once at module load instead of re-creating them per invocation.
const DENY_CHROME = makeThrowingProxy("chrome");
const DENY_FUNCTION = makeThrowingProxy("Function");
const DENY_EVAL = makeThrowingProxy("eval");

/**
 * Hardened forwarding proxy for a REAL built-in constructor/object (e.g.
 * `Object`, `Array`, `String`, `Promise`, `Map`, …) passed as a PARAMETER to
 * the generated function. It forwards every access to the real builtin so
 * legitimate evaluate code keeps working (`Object.keys`, `Array.from`,
 * `JSON.parse`, `x instanceof Array`, `typeof Object === "function"`, …) while
 * denying the *escape* properties `constructor` and `chrome`.
 *
 * WHY: `evaluate` runs in the content-script realm, so the free identifiers
 * `Object`/`Array`/`Function`/… resolve to the REAL realm globals. The documented
 * secret-exfil escape reaches the real `chrome` through the prototype chain of
 * those globals — e.g. `Object.constructor` (→ real `Function`) or
 * `Object.prototype.constructor`. Shadowing the globals with this proxy closes
 * the *direct* `Object.constructor` / `Array.constructor` / … reference form
 * (those now throw `access denied by evaluate sandbox`), while `instanceof` and
 * normal method usage still resolve through the (allowed) `prototype` property.
 *
 * RESIDUAL RISK (NOT closed here): the escape via a *literal* object's
 * prototype chain — `[].constructor.constructor` or `({}).constructor` — is
 * unaffected, because `[]`/`{}` are real realm objects whose `.constructor`
 * still leads to the real `Function`. Closing that requires running `evaluate`
 * in a realm with no `chrome` binding (architectural fix owned outside this
 * file). This proxy is defense-in-depth that widens the set of blocked
 * constructor-escape entry points without changing legitimate behavior.
 */
const BUILTIN_DENIED_PROPS = new Set(["constructor", "chrome", "__proto__"]);
function makeHardenedBuiltin(real: object): object {
  const deny = (prop: PropertyKey): never => {
    throw new Error(`access denied by evaluate sandbox: ${String(prop)}`);
  };
  return new Proxy(real, {
    get: (t, prop, recv) => {
      if (typeof prop === "string" && BUILTIN_DENIED_PROPS.has(prop)) deny(prop);
      return Reflect.get(t, prop, recv);
    },
    has: (t, prop) => {
      if (typeof prop === "string" && BUILTIN_DENIED_PROPS.has(prop)) return false;
      return Reflect.has(t, prop);
    },
    set: (t, prop, value, recv) => {
      if (typeof prop === "string" && BUILTIN_DENIED_PROPS.has(prop)) deny(prop);
      return Reflect.set(t, prop, value, recv);
    },
    apply: (t, thisArg, args) =>
      Reflect.apply(t as (...a: unknown[]) => unknown, thisArg, args),
    construct: (t, args, newTarget) =>
      Reflect.construct(t as new (...a: unknown[]) => object, args, newTarget),
    getPrototypeOf: (t) => {
      const proto = Object.getPrototypeOf(t);
      return proto === null ? null : makeHardenedBuiltin(proto);
    },
  });
}

// Built once at module load (identical on every call). Each shadows the
// corresponding global so evaluated code cannot use it to climb to the real
// `Function`/real `chrome` via the direct `X.constructor` form.
const HARDENED_BUILTINS = {
  Object: makeHardenedBuiltin(Object),
  Array: makeHardenedBuiltin(Array),
  String: makeHardenedBuiltin(String),
  Number: makeHardenedBuiltin(Number),
  Boolean: makeHardenedBuiltin(Boolean),
  Symbol: makeHardenedBuiltin(Symbol),
  Proxy: makeHardenedBuiltin(Proxy),
  Reflect: makeHardenedBuiltin(Reflect),
  Promise: makeHardenedBuiltin(Promise),
  Map: makeHardenedBuiltin(Map),
  Set: makeHardenedBuiltin(Set),
  WeakMap: makeHardenedBuiltin(WeakMap),
  WeakSet: makeHardenedBuiltin(WeakSet),
  Date: makeHardenedBuiltin(Date),
  RegExp: makeHardenedBuiltin(RegExp),
  Error: makeHardenedBuiltin(Error),
  Math: makeHardenedBuiltin(Math),
  JSON: makeHardenedBuiltin(JSON),
  BigInt: makeHardenedBuiltin(BigInt),
} as const;

const SANDBOX_DENIED_PROPS = new Set(["chrome", "Function", "eval", "constructor", "__proto__"]);

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
    getPrototypeOf: (t) => {
      const proto = Object.getPrototypeOf(t);
      return proto === null ? null : (makeChromeDenyingProxy(proto, redirect) as object);
    },
    getOwnPropertyDescriptor: (t, prop) => {
      if (typeof prop === "string") {
        if (SANDBOX_DENIED_PROPS.has(prop)) return undefined;
        if (redirect && prop in redirect) {
          return {
            configurable: true,
            enumerable: true,
            writable: false,
            value: redirect[prop](),
          };
        }
      }
      return Reflect.getOwnPropertyDescriptor(t, prop);
    },
  });
}

/**
 * Recursively-hardened window-like proxy (used for `window`, `globalThis`,
 * `self` and their `top`/`parent`/`opener` ancestors). Denies `chrome`,
 * `Function`, and `eval` at every level AND redirects window-traversal
 * properties to likewise-hardened objects, so the code cannot reach the REAL
 * extension `chrome` global through `window.document.defaultView.chrome`,
 * `window.top.chrome`, `window.parent.chrome`, etc. (evaluate sandbox
 * correctness depends on content-script isolation semantics — this makes the
 * guarantee independent of Chrome's internals).
 */
function makeHardenedWindowLike(target: object, hardenedDoc: Document): object {
  const redirect: RedirectMap = {
    document: () => hardenedDoc,
    defaultView: () => makeHardenedWindowLike(target, hardenedDoc),
    self: () => makeHardenedWindowLike(target, hardenedDoc),
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
 * Best-effort `document` obfuscation proxy. Forwards every DOM access EXCEPT a
 * set of window-traversal properties that could otherwise reach the REAL
 * extension `chrome` (which lives in the page's window, not the
 * content-script's): `document.defaultView.chrome`, `document.forms`,
 * `document.frames`, `document.top`, `document.parent`, `document.opener`,
 * `document.window` are denied.
 *
 * SECURITY (NON-BOUNDARY): this is NOT a security boundary and does NOT close
 * the document→chrome path. It only masks direct property access on the
 * document object itself. It is trivially bypassed by reading `ownerDocument`
 * off ANY DOM node returned through the proxy — e.g.
 * `hardenedDoc.body.ownerDocument.defaultView.chrome` — because the returned
 * node is the REAL element whose `.ownerDocument` is the REAL document, whose
 * `.defaultView` is the REAL window, whose `.chrome` is the REAL extension
 * global (`document`-hardening bypassable via
 * `ownerDocument` on any DOM node). Wrapping every returned node to trap
 * `ownerDocument` is not feasible without breaking `instanceof`, structural
 * DOM identity, and passing nodes back to real DOM APIs (i.e. without breaking
 * behavior), and it would not close the constructor-chain escape documented at
 * the call site regardless. The only robust fix is architectural (run in a
 * realm with no `chrome` binding, keep the secret store out of content-script
 * scope) and is owned outside this file. Treat this proxy as bar-raising
 * obfuscation only, not as a boundary.
 */
const DOCUMENT_DENIED_PROPS = new Set([
  "defaultView", "forms", "frames", "top", "parent", "opener", "window", "constructor",
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
    getPrototypeOf: (t) => {
      const proto = Object.getPrototypeOf(t);
      return proto === null ? null : makeHardenedDocument(proto as Document);
    },
    getOwnPropertyDescriptor: (t, prop) => {
      if (DOCUMENT_DENIED_PROPS.has(prop as string)) return undefined;
      return Reflect.getOwnPropertyDescriptor(t, prop);
    },
  }) as Document;
}

// Cached hardened sandbox objects per page. Invalidated when the DOM fingerprint
// changes (page navigation / major DOM mutation). The proxies are stateless
// wrappers around the real objects — caching them across evaluate calls on the
// same page is safe and eliminates repeated construction overhead.
let cachedFingerprint: string | null = null;
let cachedSandbox: {
  hardenedDocument: Document;
  sandboxWindow: object;
  sandboxGlobal: object;
  sandboxSelf: object;
} | null = null;

/**
 * Run `code` in the hardened evaluate sandbox and return its synchronous
 * result (or a pending Promise if the code returns one — callers must
 * `await`/`Promise.race` as needed). The sandbox denies `chrome`,
 * `Function`, `eval`, and the `window`/`globalThis`/`self`/`document`
 * traversal paths to the real extension globals (see the traps above).
 *
 * Exported so the hardening can be regression-tested directly without the
 * domain/registry/secret machinery of {@link handleEvaluate} — the test
 * harness and this function share the exact same proxy construction, so a
 * passing test proves the deny/throw paths hold.
 */
export function runSandboxedCode(code: string): unknown {
  const fp = domFingerprint();
  if (cachedFingerprint !== fp || !cachedSandbox) {
    const hardenedDocument = makeHardenedDocument(document);
    const makeWindowProxy = (target: object): object =>
      makeHardenedWindowLike(target, hardenedDocument);
    cachedSandbox = {
      hardenedDocument,
      sandboxWindow: makeWindowProxy(
        typeof window !== "undefined" ? (window as object) : (globalThis as object),
      ),
      sandboxGlobal: makeWindowProxy(globalThis as object),
      sandboxSelf: makeWindowProxy(
        typeof self !== "undefined" ? (self as object) : (globalThis as object),
      ),
    };
    cachedFingerprint = fp;
  }
  const { hardenedDocument, sandboxWindow, sandboxGlobal, sandboxSelf } = cachedSandbox;
  // Normalize Unicode escape sequences before scanning so encoded patterns
  // like \u002econstructor (→ .constructor) are visible to the regex checks.
  const normalizedCode = normalizeUnicodeEscapes(code);
  // Block obvious Function-constructor escape patterns at the entry point.
  // This catches `[].constructor.constructor`, `({}).constructor.constructor`,
  // and `(async function(){}).constructor` — the documented bypass vectors.
  // Obfuscated variants (string concat, template literals) are caught by the
  // MV3 platform restriction on chrome.storage.session from content scripts.
  if (/\.\s*constructor\s*(?:\[\s*['"]constructor['"]\s*\]|\.constructor)?/.test(normalizedCode)) {
    throw new Error(
      "evaluate blocked: Function-constructor escape pattern detected. " +
      "This pattern can bypass the evaluate sandbox.",
    );
  }
  // Detect prototype-chain and bracket-notation constructor escapes that
  // bypass the .constructor.constructor scan above (e.g. __proto__,
  // getPrototypeOf, ['constructor'] without a preceding dot-constructor).
  const ESCAPE_PATTERNS: { pattern: RegExp; name: string }[] = [
    { pattern: /__proto__/i, name: "__proto__ reference" },
    { pattern: /\[\s*['"`]constructor['"`]\s*\]/, name: "bracket-notation constructor access" },
    { pattern: /\[\s*['"`]__proto__['"`]\s*\]/, name: "bracket-notation __proto__ access" },
    { pattern: /getPrototypeOf/, name: "Object.getPrototypeOf call" },
  ];
  for (const { pattern, name } of ESCAPE_PATTERNS) {
    if (pattern.test(normalizedCode)) {
      throw new Error(
        `evaluate blocked: sandbox escape pattern detected (${name})`,
      );
    }
  }
  // Ensure the evaluated body never runs in strict mode: the generated
  // function declares `eval`/`Function` as PARAMETERS, which are reserved
  // names under strict mode and would make `new Function` throw
  // `SyntaxError: Unexpected eval or arguments in strict mode` at creation
  // time. Strip any leading directive and any leading comments (a strict
  // snippet that begins with a comment would otherwise keep its directive
  // and re-trigger the same SyntaxError).
  //
  // CONSEQUENCE: evaluated code runs in sloppy mode. Semantic differences
  // from strict mode: `this` in functions defaults to `window` (not
  // `undefined`), missing variables create globals instead of throwing
  // `ReferenceError`, and duplicate parameter names are silently allowed.
  // This matches the real-browser behavior most page JS expects.
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
    "Object",
    "Array",
    "String",
    "Number",
    "Boolean",
    "Symbol",
    "Proxy",
    "Reflect",
    "Promise",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "Date",
    "RegExp",
    "Error",
    "Math",
    "JSON",
    "BigInt",
    strippedCode,
  ) as (...args: unknown[]) => unknown;
  return fn.call(
    sandboxWindow,
    DENY_CHROME,
    sandboxWindow,
    hardenedDocument,
    sandboxGlobal,
    sandboxSelf,
    DENY_FUNCTION,
    DENY_EVAL,
    HARDENED_BUILTINS.Object,
    HARDENED_BUILTINS.Array,
    HARDENED_BUILTINS.String,
    HARDENED_BUILTINS.Number,
    HARDENED_BUILTINS.Boolean,
    HARDENED_BUILTINS.Symbol,
    HARDENED_BUILTINS.Proxy,
    HARDENED_BUILTINS.Reflect,
    HARDENED_BUILTINS.Promise,
    HARDENED_BUILTINS.Map,
    HARDENED_BUILTINS.Set,
    HARDENED_BUILTINS.WeakMap,
    HARDENED_BUILTINS.WeakSet,
    HARDENED_BUILTINS.Date,
    HARDENED_BUILTINS.RegExp,
    HARDENED_BUILTINS.Error,
    HARDENED_BUILTINS.Math,
    HARDENED_BUILTINS.JSON,
    HARDENED_BUILTINS.BigInt,
  );
}
