import assert from "node:assert/strict";
import { test } from "node:test";
import { COUNTRIES } from "../src/countries.ts";
import {
  baselineSupport,
  combinePolicies,
  formatApplied,
  formatDetection,
  formatFacts,
  formatPolicy,
  formatRefused,
  hasRequirements,
  isProviderId,
  meets,
  orderRoutes,
  parseApplied,
  parseDetection,
  parseFacts,
  parsePolicy,
  parsePublishedFacts,
  parseRefused,
  readModel,
  splitModel,
  supports,
  type Facts,
  type Policy,
  type Support,
  type Value,
  type VendorRules,
} from "../src/index.ts";

function withKeys(...extra: string[]): Support {
  const base = baselineSupport();
  return { ...base, keys: new Set([...base.keys, ...extra]) };
}

function policy(text: string, support?: Support, vendor?: VendorRules): Policy {
  const parsed = parsePolicy(text, support, vendor);
  assert.ok(parsed.ok, `"${text}" should parse: ${parsed.ok ? "" : parsed.detail}`);
  return parsed.value;
}

function facts(text: string): Facts {
  const parsed = parseFacts(text);
  assert.ok(parsed.ok, `facts "${text}" should parse`);
  return parsed.value;
}

/** Asserts the policy is refused and returns the key the refusal names. */
function refusedKey(text: string, support?: Support, vendor?: VendorRules): string | null {
  const parsed = parsePolicy(text, support, vendor);
  assert.ok(!parsed.ok, `"${text}" should be refused`);
  return parsed.key;
}

/** A vendor key `acme.tier` whose value is one digit 1 to 3: a route meets it when its own tier is at most the required one. */
const tierRule: VendorRules = new Map([
  [
    "acme.tier",
    {
      accepts: (value: Value) => value !== true && value.length === 1 && /^[1-3]$/.test(value[0]!),
      meets: (required: Value, fact: Value) => required !== true && fact !== true && Number(fact[0]) <= Number(required[0]),
    },
  ],
]);

test("S1: a policy with every baseline key parses to its meaning", () => {
  assert.deepEqual(policy("zdr+notrain+bits=8+region=us,de+attest=weights,prompt+only=a,b+ignore=c+sort=latency+order=b,a"), {
    zdr: true,
    notrain: true,
    bits: 8,
    region: ["us", "de"],
    attest: ["weights", "prompt"],
    only: ["a", "b"],
    ignore: ["c"],
    sort: "latency",
    order: ["b", "a"],
    vendor: new Map(),
  });
});

test("S1: empty strings, empty pairs, empty lists, and whitespace are malformed", () => {
  for (const text of ["", "+", "zdr+", "+zdr", "zdr++notrain", "only=", "only=a,", "only=,a", "zdr ", " zdr", "zdr+ notrain", "only=a, b", "=a", "zdr=", "bits==8", "zdr\n", "zdr\t+notrain"]) {
    refusedKey(text);
  }
});

test("S2: key and item character sets and lengths are enforced at the boundary", () => {
  const support = withKeys(`v.${"k".repeat(16)}`, `${"v".repeat(16)}.k`);
  policy(`v.${"k".repeat(16)}`, support);
  policy(`${"v".repeat(16)}.k`, support);
  assert.equal(refusedKey(`v.${"k".repeat(17)}`, support), null);
  assert.equal(refusedKey(`${"v".repeat(17)}.k`, support), null);
  for (const key of ["Zdr", "1zdr", "z_dr", "z-dr", "a.b.c", "a.", ".a", "a..b", "zdr\u00e9", "__proto__"]) assert.equal(refusedKey(key), null, key);

  policy(`only=${"a".repeat(32)}`);
  assert.equal(refusedKey(`only=${"a".repeat(33)}`), "only");
  policy("only=0a,a_b,a.b,a-b,constructor,valueof");
  for (const item of ["A", "_a", ".a", "-a", "a b", "a/b", "a:b", "a~b", "__proto__", "\u00e9"]) assert.equal(refusedKey(`only=${item}`), "only", item);
});

test("S3: a repeated key or a repeated item is malformed and names the key", () => {
  assert.equal(refusedKey("zdr+zdr"), "zdr");
  assert.equal(refusedKey("only=a+only=b"), "only");
  assert.equal(refusedKey("only=a,a"), "only");
  assert.equal(refusedKey("region=us,de,us"), "region");
});

