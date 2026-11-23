/**
 * The identity of one outgoing request: where it goes, with which key, for which model, with which policy
 * header. The plugin makes it once, when it releases a request, from exactly what it hands the harness; the
 * fetch gate reads the same four values off the request as it leaves, and the request goes only if they match.
 */

import type { ResultHeaders } from "../../../core/src/index.ts";

export interface RequestIdentity {
  /** The base URL, with no trailing slash; the request's URL starts with it and a slash. */
  base: string;
  /** The key the request carries; null when it carries none. */
  credential: string | null;
  /** The body's top-level `model`; null when the body names none (some APIs name it in the URL). */
  model: string | null;
  /** The `Route-Policy` value; null when there is none. */
  header: string | null;
}

export const identityKey = (identity: RequestIdentity): string => JSON.stringify([identity.base, identity.credential, identity.model, identity.header]);

/** A request as it leaves through `fetch`, before anything is sent. */
export interface Outgoing {
  url: string;
  method: string;
  credential: string | null;
  /** The body's top-level `model`: null when the body names none, undefined when the body cannot be read. */
  model: string | null | undefined;
  header: string | null;
}

/** The key a set of headers carries: a bearer token, or an `x-api-key` as the Messages API sends it. */
export function credentialOf(headers: Headers): string | null {
  return /^Bearer (.+)$/i.exec(headers.get("authorization") ?? "")?.[1] ?? headers.get("x-api-key");
}

/** The body's top-level `model`: null when it names none, undefined when the body cannot be read. */
function modelOf(body: unknown): string | null | undefined {
  if (body === undefined || body === null) return null;
  if (typeof body !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || !("model" in parsed)) return null;
    return typeof parsed.model === "string" ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the four identity values off a request as it leaves. */
export function outgoingOf(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): Outgoing {
  const request = input instanceof Request ? input : null;
  const headers = new Headers(init?.headers ?? request?.headers);
  return {
    url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
    credential: credentialOf(headers),
    // A Request object's own body is a stream: not readable here without consuming it.
    model: init?.body !== undefined ? modelOf(init.body) : request?.body ? undefined : null,
    header: headers.get("route-policy"),
  };
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
