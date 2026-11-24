/**
 * The last check before a request leaves the process, and the only place its response is read.
 *
 * Both harnesses send provider requests through the process's `fetch`, which this wraps once per process. One
 * release table serves every plugin session in the process. A session releases a request by its exact bytes:
 * base URL and query, context (every header but those known not to identify the caller), `Route-Policy`
 * header, and serialized body. Every POST, and every request of any other method that sends a body (its own, or a
 * `Request` input's that `fetch` would send), is checked; a request the gate cannot read is not sent at all. A
 * request that matches exactly one session's release goes, once, while what its decision relied on holds: the
 * release is used up, so a harness's resend of the same request is not released again. A release withdrawn (its
 * session ended) or gone stale is revoked: it is never sent, and until it expires its body is still recognized.
 * A released request goes with redirects off, so a gateway cannot move the body elsewhere, and the response to
 * that very call goes back to the session that released it. A checked request no usable release matches fails
 * before a byte is written when a session watching its base URL says a policy is at stake, or, where no session
 * says so, when it carries the body of a release still held, live or revoked (the same bytes, or the same JSON
 * written differently: a release is sent only as and where it was released for), when its body cannot be read as
 * text while any release is held (it cannot be compared with them), or when it carries a policy no session
 * checked for that place, in a `Route-Policy` header or a model suffix. Anything else goes untouched.
 *
 * Why here: the harness hooks decide on what the harness tells them, which is not always what goes on the wire,
 * and both harnesses skip their response hook for a non-2xx response, which is how a refusal arrives.
 */

import { completionOf, contextKey, modelIn, outgoingOf, type Completion, type Outgoing } from "./request.ts";

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
 * How long a release is kept. A harness sends right after the payload hook returns; one that has not sent by then
 * will not, and an old release would only make a later identical one ambiguous. A release withdrawn or gone stale
 * is kept, revoked, for the same time, so its content is still recognized wherever else it is sent; past this it
 * is forgotten, on its own, whether or not anything is sent: the table, and the bodies and session callbacks it
 * holds, never outlive this by more than a timer's lateness.
 */
const RELEASE_TTL_MS = 30_000;

/**
 * A release from when it is added until it is used once or expires. Withdrawn (its session ended, or its client
 * let go of it) or gone stale, it is revoked, not forgotten: it can no longer be spent, but its body is still
 * recognized. Settled, it has stopped the one request it was released for, and matches no other.
 */
interface Entry {
  release: Release | null;
  expires: number;
  revoked: boolean;
  settled: boolean;
}