test("S4: limits are inclusive at 512 bytes, 16 pairs, and 16 items, and bytes are counted, not characters", () => {
  const items = (n: number): string => Array.from({ length: n }, (_, i) => `p${i}`).join(",");
  policy(`only=${items(16)}`);
  assert.equal(refusedKey(`only=${items(17)}`), "only");

  const vendorKeys = Array.from({ length: 17 }, (_, i) => `v.k${i}`);
  const support: Support = { ...baselineSupport(), keys: new Set(vendorKeys) };
  policy(vendorKeys.slice(0, 16).join("+"), support);
  assert.equal(refusedKey(vendorKeys.join("+"), support), null);

  // "only=" and fifteen 32-byte items is 499 bytes; a sixteenth item of 12 bytes makes exactly 512.
  const fifteen = Array.from({ length: 15 }, (_, i) => String.fromCharCode(97 + i).repeat(32)).join(",");
  const at = `only=${fifteen},${"p".repeat(12)}`;
  assert.equal(at.length, 512);
  policy(at);
  assert.equal(refusedKey(`only=${fifteen},${"p".repeat(13)}`), null);

  // 259 characters but 513 bytes: over the limit, so no key is named, although its first pair is well formed.
  const wide = `only=a+ignore=${"\u00e9".repeat(250)}`;
  assert.equal(wide.length < 512, true);
  assert.equal(new TextEncoder().encode(wide).length > 512, true);
  assert.equal(refusedKey(wide), null);
  // The same shape under the limit is a malformed item, which names its key.
  assert.equal(refusedKey("only=a+ignore=\u00e9"), "ignore");
});

test("S5: zdr and notrain are flags only", () => {
  assert.equal(refusedKey("zdr=yes"), "zdr");
  assert.equal(refusedKey("notrain=1"), "notrain");
});

test("S6: bits takes one integer from 1 to 64 with no leading zero", () => {
  assert.equal(policy("bits=1").bits, 1);
  assert.equal(policy("bits=64").bits, 64);
  for (const value of ["0", "65", "08", "8.0", "-8", "8,16", "x", "100"]) assert.equal(refusedKey(`bits=${value}`), "bits", value);
  assert.equal(refusedKey("bits"), "bits");
});

test("S7: region takes assigned ISO 3166-1 alpha-2 codes only", () => {
  assert.equal(Object.keys(COUNTRIES).length, 249);
  assert.deepEqual(policy("region=us,de,jp").region, ["us", "de", "jp"]);
  for (const value of ["ab", "eu", "uk", "xk", "zz", "usa", "u", "u1", "us,deu", "us,ab"]) assert.equal(refusedKey(`region=${value}`), "region", value);
  assert.equal(refusedKey("region"), "region");
  assert.equal(refusedKey("region=constructor"), "region");
  assert.equal(parseFacts("region=ab").ok, false);
  assert.equal(parseFacts("region=us,eu").ok, false);
});

test("S8, S10: attest and sort accept only values that are both defined here and listed by the gateway", () => {
  assert.equal(refusedKey("attest=weights,other"), "attest");
  assert.equal(refusedKey("attest"), "attest");
  assert.equal(refusedKey("sort=cheap"), "sort");
  assert.equal(refusedKey("sort=price,latency"), "sort");
  assert.equal(refusedKey("sort"), "sort");

  const narrow: Support = { keys: baselineSupport().keys, attest: new Set(["weights"]), sort: new Set(["price"]) };
  policy("attest=weights+sort=price", narrow);
  assert.equal(refusedKey("attest=prompt", narrow), "attest");
  assert.equal(refusedKey("attest=weights,prompt", narrow), "attest");
  assert.equal(refusedKey("sort=latency", narrow), "sort");

  // Listing a value this revision does not define does not make it valid.
  const wide: Support = { keys: baselineSupport().keys, attest: new Set(["weights", "custom"]), sort: new Set(["price", "custom"]) };
  assert.equal(refusedKey("attest=custom", wide), "attest");
  assert.equal(refusedKey("sort=custom", wide), "sort");
});

test("S9: only, ignore, and order take lists of any items", () => {
  for (const key of ["only", "ignore", "order"]) {
    assert.equal(refusedKey(key), key);
    policy(`${key}=nosuch,constructor,0`);
  }
});

test("S16: the whole-string limits are checked first and name no key", () => {
  const seventeen = `bits=0+${Array.from({ length: 16 }, (_, i) => `only${i}`).join("+")}`;
  assert.equal(seventeen.split("+").length, 17);
  assert.equal(refusedKey(seventeen), null);
  assert.equal(refusedKey(`bits=0+only=${"a".repeat(32)},${"b,".repeat(250)}c`), null);
});

