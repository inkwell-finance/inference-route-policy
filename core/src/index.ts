/**
 * Inference Route Policy: the grammar, the order of checks, the combining rules, and the matching rules of SPEC.md
 * as pure functions. No runtime dependency and no I/O, so gateways and clients share one reading of the spec.
 *
 * Every list and map a function returns is its own: changing it never changes an input or another result.
 */

import { COUNTRIES } from "./countries.ts";

export const LIMITS = Object.freeze({ policyBytes: 512, pairs: 16, items: 16 });

const BASELINE_KEYS = ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "sort", "order"] as const;
const BASELINE_ATTEST = ["weights", "prompt"] as const;
const BASELINE_SORT = ["price", "latency", "throughput"] as const;

/** Keys this revision defines whose presence restricts which routes qualify. Vendor keys do too. */
const REQUIREMENT_KEYS = ["zdr", "notrain", "bits", "region", "attest", "only", "ignore"] as const;
/** Keys this revision defines that a route's facts may not carry. */
const NOT_FACTS: Readonly<Record<string, true>> = { only: true, ignore: true, sort: true, order: true };

const NAME = "[a-z][a-z0-9]{0,15}";
const KEY_SOURCE = `${NAME}(?:\\.${NAME})?`;
const KEY = new RegExp(`^${KEY_SOURCE}$`);
const ITEM = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
const BITS = /^[1-9][0-9]?$/;
const REFUSED = new RegExp(`^reason=(unsupported|unsatisfiable|unavailable)(?:\\+key=(${KEY_SOURCE}))?$`);

/** A flag (`true`) or a list, as written. */
export type Value = true | readonly string[];

/** What a gateway accepts, as its detection reply states it. Vendor keys it lists are in `keys`. */
export interface Support {
  readonly keys: ReadonlySet<string>;
  readonly attest: ReadonlySet<string>;
  readonly sort: ReadonlySet<string>;
}

/** The fixed defaults of a detection reply that lists nothing. A fresh object each call, so no caller can change them. */
export function baselineSupport(): Support {
  return { keys: new Set(BASELINE_KEYS), attest: new Set(BASELINE_ATTEST), sort: new Set(BASELINE_SORT) };
}

/** A gateway's definition of one vendor key (SPEC.md, Vendor keys). */
export interface VendorRule {
  /** Whether the gateway accepts this value for the key. */
  accepts(value: Value): boolean;
  /** Whether a route that publishes `fact` under the key meets `required`. Never called for a route without the key. */
  meets(required: Value, fact: Value): boolean;
  /** What two carriers' values combine to, or null when they cannot. Absent: the two must be identical. */
  combine?(a: Value, b: Value): Value | null;
}

export type VendorRules = ReadonlyMap<string, VendorRule>;

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
  /** Vendor keys, which only the gateway that defines them accepts. Always requirements. */
  vendor: ReadonlyMap<string, Value>;
}

