/**
 * The last check before a request leaves the process, and the only place its response is read.
 *
 * Both harnesses send provider requests through the process's `fetch`, which this wraps once per process. One
 * release table serves every plugin session in the process. A session releases a request by its exact bytes:
 * base URL and query, context (every header but those known not to identify the caller), `Route-Policy`
 * header, and serialized body. Every POST, and every request of any other method that sends a body, is checked;
 * a request that matches exactly one session's release goes, once: the release is used up, so a harness's resend
 * of the same request is not released again. It goes with redirects off, so a gateway cannot move the body
 * elsewhere, and the response to that very call goes back to the session that released it. A checked request no
 * release matches fails before a byte is written when a session watching its base URL says a policy is at stake,
 * or, where no session says so, when it carries an outstanding release's body (the same bytes, or the same JSON
 * written differently: a release is sent only as and where it was released for), when its body cannot be read as
 * text while any release is outstanding (it cannot be compared with them), or when it carries a `Route-Policy`
 * header no session checked for that place. Anything else goes untouched.
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
  /** The release's body as canonical JSON, once computed; null when it is not JSON. */
  json?: string | null;
}

interface Registry {
  releases: Entry[];
  watchers: Set<Watcher>;
}

function isRegistry(value: unknown): value is Registry {
  return typeof value === "object" && value !== null && "releases" in value && Array.isArray(value.releases) && "watchers" in value && value.watchers instanceof Set;
}

/**
 * Whether a path is the base URL's path with one endpoint path appended: what follows the base is a "/" and a
 * nonempty path that does not itself start with "/". A request to "{base}//x" went to the base "{base}/", not the
 * one whose metadata was read.
 */
const under = (base: string, path: string): boolean => path.startsWith(`${base}/`) && path.length > base.length + 1 && path[base.length + 1] !== "/";

const matches = (release: Release, outgoing: Outgoing): boolean =>
  under(release.base, outgoing.path) &&
  outgoing.query === release.query &&
  outgoing.body === release.body &&
  outgoing.header === release.header &&
  contextKey(outgoing.context) === contextKey(release.context);

/** A JSON value with every object's members in one order, so two texts of the same JSON compare equal. */
const ordered = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(ordered)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(Reflect.get(value, key))]))
      : value;

/** A text's JSON value written one way, whatever its whitespace and member order; null when it is not JSON. */
function canonicalJson(text: string): string | null {
  try {
    return JSON.stringify(ordered(JSON.parse(text)));
  } catch {
    return null;
  }
}

/** Whether a fetch call sends a body: `init`'s when it names one, else a `Request` input's own. */
function sendsBody(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): boolean {
  const body = init !== undefined && "body" in init ? init.body : input instanceof Request ? input.body : null;
  return body !== undefined && body !== null;
}

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

/** What to do with one checked request. Never throws: a failure to decide is a stop. */
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
    if (stop !== null) return { kind: "stop", reason: stop };
    // No session claims this request. It still fails closed when it is a release being spent somewhere other than
    // its own place, or as other bytes; when its body cannot be compared with a release that is outstanding; or
    // when it carries a policy that no session checked for where it goes.
    const where = `${outgoing.path}${outgoing.query}`;
    const live = registry.releases.filter((e) => e.release !== null && e.release.current());
    const told = new Set<object>();
    const stopAll = (entries: readonly Entry[], reason: string): Plan => {
      for (const { release } of entries) {
        if (release === null || told.has(release.owner)) continue;
        told.add(release.owner);
        tell(() => release.stopped(reason));
      }
      return { kind: "stop", reason };
    };
    const spent = live.filter((e) => e.release?.body === outgoing.body);
    const [elsewhere] = spent;
    if (elsewhere?.release) return stopAll(spent, `this request to ${where} is one released for ${elsewhere.release.base}${elsewhere.release.query}, and a release is sent only where it was released for`);
    // The same JSON in other bytes, compared by canonical text, computed once per release.
    const json = outgoing.body === null ? null : canonicalJson(outgoing.body);
    const rewritten =
      json === null
        ? []
        : live.filter((e) => {
            if (e.json === undefined) e.json = e.release === null ? null : canonicalJson(e.release.body);
            return e.json === json;
          });
    const [same] = rewritten;
    if (same?.release) {
      return stopAll(rewritten, `this request to ${where} carries, written differently, the JSON body of one released for ${same.release.base}${same.release.query}, and a release is sent only as it was released, where it was released for`);
    }
    if (outgoing.body === null && live.length > 0) {
      return { kind: "stop", reason: `this request to ${where} has a body that cannot be read as text, so it cannot be compared with the requests released and not yet sent` };
    }
    if (outgoing.header !== null) return { kind: "stop", reason: `this request to ${where} carries a Route-Policy header, and no session checked ${where} for it` };
    return { kind: "pass" };
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
    // A request that sends no body, other than a POST, carries no content to release; everything else is checked,
    // whether or not any session has released or watches anything yet.
    if (outgoing.method !== "POST" && !sendsBody(input, init)) return original(input, init);
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