test("S16: the first failing pair in the order written decides, whether it fails on grammar or on meaning", () => {
  assert.equal(refusedKey("bits=0+only=a,a"), "bits");
  assert.equal(refusedKey("only=a,a+bits=0"), "only");
  assert.equal(refusedKey("zdr=1+only="), "zdr");
  assert.equal(refusedKey("only=+zdr=1"), "only");
  assert.equal(refusedKey("later+?"), "later");
  assert.equal(refusedKey("?+later"), null);
  assert.equal(refusedKey("zdr+later=1"), "later");
  assert.equal(refusedKey("later+bits=999"), "later");
  assert.equal(refusedKey("bits=999+later"), "bits");
  assert.equal(refusedKey("zdr+Bad=1+bits=0"), null);
});

test("S16: within one pair, grammar comes before a repeated key, then the key, then the value", () => {
  assert.equal(refusedKey("zdr+zdr=A"), "zdr");
  const subset: Support = { ...baselineSupport(), keys: new Set(["only", "sort"]) };
  assert.equal(refusedKey("zdr", subset), "zdr");
  assert.equal(refusedKey("bits=0", subset), "bits");
  // A dotless key the gateway lists but this document does not define cannot be accepted.
  assert.equal(refusedKey("later", { ...baselineSupport(), keys: new Set(["later"]) }), "later");
});

test("vendor keys: refused unless the gateway lists them, and values are judged by the gateway's rule", () => {
  assert.equal(refusedKey("acme.tier=2"), "acme.tier");
  const support = withKeys("acme.tier", "acme.audited");
  assert.deepEqual(policy("acme.tier=2+acme.audited", support, tierRule).vendor, new Map<string, Value>([["acme.tier", ["2"]], ["acme.audited", true]]));
  assert.equal(refusedKey("acme.tier=9", support, tierRule), "acme.tier");
  assert.equal(refusedKey("acme.tier", support, tierRule), "acme.tier");
  assert.equal(refusedKey("acme.tier=1,2", support, tierRule), "acme.tier");
  // A client has the key from detection but not the rule, so any grammatical value passes its own check.
  policy("acme.tier=9", support);
});

test("formatPolicy: a parsed policy formats to a string that parses to the same policy", () => {
  const support = withKeys("acme.tier", "acme.audited");
  for (const text of ["zdr", "sort=price", "order=b,a+sort=throughput", "acme.tier=2+zdr+acme.audited", "ignore=c+only=a,b+attest=prompt+region=de,us+bits=16+notrain+zdr"]) {
    const first = policy(text, support);
    const formatted = formatPolicy(first);
    assert.ok(formatted.ok, text);
    assert.deepEqual(policy(formatted.value, support), first, text);
  }
  assert.deepEqual(formatPolicy(policy("sort=price+zdr+bits=8")), { ok: true, value: "zdr+bits=8+sort=price" });
});

test("formatPolicy: a combined policy that cannot be written as a valid policy fails instead of producing one", () => {
  const empty = combinePolicies({});
  assert.ok(empty.ok);
  assert.equal(formatPolicy(empty.value).ok, false);

  const disjointRegion = combinePolicies({ key: policy("region=us"), suffix: policy("region=de") });
  assert.ok(disjointRegion.ok);
  const region = formatPolicy(disjointRegion.value);
  assert.ok(!region.ok);
  assert.equal(region.key, "region");

  const disjointOnly = combinePolicies({ key: policy("only=a"), suffix: policy("only=b") });
  assert.ok(disjointOnly.ok);
  assert.equal(formatPolicy(disjointOnly.value).ok, false);

  const sixteen = Array.from({ length: 16 }, (_, i) => `p${i}`).join(",");
  const seventeen = combinePolicies({ key: policy(`ignore=${sixteen}`), suffix: policy("ignore=extra") });
  assert.ok(seventeen.ok);
  assert.equal(seventeen.value.ignore.length, 17);
  const ignore = formatPolicy(seventeen.value);
  assert.ok(!ignore.ok);
  assert.equal(ignore.key, "ignore");
});

test("hasRequirements separates requirements from preferences", () => {
  assert.equal(hasRequirements(policy("sort=price")), false);
  assert.equal(hasRequirements(policy("order=a")), false);
  assert.equal(hasRequirements(policy("sort=price+order=a")), false);
  for (const text of ["zdr", "notrain", "bits=8", "region=us", "attest=weights", "only=a", "ignore=a"]) {
    assert.equal(hasRequirements(policy(text)), true, text);
    assert.equal(hasRequirements(policy(`sort=price+${text}`)), true, text);
  }
  assert.equal(hasRequirements(policy("acme.tier=2", withKeys("acme.tier"))), true);
});

