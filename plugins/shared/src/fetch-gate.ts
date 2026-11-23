/**
 * The last check before a request leaves the process, and the only place its response is read.
 *
 * Both harnesses send provider requests through the process's `fetch`. This wraps it once per process. For each
 * POST, every registered gate says whether the request is one it released, one it must stop, or none of its
 * business. A request a gate released goes through unchanged, and that gate reads the response to that very
 * call; a request any gate must stop, and no gate released, fails before a byte is written, with the error the
 * harness then reports as the turn's failure. Everything else goes through untouched.
 *
 * Why here: the harness hooks decide with what the harness tells them, which is not always what goes on the
 * wire (a configured header can replace the key the registry reported), and both harnesses skip their response
 * hook for a non-2xx response, which is how a refusal arrives.
 */

import { completionOf, outgoingOf, type Completion, type Outgoing } from "./request.ts";

export type Verdict =
  | { kind: "pass" }
  /** The gate released this request: it goes, and `complete` gets the response to this call. */
  | { kind: "released"; complete: (completion: Completion) => void }
  /** Under the gate's watch, the gate did not release this request, and it must not leave. `stopped` runs if it does not. */
  | { kind: "stop"; reason: string; stopped?: () => void };

export type Gate = (outgoing: Outgoing) => Verdict;

// One wrapper per process, shared by every copy of this module a harness loads (omp re-imports an extension
// for each session), so wrappers never stack.
const REGISTRY = Symbol.for("inference-route-policy.fetch-gates");

interface Registry {
  gates: Set<Gate>;
}

function isRegistry(value: unknown): value is Registry {
  return typeof value === "object" && value !== null && "gates" in value && value.gates instanceof Set;
}

/** Why a request must not leave, or null, and who to tell; or the release whose owner reads the response. */
interface Judgment {
  stop: string | null;
  stopped: (() => void)[];
  complete: ((completion: Completion) => void) | null;
}

/** Why a request must not leave, or null; and the release whose owner reads the response. */
function judge(gates: Iterable<Gate>, outgoing: Outgoing): Judgment {
  let stop: string | null = null;
  const stopped: (() => void)[] = [];
  for (const gate of gates) {
    let verdict: Verdict;
    try {
      verdict = gate(outgoing);
    } catch (error) {
      verdict = { kind: "stop", reason: `the plugin failed while checking the request: ${error instanceof Error ? error.message : "unknown error"}` };
    }
    // A request one gate released is that gate's; another gate's watch over the same base URL does not stop it.
    if (verdict.kind === "released") return { stop: null, stopped: [], complete: verdict.complete };
    if (verdict.kind === "stop") {
      stop ??= verdict.reason;
      if (verdict.stopped !== undefined) stopped.push(verdict.stopped);
    }
  }
  return { stop, stopped, complete: null };
}

function install(): Registry {
  const existing: unknown = Reflect.get(globalThis, REGISTRY);
  if (isRegistry(existing)) return existing;
  const registry: Registry = { gates: new Set() };
  Reflect.set(globalThis, REGISTRY, registry);
  const original = globalThis.fetch;
  const gated = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    let verdict: Judgment = { stop: null, stopped: [], complete: null };
    if (registry.gates.size > 0) {
      let outgoing: Outgoing | null = null;
      try {
        outgoing = outgoingOf(input, init);
      } catch {
        // Headers `fetch` itself cannot read make `fetch` fail below, before anything is sent.
      }
      if (outgoing?.method === "POST") verdict = judge(registry.gates, outgoing);
    }
    if (verdict.stop !== null) {
      for (const tell of verdict.stopped) {
        try {
          tell();
        } catch {
          // The request is stopped whether or not the user could be told.
        }
      }
      throw new Error(`Blocked by the route policy plugin, nothing was sent: ${verdict.stop}`);
    }
    const response = await original(input, init);
    if (verdict.complete !== null) {
      try {
        verdict.complete(completionOf(response));
      } catch {
        // Reading the result must not reach the harness's request.
      }
    }
    return response;
  };
  // Keep the runtime's own members of fetch (Bun's `preconnect`, for one).
  globalThis.fetch = Object.assign(gated, original);
  return registry;
}

/** Puts `gate` in front of every `fetch` from now on. Returns the function that removes it. */
export function addGate(gate: Gate): () => void {
  const registry = install();
  registry.gates.add(gate);
  return () => registry.gates.delete(gate);
}
