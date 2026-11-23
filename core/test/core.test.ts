import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { COUNTRIES } from "../src/countries.ts";
import {
  REFUSAL_STATUS,
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
  keysOf,
  meets,
  orderRoutes,
  parseApplied,
  parseDetection as readDetection,
  parseFacts,
  parsePolicy,
  parsePublishedFacts,
  parseRefused,
  publishedRoutes,
  readOutcome,
  readRefusal,
  someRouteMeets,
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

/** Asserts the policy is refused and returns the key the refusal names. */
function refusedKey(text: string, support?: Support): string | null {
  const parsed = parsePolicy(text, support);
  assert.ok(!parsed.ok, `"${text}" should be refused`);
  return parsed.key;
}

/** The routes a model list publishes for its one model, `m`. */
const parseRoutes = (rows: unknown) => publishedRoutes({ data: [{ id: "m", routes: rows }] }, "m");

/** A detection body read as a 200 reply to a request that carried credentials. */
const parseDetection = (body: unknown) => readDetection({ status: 200, body, credentialed: true });

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

  // Only facts can hold sixteen distinct well-formed keys, since a reader lets through the ones it does not know.
  const unknown = Array.from({ length: 17 }, (_, i) => `k${i}`);
  assert.equal(parseFacts(unknown.slice(0, 16).join("+")).ok, true);
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

test("a policy and facts are only what the parser made: frozen, and a look-alike is refused everywhere", () => {
  const made = policy("zdr+region=us,de+only=a+order=a");
  assert.ok(Object.isFrozen(made));
  for (const list of [made.region, made.attest, made.only, made.ignore, made.order]) assert.ok(list === null || Object.isFrozen(list));
  const combined = combinePolicies({ key: made, suffix: policy("ignore=x") });
  assert.ok(Object.isFrozen(combined));
  for (const list of [combined.region, combined.attest, combined.only, combined.ignore, combined.order]) assert.ok(list === null || Object.isFrozen(list));
  const read = facts("zdr+region=us+attest=weights");
  assert.ok(Object.isFrozen(read));
  assert.ok(Object.isFrozen(read.region) && Object.isFrozen(read.attest));
  // The combined policy has its own lists: it is not the input's.
  assert.notEqual(combined.order, made.order);
  assert.deepEqual(combined.order, made.order);

  // The refusal is the library's own, by name: a TypeError from reading a field that is not there would not do.
  const notAPolicy = { name: "TypeError", message: /^policy was not made by/ };
  const notFacts = { name: "TypeError", message: /^facts were not made by/ };

  // Hand-built values that the parser would have refused, each shaped exactly like the real thing.
  const forgedPolicies: Policy[] = [{ ...made }, { ...made, bits: 65 }, { ...made, bits: Number.NaN }, { ...made, region: [] }, { ...made, only: ["a,b"] }, { ...made, sort: "custom" }];
  const forgedFacts: Facts[] = [{ ...read }, { ...read, bits: 65 }, { ...read, bits: Number.NaN }, { ...read, region: [] }, { ...read, region: ["ab"] }];
  const route = { provider: "a", facts: read };
  for (const forged of forgedPolicies) {
    assert.throws(() => meets(route, forged), notAPolicy);
    assert.throws(() => formatPolicy(forged), notAPolicy);
    assert.throws(() => keysOf(forged), notAPolicy);
    assert.throws(() => hasRequirements(forged), notAPolicy);
    assert.throws(() => supports(baselineSupport(), forged), notAPolicy);
    assert.throws(() => combinePolicies({ key: made, header: forged }), notAPolicy);
    assert.throws(() => combinePolicies({ suffix: forged }), notAPolicy);
    assert.throws(() => orderRoutes([route], forged, () => 0), notAPolicy);
    assert.throws(() => clearedToSend(baselineSupport(), [made, forged]), notAPolicy);
    assert.throws(() => readOutcome({ applied: ["provider=a"], refused: [], evidence: [] }, forged, null), notAPolicy);
  }
  for (const forged of forgedFacts) {
    assert.throws(() => meets({ provider: "a", facts: forged }, made), notFacts);
    assert.throws(() => meets({ provider: "a", facts: forged }, policy("only=a")), notFacts);
    const routes = parseRoutes([{ provider: "a", facts: "zdr" }]);
    routes.set("a", { facts: forged, evidence: null });
    assert.throws(() => readOutcome({ applied: ["provider=a"], refused: [], evidence: [] }, policy("zdr"), routes), notFacts);
  }

  // A policy is not facts, and facts are not a policy, however alike their fields: the compiler says so, and so
  // does the library when the compiler is not asked.
  // @ts-expect-error a Policy is not assignable to Facts
  const policyAsFacts: Facts = combinePolicies({ key: policy("region=it"), suffix: policy("region=jp") });
  // @ts-expect-error Facts are not assignable to a Policy
  const factsAsPolicy: Policy = read;
  assert.throws(() => meets({ provider: "a", facts: policyAsFacts }, policy("region=us")), notFacts);
  assert.throws(() => meets({ provider: "a", facts: policyAsFacts }, policy("only=a")), notFacts);
  assert.throws(() => meets(route, factsAsPolicy), notAPolicy);
  assert.throws(() => formatPolicy(factsAsPolicy), notAPolicy);
  assert.throws(() => keysOf(factsAsPolicy), notAPolicy);
  assert.throws(() => combinePolicies({ key: factsAsPolicy }), notAPolicy);
  assert.throws(() => orderRoutes([route], factsAsPolicy, () => 0), notAPolicy);
  assert.throws(() => readOutcome({ applied: ["provider=a"], refused: [], evidence: [] }, factsAsPolicy, null), notAPolicy);
  const mixed = parseRoutes([{ provider: "a", facts: "zdr" }]);
  mixed.set("a", { facts: policyAsFacts, evidence: null });
  assert.throws(() => readOutcome({ applied: ["provider=a"], refused: [], evidence: [] }, policy("zdr"), mixed), notFacts);

  // Every argument is checked, whatever its place and whatever the others would have decided.
  const forged: Policy = { ...made };
  for (const support of [null, baselineSupport(), { keys: new Set<string>(), attest: new Set<string>(), sort: new Set<string>() }]) {
    assert.throws(() => clearedToSend(support, [made, forged]), notAPolicy);
    assert.throws(() => clearedToSend(support, [forged, made]), notAPolicy);
    assert.throws(() => clearedToSend(support, [policy("sort=price"), forged]), notAPolicy);
    assert.throws(() => clearedToSend(support, [made, factsAsPolicy]), notAPolicy);
  }
  for (const notAValue of [null, undefined, "zdr", 5]) assert.throws(() => formatPolicy(notAValue as unknown as Policy), notAPolicy);
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

test("C10: a combined policy that cannot be written as a valid one fails to format instead of producing a string", () => {
  const sixteen = `ignore=${Array.from({ length: 16 }, (_, i) => `p${i}`).join(",")}`;
  const cases: [name: string, policy: Policy, key: string | null][] = [
    ["nothing", combinePolicies({}), null],
    ["disjoint region", combinePolicies({ key: policy("region=us"), suffix: policy("region=de") }), "region"],
    ["disjoint only", combinePolicies({ key: policy("only=a"), suffix: policy("only=b") }), "only"],
    ["17 ignores", combinePolicies({ key: policy(sixteen), suffix: policy("ignore=extra") }), "ignore"],
  ];
  for (const [name, value, key] of cases) {
    const formatted = formatPolicy(value);
    assert.ok(!formatted.ok, name);
    assert.equal(formatted.key, key, name);
  }
  assert.equal(combinePolicies({ key: policy(sixteen), suffix: policy("ignore=extra") }).ignore.length, 17);
  // What can be written is written, in a fixed order.
  assert.deepEqual(formatPolicy(combinePolicies({ key: policy("zdr+region=us,de"), suffix: policy("region=de+sort=price") })), { ok: true, value: "zdr+region=de+sort=price" });
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

  // The intersection runs over every layer present: here only the key's narrows it, and it is the least specific.
  assert.deepEqual(combinePolicies({ key: policy("region=de"), header: policy("region=us,de,fr"), suffix: policy("region=us,de") }).region, ["de"]);
  assert.deepEqual(combinePolicies({ key: policy("only=c"), header: policy("only=a,b,c"), suffix: policy("only=b,c") }).only, ["c"]);
  assert.deepEqual(combinePolicies({ key: policy("region=us"), header: policy("region=us,de"), suffix: policy("region=de") }).region, []);
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

test("S13: a reader lets through fact keys and attest items it does not know, and they change nothing it matches", () => {
  assert.deepEqual(facts(""), { zdr: false, notrain: false, bits: null, region: null, attest: [] });
  const read = facts("zdr+bits=8+region=us,de+attest=weights,later+later+newkey=x,y+provider=p+constructor=x");
  assert.deepEqual(read, { zdr: true, notrain: false, bits: 8, region: ["us", "de"], attest: ["weights"] });
  // An unknown item is ignored, not kept: the facts read the same with or without it.
  assert.deepEqual(facts("attest=prompt,next"), facts("attest=prompt"));
  assert.deepEqual(facts("attest=next").attest, []);
  assert.deepEqual(facts("attest=next,later"), facts(""));
  const route = { provider: "a", facts: read };
  assert.equal(meets(route, policy("zdr+bits=8+region=us,de+attest=weights")), true);
  assert.equal(meets(route, policy("notrain")), false);
  assert.equal(meets(route, policy("attest=prompt")), false);
  assert.equal(meets(route, policy("attest=weights,prompt")), false);
  // The unknown key alone leaves the route as one that publishes no fact, which is valid.
  assert.deepEqual(facts("later"), facts(""));
  assert.equal(meets({ provider: "a", facts: facts("later") }, policy("only=a")), true);
});

test("S13: facts are invalid when malformed, when a known key has an invalid value, or when they carry a key that is never a fact", () => {
  for (const text of ["only=x", "ignore=x", "ignore", "sort", "sort=price", "order=x", "zdr+order=x", "zdr+only=a"]) assert.equal(parseFacts(text).ok, false, text);
  for (const text of ["zdr=1", "notrain=x", "bits=0", "bits=65", "bits", "bits=8,16", "region=usa", "region=ab", "region", "attest", "zdr+attest", "zdr+zdr", "+", "zdr+", "Zdr", "attest=Weights"]) assert.equal(parseFacts(text).ok, false, text);
});

test("S12: a gateway may publish only the five fact keys with defined values, whatever it accepts in requests", () => {
  assert.equal(parsePublishedFacts("").ok, true);
  const all = parsePublishedFacts("zdr+notrain+bits=8+region=us+attest=weights,prompt");
  assert.ok(all.ok);
  assert.deepEqual(all.value, facts("zdr+notrain+bits=8+region=us+attest=weights,prompt"));
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
    ["bits=64", "a", "bits=64", true],
    ["bits=8", "a", "bits=4", false],
    ["bits=16", "a", "zdr+bits=4", false],
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

test("G35: order first as listed, then the rest by the rank of the requested sort, and unknown ids have no effect", () => {
  // Each sort ranks these routes differently from the other two, so using the wrong one shows.
  const routes = [
    { provider: "a", price: 3, latency: 2, throughput: 30 },
    { provider: "b", price: 1, latency: 3, throughput: 10 },
    { provider: "c", price: 2, latency: 1, throughput: 20 },
    { provider: "d", price: 2, latency: 4, throughput: 20 },
    { provider: "e", price: 5, latency: 5, throughput: 5 },
  ];
  const rank = (route: (typeof routes)[number], sort: string): number => (sort === "price" ? route.price : sort === "latency" ? route.latency : -route.throughput);
  const ids = (p: string): string =>
    orderRoutes(routes, policy(p), rank)
      .map((route) => route.provider)
      .join("");
  assert.equal(ids("sort=price"), "bcdae");
  assert.equal(ids("sort=latency"), "cabde");
  assert.equal(ids("sort=throughput"), "acdbe");
  assert.equal(ids("order=d,a"), "dabce");
  // Every listed provider moves ahead, however many are listed: the third comes before the unlisted ones.
  assert.equal(ids("order=e,d,c"), "edcab");
  assert.equal(ids("order=e,d,c,b"), "edcba");
  // The remainder is not already in rank order, so it must be ranked after the ordered ones.
  assert.equal(ids("order=d+sort=price"), "dbcae");
  assert.equal(ids("order=d+sort=latency"), "dcabe");
  assert.equal(ids("order=d+sort=throughput"), "dacbe");
  assert.equal(ids("order=c,nosuch+sort=price"), "cbdae");
  assert.equal(ids("order=nosuch"), "abcde");
  assert.equal(ids("zdr"), "abcde");
  assert.equal(routes.map((route) => route.provider).join(""), "abcde");
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

test("S18: an evidence URI fits its grammar exactly: https, a lowercase host, an optional port, a narrow path", () => {
  for (const uri of [
    "https://basalt.example/attestation",
    "https://basalt.example",
    "https://basalt.example/",
    "https://b/a",
    "https://basalt.example/a/b.c_d~e-f?nonce=1&x=y",
    "https://basalt.example:8443/a",
    "https://xn--bcher-kva.example/a",
    "https://a-b.c-d.example/A/B",
    `https://${"a".repeat(63)}.example/a`,
    `https://basalt.example/${"a".repeat(512 - "https://basalt.example/".length)}`,
  ]) {
    assert.equal(isEvidenceUri(uri), true, uri);
  }
  for (const uri of [
    "",
    "/attestation",
    "basalt.example/attestation",
    "//basalt.example/a",
    "https:",
    "https://",
    "https:///a",
    "https://?a",
    "https://basalt.example?a",
    "http://basalt.example/a",
    "urn:example:evidence:1",
    "HTTPS://basalt.example/a",
    "HtTpS://basalt.example/a",
    "https://Basalt.example/a",
    "https://a@b@basalt.example/a",
    "https://user@basalt.example/a",
    "https://u[s]@basalt.example/a",
    "https://[::1]/a",
    "https://[::1",
    "https://-a.example/a",
    "https://a-.example/a",
    "https://a..example/a",
    "https://.example/a",
    `https://${"a".repeat(64)}.example/a`,
    "https://basalt.example:/a",
    "https://basalt.example:port/a",
    "https://basalt.example:123456/a",
    "https://a.example/x, https://b.example/y",
    "https://a.example/x,https://b.example/y",
    "https://a.example/x y",
    " https://a.example/x",
    "https://a.example/x\n",
    "https://a.example/x\u0000y",
    "https://a.example/[x]",
    "https://a.example/%2C",
    "https://a.example/%GG",
    "https://a.example/a#b",
    "https://a.example/\u00e9",
    'https://a.example/"x"',
    "https://a.example/<x>",
    "https://a.example/a;b",
    "https://a.example/a:b",
    `https://basalt.example/${"a".repeat(513 - "https://basalt.example/".length)}`,
  ]) {
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
  const minimal = parseDetection({ route_policy: "1", extra: { anything: true } });
  assert.ok(minimal.ok);
  assert.deepEqual([...minimal.value.support.keys], ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "sort", "order"]);
  assert.deepEqual([...minimal.value.support.attest], ["weights", "prompt"]);
  assert.deepEqual([...minimal.value.support.sort], ["price", "latency", "throughput"]);
  assert.equal(minimal.value.keyPolicy, null);
  assert.equal(supports(minimal.value.support, policy("attest=weights,prompt+sort=throughput")), true);
});

test("C6: a reply that lists nothing grants nothing, unlike one that omits the lists", () => {
  const none = parseDetection({ route_policy: "1", keys: [], attest: [], sort: [] });
  assert.ok(none.ok);
  assert.equal(none.value.support.keys.size, 0);
  assert.equal(none.value.support.attest.size, 0);
  assert.equal(none.value.support.sort.size, 0);
  assert.equal(supports(none.value.support, policy("zdr")), false);
  assert.equal(parsePolicy("zdr", none.value.support).ok, false);

  const noValues = parseDetection({ route_policy: "1", attest: [], sort: [] });
  assert.ok(noValues.ok);
  assert.equal(noValues.value.support.keys.size, 9);
  assert.equal(supports(noValues.value.support, policy("attest=weights")), false);
  assert.equal(supports(noValues.value.support, policy("sort=price")), false);
});

test("C6, C12: keys and values this revision does not define are dropped from what the client may use, and the reply stays valid", () => {
  const newer = parseDetection({ route_policy: "1", keys: ["zdr", "later", "sort", "attest"], attest: ["weights", "later"], sort: ["price", "later"], key_policy: "zdr+later=x+sort=later+attest=later" });
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

test("C6: a reply with any known member invalid is no detection, and the version is the string 1 and no number", () => {
  const sparseKeys: unknown[] = ["zdr"];
  sparseKeys.length = 3;
  const sparseAttest: unknown[] = [];
  sparseAttest.length = 1;
  const bodies: unknown[] = [
    null,
    [],
    "text",
    {},
    { route_policy: 1 },
    { route_policy: "1.0" },
    { route_policy: "2" },
    { route_policy: " 1" },
    { route_policy: true },
    { route_policy: ["1"] },
    Object.create({ route_policy: "1" }),
    { route_policy: "1", keys: "zdr" },
    { route_policy: "1", keys: ["bits", "bad key"] },
    { route_policy: "1", keys: ["a.b"] },
    { route_policy: "1", keys: [1] },
    { route_policy: "1", keys: sparseKeys },
    { route_policy: "1", attest: sparseAttest },
    { route_policy: "1", sort: [1] },
    { route_policy: "1", sort: ["a,b"] },
    { route_policy: "1", attest: {} },
    { route_policy: "1", attest: ["Weights"] },
    { route_policy: "1", key_policy: 5 },
    { route_policy: "1", key_policy: "" },
    { route_policy: "1", key_policy: "only=" },
    { route_policy: "1", key_policy: "bits=0" },
    { route_policy: "1", keys: [], key_policy: "zdr" },
    { route_policy: "1", keys: ["zdr"], key_policy: "zdr+notrain" },
    { route_policy: "1", sort: ["price"], key_policy: "sort=latency" },
    { route_policy: "1", attest: ["weights"], key_policy: "attest=prompt" },
    { route_policy: "1", key_policy: "region=ab" },
    { route_policy: "1", key_policy: "later" },
  ];
  for (const body of bodies) assert.equal(parseDetection(body).ok, false, JSON.stringify(body));

  // Number tokens that a JSON decoder rounds to 1 are still numbers, so none of them is the version.
  for (const raw of ['{"route_policy":1}', '{"route_policy":1.00000000000000001}', '{"route_policy":0.99999999999999999}', '{"route_policy":1e0}']) {
    const decoded: unknown = JSON.parse(raw);
    assert.equal(parseDetection(decoded).ok, false, raw);
  }
  // A repeated member reads as its last occurrence, which is what a JSON decoder hands over.
  const lastWins: unknown = JSON.parse('{"route_policy":"1","keys":[],"keys":["zdr"]}');
  const last = parseDetection(lastWins);
  assert.ok(last.ok);
  assert.deepEqual([...last.value.support.keys], ["zdr"]);
  const lastEmpty: unknown = JSON.parse('{"route_policy":"1","keys":["zdr"],"keys":[]}');
  const empty = parseDetection(lastEmpty);
  assert.ok(empty.ok);
  assert.equal(empty.value.support.keys.size, 0);
});

test("G20 to G22: what a gateway formats is what a client reads back, and it cannot format what it could not honor", () => {
  const support: Support = { keys: new Set(["zdr", "sort", "attest"]), attest: new Set(["prompt"]), sort: new Set(["latency", "price"]) };
  const body: unknown = JSON.parse(JSON.stringify(formatDetection(support, "zdr+sort=latency")));
  assert.deepEqual(body, { route_policy: "1", keys: ["zdr", "sort", "attest"], attest: ["prompt"], sort: ["latency", "price"], key_policy: "zdr+sort=latency" });
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
  assert.deepEqual(formatDetection({ keys: new Set(), attest: new Set(), sort: new Set() }), { route_policy: "1", keys: [], attest: [], sort: [] });
  // An entry that is not a string at all is refused like any other it does not define.
  const untyped = formatDetection as (support: { keys: Set<unknown>; attest: Set<unknown>; sort: Set<unknown> }) => unknown;
  assert.throws(() => untyped({ keys: new Set([undefined, "zdr"]), attest: new Set(), sort: new Set() }), RangeError);
  assert.throws(() => untyped({ keys: new Set(["zdr"]), attest: new Set([null]), sort: new Set() }), RangeError);
  assert.throws(() => untyped({ keys: new Set(["zdr"]), attest: new Set(), sort: new Set([undefined]) }), RangeError);
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

test("G23, C4: a model's published routes are read by provider, and a repeated or invalid one cannot be relied on", () => {
  const routes = parseRoutes([
    { provider: "aurora", facts: "zdr+notrain+bits=8+region=us" },
    { provider: "basalt", facts: "bits=16+attest=weights,prompt", evidence: "https://basalt.example/attestation" },
    { provider: "cobalt", facts: "" },
    { provider: "broken", facts: "zdr+bits=0" },
    { provider: "nofacts" },
    { provider: "twice", facts: "zdr" },
    { provider: "twice", facts: "notrain" },
    { provider: "badevidence", facts: "attest=weights", evidence: "https://a.example/x,y" },
    { provider: "newer", facts: "zdr+newflag+attest=weights,later" },
    { provider: "Not An Id", facts: "zdr" },
    { facts: "zdr" },
    null,
    "aurora",
  ]);
  assert.deepEqual([...routes.keys()], ["aurora", "basalt", "cobalt", "broken", "nofacts", "twice", "badevidence", "newer"]);
  assert.deepEqual(routes.get("aurora"), { facts: facts("zdr+notrain+bits=8+region=us"), evidence: null });
  assert.deepEqual(routes.get("basalt"), { facts: facts("bits=16+attest=weights,prompt"), evidence: "https://basalt.example/attestation" });
  assert.deepEqual(routes.get("cobalt"), { facts: facts(""), evidence: null });
  assert.equal(routes.get("broken"), null);
  assert.equal(routes.get("nofacts"), null);
  assert.equal(routes.get("twice"), null);
  assert.deepEqual(routes.get("badevidence"), { facts: facts("attest=weights"), evidence: null });
  // A row from a gateway on a later revision is read as a client reads facts, not as a gateway publishes them.
  assert.deepEqual(routes.get("newer"), { facts: facts("zdr+attest=weights"), evidence: null });

  // Three occurrences are still not one, and inherited members are not the entry's own.
  assert.equal(parseRoutes([{ provider: "p", facts: "zdr" }, { provider: "p", facts: "zdr" }, { provider: "p", facts: "zdr" }]).get("p"), null);
  assert.equal(parseRoutes([Object.create({ provider: "p", facts: "zdr" })]).size, 0);

  // A member that is not a list publishes no routes.
  for (const none of [undefined, null, {}, "routes", 5, []]) assert.equal(parseRoutes(none).size, 0, String(none));
});

test("C3, C4, C5: a response is a refusal, honored, or not honored", () => {
  const sent = policy("zdr+region=us");
  const routes = parseRoutes([
    { provider: "aurora", facts: "zdr+notrain+bits=8+region=us" },
    { provider: "basalt", facts: "bits=16+region=us,de+attest=weights,prompt", evidence: "https://basalt.example/attestation" },
    { provider: "cobalt", facts: "" },
    { provider: "delta", facts: "zdr+region=us,de" },
    { provider: "echo", facts: "region=us" },
    { provider: "newer", facts: "newflag+zdr+region=us" },
    { provider: "broken", facts: "zdr+region=us+bits=0" },
    { provider: "twice", facts: "zdr+region=us" },
    { provider: "twice", facts: "zdr+region=us" },
  ]);
  const headers = (applied: string[], refused: string[] = [], evidence: string[] = []) => ({ applied, refused, evidence });

  assert.deepEqual(readOutcome(headers(["provider=aurora"]), sent, routes), { outcome: "honored", provider: "aurora", evidence: null, checked: true });
  // A route that also publishes a fact from a later revision is judged on the facts this client knows.
  assert.deepEqual(readOutcome(headers(["provider=newer"]), sent, routes), { outcome: "honored", provider: "newer", evidence: null, checked: true });

  const notHonored: [applied: string[], name: string][] = [
    [[], "none"],
    [["provider=aurora", "provider=basalt"], "two lines"],
    [["provider=aurora", "provider=aurora"], "two identical lines"],
    [["provider=aurora, provider=aurora"], "two lines joined with a space"],
    [["provider=aurora,provider=aurora"], "two lines joined without one"],
    [["provider=aurora,aurora"], "a line and a bare item joined"],
    [["provider=cobalt"], "published route that publishes no fact"],
    [["provider=delta"], "published route that fails only the region requirement"],
    [["provider=echo"], "published route that fails only the zdr requirement"],
    [["provider=broken"], "published route whose facts are invalid"],
    [["provider=twice"], "provider published twice, each time with facts that would meet"],
    [["provider=nosuch"], "provider that is not published for the model"],
    [["aurora"], "no provider key"],
    [[""], "empty"],
  ];
  for (const [applied, name] of notHonored) assert.equal(readOutcome(headers(applied), sent, routes).outcome, "not-honored", name);

  // A route that fails only the precision requirement.
  assert.equal(readOutcome(headers(["provider=aurora"]), policy("zdr+bits=16"), routes).outcome, "not-honored");
  assert.equal(readOutcome(headers(["provider=aurora"]), policy("zdr+bits=8"), routes).outcome, "honored");

  // The provider-id requirements are checked against the provider named.
  assert.equal(readOutcome(headers(["provider=cobalt"]), policy("only=cobalt"), routes).outcome, "honored");
  assert.equal(readOutcome(headers(["provider=aurora"]), policy("only=cobalt"), routes).outcome, "not-honored");
  assert.equal(readOutcome(headers(["provider=aurora"]), policy("zdr+ignore=aurora"), routes).outcome, "not-honored");
  // Invalid or repeated published facts meet no requirement, a provider-id one included.
  assert.equal(readOutcome(headers(["provider=broken"]), policy("only=broken"), routes).outcome, "not-honored");
  assert.equal(readOutcome(headers(["provider=twice"]), policy("only=twice"), routes).outcome, "not-honored");

  // A model list that publishes no routes for the model has been checked, and the provider is not in it.
  for (const unusable of [[], {}, "not-a-list", undefined]) {
    assert.equal(readOutcome(headers(["provider=aurora"]), sent, parseRoutes(unusable)).outcome, "not-honored", String(unusable));
    assert.equal(readOutcome(headers(["provider=aurora"]), policy("only=aurora"), parseRoutes(unusable)).outcome, "not-honored", String(unusable));
  }

  // With no model list held, the facts cannot be compared, and the outcome says so. The provider ids still can.
  assert.deepEqual(readOutcome(headers(["provider=aurora"]), sent, null), { outcome: "honored", provider: "aurora", evidence: null, checked: false });
  assert.equal(readOutcome(headers(["provider=aurora"]), policy("only=cobalt"), null).outcome, "not-honored");
  assert.equal(readOutcome(headers(["provider=aurora"]), policy("only=cobalt,aurora"), null).outcome, "honored");
  assert.equal(readOutcome(headers(["provider=aurora"]), policy("zdr+ignore=aurora"), null).outcome, "not-honored");
  assert.equal(readOutcome(headers(["provider=aurora"]), policy("ignore=cobalt,aurora"), null).outcome, "not-honored");
  assert.equal(readOutcome(headers(["provider=aurora"]), policy("ignore=cobalt,basalt"), null).outcome, "honored");
  assert.equal(readOutcome(headers(["provider=aurora", "provider=aurora"]), sent, null).outcome, "not-honored");

  // Any Route-Refused is a refusal: parsed, unparsed, repeated, or beside a Route-Applied that would otherwise honor.
  assert.deepEqual(readOutcome(headers([], ["reason=unsupported+key=bits"]), sent, routes), { outcome: "refused", reason: "unsupported", key: "bits" });
  assert.deepEqual(readOutcome(headers([], ["reason=unavailable"]), sent, routes), { outcome: "refused", reason: "unavailable", key: null });
  assert.deepEqual(readOutcome(headers([], ["garbage"]), sent, routes), { outcome: "refused", reason: null, key: null });
  assert.deepEqual(readOutcome(headers([], ["reason=unsupported", "reason=unavailable"]), sent, routes), { outcome: "refused", reason: null, key: null });
  assert.deepEqual(readOutcome(headers(["provider=aurora"], ["reason=unsatisfiable"]), sent, routes), { outcome: "refused", reason: "unsatisfiable", key: null });
  assert.deepEqual(readOutcome(headers(["provider=aurora"], [""]), sent, routes), { outcome: "refused", reason: null, key: null });
});

test("C3, C4: a policy with attest is honored only with exactly one valid Route-Evidence, which is the string published", () => {
  const sent = policy("attest=weights,prompt");
  const uri = "https://basalt.example/attestation";
  const routes = parseRoutes([
    { provider: "basalt", facts: "bits=16+region=us,de+attest=weights,prompt", evidence: uri },
    { provider: "aurora", facts: "zdr+attest=weights", evidence: "https://aurora.example/attestation" },
    { provider: "silent", facts: "attest=weights,prompt" },
  ]);
  const response = (evidence: string[], provider = "basalt") => ({ applied: [`provider=${provider}`], refused: [], evidence });

  assert.deepEqual(readOutcome(response([uri]), sent, routes), { outcome: "honored", provider: "basalt", evidence: uri, checked: true });
  assert.deepEqual(readOutcome(response([uri]), sent, null), { outcome: "honored", provider: "basalt", evidence: uri, checked: false });

  const invalid = [[], [uri, uri], [`${uri}, ${uri}`], [`${uri},${uri}`], ["/attestation"], ["not a uri"], [""], ["https://[::1"], ["https://a@b@basalt.example/attestation"], ["https://basalt.example/%GG"], ["http://basalt.example/attestation"], ["HTTPS://basalt.example/attestation"]];
  for (const evidence of invalid) {
    assert.equal(readOutcome(response(evidence), sent, routes).outcome, "not-honored", JSON.stringify(evidence));
    assert.equal(readOutcome(response(evidence), sent, null).outcome, "not-honored", JSON.stringify(evidence));
  }
  // With the model list, a valid URI that is not the very string published for the route does not honor: another
  // host, another path on the same host, or the same place spelled another way.
  for (const other of ["https://elsewhere.example/attestation", "https://basalt.example/other", "https://basalt.example/attestation/", "https://basalt.example:443/attestation", "https://basalt.example/attestation?x=1"]) {
    assert.equal(readOutcome(response([other]), sent, routes).outcome, "not-honored", other);
    assert.equal(readOutcome(response([other]), sent, null).outcome, "honored", other);
  }
  // A route that publishes attest facts but no evidence cannot be matched to any.
  assert.equal(readOutcome(response([uri], "silent"), sent, routes).outcome, "not-honored");
  // The evidence pointer does not stand in for the route's published facts.
  assert.equal(readOutcome(response(["https://aurora.example/attestation"], "aurora"), sent, routes).outcome, "not-honored");
  // Without attest in the policy sent, evidence is not needed, none is reported, and what the route publishes is beside the point.
  assert.deepEqual(readOutcome(response([], "aurora"), policy("zdr"), routes), { outcome: "honored", provider: "aurora", evidence: null, checked: true });
  assert.deepEqual(readOutcome(response([uri], "aurora"), policy("zdr"), routes), { outcome: "honored", provider: "aurora", evidence: null, checked: true });
});

test("the baseline cannot be changed by a caller, in any of its three sets", () => {
  const first = baselineSupport();
  (first.attest as Set<string>).add("custom");
  (first.attest as Set<string>).delete("prompt");
  (first.keys as Set<string>).delete("zdr");
  (first.sort as Set<string>).delete("throughput");
  (first.sort as Set<string>).add("custom");
  assert.equal(parsePolicy("attest=custom").ok, false);
  assert.equal(parsePolicy("sort=custom").ok, false);
  for (const text of ["zdr", "attest=prompt", "sort=throughput"]) assert.equal(parsePolicy(text).ok, true, text);
  const fresh = baselineSupport();
  assert.deepEqual([...fresh.keys], ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "sort", "order"]);
  assert.deepEqual([...fresh.attest], ["weights", "prompt"]);
  assert.deepEqual([...fresh.sort], ["price", "latency", "throughput"]);
  // A detection reply that omits a list gets the same untouched defaults.
  const minimal = parseDetection({ route_policy: "1" });
  assert.ok(minimal.ok);
  assert.equal(supports(minimal.value.support, policy("zdr+attest=prompt+sort=throughput")), true);
});

test("C6: each list a detection reply omits takes its default, whichever others it gives", () => {
  const cases: [body: Record<string, unknown>, policy: string, cleared: boolean][] = [
    [{ keys: ["attest", "sort"] }, "attest=prompt", true],
    [{ keys: ["attest", "sort"] }, "attest=weights+sort=throughput", true],
    [{ keys: ["attest"], sort: ["price"] }, "attest=weights,prompt", true],
    [{ keys: ["attest"], attest: ["weights"] }, "attest=prompt", false],
    [{ attest: ["weights"] }, "zdr+sort=latency", true],
    [{ attest: ["weights"] }, "attest=prompt", false],
    [{ sort: ["price"] }, "attest=prompt", true],
    [{ sort: ["price"] }, "zdr+sort=latency", false],
    [{ keys: ["zdr"] }, "zdr", true],
    [{ keys: ["zdr"] }, "attest=prompt", false],
  ];
  for (const [body, text, cleared] of cases) {
    const reply = parseDetection({ route_policy: "1", ...body });
    assert.ok(reply.ok, JSON.stringify(body));
    assert.equal(clearedToSend(reply.value.support, [policy(text)]), cleared, `${JSON.stringify(body)} ${text}`);
  }
});

test("S5, S12: a flag given a value is not a fact, to a gateway publishing as to a client reading", () => {
  for (const text of ["zdr=no", "notrain=no", "zdr=no+notrain=no", "zdr=yes", "notrain=1+zdr", "zdr+notrain=0"]) {
    const published = parsePublishedFacts(text);
    assert.ok(!published.ok, text);
    assert.ok(published.key === "zdr" || published.key === "notrain", text);
    assert.equal(parseFacts(text).ok, false, text);
  }
  const first = parsePublishedFacts("zdr=no+notrain=no");
  assert.ok(!first.ok);
  assert.equal(first.key, "zdr");
});

test("S15: the key in Route-Refused fits the key grammar from its first character to its last", () => {
  for (const key of ["a", "zone7", "a".repeat(16)]) assert.deepEqual(parseRefused(`reason=unsupported+key=${key}`), { ok: true, value: { reason: "unsupported", key } });
  for (const key of ["7zone", "7", "_a", "-a", "A", "a_b", "a-b", "a.b", "a".repeat(17), "a b", "a+b"]) assert.equal(parseRefused(`reason=unsupported+key=${key}`).ok, false, key);
});

test("C16: a client holding the model list can tell that no published route meets a policy before sending it", () => {
  const routes = parseRoutes([
    { provider: "aurora", facts: "zdr+notrain+bits=8+region=us" },
    { provider: "basalt", facts: "bits=16+region=ca" },
    { provider: "broken", facts: "zdr+region=de+bits=0" },
    { provider: "twice", facts: "zdr+region=fr" },
    { provider: "twice", facts: "zdr+region=fr" },
  ]);
  for (const text of ["zdr", "zdr+region=us", "region=ca", "bits=16", "only=basalt", "ignore=aurora", "sort=price"]) assert.equal(someRouteMeets(routes, policy(text)), true, text);
  // The sole route in the wrong country, an unpublished provider, and routes that cannot be relied on.
  for (const text of ["zdr+region=ca", "zdr+bits=16", "attest=weights", "only=nosuch", "region=de", "region=fr", "only=broken", "only=twice"]) {
    assert.equal(someRouteMeets(routes, policy(text)), false, text);
  }
  assert.equal(someRouteMeets(parseRoutes([]), policy("sort=price")), false);
  assert.equal(someRouteMeets(routes, combinePolicies({ header: policy("region=us"), suffix: policy("region=ca") })), false);
  const forged: Policy = { ...policy("zdr") };
  assert.throws(() => someRouteMeets(routes, forged), { name: "TypeError", message: /^policy was not made by/ });
  assert.throws(() => someRouteMeets(parseRoutes([]), forged), { name: "TypeError", message: /^policy was not made by/ });
});

test("G11, G13: a requirement that only one carrier states survives, whichever carrier it is", () => {
  const each: [carrier: "key" | "header" | "suffix", text: string, field: keyof Policy, expected: unknown][] = [
    ["suffix", "notrain", "notrain", true],
    ["header", "notrain", "notrain", true],
    ["key", "notrain", "notrain", true],
    ["suffix", "zdr", "zdr", true],
    ["suffix", "bits=16", "bits", 16],
    ["header", "bits=16", "bits", 16],
    ["suffix", "region=us", "region", ["us"]],
    ["suffix", "only=a", "only", ["a"]],
    ["suffix", "ignore=a", "ignore", ["a"]],
    ["suffix", "attest=prompt", "attest", ["prompt"]],
    ["key", "attest=prompt", "attest", ["prompt"]],
  ];
  for (const [carrier, text, field, expected] of each) {
    // The other two carriers state something else, so the requirement comes from this one alone.
    const others = { key: policy("sort=price"), header: policy("order=x"), suffix: policy("sort=latency") };
    const combined = combinePolicies({ ...others, [carrier]: policy(text) });
    assert.deepEqual(combined[field], expected, `${carrier}: ${text}`);
  }
  const both = combinePolicies({ header: policy("zdr"), suffix: policy("notrain") });
  assert.equal(both.zdr, true);
  assert.equal(both.notrain, true);
  assert.equal(meets({ provider: "a", facts: facts("zdr") }, both), false);
  assert.equal(meets({ provider: "a", facts: facts("zdr+notrain") }, both), true);
});

test("G6: every country a route processes in must be allowed, however many it lists", () => {
  const route = (text: string) => ({ provider: "a", facts: facts(text) });
  assert.equal(meets(route("region=it,fr"), policy("region=it,fr")), true);
  assert.equal(meets(route("region=it,fr,de"), policy("region=it,fr")), false);
  assert.equal(meets(route("region=de,it,fr"), policy("region=it,fr")), false);
  assert.equal(meets(route("region=it,fr,de,es"), policy("region=it,fr,de")), false);
  assert.equal(meets(route("region=it,fr,de,es"), policy("region=es,de,fr,it")), true);
});

test("S18: an evidence URI's port is 1 to 65535 with no leading zero", () => {
  for (const port of ["1", "443", "8443", "44300", "65535"]) assert.equal(isEvidenceUri(`https://basalt.example:${port}/a`), true, port);
  for (const port of ["0", "00", "0443", "65536", "99999", "100000", "-1", ""]) assert.equal(isEvidenceUri(`https://basalt.example:${port}/a`), false, port);
});

test("C3: evidence is needed for any attest requirement, one item or two, and for none without one", () => {
  const uri = "https://basalt.example/attestation";
  const routes = parseRoutes([{ provider: "basalt", facts: "attest=weights,prompt", evidence: uri }]);
  const response = (evidence: string[]) => ({ applied: ["provider=basalt"], refused: [], evidence });
  for (const text of ["attest=prompt", "attest=weights", "attest=weights,prompt", "zdr+attest=prompt"]) {
    const sent = policy(text);
    assert.equal(readOutcome(response([]), sent, null).outcome, "not-honored", text);
    assert.equal(readOutcome(response([]), sent, routes).outcome, "not-honored", text);
  }
  assert.equal(readOutcome(response([uri]), policy("attest=prompt"), routes).outcome, "honored");
  assert.equal(readOutcome(response([uri]), policy("attest=weights"), null).outcome, "honored");
  assert.equal(readOutcome(response([]), policy("only=basalt"), routes).outcome, "honored");
});

test("C3: policies that combine to one no route can meet are never honored, with or without a model list", () => {
  const routes = parseRoutes([{ provider: "p", facts: "zdr+region=it,jp" }]);
  const response = { applied: ["provider=p"], refused: [], evidence: [] };
  const region = combinePolicies({ header: policy("region=it"), suffix: policy("region=jp") });
  const only = combinePolicies({ header: policy("only=p"), suffix: policy("only=q") });
  for (const sent of [region, only]) {
    assert.equal(readOutcome(response, sent, null).outcome, "not-honored");
    assert.equal(readOutcome(response, sent, routes).outcome, "not-honored");
  }
  // Each carrier alone is honored by the same response, so it is the combination that decides.
  assert.equal(readOutcome(response, policy("only=p"), null).outcome, "honored");
  assert.equal(readOutcome(response, policy("region=it,jp"), routes).outcome, "honored");
  // A refusal is still a refusal.
  assert.equal(readOutcome({ ...response, refused: ["reason=unsatisfiable"] }, region, null).outcome, "refused");
});

test("C6, G22: a key policy in a reply to a request without credentials makes the reply no detection", () => {
  const body = { route_policy: "1", key_policy: "zdr" };
  const withCredentials = readDetection({ status: 200, body, credentialed: true });
  assert.ok(withCredentials.ok);
  assert.equal(withCredentials.value.keyPolicy, "zdr");
  const anonymous = readDetection({ status: 200, body, credentialed: false });
  assert.ok(!anonymous.ok);
  assert.equal(anonymous.key, "key_policy");
  // Without the member, an anonymous reply is as valid as any.
  const plain = readDetection({ status: 200, body: { route_policy: "1" }, credentialed: false });
  assert.ok(plain.ok);
  assert.equal(plain.value.keyPolicy, null);
  assert.equal(clearedToSend(plain.value.support, [policy("zdr")]), true);
});

test("C6, G20: only a 200 reply is detection, whatever its body says", () => {
  const body = { route_policy: "1" };
  for (const credentialed of [true, false]) {
    assert.equal(readDetection({ status: 200, body, credentialed }).ok, true);
    for (const status of [201, 204, 206, 301, 304, 400, 401, 403, 404, 500, 503, 0, 2000, Number.NaN]) {
      const reply = readDetection({ status, body, credentialed });
      assert.ok(!reply.ok, String(status));
      assert.equal(reply.key, null, String(status));
    }
  }
});

test("G23, C4: the model is looked up by its id with no suffix, and a suffixed entry is only an alias", () => {
  const list = {
    data: [
      { id: "m", routes: [{ provider: "p", facts: "zdr" }] },
      { id: "m+zdr", routes: [{ provider: "p", facts: "notrain" }] },
      { id: "n", routes: [{ provider: "p", facts: "notrain" }] },
    ],
  };
  const response = { applied: ["provider=p"], refused: [], evidence: [] };
  for (const requested of ["m", "m+zdr", "m+zdr+sort=price", "m+"]) {
    assert.deepEqual(publishedRoutes(list, requested).get("p"), { facts: facts("zdr"), evidence: null }, requested);
    assert.equal(readOutcome(response, policy("zdr"), publishedRoutes(list, requested)).outcome, "honored", requested);
    assert.equal(readOutcome(response, policy("notrain"), publishedRoutes(list, requested)).outcome, "not-honored", requested);
  }
  // The same provider under another model has that model's facts, wherever the model stands in the list.
  assert.deepEqual(publishedRoutes(list, "n").get("p"), { facts: facts("notrain"), evidence: null });
  assert.equal(readOutcome(response, policy("zdr"), publishedRoutes(list, "n")).outcome, "not-honored");
  assert.equal(readOutcome(response, policy("notrain"), publishedRoutes(list, "n+sort=price")).outcome, "honored");
  // A list holding only the alias publishes no routes for the model.
  assert.equal(publishedRoutes({ data: [{ id: "m+zdr", routes: [{ provider: "p", facts: "zdr" }] }] }, "m+zdr").size, 0);
});

test("C4: only the model's own entries decide; whatever else the list holds does not concern the reader", () => {
  const target = { id: "m", routes: [{ provider: "p", facts: "zdr" }] };
  const response = { applied: ["provider=p"], refused: [], evidence: [] };
  const siblings: unknown[][] = [
    [null, target],
    [target, "text", 5, []],
    [{ id: "other", routes: 7 }, target],
    [{ id: "twin", routes: [] }, { id: "twin", routes: [] }, target],
    [{ routes: [{ provider: "p", facts: "notrain" }] }, target],
    [{ id: ["m"], routes: [{ provider: "p", facts: "notrain" }] }, target],
  ];
  for (const data of siblings) {
    assert.equal(readOutcome(response, policy("zdr"), publishedRoutes({ data }, "m")).outcome, "honored", JSON.stringify(data));
  }
});

test("S19: a repeated member name reads as its last occurrence, in the model list as in detection", () => {
  const list: unknown = JSON.parse('{"data":[],"data":[{"id":"x","id":"m","routes":[],"routes":[{"provider":"q","provider":"p","facts":"notrain","facts":"zdr"}]}]}');
  const routes = publishedRoutes(list, "m");
  assert.deepEqual([...routes.keys()], ["p"]);
  assert.deepEqual(routes.get("p"), { facts: facts("zdr"), evidence: null });
  const reply: unknown = JSON.parse('{"route_policy":"2","route_policy":"1","sort":["price"],"sort":[]}');
  const detection = parseDetection(reply);
  assert.ok(detection.ok);
  assert.equal(detection.value.support.sort.size, 0);
});

test("G35: explicit order beats rank for the providers it names", () => {
  const routes = [
    { provider: "a", price: 3 },
    { provider: "b", price: 1 },
    { provider: "c", price: 2 },
  ];
  const ids = (p: string): string =>
    orderRoutes(routes, policy(p), (route) => route.price)
      .map((route) => route.provider)
      .join("");
  // The order given is the opposite of the price order, and it stands.
  assert.equal(ids("order=c,b,a+sort=price"), "cba");
  assert.equal(ids("order=a,c+sort=price"), "acb");
  assert.equal(ids("order=c,b,a"), "cba");
  assert.equal(ids("sort=price"), "bca");
});

test("C5: readRefusal reports a refusal for any Route-Refused, readable or not, and none without one", () => {
  const headers = (refused: string[]) => ({ applied: ["provider=aurora"], refused, evidence: [] });
  assert.equal(readRefusal(headers([])), null);
  assert.deepEqual(readRefusal(headers(["reason=unsupported+key=tier"])), { reason: "unsupported", key: "tier" });
  assert.deepEqual(readRefusal(headers(["reason=unsatisfiable"])), { reason: "unsatisfiable", key: null });
  assert.deepEqual(readRefusal(headers(["nonsense"])), { reason: null, key: null });
  assert.deepEqual(readRefusal(headers([""])), { reason: null, key: null });
  assert.deepEqual(readRefusal(headers(["reason=unsatisfiable", "reason=unsatisfiable"])), { reason: null, key: null });
});

test("C5: a refusal of an attest policy is a refusal, although it carries no evidence", () => {
  const sent = policy("attest=weights,prompt");
  const refusal = { applied: [], refused: ["reason=unsatisfiable"], evidence: [] };
  assert.deepEqual(readOutcome(refusal, sent, null), { outcome: "refused", reason: "unsatisfiable", key: null });
  assert.deepEqual(readOutcome(refusal, sent, publishedRoutes({ data: [] }, "m")), { outcome: "refused", reason: "unsatisfiable", key: null });
  assert.deepEqual(readOutcome({ applied: ["provider=p"], refused: ["garbage"], evidence: [] }, sent, null), { outcome: "refused", reason: null, key: null });
});

test("G23, C4: a model list publishes routes for a model only when it has the shape and names the model once", () => {
  const rows = [{ provider: "p", facts: "zdr" }];
  assert.deepEqual([...publishedRoutes({ data: [{ id: "m", routes: rows }, { id: "other", routes: [{ provider: "q", facts: "" }] }] }, "m").keys()], ["p"]);
  assert.deepEqual([...publishedRoutes({ object: "list", data: [{ id: "other", routes: rows }, { id: "m", routes: rows }] }, "m").keys()], ["p"]);

  const none: [list: unknown, name: string][] = [
    [{ data: [{ id: "m", routes: rows }, { id: "m", routes: [{ provider: "p", facts: "notrain" }] }] }, "the model appears twice, with different facts"],
    [{ data: [{ id: "m", routes: rows }, { id: "m", routes: rows }] }, "the model appears twice, identically"],
    [{ data: [{ id: "other", routes: rows }] }, "the model is absent"],
    [{ data: [] }, "the list is empty"],
    [{ data: [{ id: "m" }] }, "the model has no routes member"],
    [{ data: [{ id: "m", routes: {} }] }, "routes is not a list"],
    [{ data: [{ id: "m", routes: "p" }] }, "routes is a string"],
    [{ data: { id: "m", routes: rows } }, "data is not a list"],
    [[{ id: "m", routes: rows }], "the list is a bare array"],
    [{ models: [{ id: "m", routes: rows }] }, "the list is under another member"],
    [Object.create({ data: [{ id: "m", routes: rows }] }), "data is inherited"],
    [{ data: [Object.create({ id: "m", routes: rows })] }, "the model's members are inherited"],
    [{ data: [{ id: ["m"], routes: rows }] }, "the id is not a string"],
    [null, "null"],
    ["text", "a string"],
  ];
  const response = { applied: ["provider=p"], refused: [], evidence: [] };
  for (const [list, name] of none) {
    assert.equal(publishedRoutes(list, "m").size, 0, name);
    assert.equal(readOutcome(response, policy("zdr"), publishedRoutes(list, "m")).outcome, "not-honored", name);
  }
  assert.equal(readOutcome(response, policy("zdr"), publishedRoutes({ data: [{ id: "m", routes: rows }] }, "m")).outcome, "honored");
});

test("G1, G3, G5: each refusal reason has its status", () => {
  assert.deepEqual({ ...REFUSAL_STATUS }, { unsupported: 400, unsatisfiable: 400, unavailable: 503 });
  assert.ok(Object.isFrozen(REFUSAL_STATUS));
});

test("S3, S13: a repeated key in facts is malformed and named, whether or not the reader knows the key", () => {
  const cases: [facts: string, key: string][] = [
    ["extended=2+extended=4+zdr", "extended"],
    ["zdr+extended+extended", "extended"],
    ["zdr+zdr", "zdr"],
    ["attest=weights+attest=prompt", "attest"],
  ];
  for (const [text, key] of cases) {
    const read = parseFacts(text);
    assert.ok(!read.ok, text);
    assert.equal(read.key, key, text);
    assert.equal(parsePublishedFacts(text).ok, false, text);
  }
  // A repeated item in a key the reader does not know is malformed too.
  assert.equal(parseFacts("extended=a,a").ok, false);
});

test("C10: two policies that are each writable can combine past 512 bytes, and then there is nothing to send", () => {
  const list = (prefix: string): string => Array.from({ length: 15 }, (_, i) => `${prefix}${String(i).padStart(2, "0")}`.padEnd(32, "x")).join(",");
  const key = policy(`only=${list("a")}`);
  const suffix = policy(`ignore=${list("b")}`);
  for (const each of [key, suffix]) assert.equal(formatPolicy(each).ok, true);
  const combined = combinePolicies({ key, suffix });
  // Every list is within its limit; only the whole string is too long.
  assert.equal(combined.only?.length, 15);
  assert.equal(combined.ignore.length, 15);
  const formatted = formatPolicy(combined);
  assert.ok(!formatted.ok);
  assert.equal(formatted.key, null);
});

test("C4: an empty model id names no model, so no list publishes routes for it", () => {
  const list = { data: [{ id: "", routes: [{ provider: "p", facts: "zdr" }] }] };
  for (const requested of ["", "+zdr", "+"]) {
    assert.equal(publishedRoutes(list, requested).size, 0, requested);
    assert.equal(readOutcome({ applied: ["provider=p"], refused: [], evidence: [] }, policy("zdr"), publishedRoutes(list, requested)).outcome, "not-honored", requested);
  }
});

test("S18: the last label of an evidence URI's host is not all digits", () => {
  for (const host of ["proof.example", "1.example", "123.a1", "a.b.c1", "x1", "1x", "a-1", "xn--1ca"]) assert.equal(isEvidenceUri(`https://${host}/report`), true, host);
  for (const host of ["proof.123", "127.0.0.1", "1", "123", "a.b.0", "192.168.1.1"]) {
    assert.equal(isEvidenceUri(`https://${host}/report`), false, host);
    assert.equal(isEvidenceUri(`https://${host}`), false, host);
    assert.equal(isEvidenceUri(`https://${host}:8443/report`), false, host);
  }
});

test("C16: the pre-send check reads every route until one meets, and stops there", () => {
  // Routes that cannot be relied on come first; the only one that meets comes last.
  const routes = parseRoutes([
    { provider: "broken", facts: "zdr+bits=0" },
    { provider: "twice", facts: "zdr" },
    { provider: "twice", facts: "zdr" },
    { provider: "cobalt", facts: "" },
    { provider: "aurora", facts: "zdr" },
  ]);
  assert.equal(someRouteMeets(routes, policy("zdr")), true);
  assert.equal(someRouteMeets(routes, policy("zdr+only=aurora")), true);
  assert.equal(someRouteMeets(routes, policy("zdr+ignore=aurora")), false);

  // Once a route meets, later entries are not read at all.
  const visited: string[] = [];
  const counting = new Map(routes);
  const original = counting[Symbol.iterator].bind(counting);
  counting[Symbol.iterator] = () => {
    const iterator = original();
    const next = iterator.next.bind(iterator);
    iterator.next = () => {
      const step = next();
      if (!step.done) visited.push(step.value[0]);
      return step;
    };
    return iterator;
  };
  assert.equal(someRouteMeets(counting, policy("only=cobalt")), true);
  assert.deepEqual(visited, ["broken", "twice", "cobalt"]);
});

test("C16: a route meets an attest requirement before sending only when it publishes a valid evidence URI", () => {
  const uri = "https://basalt.example/attestation";
  const withEvidence = parseRoutes([{ provider: "basalt", facts: "attest=weights,prompt", evidence: uri }]);
  const without = parseRoutes([{ provider: "basalt", facts: "attest=weights,prompt" }]);
  const badUri = parseRoutes([{ provider: "basalt", facts: "attest=weights,prompt", evidence: "bad URI" }]);
  for (const text of ["attest=prompt", "attest=weights,prompt", "attest=weights+only=basalt"]) {
    assert.equal(someRouteMeets(withEvidence, policy(text)), true, text);
    assert.equal(someRouteMeets(without, policy(text)), false, text);
    assert.equal(someRouteMeets(badUri, policy(text)), false, text);
  }
  // Without attest in the policy, evidence plays no part.
  for (const routes of [withEvidence, without, badUri]) assert.equal(someRouteMeets(routes, policy("only=basalt")), true);
  // What the check admits, the outcome can confirm; what it turns away, no response could have confirmed.
  const response = { applied: ["provider=basalt"], refused: [], evidence: [uri] };
  assert.equal(readOutcome(response, policy("attest=prompt"), withEvidence).outcome, "honored");
  assert.equal(readOutcome(response, policy("attest=prompt"), without).outcome, "not-honored");
  assert.equal(readOutcome(response, policy("attest=prompt"), badUri).outcome, "not-honored");
});

test("C16: the key's bound policy counts toward the pre-send check when the client can interpret it", () => {
  const routes = parseRoutes([
    { provider: "slow", facts: "" },
    { provider: "other", facts: "zdr" },
  ]);
  const header = policy("zdr");
  assert.equal(someRouteMeets(routes, header), true);
  // The key binds only=slow, and slow does not publish zdr: nothing meets both.
  const reply = parseDetection({ route_policy: "1", key_policy: "only=slow" });
  assert.ok(reply.ok);
  const bound = parsePolicy(reply.value.keyPolicy ?? "", reply.value.support);
  assert.ok(bound.ok);
  assert.equal(someRouteMeets(routes, combinePolicies({ key: bound.value, header })), false);
  assert.equal(someRouteMeets(routes, combinePolicies({ key: bound.value })), true);
  // A bound policy from a later revision cannot be interpreted, so it plays no part.
  const newer = parseDetection({ route_policy: "1", keys: ["zdr", "later"], key_policy: "later=slow" });
  assert.ok(newer.ok);
  assert.equal(parsePolicy(newer.value.keyPolicy ?? "", newer.value.support).ok, false);
});

test("C6: a bound policy that repeats a key or an item makes the reply no detection", () => {
  for (const bound of ["zdr+zdr", "only=a+only=b", "only=a,a", "sort=price+sort=price", "zdr+notrain+zdr"]) {
    const reply = parseDetection({ route_policy: "1", key_policy: bound });
    assert.ok(!reply.ok, bound);
    assert.equal(reply.key, "key_policy", bound);
  }
  assert.equal(parseDetection({ route_policy: "1", key_policy: "zdr+notrain" }).ok, true);
});