test("C1: supports needs every key listed, and every attest and sort value listed, wherever it stands in its list", () => {
  const narrow: Support = { keys: new Set(["zdr", "sort", "attest", "bits", "region", "only"]), attest: new Set(["weights"]), sort: new Set(["price"]) };
  assert.equal(supports(narrow, policy("zdr+sort=price+attest=weights")), true);
  assert.equal(supports(narrow, policy("notrain")), false);
  assert.equal(supports(narrow, policy("zdr+ignore=a")), false);
  assert.equal(supports(narrow, policy("sort=latency")), false);
  assert.equal(supports(narrow, policy("attest=prompt")), false);
  assert.equal(supports(narrow, policy("attest=weights,prompt")), false);
  assert.equal(supports(narrow, policy("attest=prompt,weights")), false);
  // Keys with a fixed domain have no list of values to check.
  assert.equal(supports(narrow, policy("bits=64+region=fr+only=constructor")), true);
  assert.equal(supports(narrow, policy("acme.tier=2", withKeys("acme.tier"))), false);
});

test("S11: the model field splits at its first plus, and readModel checks both halves", () => {
  assert.deepEqual(splitModel("example-model"), { id: "example-model", policy: null });
  assert.deepEqual(splitModel("vendor/example-model:free+zdr+sort=price"), { id: "vendor/example-model:free", policy: "zdr+sort=price" });

  const none = readModel("example-model");
  assert.ok(none.ok);
  assert.deepEqual(none.value, { id: "example-model", policy: null });

  const suffixed = readModel("vendor/example-model:free+zdr+sort=price");
  assert.ok(suffixed.ok);
  assert.equal(suffixed.value.id, "vendor/example-model:free");
  assert.equal(suffixed.value.policy?.zdr, true);
  assert.equal(suffixed.value.policy?.sort, "price");

  const emptyId = readModel("+notrain");
  assert.ok(!emptyId.ok);
  assert.equal(emptyId.key, null);
  const emptyPolicy = readModel("example-model+");
  assert.ok(!emptyPolicy.ok);
  assert.equal(emptyPolicy.key, null);
  const badPolicy = readModel("example-model+bits=0");
  assert.ok(!badPolicy.ok);
  assert.equal(badPolicy.key, "bits");
  const narrow = readModel("example-model+zdr", { ...baselineSupport(), keys: new Set(["sort"]) });
  assert.ok(!narrow.ok);
  assert.equal(narrow.key, "zdr");
});

test("combining: requirements accumulate and only narrow", () => {
  const combined = combinePolicies({
    key: policy("zdr+bits=8+region=us,de,fr+only=a,b,c+ignore=x+attest=weights"),
    header: policy("notrain+bits=16+region=de,fr+ignore=y"),
    suffix: policy("bits=4+region=fr,gb+only=b,c,d+attest=prompt"),
  });
  assert.ok(combined.ok);
  assert.deepEqual(combined.value, {
    zdr: true,
    notrain: true,
    bits: 16,
    region: ["fr"],
    attest: ["prompt", "weights"],
    only: ["b", "c"],
    ignore: ["y", "x"],
    sort: null,
    order: null,
    vendor: new Map(),
  });
});

test("G12: an empty region intersection alone, and an empty only intersection alone, each qualify no route", () => {
  const open = { provider: "a", facts: facts("region=us") };

  const region = combinePolicies({ key: policy("region=us"), suffix: policy("region=de") });
  assert.ok(region.ok);
  assert.deepEqual(region.value.region, []);
  assert.equal(region.value.only, null);
  assert.equal(meets(open, region.value), false);
  assert.equal(meets({ provider: "a", facts: facts("region=de") }, region.value), false);
  assert.equal(meets({ provider: "a", facts: facts("") }, region.value), false);

  const only = combinePolicies({ key: policy("only=a"), header: policy("only=b") });
  assert.ok(only.ok);
  assert.deepEqual(only.value.only, []);
  assert.equal(only.value.region, null);
  assert.equal(meets(open, only.value), false);
  assert.equal(meets({ provider: "b", facts: facts("") }, only.value), false);
});

test("combining: the most specific preference wins, per key", () => {
  const all = combinePolicies({ key: policy("sort=price+order=a"), header: policy("sort=latency+order=b"), suffix: policy("sort=throughput") });
  assert.ok(all.ok);
  assert.equal(all.value.sort, "throughput");
  assert.deepEqual(all.value.order, ["b"]);

  const headerOverKey = combinePolicies({ key: policy("sort=price+order=a"), header: policy("sort=latency") });
  assert.ok(headerOverKey.ok);
  assert.equal(headerOverKey.value.sort, "latency");
  assert.deepEqual(headerOverKey.value.order, ["a"]);

  const keyOnly = combinePolicies({ key: policy("sort=price+order=a") });
  assert.ok(keyOnly.ok);
  assert.equal(keyOnly.value.sort, "price");
  assert.deepEqual(keyOnly.value.order, ["a"]);
});

