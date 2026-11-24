/**
 * What a request is, as far as a policy decision depends on it, read the same way where the plugin decides and
 * where the request leaves: its URL, its context (every header but a few known not to identify the caller), its
 * policy header, and its body as serialized.
 */

import type { ResultHeaders } from "../../../core/src/index.ts";

/**
 * Headers that do not say who is asking, so they are left out of a request's context. Everything else a request
 * carries (a key in any header, a cookie, a proxy credential, a custom token) is context: the plugin reads
 * metadata with all of it and lets the request leave only with exactly that.
 */
export const NOT_CONTEXT: readonly string[] = [
  // Content negotiation: what the client accepts back.
  "accept",
  "accept-encoding",
  "accept-language",
  // Describe the body, which is bound byte for byte on its own.
  "content-length",
  "content-type",
  // Names the client software; both harnesses set their own.
  "user-agent",
  // The policy carrier, bound on its own.
  "route-policy",
  // The OpenAI SDK's description of itself and of the attempt, seen on pi's requests (and the timeout on omp's).
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-retry-count",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-timeout",
];

/** A request's context: every header it carries but those above, by lowercase name in order. */
export type RequestContext = readonly (readonly [string, string])[];

export function contextOf(headers: Headers): RequestContext {
  const context: [string, string][] = [];
  // Headers iterates lowercase names in order, repeated lines joined into one value.
  for (const [name, value] of headers) if (!NOT_CONTEXT.includes(name)) context.push([name, value]);
  return context;
}

/**
 * Headers known to carry a credential: the registry's key goes in one of the first four (bearer for most APIs,
 * `x-api-key` for Messages, `x-goog-api-key` for Google, `api-key` for Azure-style gateways), and a cookie or a
 * proxy credential can name the caller too. This list decides only whether a detection request "carried
 * credentials" (C6): a header not on it still belongs to the context, but does not make a request credentialed.
 * Treating an unknown header as no credential can only reject a valid reply's `key_policy`, never accept one a
 * gateway sent to a caller it could not identify.
 */
export const CREDENTIAL_HEADERS: readonly string[] = ["authorization", "x-api-key", "x-goog-api-key", "api-key", "cookie", "proxy-authorization"];

/** The names of the headers that carry a credential in a context, in order. */
export const credentialNames = (context: RequestContext): string[] =>
  context.flatMap(([name, value]) => (CREDENTIAL_HEADERS.includes(name) && value.trim() !== "" ? [name] : []));

/** Whether a context carries a credential, as C6 means it. */
export const credentialed = (context: RequestContext): boolean => credentialNames(context).length > 0;

export const contextKey = (context: RequestContext): string => JSON.stringify(context);

/**
 * Where a request goes: the base URL without its query, and the query, which every request there carries too.
 * Both are as `fetch` puts them on the wire: the URL parser's serialization, which is the request target `fetch`
 * sends. Metadata reads and the released request are both read through it, so equal here is equal on the wire.
 */
export interface Place {
  /** Scheme, host, and path, without trailing slashes. */
  base: string;
  /** "" when the URL has no query, "?" when it has an empty one, else "?" and the query as sent. */
  query: string;
}

/**
 * The query as `fetch` sends it, its "?" included. `URL.search` is "" both for no query and for an empty one,
 * which are different targets on the wire (RFC 3986, 6.2.3); the serialization keeps the "?" of an empty one.
 */
function queryOf(url: URL): string {
  if (url.search !== "") return url.search;
  // The serialization escapes every "#" before the fragment's, so the first one starts it.
  const href = url.href;
  const hash = href.indexOf("#");
  return (hash === -1 ? href : href.slice(0, hash)).endsWith("?") ? "?" : "";
}

/** A URL `fetch` can send: credentials in it make `fetch` refuse the request, so they name no place. */
function sendable(url: URL): boolean {
  return url.username === "" && url.password === "";
}

/** RFC 3986, 5.2.4: a path without its "." and ".." segments, "/" when nothing is left. */
function withoutDotSegments(path: string): string {
  const segments = path.split("/").slice(1);
  const kept: string[] = [];
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    if (segment === "." || segment === "..") {
      if (segment === "..") kept.pop();
      if (last) kept.push("");
    } else {
      kept.push(segment);
    }
  }
  return `/${kept.join("/")}`;
}

const DEFAULT_PORTS: Readonly<Record<string, string>> = { "http:": "80", "https:": "443" };

/**
 * How the parser would send the base URL other than as written, or null when it sends it as written. Written
 * and sent may differ only where RFC 3986 says the two name the same resource: the case of the scheme and of an
 * ASCII host (6.2.2.1), a default or empty port (6.2.3), an empty path as "/" (6.2.3), and "." and ".." segments
 * (6.2.2.3). Anything else the parser rewrites, such as a character it percent-encodes, a backslash, a tab, a
 * non-ASCII host, or another spelling of an IP address, would send the request somewhere not written.
 */
