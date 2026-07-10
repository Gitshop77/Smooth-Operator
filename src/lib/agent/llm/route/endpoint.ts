/**
 * Endpoint builder — base URL, path, and query params.
 * Defines WHERE a request is sent (base URL + path + query params).
 */

export interface EndpointPatch<Body = unknown> {
  readonly baseURL?: string;
  readonly path?: string | ((body: Body) => string);
  readonly query?: Record<string, string>;
}

export interface Endpoint<Body = unknown> {
  readonly baseURL?: string;
  readonly path: string | ((body: Body) => string);
  readonly query: Record<string, string>;
  readonly merge: (patch: EndpointPatch<Body>) => Endpoint<Body>;
}

export const path = <Body = unknown>(p: string, opts?: { baseURL?: string; query?: Record<string, string> }): Endpoint<Body> => {
  const base: Endpoint<Body> = {
    baseURL: opts?.baseURL,
    path: p,
    query: opts?.query ?? {},
    merge: (patch: EndpointPatch<Body>): Endpoint<Body> => mergeEndpoint(base, patch),
  };
  return base;
};

export const merge = <Body>(base: Endpoint<Body>, patch: EndpointPatch<Body>): Endpoint<Body> => mergeEndpoint(base, patch);

function mergeEndpoint<Body>(base: Endpoint<Body>, patch: EndpointPatch<Body>): Endpoint<Body> {
  const merged: Endpoint<Body> = {
    baseURL: patch.baseURL ?? base.baseURL,
    path: patch.path ?? base.path,
    query: { ...base.query, ...(patch.query ?? {}) },
    merge: (p: EndpointPatch<Body>): Endpoint<Body> => mergeEndpoint(merged, p),
  };
  return merged;
}

/** Build the full URL from an endpoint + body. */
export const buildURL = <Body>(endpoint: Endpoint<Body>, body: Body): string => {
  const base = endpoint.baseURL ?? "";
  const p = typeof endpoint.path === "function" ? endpoint.path(body) : endpoint.path;
  const url = `${base.replace(/\/$/, "")}${p}`;
  const query = new URLSearchParams(endpoint.query).toString();
  return query ? `${url}?${query}` : url;
};

export * as Endpoint from "./endpoint";