test("G13: no layer removes or weakens a requirement of another", () => {
  const key = policy("zdr+notrain+bits=16+region=us+attest=weights+only=a+ignore=b");
  for (const other of ["sort=price", "bits=1", "region=us,de,fr", "only=a,b,c", "attest=prompt", "ignore=c"]) {
    for (const carrier of ["header", "suffix"] as const) {
      const combined = combinePolicies({ key, [carrier]: policy(other) });
      assert.ok(combined.ok);
      const { value } = combined;
      assert.equal(value.zdr, true, other);
      assert.equal(value.notrain, true, other);
      assert.equal(value.bits, 16, other);
      assert.deepEqual(value.region, ["us"], other);
      assert.deepEqual(value.only, ["a"], other);
      assert.ok(value.attest.includes("weights"), other);
      assert.ok(value.ignore.includes("b"), other);
    }
  }
});

test("combining: the result shares no list or map with its inputs", () => {
  const support = withKeys("acme.list");
  const key = policy("order=a,b+region=us,de+only=a,b+ignore=x+attest=weights+acme.list=one,two", support);
  const combined = combinePolicies({ key });
  assert.ok(combined.ok);
  const result = combined.value;
  for (const list of [result.order, result.region, result.only, result.ignore, result.attest, result.vendor.get("acme.list")]) {
    assert.ok(Array.isArray(list));
    list.length = 0;
  }
  (result.vendor as Map<string, Value>).clear();
  assert.deepEqual(key, policy("order=a,b+region=us,de+only=a,b+ignore=x+attest=weights+acme.list=one,two", support));
});

test("G28: vendor values by two carriers must be identical, in order, unless the gateway defines how they combine", () => {
  const support = withKeys("acme.tier", "acme.list", "acme.audited");
  const p = (text: string): Policy => policy(text, support);

  const conflict = combinePolicies({ key: p("acme.tier=1"), suffix: p("acme.tier=2") });
  assert.ok(!conflict.ok);
  assert.equal(conflict.key, "acme.tier");
  assert.equal(combinePolicies({ key: p("acme.tier"), header: p("acme.tier=2") }).ok, false);
  assert.equal(combinePolicies({ key: p("acme.list=a,b"), header: p("acme.list=b,a") }).ok, false);

  const same = combinePolicies({ key: p("acme.list=a,b+acme.audited"), header: p("acme.list=a,b"), suffix: p("acme.audited") });
  assert.ok(same.ok);
  assert.deepEqual(same.value.vendor, new Map<string, Value>([["acme.audited", true], ["acme.list", ["a", "b"]]]));

  // With a rule, the gateway's rule decides: here the stricter (lower) tier wins.
  const strictest: VendorRules = new Map([
    ["acme.tier", { accepts: () => true, meets: () => true, combine: (a: Value, b: Value): Value | null => (a === true || b === true ? null : [String(Math.min(Number(a[0]), Number(b[0])))]) }],
  ]);
  const ruled = combinePolicies({ key: p("acme.tier=1"), suffix: p("acme.tier=2") }, strictest);
  assert.ok(ruled.ok);
  assert.deepEqual(ruled.value.vendor.get("acme.tier"), ["1"]);
  assert.equal(combinePolicies({ key: p("acme.tier"), suffix: p("acme.tier=2") }, strictest).ok, false);
});

test("G29: a vendor conflict is reported even when an intersection is also empty", () => {
  const support = withKeys("acme.tier");
  const both = combinePolicies({ key: policy("region=us+acme.tier=1", support), suffix: policy("region=de+acme.tier=2", support) });
  assert.ok(!both.ok);
  assert.equal(both.key, "acme.tier");
});

