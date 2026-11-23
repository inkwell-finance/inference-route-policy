/**
 * The two reads a client makes of a gateway before it sends a policy: detection (`GET {base}/route-policy`) and
 * the model list (`GET {base}/models`). Neither carries content. Each reply belongs to the base URL and the
 * credential it was fetched with (C14), so callers key what they keep by both.
 */

import { parseDetection, type Detection } from "../../../core/src/index.ts";
import type { RequestContext } from "./request.ts";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Where a request goes and what identifies its caller there: the base URL without its query, the query every
 * request there carries, and the request's context (every header but the few known not to identify anyone).
 */
export interface Target {
  base: string;
  query: string;
  context: RequestContext;
}

export type DetectionResult = { ok: true; detection: Detection } | { ok: false; why: string };

/** A base URL with no trailing slash, so `{base}/models` and a request URL compare as strings. */
export const normalizeBase = (base: string): string => base.replace(/\/+$/, "");

function headersFor(target: Target): Record<string, string> {
  // The whole context the request will carry: whichever header or cookie the gateway knows its caller by,
  // detection and the model list answer for that caller. Detection needs none, but a bound policy is reported
  // only to its key's holder.
  return { ...Object.fromEntries(target.context), accept: "application/json" };
}

async function getJson(fetchImpl: Fetch, url: string, target: Target, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  // A reply belongs to the base URL it was fetched from (C14). Following a redirect would let another origin's
  // reply speak for this one, so a 3xx comes back as itself and reads as no reply.
  const response = await fetchImpl(url, { headers: headersFor(target), redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

/** Fetches and reads a detection reply. Anything that is not a valid reply, a failed fetch included, is no detection (C6). */
export async function fetchDetection(fetchImpl: Fetch, target: Target, timeoutMs: number): Promise<DetectionResult> {
  try {
    const { status, body } = await getJson(fetchImpl, `${normalizeBase(target.base)}/route-policy${target.query}`, target, timeoutMs);
    const read = parseDetection({ status, body, credentialed: target.context.length > 0 });
    return read.ok ? { ok: true, detection: read.value } : { ok: false, why: `detection reply is not valid: ${read.key === null ? "" : `${read.key} `}${read.detail}` };
  } catch (error) {
    return { ok: false, why: `detection could not be fetched: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Fetches the model list as the gateway sent it; `publishedRoutes` reads it. Null when there is no list to hold. */
export async function fetchModelList(fetchImpl: Fetch, target: Target, timeoutMs: number): Promise<unknown> {
  try {
    const { status, body } = await getJson(fetchImpl, `${normalizeBase(target.base)}/models${target.query}`, target, timeoutMs);
    return status === 200 && body !== undefined ? body : null;
  } catch {
    return null;
  }
}
