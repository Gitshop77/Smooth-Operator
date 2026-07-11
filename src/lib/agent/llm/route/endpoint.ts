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

  if (!base) {
    // No base URL: preserve the (relative) path exactly, but merge any
    // endpoint-level query params into a query `p` may already carry, so we
    // never emit a malformed double-"?…?…" (e.g. "?v=1?k=2").
    return mergeQueryIntoPath(p, endpoint.query);
  }

  // Absolute base: the URL constructor already folds any query present in `p`
  // into the result, so we merge `endpoint.query` into it instead of appending
  // a second "?", which would produce a malformed double-"?…?…" string.
  const url = new URL(p, base);
  for (const [k, v] of Object.entries(endpoint.query)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
};

/**
 * Merge `query` into a (possibly relative) path that may already carry a query
 * string, emitting exactly one "?". Returns `path` unchanged when there is
 * nothing to add.
 */
function mergeQueryIntoPath(path: string, query: Record<string, string>): string {
  const queryStr = new URLSearchParams(query).toString();
  if (queryStr === "") return path;
  const qIndex = path.indexOf("?");
  if (qIndex === -1) return `${path}?${queryStr}`;
  const params = new URLSearchParams(path.slice(qIndex + 1));
  for (const [k, v] of Object.entries(query)) params.set(k, v);
  return `${path.slice(0, qIndex)}?${params.toString()}`;
}

export * as Endpoint from "./endpoint";
