/**
 * Inference Route Policy: the grammar, the combining rules, and the matching rules of SPEC.md as pure functions.
 * No runtime dependency and no I/O, so gateways and clients share one reading of the spec.
 */

export const LIMITS = { policyBytes: 512, pairs: 16, items: 16 } as const;

export const BASELINE_KEYS = ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "sort", "order"] as const;
export const BASELINE_ATTEST = ["weights", "prompt"] as const;
export const BASELINE_SORT = ["price", "latency", "throughput"] as const;

/** Keys that decide which routes qualify. `sort` and `order` only order them. Vendor keys are requirements too. */
const REQUIREMENT_KEYS = ["zdr", "notrain", "bits", "region", "attest", "only", "ignore"] as const;
const FACT_KEYS: Readonly<Record<string, true>> = { zdr: true, notrain: true, bits: true, region: true, attest: true };

const NAME = "[a-z][a-z0-9]{0,15}";
const KEY = new RegExp(`^${NAME}(?:\\.${NAME})?$`);
const ITEM = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
const BITS = /^[1-9][0-9]?$/;
const COUNTRY = /^[a-z]{2}$/;

/** A flag (`true`) or a list, as written. */
export type Value = true | readonly string[];

/** What a gateway accepts, as its detection reply states it. Vendor keys it defines are in `keys`. */
export interface Support {
  keys: ReadonlySet<string>;
  attest: ReadonlySet<string>;
  sort: ReadonlySet<string>;
}

export const BASELINE_SUPPORT: Support = {
  keys: new Set(BASELINE_KEYS),
  attest: new Set(BASELINE_ATTEST),
  sort: new Set(BASELINE_SORT),
};

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
  /** Vendor keys (`vendor.name`), which only a gateway that defines them accepts. */
  vendor: Readonly<Record<string, Value>>;
}

export interface Facts {
  zdr: boolean;
  notrain: boolean;
  bits: number | null;
  region: readonly string[] | null;
  attest: readonly string[];
  /** Vendor keys, and keys from a later revision that this reader does not know. Never required by it, so only carried. */
  other: Readonly<Record<string, Value>>;
}

export type Result<T> = { ok: true; value: T } | { ok: false; key: string | null; detail: string };

const fail = (key: string | null, detail: string): { ok: false; key: string | null; detail: string } => ({ ok: false, key, detail });

/** The pairs of a policy or facts string, in order, with the grammar, repeats, and limits checked (S1 to S4). */
function parsePairs(text: string): Result<[string, Value][]> {
  if (text.length > LIMITS.policyBytes) return fail(null, `longer than ${LIMITS.policyBytes} bytes`);
  const parts = text.split("+");
  if (parts.length > LIMITS.pairs) return fail(null, `more than ${LIMITS.pairs} pairs`);
  const pairs: [string, Value][] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const eq = part.indexOf("=");
    const key = eq < 0 ? part : part.slice(0, eq);
    if (!KEY.test(key)) return fail(null, `malformed key in "${part}"`);
    if (seen.has(key)) return fail(key, "repeated key");
    seen.add(key);
    if (eq < 0) {
      pairs.push([key, true]);
      continue;
    }
    const items = part.slice(eq + 1).split(",");
    if (items.length > LIMITS.items) return fail(key, `more than ${LIMITS.items} items`);
    for (const item of items) if (!ITEM.test(item)) return fail(key, `malformed item "${item}"`);
    if (new Set(items).size !== items.length) return fail(key, "repeated item");
    pairs.push([key, items]);
  }
  return { ok: true, value: pairs };
}

/** `bits` as an integer 1 to 64, or null when the value is not one (S6). */
function bitsOf(value: Value): number | null {
  if (value === true || value.length !== 1 || !BITS.test(value[0]!)) return null;
  const n = Number(value[0]);
  return n <= 64 ? n : null;
}

const countriesOf = (value: Value): readonly string[] | null => (value !== true && value.every((c) => COUNTRY.test(c)) ? value : null);

export const emptyPolicy = (): Policy => ({ zdr: false, notrain: false, bits: null, region: null, attest: [], only: null, ignore: [], sort: null, order: null, vendor: {} });

/**
 * Parses one carrier's policy. Refuses anything outside the grammar, over a limit, or not in `support` (S1 to S10):
 * the result is either the whole policy or the reason and, when its pair is well formed, the first offending key.
 */
