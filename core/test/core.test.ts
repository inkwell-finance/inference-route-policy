import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BASELINE_SUPPORT,
  combinePolicies,
  formatApplied,
  formatDetection,
  formatFacts,
  formatPolicy,
  formatRefused,
  hasRequirements,
  meets,
  orderRoutes,
  parseApplied,
  parseDetection,
  parseFacts,
  parsePolicy,
  parseRefused,
  splitModel,
  supports,
  type Facts,
  type Policy,
  type Support,
} from "../src/index.ts";

function policy(text: string, support?: Support): Policy {
  const parsed = parsePolicy(text, support);
  assert.ok(parsed.ok, `"${text}" should parse: ${parsed.ok ? "" : parsed.detail}`);
  return parsed.value;
}

function facts(text: string): Facts {
  const parsed = parseFacts(text);
  assert.ok(parsed.ok, `facts "${text}" should parse`);
  return parsed.value;
}

/** Asserts a refusal and returns the key it names. */
function refusedKey(text: string, support?: Support): string | null {
  const parsed = parsePolicy(text, support);
  assert.ok(!parsed.ok, `"${text}" should be refused`);
  return parsed.key;
}

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
    vendor: {},
  });
});

test("S1: empty strings, empty pairs, empty lists, and whitespace are malformed", () => {
  for (const text of ["", "+", "zdr+", "+zdr", "zdr++notrain", "only=", "only=a,", "only=,a", "zdr ", " zdr", "zdr+ notrain", "only=a, b", "=a", "zdr=", "bits==8"]) {
    refusedKey(text);
  }
});

test("S2: key and item character sets and lengths are enforced at the boundary", () => {
  const support: Support = { ...BASELINE_SUPPORT, keys: new Set([...BASELINE_SUPPORT.keys, `v.${"k".repeat(16)}`, `${"v".repeat(16)}.k`]) };
  policy(`v.${"k".repeat(16)}`, support);
  policy(`${"v".repeat(16)}.k`, support);
  assert.equal(refusedKey(`v.${"k".repeat(17)}`, support), null);
  assert.equal(refusedKey(`${"v".repeat(17)}.k`, support), null);
  for (const key of ["Zdr", "1zdr", "z_dr", "z-dr", "a.b.c", "a.", ".a", "a..b"]) assert.equal(refusedKey(key), null, key);

  policy(`only=${"a".repeat(32)}`);
  assert.equal(refusedKey(`only=${"a".repeat(33)}`), "only");
  policy("only=0a,a_b,a.b,a-b");
  for (const item of ["A", "_a", ".a", "-a", "a b", "a/b", "a:b", "a~b"]) assert.equal(refusedKey(`only=${item}`), "only", item);
});

test("S3: a repeated key or a repeated item is malformed and names the key", () => {
  assert.equal(refusedKey("zdr+zdr"), "zdr");
  assert.equal(refusedKey("only=a+only=b"), "only");
  assert.equal(refusedKey("only=a,a"), "only");
  assert.equal(refusedKey("region=us,de,us"), "region");
});

