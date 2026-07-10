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

const secretValue = (secret: string | undefined, source: string): string => {
  if (secret === undefined || secret === "") throw new MissingCredentialError(source);
  return secret;
};

const makeAuth = (applyFn: (input: AuthInput) => HeaderMap): Auth => ({
  apply: applyFn,
});

const value = (secret: string, source = "value"): Credential => makeCredential(() => secretValue(secret, source));

export const optional = (secret: string | undefined, source = "optional value"): Credential =>
  secret === undefined ? makeCredential(() => { throw new MissingCredentialError(source); }) : makeCredential(() => secretValue(secret, source));
export const config = (name: string): Credential =>
  makeCredential(() => secretValue(typeof process !== "undefined" ? process.env?.[name] : undefined, name));

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
