/**
 * Inference Route Policy: the grammar, the order of checks, the combining rules, and the matching rules of SPEC.md
 * as pure functions. No runtime dependency and no I/O, so gateways and clients share one reading of the spec.
 *
 * Every list and map a function returns is its own: changing it never changes an input or another result.
 */

import { COUNTRIES } from "./countries.ts";

export const LIMITS = Object.freeze({ policyBytes: 512, pairs: 16, items: 16 });

const BASELINE_KEYS: readonly string[] = ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "sort", "order"];
const BASELINE_ATTEST: readonly string[] = ["weights", "prompt"];
const BASELINE_SORT: readonly string[] = ["price", "latency", "throughput"];

/** Keys whose presence restricts which routes qualify. `sort` and `order` only order them. */
const REQUIREMENT_KEYS: readonly string[] = ["zdr", "notrain", "bits", "region", "attest", "only", "ignore"];
/** Keys a route's facts may never carry, because they are not facts. */
const NOT_FACTS: Readonly<Record<string, true>> = { only: true, ignore: true, sort: true, order: true };

const KEY_SOURCE = "[a-z][a-z0-9]{0,15}";
const KEY = new RegExp(`^${KEY_SOURCE}$`);
const ITEM = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
const BITS = /^[1-9][0-9]?$/;
const REFUSED = new RegExp(`^reason=(unsupported|unsatisfiable|unavailable)(?:\\+key=(${KEY_SOURCE}))?$`);

/** A flag (`true`) or a list, as written. */
export type Value = true | readonly string[];

/** What a gateway accepts, as its detection reply states it. */
export interface Support {
  readonly keys: ReadonlySet<string>;
  readonly attest: ReadonlySet<string>;
  readonly sort: ReadonlySet<string>;
}

/** The fixed defaults of a detection reply that lists nothing. A fresh object each call, so no caller can change them. */
export function baselineSupport(): Support {
  return { keys: new Set(BASELINE_KEYS), attest: new Set(BASELINE_ATTEST), sort: new Set(BASELINE_SORT) };
}

export interface Policy {
  zdr: boolean;
  notrain: boolean;
  bits: number | null;
  region: readonly string[] | null;
  attest: readonly string[];
  only: readonly string[] | null;
  ignore: readonly string[];
  sort: string | null;
  order: readonly string[] | null;
}

export interface Facts {
  zdr: boolean;
  notrain: boolean;
  bits: number | null;
  region: readonly string[] | null;
  /** May hold items this revision does not define, read from a gateway on a later one. They match nothing here. */
  attest: readonly string[];
  /** Well-formed keys this revision does not define, read from a gateway on a later one. Carried, never matched. */
  other: ReadonlyMap<string, Value>;
}

export interface Failure {
  ok: false;
  /** The key the failure names, when it names one (SPEC.md, Order of checks). */
  key: string | null;
  detail: string;
}

export type Result<T> = { ok: true; value: T } | Failure;

const fail = (key: string | null, detail: string): Failure => ({ ok: false, key, detail });

/**
 * Walks a policy or facts string in the spec's order of checks (S16): the whole-string limits, then each pair as
 * written. A pair fails on its grammar, a repeated key, or `check`. Returns the first failure, which names the
 * pair's key when that key is well formed.
 */
function walk(text: string, check: (key: string, value: Value) => Failure | null): Failure | null {
  if (new TextEncoder().encode(text).length > LIMITS.policyBytes) return fail(null, `longer than ${LIMITS.policyBytes} bytes`);
  const parts = text.split("+");
  if (parts.length > LIMITS.pairs) return fail(null, `more than ${LIMITS.pairs} pairs`);
  const seen = new Set<string>();
  for (const part of parts) {
    const eq = part.indexOf("=");
    const key = eq < 0 ? part : part.slice(0, eq);
    if (!KEY.test(key)) return fail(null, `malformed key in "${part}"`);
    let value: Value = true;
    if (eq >= 0) {
      const items = part.slice(eq + 1).split(",");
      for (const item of items) if (!ITEM.test(item)) return fail(key, `malformed item "${item}"`);
      if (items.length > LIMITS.items) return fail(key, `more than ${LIMITS.items} items`);
      if (new Set(items).size !== items.length) return fail(key, "repeated item");
      value = items;
    }
    if (seen.has(key)) return fail(key, "repeated key");
    seen.add(key);
    const failure = check(key, value);
    if (failure !== null) return failure;
  }
  return null;
}