test("S4: limits are inclusive at 512 bytes, 16 pairs, and 16 items", () => {
  const items = (n: number): string => Array.from({ length: n }, (_, i) => `p${i}`).join(",");
  policy(`only=${items(16)}`);
  assert.equal(refusedKey(`only=${items(17)}`), "only");

  const vendorKeys = Array.from({ length: 17 }, (_, i) => `v.k${i}`);
  const support: Support = { ...BASELINE_SUPPORT, keys: new Set(vendorKeys) };
  policy(vendorKeys.slice(0, 16).join("+"), support);
  assert.equal(refusedKey(vendorKeys.join("+"), support), null);

  // "only=" and fifteen 32-byte items is 499 bytes; a sixteenth item of 12 bytes makes exactly 512.
  const fifteen = Array.from({ length: 15 }, (_, i) => String.fromCharCode(97 + i).repeat(32)).join(",");
  const at = `only=${fifteen},${"p".repeat(12)}`;
  assert.equal(at.length, 512);
  policy(at);
  const over = `only=${fifteen},${"p".repeat(13)}`;
  assert.equal(over.length, 513);
  assert.equal(refusedKey(over), null);
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

test("S7: region takes two-letter lowercase codes", () => {
  assert.deepEqual(policy("region=us").region, ["us"]);
  for (const value of ["usa", "u", "u1", "us,deu", "eu-west"]) assert.equal(refusedKey(`region=${value}`), "region", value);
  assert.equal(refusedKey("region"), "region");
});

test("S8, S10: attest and sort accept only the values the gateway lists", () => {
  assert.equal(refusedKey("attest=weights,other"), "attest");
  assert.equal(refusedKey("attest"), "attest");
  assert.equal(refusedKey("sort=cheap"), "sort");
  assert.equal(refusedKey("sort=price,latency"), "sort");
  assert.equal(refusedKey("sort"), "sort");

  const narrow: Support = { keys: BASELINE_SUPPORT.keys, attest: new Set(["weights"]), sort: new Set(["price"]) };
  policy("attest=weights+sort=price", narrow);
  assert.equal(refusedKey("attest=prompt", narrow), "attest");
  assert.equal(refusedKey("sort=latency", narrow), "sort");
});

test("S9: only, ignore, and order take lists", () => {
  for (const key of ["only", "ignore", "order"]) assert.equal(refusedKey(key), key);
});

test("unknown keys are refused by name, the first offending key wins, and vendor keys need the gateway to define them", () => {
  assert.equal(refusedKey("zdr+later=1"), "later");
  assert.equal(refusedKey("later+bits=999"), "later");
  assert.equal(refusedKey("bits=999+later"), "bits");
  assert.equal(refusedKey("acme.tier=2"), "acme.tier");

  const subset: Support = { ...BASELINE_SUPPORT, keys: new Set(["only", "sort"]) };
  assert.equal(refusedKey("zdr", subset), "zdr");

  const vendor: Support = { ...BASELINE_SUPPORT, keys: new Set([...BASELINE_SUPPORT.keys, "acme.tier", "acme.audited"]) };
  assert.deepEqual(policy("acme.tier=2+acme.audited", vendor).vendor, { "acme.tier": ["2"], "acme.audited": true });

  // A dotless key the gateway lists but this document does not define cannot be accepted.
  assert.equal(refusedKey("later", { ...BASELINE_SUPPORT, keys: new Set(["later"]) }), "later");
});

test("formatting a parsed policy and parsing it again gives the same policy", () => {
  const vendor: Support = { ...BASELINE_SUPPORT, keys: new Set([...BASELINE_SUPPORT.keys, "acme.tier", "acme.audited"]) };
  for (const text of ["zdr", "sort=price", "order=b,a+sort=throughput", "acme.tier=2+zdr+acme.audited", "ignore=c+only=a,b+attest=prompt+region=de,us+bits=16+notrain+zdr"]) {
    const first = policy(text, vendor);
    assert.deepEqual(policy(formatPolicy(first), vendor), first, text);
  }
  assert.equal(formatPolicy(policy("sort=price+zdr+bits=8")), "zdr+bits=8+sort=price");
});

test("hasRequirements separates requirements from preferences", () => {
  assert.equal(hasRequirements(policy("sort=price+order=a")), false);
  for (const text of ["zdr", "notrain", "bits=8", "region=us", "attest=weights", "only=a", "ignore=a"]) assert.equal(hasRequirements(policy(text)), true, text);
  const vendor: Support = { ...BASELINE_SUPPORT, keys: new Set(["acme.tier"]) };
  assert.equal(hasRequirements(policy("acme.tier=2", vendor)), true);
});

test("supports checks every key and value against a detection reply", () => {
  const narrow: Support = { keys: new Set(["zdr", "sort", "attest"]), attest: new Set(["weights"]), sort: new Set(["price"]) };
  assert.equal(supports(narrow, policy("zdr+sort=price+attest=weights")), true);
  assert.equal(supports(narrow, policy("zdr+bits=8")), false);
  assert.equal(supports(narrow, policy("sort=latency")), false);
  assert.equal(supports(narrow, policy("attest=prompt")), false);
});

test("S11: the model field splits at its first plus", () => {
  assert.deepEqual(splitModel("example-model"), { id: "example-model", policy: null });
  assert.deepEqual(splitModel("vendor/example-model:free+zdr+sort=price"), { id: "vendor/example-model:free", policy: "zdr+sort=price" });
  assert.deepEqual(splitModel("example-model+"), { id: "example-model", policy: "" });
  assert.deepEqual(splitModel("+zdr"), { id: "", policy: "zdr" });
  assert.equal(parsePolicy("").ok, false);
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
    vendor: {},
  });
});

test("combining: an empty intersection stays empty and qualifies no route", () => {
  const combined = combinePolicies({ key: policy("region=us+only=a"), suffix: policy("region=de+only=b") });
  assert.ok(combined.ok);
  assert.deepEqual(combined.value.region, []);
  assert.deepEqual(combined.value.only, []);
  assert.equal(meets({ provider: "a", facts: facts("region=us") }, combined.value), false);
  assert.equal(meets({ provider: "b", facts: facts("region=de") }, combined.value), false);
});