export function parsePolicy(text: string, support: Support = BASELINE_SUPPORT): Result<Policy> {
  const pairs = parsePairs(text);
  if (!pairs.ok) return pairs;
  const policy = emptyPolicy();
  const vendor: Record<string, Value> = {};
  for (const [key, value] of pairs.value) {
    if (!support.keys.has(key)) return fail(key, "key not accepted");
    if (key.includes(".")) {
      vendor[key] = value;
      continue;
    }
    switch (key) {
      case "zdr":
      case "notrain":
        if (value !== true) return fail(key, "takes no value");
        policy[key] = true;
        break;
      case "bits": {
        const bits = bitsOf(value);
        if (bits === null) return fail(key, "takes one integer from 1 to 64");
        policy.bits = bits;
        break;
      }
      case "region": {
        const region = countriesOf(value);
        if (region === null) return fail(key, "takes a list of two-letter country codes");
        policy.region = region;
        break;
      }
      case "attest":
        if (value === true || !value.every((v) => support.attest.has(v))) return fail(key, "value not accepted");
        policy.attest = value;
        break;
      case "only":
      case "ignore":
      case "order":
        if (value === true) return fail(key, "takes a list of provider ids");
        policy[key] = value;
        break;
      case "sort":
        if (value === true || value.length !== 1 || !support.sort.has(value[0]!)) return fail(key, "value not accepted");
        policy.sort = value[0]!;
        break;
      default:
        // In `support.keys` without a dot, yet not defined by this document: a gateway cannot accept it.
        return fail(key, "key not defined");
    }
  }
  policy.vendor = vendor;
  return { ok: true, value: policy };
}

const pair = (key: string, value: Value): string => (value === true ? key : `${key}=${value.join(",")}`);

const sortedPairs = (record: Readonly<Record<string, Value>>): string[] =>
  Object.keys(record)
    .sort()
    .map((key) => pair(key, record[key]!));

/** The policy as a string, keys in a fixed order. Empty when the policy says nothing, which is not a valid policy to send. */
export function formatPolicy(policy: Policy): string {
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
  return out.join("+");
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
  keys.push(...Object.keys(policy.vendor).sort());
  return keys;
}

/** Whether the policy restricts which routes qualify. One that only orders them may be sent without detection. */
export function hasRequirements(policy: Policy): boolean {
  const used = new Set(keysOf(policy));
  return REQUIREMENT_KEYS.some((key) => used.has(key)) || Object.keys(policy.vendor).length > 0;
}

/** Whether `support` accepts every key and value the policy uses: what a client checks before sending requirements. */
export function supports(support: Support, policy: Policy): boolean {
  return (
    keysOf(policy).every((key) => support.keys.has(key)) &&
    policy.attest.every((v) => support.attest.has(v)) &&
    (policy.sort === null || support.sort.has(policy.sort))
  );
}

/**
 * Splits a `model` field at its first `+` (S11). `policy` is null when there is no `+`; otherwise it is whatever
 * follows, unparsed, and may be empty, which `parsePolicy` refuses. `id` may be empty, which no gateway resolves.
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

const sameValue = (a: Value, b: Value): boolean => (a === true || b === true ? a === b : a.length === b.length && a.every((item) => b.includes(item)));

/**
 * Combines the policies that reached one request (SPEC.md, Combining). Requirements accumulate; the most specific
 * preference wins. An empty `region` or `only` in the result means no route can qualify. A vendor key that arrives
 * by two carriers with different values is refused, since this library knows no vendor's rule.
 */
export function combinePolicies(layers: { key?: Policy; header?: Policy; suffix?: Policy }): Result<Policy> {
  const bySpecificity = [layers.suffix, layers.header, layers.key].filter((p) => p !== undefined);
  const vendor: Record<string, Value> = {};
  for (const layer of bySpecificity) {
    for (const [key, value] of Object.entries(layer.vendor)) {
      if (key in vendor && !sameValue(vendor[key]!, value)) return fail(key, "vendor key arrives by two carriers with different values");
      vendor[key] = value;
    }
  }
  const bits = bySpecificity.map((p) => p.bits).filter((b) => b !== null);
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
      order: bySpecificity.find((p) => p.order !== null)?.order ?? null,
      vendor,
    },
  };
}

function factsFromPairs(pairs: readonly [string, Value][]): Result<Facts> {
  const facts: Facts = { zdr: false, notrain: false, bits: null, region: null, attest: [], other: {} };
  const other: Record<string, Value> = {};
  for (const [key, value] of pairs) {
    switch (key) {
      case "zdr":
      case "notrain":
        if (value !== true) return fail(key, "takes no value");
        facts[key] = true;
        break;
      case "bits": {
        const bits = bitsOf(value);
        if (bits === null) return fail(key, "takes one integer from 1 to 64");
        facts.bits = bits;
        break;
      }
      case "region": {
        const region = countriesOf(value);
        if (region === null) return fail(key, "takes a list of two-letter country codes");
        facts.region = region;
        break;
      }
      case "attest":
        if (value === true) return fail(key, "takes a list");
        facts.attest = value;
        break;
      default:
        other[key] = value;
    }
  }
  facts.other = other;
  return { ok: true, value: facts };
}

