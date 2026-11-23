import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { COUNTRIES } from "../src/countries.ts";
import {
  baselineSupport,
  clearedToSend,
  combinePolicies,
  formatApplied,
  formatDetection,
  formatPolicy,
  formatRefused,
  hasRequirements,
  isEvidenceUri,
  isProviderId,
  meets,
  orderRoutes,
  parseApplied,
  parseDetection,
  parseFacts,
  parsePolicy,
  parsePublishedFacts,
  parseRefused,
  readOutcome,
  splitModel,
  supports,
  type Facts,
  type Policy,
  type Support,
  type Value,
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

/** Asserts the policy is refused and returns the key the refusal names. */
function refusedKey(text: string, support?: Support): string | null {
  const parsed = parsePolicy(text, support);
  assert.ok(!parsed.ok, `"${text}" should be refused`);
  return parsed.key;
}

test("S1: a policy with every key parses to its meaning", () => {
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
  });
  assert.deepEqual(policy("sort=price"), { zdr: false, notrain: false, bits: null, region: null, attest: [], only: null, ignore: [], sort: "price", order: null });
});

test("S1: empty strings, empty pairs, empty lists, and whitespace are malformed", () => {
  for (const text of ["", "+", "zdr+", "+zdr", "zdr++notrain", "only=", "only=a,", "only=,a", "zdr ", " zdr", "zdr+ notrain", "only=a, b", "=a", "zdr=", "bits==8", "zdr\n", "zdr\t+notrain"]) {
    refusedKey(text);
  }
});

