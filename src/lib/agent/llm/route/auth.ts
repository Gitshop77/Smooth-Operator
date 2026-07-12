/**
 * Composable auth system — chains credential sources and renders headers.
 *
 * The fluent API is `Auth.optional(key).orElse(Auth.config(env)).pipe(Auth.bearer)`
 * — try the caller-supplied key, fall back to an env var, then render as a
 * `Bearer` header. Plain TypeScript (no framework dependency) so it runs in
 * service workers, browsers, and Node.
 */

export type HeaderMap = Record<string, string>;

export interface AuthInput {
  method: "POST" | "GET";
  url: string;
  body: string;
  headers: HeaderMap;
}

export class MissingCredentialError extends Error {
  constructor(source: string) {
    super(`Missing credential: ${source}`);
    this.name = "MissingCredentialError";
  }
}

/** A credential source — knows how to load a secret string. */
export interface Credential {
  readonly load: () => string;
  readonly orElse: (that: Credential) => Credential;
  readonly bearer: () => Auth;
  readonly header: (name: string) => Auth;
  readonly pipe: <A>(f: (self: Credential) => A) => A;
}

/** An auth strategy — knows how to modify request headers. */
export interface Auth {
  readonly apply: (input: AuthInput) => HeaderMap;
}

const makeCredential = (loadFn: () => string): Credential => {
  const self: Credential = {
    load: loadFn,
    orElse: (that: Credential): Credential =>
      makeCredential(() => {
        try { return loadFn(); } catch { return that.load(); }
      }),
    bearer: (): Auth => fromCredential(self, (secret) => ({ authorization: `Bearer ${secret}` })),
    header: (name: string): Auth => fromCredential(self, (secret) => ({ [name]: secret })),
    pipe: <A>(f: (self: Credential) => A): A => f(self),
  };
  return self;
};

const fromCredential = (source: Credential, render: (secret: string) => HeaderMap): Auth =>
  makeAuth((input: AuthInput): HeaderMap => {
    const secret = source.load();
    return { ...input.headers, ...render(secret) };
  });

const secretValue = (secret: string | null | undefined, source: string): string => {
 // Treat `null` like `undefined`/`""` so a planted/empty entry is indistinguishable
 // from "no credential here" and falls through the surrounding `orElse()` chain.
  if (secret == null || secret === "") throw new MissingCredentialError(source);
  return secret;
};

const makeAuth = (applyFn: (input: AuthInput) => HeaderMap): Auth => ({
  apply: applyFn,
});

const value = (secret: string, source = "value"): Credential => makeCredential(() => secretValue(secret, source));

export const optional = (secret: string | undefined, source = "optional value"): Credential =>
  secret === undefined ? makeCredential(() => { throw new MissingCredentialError(source); }) : makeCredential(() => secretValue(secret, source));
/**
 * Resolve a secret from an environment variable (Node / CLI / tests), or — in a
 * browser / extension context where `process.env` does not exist — from an
 * injected synchronous source. The extension's service worker can hydrate a
 * cache from `chrome.storage.session` and expose it on
 * `globalThis.__openCoworkEnv` (mirroring the repo's existing `globalThis`
 * bridge convention), so env-style secrets become resolvable in-browser.
 *
 * Without an injected source `config()` cannot resolve in-browser and simply
 * throws `MissingCredentialError`, which a surrounding `orElse()` chain treats
 * as "no credential here" and falls through to the next source. The previous
 * implementation unconditionally threw in the extension (because `process` is
 * `undefined` there), making the env-var fallback dead code on the only browser
 * deployment target — callers believed env vars would work in-browser when they
 * never could.
 */
/**
 * Immutable snapshot of the extension's injected-env bridge.
 *
 * `globalThis.__openCoworkEnv` is a synchronous secrets bridge the service
 * worker can hydrate from `chrome.storage.session` and expose for in-browser
 * credential resolution. It is a *mutable* global, however, so rather than
 * reading it live on every `config()` call (where a script sharing the isolated
 * extension context could mutate a value after credentials were already
 * resolved), we take a single frozen snapshot on first access. The bridge is
 * isolated to this extension's contexts (content scripts and other extensions
 * run in their own worlds), but freezing still removes the live-read fragility
 * for the lifetime of the session.
 */
let injectedEnvSnapshot: Readonly<Record<string, string>> | null = null;
const getInjectedEnv = (): Readonly<Record<string, string>> => {
  if (injectedEnvSnapshot === null) {
    const source = (globalThis as { __openCoworkEnv?: Record<string, string> }).__openCoworkEnv;
    injectedEnvSnapshot = Object.freeze({ ...(source ?? {}) });
  }
  return injectedEnvSnapshot;
};

export const config = (name: string): Credential =>
  makeCredential(() => {
    if (typeof process !== "undefined" && process.env?.[name] !== undefined) {
      return secretValue(process.env[name], name);
    }
    const injected = getInjectedEnv()[name];
 // `injected` is `string | undefined`; a `null` entry in the source map would
 // be coerced to `undefined` by the index access, and `secretValue` already
 // treats both `null` and `undefined` as "missing".
    return secretValue(injected, name);
  });

export const none = makeAuth((input: AuthInput): HeaderMap => input.headers);

export function bearer(source: string | Credential): Auth {
  return (typeof source === "string" ? value(source) : source).bearer();
}

// Function overloads — `no-redeclare` doesn't understand TS overloads.
/* eslint-disable no-redeclare */
export function header(name: string): (source: string | Credential) => Auth;
export function header(name: string, source: string | Credential): Auth;
export function header(name: string, source?: string | Credential): Auth | ((source: string | Credential) => Auth) {
  if (source === undefined) return (next: string | Credential): Auth => (typeof next === "string" ? value(next) : next).header(name);
  return (typeof source === "string" ? value(source) : source).header(name);
}

export type ApiKeyMode = "optional" | "required";
export type ProviderAuthOption<Mode extends ApiKeyMode> =
  | { readonly auth: Auth; readonly apiKey?: never }
  | (Mode extends "optional" ? { readonly apiKey?: string; readonly auth?: never } : { readonly apiKey: string; readonly auth?: never });

export * as Auth from "./auth";