interface Registry {
  releases: Entry[];
  watchers: Set<Watcher>;
  /** The one timer that forgets expired releases on its own, armed while any release is held; null when none is. */
  sweeper?: NodeJS.Timeout | null;
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

/**
 * Each release's body as canonical JSON, once computed (null when it is not JSON). Keyed weakly by the release, so a
 * release the table has let go of takes its body's JSON with it, however long anything else holds its entry.
 */
const releasedJson = new WeakMap<Release, string | null>();

function jsonOf(release: Release): string | null {
  let json = releasedJson.get(release);
  if (json === undefined) {
    json = canonicalJson(release.body);
    releasedJson.set(release, json);
  }
  return json;
}

/** Takes an entry out of the table and lets go of its release, and so of its body: when it is used, or when it expires. */
function drop(registry: Registry, entry: Entry): void {
  entry.release = null;
  const index = registry.releases.indexOf(entry);
  if (index >= 0) registry.releases.splice(index, 1);
}

/** Forgets every expired release, then arms the sweeper for the next one to expire, if any is held. */
function sweep(registry: Registry): void {
  const now = Date.now();
  for (const entry of registry.releases.filter((e) => e.expires <= now)) drop(registry, entry);
  if (registry.sweeper !== undefined && registry.sweeper !== null) return;
  if (registry.releases.length === 0) return;
  const next = Math.min(...registry.releases.map((e) => e.expires));
  const timer = setTimeout(
    () => {
      registry.sweeper = null;
      sweep(registry);
    },
    // Every release left expires after now; at least a millisecond ahead, the timer can never fire in a loop.
    Math.max(next - now, 1),
  );
  // It never keeps a process alive: an idle process exits, and the releases go with it.
  timer.unref();
  registry.sweeper = timer;
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
    sweep(registry);
    // The oldest release this request is still one of, as before revocation: a stale one stops it, and a later
    // identical release is then the next one's. A withdrawn one counts only when no other is left.
    const found = registry.releases.filter((entry) => entry.release !== null && !entry.settled && matches(entry.release, outgoing));
    const active = found.filter((entry) => !entry.revoked);
    const candidates = active.flatMap((entry) => (entry.release === null ? [] : [entry.release]));
    const owners = new Set(candidates.map((release) => release.owner));
    if (owners.size > 1) {
      for (const release of candidates) tell(() => release.stopped("two sessions released this same request, so whose it is cannot be told"));
      return { kind: "stop", reason: "two sessions released this same request, so whose it is cannot be told" };
    }
    const [entry] = active.length > 0 ? active : found;
    const release = entry?.release;
    if (entry !== undefined && release !== null && release !== undefined) {
      if (!entry.revoked && release.current()) {
        drop(registry, entry);
        return { kind: "send", release };
      }
      // Withdrawn, or stale (which revokes it): this request is stopped, and the release is kept until it expires.
      const reason = entry.revoked
        ? "this request was withdrawn before it left (its session ended, or its client let go of it), and a withdrawn release is never sent"
        : "the detection reply this request was checked against was discarded before it left; send it again";
      entry.revoked = true;
      entry.settled = true;
      tell(() => release.stopped(reason));
      return { kind: "stop", reason };
    }
    let stop: string | null = null;
    for (const watcher of registry.watchers) {
      const reason = watcher.check(outgoing);
      if (reason === null) continue;
      stop ??= reason;
      tell(() => watcher.stopped(reason));
    }
    if (stop !== null) return { kind: "stop", reason: stop };
    // No session claims this request. It still fails closed when it carries the body of a release still held, live,
    // stale, or revoked (the same bytes, or the same JSON written differently), anywhere but where that release is
    // spent; when its body cannot be compared with a release still held; or when it carries a policy, on either
    // carrier, that no session checked for where it goes.
    const where = `${outgoing.path}${outgoing.query}`;
    const held = registry.releases.filter((e) => e.release !== null);
    // With nothing held there is nothing to compare a body with, so none is compared, parsed, or rewritten.
    if (held.length > 0) {
      const told = new Set<object>();
      const stopAll = (entries: readonly Entry[], reason: string): Plan => {
        for (const { release } of entries) {
          if (release === null || told.has(release.owner)) continue;
          told.add(release.owner);
          tell(() => release.stopped(reason));
        }
        return { kind: "stop", reason };
      };
      const spent = held.filter((e) => e.release?.body === outgoing.body);
      const [elsewhere] = spent;
      if (elsewhere?.release) return stopAll(spent, `this request to ${where} is one released for ${elsewhere.release.base}${elsewhere.release.query}, and a release is sent only where it was released for`);
      // The same JSON in other bytes, compared by canonical text, computed once per release.
      const json = outgoing.body === null ? null : canonicalJson(outgoing.body);
      const rewritten = json === null ? [] : held.filter((e) => e.release !== null && jsonOf(e.release) === json);
      const [same] = rewritten;
      if (same?.release) {
        return stopAll(rewritten, `this request to ${where} carries, written differently, the JSON body of one released for ${same.release.base}${same.release.query}, and a release is sent only as it was released, where it was released for`);
      }
      if (outgoing.body === null) {
        return { kind: "stop", reason: `this request to ${where} has a body that cannot be read as text, so it cannot be compared with the requests released and not yet expired` };
      }
    }
    if (outgoing.header !== null) return { kind: "stop", reason: `this request to ${where} carries a Route-Policy header, and no session checked ${where} for it` };
    // The other carrier: a model suffix. Only a body with a "+" in it, written or escaped, can have one, so only such
    // a body is parsed.
    if (outgoing.body !== null && /\+|\\u002b/i.test(outgoing.body) && (modelIn(outgoing.body) ?? "").includes("+")) {
      return { kind: "stop", reason: `this request to ${where} carries a policy in its model suffix, and no session checked ${where} for it` };
    }
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
    } catch (error) {
      // A URL or headers `fetch` cannot send either: nothing can be checked, so nothing is sent.
      throw new Error(`Blocked by the route policy plugin, nothing was sent: the request could not be read (${error instanceof Error ? error.message : "unknown error"})`);
    }
    // The one request the gate does not check: not a POST, and no body (`outgoingOf` decides that, as `fetch` does).
    if (outgoing.method !== "POST" && outgoing.body === "") return original(input, init);
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

/** Adds a release to the process's table. Returns the function that withdraws it: revoked, if it is still unused. */
export function addRelease(release: Release): () => void {
  const registry = install();
  const entry: Entry = { release, expires: Date.now() + RELEASE_TTL_MS, revoked: false, settled: false };
  registry.releases.push(entry);
  sweep(registry);
  return () => {
    entry.revoked = true;
  };
}

/** Puts a session's watcher in front of every `fetch`. Returns the function that removes it. */
export function addWatcher(watcher: Watcher): () => void {
  const registry = install();
  registry.watchers.add(watcher);
  return () => registry.watchers.delete(watcher);
}

/** Revokes every unused release of a session, as when it ends: none can be spent, each is still recognized. */
export function withdrawReleases(owner: object): void {
  const registry = install();
  for (const entry of registry.releases.filter((e) => e.release?.owner === owner)) entry.revoked = true;
}