test("S2: key and item character sets and lengths are enforced at the boundary", () => {
  // A 16-character key is well formed, so it is refused by name; a 17-character one is not a key at all.
  assert.equal(refusedKey("k".repeat(16)), "k".repeat(16));
  assert.equal(refusedKey("k".repeat(17)), null);
  for (const key of ["Zdr", "1zdr", "z_dr", "z-dr", "a.b", "acme.tier=2", "a.", ".a", "zdr\u00e9", "__proto__"]) assert.equal(refusedKey(key), null, key);

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

  // Only facts can hold sixteen distinct well-formed keys, since a reader keeps the ones it does not know.
  const unknown = Array.from({ length: 17 }, (_, i) => `k${i}`);
  assert.equal(facts(unknown.slice(0, 16).join("+")).other.size, 16);
  const seventeen = parseFacts(unknown.join("+"));
  assert.ok(!seventeen.ok);
  assert.equal(seventeen.key, null);

  // "only=" and fifteen 32-byte items is 499 bytes; a sixteenth item of 12 bytes makes exactly 512.
  const fifteen = Array.from({ length: 15 }, (_, i) => String.fromCharCode(97 + i).repeat(32)).join(",");
  const at = `only=${fifteen},${"p".repeat(12)}`;
  assert.equal(at.length, 512);
  policy(at);
  assert.equal(refusedKey(`only=${fifteen},${"p".repeat(13)}`), null);

  // 264 characters but 514 bytes: over the limit, so no key is named, although its first pair is well formed.
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

test("S7: region takes exactly the assigned ISO 3166-1 alpha-2 codes", () => {
  // The set, checked once against an independent ISO 3166-1 listing, is pinned by its digest so that no code can
  // be swapped for another without this failing.
  const codes = Object.keys(COUNTRIES).sort();
  assert.equal(codes.length, 249);
  assert.equal(createHash("sha256").update(codes.join(",")).digest("hex"), "792d849dd15e8c7053629d4ce0683b28565d05f4f1f5431d13284245313534c6");
  for (const code of codes) assert.deepEqual(policy(`region=${code}`).region, [code]);

  assert.deepEqual(policy("region=us,de,jp").region, ["us", "de", "jp"]);
  for (const value of ["ab", "eu", "uk", "xk", "xa", "zz", "usa", "u", "u1", "us,deu", "us,ab", "constructor"]) assert.equal(refusedKey(`region=${value}`), "region", value);
  assert.equal(refusedKey("region"), "region");
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
  const tail = Array.from({ length: 16 }, (_, i) => `k${i}`).join("+");
  // Sixteen pairs: the first, which is invalid, is named. Seventeen: the whole string fails first.
  assert.equal(refusedKey(`bits=0+${tail.split("+").slice(0, 15).join("+")}`), "bits");
  assert.equal(refusedKey(`bits=0+${tail}`), null);
  assert.equal(refusedKey(`bits=0+only=${"a".repeat(32)},${"b,".repeat(250)}c`), null);
});

test("S16: the first failing pair in the order written decides, whatever each pair's failure is", () => {
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
  assert.equal(refusedKey("zdr+notrain+zdr+bits=0"), "zdr");
});

test("G21: a key the gateway does not list is refused by name, and listing an undefined key does not define it", () => {
  const subset: Support = { ...baselineSupport(), keys: new Set(["only", "sort"]) };
  assert.equal(refusedKey("zdr", subset), "zdr");
  assert.equal(refusedKey("only=a+bits=8", subset), "bits");
  policy("only=a+sort=price", subset);
  assert.equal(refusedKey("later", { ...baselineSupport(), keys: new Set(["later"]) }), "later");
});

test("formatPolicy: a parsed policy formats to a string that parses to the same policy", () => {
  for (const text of ["zdr", "sort=price", "order=b,a+sort=throughput", "ignore=c+only=a,b+attest=prompt+region=de,us+bits=16+notrain+zdr"]) {
    const first = policy(text);
    const formatted = formatPolicy(first);
    assert.ok(formatted.ok, text);
    assert.deepEqual(policy(formatted.value), first, text);
  }
  assert.deepEqual(formatPolicy(policy("sort=price+zdr+bits=8")), { ok: true, value: "zdr+bits=8+sort=price" });
});

test("C10: a policy that cannot be written as a valid one fails to format instead of producing a string", () => {
  const cases: [name: string, policy: Policy, key: string | null][] = [
    ["nothing", combinePolicies({}), null],
    ["disjoint region", combinePolicies({ key: policy("region=us"), suffix: policy("region=de") }), "region"],
    ["disjoint only", combinePolicies({ key: policy("only=a"), suffix: policy("only=b") }), "only"],
    ["17 ignores", combinePolicies({ key: policy(`ignore=${Array.from({ length: 16 }, (_, i) => `p${i}`).join(",")}`), suffix: policy("ignore=extra") }), "ignore"],
    ["bits out of range", { ...policy("zdr"), bits: 0 }, "bits"],
    ["undefined sort", { ...policy("zdr"), sort: "custom" }, "sort"],
    ["undefined attest", { ...policy("zdr"), attest: ["custom"] }, "attest"],
    ["unassigned region", { ...policy("zdr"), region: ["ab"] }, "region"],
    ["malformed provider id", { ...policy("zdr"), only: ["Org/Provider"] }, "only"],
    // These fit the grammar once joined, and would read back as a different, weaker policy.
    ["comma inside an item", { ...policy("zdr"), only: ["a,b"] }, null],
    ["plus inside an item", { ...policy("notrain"), region: ["us+zdr"] }, null],
    ["a second sort", { ...policy("zdr"), sort: "price+order=a" }, null],
  ];
  for (const [name, value, key] of cases) {
    const formatted = formatPolicy(value);
    assert.ok(!formatted.ok, name);
    assert.equal(formatted.key, key, name);
  }
  assert.equal(combinePolicies({ key: policy(`ignore=${Array.from({ length: 16 }, (_, i) => `p${i}`).join(",")}`), suffix: policy("ignore=extra") }).ignore.length, 17);
});

test("hasRequirements separates requirements from preferences", () => {
  assert.equal(hasRequirements(policy("sort=price")), false);
  assert.equal(hasRequirements(policy("order=a")), false);
  assert.equal(hasRequirements(policy("sort=price+order=a")), false);
  for (const text of ["zdr", "notrain", "bits=8", "region=us", "attest=weights", "only=a", "ignore=a"]) {
    assert.equal(hasRequirements(policy(text)), true, text);
    assert.equal(hasRequirements(policy(`sort=price+${text}`)), true, text);
  }
});

test("C1: supports needs every key listed, and every attest and sort value listed, wherever it stands in its list", () => {
  const narrow: Support = { keys: new Set(["zdr", "sort", "attest", "bits", "region", "only"]), attest: new Set(["weights"]), sort: new Set(["price"]) };
  assert.equal(supports(narrow, policy("zdr+sort=price+attest=weights")), true);
  assert.equal(supports(narrow, policy("notrain")), false);
  assert.equal(supports(narrow, policy("zdr+ignore=a")), false);
  assert.equal(supports(narrow, policy("zdr+order=a")), false);
  assert.equal(supports(narrow, policy("sort=latency")), false);
  assert.equal(supports(narrow, policy("attest=prompt")), false);
  assert.equal(supports(narrow, policy("attest=weights,prompt")), false);
  assert.equal(supports(narrow, policy("attest=prompt,weights")), false);
  // Keys with a fixed domain have no list of values to check.
  assert.equal(supports(narrow, policy("bits=64+region=fr+only=constructor")), true);
});

test("S11: the model field splits at its first plus", () => {
  assert.deepEqual(splitModel("example-model"), { id: "example-model", policy: null });
  assert.deepEqual(splitModel("vendor/example-model:free+zdr+sort=price"), { id: "vendor/example-model:free", policy: "zdr+sort=price" });
  assert.deepEqual(splitModel("example-model+"), { id: "example-model", policy: "" });
  assert.deepEqual(splitModel("+zdr"), { id: "", policy: "zdr" });
  assert.deepEqual(splitModel(""), { id: "", policy: null });
  // What follows the plus is a policy like any other: an empty one is refused, with no key.
  assert.equal(refusedKey(splitModel("example-model+").policy ?? "unreachable"), null);
});

test("combining: requirements accumulate and only narrow", () => {
  assert.deepEqual(
    combinePolicies({
      key: policy("zdr+bits=8+region=us,de,fr+only=a,b,c+ignore=x+attest=weights"),
      header: policy("notrain+bits=16+region=de,fr+ignore=y"),
      suffix: policy("bits=4+region=fr,gb+only=b,c,d+attest=prompt"),
    }),
    { zdr: true, notrain: true, bits: 16, region: ["fr"], attest: ["prompt", "weights"], only: ["b", "c"], ignore: ["y", "x"], sort: null, order: null },
  );
  // bits is the highest wherever it comes from.
  assert.equal(combinePolicies({ key: policy("bits=32"), header: policy("bits=8"), suffix: policy("bits=16") }).bits, 32);
  assert.equal(combinePolicies({ key: policy("bits=8"), suffix: policy("bits=32") }).bits, 32);
  // A union lists each item once, even when two carriers share one.
  assert.deepEqual(combinePolicies({ key: policy("ignore=a,b+attest=weights"), header: policy("ignore=b,c+attest=weights,prompt"), suffix: policy("ignore=a,c") }).ignore, ["a", "c", "b"]);
  assert.deepEqual(combinePolicies({ key: policy("attest=weights"), header: policy("attest=weights,prompt") }).attest, ["weights", "prompt"]);
  assert.deepEqual(formatPolicy(combinePolicies({ key: policy("ignore=a,b"), suffix: policy("ignore=a,c") })), { ok: true, value: "ignore=a,c,b" });
});

test("G12: an empty region intersection alone, and an empty only intersection alone, each qualify no route", () => {
  const open = { provider: "a", facts: facts("region=us") };

  const region = combinePolicies({ key: policy("region=us"), suffix: policy("region=de") });
  assert.deepEqual(region.region, []);
  assert.equal(region.only, null);
  assert.equal(meets(open, region), false);
  assert.equal(meets({ provider: "a", facts: facts("region=de") }, region), false);
  assert.equal(meets({ provider: "a", facts: facts("") }, region), false);

  const only = combinePolicies({ key: policy("only=a"), header: policy("only=b") });
  assert.deepEqual(only.only, []);
  assert.equal(only.region, null);
  assert.equal(meets(open, only), false);
  assert.equal(meets({ provider: "b", facts: facts("") }, only), false);
});

test("combining: the most specific preference wins, per key", () => {
  const all = combinePolicies({ key: policy("sort=price+order=a"), header: policy("sort=latency+order=b"), suffix: policy("sort=throughput") });
  assert.equal(all.sort, "throughput");
  assert.deepEqual(all.order, ["b"]);

  const headerOverKey = combinePolicies({ key: policy("sort=price+order=a"), header: policy("sort=latency") });
  assert.equal(headerOverKey.sort, "latency");
  assert.deepEqual(headerOverKey.order, ["a"]);

  const keyOnly = combinePolicies({ key: policy("sort=price+order=a") });
  assert.equal(keyOnly.sort, "price");
  assert.deepEqual(keyOnly.order, ["a"]);

  // A suffix that states an order beats the header's and the key's.
  const suffixOrder = combinePolicies({ key: policy("order=a"), header: policy("order=b"), suffix: policy("order=c,d") });
  assert.deepEqual(suffixOrder.order, ["c", "d"]);
  assert.equal(combinePolicies({ key: policy("sort=price"), suffix: policy("sort=latency") }).sort, "latency");
});

test("G13: no layer removes or weakens a requirement of another", () => {
  const key = policy("zdr+notrain+bits=16+region=us+attest=weights+only=a+ignore=b");
  for (const other of ["sort=price", "bits=1", "region=us,de,fr", "only=a,b,c", "attest=prompt", "ignore=c"]) {
    for (const carrier of ["header", "suffix"] as const) {
      const value = combinePolicies({ key, [carrier]: policy(other) });
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

test("combining: the result shares no list with its inputs", () => {
  const text = "order=a,b+region=us,de+only=a,b+ignore=x+attest=weights";
  const key = policy(text);
  const result = combinePolicies({ key });
  assert.deepEqual(result, key);
  for (const list of [result.order, result.region, result.only, result.ignore, result.attest]) {
    assert.ok(Array.isArray(list));
    list.length = 0;
  }
  assert.deepEqual(key, policy(text));
});

test("S13: a reader ignores unknown fact keys and unknown attest items, and they change nothing it matches", () => {
  assert.deepEqual(facts(""), { zdr: false, notrain: false, bits: null, region: null, attest: [], other: new Map() });
  const read = facts("zdr+bits=8+region=us,de+attest=weights,later+later+newkey=x,y");
  assert.deepEqual(read, {
    zdr: true,
    notrain: false,
    bits: 8,
    region: ["us", "de"],
    attest: ["weights", "later"],
    other: new Map<string, Value>([["later", true], ["newkey", ["x", "y"]]]),
  });
  const route = { provider: "a", facts: read };
  assert.equal(meets(route, policy("zdr+bits=8+region=us,de+attest=weights")), true);
  assert.equal(meets(route, policy("notrain")), false);
  assert.equal(meets(route, policy("attest=prompt")), false);
  assert.equal(meets(route, policy("attest=weights,prompt")), false);

  // An absent key reads as absent, whatever its name.
  assert.equal(facts("").other.get("constructor"), undefined);
  assert.equal(facts("").other.has("valueof"), false);
  assert.deepEqual(facts("constructor=x").other.get("constructor"), ["x"]);
});

test("S13: facts are invalid when malformed, when a known key has an invalid value, or when they carry a key that is never a fact", () => {
  for (const text of ["only=x", "ignore=x", "ignore", "sort", "sort=price", "order=x", "zdr+order=x", "zdr+only=a"]) assert.equal(parseFacts(text).ok, false, text);
  for (const text of ["zdr=1", "notrain=x", "bits=0", "bits", "bits=8,16", "region=usa", "region=ab", "region", "attest", "zdr+attest", "zdr+zdr", "+", "zdr+", "Zdr", "attest=Weights"]) assert.equal(parseFacts(text).ok, false, text);
});

test("S12: a gateway may publish only the five fact keys with defined values, whatever it accepts in requests", () => {
  assert.equal(parsePublishedFacts("").ok, true);
  assert.equal(parsePublishedFacts("zdr+notrain+bits=8+region=us+attest=weights,prompt").ok, true);
  const cases: [facts: string, key: string][] = [
    ["later", "later"],
    ["zdr+newkey=1", "newkey"],
    ["provider=a", "provider"],
    ["attest=custom", "attest"],
    ["attest=weights,custom", "attest"],
    ["only=a", "only"],
    ["region=ab", "region"],
    ["bits=0", "bits"],
  ];
  for (const [text, key] of cases) {
    const parsed = parsePublishedFacts(text);
    assert.ok(!parsed.ok, text);
    assert.equal(parsed.key, key, text);
  }
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
    ["only=a,b", "b", "", true],
    ["only=a,b", "c", "zdr", false],
    ["only=nosuch", "a", "", false],
    ["ignore=a", "a", "zdr", false],
    ["ignore=a", "b", "", true],
    ["ignore=a,b", "b", "", false],
    ["ignore=a,b,c", "c", "zdr", false],
    ["ignore=nosuch", "a", "", true],
    ["sort=price+order=z", "a", "", true],
    ["zdr+bits=8+region=us+only=a", "a", "zdr+bits=8+region=us", true],
    ["zdr+bits=8+region=us+only=a", "a", "zdr+bits=8+region=us,de", false],
    ["zdr+bits=8+region=us+only=a", "b", "zdr+bits=8+region=us", false],
    ["zdr+ignore=a", "a", "zdr", false],
  ];
  for (const [p, provider, f, expected] of cases) assert.equal(meets({ provider, facts: facts(f) }, policy(p)), expected, `${p} vs ${provider} [${f}]`);
});

test("G7: order first as listed, then the rest by the rank of the requested sort, and unknown ids have no effect", () => {
  // Each sort ranks these routes differently from the other two, so using the wrong one shows.
  const routes = [
    { provider: "a", price: 3, latency: 2, throughput: 30 },
    { provider: "b", price: 1, latency: 3, throughput: 10 },
    { provider: "c", price: 2, latency: 1, throughput: 20 },
    { provider: "d", price: 2, latency: 4, throughput: 20 },
  ];
  const rank = (route: (typeof routes)[number], sort: string): number => (sort === "price" ? route.price : sort === "latency" ? route.latency : -route.throughput);
  const ids = (p: string): string =>
    orderRoutes(routes, policy(p), rank)
      .map((route) => route.provider)
      .join("");
  assert.equal(ids("sort=price"), "bcda");
  assert.equal(ids("sort=latency"), "cabd");
  assert.equal(ids("sort=throughput"), "acdb");
  assert.equal(ids("order=d,a"), "dabc");
  // The remainder (a, b, c) is not already in rank order, so it must be ranked after the ordered one.
  assert.equal(ids("order=d+sort=price"), "dbca");
  assert.equal(ids("order=d+sort=latency"), "dcab");
  assert.equal(ids("order=d+sort=throughput"), "dacb");
  assert.equal(ids("order=c,nosuch+sort=price"), "cbda");
  assert.equal(ids("order=nosuch"), "abcd");
  assert.equal(ids("zdr"), "abcd");
  assert.equal(routes.map((route) => route.provider).join(""), "abcd");
});

test("S14: Route-Applied is the provider and nothing else, so joined lines never read as one", () => {
  assert.equal(formatApplied("aurora"), "provider=aurora");
  for (const id of ["aurora", "a", "0", "data-east", "a.b_c", "constructor", "null", "a".repeat(32)]) {
    assert.equal(isProviderId(id), true, id);
    assert.deepEqual(parseApplied(formatApplied(id)), { ok: true, value: id });
  }
  for (const text of [
    "",
    "zdr",
    "xrovider=a",
    "provide=aurora",
    "provider",
    "provider=",
    "provider=A",
    "provider=org/a",
    "provider=a+",
    "provider=a+zdr",
    "zdr+provider=a",
    " provider=a",
    "provider=a ",
    `provider=${"a".repeat(33)}`,
    // Two lines joined, however the joiner writes the comma.
    "provider=a,provider=b",
    "provider=a, provider=b",
    "provider=a,b",
    "provider=a, b",
    "provider=a,",
  ]) {
    assert.equal(parseApplied(text).ok, false, text);
  }
});

test("S18: an evidence URI is absolute and has no comma and no whitespace", () => {
  for (const uri of ["https://basalt.example/attestation", "https://basalt.example/a?nonce=1&x=%2C", "urn:example:evidence:1", "HTTPS://BASALT.EXAMPLE/a"]) assert.equal(isEvidenceUri(uri), true, uri);
  for (const uri of ["", "/attestation", "basalt.example/attestation", "//basalt.example/a", "https:", "1https://a", "https://a.example/x, https://b.example/y", "https://a.example/x,https://b.example/y", "https://a.example/x y", " https://a.example/x", "https://a.example/x\n"]) {
    assert.equal(isEvidenceUri(uri), false, uri);
  }
  for (const value of [null, undefined, 5, {}, ["https://a.example/x"]]) assert.equal(isEvidenceUri(value), false, String(value));
});

test("S14, S15, S17: the writers refuse to write what a reader would refuse, whatever type they are handed", () => {
  for (const id of ["", "org/provider", "Data-East", "a b", "-a", "a,b", "a+b", "a".repeat(33)]) {
    assert.equal(isProviderId(id), false, id);
    assert.throws(() => formatApplied(id), RangeError, id);
  }
  // A value that is not a string is never coerced into an identifier.
  const untypedApplied = formatApplied as (provider: unknown) => string;
  for (const value of [null, undefined, 5, true, {}, ["aurora"]]) {
    assert.equal(isProviderId(value), false, String(value));
    assert.throws(() => untypedApplied(value), RangeError, String(value));
  }

  for (const key of ["bad key", "Bad", "", "a.b", "k".repeat(17)]) assert.throws(() => formatRefused("unsupported", key), RangeError, key);
  const untypedRefused = formatRefused as (reason: unknown, key?: unknown) => string;
  for (const reason of ["other", "constructor", "", null, undefined, 5, ["unsupported"]]) assert.throws(() => untypedRefused(reason), RangeError, String(reason));
  for (const key of [false, true, 5, {}, ["bits"]]) assert.throws(() => untypedRefused("unsupported", key), RangeError, String(key));
  assert.throws(() => untypedRefused("unavailable", "bits"), RangeError);
  assert.throws(() => untypedRefused("unsatisfiable", "bits"), RangeError);
});


test("S15: Route-Refused is a reason, then a key only with unsupported, and nothing else", () => {
  assert.equal(formatRefused("unsupported", "bits"), "reason=unsupported+key=bits");
  assert.equal(formatRefused("unsupported"), "reason=unsupported");
  assert.equal(formatRefused("unsatisfiable"), "reason=unsatisfiable");
  assert.equal(formatRefused("unavailable"), "reason=unavailable");
  assert.deepEqual(parseRefused(formatRefused("unsupported", "later")), { ok: true, value: { reason: "unsupported", key: "later" } });
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
    "reason=unsupported+key=a.b",
    "reason=unsupported++",
    "reason=unsupported+garbage",
    "what=ever+reason=unsupported",
    "reason=unsatisfiable+key=bits",
    "reason=unavailable+key=bits",
    " reason=unsupported",
    "reason=unsupported, reason=unsupported",
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

test("C6: a reply that lists nothing grants nothing, unlike one that omits the lists", () => {
  const none = parseDetection({ route_policy: 1, keys: [], attest: [], sort: [] });
  assert.ok(none.ok);
  assert.equal(none.value.support.keys.size, 0);
  assert.equal(none.value.support.attest.size, 0);
  assert.equal(none.value.support.sort.size, 0);
  assert.equal(supports(none.value.support, policy("zdr")), false);
  assert.equal(parsePolicy("zdr", none.value.support).ok, false);

  const noValues = parseDetection({ route_policy: 1, attest: [], sort: [] });
  assert.ok(noValues.ok);
  assert.equal(noValues.value.support.keys.size, 9);
  assert.equal(supports(noValues.value.support, policy("attest=weights")), false);
  assert.equal(supports(noValues.value.support, policy("sort=price")), false);
});

test("C6, C12: keys and values this revision does not define are dropped from what the client may use, and the reply stays valid", () => {
  const newer = parseDetection({ route_policy: 1, keys: ["zdr", "later", "sort", "attest"], attest: ["weights", "later"], sort: ["price", "later"], key_policy: "zdr+later=x+sort=later+attest=later" });
  assert.ok(newer.ok);
  assert.deepEqual([...newer.value.support.keys], ["zdr", "attest", "sort"]);
  assert.deepEqual([...newer.value.support.attest], ["weights"]);
  assert.deepEqual([...newer.value.support.sort], ["price"]);
  assert.equal(supports(newer.value.support, policy("zdr")), true);
  assert.equal(supports(newer.value.support, policy("notrain")), false);
  // The bound policy is kept as sent, to be shown. This client cannot interpret it, and can tell that it cannot.
  assert.equal(newer.value.keyPolicy, "zdr+later=x+sort=later+attest=later");
  assert.equal(parsePolicy(newer.value.keyPolicy, newer.value.support).ok, false);
});

test("C6: a reply with any known member invalid is no detection", () => {
  const sparseKeys: unknown[] = ["zdr"];
  sparseKeys.length = 3;
  const sparseAttest: unknown[] = [];
  sparseAttest.length = 1;
  const bodies: unknown[] = [
    null,
    [],
    "text",
    {},
    { route_policy: "1" },
    { route_policy: 2 },
    { route_policy: true },
    Object.create({ route_policy: 1 }),
    { route_policy: 1, keys: "zdr" },
    { route_policy: 1, keys: ["bits", "bad key"] },
    { route_policy: 1, keys: ["a.b"] },
    { route_policy: 1, keys: [1] },
    { route_policy: 1, keys: sparseKeys },
    { route_policy: 1, attest: sparseAttest },
    { route_policy: 1, sort: [1] },
    { route_policy: 1, sort: ["a,b"] },
    { route_policy: 1, attest: {} },
    { route_policy: 1, attest: ["Weights"] },
    { route_policy: 1, key_policy: 5 },
    { route_policy: 1, key_policy: "" },
    { route_policy: 1, key_policy: "only=" },
    { route_policy: 1, key_policy: "bits=0" },
    { route_policy: 1, keys: [], key_policy: "zdr" },
    { route_policy: 1, keys: ["zdr"], key_policy: "zdr+notrain" },
    { route_policy: 1, sort: ["price"], key_policy: "sort=latency" },
    { route_policy: 1, attest: ["weights"], key_policy: "attest=prompt" },
    { route_policy: 1, key_policy: "region=ab" },
    { route_policy: 1, key_policy: "later" },
  ];
  for (const body of bodies) assert.equal(parseDetection(body).ok, false, JSON.stringify(body));
});

test("G20 to G22: what a gateway formats is what a client reads back, and it cannot format what it could not honor", () => {
  const support: Support = { keys: new Set(["zdr", "sort", "attest"]), attest: new Set(["prompt"]), sort: new Set(["latency", "price"]) };
  const body: unknown = JSON.parse(JSON.stringify(formatDetection(support, "zdr+sort=latency")));
  assert.deepEqual(body, { route_policy: 1, keys: ["zdr", "sort", "attest"], attest: ["prompt"], sort: ["latency", "price"], key_policy: "zdr+sort=latency" });
  const parsed = parseDetection(body);
  assert.ok(parsed.ok);
  assert.deepEqual([...parsed.value.support.keys].sort(), ["attest", "sort", "zdr"]);
  assert.deepEqual([...parsed.value.support.attest], ["prompt"]);
  assert.deepEqual([...parsed.value.support.sort].sort(), ["latency", "price"]);
  assert.equal(parsed.value.keyPolicy, "zdr+sort=latency");
  assert.equal(Object.hasOwn(formatDetection(support), "key_policy"), false);

  for (const bound of ["bits=0", "", "notrain", "sort=throughput", "attest=weights", "zdr+zdr", "later"]) {
    assert.throws(() => formatDetection(support, bound), RangeError, bound);
  }
  // Whatever it does format, the client accepts.
  for (const bound of ["zdr", "attest=prompt", "sort=price+zdr"]) {
    const reply: unknown = JSON.parse(JSON.stringify(formatDetection(support, bound)));
    assert.equal(parseDetection(reply).ok, true, bound);
  }

  // It advertises only what this revision defines, with or without a bound policy: nothing else could be honored.
  const base = baselineSupport();
  const unadvertisable: Support[] = [
    { ...base, keys: new Set(["zdr", "bad key"]) },
    { ...base, keys: new Set(["zdr", "later"]) },
    { ...base, attest: new Set(["weights", "custom"]) },
    { ...base, attest: new Set(["Weights"]) },
    { ...base, sort: new Set(["price", "a,b"]) },
    { ...base, sort: new Set(["cheapest"]) },
  ];
  for (const bad of unadvertisable) {
    assert.throws(() => formatDetection(bad), RangeError);
    assert.throws(() => formatDetection(bad, "zdr"), RangeError);
  }
  assert.deepEqual(formatDetection({ keys: new Set(), attest: new Set(), sort: new Set() }), { route_policy: 1, keys: [], attest: [], sort: [] });
});

test("C1, C2: a request is cleared only when detection covers every policy on it, preferences included", () => {
  const support: Support = { keys: new Set(["zdr", "sort", "only"]), attest: new Set(), sort: new Set(["price"]) };
  const p = (text: string): Policy => policy(text);
  // Preferences alone need no detection, supported or not.
  assert.equal(clearedToSend(null, []), true);
  assert.equal(clearedToSend(null, [p("sort=latency")]), true);
  assert.equal(clearedToSend(null, [p("sort=latency"), p("order=a")]), true);
  assert.equal(clearedToSend(support, [p("sort=latency")]), true);
  // A requirement needs a reply, and the reply must cover it.
  assert.equal(clearedToSend(null, [p("zdr")]), false);
  assert.equal(clearedToSend(support, [p("zdr")]), true);
  assert.equal(clearedToSend(support, [p("notrain")]), false);
  assert.equal(clearedToSend(support, [p("zdr+sort=price")]), true);
  assert.equal(clearedToSend(support, [p("zdr+sort=latency")]), false);
  // On two carriers the check is on both together: a supported requirement beside an unsupported preference blocks.
  assert.equal(clearedToSend(support, [p("zdr"), p("sort=latency")]), false);
  assert.equal(clearedToSend(support, [p("sort=latency"), p("zdr")]), false);
  assert.equal(clearedToSend(support, [p("zdr"), p("order=a")]), false);
  assert.equal(clearedToSend(support, [p("zdr"), p("sort=price")]), true);
  assert.equal(clearedToSend(support, [p("sort=price"), p("only=a")]), true);
  assert.equal(clearedToSend(null, [p("sort=price"), p("only=a")]), false);
  // Each carrier is checked as sent, not the policy they combine to: the suffix's supported sort would override
  // the header's unsupported one, and the request is still not cleared.
  const header = p("zdr+sort=latency");
  const suffix = p("sort=price");
  assert.equal(supports(support, combinePolicies({ header, suffix })), true);
  assert.equal(clearedToSend(support, [header, suffix]), false);
});

test("C3, C4, C5: a response is a refusal, honored, or not honored", () => {
  const sent = policy("zdr+region=us");
  const routes = new Map([
    ["aurora", "zdr+notrain+bits=8+region=us"],
    ["basalt", "bits=16+region=us,de+attest=weights,prompt"],
    ["cobalt", ""],
    ["broken", "zdr+region=us+bits=0"],
  ]);
  const headers = (applied: string[], refused: string[] = [], evidence: string[] = []) => ({ applied, refused, evidence });

  assert.deepEqual(readOutcome(headers(["provider=aurora"]), sent, routes), { outcome: "honored", provider: "aurora", evidence: null, checked: true });

  const notHonored: [applied: string[], name: string][] = [
    [[], "none"],
    [["provider=aurora", "provider=basalt"], "two lines"],
    [["provider=aurora", "provider=aurora"], "two identical lines"],
    [["provider=aurora, provider=aurora"], "two lines joined with a space"],
    [["provider=aurora,provider=aurora"], "two lines joined without one"],
    [["provider=aurora,aurora"], "a line and a bare item joined"],
    [["provider=cobalt"], "published route that meets nothing"],
    [["provider=basalt"], "published route with a wider region and no zdr"],
    [["provider=broken"], "published route whose facts are invalid"],
    [["provider=nosuch"], "provider that is not published for the model"],
    [["aurora"], "no provider key"],
    [[""], "empty"],
  ];
  for (const [applied, name] of notHonored) assert.equal(readOutcome(headers(applied), sent, routes).outcome, "not-honored", name);

  // The provider-id requirements are checked against the provider named.
  assert.equal(readOutcome(headers(["provider=cobalt"]), policy("only=cobalt"), routes).outcome, "honored");
  assert.equal(readOutcome(headers(["provider=aurora"]), policy("only=cobalt"), routes).outcome, "not-honored");
  assert.equal(readOutcome(headers(["provider=aurora"]), policy("zdr+ignore=aurora"), routes).outcome, "not-honored");
  // Invalid published facts meet no requirement, a provider-id one included.
  assert.equal(readOutcome(headers(["provider=broken"]), policy("only=broken"), routes).outcome, "not-honored");

  // Without a model list the facts cannot be compared, and the outcome says so. The provider ids still can.
  assert.deepEqual(readOutcome(headers(["provider=aurora"]), sent, null), { outcome: "honored", provider: "aurora", evidence: null, checked: false });
  assert.equal(readOutcome(headers(["provider=aurora"]), policy("only=cobalt"), null).outcome, "not-honored");
  assert.equal(readOutcome(headers(["provider=aurora"]), policy("zdr+ignore=aurora"), null).outcome, "not-honored");
  assert.equal(readOutcome(headers(["provider=aurora", "provider=aurora"]), sent, null).outcome, "not-honored");

  // Any Route-Refused is a refusal: parsed, unparsed, repeated, or beside a Route-Applied that would otherwise honor.
  assert.deepEqual(readOutcome(headers([], ["reason=unsupported+key=bits"]), sent, routes), { outcome: "refused", reason: "unsupported", key: "bits" });
  assert.deepEqual(readOutcome(headers([], ["reason=unavailable"]), sent, routes), { outcome: "refused", reason: "unavailable", key: null });
  assert.deepEqual(readOutcome(headers([], ["garbage"]), sent, routes), { outcome: "refused", reason: null, key: null });
  assert.deepEqual(readOutcome(headers([], ["reason=unsupported", "reason=unavailable"]), sent, routes), { outcome: "refused", reason: null, key: null });
  assert.deepEqual(readOutcome(headers(["provider=aurora"], ["reason=unsatisfiable"]), sent, routes), { outcome: "refused", reason: "unsatisfiable", key: null });
  assert.deepEqual(readOutcome(headers(["provider=aurora"], [""]), sent, routes), { outcome: "refused", reason: null, key: null });
});

test("C3: a policy with attest is honored only with exactly one valid Route-Evidence", () => {
  const sent = policy("attest=weights,prompt");
  const routes = new Map([
    ["basalt", "bits=16+region=us,de+attest=weights,prompt"],
    ["aurora", "zdr+attest=weights"],
  ]);
  const uri = "https://basalt.example/attestation";
  const response = (evidence: string[], provider = "basalt") => ({ applied: [`provider=${provider}`], refused: [], evidence });

  assert.deepEqual(readOutcome(response([uri]), sent, routes), { outcome: "honored", provider: "basalt", evidence: uri, checked: true });
  assert.deepEqual(readOutcome(response([uri]), sent, null), { outcome: "honored", provider: "basalt", evidence: uri, checked: false });

  for (const evidence of [[], [uri, uri], [`${uri}, ${uri}`], [`${uri},${uri}`], ["/attestation"], ["not a uri"], [""]]) {
    assert.equal(readOutcome(response(evidence), sent, routes).outcome, "not-honored", JSON.stringify(evidence));
    assert.equal(readOutcome(response(evidence), sent, null).outcome, "not-honored", JSON.stringify(evidence));
  }
  // The evidence pointer does not stand in for the route's published facts.
  assert.equal(readOutcome(response([uri], "aurora"), sent, routes).outcome, "not-honored");
  // Without attest in the policy sent, evidence is not needed, and none is reported.
  assert.deepEqual(readOutcome(response([], "aurora"), policy("zdr"), routes), { outcome: "honored", provider: "aurora", evidence: null, checked: true });
  assert.deepEqual(readOutcome(response([uri], "aurora"), policy("zdr"), routes), { outcome: "honored", provider: "aurora", evidence: null, checked: true });
});

test("the baseline cannot be changed by a caller", () => {
  const first = baselineSupport();
  (first.attest as Set<string>).add("custom");
  (first.keys as Set<string>).delete("zdr");
  assert.equal(parsePolicy("attest=custom").ok, false);
  assert.equal(parsePolicy("zdr").ok, true);
  assert.equal(baselineSupport().keys.has("zdr"), true);
  assert.equal(baselineSupport().attest.has("custom"), false);
});
