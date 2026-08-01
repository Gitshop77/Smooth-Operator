/**
 * Endpoint builder — base URL, path, and query params.
 * Defines WHERE a request is sent (base URL + path + query params).
 */

interface EndpointPatch<Body = unknown> {
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

 // Absolute base: merge the base URL's own query, any query carried by the
 // (relative) path `p`, and the endpoint-level `query` into a SINGLE "?".
 // `new URL(p, base)` would otherwise DROP the base's query (and vice-versa)
 // because a relative reference's query overrides the base's — producing a
 // lost `?x=1` or a malformed double "?". Build one merged params object.
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    // `base` is not a valid absolute URL (e.g. a host-only string like
    // "example.com") — treat it as relative and fall back to the path branch
    // rather than throwing (scheme-less/relative baseURL crashed buildURL).
    return mergeQueryIntoPath(p, endpoint.query);
  }

  const pIsAbsolute = /^https?:\/\//i.test(p);
  const url = new URL(p, base);

  const params = new URLSearchParams();
  // Only fold the base URL's query when the path is NOT itself an absolute
  // URL — otherwise the base's query (which may carry secrets) would be
  // appended to an unrelated origin (base-URL secret query leaked
  // into an absolute-path URL).
  if (!pIsAbsolute) {
    for (const [k, v] of new URLSearchParams(baseUrl.search)) params.set(k, v);
  }
  // Strip any URL fragment before extracting the path query, so a '#…' is not
  // folded into a query value (fragment absorbed into query param).
  const pNoFrag = p.replace(/#.*$/, "");
  const pQueryIndex = pNoFrag.indexOf("?");
  if (pQueryIndex !== -1) {
    const pQuery = new URLSearchParams(pNoFrag.slice(pQueryIndex + 1));
    for (const [k, v] of pQuery) params.set(k, v);
  }
  for (const [k, v] of Object.entries(endpoint.query)) params.set(k, v);
  url.search = params.toString();
  return url.toString();
};

/**
 * Merge `query` into a (possibly relative) path that may already carry a query
 * string, emitting exactly one "?". Returns `path` unchanged when there is
 * nothing to add.
 */
function mergeQueryIntoPath(path: string, query: Record<string, string>): string {
  if (Object.keys(query).length === 0) return path;
  const queryStr = new URLSearchParams(query).toString();
  if (queryStr === "") return path;
 // Split off any URL fragment so it isn't absorbed into the query by
 // URLSearchParams (which would otherwise merge everything after '#' into a
 // value). The base-URL branch above preserves fragments; keep them here too.
  const hashIndex = path.indexOf("#");
  const frag = hashIndex === -1 ? "" : path.slice(hashIndex);
  const pathNoFrag = hashIndex === -1 ? path : path.slice(0, hashIndex);
  const qIndex = pathNoFrag.indexOf("?");
  if (qIndex === -1) return `${pathNoFrag}?${queryStr}${frag}`;
  const params = new URLSearchParams(pathNoFrag.slice(qIndex + 1));
  for (const [k, v] of Object.entries(query)) params.set(k, v);
  return `${pathNoFrag.slice(0, qIndex)}?${params.toString()}${frag}`;
}

export * as Endpoint from "./endpoint";