/** `bits` as an integer 1 to 64, or null when the value is not one (S6). */
function bitsOf(value: Value): number | null {
  if (value === true || value.length !== 1 || !BITS.test(value[0]!)) return null;
  const n = Number(value[0]);
  return n <= 64 ? n : null;
}

/** A `region` value as its list, or null when it is a flag or names a code ISO 3166-1 has not assigned (S7). */
const countriesOf = (value: Value): readonly string[] | null => (value !== true && value.every((code) => Object.hasOwn(COUNTRIES, code)) ? value : null);

/**
 * Why a value is not valid for a key this revision defines, or null when it is. `attest` and `sort` are valid only
 * within the lists given; the other keys have a fixed domain (SPEC.md, Keys and Detection).
 */
function valueFailure(key: string, value: Value, attest: ReadonlySet<string>, sort: ReadonlySet<string>): Failure | null {
  switch (key) {
    case "zdr":
    case "notrain":
      return value === true ? null : fail(key, "takes no value");
    case "bits":
      return bitsOf(value) === null ? fail(key, "takes one integer from 1 to 64") : null;
    case "region":
      return countriesOf(value) === null ? fail(key, "takes a list of assigned ISO 3166-1 alpha-2 codes") : null;
    case "attest":
      return value === true || !value.every((item) => attest.has(item)) ? fail(key, "value not accepted") : null;
    case "only":
    case "ignore":
    case "order":
      return value === true ? fail(key, "takes a list of provider ids") : null;
    case "sort":
      return value === true || value.length !== 1 || !sort.has(value[0]!) ? fail(key, "value not accepted") : null;
    default:
      return fail(key, "key not defined");
  }
}

/** The members of `listed` that this revision defines: listing a value does not define it. */
const defined = (listed: ReadonlySet<string>, baseline: readonly string[]): ReadonlySet<string> => new Set(baseline.filter((value) => listed.has(value)));

/**
 * Parses one carrier's policy against what the gateway accepts (S1 to S10, S16). The result is the whole policy or
 * the first failure in the spec's order of checks.
 */
export function parsePolicy(text: string, support: Support = baselineSupport()): Result<Policy> {
  const attest = defined(support.attest, BASELINE_ATTEST);
  const sort = defined(support.sort, BASELINE_SORT);
  const pairs = new Map<string, Value>();
  const failure = walk(text, (key, value) => {
    if (!support.keys.has(key)) return fail(key, "key not accepted");
    const invalid = valueFailure(key, value, attest, sort);
    if (invalid === null) pairs.set(key, value);
    return invalid;
  });
  if (failure !== null) return failure;
  const list = (key: string): readonly string[] | null => {
    const value = pairs.get(key);
    return value === undefined || value === true ? null : value;
  };
  return {
    ok: true,
    value: {
      zdr: pairs.has("zdr"),
      notrain: pairs.has("notrain"),
      bits: pairs.has("bits") ? bitsOf(pairs.get("bits")!) : null,
      region: list("region"),
      attest: list("attest") ?? [],
      only: list("only"),
      ignore: list("ignore") ?? [],
      sort: list("sort")?.[0] ?? null,
      order: list("order"),
    },
  };
}

const listPair = (key: string, items: readonly string[]): string => `${key}=${items.join(",")}`;

/**
 * The policy as a string that is valid on a carrier, keys in a fixed order. Fails when no string says exactly what
 * the policy says: it says nothing, an intersection left `region` or `only` empty, a list is over a limit, or a
 * field holds something its key does not allow, such as an item with a comma in it, which would read back as two.
 * A combined policy is a decision and need not be writable (SPEC.md, Combining), so a client that must send one
 * checks here first.
 */