test("S13: a reader keeps unknown well-formed fact keys, never matches on them, and refuses known non-facts", () => {
  assert.deepEqual(facts(""), { zdr: false, notrain: false, bits: null, region: null, attest: [], other: new Map() });
  const read = facts("zdr+bits=8+region=us,de+attest=weights,later+acme.tier=2+later");
  assert.deepEqual(read, {
    zdr: true,
    notrain: false,
    bits: 8,
    region: ["us", "de"],
    attest: ["weights", "later"],
    other: new Map<string, Value>([["acme.tier", ["2"]], ["later", true]]),
  });
  // The unknown keys change nothing about what the route meets.
  const route = { provider: "a", facts: read };
  assert.equal(meets(route, policy("zdr+bits=8+region=us,de+attest=weights")), true);
  assert.equal(meets(route, policy("notrain")), false);
  assert.equal(meets(route, policy("attest=prompt")), false);

  for (const text of ["only=x", "ignore=x", "ignore", "sort", "sort=price", "order=x", "zdr+order=x"]) assert.equal(parseFacts(text).ok, false, text);
  for (const text of ["zdr=1", "bits=0", "region=usa", "attest", "zdr+zdr", "+", "zdr+"]) assert.equal(parseFacts(text).ok, false, text);

  // An absent key reads as absent, whatever its name.
  assert.equal(facts("").other.get("constructor"), undefined);
  assert.equal(facts("").other.has("toString"), false);
  assert.deepEqual(facts("constructor=x").other.get("constructor"), ["x"]);

  const text = "zdr+notrain+bits=8+region=us,de+attest=weights,prompt+acme.tier=2";
  assert.equal(formatFacts(facts(text)), text);
});

test("S12: a gateway may publish only the five fact keys and vendor keys it defines, with values it accepts", () => {
  const support = withKeys("acme.tier");
  assert.equal(parsePublishedFacts("", support).ok, true);
  assert.equal(parsePublishedFacts("zdr+notrain+bits=8+region=us+attest=weights,prompt+acme.tier=2", support).ok, true);
  const cases: [facts: string, key: string][] = [
    ["later", "later"],
    ["zdr+other.key", "other.key"],
    ["provider=a", "provider"],
    ["attest=custom", "attest"],
    ["only=a", "only"],
    ["region=ab", "region"],
  ];
  for (const [text, key] of cases) {
    const parsed = parsePublishedFacts(text, support);
    assert.ok(!parsed.ok, text);
    assert.equal(parsed.key, key, text);
  }
  assert.equal(parsePublishedFacts("acme.tier=2").ok, false);
  assert.equal(parsePublishedFacts("attest=prompt", { ...baselineSupport(), attest: new Set(["weights"]) }).ok, false);
});

test("G6: each requirement is checked against the route's facts, and an absent fact is not met", () => {
  const cases: [policy: string, provider: string, facts: string, expected: boolean][] = [
    ["zdr", "a", "zdr", true],
    ["zdr", "a", "notrain", false],
    ["notrain", "a", "zdr+notrain", true],
    ["notrain", "a", "", false],
    ["bits=8", "a", "bits=8", true],
    ["bits=8", "a", "bits=16", true],
    ["bits=8", "a", "bits=4", false],
    ["bits=8", "a", "zdr", false],
    ["region=us,de", "a", "region=us", true],
    ["region=us,de", "a", "region=de,us", true],
    ["region=us", "a", "region=us,de", false],
    ["region=us", "a", "", false],
    ["attest=weights", "a", "attest=weights,prompt", true],
    ["attest=weights,prompt", "a", "attest=weights", false],
    ["attest=prompt,weights", "a", "attest=weights", false],
    ["attest=prompt", "a", "", false],
    ["only=a,b", "a", "", true],
    ["only=a,b", "c", "zdr", false],
    ["only=nosuch", "a", "", false],
    ["ignore=a", "a", "zdr", false],
    ["ignore=a", "b", "", true],
    ["ignore=nosuch", "a", "", true],
    ["sort=price+order=z", "a", "", true],
    ["zdr+bits=8+region=us+only=a", "a", "zdr+bits=8+region=us", true],
    ["zdr+bits=8+region=us+only=a", "a", "zdr+bits=8+region=us,de", false],
    ["zdr+bits=8+region=us+only=a", "b", "zdr+bits=8+region=us", false],
  ];
  for (const [p, provider, f, expected] of cases) assert.equal(meets({ provider, facts: facts(f) }, policy(p)), expected, `${p} vs ${provider} [${f}]`);
});

test("G28: a vendor requirement is met only when the route's facts carry the key and the gateway's rule agrees", () => {
  const support = withKeys("acme.tier");
  const required = policy("acme.tier=2", support, tierRule);
  const route = (text: string) => ({ provider: "a", facts: facts(text) });
  assert.equal(meets(route("acme.tier=2"), required, tierRule), true);
  assert.equal(meets(route("acme.tier=1"), required, tierRule), true);
  assert.equal(meets(route("acme.tier=3"), required, tierRule), false);
  // No rule: never met. Rule that says yes to everything, but the route does not publish the key: not met.
  assert.equal(meets(route("acme.tier=2"), required), false);
  const yes: VendorRules = new Map([["acme.tier", { accepts: () => true, meets: () => true }]]);
  assert.equal(meets(route(""), required, yes), false);
  assert.equal(meets(route("zdr"), required, yes), false);
  assert.equal(meets(route("acme.tier=3"), required, yes), true);
});