/**
 * Parses a route's facts (S12). The empty string is a route that meets nothing. Keys this reader does not know are
 * kept in `other` and never matched: a fact it does not know cannot be one it required.
 */
export function parseFacts(text: string): Result<Facts> {
  if (text === "") return factsFromPairs([]);
  const pairs = parsePairs(text);
  return pairs.ok ? factsFromPairs(pairs.value) : pairs;
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

/** Whether a gateway may publish this key as a fact without a vendor prefix. */
export const isFactKey = (key: string): boolean => Object.hasOwn(FACT_KEYS, key) || key.includes(".");

/**
 * Whether a route meets a policy (SPEC.md, Facts). A fact that is absent is not met. Vendor keys are met only as
 * `vendorMeets` says; without it a policy that has any is met by no route.
 */
export function meets(route: { provider: string; facts: Facts }, policy: Policy, vendorMeets?: (key: string, required: Value, facts: Facts) => boolean): boolean {
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
  return Object.entries(policy.vendor).every(([key, required]) => vendorMeets?.(key, required, facts) === true);
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

/** The `Route-Applied` value for the route that served a request (S13). */
export function formatApplied(provider: string, facts: Facts): string {
  const rest = formatFacts(facts);
  return rest === "" ? `provider=${provider}` : `provider=${provider}+${rest}`;
}

export function parseApplied(text: string): Result<{ provider: string; facts: Facts }> {
  const pairs = parsePairs(text);
  if (!pairs.ok) return pairs;
  const provider = pairs.value.find(([key]) => key === "provider")?.[1];
  if (provider === undefined || provider === true || provider.length !== 1) return fail("provider", "names exactly one provider");
  const facts = factsFromPairs(pairs.value.filter(([key]) => key !== "provider"));
  return facts.ok ? { ok: true, value: { provider: provider[0]!, facts: facts.value } } : facts;
}

export const REFUSAL_REASONS = ["unsupported", "unsatisfiable", "unavailable"] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/** HTTP status of each refusal (SPEC.md, Refusal). */
export const REFUSAL_STATUS: Readonly<Record<RefusalReason, number>> = { unsupported: 400, unsatisfiable: 400, unavailable: 503 };

/** The `Route-Refused` value (S14). */
export const formatRefused = (reason: RefusalReason, key: string | null = null): string => (key === null ? `reason=${reason}` : `reason=${reason}+key=${key}`);

export function parseRefused(text: string): Result<{ reason: RefusalReason; key: string | null }> {
  const fields = new Map<string, string>();
  for (const part of text.split("+")) {
    const eq = part.indexOf("=");
    if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const reason = REFUSAL_REASONS.find((r) => r === fields.get("reason"));
  if (reason === undefined) return fail("reason", "not a known reason");
  const key = fields.get("key") ?? null;
  if (key !== null && !KEY.test(key)) return fail("key", "malformed key");
  return { ok: true, value: { reason, key } };
}

export interface Detection {
  support: Support;
  /** The policy bound to the key the detection request carried, unparsed; null when there is none. */
  keyPolicy: string | null;
}

const stringSet = (value: unknown, fallback: readonly string[]): ReadonlySet<string> | null => {
  if (value === undefined) return new Set(fallback);
  return Array.isArray(value) && value.every((v): v is string => typeof v === "string") ? new Set(value) : null;
};

/** Reads a detection reply body (SPEC.md, Detection). Absent lists mean the baseline; unknown members are ignored. */
export function parseDetection(body: unknown): Result<Detection> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail(null, "not a JSON object");
  const reply = body as Record<string, unknown>;
  if (reply.route_policy !== 1) return fail("route_policy", "is not 1");
  const keys = stringSet(reply.keys, BASELINE_KEYS);
  const attest = stringSet(reply.attest, BASELINE_ATTEST);
  const sort = stringSet(reply.sort, BASELINE_SORT);
  if (keys === null) return fail("keys", "is not a list of strings");
  if (attest === null) return fail("attest", "is not a list of strings");
  if (sort === null) return fail("sort", "is not a list of strings");
  const keyPolicy = reply.key_policy;
  if (keyPolicy !== undefined && typeof keyPolicy !== "string") return fail("key_policy", "is not a string");
  return { ok: true, value: { support: { keys, attest, sort }, keyPolicy: keyPolicy ?? null } };
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
