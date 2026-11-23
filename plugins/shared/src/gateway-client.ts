/**
 * The two reads a client makes of a gateway before it sends a policy: detection (`GET {base}/route-policy`) and
 * the model list (`GET {base}/models`). Neither carries content. Each reply belongs to the base URL and the
 * credential it was fetched with (C14), so callers key what they keep by both.
 */

import { parseDetection, type Detection } from "../../../core/src/index.ts";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Where a request goes and with which key. `credential` is null when the request carries none. */
export interface Target {
  base: string;
  credential: string | null;
}

export type DetectionResult = { ok: true; detection: Detection } | { ok: false; why: string };

/** A base URL with no trailing slash, so `{base}/models` and a request URL compare as strings. */
export const normalizeBase = (base: string): string => base.replace(/\/+$/, "");

function headersFor(target: Target): Record<string, string> {
  // Credentials go as a bearer token, the form every OpenAI-compatible gateway reads; detection needs none, but a
  // key's bound policy is reported only to its holder.
  return target.credential === null ? { accept: "application/json" } : { accept: "application/json", authorization: `Bearer ${target.credential}` };
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
    const { status, body } = await getJson(fetchImpl, `${normalizeBase(target.base)}/route-policy`, target, timeoutMs);
    const read = parseDetection({ status, body, credentialed: target.credential !== null });
    return read.ok ? { ok: true, detection: read.value } : { ok: false, why: `detection reply is not valid: ${read.key === null ? "" : `${read.key} `}${read.detail}` };
  } catch (error) {
    return { ok: false, why: `detection could not be fetched: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Fetches the model list as the gateway sent it; `publishedRoutes` reads it. Null when there is no list to hold. */
export async function fetchModelList(fetchImpl: Fetch, target: Target, timeoutMs: number): Promise<unknown> {
  try {
    const { status, body } = await getJson(fetchImpl, `${normalizeBase(target.base)}/models`, target, timeoutMs);
    return status === 200 && body !== undefined ? body : null;
  } catch {
    return null;
  }
}