function rewritten(written: string, url: URL, sentQuery: string): string | null {
  const parts = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#[\s\S]*)?$/.exec(written);
  if (parts === null) return "it is not written as scheme://host/path?query";
  const [, scheme = "", authority = "", path = "", query = "", fragment] = parts;
  if (fragment !== undefined) return `its fragment ${JSON.stringify(fragment)} is never sent`;
  const differences: string[] = [];
  if (`${scheme.toLowerCase()}:` !== url.protocol) differences.push(`its scheme ${JSON.stringify(scheme)} would be sent as ${JSON.stringify(url.protocol.slice(0, -1))}`);
  const hostPort = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(authority);
  const host = hostPort?.[1] ?? authority;
  const port = hostPort?.[2] ?? "";
  if (host.toLowerCase() !== url.hostname) differences.push(`its host ${JSON.stringify(host)} would be sent as ${JSON.stringify(url.hostname)}`);
  if (port !== url.port && !(url.port === "" && port === DEFAULT_PORTS[url.protocol])) {
    differences.push(`its port ${JSON.stringify(port)} would be sent as ${JSON.stringify(url.port)}`);
  }
  // Dot segments are removed only to explain a path that differs; most are sent as written.
  if (path !== url.pathname && withoutDotSegments(path) !== url.pathname) differences.push(`its path ${JSON.stringify(path)} would be sent as ${JSON.stringify(url.pathname)}`);
  if (query !== sentQuery) differences.push(`its query ${JSON.stringify(query)} would be sent as ${JSON.stringify(sentQuery)}`);
  return differences.length === 0 ? null : differences.join(", and ");
}

/**
 * A base URL as a place, with why it cannot be used exactly as written (null when it can); null instead when it
 * is not an absolute URL `fetch` can send to. A place that is not as written may carry no policy (C14).
 */
export function placeOf(baseUrl: string): { place: Place; unexact: string | null } | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (!sendable(url)) return null;
  const query = queryOf(url);
  const difference = rewritten(baseUrl, url, query);
  return {
    place: { base: `${url.origin}${url.pathname}`.replace(/\/+$/, ""), query },
    unexact: difference === null ? null : `the base URL ${JSON.stringify(baseUrl)} cannot be used exactly as written: ${difference}; a policy is not sent anywhere else`,
  };
}

/** A request as it leaves through `fetch`, before anything is sent. */
export interface Outgoing {
  /** Scheme, host, and path as sent: the URL without its query or fragment. */
  path: string;
  /** As in `Place`: "" for no query, "?" for an empty one. */
  query: string;
  method: string;
  context: RequestContext;
  /** The `Route-Policy` value as it will be sent: repeated lines are joined, and so never equal one released value. */
  header: string | null;
  /** The body as it will be sent, when it is text; null when it is bytes or a stream this reader cannot compare. */
  body: string | null;
}

/**
 * Reads a request as it leaves. `init` overrides a `Request` input's headers and body, as `fetch` does. Headers
 * are read through `Headers`, as `fetch` sends them: names case-insensitive, values trimmed, repeated lines joined
 * into one. Throws, as `fetch` would, for a URL it cannot send.
 */
export function outgoingOf(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): Outgoing {
  const request = input instanceof Request ? input : null;
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!sendable(url)) throw new TypeError("a URL with credentials in it is not sent");
  const headers = new Headers(init?.headers ?? request?.headers);
  const body = init !== undefined && "body" in init ? init.body : request?.body;
  return {
    path: `${url.origin}${url.pathname}`,
    query: queryOf(url),
    method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
    context: contextOf(headers),
    header: headers.get("route-policy"),
    body: typeof body === "string" ? body : body === undefined || body === null ? "" : null,
  };
}

/** The body's top-level `model`: null when it names none, undefined when the body cannot be read. */
export function modelIn(body: string | null): string | null | undefined {
  if (body === null) return undefined;
  if (body === "") return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || !("model" in parsed)) return null;
    return typeof parsed.model === "string" ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

/** The status and result headers of the response to one request. */
export interface Completion {
  status: number;
  result: ResultHeaders;
}

export function completionOf(response: Response): Completion {
  // Headers.get joins repeated field lines into one value, which the core's readers then reject as a whole:
  // the spec's test for a client that sees only joined values.
  const values = (name: string): string[] => {
    const value = response.headers.get(name);
    return value === null ? [] : [value];
  };
  return { status: response.status, result: { applied: values("route-applied"), refused: values("route-refused"), evidence: values("route-evidence") } };
}