test("G7: order first as listed, then the rest by rank, and unknown ids have no effect", () => {
  const routes = [
    { provider: "a", price: 3 },
    { provider: "b", price: 1 },
    { provider: "c", price: 2 },
    { provider: "d", price: 2 },
  ];
  const ids = (p: string): string =>
    orderRoutes(routes, policy(p), (route) => route.price)
      .map((route) => route.provider)
      .join("");
  assert.equal(ids("sort=price"), "bcda");
  assert.equal(ids("order=d,a"), "dabc");
  // The remainder (a, b, c) is not already in rank order, so it must be ranked after the ordered one.
  assert.equal(ids("order=d+sort=price"), "dbca");
  assert.equal(ids("order=c,nosuch+sort=price"), "cbda");
  assert.equal(ids("order=nosuch"), "abcd");
  assert.equal(ids("zdr"), "abcd");
  assert.equal(routes.map((route) => route.provider).join(""), "abcd");
});

test("S14: Route-Applied names the provider first, then the facts, whose limits are their own", () => {
  assert.equal(formatApplied("aurora", facts("")), "provider=aurora");
  assert.equal(formatApplied("aurora", facts("zdr+bits=8+region=us")), "provider=aurora+zdr+bits=8+region=us");

  const bare = parseApplied("provider=aurora");
  assert.ok(bare.ok);
  assert.deepEqual(bare.value, { provider: "aurora", facts: facts("") });

  const parsed = parseApplied("provider=aurora+zdr+bits=8+region=us+later=1");
  assert.ok(parsed.ok);
  assert.equal(parsed.value.provider, "aurora");
  assert.deepEqual(parsed.value.facts, { zdr: true, notrain: false, bits: 8, region: ["us"], attest: [], other: new Map<string, Value>([["later", ["1"]]]) });

  for (const text of ["", "zdr", "zdr+provider=a", "xrovider=a", "provide=aurora", "provider", "provider=", "provider=a,b", "provider=A", "provider=org/a", "provider=a+", "provider=a+provider=b", "provider=a+bits=0", "provider=a+order=b", "provider=a+only=b"]) {
    assert.equal(parseApplied(text).ok, false, text);
  }

  // Sixteen fact pairs and a 512-byte facts string are legal facts, so they round-trip behind the provider.
  const sixteen = facts(Array.from({ length: 16 }, (_, i) => `v.k${i}`).join("+"));
  const many = parseApplied(formatApplied("aurora", sixteen));
  assert.ok(many.ok);
  assert.equal(many.value.facts.other.size, 16);
  const long = facts(`v.k=${Array.from({ length: 15 }, (_, i) => String.fromCharCode(97 + i).repeat(32)).join(",")},${"p".repeat(13)}`);
  assert.equal(formatFacts(long).length, 512);
  const wide = parseApplied(formatApplied("aurora", long));
  assert.ok(wide.ok);
  assert.equal(formatFacts(wide.value.facts).length, 512);
});

test("S17: provider ids are items", () => {
  for (const id of ["aurora", "a", "0", "data-east", "a.b_c"]) assert.equal(isProviderId(id), true, id);
  for (const id of ["", "org/provider", "Data-East", "a b", "-a", "a".repeat(33)]) assert.equal(isProviderId(id), false, id);
});

test("S15: Route-Refused is a reason, then a key only with unsupported, and nothing else", () => {
  assert.equal(formatRefused("unsupported", "bits"), "reason=unsupported+key=bits");
  assert.equal(formatRefused("unsupported"), "reason=unsupported");
  assert.equal(formatRefused("unavailable"), "reason=unavailable");
  assert.deepEqual(parseRefused("reason=unsupported+key=acme.tier"), { ok: true, value: { reason: "unsupported", key: "acme.tier" } });
  assert.deepEqual(parseRefused("reason=unsupported"), { ok: true, value: { reason: "unsupported", key: null } });
  assert.deepEqual(parseRefused("reason=unsatisfiable"), { ok: true, value: { reason: "unsatisfiable", key: null } });
  assert.deepEqual(parseRefused("reason=unavailable"), { ok: true, value: { reason: "unavailable", key: null } });
  for (const text of [
    "",
    "reason=other",
    "key=bits",
    "key=bits+reason=unsupported",
    "reason=unsupported+reason=unavailable",
    "reason=unsupported+key=bits+key=only",
    "reason=unsupported+key=Bad",
    "reason=unsupported+key=",
    "reason=unsupported++",
    "reason=unsupported+garbage",
    "what=ever+reason=unsupported",
    "reason=unsatisfiable+key=bits",
    "reason=unavailable+key=bits",
    " reason=unsupported",
  ]) {
    assert.equal(parseRefused(text).ok, false, text);
  }
});

