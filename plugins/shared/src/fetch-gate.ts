/**
 * The last check before a request leaves the process, and the only place its response is read.
 *
 * Both harnesses send provider requests through the process's `fetch`, which this wraps once per process. One
 * release table serves every plugin session in the process. A session releases a request by its exact bytes:
 * base URL and query, context (every header but those known not to identify the caller), `Route-Policy`
 * header, and serialized body. A POST that matches exactly one
 * session's release goes, once: the release is used up, so a harness's resend of the same request is not
 * released again. It goes with redirects off, so a gateway cannot move the body elsewhere, and the response to
 * that very call goes back to the session that released it. A POST no release matches goes untouched unless a
 * session watching its base URL says a policy is at stake, and then it fails before a byte is written.
 *
 * Why here: the harness hooks decide on what the harness tells them, which is not always what goes on the wire,
 * and both harnesses skip their response hook for a non-2xx response, which is how a refusal arrives.
 */

import { completionOf, contextKey, outgoingOf, type Completion, type Outgoing } from "./request.ts";

/** A request a session let go, as it must leave, and what to do with it. */
export interface Release {
  /** The session that released it; its responses and stops go there and nowhere else. */
  owner: object;
  base: string;
  query: string;
  context: Outgoing["context"];
  header: string | null;
  body: string;
  /** Whether what the decision relied on still holds at the moment it leaves. */
  current(): boolean;
  /** Called when the request is stopped at the gate instead. */
  stopped(reason: string): void;
  /** Called with the response to the call that sent it. */
  complete(completion: Completion): void;
}

/** A session's say over a POST no release matched: why it must not leave, or null. */
export interface Watcher {
  check(outgoing: Outgoing): string | null;
  stopped(reason: string): void;
}

const REGISTRY = Symbol.for("inference-route-policy.fetch-gate");

/**
 * How long an unused release waits for its request. A harness sends right after the payload hook returns; one
 * that has not sent by then will not, and an old release would only make a later identical one ambiguous.
 */
const RELEASE_TTL_MS = 30_000;

/** A release while it waits. Used or withdrawn, it lets go of the release, and with it the body. */
interface Entry {
  release: Release | null;
  expires: number;
}

interface Registry {
  releases: Entry[];
  watchers: Set<Watcher>;
}

function isRegistry(value: unknown): value is Registry {
  return typeof value === "object" && value !== null && "releases" in value && Array.isArray(value.releases) && "watchers" in value && value.watchers instanceof Set;
}

const matches = (release: Release, outgoing: Outgoing): boolean =>
  outgoing.path.startsWith(`${release.base}/`) &&
  outgoing.query === release.query &&
  outgoing.body === release.body &&
  outgoing.header === release.header &&
  contextKey(outgoing.context) === contextKey(release.context);

/** Takes an entry out of the table and lets go of its release. */
function drop(registry: Registry, entry: Entry): void {
  entry.release = null;
  const index = registry.releases.indexOf(entry);
  if (index >= 0) registry.releases.splice(index, 1);
}

const tell = (notify: () => void): void => {
  try {
    notify();
  } catch {
    // The request's fate does not depend on whether a session could be told.
  }
};

type Plan = { kind: "pass" } | { kind: "stop"; reason: string } | { kind: "send"; release: Release };

/** What to do with one POST. Never throws: a failure to decide is a stop. */
function plan(registry: Registry, outgoing: Outgoing): Plan {
  try {
    const now = Date.now();
    for (const entry of registry.releases.filter((e) => e.expires <= now)) drop(registry, entry);
    const found = registry.releases.filter((entry) => entry.release !== null && matches(entry.release, outgoing));
    const candidates = found.flatMap((entry) => (entry.release === null ? [] : [entry.release]));
    const owners = new Set(candidates.map((release) => release.owner));
    if (owners.size > 1) {
      for (const release of candidates) tell(() => release.stopped("two sessions released this same request, so whose it is cannot be told"));
      return { kind: "stop", reason: "two sessions released this same request, so whose it is cannot be told" };
    }
    const [release] = candidates;
    const [entry] = found;
    if (release !== undefined && entry !== undefined) {
      drop(registry, entry);
      if (!release.current()) {
        const reason = "the detection reply this request was checked against was discarded before it left; send it again";
        tell(() => release.stopped(reason));
        return { kind: "stop", reason };
      }
      return { kind: "send", release };
    }
    let stop: string | null = null;
    for (const watcher of registry.watchers) {
      const reason = watcher.check(outgoing);
      if (reason === null) continue;
      stop ??= reason;
      tell(() => watcher.stopped(reason));
    }
    return stop === null ? { kind: "pass" } : { kind: "stop", reason: stop };
  } catch (error) {
    return { kind: "stop", reason: `the plugin failed while checking the request: ${error instanceof Error ? error.message : "unknown error"}` };
  }
}

function install(): Registry {
  const existing: unknown = Reflect.get(globalThis, REGISTRY);
  if (isRegistry(existing)) return existing;
  const registry: Registry = { releases: [], watchers: new Set() };
  Reflect.set(globalThis, REGISTRY, registry);
  const original = globalThis.fetch;
  const gated = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    let outgoing: Outgoing;
    try {
      outgoing = outgoingOf(input, init);
    } catch {
      // Headers `fetch` itself cannot read make `fetch` fail, before anything is sent.
      return original(input, init);
    }
    if (outgoing.method !== "POST" || (registry.releases.length === 0 && registry.watchers.size === 0)) return original(input, init);
    const next = plan(registry, outgoing);
    if (next.kind === "stop") throw new Error(`Blocked by the route policy plugin, nothing was sent: ${next.reason}`);
    if (next.kind === "pass") return original(input, init);
    // A released request goes where it was released for, and nowhere a redirect would send its body.
    const response = await original(input, { ...init, redirect: "manual" });
    tell(() => next.release.complete(completionOf(response)));
    return response;
  };
  // Keep the runtime's own members of fetch (Bun's `preconnect`, for one).
  globalThis.fetch = Object.assign(gated, original);
  return registry;
}

/** Adds a release to the process's table. Returns the function that withdraws it, if it is still unused. */
export function addRelease(release: Release): () => void {
  const registry = install();
  const entry: Entry = { release, expires: Date.now() + RELEASE_TTL_MS };
  registry.releases.push(entry);
  return () => drop(registry, entry);
}

/** Puts a session's watcher in front of every `fetch`. Returns the function that removes it. */
export function addWatcher(watcher: Watcher): () => void {
  const registry = install();
  registry.watchers.add(watcher);
  return () => registry.watchers.delete(watcher);
}

/** Withdraws every unused release of a session, as when it ends. */
export function withdrawReleases(owner: object): void {
  const registry = install();
  for (const entry of registry.releases.filter((e) => e.release?.owner === owner)) drop(registry, entry);
}