export function formatPolicy(policy: Policy): Result<string> {
  const out: string[] = [];
  if (policy.zdr) out.push("zdr");
  if (policy.notrain) out.push("notrain");
  if (policy.bits !== null) out.push(`bits=${policy.bits}`);
  if (policy.region !== null) out.push(listPair("region", policy.region));
  if (policy.attest.length > 0) out.push(listPair("attest", policy.attest));
  if (policy.only !== null) out.push(listPair("only", policy.only));
  if (policy.ignore.length > 0) out.push(listPair("ignore", policy.ignore));
  if (policy.sort !== null) out.push(`sort=${policy.sort}`);
  if (policy.order !== null) out.push(listPair("order", policy.order));
  const text = out.join("+");
  const parsed = parsePolicy(text);
  if (!parsed.ok) return parsed;
  // Joining can change meaning without breaking the grammar, so the string must read back as the same policy.
  const same = (a: readonly string[] | null, b: readonly string[] | null): boolean => (a === null || b === null ? a === b : a.length === b.length && a.every((item, i) => item === b[i]));
  const read = parsed.value;
  const unchanged =
    read.zdr === policy.zdr &&
    read.notrain === policy.notrain &&
    read.bits === policy.bits &&
    read.sort === policy.sort &&
    same(read.region, policy.region) &&
    same(read.attest, policy.attest) &&
    same(read.only, policy.only) &&
    same(read.ignore, policy.ignore) &&
    same(read.order, policy.order);
  return unchanged ? { ok: true, value: text } : fail(null, "holds a value that does not read back as written");
}

/** The keys a policy uses, for checking them against a detection reply. */
export function keysOf(policy: Policy): string[] {
  const keys: string[] = [];
  if (policy.zdr) keys.push("zdr");
  if (policy.notrain) keys.push("notrain");
  if (policy.bits !== null) keys.push("bits");
  if (policy.region !== null) keys.push("region");
  if (policy.attest.length > 0) keys.push("attest");
  if (policy.only !== null) keys.push("only");
  if (policy.ignore.length > 0) keys.push("ignore");
  if (policy.sort !== null) keys.push("sort");
  if (policy.order !== null) keys.push("order");
  return keys;
}

/** Whether the policy restricts which routes qualify. One that only orders them may be sent without detection. */
export function hasRequirements(policy: Policy): boolean {
  return keysOf(policy).some((key) => REQUIREMENT_KEYS.includes(key));
}

/**
 * Whether a detection reply lists every key the policy uses and every `attest` and `sort` value it uses: what a
 * client must hold before sending a requirement (C1). Other keys have no list of values to check.
 */
export function supports(support: Support, policy: Policy): boolean {
  return (
    keysOf(policy).every((key) => support.keys.has(key)) &&
    policy.attest.every((item) => support.attest.has(item)) &&
    (policy.sort === null || support.sort.has(policy.sort))
  );
}

/**
 * Splits a `model` field at its first `+`, without judging either half (S11). `policy` is null when there is no
 * `+`. The id may be empty, which names no model.
 */
export function splitModel(model: string): { id: string; policy: string | null } {
  const plus = model.indexOf("+");
  return plus < 0 ? { id: model, policy: null } : { id: model.slice(0, plus), policy: model.slice(plus + 1) };
}

const union = (lists: readonly (readonly string[])[]): string[] => [...new Set(lists.flat())];

function intersection(lists: readonly (readonly string[] | null)[]): string[] | null {
  const present = lists.filter((list) => list !== null);
  if (present.length === 0) return null;
  return present.slice(1).reduce<string[]>((acc, list) => acc.filter((item) => list.includes(item)), [...present[0]!]);
}

/**
 * Combines the policies that reached one request (SPEC.md, Combining). Requirements accumulate; the most specific
 * preference wins. An empty `region` or `only` in the result means no route can qualify. The result is a decision:
 * it may be over a limit, and `formatPolicy` says whether it can be written.
 */
