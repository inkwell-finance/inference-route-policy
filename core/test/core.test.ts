import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { COUNTRIES } from "../src/countries.ts";
import {
  LIMITS,
  REFUSAL_STATUS,
  baselineSupport,
  clearedToSend,
  combinePolicies,
  formatApplied,
  formatDetection,
  fitsPolicyGrammar,
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
  providerAllowed,
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

/** The fields of a policy that states nothing. */
const NO_POLICY = { zdr: false, notrain: false, bits: null, region: null, attest: [], only: null, ignore: [], sort: null, order: null };

/** The fields of facts that state nothing. */
const NO_FACTS = { zdr: false, notrain: false, bits: null, region: null, attest: [] };

/** A support's three lists as arrays, so that their order is compared too. */
const lists = (support: Support) => ({ keys: [...support.keys], attest: [...support.attest], sort: [...support.sort] });

/** The routes a model list publishes for its one model, `m`. */
const parseRoutes = (rows: unknown) => publishedRoutes({ data: [{ id: "m", routes: rows }] }, "m");

/** A detection body read as a 200 reply to a request that carried credentials. */
const parseDetection = (body: unknown) => readDetection({ status: 200, body, credentialed: true });

const notAPolicy = { name: "TypeError", message: /^policy was not made by parsePolicy or combinePolicies$/ };
const notFacts = { name: "TypeError", message: /^facts were not made by parseFacts or parsePublishedFacts$/ };

test("S1: zdr+notrain+bits=8+region=us,de+attest=weights,prompt+only=a,b+ignore=c+sort=latency+order=b,a, which names the nine keys of baselineSupport(), parses to the nine values written", () => {
  const parsed = policy("zdr+notrain+bits=8+region=us,de+attest=weights,prompt+only=a,b+ignore=c+sort=latency+order=b,a");
  assert.deepEqual(keysOf(parsed), [...baselineSupport().keys]);
  assert.deepEqual(parsed, {
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
});

test("S1: sort=price parses to sort price with the other eight fields empty", () => {
  assert.deepEqual(policy("sort=price"), { ...NO_POLICY, sort: "price" });
});

test("S1: 17 policies with an empty policy, pair, key or item, a stray =, or whitespace are refused as a malformed key or item", () => {
  const cases: [text: string, key: string | null, detail: string][] = [
    ["", null, "malformed key in \"\""],
    ["+", null, "malformed key in \"\""],
    ["zdr+", null, "malformed key in \"\""],
    ["+zdr", null, "malformed key in \"\""],
    ["zdr++notrain", null, "malformed key in \"\""],
    ["only=", "only", "malformed item \"\""],
    ["only=a,", "only", "malformed item \"\""],
    ["only=,a", "only", "malformed item \"\""],
    ["zdr ", null, "malformed key in \"zdr \""],
    [" zdr", null, "malformed key in \" zdr\""],
    ["zdr+ notrain", null, "malformed key in \" notrain\""],
    ["only=a, b", "only", "malformed item \" b\""],
    ["=a", null, "malformed key in \"=a\""],
    ["zdr=", "zdr", "malformed item \"\""],
    ["bits==8", "bits", "malformed item \"=8\""],
    ["zdr\n", null, "malformed key in \"zdr\n\""],
    ["zdr\t+notrain", null, "malformed key in \"zdr\t\""],
  ];
  assert.equal(cases.length, 17);
  for (const [text, key, detail] of cases) assert.deepEqual(parsePolicy(text), { ok: false, key, detail }, JSON.stringify(text));
});

test("S2: a 16-character key passes the grammar and is refused by name as not accepted; a 17-character key is malformed and names no key", () => {
  assert.deepEqual(parsePolicy("k".repeat(16)), { ok: false, key: "k".repeat(16), detail: "key not accepted" });
  assert.deepEqual(parsePolicy("k".repeat(17)), { ok: false, key: null, detail: `malformed key in "${"k".repeat(17)}"` });
});

test("S2: only= with a 32-character item parses, and with a 33-character item is refused naming `only` as a malformed item", () => {
  assert.deepEqual(policy(`only=${"a".repeat(32)}`), { ...NO_POLICY, only: ["a".repeat(32)] });
  assert.deepEqual(parsePolicy(`only=${"a".repeat(33)}`), { ok: false, key: "only", detail: `malformed item "${"a".repeat(33)}"` });
});

test("S2: Zdr, 1zdr, z_dr, z-dr, a.b, acme.tier=2, a., .a, zdré and __proto__ are refused as malformed keys that name no key", () => {
  for (const key of ["Zdr", "1zdr", "z_dr", "z-dr", "a.b", "acme.tier=2", "a.", ".a", "zdr\u00e9", "__proto__"]) {
    assert.deepEqual(parsePolicy(key), { ok: false, key: null, detail: `malformed key in "${key}"` }, key);
  }
});

test("S2: only=0a,a_b,a.b,a-b,constructor,valueof parses, and only= with A, _a, .a, -a, a b, a/b, a:b, a~b, __proto__ or é is refused naming `only` as a malformed item", () => {
  assert.deepEqual(policy("only=0a,a_b,a.b,a-b,constructor,valueof"), { ...NO_POLICY, only: ["0a", "a_b", "a.b", "a-b", "constructor", "valueof"] });
  for (const item of ["A", "_a", ".a", "-a", "a b", "a/b", "a:b", "a~b", "__proto__", "\u00e9"]) {
    assert.deepEqual(parsePolicy(`only=${item}`), { ok: false, key: "only", detail: `malformed item "${item}"` }, item);
  }
});

test("S3: zdr+zdr and only=a+only=b are refused as a repeated key, and only=a,a and region=us,de,us as a repeated item, naming the key", () => {
  assert.deepEqual(parsePolicy("zdr+zdr"), { ok: false, key: "zdr", detail: "repeated key" });
  assert.deepEqual(parsePolicy("only=a+only=b"), { ok: false, key: "only", detail: "repeated key" });
  assert.deepEqual(parsePolicy("only=a,a"), { ok: false, key: "only", detail: "repeated item" });
  assert.deepEqual(parsePolicy("region=us,de,us"), { ok: false, key: "region", detail: "repeated item" });
});

test("S4: only= with LIMITS.items (16) items parses, and with 17 items is refused naming `only` as more than 16 items", () => {
  assert.equal(LIMITS.items, 16);
  const items = (n: number): string[] => Array.from({ length: n }, (_, i) => `p${i}`);
  assert.deepEqual(policy(`only=${items(LIMITS.items).join(",")}`), { ...NO_POLICY, only: items(LIMITS.items) });
  assert.deepEqual(parsePolicy(`only=${items(LIMITS.items + 1).join(",")}`), { ok: false, key: "only", detail: "more than 16 items" });
});

test("S4: facts of LIMITS.pairs (16) unknown keys read as no fact, and facts of 17 unknown keys fail as more than 16 pairs naming no key", () => {
  // Only facts can hold sixteen distinct well-formed keys, since a reader lets through the ones it does not know.
  assert.equal(LIMITS.pairs, 16);
  const unknown = Array.from({ length: LIMITS.pairs + 1 }, (_, i) => `k${i}`);
  assert.deepEqual(parseFacts(unknown.slice(0, LIMITS.pairs).join("+")), { ok: true, value: NO_FACTS });
  assert.deepEqual(parseFacts(unknown.join("+")), { ok: false, key: null, detail: "more than 16 pairs" });
});

test("S4: an only= policy of exactly LIMITS.policyBytes (512) bytes parses, and the same policy one byte longer is refused as longer than 512 bytes naming no key", () => {
  assert.equal(LIMITS.policyBytes, 512);
  // "only=" and fifteen 32-byte items is 499 bytes; a sixteenth item of 12 bytes makes exactly 512.
  const fifteen = Array.from({ length: 15 }, (_, i) => String.fromCharCode(97 + i).repeat(32));
  const at = `only=${[...fifteen, "p".repeat(12)].join(",")}`;
  assert.equal(new TextEncoder().encode(at).length, LIMITS.policyBytes);
  assert.deepEqual(policy(at), { ...NO_POLICY, only: [...fifteen, "p".repeat(12)] });
  const over = `only=${[...fifteen, "p".repeat(13)].join(",")}`;
  assert.equal(new TextEncoder().encode(over).length, LIMITS.policyBytes + 1);
  assert.deepEqual(parsePolicy(over), { ok: false, key: null, detail: "longer than 512 bytes" });
});

test("S4: only=a+ignore= with 250 é is 264 characters but 514 bytes and is refused as longer than 512 bytes, while only=a+ignore=é is refused naming ignore as a malformed item", () => {
  const wide = `only=a+ignore=${"\u00e9".repeat(250)}`;
  assert.equal(wide.length, 264);
  assert.equal(new TextEncoder().encode(wide).length, 514);
  assert.deepEqual(parsePolicy(wide), { ok: false, key: null, detail: "longer than 512 bytes" });
  assert.deepEqual(parsePolicy("only=a+ignore=\u00e9"), { ok: false, key: "ignore", detail: "malformed item \"\u00e9\"" });
});

test("S5: zdr=yes and notrain=1 are refused naming zdr and notrain as taking no value", () => {
  assert.deepEqual(parsePolicy("zdr=yes"), { ok: false, key: "zdr", detail: "takes no value" });
  assert.deepEqual(parsePolicy("notrain=1"), { ok: false, key: "notrain", detail: "takes no value" });
});

test("S6: bits=1 and bits=64 parse to bits 1 and 64", () => {
  assert.deepEqual(policy("bits=1"), { ...NO_POLICY, bits: 1 });
  assert.deepEqual(policy("bits=64"), { ...NO_POLICY, bits: 64 });
});

test("S6: bits with 0, 65, 08, 8.0, 8,16, x or 100, and bits with no value, are refused naming bits as not one integer from 1 to 64; bits=-8 is refused naming bits as a malformed item", () => {
  for (const value of ["0", "65", "08", "8.0", "8,16", "x", "100"]) {
    assert.deepEqual(parsePolicy(`bits=${value}`), { ok: false, key: "bits", detail: "takes one integer from 1 to 64" }, value);
  }
  assert.deepEqual(parsePolicy("bits"), { ok: false, key: "bits", detail: "takes one integer from 1 to 64" });
  assert.deepEqual(parsePolicy("bits=-8"), { ok: false, key: "bits", detail: "malformed item \"-8\"" });
});

test("S7: COUNTRIES holds 249 codes with the pinned digest, and region=<code> parses to that one code for the 249 codes", () => {
  // The set, checked once against an independent ISO 3166-1 listing, is pinned by its digest so that no code can
  // be swapped for another without this failing.
  const codes = Object.keys(COUNTRIES).sort();
  assert.equal(codes.length, 249);
  assert.equal(createHash("sha256").update(codes.join(",")).digest("hex"), "792d849dd15e8c7053629d4ce0683b28565d05f4f1f5431d13284245313534c6");
  for (const code of codes) assert.deepEqual(policy(`region=${code}`), { ...NO_POLICY, region: [code] }, code);
});

test("S7: region=us,de,jp parses; region with ab, eu, uk, xk, xa, zz, usa, u, u1, us,deu, us,ab or constructor, or with no value, is refused naming region", () => {
  assert.deepEqual(policy("region=us,de,jp"), { ...NO_POLICY, region: ["us", "de", "jp"] });
  for (const value of ["ab", "eu", "uk", "xk", "xa", "zz", "usa", "u", "u1", "us,deu", "us,ab", "constructor"]) {
    assert.deepEqual(parsePolicy(`region=${value}`), { ok: false, key: "region", detail: "takes a list of assigned ISO 3166-1 alpha-2 codes" }, value);
  }
  assert.deepEqual(parsePolicy("region"), { ok: false, key: "region", detail: "takes a list of assigned ISO 3166-1 alpha-2 codes" });
});

test("S7: facts region=ab and region=us,eu are invalid, naming region", () => {
  assert.deepEqual(parseFacts("region=ab"), { ok: false, key: "region", detail: "takes a list of assigned ISO 3166-1 alpha-2 codes" });
  assert.deepEqual(parseFacts("region=us,eu"), { ok: false, key: "region", detail: "takes a list of assigned ISO 3166-1 alpha-2 codes" });
});

test("S8: attest=weights,other and attest with no value are refused naming attest", () => {
  assert.deepEqual(parsePolicy("attest=weights,other"), { ok: false, key: "attest", detail: "value not accepted" });
  assert.deepEqual(parsePolicy("attest"), { ok: false, key: "attest", detail: "value not accepted" });
});

test("S10: sort=cheap, sort=price,latency and sort with no value are refused naming sort", () => {
  assert.deepEqual(parsePolicy("sort=cheap"), { ok: false, key: "sort", detail: "value not accepted" });
  assert.deepEqual(parsePolicy("sort=price,latency"), { ok: false, key: "sort", detail: "value not accepted" });
  assert.deepEqual(parsePolicy("sort"), { ok: false, key: "sort", detail: "value not accepted" });
});

test("S8, S10: with attest listing weights and sort listing price, attest=weights+sort=price parses, and attest=prompt, attest=weights,prompt and sort=latency are refused as not accepted", () => {
  const narrow: Support = { keys: baselineSupport().keys, attest: new Set(["weights"]), sort: new Set(["price"]) };
  assert.deepEqual(policy("attest=weights+sort=price", narrow), { ...NO_POLICY, attest: ["weights"], sort: "price" });
  assert.deepEqual(parsePolicy("attest=prompt", narrow), { ok: false, key: "attest", detail: "value not accepted" });
  assert.deepEqual(parsePolicy("attest=weights,prompt", narrow), { ok: false, key: "attest", detail: "value not accepted" });
  assert.deepEqual(parsePolicy("sort=latency", narrow), { ok: false, key: "sort", detail: "value not accepted" });
});

test("S8, S10: with attest and sort lists that add custom, attest=custom and sort=custom are still refused as not accepted", () => {
  // Listing a value this revision does not define does not make it valid.
  const wide: Support = { keys: baselineSupport().keys, attest: new Set(["weights", "custom"]), sort: new Set(["price", "custom"]) };
  assert.deepEqual(parsePolicy("attest=custom", wide), { ok: false, key: "attest", detail: "value not accepted" });
  assert.deepEqual(parsePolicy("sort=custom", wide), { ok: false, key: "sort", detail: "value not accepted" });
});

test("S9: only, ignore and order with no value are refused naming the key, and only=, ignore= and order= with nosuch,constructor,0 parse to that list", () => {
  for (const key of ["only", "ignore", "order"] as const) {
    assert.deepEqual(parsePolicy(key), { ok: false, key, detail: "takes a list of provider ids" }, key);
    assert.deepEqual(policy(`${key}=nosuch,constructor,0`), { ...NO_POLICY, [key]: ["nosuch", "constructor", "0"] }, key);
  }
});

test("S16: bits=0 followed by 15 pairs is refused naming bits, bits=0 followed by 16 pairs as more than 16 pairs, and bits=0 followed by an over-512-byte pair as longer than 512 bytes", () => {
  const tail = Array.from({ length: 16 }, (_, i) => `k${i}`);
  assert.deepEqual(parsePolicy(`bits=0+${tail.slice(0, 15).join("+")}`), { ok: false, key: "bits", detail: "takes one integer from 1 to 64" });
  assert.deepEqual(parsePolicy(`bits=0+${tail.join("+")}`), { ok: false, key: null, detail: "more than 16 pairs" });
  assert.deepEqual(parsePolicy(`bits=0+only=${"a".repeat(32)},${"b,".repeat(250)}c`), { ok: false, key: null, detail: "longer than 512 bytes" });
});

test("S16: in 11 policies of two to four pairs, the first failing pair in written order is the one refused, by value, repetition, grammar or unknown key", () => {
  const cases: [text: string, key: string | null, detail: string][] = [
    ["bits=0+only=a,a", "bits", "takes one integer from 1 to 64"],
    ["only=a,a+bits=0", "only", "repeated item"],
    ["zdr=1+only=", "zdr", "takes no value"],
    ["only=+zdr=1", "only", "malformed item \"\""],
    ["later+?", "later", "key not accepted"],
    ["?+later", null, "malformed key in \"?\""],
    ["zdr+later=1", "later", "key not accepted"],
    ["later+bits=999", "later", "key not accepted"],
    ["bits=999+later", "bits", "takes one integer from 1 to 64"],
    ["zdr+Bad=1+bits=0", null, "malformed key in \"Bad=1\""],
    ["zdr+notrain+zdr+bits=0", "zdr", "repeated key"],
  ];
  assert.equal(cases.length, 11);
  for (const [text, key, detail] of cases) assert.deepEqual(parsePolicy(text), { ok: false, key, detail }, text);
});

test("G21: with keys listing `only` and `sort`, zdr and only=a+bits=8 are refused naming zdr and bits as not accepted, and only=a+sort=price parses", () => {
  const subset: Support = { ...baselineSupport(), keys: new Set(["only", "sort"]) };
  assert.deepEqual(parsePolicy("zdr", subset), { ok: false, key: "zdr", detail: "key not accepted" });
  assert.deepEqual(parsePolicy("only=a+bits=8", subset), { ok: false, key: "bits", detail: "key not accepted" });
  assert.deepEqual(policy("only=a+sort=price", subset), { ...NO_POLICY, only: ["a"], sort: "price" });
});

test("G21: with keys listing later, later is refused naming later as a key not defined", () => {
  assert.deepEqual(parsePolicy("later", { ...baselineSupport(), keys: new Set(["later"]) }), { ok: false, key: "later", detail: "key not defined" });
});

test("parsePolicy, combinePolicies and parseFacts return frozen values with frozen lists, and the combined order list is a copy equal to the input's", () => {
  const made = policy("zdr+region=us,de+only=a+order=a");
  assert.ok(Object.isFrozen(made));
  for (const list of [made.region, made.attest, made.only, made.ignore, made.order]) assert.ok(list !== null && Object.isFrozen(list));
  const combined = combinePolicies({ key: made, suffix: policy("ignore=x") });
  assert.ok(Object.isFrozen(combined));
  for (const list of [combined.region, combined.attest, combined.only, combined.ignore, combined.order]) assert.ok(list !== null && Object.isFrozen(list));
  const read = facts("zdr+region=us+attest=weights");
  assert.ok(Object.isFrozen(read));
  assert.ok(Object.isFrozen(read.region) && Object.isFrozen(read.attest));
  // The combined policy has its own lists: it is not the input's.
  assert.notEqual(combined.order, made.order);
  assert.deepEqual(combined.order, made.order);
});

test("six hand-built copies of a parsed policy, one unchanged and five with values the parser refuses, are refused as not made by the parser by meets, formatPolicy, keysOf, hasRequirements, supports, combinePolicies as header or suffix, orderRoutes, clearedToSend and readOutcome", () => {
  const made = policy("zdr+region=us,de+only=a+order=a");
  const route = { provider: "a", facts: facts("zdr+region=us+attest=weights") };
  const forgedPolicies: Policy[] = [{ ...made }, { ...made, bits: 65 }, { ...made, bits: Number.NaN }, { ...made, region: [] }, { ...made, only: ["a,b"] }, { ...made, sort: "custom" }];
  assert.equal(forgedPolicies.length, 6);
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
});

test("five hand-built copies of parsed facts, one unchanged and four with values the parser refuses, are refused as not made by the parser by meets under two policies and by readOutcome", () => {
  const read = facts("zdr+region=us+attest=weights");
  const made = policy("zdr+region=us,de+only=a+order=a");
  const forgedFacts: Facts[] = [{ ...read }, { ...read, bits: 65 }, { ...read, bits: Number.NaN }, { ...read, region: [] }, { ...read, region: ["ab"] }];
  assert.equal(forgedFacts.length, 5);
  for (const forged of forgedFacts) {
    assert.throws(() => meets({ provider: "a", facts: forged }, made), notFacts);
    assert.throws(() => meets({ provider: "a", facts: forged }, policy("only=a")), notFacts);
    const routes = parseRoutes([{ provider: "a", facts: "zdr" }]);
    routes.set("a", { facts: forged, evidence: null });
    assert.throws(() => readOutcome({ applied: ["provider=a"], refused: [], evidence: [] }, policy("zdr"), routes), notFacts);
  }
});

test("a combined policy passed as facts is refused as not facts by meets and readOutcome, and parsed facts passed as a policy are refused as not a policy by meets, formatPolicy, keysOf, combinePolicies, orderRoutes and readOutcome", () => {
  const read = facts("zdr+region=us+attest=weights");
  const route = { provider: "a", facts: read };
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
});

test("under a null, the baseline and an empty support, clearedToSend refuses a hand-built policy listed second, first, or after sort=price, and parsed facts listed second", () => {
  const made = policy("zdr+region=us,de+only=a+order=a");
  const forged: Policy = { ...made };
  // @ts-expect-error Facts are not assignable to a Policy
  const factsAsPolicy: Policy = facts("zdr");
  for (const support of [null, baselineSupport(), { keys: new Set<string>(), attest: new Set<string>(), sort: new Set<string>() }]) {
    assert.throws(() => clearedToSend(support, [made, forged]), notAPolicy);
    assert.throws(() => clearedToSend(support, [forged, made]), notAPolicy);
    assert.throws(() => clearedToSend(support, [policy("sort=price"), forged]), notAPolicy);
    assert.throws(() => clearedToSend(support, [made, factsAsPolicy]), notAPolicy);
  }
});

test("formatPolicy refuses null, undefined, \"zdr\" and 5 as not made by the parser", () => {
  for (const notAValue of [null, undefined, "zdr", 5]) assert.throws(() => formatPolicy(notAValue as unknown as Policy), notAPolicy, String(notAValue));
});

test("formatPolicy writes zdr, sort=price, order=b,a+sort=throughput and a seven-key policy as strings that parse back to equal policies", () => {
  const cases: [text: string, written: string][] = [
    ["zdr", "zdr"],
    ["sort=price", "sort=price"],
    ["order=b,a+sort=throughput", "sort=throughput+order=b,a"],
    ["ignore=c+only=a,b+attest=prompt+region=de,us+bits=16+notrain+zdr", "zdr+notrain+bits=16+region=de,us+attest=prompt+only=a,b+ignore=c"],
  ];
  for (const [text, written] of cases) {
    const first = policy(text);
    assert.deepEqual(formatPolicy(first), { ok: true, value: written }, text);
    assert.deepEqual(policy(written), first, text);
  }
});

test("formatPolicy writes sort=price+zdr+bits=8 as zdr+bits=8+sort=price", () => {
  assert.deepEqual(formatPolicy(policy("sort=price+zdr+bits=8")), { ok: true, value: "zdr+bits=8+sort=price" });
});

test("C10: combinePolicies({}), disjoint region us and de, disjoint only=a and only=b, and 16 plus 1 ignore items fail to format, naming no key, `region`, `only` and `ignore`", () => {
  const sixteen = `ignore=${Array.from({ length: 16 }, (_, i) => `p${i}`).join(",")}`;
  const cases: [name: string, policy: Policy, key: string | null, detail: string][] = [
    ["nothing", combinePolicies({}), null, "malformed key in \"\""],
    ["disjoint region", combinePolicies({ key: policy("region=us"), suffix: policy("region=de") }), "region", "malformed item \"\""],
    ["disjoint only", combinePolicies({ key: policy("only=a"), suffix: policy("only=b") }), "only", "malformed item \"\""],
    ["17 ignores", combinePolicies({ key: policy(sixteen), suffix: policy("ignore=extra") }), "ignore", "more than 16 items"],
  ];
  for (const [name, value, key, detail] of cases) assert.deepEqual(formatPolicy(value), { ok: false, key, detail }, name);
  assert.deepEqual(combinePolicies({ key: policy(sixteen), suffix: policy("ignore=extra") }).ignore, ["extra", ...Array.from({ length: 16 }, (_, i) => `p${i}`)]);
});

test("C10: the key policy zdr+region=us,de combined with the suffix region=de+sort=price formats as zdr+region=de+sort=price", () => {
  assert.deepEqual(formatPolicy(combinePolicies({ key: policy("zdr+region=us,de"), suffix: policy("region=de+sort=price") })), { ok: true, value: "zdr+region=de+sort=price" });
});

test("hasRequirements is false for sort=price, order=a and sort=price+order=a", () => {
  assert.equal(hasRequirements(policy("sort=price")), false);
  assert.equal(hasRequirements(policy("order=a")), false);
  assert.equal(hasRequirements(policy("sort=price+order=a")), false);
});

test("hasRequirements is true for a sample of the seven non-preference keys of baselineSupport(), alone and with sort=price", () => {
  const samples: Record<string, string> = { zdr: "zdr", notrain: "notrain", bits: "bits=8", region: "region=us", attest: "attest=weights", only: "only=a", ignore: "ignore=a" };
  assert.deepEqual(Object.keys(samples), [...baselineSupport().keys].filter((key) => key !== "sort" && key !== "order"));
  for (const text of Object.values(samples)) {
    assert.equal(hasRequirements(policy(text)), true, text);
    assert.equal(hasRequirements(policy(`sort=price+${text}`)), true, text);
  }
});

test("C1: with keys zdr, sort, attest, bits, region and only, attest weights and sort price listed, supports is true for zdr+sort=price+attest=weights and bits=64+region=fr+only=constructor, and false for notrain, ignore, order, sort=latency, attest=prompt, attest=weights,prompt and attest=prompt,weights", () => {
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

test("S11: splitModel splits example-model, vendor/example-model:free+zdr+sort=price, example-model+, +zdr and the empty string at the first plus", () => {
  assert.deepEqual(splitModel("example-model"), { id: "example-model", policy: null });
  assert.deepEqual(splitModel("vendor/example-model:free+zdr+sort=price"), { id: "vendor/example-model:free", policy: "zdr+sort=price" });
  assert.deepEqual(splitModel("example-model+"), { id: "example-model", policy: "" });
  assert.deepEqual(splitModel("+zdr"), { id: "", policy: "zdr" });
  assert.deepEqual(splitModel(""), { id: "", policy: null });
});

test("S11: the empty policy after example-model+ is refused as a malformed key naming no key", () => {
  const { policy: suffix } = splitModel("example-model+");
  assert.equal(suffix, "");
  assert.deepEqual(parsePolicy(suffix ?? "unreachable"), { ok: false, key: null, detail: "malformed key in \"\"" });
});

test("G11: a key, header and suffix with flags, bits 8, 16 and 4, regions, `only` lists, ignore and attest combine to both flags, bits 16, region fr, `only` b,c, ignore y,x and attest prompt,weights", () => {
  assert.deepEqual(
    combinePolicies({
      key: policy("zdr+bits=8+region=us,de,fr+only=a,b,c+ignore=x+attest=weights"),
      header: policy("notrain+bits=16+region=de,fr+ignore=y"),
      suffix: policy("bits=4+region=fr,gb+only=b,c,d+attest=prompt"),
    }),
    { zdr: true, notrain: true, bits: 16, region: ["fr"], attest: ["prompt", "weights"], only: ["b", "c"], ignore: ["y", "x"], sort: null, order: null },
  );
});

test("G11: bits=32 from the key beats the header's 8 and the suffix's 16, and bits=32 from the suffix beats the key's 8", () => {
  assert.deepEqual(combinePolicies({ key: policy("bits=32"), header: policy("bits=8"), suffix: policy("bits=16") }), { ...NO_POLICY, bits: 32 });
  assert.deepEqual(combinePolicies({ key: policy("bits=8"), suffix: policy("bits=32") }), { ...NO_POLICY, bits: 32 });
});

test("G11: ignore lists a,b, b,c and a,c combine to a,c,b, attest lists weights and weights,prompt to weights,prompt, and ignore=a,b with ignore=a,c formats as ignore=a,c,b", () => {
  assert.deepEqual(
    combinePolicies({ key: policy("ignore=a,b+attest=weights"), header: policy("ignore=b,c+attest=weights,prompt"), suffix: policy("ignore=a,c") }),
    { ...NO_POLICY, ignore: ["a", "c", "b"], attest: ["weights", "prompt"] },
  );
  assert.deepEqual(combinePolicies({ key: policy("attest=weights"), header: policy("attest=weights,prompt") }), { ...NO_POLICY, attest: ["weights", "prompt"] });
  assert.deepEqual(formatPolicy(combinePolicies({ key: policy("ignore=a,b"), suffix: policy("ignore=a,c") })), { ok: true, value: "ignore=a,c,b" });
});

test("G12: region=us from the key and region=de from the suffix combine to an empty region, which routes with region us, de or no facts do not meet", () => {
  const region = combinePolicies({ key: policy("region=us"), suffix: policy("region=de") });
  assert.deepEqual(region, { ...NO_POLICY, region: [] });
  assert.equal(meets({ provider: "a", facts: facts("region=us") }, region), false);
  assert.equal(meets({ provider: "a", facts: facts("region=de") }, region), false);
  assert.equal(meets({ provider: "a", facts: facts("") }, region), false);
});

test("G12: only=a from the key and only=b from the header combine to an empty only, which providers a and b do not meet", () => {
  const only = combinePolicies({ key: policy("only=a"), header: policy("only=b") });
  assert.deepEqual(only, { ...NO_POLICY, only: [] });
  assert.equal(meets({ provider: "a", facts: facts("region=us") }, only), false);
  assert.equal(meets({ provider: "b", facts: facts("") }, only), false);
});

test("G12: three-layer intersections where the key narrows give region de and `only` c, and key us with header us,de and suffix de gives an empty region", () => {
  // The intersection runs over the three layers present: here the key's narrows it, and it is the least specific.
  assert.deepEqual(combinePolicies({ key: policy("region=de"), header: policy("region=us,de,fr"), suffix: policy("region=us,de") }), { ...NO_POLICY, region: ["de"] });
  assert.deepEqual(combinePolicies({ key: policy("only=c"), header: policy("only=a,b,c"), suffix: policy("only=b,c") }), { ...NO_POLICY, only: ["c"] });
  assert.deepEqual(combinePolicies({ key: policy("region=us"), header: policy("region=us,de"), suffix: policy("region=de") }), { ...NO_POLICY, region: [] });
});

test("G11: sort comes from the suffix over the header over the key, and order from the header over the key, with the key's own sort and order used when it is the one layer", () => {
  assert.deepEqual(
    combinePolicies({ key: policy("sort=price+order=a"), header: policy("sort=latency+order=b"), suffix: policy("sort=throughput") }),
    { ...NO_POLICY, sort: "throughput", order: ["b"] },
  );
  assert.deepEqual(combinePolicies({ key: policy("sort=price+order=a"), header: policy("sort=latency") }), { ...NO_POLICY, sort: "latency", order: ["a"] });
  assert.deepEqual(combinePolicies({ key: policy("sort=price+order=a") }), { ...NO_POLICY, sort: "price", order: ["a"] });
  assert.deepEqual(combinePolicies({ key: policy("sort=price"), suffix: policy("sort=latency") }), { ...NO_POLICY, sort: "latency" });
});

test("G11: order=c,d from the suffix beats order=b from the header and order=a from the key", () => {
  assert.deepEqual(combinePolicies({ key: policy("order=a"), header: policy("order=b"), suffix: policy("order=c,d") }), { ...NO_POLICY, order: ["c", "d"] });
});

test("G13: the key policy zdr+notrain+bits=16+region=us+attest=weights+only=a+ignore=b keeps those values beside a header or suffix stating sort=price, bits=1, region=us,de,fr, only=a,b,c, attest=prompt or ignore=c", () => {
  const key = policy("zdr+notrain+bits=16+region=us+attest=weights+only=a+ignore=b");
  const strong = { zdr: true, notrain: true, bits: 16, region: ["us"], attest: ["weights"], only: ["a"], ignore: ["b"], sort: null, order: null };
  // The header and the suffix are both more specific than the key, so their list items come first.
  const expected: Record<string, object> = {
    "sort=price": { ...strong, sort: "price" },
    "bits=1": strong,
    "region=us,de,fr": strong,
    "only=a,b,c": strong,
    "attest=prompt": { ...strong, attest: ["prompt", "weights"] },
    "ignore=c": { ...strong, ignore: ["c", "b"] },
  };
  for (const [other, value] of Object.entries(expected)) {
    for (const carrier of ["header", "suffix"] as const) {
      assert.deepEqual(combinePolicies({ key, [carrier]: policy(other) }), value, `${carrier}: ${other}`);
    }
  }
});

test("S13: facts zdr+bits=8+region=us,de+attest=weights,later+later+newkey=x,y+provider=p+constructor=x read as zdr, bits 8, region us,de and attest weights, and the empty string reads as no fact", () => {
  assert.deepEqual(facts(""), NO_FACTS);
  assert.deepEqual(facts("zdr+bits=8+region=us,de+attest=weights,later+later+newkey=x,y+provider=p+constructor=x"), { ...NO_FACTS, zdr: true, bits: 8, region: ["us", "de"], attest: ["weights"] });
});

test("S13: facts attest=prompt,next read as attest=prompt, and attest=next and attest=next,later read as no fact", () => {
  // An unknown item is ignored, not kept: the facts read the same with or without it.
  assert.deepEqual(facts("attest=prompt,next"), { ...NO_FACTS, attest: ["prompt"] });
  assert.deepEqual(facts("attest=next"), NO_FACTS);
  assert.deepEqual(facts("attest=next,later"), NO_FACTS);
});

test("S13: a route whose facts carry later, newkey, provider and constructor meets zdr+bits=8+region=us,de+attest=weights and not notrain, attest=prompt or attest=weights,prompt", () => {
  const route = { provider: "a", facts: facts("zdr+bits=8+region=us,de+attest=weights,later+later+newkey=x,y+provider=p+constructor=x") };
  assert.equal(meets(route, policy("zdr+bits=8+region=us,de+attest=weights")), true);
  assert.equal(meets(route, policy("notrain")), false);
  assert.equal(meets(route, policy("attest=prompt")), false);
  assert.equal(meets(route, policy("attest=weights,prompt")), false);
});

test("S13: facts later read as no fact, and a route with them meets only=a", () => {
  // The unknown key alone leaves the route as one that publishes no fact, which is valid.
  assert.deepEqual(facts("later"), NO_FACTS);
  assert.equal(meets({ provider: "a", facts: facts("later") }, policy("only=a")), true);
});

test("S13: facts carrying only=x, ignore=x, ignore, sort, sort=price, order=x, zdr+order=x or zdr+only=a are invalid, naming the key as not a fact", () => {
  const cases: [text: string, key: string][] = [
    ["only=x", "only"], ["ignore=x", "ignore"], ["ignore", "ignore"], ["sort", "sort"],
    ["sort=price", "sort"], ["order=x", "order"], ["zdr+order=x", "order"], ["zdr+only=a", "only"],
  ];
  for (const [text, key] of cases) assert.deepEqual(parseFacts(text), { ok: false, key, detail: "is not a fact" }, text);
});

test("S13: 16 facts strings that are malformed or give zdr, notrain, bits, region or attest an invalid value are invalid with the failure named", () => {
  const cases: [text: string, key: string | null, detail: string][] = [
    ["zdr=1", "zdr", "takes no value"],
    ["notrain=x", "notrain", "takes no value"],
    ["bits=0", "bits", "takes one integer from 1 to 64"],
    ["bits=65", "bits", "takes one integer from 1 to 64"],
    ["bits", "bits", "takes one integer from 1 to 64"],
    ["bits=8,16", "bits", "takes one integer from 1 to 64"],
    ["region=usa", "region", "takes a list of assigned ISO 3166-1 alpha-2 codes"],
    ["region=ab", "region", "takes a list of assigned ISO 3166-1 alpha-2 codes"],
    ["region", "region", "takes a list of assigned ISO 3166-1 alpha-2 codes"],
    ["attest", "attest", "takes a list"],
    ["zdr+attest", "attest", "takes a list"],
    ["zdr+zdr", "zdr", "repeated key"],
    ["+", null, "malformed key in \"\""],
    ["zdr+", null, "malformed key in \"\""],
    ["Zdr", null, "malformed key in \"Zdr\""],
    ["attest=Weights", "attest", "malformed item \"Weights\""],
  ];
  assert.equal(cases.length, 16);
  for (const [text, key, detail] of cases) assert.deepEqual(parseFacts(text), { ok: false, key, detail }, text);
});

test("S12: parsePublishedFacts accepts the empty string and zdr+notrain+bits=8+region=us+attest=weights,prompt", () => {
  assert.deepEqual(parsePublishedFacts(""), { ok: true, value: NO_FACTS });
  assert.deepEqual(parsePublishedFacts("zdr+notrain+bits=8+region=us+attest=weights,prompt"), {
    ok: true, value: { zdr: true, notrain: true, bits: 8, region: ["us"], attest: ["weights", "prompt"] },
  });
});

test("S12: parsePublishedFacts refuses later, newkey, provider and `only` as not facts, attest=custom and attest=weights,custom as undefined attest values, and region=ab and bits=0 as invalid values", () => {
  const cases: [text: string, key: string, detail: string][] = [
    ["later", "later", "is not a fact"],
    ["zdr+newkey=1", "newkey", "is not a fact"],
    ["provider=a", "provider", "is not a fact"],
    ["attest=custom", "attest", "holds an attest value this revision does not define"],
    ["attest=weights,custom", "attest", "holds an attest value this revision does not define"],
    ["only=a", "only", "is not a fact"],
    ["region=ab", "region", "takes a list of assigned ISO 3166-1 alpha-2 codes"],
    ["bits=0", "bits", "takes one integer from 1 to 64"],
  ];
  for (const [text, key, detail] of cases) assert.deepEqual(parsePublishedFacts(text), { ok: false, key, detail }, text);
});

test("G6: meets gives the tabled result for 32 rows of policy, provider and facts over zdr, notrain, bits, region, attest, only, ignore, preferences and absent facts", () => {
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
  assert.equal(cases.length, 32);
  for (const [p, provider, f, expected] of cases) assert.equal(meets({ provider, facts: facts(f) }, policy(p)), expected, `${p} vs ${provider} [${f}]`);
});

test("G35: over routes a to e, orderRoutes gives bcdae, cabde and acdbe for sort price, latency and throughput; dabce, edcab and edcba for order d,a, e,d,c and e,d,c,b; dbcae, dcabe and dacbe for order=d with the three sorts; cbdae for order=c,nosuch+sort=price; abcde for order=nosuch and zdr; and leaves the input as abcde", () => {
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
  // The third listed provider comes before the unlisted ones.
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

test("S14: formatApplied writes provider=aurora, and parseApplied reads provider=<id> back for aurora, a, 0, data-east, a.b_c, constructor, null and a 32-character id", () => {
  assert.equal(formatApplied("aurora"), "provider=aurora");
  for (const id of ["aurora", "a", "0", "data-east", "a.b_c", "constructor", "null", "a".repeat(32)]) {
    assert.equal(isProviderId(id), true, id);
    assert.deepEqual(parseApplied(formatApplied(id)), { ok: true, value: id });
  }
});

test("S14: parseApplied refuses 19 strings, among them five joinings of two lines or a line and an item, as not beginning with the provider or not exactly one provider id", () => {
  const cases: [text: string, detail: string][] = [
    ["", "does not begin with the provider"],
    ["zdr", "does not begin with the provider"],
    ["xrovider=a", "does not begin with the provider"],
    ["provide=aurora", "does not begin with the provider"],
    ["provider", "does not begin with the provider"],
    ["provider=", "is not exactly one provider id"],
    ["provider=A", "is not exactly one provider id"],
    ["provider=org/a", "is not exactly one provider id"],
    ["provider=a+", "is not exactly one provider id"],
    ["provider=a+zdr", "is not exactly one provider id"],
    ["zdr+provider=a", "does not begin with the provider"],
    [" provider=a", "does not begin with the provider"],
    ["provider=a ", "is not exactly one provider id"],
    [`provider=${"a".repeat(33)}`, "is not exactly one provider id"],
    // Two lines joined, however the joiner writes the comma.
    ["provider=a,provider=b", "is not exactly one provider id"],
    ["provider=a, provider=b", "is not exactly one provider id"],
    ["provider=a,b", "is not exactly one provider id"],
    ["provider=a, b", "is not exactly one provider id"],
    ["provider=a,", "is not exactly one provider id"],
  ];
  assert.equal(cases.length, 19);
  for (const [text, detail] of cases) assert.deepEqual(parseApplied(text), { ok: false, key: "provider", detail }, JSON.stringify(text));
});

test("S18: isEvidenceUri accepts 10 https URIs with lowercase hosts, optional ports, narrow paths and up to 512 bytes", () => {
  const accepted = [
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
  ];
  assert.equal(accepted.length, 10);
  for (const uri of accepted) assert.equal(isEvidenceUri(uri), true, uri);
});

test("S18: isEvidenceUri refuses 43 strings outside the grammar and the non-strings null, undefined, 5, {} and a one-URI array", () => {
  const refused = [
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
  ];
  assert.equal(refused.length, 43);
  for (const uri of refused) assert.equal(isEvidenceUri(uri), false, uri);
  for (const value of [null, undefined, 5, {}, ["https://a.example/x"]]) assert.equal(isEvidenceUri(value), false, String(value));
});

test("S17: isProviderId refuses 8 malformed strings and 6 non-strings, and formatApplied throws a RangeError naming the value for the same 14 values", () => {
  for (const id of ["", "org/provider", "Data-East", "a b", "-a", "a,b", "a+b", "a".repeat(33)]) {
    assert.equal(isProviderId(id), false, id);
    assert.throws(() => formatApplied(id), { name: "RangeError", message: `"${id}" is not a provider id` }, id);
  }
  // A value that is not a string is never coerced into an identifier.
  const untypedApplied = formatApplied as (provider: unknown) => string;
  for (const value of [null, undefined, 5, true, {}, ["aurora"]]) {
    assert.equal(isProviderId(value), false, String(value));
    assert.throws(() => untypedApplied(value), { name: "RangeError", message: `"${String(value)}" is not a provider id` }, String(value));
  }
});

test("S15: formatRefused throws a RangeError for 10 unwritable unsupported keys, 7 values that are not reasons, and the key bits with unavailable or unsatisfiable", () => {
  const untypedRefused = formatRefused as (reason: unknown, key?: unknown) => string;
  for (const key of ["bad key", "Bad", "", "a.b", "k".repeat(17), false, true, 5, {}, ["bits"]]) {
    assert.throws(() => untypedRefused("unsupported", key), { name: "RangeError", message: `cannot name key "${String(key)}" in a "unsupported" refusal` }, String(key));
  }
  for (const reason of ["other", "constructor", "", null, undefined, 5, ["unsupported"]]) {
    assert.throws(() => untypedRefused(reason), { name: "RangeError", message: `"${String(reason)}" is not a refusal reason` }, String(reason));
  }
  assert.throws(() => untypedRefused("unavailable", "bits"), { name: "RangeError", message: "cannot name key \"bits\" in a \"unavailable\" refusal" });
  assert.throws(() => untypedRefused("unsatisfiable", "bits"), { name: "RangeError", message: "cannot name key \"bits\" in a \"unsatisfiable\" refusal" });
});

test("S15: formatRefused writes reason=unsupported+key=bits, reason=unsupported, reason=unsatisfiable and reason=unavailable, which parseRefused reads back with key later, null, null and null", () => {
  assert.equal(formatRefused("unsupported", "bits"), "reason=unsupported+key=bits");
  assert.equal(formatRefused("unsupported"), "reason=unsupported");
  assert.equal(formatRefused("unsatisfiable"), "reason=unsatisfiable");
  assert.equal(formatRefused("unavailable"), "reason=unavailable");
  assert.deepEqual(parseRefused(formatRefused("unsupported", "later")), { ok: true, value: { reason: "unsupported", key: "later" } });
  assert.deepEqual(parseRefused("reason=unsupported"), { ok: true, value: { reason: "unsupported", key: null } });
  assert.deepEqual(parseRefused("reason=unsatisfiable"), { ok: true, value: { reason: "unsatisfiable", key: null } });
  assert.deepEqual(parseRefused("reason=unavailable"), { ok: true, value: { reason: "unavailable", key: null } });
});

test("S15: parseRefused refuses 14 strings as not a Route-Refused value, and reason=unsatisfiable+key=bits and reason=unavailable+key=bits as naming a key without unsupported", () => {
  const malformed = [
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
    " reason=unsupported",
    "reason=unsupported, reason=unsupported",
  ];
  assert.equal(malformed.length, 14);
  for (const text of malformed) assert.deepEqual(parseRefused(text), { ok: false, key: null, detail: "not a Route-Refused value" }, JSON.stringify(text));
  for (const text of ["reason=unsatisfiable+key=bits", "reason=unavailable+key=bits"]) {
    assert.deepEqual(parseRefused(text), { ok: false, key: "key", detail: "a key is named only with \"unsupported\"" }, text);
  }
});

test("C6: a 200 reply {route_policy: \"1\", extra} gives the three lists of baselineSupport() and no key policy, and supports attest=weights,prompt+sort=throughput", () => {
  const minimal = parseDetection({ route_policy: "1", extra: { anything: true } });
  assert.ok(minimal.ok);
  assert.deepEqual(lists(minimal.value.support), lists(baselineSupport()));
  assert.deepEqual(lists(minimal.value.support), {
    keys: ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "sort", "order"],
    attest: ["weights", "prompt"],
    sort: ["price", "latency", "throughput"],
  });
  assert.equal(minimal.value.keyPolicy, null);
  assert.equal(supports(minimal.value.support, policy("attest=weights,prompt+sort=throughput")), true);
});

test("C6: a reply with keys, attest and sort as empty lists grants no key and refuses zdr, while one with empty attest and sort but no keys list keeps the nine baseline keys and supports neither attest=weights nor sort=price", () => {
  const none = parseDetection({ route_policy: "1", keys: [], attest: [], sort: [] });
  assert.ok(none.ok);
  assert.deepEqual(lists(none.value.support), { keys: [], attest: [], sort: [] });
  assert.equal(supports(none.value.support, policy("zdr")), false);
  assert.deepEqual(parsePolicy("zdr", none.value.support), { ok: false, key: "zdr", detail: "key not accepted" });

  const noValues = parseDetection({ route_policy: "1", attest: [], sort: [] });
  assert.ok(noValues.ok);
  assert.deepEqual(lists(noValues.value.support), { keys: [...baselineSupport().keys], attest: [], sort: [] });
  assert.equal(supports(noValues.value.support, policy("attest=weights")), false);
  assert.equal(supports(noValues.value.support, policy("sort=price")), false);
});

test("C6, C12: a reply listing later among keys, attest and sort is valid, gives keys zdr, attest, sort, attest weights and sort price, and keeps the key policy zdr+later=x+sort=later+attest=later as sent though it does not parse under that support", () => {
  const newer = parseDetection({ route_policy: "1", keys: ["zdr", "later", "sort", "attest"], attest: ["weights", "later"], sort: ["price", "later"], key_policy: "zdr+later=x+sort=later+attest=later" });
  assert.ok(newer.ok);
  assert.deepEqual(lists(newer.value.support), { keys: ["zdr", "attest", "sort"], attest: ["weights"], sort: ["price"] });
  assert.equal(supports(newer.value.support, policy("zdr")), true);
  assert.equal(supports(newer.value.support, policy("notrain")), false);
  // The bound policy is kept as sent, to be shown. This client cannot interpret it, and can tell that it cannot.
  assert.equal(newer.value.keyPolicy, "zdr+later=x+sort=later+attest=later");
  assert.deepEqual(parsePolicy(newer.value.keyPolicy, newer.value.support), { ok: false, key: "later", detail: "key not accepted" });
});

test("C6: 31 detection bodies with a non-object, a route_policy other than the string 1, a malformed keys, attest or sort list, or an invalid key_policy are no detection, with the failing member named", () => {
  const sparseKeys: unknown[] = ["zdr"];
  sparseKeys.length = 3;
  const sparseAttest: unknown[] = [];
  sparseAttest.length = 1;
  const notVersion = { key: "route_policy", detail: "is not the string \"1\"" };
  const underLists = (detail: string) => ({ key: "key_policy", detail: `fails the order of checks under the reply's lists: ${detail}` });
  const cases: [body: unknown, failure: { key: string | null; detail: string }][] = [
    [null, { key: null, detail: "not a JSON object" }],
    [[], { key: null, detail: "not a JSON object" }],
    ["text", { key: null, detail: "not a JSON object" }],
    [{}, notVersion],
    [{ route_policy: 1 }, notVersion],
    [{ route_policy: "1.0" }, notVersion],
    [{ route_policy: "2" }, notVersion],
    [{ route_policy: " 1" }, notVersion],
    [{ route_policy: true }, notVersion],
    [{ route_policy: ["1"] }, notVersion],
    [Object.create({ route_policy: "1" }), notVersion],
    [{ route_policy: "1", keys: "zdr" }, { key: "keys", detail: "is not a list of keys" }],
    [{ route_policy: "1", keys: ["bits", "bad key"] }, { key: "keys", detail: "is not a list of keys" }],
    [{ route_policy: "1", keys: ["a.b"] }, { key: "keys", detail: "is not a list of keys" }],
    [{ route_policy: "1", keys: [1] }, { key: "keys", detail: "is not a list of keys" }],
    [{ route_policy: "1", keys: sparseKeys }, { key: "keys", detail: "is not a list of keys" }],
    [{ route_policy: "1", attest: sparseAttest }, { key: "attest", detail: "is not a list of items" }],
    [{ route_policy: "1", sort: [1] }, { key: "sort", detail: "is not a list of items" }],
    [{ route_policy: "1", sort: ["a,b"] }, { key: "sort", detail: "is not a list of items" }],
    [{ route_policy: "1", attest: {} }, { key: "attest", detail: "is not a list of items" }],
    [{ route_policy: "1", attest: ["Weights"] }, { key: "attest", detail: "is not a list of items" }],
    [{ route_policy: "1", key_policy: 5 }, { key: "key_policy", detail: "is not a string" }],
    [{ route_policy: "1", key_policy: "" }, underLists("malformed key in \"\"")],
    [{ route_policy: "1", key_policy: "only=" }, underLists("malformed item \"\"")],
    [{ route_policy: "1", key_policy: "bits=0" }, underLists("takes one integer from 1 to 64")],
    [{ route_policy: "1", keys: [], key_policy: "zdr" }, underLists("key not listed")],
    [{ route_policy: "1", keys: ["zdr"], key_policy: "zdr+notrain" }, underLists("key not listed")],
    [{ route_policy: "1", sort: ["price"], key_policy: "sort=latency" }, underLists("value not accepted")],
    [{ route_policy: "1", attest: ["weights"], key_policy: "attest=prompt" }, underLists("value not accepted")],
    [{ route_policy: "1", key_policy: "region=ab" }, underLists("takes a list of assigned ISO 3166-1 alpha-2 codes")],
    [{ route_policy: "1", key_policy: "later" }, underLists("key not listed")],
  ];
  assert.equal(cases.length, 31);
  for (const [body, failure] of cases) assert.deepEqual(parseDetection(body), { ok: false, ...failure }, JSON.stringify(body));
});

test("C6: route_policy given as the number tokens 1, 1.00000000000000001, 0.99999999999999999 and 1e0 is no detection, naming route_policy", () => {
  // Number tokens that a JSON decoder rounds to 1 are still numbers, so none of them is the version.
  for (const raw of ['{"route_policy":1}', '{"route_policy":1.00000000000000001}', '{"route_policy":0.99999999999999999}', '{"route_policy":1e0}']) {
    const decoded: unknown = JSON.parse(raw);
    assert.deepEqual(parseDetection(decoded), { ok: false, key: "route_policy", detail: "is not the string \"1\"" }, raw);
  }
});

test("S19: a detection body with keys [] then keys [zdr] reads keys zdr, and one with keys [zdr] then keys [] reads no keys", () => {
  // A repeated member reads as its last occurrence, which is what a JSON decoder hands over.
  const lastWins: unknown = JSON.parse('{"route_policy":"1","keys":[],"keys":["zdr"]}');
  const last = parseDetection(lastWins);
  assert.ok(last.ok);
  assert.deepEqual(lists(last.value.support), { keys: ["zdr"], attest: ["weights", "prompt"], sort: ["price", "latency", "throughput"] });
  const lastEmpty: unknown = JSON.parse('{"route_policy":"1","keys":["zdr"],"keys":[]}');
  const empty = parseDetection(lastEmpty);
  assert.ok(empty.ok);
  assert.deepEqual(lists(empty.value.support), { keys: [], attest: ["weights", "prompt"], sort: ["price", "latency", "throughput"] });
});

test("G20, G22: formatDetection for keys zdr, sort, attest, attest prompt, sort latency, price and key policy zdr+sort=latency writes that body, which parseDetection reads back with the same lists and key policy; without a key policy the body has no key_policy", () => {
  const support: Support = { keys: new Set(["zdr", "sort", "attest"]), attest: new Set(["prompt"]), sort: new Set(["latency", "price"]) };
  const body: unknown = JSON.parse(JSON.stringify(formatDetection(support, "zdr+sort=latency")));
  assert.deepEqual(body, { route_policy: "1", keys: ["zdr", "sort", "attest"], attest: ["prompt"], sort: ["latency", "price"], key_policy: "zdr+sort=latency" });
  const parsed = parseDetection(body);
  assert.ok(parsed.ok);
  assert.deepEqual(lists(parsed.value.support), { keys: ["zdr", "attest", "sort"], attest: ["prompt"], sort: ["price", "latency"] });
  assert.equal(parsed.value.keyPolicy, "zdr+sort=latency");
  assert.deepEqual(formatDetection(support), { route_policy: "1", keys: ["zdr", "sort", "attest"], attest: ["prompt"], sort: ["latency", "price"] });
});

test("G22: with keys zdr, sort, attest listed, formatDetection throws a RangeError for the key policies bits=0, the empty string, notrain, sort=throughput, attest=weights, zdr+zdr and later, and the replies it writes for zdr, attest=prompt and sort=price+zdr parse", () => {
  const support: Support = { keys: new Set(["zdr", "sort", "attest"]), attest: new Set(["prompt"]), sort: new Set(["latency", "price"]) };
  const failures: [bound: string, detail: string][] = [
    ["bits=0", "key not accepted"],
    ["", "malformed key in \"\""],
    ["notrain", "key not accepted"],
    ["sort=throughput", "value not accepted"],
    ["attest=weights", "value not accepted"],
    ["zdr+zdr", "repeated key"],
    ["later", "key not accepted"],
  ];
  for (const [bound, detail] of failures) {
    assert.throws(() => formatDetection(support, bound), { name: "RangeError", message: `key policy "${bound}" fails the order of checks: ${detail}` }, bound);
  }
  for (const bound of ["zdr", "attest=prompt", "sort=price+zdr"]) {
    const reply: unknown = JSON.parse(JSON.stringify(formatDetection(support, bound)));
    const parsed = parseDetection(reply);
    assert.ok(parsed.ok, bound);
    assert.equal(parsed.value.keyPolicy, bound);
  }
});

test("G20: formatDetection throws a RangeError naming the list and the entry for six supports listing bad key, later, custom, Weights, a,b or cheapest, with and without a bound policy", () => {
  // It advertises only what this revision defines, with or without a bound policy: nothing else could be honored.
  const base = baselineSupport();
  const unadvertisable: [support: Support, message: string][] = [
    [{ ...base, keys: new Set(["zdr", "bad key"]) }, "keys holds what this revision does not define: bad key"],
    [{ ...base, keys: new Set(["zdr", "later"]) }, "keys holds what this revision does not define: later"],
    [{ ...base, attest: new Set(["weights", "custom"]) }, "attest holds what this revision does not define: custom"],
    [{ ...base, attest: new Set(["Weights"]) }, "attest holds what this revision does not define: Weights"],
    [{ ...base, sort: new Set(["price", "a,b"]) }, "sort holds what this revision does not define: a,b"],
    [{ ...base, sort: new Set(["cheapest"]) }, "sort holds what this revision does not define: cheapest"],
  ];
  for (const [bad, message] of unadvertisable) {
    assert.throws(() => formatDetection(bad), { name: "RangeError", message }, message);
    assert.throws(() => formatDetection(bad, "zdr"), { name: "RangeError", message }, message);
  }
});

test("G20: formatDetection writes empty lists for an empty support, and throws a RangeError for undefined in keys, null in attest and undefined in sort", () => {
  assert.deepEqual(formatDetection({ keys: new Set(), attest: new Set(), sort: new Set() }), { route_policy: "1", keys: [], attest: [], sort: [] });
  // An entry that is not a string at all is refused like a string this revision does not define.
  const untyped = formatDetection as (support: { keys: Set<unknown>; attest: Set<unknown>; sort: Set<unknown> }) => unknown;
  assert.throws(() => untyped({ keys: new Set([undefined, "zdr"]), attest: new Set(), sort: new Set() }), { name: "RangeError", message: "keys holds what this revision does not define: undefined" });
  assert.throws(() => untyped({ keys: new Set(["zdr"]), attest: new Set([null]), sort: new Set() }), { name: "RangeError", message: "attest holds what this revision does not define: null" });
  assert.throws(() => untyped({ keys: new Set(["zdr"]), attest: new Set(), sort: new Set([undefined]) }), { name: "RangeError", message: "sort holds what this revision does not define: undefined" });
});

test("C2: with no detection reply, no policy, sort=latency, and sort=latency with order=a are cleared, and with keys zdr, sort and `only` listed, sort=latency is cleared", () => {
  const support: Support = { keys: new Set(["zdr", "sort", "only"]), attest: new Set(), sort: new Set(["price"]) };
  assert.equal(clearedToSend(null, []), true);
  assert.equal(clearedToSend(null, [policy("sort=latency")]), true);
  assert.equal(clearedToSend(null, [policy("sort=latency"), policy("order=a")]), true);
  assert.equal(clearedToSend(support, [policy("sort=latency")]), true);
});

test("C1: with keys zdr, sort and `only` and sort price listed, zdr, zdr+sort=price, zdr beside sort=price and sort=price beside only=a are cleared, and notrain, zdr+sort=latency, zdr beside sort=latency or order=a, and requirements with no reply are not", () => {
  const support: Support = { keys: new Set(["zdr", "sort", "only"]), attest: new Set(), sort: new Set(["price"]) };
  const p = (text: string): Policy => policy(text);
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
});

test("C1: a header zdr+sort=latency with a suffix sort=price is not cleared, although their combination is supported", () => {
  const support: Support = { keys: new Set(["zdr", "sort", "only"]), attest: new Set(), sort: new Set(["price"]) };
  // Each carrier is checked as sent, not the policy they combine to: the suffix's supported sort would override
  // the header's unsupported one, and the request is still not cleared.
  const header = policy("zdr+sort=latency");
  const suffix = policy("sort=price");
  assert.equal(supports(support, combinePolicies({ header, suffix })), true);
  assert.equal(clearedToSend(support, [header, suffix]), false);
});

test("C4: a routes list of 13 rows reads as eight providers by id, with broken, nofacts and twice unusable, badevidence without evidence, newer as a reader reads it, and the unnamed or malformed rows skipped", () => {
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
  assert.deepEqual(routes, new Map([
    ["aurora", { facts: facts("zdr+notrain+bits=8+region=us"), evidence: null }],
    ["basalt", { facts: facts("bits=16+attest=weights,prompt"), evidence: "https://basalt.example/attestation" }],
    ["cobalt", { facts: facts(""), evidence: null }],
    ["broken", null],
    ["nofacts", null],
    ["twice", null],
    ["badevidence", { facts: facts("attest=weights"), evidence: null }],
    // A row from a gateway on a later revision is read as a client reads facts, not as a gateway publishes them.
    ["newer", { facts: facts("zdr+attest=weights"), evidence: null }],
  ]));
});

test("C4: a provider published three times reads as unusable, and a row whose members are inherited is skipped", () => {
  assert.deepEqual(parseRoutes([{ provider: "p", facts: "zdr" }, { provider: "p", facts: "zdr" }, { provider: "p", facts: "zdr" }]), new Map([["p", null]]));
  assert.deepEqual(parseRoutes([Object.create({ provider: "p", facts: "zdr" })]), new Map());
});

test("C4: routes given as undefined, null, {}, \"routes\", 5 or [] publish no routes", () => {
  for (const none of [undefined, null, {}, "routes", 5, []]) assert.deepEqual(parseRoutes(none), new Map(), String(none));
});

/** The published routes of the C3 and C4 readOutcome tests below, for a policy zdr+region=us. */
const outcomeRoutes = () => parseRoutes([
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
const applied = (lines: string[], refused: string[] = [], evidence: string[] = []) => ({ applied: lines, refused, evidence });

test("C4: for zdr+region=us, provider=aurora and provider=newer, whose facts meet it, are honored and checked against the model list", () => {
  const sent = policy("zdr+region=us");
  assert.deepEqual(readOutcome(applied(["provider=aurora"]), sent, outcomeRoutes()), { outcome: "honored", provider: "aurora", evidence: null, checked: true });
  // A route that also publishes a fact from a later revision is judged on the facts this client knows.
  assert.deepEqual(readOutcome(applied(["provider=newer"]), sent, outcomeRoutes()), { outcome: "honored", provider: "newer", evidence: null, checked: true });
});

test("C3: for zdr+region=us, no Route-Applied, two lines, and three joined or malformed values are not honored for that reason", () => {
  const sent = policy("zdr+region=us");
  const cases: [lines: string[], why: string][] = [
    [[], "no Route-Applied"],
    [["provider=aurora", "provider=basalt"], "more than one Route-Applied"],
    [["provider=aurora", "provider=aurora"], "more than one Route-Applied"],
    [["provider=aurora, provider=aurora"], "Route-Applied is not valid: is not exactly one provider id"],
    [["provider=aurora,provider=aurora"], "Route-Applied is not valid: is not exactly one provider id"],
    [["provider=aurora,aurora"], "Route-Applied is not valid: is not exactly one provider id"],
    [["aurora"], "Route-Applied is not valid: does not begin with the provider"],
    [[""], "Route-Applied is not valid: does not begin with the provider"],
  ];
  for (const [lines, why] of cases) assert.deepEqual(readOutcome(applied(lines), sent, outcomeRoutes()), { outcome: "not-honored", why }, JSON.stringify(lines));
});

test("C4: for zdr+region=us, provider cobalt, delta and echo whose facts miss it, broken and twice that cannot be relied on, and nosuch that is unpublished are not honored for that reason", () => {
  const sent = policy("zdr+region=us");
  const cases: [provider: string, why: string][] = [
    ["cobalt", "route \"cobalt\" does not meet the policy sent"],
    ["delta", "route \"delta\" does not meet the policy sent"],
    ["echo", "route \"echo\" does not meet the policy sent"],
    ["broken", "provider \"broken\" is published more than once or with invalid facts"],
    ["twice", "provider \"twice\" is published more than once or with invalid facts"],
    ["nosuch", "provider \"nosuch\" is not among the model's published routes"],
  ];
  for (const [provider, why] of cases) assert.deepEqual(readOutcome(applied([`provider=${provider}`]), sent, outcomeRoutes()), { outcome: "not-honored", why }, provider);
});

test("C4: provider=aurora is not honored for zdr+bits=16 and is honored for zdr+bits=8", () => {
  // A route that fails the precision requirement and no other.
  assert.deepEqual(readOutcome(applied(["provider=aurora"]), policy("zdr+bits=16"), outcomeRoutes()), { outcome: "not-honored", why: "route \"aurora\" does not meet the policy sent" });
  assert.deepEqual(readOutcome(applied(["provider=aurora"]), policy("zdr+bits=8"), outcomeRoutes()), { outcome: "honored", provider: "aurora", evidence: null, checked: true });
});

test("C3, C4: with the model list, cobalt is honored for only=cobalt, aurora is not honored for only=cobalt or zdr+ignore=aurora, and broken and twice are not honored for only=broken and only=twice", () => {
  assert.deepEqual(readOutcome(applied(["provider=cobalt"]), policy("only=cobalt"), outcomeRoutes()), { outcome: "honored", provider: "cobalt", evidence: null, checked: true });
  assert.deepEqual(readOutcome(applied(["provider=aurora"]), policy("only=cobalt"), outcomeRoutes()), { outcome: "not-honored", why: "route \"aurora\" does not meet the policy sent" });
  assert.deepEqual(readOutcome(applied(["provider=aurora"]), policy("zdr+ignore=aurora"), outcomeRoutes()), { outcome: "not-honored", why: "route \"aurora\" does not meet the policy sent" });
  // Invalid or repeated published facts meet no requirement, a provider-id one included.
  assert.deepEqual(readOutcome(applied(["provider=broken"]), policy("only=broken"), outcomeRoutes()), { outcome: "not-honored", why: "provider \"broken\" is published more than once or with invalid facts" });
  assert.deepEqual(readOutcome(applied(["provider=twice"]), policy("only=twice"), outcomeRoutes()), { outcome: "not-honored", why: "provider \"twice\" is published more than once or with invalid facts" });
});

test("C4: routes given as [], {}, \"not-a-list\" or undefined publish nothing, so provider=aurora is not honored for zdr+region=us or only=aurora", () => {
  // A model list that publishes no routes for the model has been checked, and the provider is not in it.
  for (const unusable of [[], {}, "not-a-list", undefined]) {
    for (const text of ["zdr+region=us", "only=aurora"]) {
      assert.deepEqual(readOutcome(applied(["provider=aurora"]), policy(text), parseRoutes(unusable)), { outcome: "not-honored", why: "provider \"aurora\" is not among the model's published routes" }, `${String(unusable)} ${text}`);
    }
  }
});

test("C3: with no model list, provider=aurora is honored unchecked for zdr+region=us, only=cobalt,aurora and ignore=cobalt,basalt, and not honored for only=cobalt, zdr+ignore=aurora, ignore=cobalt,aurora or two lines", () => {
  // With no model list held, the facts cannot be compared, and the outcome says so. The provider ids still can.
  for (const text of ["zdr+region=us", "only=cobalt,aurora", "ignore=cobalt,basalt"]) {
    assert.deepEqual(readOutcome(applied(["provider=aurora"]), policy(text), null), { outcome: "honored", provider: "aurora", evidence: null, checked: false }, text);
  }
  for (const text of ["only=cobalt", "zdr+ignore=aurora", "ignore=cobalt,aurora"]) {
    assert.deepEqual(readOutcome(applied(["provider=aurora"]), policy(text), null), { outcome: "not-honored", why: "provider \"aurora\" is excluded by the policy sent" }, text);
  }
  assert.deepEqual(readOutcome(applied(["provider=aurora", "provider=aurora"]), policy("zdr+region=us"), null), { outcome: "not-honored", why: "more than one Route-Applied" });
});

test("C5: a Route-Refused value that parses, garbage, two values, and a refusal beside provider=aurora or with an empty value read as refused with the parsed reason and key or none", () => {
  const sent = policy("zdr+region=us");
  // A Route-Refused is a refusal: parsed, unparsed, repeated, or beside a Route-Applied that would otherwise honor.
  assert.deepEqual(readOutcome(applied([], ["reason=unsupported+key=bits"]), sent, outcomeRoutes()), { outcome: "refused", reason: "unsupported", key: "bits" });
  assert.deepEqual(readOutcome(applied([], ["reason=unavailable"]), sent, outcomeRoutes()), { outcome: "refused", reason: "unavailable", key: null });
  assert.deepEqual(readOutcome(applied([], ["garbage"]), sent, outcomeRoutes()), { outcome: "refused", reason: null, key: null });
  assert.deepEqual(readOutcome(applied([], ["reason=unsupported", "reason=unavailable"]), sent, outcomeRoutes()), { outcome: "refused", reason: null, key: null });
  assert.deepEqual(readOutcome(applied(["provider=aurora"], ["reason=unsatisfiable"]), sent, outcomeRoutes()), { outcome: "refused", reason: "unsatisfiable", key: null });
  assert.deepEqual(readOutcome(applied(["provider=aurora"], [""]), sent, outcomeRoutes()), { outcome: "refused", reason: null, key: null });
});

/** The published routes of the attest readOutcome tests below. */
const evidenceUri = "https://basalt.example/attestation";
const attestRoutes = () => parseRoutes([
  { provider: "basalt", facts: "bits=16+region=us,de+attest=weights,prompt", evidence: evidenceUri },
  { provider: "aurora", facts: "zdr+attest=weights", evidence: "https://aurora.example/attestation" },
  { provider: "silent", facts: "attest=weights,prompt" },
]);
const attested = (evidence: string[], provider = "basalt") => ({ applied: [`provider=${provider}`], refused: [], evidence });

test("C3, C4: for attest=weights,prompt, provider=basalt with its published Route-Evidence is honored, checked with the model list and unchecked without", () => {
  const sent = policy("attest=weights,prompt");
  assert.deepEqual(readOutcome(attested([evidenceUri]), sent, attestRoutes()), { outcome: "honored", provider: "basalt", evidence: evidenceUri, checked: true });
  assert.deepEqual(readOutcome(attested([evidenceUri]), sent, null), { outcome: "honored", provider: "basalt", evidence: evidenceUri, checked: false });
});

test("C3: for attest=weights,prompt, no Route-Evidence, two lines, two lines joined in two ways, and eight values that are not evidence URIs are not honored, with or without the model list", () => {
  const sent = policy("attest=weights,prompt");
  const invalid = [[], [evidenceUri, evidenceUri], [`${evidenceUri}, ${evidenceUri}`], [`${evidenceUri},${evidenceUri}`], ["/attestation"], ["not a uri"], [""], ["https://[::1"], ["https://a@b@basalt.example/attestation"], ["https://basalt.example/%GG"], ["http://basalt.example/attestation"], ["HTTPS://basalt.example/attestation"]];
  assert.equal(invalid.length, 12);
  const notHonored = { outcome: "not-honored", why: "attest was required and there is not exactly one valid Route-Evidence" };
  for (const evidence of invalid) {
    assert.deepEqual(readOutcome(attested(evidence), sent, attestRoutes()), notHonored, JSON.stringify(evidence));
    assert.deepEqual(readOutcome(attested(evidence), sent, null), notHonored, JSON.stringify(evidence));
  }
});

test("C4: for attest=weights,prompt, five valid URIs other than the string basalt publishes are not honored with the model list and are honored unchecked without it", () => {
  const sent = policy("attest=weights,prompt");
  // Another host, another path on the same host, or the same place spelled another way.
  for (const other of ["https://elsewhere.example/attestation", "https://basalt.example/other", "https://basalt.example/attestation/", "https://basalt.example:443/attestation", "https://basalt.example/attestation?x=1"]) {
    assert.deepEqual(readOutcome(attested([other]), sent, attestRoutes()), { outcome: "not-honored", why: "Route-Evidence is not the evidence published for \"basalt\"" }, other);
    assert.deepEqual(readOutcome(attested([other]), sent, null), { outcome: "honored", provider: "basalt", evidence: other, checked: false }, other);
  }
});

test("C4: for attest=weights,prompt, silent, which publishes attest facts and no evidence, and aurora, which publishes attest=weights with evidence, are not honored", () => {
  const sent = policy("attest=weights,prompt");
  assert.deepEqual(readOutcome(attested([evidenceUri], "silent"), sent, attestRoutes()), { outcome: "not-honored", why: "Route-Evidence is not the evidence published for \"silent\"" });
  // The evidence pointer does not stand in for the route's published facts.
  assert.deepEqual(readOutcome(attested(["https://aurora.example/attestation"], "aurora"), sent, attestRoutes()), { outcome: "not-honored", why: "route \"aurora\" does not meet the policy sent" });
});

test("C3: for zdr, provider=aurora is honored with no Route-Evidence, and with basalt's Route-Evidence the outcome reports no evidence", () => {
  assert.deepEqual(readOutcome(attested([], "aurora"), policy("zdr"), attestRoutes()), { outcome: "honored", provider: "aurora", evidence: null, checked: true });
  assert.deepEqual(readOutcome(attested([evidenceUri], "aurora"), policy("zdr"), attestRoutes()), { outcome: "honored", provider: "aurora", evidence: null, checked: true });
});

test("baselineSupport returns new sets: after one result's keys, attest and sort are changed, parsePolicy defaults, the next baselineSupport() and a list-less detection reply are unchanged", () => {
  const first = baselineSupport();
  (first.attest as Set<string>).add("custom");
  (first.attest as Set<string>).delete("prompt");
  (first.keys as Set<string>).delete("zdr");
  (first.sort as Set<string>).delete("throughput");
  (first.sort as Set<string>).add("custom");
  assert.deepEqual(parsePolicy("attest=custom"), { ok: false, key: "attest", detail: "value not accepted" });
  assert.deepEqual(parsePolicy("sort=custom"), { ok: false, key: "sort", detail: "value not accepted" });
  assert.deepEqual(policy("zdr"), { ...NO_POLICY, zdr: true });
  assert.deepEqual(policy("attest=prompt"), { ...NO_POLICY, attest: ["prompt"] });
  assert.deepEqual(policy("sort=throughput"), { ...NO_POLICY, sort: "throughput" });
  assert.deepEqual(lists(baselineSupport()), {
    keys: ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "sort", "order"],
    attest: ["weights", "prompt"],
    sort: ["price", "latency", "throughput"],
  });
  // A detection reply that omits a list gets the same untouched defaults.
  const minimal = parseDetection({ route_policy: "1" });
  assert.ok(minimal.ok);
  assert.deepEqual(lists(minimal.value.support), lists(baselineSupport()));
});

test("C6: in 10 detection bodies that give some of keys, attest and sort and omit the rest, clearedToSend shows the omitted lists at their baseline values", () => {
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
  assert.equal(cases.length, 10);
  for (const [body, text, cleared] of cases) {
    const reply = parseDetection({ route_policy: "1", ...body });
    assert.ok(reply.ok, JSON.stringify(body));
    assert.equal(clearedToSend(reply.value.support, [policy(text)]), cleared, `${JSON.stringify(body)} ${text}`);
  }
});

test("S5: six facts strings giving zdr or notrain a value are refused as taking no value by parsePublishedFacts and parseFacts, naming the first such flag", () => {
  const cases: [text: string, key: string][] = [
    ["zdr=no", "zdr"], ["notrain=no", "notrain"], ["zdr=no+notrain=no", "zdr"],
    ["zdr=yes", "zdr"], ["notrain=1+zdr", "notrain"], ["zdr+notrain=0", "notrain"],
  ];
  for (const [text, key] of cases) {
    assert.deepEqual(parsePublishedFacts(text), { ok: false, key, detail: "takes no value" }, text);
    assert.deepEqual(parseFacts(text), { ok: false, key, detail: "takes no value" }, text);
  }
});

test("S15: parseRefused reads unsupported with key a, zone7 and a 16-letter key, and refuses keys 7zone, 7, _a, -a, A, a_b, a-b, a.b, a 17-letter key, a b and a+b", () => {
  for (const key of ["a", "zone7", "a".repeat(16)]) assert.deepEqual(parseRefused(`reason=unsupported+key=${key}`), { ok: true, value: { reason: "unsupported", key } });
  for (const key of ["7zone", "7", "_a", "-a", "A", "a_b", "a-b", "a.b", "a".repeat(17), "a b", "a+b"]) {
    assert.deepEqual(parseRefused(`reason=unsupported+key=${key}`), { ok: false, key: null, detail: "not a Route-Refused value" }, key);
  }
});

/** The published routes of the first C16 tests below. */
const preSendRoutes = () => parseRoutes([
  { provider: "aurora", facts: "zdr+notrain+bits=8+region=us" },
  { provider: "basalt", facts: "bits=16+region=ca" },
  { provider: "broken", facts: "zdr+region=de+bits=0" },
  { provider: "twice", facts: "zdr+region=fr" },
  { provider: "twice", facts: "zdr+region=fr" },
]);

test("C16: over aurora, basalt, broken and twice, someRouteMeets is true for zdr, zdr+region=us, region=ca, bits=16, only=basalt, ignore=aurora and sort=price", () => {
  for (const text of ["zdr", "zdr+region=us", "region=ca", "bits=16", "only=basalt", "ignore=aurora", "sort=price"]) assert.equal(someRouteMeets(preSendRoutes(), policy(text)), true, text);
});

test("C16: over aurora, basalt, broken and twice, someRouteMeets is false for zdr+region=ca, zdr+bits=16, attest=weights, only=nosuch, region=de, region=fr, only=broken, only=twice and region us with ca", () => {
  // The sole route in the wrong country, an unpublished provider, and routes that cannot be relied on.
  for (const text of ["zdr+region=ca", "zdr+bits=16", "attest=weights", "only=nosuch", "region=de", "region=fr", "only=broken", "only=twice"]) {
    assert.equal(someRouteMeets(preSendRoutes(), policy(text)), false, text);
  }
  assert.equal(someRouteMeets(preSendRoutes(), combinePolicies({ header: policy("region=us"), suffix: policy("region=ca") })), false);
});

test("C16: someRouteMeets is false for sort=price over no routes, and refuses a hand-built copy of zdr over the four providers aurora, basalt, broken and twice and over no routes", () => {
  assert.equal(someRouteMeets(parseRoutes([]), policy("sort=price")), false);
  const forged: Policy = { ...policy("zdr") };
  assert.throws(() => someRouteMeets(preSendRoutes(), forged), notAPolicy);
  assert.throws(() => someRouteMeets(parseRoutes([]), forged), notAPolicy);
});

test("G11, G13: notrain from the suffix, header or key, zdr, region=us, only=a and ignore=a from the suffix, bits=16 from the suffix or header, and attest=prompt from the suffix or key survive combining beside layers that state sort or order", () => {
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
  // The preferences left once the carrier's own preference is replaced by the requirement.
  const preferences = { key: { sort: "latency", order: ["x"] }, header: { sort: "latency", order: null }, suffix: { sort: "price", order: ["x"] } };
  for (const [carrier, text, field, expected] of each) {
    // The other two carriers state something else, so the requirement comes from this one alone.
    const others = { key: policy("sort=price"), header: policy("order=x"), suffix: policy("sort=latency") };
    const combined = combinePolicies({ ...others, [carrier]: policy(text) });
    assert.deepEqual(combined, { ...NO_POLICY, ...preferences[carrier], [field]: expected }, `${carrier}: ${text}`);
  }
});

test("G11: zdr from the header and notrain from the suffix combine to both flags, which a zdr route does not meet and a zdr+notrain route meets", () => {
  const both = combinePolicies({ header: policy("zdr"), suffix: policy("notrain") });
  assert.deepEqual(both, { ...NO_POLICY, zdr: true, notrain: true });
  assert.equal(meets({ provider: "a", facts: facts("zdr") }, both), false);
  assert.equal(meets({ provider: "a", facts: facts("zdr+notrain") }, both), true);
});

test("G6: a route in it,fr meets region=it,fr; routes in it,fr,de, de,it,fr and it,fr,de,es do not meet region=it,fr or it,fr,de; and it,fr,de,es meets region=es,de,fr,it", () => {
  const route = (text: string) => ({ provider: "a", facts: facts(text) });
  assert.equal(meets(route("region=it,fr"), policy("region=it,fr")), true);
  assert.equal(meets(route("region=it,fr,de"), policy("region=it,fr")), false);
  assert.equal(meets(route("region=de,it,fr"), policy("region=it,fr")), false);
  assert.equal(meets(route("region=it,fr,de,es"), policy("region=it,fr,de")), false);
  assert.equal(meets(route("region=it,fr,de,es"), policy("region=es,de,fr,it")), true);
});

test("S18: isEvidenceUri accepts ports 1, 443, 8443, 44300 and 65535, and refuses 0, 00, 0443, 65536, 99999, 100000, -1 and an empty port", () => {
  for (const port of ["1", "443", "8443", "44300", "65535"]) assert.equal(isEvidenceUri(`https://basalt.example:${port}/a`), true, port);
  for (const port of ["0", "00", "0443", "65536", "99999", "100000", "-1", ""]) assert.equal(isEvidenceUri(`https://basalt.example:${port}/a`), false, port);
});

test("C3: with no Route-Evidence, attest=prompt, attest=weights, attest=weights,prompt and zdr+attest=prompt are not honored with or without the model list, while only=basalt is honored", () => {
  const routes = parseRoutes([{ provider: "basalt", facts: "attest=weights,prompt", evidence: evidenceUri }]);
  const notHonored = { outcome: "not-honored", why: "attest was required and there is not exactly one valid Route-Evidence" };
  for (const text of ["attest=prompt", "attest=weights", "attest=weights,prompt", "zdr+attest=prompt"]) {
    assert.deepEqual(readOutcome(attested([]), policy(text), null), notHonored, text);
    assert.deepEqual(readOutcome(attested([]), policy(text), routes), notHonored, text);
  }
  assert.deepEqual(readOutcome(attested([]), policy("only=basalt"), routes), { outcome: "honored", provider: "basalt", evidence: null, checked: true });
});

test("C3: with basalt's Route-Evidence, attest=prompt is honored with the model list and attest=weights without it", () => {
  const routes = parseRoutes([{ provider: "basalt", facts: "attest=weights,prompt", evidence: evidenceUri }]);
  assert.deepEqual(readOutcome(attested([evidenceUri]), policy("attest=prompt"), routes), { outcome: "honored", provider: "basalt", evidence: evidenceUri, checked: true });
  assert.deepEqual(readOutcome(attested([evidenceUri]), policy("attest=weights"), null), { outcome: "honored", provider: "basalt", evidence: evidenceUri, checked: false });
});

test("C3: region it with region jp, and only=p with only=q, are not honored for provider p with or without the model list, though region=it,jp and only=p alone are honored, and a refusal of the region pair reads as refused", () => {
  const routes = parseRoutes([{ provider: "p", facts: "zdr+region=it,jp" }]);
  const response = { applied: ["provider=p"], refused: [], evidence: [] };
  const region = combinePolicies({ header: policy("region=it"), suffix: policy("region=jp") });
  const only = combinePolicies({ header: policy("only=p"), suffix: policy("only=q") });
  const empty = { outcome: "not-honored", why: "the policies sent combine to one no route can meet" };
  assert.deepEqual(readOutcome(response, region, null), empty);
  assert.deepEqual(readOutcome(response, region, routes), empty);
  assert.deepEqual(readOutcome(response, only, null), { outcome: "not-honored", why: "provider \"p\" is excluded by the policy sent" });
  assert.deepEqual(readOutcome(response, only, routes), { outcome: "not-honored", why: "route \"p\" does not meet the policy sent" });
  // Each carrier alone is honored by the same response, so it is the combination that decides.
  assert.deepEqual(readOutcome(response, policy("only=p"), null), { outcome: "honored", provider: "p", evidence: null, checked: false });
  assert.deepEqual(readOutcome(response, policy("region=it,jp"), routes), { outcome: "honored", provider: "p", evidence: null, checked: true });
  assert.deepEqual(readOutcome({ ...response, refused: ["reason=unsatisfiable"] }, region, null), { outcome: "refused", reason: "unsatisfiable", key: null });
});

test("C6: the body {route_policy: \"1\", key_policy: \"zdr\"} is a detection with key policy zdr for a credentialed request and no detection, naming key_policy, for an anonymous one; without key_policy the anonymous reply is a detection with baseline lists", () => {
  const body = { route_policy: "1", key_policy: "zdr" };
  const withCredentials = readDetection({ status: 200, body, credentialed: true });
  assert.ok(withCredentials.ok);
  assert.equal(withCredentials.value.keyPolicy, "zdr");
  assert.deepEqual(readDetection({ status: 200, body, credentialed: false }), { ok: false, key: "key_policy", detail: "is present in a reply to a request without credentials" });
  // Without the member, an anonymous reply is as valid as a credentialed one.
  const plain = readDetection({ status: 200, body: { route_policy: "1" }, credentialed: false });
  assert.ok(plain.ok);
  assert.equal(plain.value.keyPolicy, null);
  assert.deepEqual(lists(plain.value.support), lists(baselineSupport()));
  assert.equal(clearedToSend(plain.value.support, [policy("zdr")]), true);
});

test("C6: {route_policy: \"1\"} is a detection at status 200 and no detection, naming no member, at statuses 201, 204, 206, 301, 304, 400, 401, 403, 404, 500, 503, 0, 2000 and NaN, with and without credentials", () => {
  const body = { route_policy: "1" };
  for (const credentialed of [true, false]) {
    assert.equal(readDetection({ status: 200, body, credentialed }).ok, true);
    for (const status of [201, 204, 206, 301, 304, 400, 401, 403, 404, 500, 503, 0, 2000, Number.NaN]) {
      assert.deepEqual(readDetection({ status, body, credentialed }), { ok: false, key: null, detail: `status is ${status}, not 200` }, String(status));
    }
  }
});

test("C4: in a list with m, the alias m+zdr and n, the requests m, m+zdr, m+zdr+sort=price and m+ read m's routes, and n and n+sort=price read n's", () => {
  const list = {
    data: [
      { id: "m", routes: [{ provider: "p", facts: "zdr" }] },
      { id: "m+zdr", routes: [{ provider: "p", facts: "notrain" }] },
      { id: "n", routes: [{ provider: "p", facts: "notrain" }] },
    ],
  };
  const response = { applied: ["provider=p"], refused: [], evidence: [] };
  for (const requested of ["m", "m+zdr", "m+zdr+sort=price", "m+"]) {
    assert.deepEqual(publishedRoutes(list, requested), new Map([["p", { facts: facts("zdr"), evidence: null }]]), requested);
    assert.deepEqual(readOutcome(response, policy("zdr"), publishedRoutes(list, requested)), { outcome: "honored", provider: "p", evidence: null, checked: true }, requested);
    assert.deepEqual(readOutcome(response, policy("notrain"), publishedRoutes(list, requested)), { outcome: "not-honored", why: "route \"p\" does not meet the policy sent" }, requested);
  }
  // The same provider under another model has that model's facts, wherever the model stands in the list.
  assert.deepEqual(publishedRoutes(list, "n"), new Map([["p", { facts: facts("notrain"), evidence: null }]]));
  assert.deepEqual(readOutcome(response, policy("zdr"), publishedRoutes(list, "n")), { outcome: "not-honored", why: "route \"p\" does not meet the policy sent" });
  assert.deepEqual(readOutcome(response, policy("notrain"), publishedRoutes(list, "n+sort=price")), { outcome: "honored", provider: "p", evidence: null, checked: true });
});

test("C4: a list holding the alias m+zdr and no entry m publishes no routes for m+zdr", () => {
  assert.deepEqual(publishedRoutes({ data: [{ id: "m+zdr", routes: [{ provider: "p", facts: "zdr" }] }] }, "m+zdr"), new Map());
});

test("C4: beside m's entry, six lists holding null, strings, numbers, arrays, an entry with routes 7, two twin entries, an entry with no id and one with an array id leave p honored for zdr", () => {
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
    assert.deepEqual(readOutcome(response, policy("zdr"), publishedRoutes({ data }, "m")), { outcome: "honored", provider: "p", evidence: null, checked: true }, JSON.stringify(data));
  }
});

test("S19: a model list repeating data, id, routes, provider and facts reads the last occurrence of the five, giving p with zdr, and a detection body repeating route_policy and sort reads route_policy 1 and no sort", () => {
  const list: unknown = JSON.parse('{"data":[],"data":[{"id":"x","id":"m","routes":[],"routes":[{"provider":"q","provider":"p","facts":"notrain","facts":"zdr"}]}]}');
  assert.deepEqual(publishedRoutes(list, "m"), new Map([["p", { facts: facts("zdr"), evidence: null }]]));
  const reply: unknown = JSON.parse('{"route_policy":"2","route_policy":"1","sort":["price"],"sort":[]}');
  const detection = parseDetection(reply);
  assert.ok(detection.ok);
  assert.deepEqual(lists(detection.value.support), { keys: [...baselineSupport().keys], attest: ["weights", "prompt"], sort: [] });
});

test("G35: over routes a, b, c priced 3, 1, 2, order=c,b,a with or without sort=price gives cba, order=a,c+sort=price gives acb, and sort=price gives bca", () => {
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

test("C5: readRefusal is null with no Route-Refused, reads reason and key from a parsing value, and gives a null reason and key for nonsense, an empty value and two values", () => {
  const headers = (refused: string[]) => ({ applied: ["provider=aurora"], refused, evidence: [] });
  assert.equal(readRefusal(headers([])), null);
  assert.deepEqual(readRefusal(headers(["reason=unsupported+key=tier"])), { reason: "unsupported", key: "tier" });
  assert.deepEqual(readRefusal(headers(["reason=unsatisfiable"])), { reason: "unsatisfiable", key: null });
  assert.deepEqual(readRefusal(headers(["nonsense"])), { reason: null, key: null });
  assert.deepEqual(readRefusal(headers([""])), { reason: null, key: null });
  assert.deepEqual(readRefusal(headers(["reason=unsatisfiable", "reason=unsatisfiable"])), { reason: null, key: null });
});

test("C5: for attest=weights,prompt, reason=unsatisfiable with no evidence reads as refused with and without a model list, and garbage beside provider=p as refused with no reason", () => {
  const sent = policy("attest=weights,prompt");
  const refusal = { applied: [], refused: ["reason=unsatisfiable"], evidence: [] };
  assert.deepEqual(readOutcome(refusal, sent, null), { outcome: "refused", reason: "unsatisfiable", key: null });
  assert.deepEqual(readOutcome(refusal, sent, publishedRoutes({ data: [] }, "m")), { outcome: "refused", reason: "unsatisfiable", key: null });
  assert.deepEqual(readOutcome({ applied: ["provider=p"], refused: ["garbage"], evidence: [] }, sent, null), { outcome: "refused", reason: null, key: null });
});

test("C4: m's routes are read beside another model before or after it, and 15 lists that repeat m, lack it, misshape it or are not lists publish nothing for m, so p is not honored", () => {
  const rows = [{ provider: "p", facts: "zdr" }];
  const published = new Map([["p", { facts: facts("zdr"), evidence: null }]]);
  assert.deepEqual(publishedRoutes({ data: [{ id: "m", routes: rows }, { id: "other", routes: [{ provider: "q", facts: "" }] }] }, "m"), published);
  assert.deepEqual(publishedRoutes({ object: "list", data: [{ id: "other", routes: rows }, { id: "m", routes: rows }] }, "m"), published);

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
  assert.equal(none.length, 15);
  const response = { applied: ["provider=p"], refused: [], evidence: [] };
  for (const [list, name] of none) {
    assert.deepEqual(publishedRoutes(list, "m"), new Map(), name);
    assert.deepEqual(readOutcome(response, policy("zdr"), publishedRoutes(list, "m")), { outcome: "not-honored", why: "provider \"p\" is not among the model's published routes" }, name);
  }
  assert.deepEqual(readOutcome(response, policy("zdr"), publishedRoutes({ data: [{ id: "m", routes: rows }] }, "m")), { outcome: "honored", provider: "p", evidence: null, checked: true });
});

test("G1, G3, G5: REFUSAL_STATUS is frozen and maps unsupported and unsatisfiable to 400 and unavailable to 503", () => {
  assert.deepEqual({ ...REFUSAL_STATUS }, { unsupported: 400, unsatisfiable: 400, unavailable: 503 });
  assert.ok(Object.isFrozen(REFUSAL_STATUS));
});

test("S3, S13: facts repeating the unknown key extended, zdr, or attest read as a repeated key naming it, extended=a,a as a repeated item, and parsePublishedFacts refuses the four, extended as not a fact", () => {
  const cases: [facts: string, key: string, published: string][] = [
    ["extended=2+extended=4+zdr", "extended", "is not a fact"],
    ["zdr+extended+extended", "extended", "is not a fact"],
    ["zdr+zdr", "zdr", "repeated key"],
    ["attest=weights+attest=prompt", "attest", "repeated key"],
  ];
  for (const [text, key, published] of cases) {
    assert.deepEqual(parseFacts(text), { ok: false, key, detail: "repeated key" }, text);
    assert.deepEqual(parsePublishedFacts(text), { ok: false, key, detail: published }, text);
  }
  // A repeated item in a key the reader does not know is malformed too.
  assert.deepEqual(parseFacts("extended=a,a"), { ok: false, key: "extended", detail: "repeated item" });
});

test("C10: a key only= and a suffix ignore= of 15 32-byte items, which format alone, combine past 512 bytes and fail to format, naming no key", () => {
  const list = (prefix: string): string[] => Array.from({ length: 15 }, (_, i) => `${prefix}${String(i).padStart(2, "0")}`.padEnd(32, "x"));
  const key = policy(`only=${list("a").join(",")}`);
  const suffix = policy(`ignore=${list("b").join(",")}`);
  assert.deepEqual(formatPolicy(key), { ok: true, value: `only=${list("a").join(",")}` });
  assert.deepEqual(formatPolicy(suffix), { ok: true, value: `ignore=${list("b").join(",")}` });
  const combined = combinePolicies({ key, suffix });
  // Both lists are within their limit; the whole string is too long.
  assert.deepEqual(combined, { ...NO_POLICY, only: list("a"), ignore: list("b") });
  assert.deepEqual(formatPolicy(combined), { ok: false, key: null, detail: "longer than 512 bytes" });
});

test("C4: for a list whose one entry has the empty id, the requests \"\", +zdr and + publish no routes, so p is not honored", () => {
  const list = { data: [{ id: "", routes: [{ provider: "p", facts: "zdr" }] }] };
  for (const requested of ["", "+zdr", "+"]) {
    assert.deepEqual(publishedRoutes(list, requested), new Map(), requested);
    assert.deepEqual(readOutcome({ applied: ["provider=p"], refused: [], evidence: [] }, policy("zdr"), publishedRoutes(list, requested)), { outcome: "not-honored", why: "provider \"p\" is not among the model's published routes" }, requested);
  }
});

test("S18: hosts proof.example, 1.example, 123.a1, a.b.c1, x1, 1x, a-1 and xn--1ca are accepted, and proof.123, 127.0.0.1, 1, 123, a.b.0 and 192.168.1.1, whose last label is digits, are refused with a path, without one and with a port", () => {
  for (const host of ["proof.example", "1.example", "123.a1", "a.b.c1", "x1", "1x", "a-1", "xn--1ca"]) assert.equal(isEvidenceUri(`https://${host}/report`), true, host);
  for (const host of ["proof.123", "127.0.0.1", "1", "123", "a.b.0", "192.168.1.1"]) {
    assert.equal(isEvidenceUri(`https://${host}/report`), false, host);
    assert.equal(isEvidenceUri(`https://${host}`), false, host);
    assert.equal(isEvidenceUri(`https://${host}:8443/report`), false, host);
  }
});

test("C16: over broken, twice, cobalt and aurora, someRouteMeets is true for zdr and zdr+only=aurora and false for zdr+ignore=aurora", () => {
  // Routes that cannot be relied on come first; the one that meets zdr comes last.
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
});

test("C16: for only=cobalt, someRouteMeets visits broken, twice and cobalt and stops before aurora", () => {
  const routes = parseRoutes([
    { provider: "broken", facts: "zdr+bits=0" },
    { provider: "twice", facts: "zdr" },
    { provider: "twice", facts: "zdr" },
    { provider: "cobalt", facts: "" },
    { provider: "aurora", facts: "zdr" },
  ]);
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

test("C16: basalt with attest facts meets attest=prompt, attest=weights,prompt and attest=weights+only=basalt when it publishes a valid evidence URI and not when it publishes none or an invalid one, and meets only=basalt in the three cases", () => {
  const withEvidence = parseRoutes([{ provider: "basalt", facts: "attest=weights,prompt", evidence: evidenceUri }]);
  const without = parseRoutes([{ provider: "basalt", facts: "attest=weights,prompt" }]);
  const badUri = parseRoutes([{ provider: "basalt", facts: "attest=weights,prompt", evidence: "bad URI" }]);
  for (const text of ["attest=prompt", "attest=weights,prompt", "attest=weights+only=basalt"]) {
    assert.equal(someRouteMeets(withEvidence, policy(text)), true, text);
    assert.equal(someRouteMeets(without, policy(text)), false, text);
    assert.equal(someRouteMeets(badUri, policy(text)), false, text);
  }
  // Without attest in the policy, evidence plays no part.
  for (const routes of [withEvidence, without, badUri]) assert.equal(someRouteMeets(routes, policy("only=basalt")), true);
});

test("C4, C16: a response from basalt with its evidence for attest=prompt is honored with the evidence-publishing list and not honored with the lists that publish none or an invalid URI", () => {
  const response = { applied: ["provider=basalt"], refused: [], evidence: [evidenceUri] };
  // What the pre-send check admits, the outcome can confirm; what it turns away, no response could have confirmed.
  assert.deepEqual(readOutcome(response, policy("attest=prompt"), parseRoutes([{ provider: "basalt", facts: "attest=weights,prompt", evidence: evidenceUri }])), { outcome: "honored", provider: "basalt", evidence: evidenceUri, checked: true });
  for (const row of [{ provider: "basalt", facts: "attest=weights,prompt" }, { provider: "basalt", facts: "attest=weights,prompt", evidence: "bad URI" }]) {
    assert.deepEqual(readOutcome(response, policy("attest=prompt"), parseRoutes([row])), { outcome: "not-honored", why: "Route-Evidence is not the evidence published for \"basalt\"" }, JSON.stringify(row));
  }
});

test("C16: routes slow and other meet a header zdr, not zdr combined with a bound key policy only=slow, and meet the bound policy alone; a bound later=slow under keys zdr and later does not parse", () => {
  const routes = parseRoutes([
    { provider: "slow", facts: "" },
    { provider: "other", facts: "zdr" },
  ]);
  const header = policy("zdr");
  assert.equal(someRouteMeets(routes, header), true);
  // The key binds only=slow, and slow does not publish zdr: no route meets both.
  const reply = parseDetection({ route_policy: "1", key_policy: "only=slow" });
  assert.ok(reply.ok);
  assert.equal(reply.value.keyPolicy, "only=slow");
  const bound = policy(reply.value.keyPolicy ?? "", reply.value.support);
  assert.equal(someRouteMeets(routes, combinePolicies({ key: bound, header })), false);
  assert.equal(someRouteMeets(routes, combinePolicies({ key: bound })), true);
  // A bound policy from a later revision cannot be interpreted, so it plays no part.
  const newer = parseDetection({ route_policy: "1", keys: ["zdr", "later"], key_policy: "later=slow" });
  assert.ok(newer.ok);
  assert.deepEqual(parsePolicy(newer.value.keyPolicy ?? "", newer.value.support), { ok: false, key: "later", detail: "key not accepted" });
});

test("C6: key policies zdr+zdr, only=a+only=b, only=a,a, sort=price+sort=price and zdr+notrain+zdr make the reply no detection, naming key_policy, and zdr+notrain is a detection", () => {
  const cases: [bound: string, detail: string][] = [
    ["zdr+zdr", "repeated key"], ["only=a+only=b", "repeated key"], ["only=a,a", "repeated item"],
    ["sort=price+sort=price", "repeated key"], ["zdr+notrain+zdr", "repeated key"],
  ];
  for (const [bound, detail] of cases) {
    assert.deepEqual(parseDetection({ route_policy: "1", key_policy: bound }), { ok: false, key: "key_policy", detail: `fails the order of checks under the reply's lists: ${detail}` }, bound);
  }
  const plain = parseDetection({ route_policy: "1", key_policy: "zdr+notrain" });
  assert.ok(plain.ok);
  assert.equal(plain.value.keyPolicy, "zdr+notrain");
});

test("S1: fitsPolicyGrammar passes zdr and zdr+bits=8, and later, later=x,y+zdr, bits=999, zdr=yes, sort=unknown and region=zz, which parsePolicy refuses", () => {
  for (const text of ["zdr", "zdr+bits=8"]) assert.deepEqual(fitsPolicyGrammar(text), { ok: true, value: true }, text);
  for (const text of ["later", "later=x,y+zdr", "bits=999", "zdr=yes", "sort=unknown", "region=zz"]) {
    assert.deepEqual(fitsPolicyGrammar(text), { ok: true, value: true }, text);
    assert.equal(parsePolicy(text).ok, false, text);
  }
});

test("S1, S2, S3: fitsPolicyGrammar refuses \"\", zdr+ and ZDR as malformed keys and only= and only=a b as malformed items (S1), only= with a 33-character item (S2), and zdr+zdr and only=a,a as repeated (S3)", () => {
  const cases: [text: string, key: string | null, detail: string][] = [
    ["", null, "malformed key in \"\""],
    ["zdr+", null, "malformed key in \"\""],
    ["ZDR", null, "malformed key in \"ZDR\""],
    ["zdr+zdr", "zdr", "repeated key"],
    ["only=a,a", "only", "repeated item"],
    ["only=", "only", "malformed item \"\""],
    ["only=a b", "only", "malformed item \"a b\""],
    [`only=${"a".repeat(33)}`, "only", `malformed item "${"a".repeat(33)}"`],
  ];
  for (const [text, key, detail] of cases) assert.deepEqual(fitsPolicyGrammar(text), { ok: false, key, detail }, text);
});

test("S4: fitsPolicyGrammar refuses 16 pairs of 527 bytes as longer than 512 bytes and 17 short pairs as more than 16 pairs, naming no key, and passes 15 long pairs and 16 short ones", () => {
  const pairs = (count: number, value: string) => Array.from({ length: count }, (_, i) => `k${String(i).padStart(2, "0")}=${value}`).join("+");
  assert.equal(new TextEncoder().encode(pairs(16, "x".repeat(28))).length, 527);
  assert.deepEqual(fitsPolicyGrammar(pairs(16, "x".repeat(28))), { ok: false, key: null, detail: "longer than 512 bytes" });
  assert.deepEqual(fitsPolicyGrammar(pairs(15, "x".repeat(28))), { ok: true, value: true });
  assert.deepEqual(fitsPolicyGrammar(pairs(17, "x")), { ok: false, key: null, detail: "more than 16 pairs" });
  assert.deepEqual(fitsPolicyGrammar(pairs(16, "x")), { ok: true, value: true });
});

test("S9: providerAllowed and meets agree on six cases of `only` and `ignore`: aurora passes zdr+bits=8, only=aurora,basalt and ignore=cobalt, cobalt fails only=aurora,basalt and ignore=cobalt, and aurora fails only=aurora+ignore=aurora", () => {
  const cases: [string, string, boolean][] = [
    ["zdr+bits=8", "aurora", true],
    ["only=aurora,basalt", "aurora", true],
    ["only=aurora,basalt", "cobalt", false],
    ["ignore=cobalt", "cobalt", false],
    ["ignore=cobalt", "aurora", true],
    ["only=aurora+ignore=aurora", "aurora", false],
  ];
  for (const [text, provider, expected] of cases) {
    const sent = policy(text);
    assert.equal(providerAllowed(provider, sent), expected, `${text} ${provider}`);
    assert.equal(meets({ provider, facts: facts("zdr+notrain+bits=16") }, sent), expected, `meets ${text} ${provider}`);
  }
});

test("a hand-built policy is refused as not made by the parser as the key, header or suffix of a three-layer combination, as the first, second or third of three listed policies with no detection reply or the baseline, and by providerAllowed and someRouteMeets; hand-built facts are refused as the second of two routes", () => {
  const made = policy("zdr+only=a");
  const read = facts("zdr");
  const forged: Policy = { ...made };
  const forgedFacts: Facts = { ...read };

  for (const layer of ["key", "header", "suffix"] as const) {
    assert.throws(() => combinePolicies({ key: made, header: made, suffix: made, [layer]: forged }), notAPolicy, layer);
  }
  // With no reply, clearedToSend decides from the first policy alone, so the check on the later ones is the library's.
  for (const support of [null, baselineSupport()]) {
    for (const position of [0, 1, 2]) {
      const listed = [made, made, made];
      listed[position] = forged;
      assert.throws(() => clearedToSend(support, listed), notAPolicy, `${support === null ? "no reply" : "baseline"}, position ${position}`);
    }
  }
  // A look-alike has the fields the real one has, so the library's own check is what refuses it.
  assert.throws(() => providerAllowed("a", forged), notAPolicy);
  assert.throws(() => providerAllowed("a", {} as never), notAPolicy);
  assert.equal(providerAllowed("a", made), true);

  const routes = parseRoutes([{ provider: "a", facts: "zdr" }]);
  assert.equal(someRouteMeets(routes, made), true);
  assert.throws(() => someRouteMeets(routes, forged), notAPolicy);
  // The first route is real and does not meet the policy, so the look-alike is reached as the second.
  const two = parseRoutes([{ provider: "b", facts: "zdr" }, { provider: "a", facts: "zdr" }]);
  assert.equal(someRouteMeets(two, made), true);
  two.set("a", { facts: forgedFacts, evidence: null });
  assert.deepEqual([...two.keys()], ["b", "a"]);
  assert.throws(() => someRouteMeets(two, made), notFacts);
  assert.throws(() => readOutcome({ applied: ["provider=a"], refused: [], evidence: [] }, made, two), notFacts);
});

test("G11, G13: for the key, header and suffix, the seven requirements zdr, notrain, bits=16, region=us, only=a, ignore=a and attest=prompt stated by that carrier alone survive combining with sort or order policies in the other two", () => {
  const requirements: [text: string, field: keyof Policy, expected: unknown][] = [
    ["zdr", "zdr", true],
    ["notrain", "notrain", true],
    ["bits=16", "bits", 16],
    ["region=us", "region", ["us"]],
    ["only=a", "only", ["a"]],
    ["ignore=a", "ignore", ["a"]],
    ["attest=prompt", "attest", ["prompt"]],
  ];
  assert.deepEqual(requirements.map(([, field]) => field).sort(), [...baselineSupport().keys].filter((key) => key !== "sort" && key !== "order").sort());
  // The preferences left once the carrier's own preference is replaced by the requirement.
  const preferences = { key: { sort: "latency", order: ["x"] }, header: { sort: "latency", order: null }, suffix: { sort: "price", order: ["x"] } };
  for (const carrier of ["key", "header", "suffix"] as const) {
    for (const [text, field, expected] of requirements) {
      // The other two carriers state preferences, so the requirement comes from this carrier alone.
      const others = { key: policy("sort=price"), header: policy("order=x"), suffix: policy("sort=latency") };
      const combined = combinePolicies({ ...others, [carrier]: policy(text) });
      assert.deepEqual(combined, { ...NO_POLICY, ...preferences[carrier], [field]: expected }, `${carrier}: ${text}`);
    }
  }
});

test("G13: for the six ordered pairs of key, header and suffix, the strong policy zdr+notrain+bits=16+region=us+attest=weights+only=a+ignore=b in one keeps those values when the other states sort=price, bits=1, region=us,de,fr, only=a,b,c, attest=prompt or ignore=c", () => {
  const strong = "zdr+notrain+bits=16+region=us+attest=weights+only=a+ignore=b";
  const kept = { zdr: true, notrain: true, bits: 16, region: ["us"], attest: ["weights"], only: ["a"], ignore: ["b"], sort: null, order: null };
  const carriers = ["key", "header", "suffix"] as const;
  // The more specific layer's union items come first: suffix, then header, then key.
  const expected = (text: string, otherFirst: boolean): object => ({
    "sort=price": { ...kept, sort: "price" },
    "bits=1": kept,
    "region=us,de,fr": kept,
    "only=a,b,c": kept,
    "attest=prompt": { ...kept, attest: otherFirst ? ["prompt", "weights"] : ["weights", "prompt"] },
    "ignore=c": { ...kept, ignore: otherFirst ? ["c", "b"] : ["b", "c"] },
  })[text]!;
  let pairs = 0;
  for (const owner of carriers) {
    for (const other of carriers) {
      if (other === owner) continue;
      pairs++;
      const otherFirst = carriers.indexOf(other) > carriers.indexOf(owner);
      for (const text of ["sort=price", "bits=1", "region=us,de,fr", "only=a,b,c", "attest=prompt", "ignore=c"]) {
        const value = combinePolicies({ [owner]: policy(strong), [other]: policy(text) });
        assert.deepEqual(value, expected(text, otherFirst), `${owner} holds it, ${other} states ${text}`);
      }
    }
  }
  assert.equal(pairs, 6);
});