test("combining: the most specific preference wins, per key", () => {
  const all = combinePolicies({ key: policy("sort=price+order=a"), header: policy("sort=latency+order=b"), suffix: policy("sort=throughput") });
  assert.ok(all.ok);
  assert.equal(all.value.sort, "throughput");
  assert.deepEqual(all.value.order, ["b"]);

  const keyOnly = combinePolicies({ key: policy("sort=price+order=a") });
  assert.ok(keyOnly.ok);
  assert.equal(keyOnly.value.sort, "price");
  assert.deepEqual(keyOnly.value.order, ["a"]);
});

test("combining: no layer removes a requirement of another", () => {
  const key = policy("zdr+notrain+bits=16+region=us+attest=weights+only=a+ignore=b");
  for (const other of ["sort=price", "bits=1", "region=us,de,fr", "only=a,b,c", "attest=prompt", "ignore=c"]) {
    const combined = combinePolicies({ key, suffix: policy(other) });
    assert.ok(combined.ok);
    const { value } = combined;
    assert.equal(value.zdr && value.notrain, true, other);
    assert.equal(value.bits, 16, other);
    assert.deepEqual(value.region, ["us"], other);
    assert.deepEqual(value.only, ["a"], other);
    assert.ok(value.attest.includes("weights"), other);
    assert.ok(value.ignore.includes("b"), other);
  }
});

test("combining: a vendor key with different values by two carriers is refused; the same value is kept", () => {
  const support: Support = { ...BASELINE_SUPPORT, keys: new Set(["acme.tier", "acme.audited"]) };
  const conflict = combinePolicies({ key: policy("acme.tier=1", support), suffix: policy("acme.tier=2", support) });
  assert.ok(!conflict.ok);
  assert.equal(conflict.key, "acme.tier");

  const flagAndList = combinePolicies({ key: policy("acme.tier", support), header: policy("acme.tier=2", support) });
  assert.ok(!flagAndList.ok);

  const same = combinePolicies({ key: policy("acme.tier=2+acme.audited", support), header: policy("acme.tier=2", support) });
  assert.ok(same.ok);
  assert.deepEqual(same.value.vendor, { "acme.tier": ["2"], "acme.audited": true });
});

test("S12: facts parse, allow the empty string, and keep unknown keys without matching them", () => {
  assert.deepEqual(facts(""), { zdr: false, notrain: false, bits: null, region: null, attest: [], other: {} });
  assert.deepEqual(facts("zdr+bits=8+region=us,de+attest=weights+acme.tier=2+later"), {
    zdr: true,
    notrain: false,
    bits: 8,
    region: ["us", "de"],
    attest: ["weights"],
    other: { "acme.tier": ["2"], later: true },
  });
  for (const text of ["zdr=1", "bits=0", "region=usa", "attest", "zdr+zdr", "+"]) assert.equal(parseFacts(text).ok, false, text);
  const text = "zdr+notrain+bits=8+region=us,de+attest=weights,prompt+acme.tier=2";
  assert.equal(formatFacts(facts(text)), text);
});

test("meets: each requirement is checked against the route's facts, and an absent fact is not met", () => {
  const route = (provider: string, text: string) => ({ provider, facts: facts(text) });
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
    ["attest=prompt", "a", "", false],
    ["only=a,b", "a", "", true],
    ["only=a,b", "c", "zdr", false],
    ["only=unknown", "a", "", false],
    ["ignore=a", "a", "zdr", false],
    ["ignore=a", "b", "", true],
    ["ignore=unknown", "a", "", true],
    ["sort=price+order=z", "a", "", true],
    ["zdr+bits=8+region=us+only=a", "a", "zdr+bits=8+region=us", true],
    ["zdr+bits=8+region=us+only=a", "a", "zdr+bits=8+region=us,de", false],
  ];
  for (const [p, provider, f, expected] of cases) assert.equal(meets(route(provider, f), policy(p)), expected, `${p} vs ${provider} [${f}]`);
});

test("meets: vendor requirements are met only as the gateway's own rule says", () => {
  const support: Support = { ...BASELINE_SUPPORT, keys: new Set(["acme.tier"]) };
  const required = policy("acme.tier=2", support);
  const route = { provider: "a", facts: facts("acme.tier=2") };
  assert.equal(meets(route, required), false);
  assert.equal(meets(route, required, (key, value, f) => key === "acme.tier" && value !== true && f.other["acme.tier"] !== true && f.other["acme.tier"]?.[0] === value[0]), true);
  assert.equal(meets({ provider: "a", facts: facts("acme.tier=3") }, required, (_key, value, f) => value !== true && f.other["acme.tier"] !== true && f.other["acme.tier"]?.[0] === value[0]), false);
});