export function combinePolicies(layers: { key?: Policy; header?: Policy; suffix?: Policy }): Policy {
  const bySpecificity = [layers.suffix, layers.header, layers.key].filter((p) => p !== undefined);
  const bits = bySpecificity.map((p) => p.bits).filter((b) => b !== null);
  const order = bySpecificity.find((p) => p.order !== null)?.order ?? null;
  return {
    zdr: bySpecificity.some((p) => p.zdr),
    notrain: bySpecificity.some((p) => p.notrain),
    bits: bits.length > 0 ? Math.max(...bits) : null,
    region: intersection(bySpecificity.map((p) => p.region)),
    attest: union(bySpecificity.map((p) => p.attest)),
    only: intersection(bySpecificity.map((p) => p.only)),
    ignore: union(bySpecificity.map((p) => p.ignore)),
    sort: bySpecificity.find((p) => p.sort !== null)?.sort ?? null,
    order: order === null ? null : [...order],
  };
}

/**
 * Reads a route's facts as a client must (S13). The empty string is a route that meets nothing. Fails on invalid
 * facts: outside the grammar or limits, an invalid value for `zdr`, `notrain`, `bits`, or `region`, or a key that
 * can never be a fact. The caller then treats the route as meeting no policy that has a requirement. A well-formed
 * key this revision does not define is kept in `other`, and an unknown `attest` item is kept in `attest`; neither
 * is ever matched, since this reader cannot have required it.
 */
export function parseFacts(text: string): Result<Facts> {
  const facts: Facts = { zdr: false, notrain: false, bits: null, region: null, attest: [], other: new Map() };
  if (text === "") return { ok: true, value: facts };
  const other = new Map<string, Value>();
  const failure = walk(text, (key, value) => {
    switch (key) {
      case "zdr":
      case "notrain":
        if (value !== true) return fail(key, "takes no value");
        facts[key] = true;
        return null;
      case "bits":
        facts.bits = bitsOf(value);
        return facts.bits === null ? fail(key, "takes one integer from 1 to 64") : null;
      case "region":
        facts.region = countriesOf(value);
        return facts.region === null ? fail(key, "takes a list of assigned ISO 3166-1 alpha-2 codes") : null;
      case "attest":
        if (value === true) return fail(key, "takes a list");
        facts.attest = value;
        return null;
      default:
        if (Object.hasOwn(NOT_FACTS, key)) return fail(key, "is not a fact");
        other.set(key, value);
        return null;
    }
  });
  if (failure !== null) return failure;
  facts.other = other;
  return { ok: true, value: facts };
}

/**
 * Checks a facts string a gateway is about to publish (S12): everything `parseFacts` checks, and nothing beyond the
 * five fact keys, with only the `attest` values this revision defines. What a gateway may publish does not depend
 * on which keys it accepts in requests.
 */
export function parsePublishedFacts(text: string): Result<Facts> {
  const parsed = parseFacts(text);
  if (!parsed.ok) return parsed;
  const unknownAttest = parsed.value.attest.find((item) => !BASELINE_ATTEST.includes(item));
  if (unknownAttest !== undefined) return fail("attest", `"${unknownAttest}" is not an attest value`);
  const [unknownKey] = parsed.value.other.keys();
  return unknownKey === undefined ? parsed : fail(unknownKey, "is not a fact a gateway may publish");
}

/** Whether a route meets a policy (SPEC.md, Facts). A fact that is absent is not met. */
export function meets(route: { provider: string; facts: Facts }, policy: Policy): boolean {
  const { provider, facts } = route;
  if (policy.zdr && !facts.zdr) return false;
  if (policy.notrain && !facts.notrain) return false;
  if (policy.bits !== null && (facts.bits === null || facts.bits < policy.bits)) return false;
  if (policy.region !== null) {
    const allowed = policy.region;
    if (facts.region === null || !facts.region.every((country) => allowed.includes(country))) return false;
  }
  if (!policy.attest.every((item) => facts.attest.includes(item))) return false;
  if (policy.only !== null && !policy.only.includes(provider)) return false;
  return !policy.ignore.includes(provider);
}

