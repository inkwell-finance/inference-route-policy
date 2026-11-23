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
const NOT_CONTEXT: readonly string[] = [
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
const CREDENTIAL_HEADERS: readonly string[] = ["authorization", "x-api-key", "x-goog-api-key", "api-key", "cookie", "proxy-authorization"];

/** Whether a context carries a credential, as C6 means it. */
export const credentialed = (context: RequestContext): boolean => context.some(([name, value]) => CREDENTIAL_HEADERS.includes(name) && value.trim() !== "");

export const contextKey = (context: RequestContext): string => JSON.stringify(context);

/** Where a request goes: the base URL without its query, and the query, which every request there carries too. */
export interface Place {
  base: string;
  query: string;
}

/** A base URL as a place, or null when it is not an absolute URL. Trailing slashes are dropped from the path. */
export function placeOf(baseUrl: string): Place | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  return { base: `${url.origin}${url.pathname}`.replace(/\/+$/, ""), query: url.search };
}

/** A request as it leaves through `fetch`, before anything is sent. */
export interface Outgoing {
  /** The URL without its query. */
  path: string;
  query: string;
  method: string;
  context: RequestContext;
  /** The `Route-Policy` value as it will be sent: repeated lines are joined, and so never equal one released value. */
  header: string | null;
  /** The body as it will be sent, when it is text; null when it is bytes or a stream this reader cannot compare. */
  body: string | null;
}

/** Reads a request as it leaves. `init` overrides a `Request` input's headers and body, as `fetch` does. */
export function outgoingOf(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): Outgoing {
  const request = input instanceof Request ? input : null;
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const headers = new Headers(init?.headers ?? request?.headers);
  const body = init !== undefined && "body" in init ? init.body : request?.body;
  return {
    path: `${url.origin}${url.pathname}`,
    query: url.search,
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
