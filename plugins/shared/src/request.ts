/**
 * What a request is, as far as a policy decision depends on it, read the same way where the plugin decides and
 * where the request leaves: its authentication context, its policy header, and its body as serialized.
 */

import type { ResultHeaders } from "../../../core/src/index.ts";

/**
 * Every header a gateway may take a key from. The authentication context is all of them, not one picked out:
 * which one a gateway honors is its business, so metadata is read with the same set the request will carry.
 */
const CREDENTIAL_HEADERS: readonly string[] = ["api-key", "authorization", "x-api-key", "x-goog-api-key"];

/** A request's credential headers, by lowercase name, in a fixed order. Empty when it carries none. */
export type AuthContext = readonly (readonly [string, string])[];

export function authOf(headers: Headers): AuthContext {
  const auth: [string, string][] = [];
  for (const name of CREDENTIAL_HEADERS) {
    const value = headers.get(name);
    if (value !== null) auth.push([name, value]);
  }
  return auth;
}

export const authKey = (auth: AuthContext): string => JSON.stringify(auth);

/** Whether a header name is one a credential travels in. */
export const isCredentialHeader = (name: string): boolean => CREDENTIAL_HEADERS.includes(name.toLowerCase());

/** A request as it leaves through `fetch`, before anything is sent. */
export interface Outgoing {
  url: string;
  method: string;
  auth: AuthContext;
  /** The `Route-Policy` value as it will be sent: repeated lines are joined, and so never equal one released value. */
  header: string | null;
  /** The body as it will be sent, when it is text; null when it is bytes or a stream this reader cannot compare. */
  body: string | null;
}

/** Reads a request as it leaves. `init` overrides a `Request` input's headers and body, as `fetch` does. */
export function outgoingOf(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): Outgoing {
  const request = input instanceof Request ? input : null;
  const headers = new Headers(init?.headers ?? request?.headers);
  const body = init !== undefined && "body" in init ? init.body : request?.body;
  return {
    url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
    auth: authOf(headers),
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