/**
 * Orders routes that already qualify: `order` providers first as listed, then the rest by `rank` ascending for the
 * policy's `sort`, or as given when it has none. Ties keep the given order.
 */
export function orderRoutes<T extends { provider: string }>(routes: readonly T[], policy: Policy, rank: (route: T, sort: string) => number): T[] {
  const first = (policy.order ?? []).flatMap((id) => routes.filter((route) => route.provider === id));
  const rest = routes.filter((route) => !first.includes(route));
  const sort = policy.sort;
  if (sort !== null) {
    const ranked = new Map(rest.map((route) => [route, rank(route, sort)]));
    rest.sort((a, b) => ranked.get(a)! - ranked.get(b)!);
  }
  return [...first, ...rest];
}

/** Whether a value can be a provider id on the wire (S17). Anything that is not a string is not one. */
export const isProviderId = (id: unknown): id is string => typeof id === "string" && ITEM.test(id);

/** Whether a value is an absolute URI with no comma and no whitespace: an `evidence` URI or a `Route-Evidence` value (S18). */
export const isEvidenceUri = (uri: unknown): uri is string => typeof uri === "string" && /^[A-Za-z][A-Za-z0-9+.-]*:[^\s,]+$/.test(uri);

/**
 * The `Route-Applied` value for the route whose response is relayed (S14). Throws on a provider id that is not an
 * item: a gateway checks its ids when it loads its routes, so one reaching here is a programming error, and writing
 * it would produce a header no reader accepts.
 */
export function formatApplied(provider: string): string {
  if (!isProviderId(provider)) throw new RangeError(`"${String(provider)}" is not a provider id`);
  return `provider=${provider}`;
}

/** Reads `Route-Applied` (S14) and returns the provider id it names. Two lines joined into one value do not parse. */
export function parseApplied(text: string): Result<string> {
  const prefix = "provider=";
  if (!text.startsWith(prefix)) return fail("provider", "does not begin with the provider");
  const provider = text.slice(prefix.length);
  return isProviderId(provider) ? { ok: true, value: provider } : fail("provider", "is not exactly one provider id");
}

export type RefusalReason = "unsupported" | "unsatisfiable" | "unavailable";

/** HTTP status of each refusal (SPEC.md, Refusal). */
export const REFUSAL_STATUS: Readonly<Record<RefusalReason, number>> = Object.freeze({ unsupported: 400, unsatisfiable: 400, unavailable: 503 });

/**
 * The `Route-Refused` value (S15). Only an `unsupported` refusal names a key. Throws on a reason or key that is
 * not one, for the same reason `formatApplied` throws; the check is at run time, so it holds for untyped callers.
 */
export function formatRefused(reason: "unsupported", key?: string | null): string;
export function formatRefused(reason: "unsatisfiable" | "unavailable"): string;
export function formatRefused(reason: RefusalReason, key: string | null = null): string {
  if (typeof reason !== "string" || !Object.hasOwn(REFUSAL_STATUS, reason)) throw new RangeError(`"${String(reason)}" is not a refusal reason`);
  if (key === null) return `reason=${reason}`;
  if (reason !== "unsupported" || typeof key !== "string" || !KEY.test(key)) throw new RangeError(`cannot name key "${String(key)}" in a "${reason}" refusal`);
  return `reason=${reason}+key=${key}`;
}

/** Reads `Route-Refused` (S15). A value that does not match is still a refusal to the client; it just has no reason to show. */
export function parseRefused(text: string): Result<{ reason: RefusalReason; key: string | null }> {
  const match = REFUSED.exec(text);
  const reason = match?.[1];
  if (reason !== "unsupported" && reason !== "unsatisfiable" && reason !== "unavailable") return fail(null, "not a Route-Refused value");
  const key = match?.[2] ?? null;
  if (key !== null && reason !== "unsupported") return fail("key", `a key is named only with "unsupported"`);
  return { ok: true, value: { reason, key } };
}