test("orderRoutes: order first as listed, then by rank, and unknown ids have no effect", () => {
  const routes = [
    { provider: "a", price: 3 },
    { provider: "b", price: 1 },
    { provider: "c", price: 2 },
    { provider: "d", price: 2 },
  ];
  const ids = (p: string): string => orderRoutes(routes, policy(p), (route) => route.price).map((route) => route.provider).join("");
  assert.equal(ids("sort=price"), "bcda");
  assert.equal(ids("order=d,a"), "dabc");
  assert.equal(ids("order=d,zzz,a+sort=price"), "dabc");
  assert.equal(ids("order=c"), "cabd");
  assert.equal(ids("zdr"), "abcd");
  assert.equal(routes.map((route) => route.provider).join(""), "abcd");
});

test("S13: Route-Applied names the provider, then the facts when there are any", () => {
  assert.equal(formatApplied("aurora", facts("")), "provider=aurora");
  assert.equal(formatApplied("aurora", facts("zdr+bits=8+region=us")), "provider=aurora+zdr+bits=8+region=us");
  const parsed = parseApplied("provider=aurora+zdr+bits=8+region=us+later=1");
  assert.ok(parsed.ok);
  assert.equal(parsed.value.provider, "aurora");
  assert.deepEqual(parsed.value.facts, { zdr: true, notrain: false, bits: 8, region: ["us"], attest: [], other: { later: ["1"] } });
  for (const text of ["zdr", "provider", "provider=a,b", "provider=a+provider=b", "provider=a+bits=0", ""]) assert.equal(parseApplied(text).ok, false, text);
});

test("S14: Route-Refused carries a reason and, when there is one, a key", () => {
  assert.equal(formatRefused("unsupported", "bits"), "reason=unsupported+key=bits");
  assert.equal(formatRefused("unavailable"), "reason=unavailable");
  assert.deepEqual(parseRefused("reason=unsupported+key=acme.tier"), { ok: true, value: { reason: "unsupported", key: "acme.tier" } });
  assert.deepEqual(parseRefused("reason=unsatisfiable"), { ok: true, value: { reason: "unsatisfiable", key: null } });
  for (const text of ["", "reason=other", "key=bits", "reason=unsupported+key=Bad Key"]) assert.equal(parseRefused(text).ok, false, text);
});

test("detection: absent lists mean the baseline, unknown members are ignored, and a wrong shape is refused", () => {
  const minimal = parseDetection({ route_policy: 1, extra: { anything: true } });
  assert.ok(minimal.ok);
  assert.deepEqual([...minimal.value.support.keys], [...BASELINE_SUPPORT.keys]);
  assert.deepEqual([...minimal.value.support.attest], ["weights", "prompt"]);
  assert.deepEqual([...minimal.value.support.sort], ["price", "latency", "throughput"]);
  assert.equal(minimal.value.keyPolicy, null);

  const narrow = parseDetection({ route_policy: 1, keys: ["zdr", "acme.tier"], attest: [], sort: ["price"], key_policy: "zdr" });
  assert.ok(narrow.ok);
  assert.deepEqual([...narrow.value.support.keys], ["zdr", "acme.tier"]);
  assert.equal(narrow.value.support.attest.size, 0);
  assert.equal(narrow.value.keyPolicy, "zdr");

  for (const body of [null, [], "text", {}, { route_policy: "1" }, { route_policy: 2 }, { route_policy: 1, keys: "zdr" }, { route_policy: 1, sort: [1] }, { route_policy: 1, attest: {} }, { route_policy: 1, key_policy: 5 }]) {
    assert.equal(parseDetection(body).ok, false, JSON.stringify(body));
  }
});

test("detection: what a gateway formats is what a client reads back", () => {
  const support: Support = { keys: new Set(["zdr", "sort"]), attest: new Set(["weights"]), sort: new Set(["price"]) };
  const body: unknown = JSON.parse(JSON.stringify(formatDetection(support, "zdr")));
  const parsed = parseDetection(body);
  assert.ok(parsed.ok);
  assert.deepEqual([...parsed.value.support.keys], ["zdr", "sort"]);
  assert.equal(parsed.value.keyPolicy, "zdr");
  assert.equal("key_policy" in formatDetection(support), false);
});