export interface Facts {
  zdr: boolean;
  notrain: boolean;
  bits: number | null;
  region: readonly string[] | null;
  attest: readonly string[];
  /** Vendor keys, and well-formed keys this revision does not define. Carried, and matched only by a vendor rule. */
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

const copy = (value: Value): Value => (value === true ? true : [...value]);

/**
 * Walks a policy or facts string in the spec's order of checks (S16): the whole-string limits, then each pair as
 * written, its grammar, then a repeated key, then `check` for the key and value. Returns the first failure.
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

const defined = (values: ReadonlySet<string>, baseline: readonly string[]): ReadonlySet<string> => new Set(baseline.filter((value) => values.has(value)));

/**
 * Parses one carrier's policy against what the gateway accepts (S1 to S10, S16). The result is the whole policy or
 * the first failure in the spec's order of checks. A vendor key in `support` with no rule in `vendor` is accepted
 * with any grammatical value, which is all a client can know of it; a gateway passes the rules it defines.
 */
export function parsePolicy(text: string, support: Support = baselineSupport(), vendor?: VendorRules): Result<Policy> {
  const attest = defined(support.attest, BASELINE_ATTEST);
  const sort = defined(support.sort, BASELINE_SORT);
  const pairs = new Map<string, Value>();
  const failure = walk(text, (key, value) => {
    if (!support.keys.has(key)) return fail(key, "key not accepted");
    if (key.includes(".")) {
      const rule = vendor?.get(key);
      if (rule !== undefined && !rule.accepts(value)) return fail(key, "value not accepted");
    } else {
      const invalid = valueFailure(key, value, attest, sort);
      if (invalid !== null) return invalid;
    }
    pairs.set(key, value);
    return null;
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
      vendor: new Map([...pairs].filter(([key]) => key.includes("."))),
    },
  };
}

const pair = (key: string, value: Value): string => (value === true ? key : `${key}=${value.join(",")}`);

const sortedPairs = (map: ReadonlyMap<string, Value>): string[] => [...map.keys()].sort().map((key) => pair(key, map.get(key)!));

/**
 * The policy as a string that is valid on a carrier, keys in a fixed order. Fails when it cannot be written as one:
 * it says nothing, an intersection left `region` or `only` empty, or it is over a limit. A combined policy is a
 * decision and need not be writable (SPEC.md, Combining), so a client that must send one checks here first.
 */
export function formatPolicy(policy: Policy): Result<string> {
  const out: string[] = [];
  if (policy.zdr) out.push("zdr");
  if (policy.notrain) out.push("notrain");
  if (policy.bits !== null) out.push(`bits=${policy.bits}`);
  if (policy.region !== null) out.push(pair("region", policy.region));
  if (policy.attest.length > 0) out.push(pair("attest", policy.attest));
  if (policy.only !== null) out.push(pair("only", policy.only));
  if (policy.ignore.length > 0) out.push(pair("ignore", policy.ignore));
  if (policy.sort !== null) out.push(`sort=${policy.sort}`);
  if (policy.order !== null) out.push(pair("order", policy.order));
  out.push(...sortedPairs(policy.vendor));
  const text = out.join("+");
  const failure = walk(text, () => null);
  return failure === null ? { ok: true, value: text } : failure;
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
  keys.push(...[...policy.vendor.keys()].sort());
  return keys;
}

/** Whether the policy restricts which routes qualify. One that only orders them may be sent without detection. */
export function hasRequirements(policy: Policy): boolean {
  const used = keysOf(policy);
  return policy.vendor.size > 0 || REQUIREMENT_KEYS.some((key) => used.includes(key));
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
 * Splits a `model` field at its first `+`, without judging either half. `policy` is null when there is no `+`.
 * Gateways use `readModel`, which checks both; this is for a client that must keep a typed suffix as typed.
 */
export function splitModel(model: string): { id: string; policy: string | null } {
  const plus = model.indexOf("+");
  return plus < 0 ? { id: model, policy: null } : { id: model.slice(0, plus), policy: model.slice(plus + 1) };
}

/**
 * Reads the model-suffix carrier (S11). A field with no `+` carries no policy. With one, the id must not be empty
 * (malformed, no key named) and the rest must parse.
 */
export function readModel(model: string, support: Support = baselineSupport(), vendor?: VendorRules): Result<{ id: string; policy: Policy | null }> {
  const { id, policy } = splitModel(model);
  if (policy === null) return { ok: true, value: { id, policy: null } };
  if (id === "") return fail(null, "empty model id before the suffix");
  const parsed = parsePolicy(policy, support, vendor);
  return parsed.ok ? { ok: true, value: { id, policy: parsed.value } } : parsed;
}

const union = (lists: readonly (readonly string[])[]): string[] => [...new Set(lists.flat())];

function intersection(lists: readonly (readonly string[] | null)[]): string[] | null {
  const present = lists.filter((list) => list !== null);
  if (present.length === 0) return null;
  return present.slice(1).reduce<string[]>((acc, list) => acc.filter((item) => list.includes(item)), [...present[0]!]);
}

const identical = (a: Value, b: Value): boolean => (a === true || b === true ? a === b : a.length === b.length && a.every((item, i) => item === b[i]));

/**
 * Combines the policies that reached one request (SPEC.md, Combining). Requirements accumulate; the most specific
 * preference wins. An empty `region` or `only` in the result means no route can qualify. Vendor values combine by
 * the gateway's rule; without one, two carriers' values must be identical or the result is a failure naming the key.
 */
export function combinePolicies(layers: { key?: Policy; header?: Policy; suffix?: Policy }, vendor?: VendorRules): Result<Policy> {
  const bySpecificity = [layers.suffix, layers.header, layers.key].filter((p) => p !== undefined);
  const vendorValues = new Map<string, Value>();
  for (const layer of bySpecificity) {
    for (const [key, value] of layer.vendor) {
      const held = vendorValues.get(key);
      if (held === undefined) {
        vendorValues.set(key, copy(value));
        continue;
      }
      const combine = vendor?.get(key)?.combine;
      const combined = combine !== undefined ? combine(held, value) : identical(held, value) ? held : null;
      if (combined === null) return fail(key, "vendor values by two carriers cannot be combined");
      vendorValues.set(key, copy(combined));
    }
  }
  const bits = bySpecificity.map((p) => p.bits).filter((b) => b !== null);
  const order = bySpecificity.find((p) => p.order !== null)?.order ?? null;
  return {
    ok: true,
    value: {
      zdr: bySpecificity.some((p) => p.zdr),
      notrain: bySpecificity.some((p) => p.notrain),
      bits: bits.length > 0 ? Math.max(...bits) : null,
      region: intersection(bySpecificity.map((p) => p.region)),
      attest: union(bySpecificity.map((p) => p.attest)),
      only: intersection(bySpecificity.map((p) => p.only)),
      ignore: union(bySpecificity.map((p) => p.ignore)),
      sort: bySpecificity.find((p) => p.sort !== null)?.sort ?? null,
      order: order === null ? null : [...order],
      vendor: vendorValues,
    },
  };
}

/**
 * Reads a route's facts as a client must (S13). The empty string is a route that meets nothing. Facts that are
 * malformed, or that carry `only`, `ignore`, `sort`, or `order`, fail, and the caller treats the route as meeting
 * nothing. Any other well-formed key this revision does not define is kept in `other` and never matched here.
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
 * Checks facts a gateway is about to publish (S12): everything `parseFacts` checks, and no key beyond the five
 * this revision defines and the vendor keys the gateway defines, with `attest` values it accepts.
 */
export function parsePublishedFacts(text: string, support: Support = baselineSupport()): Result<Facts> {
  const parsed = parseFacts(text);
  if (!parsed.ok) return parsed;
  const attest = defined(support.attest, BASELINE_ATTEST);
  const unknownAttest = parsed.value.attest.find((item) => !attest.has(item));
  if (unknownAttest !== undefined) return fail("attest", `"${unknownAttest}" is not an attest value this gateway accepts`);
  for (const key of parsed.value.other.keys()) {
    if (!key.includes(".") || !support.keys.has(key)) return fail(key, "is not a fact this gateway may publish");
  }
  return parsed;
}

export function formatFacts(facts: Facts): string {
  const out: string[] = [];
  if (facts.zdr) out.push("zdr");
  if (facts.notrain) out.push("notrain");
  if (facts.bits !== null) out.push(`bits=${facts.bits}`);
  if (facts.region !== null) out.push(pair("region", facts.region));
  if (facts.attest.length > 0) out.push(pair("attest", facts.attest));
  out.push(...sortedPairs(facts.other));
  return out.join("+");
}

/**
 * Whether a route meets a policy (SPEC.md, Facts). A fact that is absent is not met. A vendor requirement is met
 * only when the route's facts carry the key and the gateway's rule for it says so; without a rule, never.
 */
export function meets(route: { provider: string; facts: Facts }, policy: Policy, vendor?: VendorRules): boolean {
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
  if (policy.ignore.includes(provider)) return false;
  for (const [key, required] of policy.vendor) {
    const fact = facts.other.get(key);
    if (fact === undefined || vendor?.get(key)?.meets(required, fact) !== true) return false;
  }
  return true;
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

/** Whether a string can be a provider id on the wire (S17). */
export const isProviderId = (id: string): boolean => ITEM.test(id);

/** The `Route-Applied` value for the route whose response is relayed (S14). */
export function formatApplied(provider: string, facts: Facts): string {
  const rest = formatFacts(facts);
  return rest === "" ? `provider=${provider}` : `provider=${provider}+${rest}`;
}

/** Reads `Route-Applied` (S14): the provider first, then facts read as `parseFacts` reads them, under their own limits. */
export function parseApplied(text: string): Result<{ provider: string; facts: Facts }> {
  const prefix = "provider=";
  if (!text.startsWith(prefix)) return fail("provider", "does not begin with the provider");
  const plus = text.indexOf("+");
  const provider = text.slice(prefix.length, plus < 0 ? undefined : plus);
  if (!isProviderId(provider)) return fail("provider", "malformed provider id");
  // `provider=x+` is malformed; `provider=x` alone is a route that meets nothing.
  if (plus === text.length - 1) return fail(null, "nothing after the last +");
  const facts = parseFacts(plus < 0 ? "" : text.slice(plus + 1));
  if (!facts.ok) return facts;
  if (facts.value.other.has("provider")) return fail("provider", "repeated key");
  return { ok: true, value: { provider, facts: facts.value } };
}

export type RefusalReason = "unsupported" | "unsatisfiable" | "unavailable";

/** HTTP status of each refusal (SPEC.md, Refusal). */
export const REFUSAL_STATUS: Readonly<Record<RefusalReason, number>> = Object.freeze({ unsupported: 400, unsatisfiable: 400, unavailable: 503 });

/** The `Route-Refused` value (S15). Only an `unsupported` refusal names a key. */
export function formatRefused(reason: "unsupported", key?: string | null): string;
export function formatRefused(reason: "unsatisfiable" | "unavailable"): string;
export function formatRefused(reason: RefusalReason, key: string | null = null): string {
  return key === null ? `reason=${reason}` : `reason=${reason}+key=${key}`;
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
  /** The policy bound to the key the detection request carried, as sent; null when there is none. */
  keyPolicy: string | null;
}

/** An own member that is a list of strings each matching `shape`; `fallback` when absent; null when present and wrong. */
function ownList(reply: object, name: string, shape: RegExp, fallback: readonly string[]): string[] | null {
  if (!Object.hasOwn(reply, name)) return [...fallback];
  const value: unknown = Reflect.get(reply, name);
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string" && shape.test(entry)) ? value : null;
}

/**
 * Reads a detection reply body (SPEC.md, Detection). A reply is valid only when every known member is: anything
 * else is no detection. From a valid one, members, dotless keys, and `attest`/`sort` values this revision does not
 * define are dropped, since this client cannot use them. Members are read as the object's own, never inherited.
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
    // Valid under the reply's own lists, including keys this revision does not define, whose values cannot be judged here.
    const listed = { keys: new Set(keys), attest: new Set(attest), sort: new Set(sort) };
    const failure = walk(bound, (key, value) => {
      if (!listed.keys.has(key)) return fail(key, "key not listed");
      const known = !key.includes(".") && BASELINE_KEYS.some((baseline) => baseline === key);
      return known ? valueFailure(key, value, listed.attest, listed.sort) : null;
    });
    if (failure !== null) return fail("key_policy", `is not valid under the reply's lists: ${failure.detail}`);
    keyPolicy = bound;
  }

  const baselineKeys: readonly string[] = BASELINE_KEYS;
  return {
    ok: true,
    value: {
      support: {
        keys: new Set(keys.filter((key) => key.includes(".") || baselineKeys.includes(key))),
        attest: defined(new Set(attest), BASELINE_ATTEST),
        sort: defined(new Set(sort), BASELINE_SORT),
      },
      keyPolicy,
    },
  };
}

/** The detection reply body a gateway with this `support` sends. */
export function formatDetection(support: Support, keyPolicy: string | null = null): Record<string, unknown> {
  return {
    route_policy: 1,
    keys: [...support.keys],
    attest: [...support.attest],
    sort: [...support.sort],
    ...(keyPolicy === null ? {} : { key_policy: keyPolicy }),
  };
}