export interface Detection {
  /** What this client can use: the reply's lists, without keys and values this revision does not define. */
  support: Support;
  /**
   * The policy bound to the key the detection request carried, as sent; null when there is none. It was checked
   * against the reply's lists as given, so it may use a key or value from a later revision that `support` lacks.
   * `parsePolicy(keyPolicy, support)` says whether this client can interpret it.
   */
  keyPolicy: string | null;
}

/** An own member that is a list of strings each matching `shape`; `fallback` when absent; null when present and wrong. */
function ownList(reply: object, name: string, shape: RegExp, fallback: readonly string[]): string[] | null {
  if (!Object.hasOwn(reply, name)) return [...fallback];
  const value: unknown = Reflect.get(reply, name);
  if (!Array.isArray(value)) return null;
  // Array.from fills holes with undefined, so a sparse array, which is not a JSON list, fails like any non-string.
  const entries: unknown[] = Array.from(value);
  return entries.every((entry): entry is string => typeof entry === "string" && shape.test(entry)) ? entries : null;
}

/**
 * Reads a detection reply body (SPEC.md, Detection). A reply is valid only when every known member is: anything
 * else is no detection. From a valid one, members, keys, and `attest`/`sort` values this revision does not define
 * are dropped from `support`, since this client cannot use them. Members are read as the object's own, never
 * inherited.
 */
export function parseDetection(body: unknown): Result<Detection> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail(null, "not a JSON object");
  if (!Object.hasOwn(body, "route_policy") || Reflect.get(body, "route_policy") !== 1) return fail("route_policy", "is not 1");
  const keys = ownList(body, "keys", KEY, BASELINE_KEYS);
  const attest = ownList(body, "attest", ITEM, BASELINE_ATTEST);
  const sort = ownList(body, "sort", ITEM, BASELINE_SORT);
  if (keys === null) return fail("keys", "is not a list of keys");
  if (attest === null) return fail("attest", "is not a list of items");
  if (sort === null) return fail("sort", "is not a list of items");

  let keyPolicy: string | null = null;
  if (Object.hasOwn(body, "key_policy")) {
    const bound: unknown = Reflect.get(body, "key_policy");
    if (typeof bound !== "string") return fail("key_policy", "is not a string");
    // Checked against the lists exactly as given. A listed key from a later revision passes with any well-formed value.
    const listed = { keys: new Set(keys), attest: new Set(attest), sort: new Set(sort) };
    const failure = walk(bound, (key, value) => {
      if (!listed.keys.has(key)) return fail(key, "key not listed");
      return BASELINE_KEYS.includes(key) ? valueFailure(key, value, listed.attest, listed.sort) : null;
    });
    if (failure !== null) return fail("key_policy", `fails the order of checks under the reply's lists: ${failure.detail}`);
    keyPolicy = bound;
  }

  return {
    ok: true,
    value: {
      support: { keys: defined(new Set(keys), BASELINE_KEYS), attest: defined(new Set(attest), BASELINE_ATTEST), sort: defined(new Set(sort), BASELINE_SORT) },
      keyPolicy,
    },
  };
}

/**
 * The detection reply body a gateway with this `support` sends. Throws on anything a client would not accept or
 * the gateway could not honor: a list entry this revision does not define, which `parsePolicy` would refuse
 * however it is listed, or a bound policy that fails the order of checks, which the gateway may not bind (G36).
 */