test("C6: a detection reply without lists means the baseline, and unknown members are ignored", () => {
  const minimal = parseDetection({ route_policy: 1, extra: { anything: true } });
  assert.ok(minimal.ok);
  assert.deepEqual([...minimal.value.support.keys], ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "sort", "order"]);
  assert.deepEqual([...minimal.value.support.attest], ["weights", "prompt"]);
  assert.deepEqual([...minimal.value.support.sort], ["price", "latency", "throughput"]);
  assert.equal(minimal.value.keyPolicy, null);
  assert.equal(supports(minimal.value.support, policy("attest=weights,prompt+sort=throughput")), true);
});

test("C6: keys and values this revision does not define are dropped from what the client may use", () => {
  const newer = parseDetection({ route_policy: 1, keys: ["zdr", "later", "acme.tier"], attest: ["weights", "later"], sort: ["price", "later"], key_policy: "zdr+later=x+acme.tier=2" });
  assert.ok(newer.ok);
  assert.deepEqual([...newer.value.support.keys], ["zdr", "acme.tier"]);
  assert.deepEqual([...newer.value.support.attest], ["weights"]);
  assert.deepEqual([...newer.value.support.sort], ["price"]);
  assert.equal(newer.value.keyPolicy, "zdr+later=x+acme.tier=2");
  assert.equal(supports(newer.value.support, policy("zdr")), true);
  assert.equal(supports(newer.value.support, policy("notrain")), false);
});

test("C6: a reply with any known member invalid is no detection", () => {
  const bodies: unknown[] = [
    null,
    [],
    "text",
    {},
    { route_policy: "1" },
    { route_policy: 2 },
    Object.create({ route_policy: 1 }),
    { route_policy: 1, keys: "zdr" },
    { route_policy: 1, keys: ["bits", "bad key"] },
    { route_policy: 1, keys: ["a.b.c"] },
    { route_policy: 1, keys: [1] },
    { route_policy: 1, sort: [1] },
    { route_policy: 1, sort: ["a,b"] },
    { route_policy: 1, attest: {} },
    { route_policy: 1, attest: ["Weights"] },
    { route_policy: 1, key_policy: 5 },
    { route_policy: 1, key_policy: "" },
    { route_policy: 1, key_policy: "only=" },
    { route_policy: 1, key_policy: "bits=0" },
    { route_policy: 1, keys: [], key_policy: "zdr" },
    { route_policy: 1, sort: ["price"], key_policy: "sort=latency" },
    { route_policy: 1, attest: ["weights"], key_policy: "attest=prompt" },
    { route_policy: 1, key_policy: "region=ab" },
  ];
  for (const body of bodies) assert.equal(parseDetection(body).ok, false, JSON.stringify(body));
});

test("G20 to G22: what a gateway formats is what a client reads back, lists and key policy included", () => {
  const support: Support = { keys: new Set(["zdr", "sort", "attest", "acme.tier"]), attest: new Set(["prompt"]), sort: new Set(["latency", "price"]) };
  const body: unknown = JSON.parse(JSON.stringify(formatDetection(support, "zdr+acme.tier=2")));
  assert.deepEqual(body, { route_policy: 1, keys: ["zdr", "sort", "attest", "acme.tier"], attest: ["prompt"], sort: ["latency", "price"], key_policy: "zdr+acme.tier=2" });
  const parsed = parseDetection(body);
  assert.ok(parsed.ok);
  assert.deepEqual([...parsed.value.support.keys], ["zdr", "sort", "attest", "acme.tier"]);
  assert.deepEqual([...parsed.value.support.attest], ["prompt"]);
  assert.deepEqual([...parsed.value.support.sort].sort(), ["latency", "price"]);
  assert.equal(parsed.value.keyPolicy, "zdr+acme.tier=2");
  assert.equal(Object.hasOwn(formatDetection(support), "key_policy"), false);
});

test("the baseline cannot be changed by a caller", () => {
  const first = baselineSupport();
  (first.attest as Set<string>).add("custom");
  (first.keys as Set<string>).delete("zdr");
  assert.equal(parsePolicy("attest=custom").ok, false);
  assert.equal(parsePolicy("zdr").ok, true);
  assert.equal(baselineSupport().keys.has("zdr"), true);
});
