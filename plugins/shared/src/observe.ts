/**
 * Reads the result headers of inference responses as they arrive.
 *
 * Both harnesses report response headers to extensions only for a successful status: a non-2xx response makes
 * their transports throw before `after_provider_response` runs, so a refusal's `Route-Refused` (status 400 or 503)
 * would never reach the plugin. The only place both statuses are visible is the process's `fetch`, which both
 * harnesses' transports call. This wraps it to observe, and only to observe: every call goes through unchanged
 * and its response is returned as it came. A listener that throws is ignored.
 */

import type { ResultHeaders } from "../../../core/src/index.ts";

/** One request and the status and result headers of its response. */
export interface Exchange {
  url: string;
  method: string;
  /** The request body's top-level `model`, when the body is JSON text that has a string one. */
  model: string | null;
  routePolicy: string | null;
  status: number;
  result: ResultHeaders;
}

export type Listener = (exchange: Exchange) => void;

// One wrapper per process, shared by every copy of this module a harness loads (omp re-imports an extension
// for each session), so wrappers never stack.
const REGISTRY = Symbol.for("inference-route-policy.fetch-listeners");

interface Registry {
  listeners: Set<Listener>;
}

function isRegistry(value: unknown): value is Registry {
  return typeof value === "object" && value !== null && "listeners" in value && value.listeners instanceof Set;
}

function bodyModel(body: unknown): string | null {
  if (typeof body !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && "model" in parsed && typeof parsed.model === "string" ? parsed.model : null;
  } catch {
    return null;
  }
}

function exchangeOf(input: Parameters<typeof fetch>[0], init: RequestInit | undefined, response: Response): Exchange {
  const request = input instanceof Request ? input : null;
  const values = (name: string): string[] => {
    const value = response.headers.get(name);
    return value === null ? [] : [value];
  };
  return {
    url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
    model: bodyModel(init?.body),
    routePolicy: new Headers(init?.headers ?? request?.headers).get("route-policy"),
    status: response.status,
    // Headers.get joins repeated field lines into one value, which the core's readers then reject as a whole:
    // the spec's test for a client that sees only joined values.
    result: { applied: values("route-applied"), refused: values("route-refused"), evidence: values("route-evidence") },
  };
}

function install(): Registry {
  const existing: unknown = Reflect.get(globalThis, REGISTRY);
  if (isRegistry(existing)) return existing;
  const registry: Registry = { listeners: new Set() };
  Reflect.set(globalThis, REGISTRY, registry);
  const original = globalThis.fetch;
  const observed = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const response = await original(input, init);
    try {
      const exchange = exchangeOf(input, init, response);
      for (const listener of registry.listeners) {
        try {
          listener(exchange);
        } catch {
          // A listener's failure must not reach the harness's request.
        }
      }
    } catch {
      // Neither may a request shape this reader did not expect.
    }
    return response;
  };
  // Keep the runtime's own members of fetch (Bun's `preconnect`, for one).
  globalThis.fetch = Object.assign(observed, original);
  return registry;
}

/** Calls `listener` with every exchange made through `fetch` from now on. Returns the function that stops it. */
export function observeExchanges(listener: Listener): () => void {
  const registry = install();
  registry.listeners.add(listener);
  return () => registry.listeners.delete(listener);
}