export function formatDetection(support: Support, keyPolicy: string | null = null): Record<string, unknown> {
  const lists: [name: string, listed: ReadonlySet<string>, definedHere: readonly string[]][] = [
    ["keys", support.keys, BASELINE_KEYS],
    ["attest", support.attest, BASELINE_ATTEST],
    ["sort", support.sort, BASELINE_SORT],
  ];
  for (const [name, listed, definedHere] of lists) {
    const unknown = [...listed].find((entry) => !definedHere.includes(entry));
    if (unknown !== undefined) throw new RangeError(`"${String(unknown)}" in ${name} is not defined by this revision`);
  }
  if (keyPolicy !== null) {
    const bound = parsePolicy(keyPolicy, support);
    if (!bound.ok) throw new RangeError(`key policy "${keyPolicy}" fails the order of checks: ${bound.detail}`);
  }
  return {
    route_policy: 1,
    keys: [...support.keys],
    attest: [...support.attest],
    sort: [...support.sort],
    ...(keyPolicy === null ? {} : { key_policy: keyPolicy }),
  };
}

/**
 * Whether a client may send a request carrying these policies, by either carrier, to a base URL whose detection
 * reply gave `support` (null when it has no valid reply) (C1, C2). With any requirement among them, the reply must
 * list every key and every `attest` and `sort` value that any of them uses, preferences included.
 */
export function clearedToSend(support: Support | null, policies: readonly Policy[]): boolean {
  if (!policies.some(hasRequirements)) return true;
  return support !== null && policies.every((policy) => supports(support, policy));
}

/** The values of each result header's field lines, or one joined value each where that is all the client can see. */
export interface ResultHeaders {
  applied: readonly string[];
  refused: readonly string[];
  evidence: readonly string[];
}

export type Outcome =
  | { outcome: "refused"; reason: RefusalReason | null; key: string | null }
  /** `checked` is false when the client had no model list to compare the route's published facts with (C4). */
  | { outcome: "honored"; provider: string; evidence: string | null; checked: boolean }
  | { outcome: "not-honored"; why: string };

/**
 * What a response says about the policy a client sent with a requirement (C3, C4, C5). Any `Route-Refused` is a
 * refusal, parsed or not, whatever else is there. Otherwise the policy is honored only by exactly one valid
 * `Route-Applied` and, when `sent` has `attest`, exactly one valid `Route-Evidence`. `routes` is the published
 * facts string of each route of the model by provider id, from the gateway's model list, or null when the client
 * has none: with it, the named provider must be published there with valid facts that meet `sent`; without it,
 * only the provider-id requirements can be checked.
 */
export function readOutcome(headers: ResultHeaders, sent: Policy, routes: ReadonlyMap<string, string> | null): Outcome {
  if (headers.refused.length > 0) {
    const parsed = headers.refused.length === 1 ? parseRefused(headers.refused[0]!) : null;
    return parsed?.ok ? { outcome: "refused", ...parsed.value } : { outcome: "refused", reason: null, key: null };
  }
  const notHonored = (why: string): Outcome => ({ outcome: "not-honored", why });
  if (headers.applied.length !== 1) return notHonored(headers.applied.length === 0 ? "no Route-Applied" : "more than one Route-Applied");
  const applied = parseApplied(headers.applied[0]!);
  if (!applied.ok) return notHonored(`Route-Applied is not valid: ${applied.detail}`);
  const provider = applied.value;

  let evidence: string | null = null;
  if (sent.attest.length > 0) {
    const [uri] = headers.evidence;
    if (headers.evidence.length !== 1 || !isEvidenceUri(uri)) return notHonored("attest was required and there is not exactly one valid Route-Evidence");
    evidence = uri;
  }

  if (routes === null) {
    const named = (sent.only === null || sent.only.includes(provider)) && !sent.ignore.includes(provider);
    return named ? { outcome: "honored", provider, evidence, checked: false } : notHonored(`provider "${provider}" is excluded by the policy sent`);
  }
  const published = routes.get(provider);
  if (published === undefined) return notHonored(`provider "${provider}" is not among the model's published routes`);
  const facts = parseFacts(published);
  if (!facts.ok) return notHonored(`the facts published for "${provider}" are not valid: ${facts.detail}`);
  return meets({ provider, facts: facts.value }, sent) ? { outcome: "honored", provider, evidence, checked: true } : notHonored(`route "${provider}" does not meet the policy sent`);
}
