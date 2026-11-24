// Every test here is one table row: a function of the core library, its inputs, and its complete expected result
// written as a literal (see table.ts). The bracketed ids in a title are the requirements (REQUIREMENTS.md) whose
// breaking, by a mutation of the source that breaks exactly that rule, makes that row fail.

import { createHash } from "node:crypto";
import { COUNTRIES } from "../src/countries.ts";
import {
  LIMITS,
  REFUSAL_STATUS,
  baselineSupport,
  clearedToSend,
  combinePolicies,
  fitsPolicyGrammar,
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
  parseDetection,
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
  type Policy,
  type PublishedRoute,
  type Support,
} from "../src/index.ts";
import { Code, show, showMembers, table, throws } from "./table.ts";

// ---- Literal builders: each writes out an expected value, and none calls the library. ----

const ok = (value: unknown) => ({ ok: true, value });
const no = (key: string | null, detail: string) => ({ ok: false, key, detail });

/** A policy's fields, written as those that differ from a policy that states nothing. */
const P = (fields: Record<string, unknown> = {}) => ({ zdr: false, notrain: false, bits: null, region: null, attest: [], only: null, ignore: [], sort: null, order: null, ...fields });
/** Facts' fields, written as those that differ from facts that state nothing. */
const F = (fields: Record<string, unknown> = {}) => ({ zdr: false, notrain: false, bits: null, region: null, attest: [], ...fields });

/** The three lists of a Support as plain data. */
const lists = (keys: string[], attest: string[], sort: string[]) => ({ keys, attest, sort });
const BASELINE_LISTS = lists(["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "sort", "order"], ["weights", "prompt"], ["price", "latency", "throughput"]);

const honored = (provider: string, evidence: string | null, checked: boolean) => ({ outcome: "honored", provider, evidence, checked });
const notHonored = (why: string) => ({ outcome: "not-honored", why });
const refused = (reason: string | null, key: string | null) => ({ outcome: "refused", reason, key });
const missesPolicy = (provider: string) => notHonored(`route "${provider}" does not meet the policy sent`);
const unpublished = (provider: string) => notHonored(`provider "${provider}" is not among the model's published routes`);
const unusable = (provider: string) => notHonored(`provider "${provider}" is published more than once or with invalid facts`);
const otherEvidence = (provider: string) => notHonored(`Route-Evidence is not the evidence published for "${provider}"`);
const excluded = (provider: string) => notHonored(`provider "${provider}" is excluded by the policy sent`);
const NO_EVIDENCE = notHonored("attest was required and there is not exactly one valid Route-Evidence");
const EMPTY_COMBINATION = notHonored("the policies sent combine to one no route can meet");

const NOT_A_POLICY = throws("TypeError", "policy was not made by parsePolicy or combinePolicies");
const NOT_FACTS = throws("TypeError", "facts were not made by parseFacts or parsePublishedFacts");

/** The headers of a response. */
const H = (applied: string[], refusedLines: string[] = [], evidence: string[] = []) => ({ applied, refused: refusedLines, evidence });

/** A support given as its three lists. */
const sup = (keys: string[], attest: string[], sort: string[]): Support => ({ keys: new Set(keys), attest: new Set(attest), sort: new Set(sort) });

// ---- Input builders: each is code the title shows, run when the test runs. ----

const value = <T>(result: { ok: true; value: T } | { ok: false; detail: string }, code: string): T => {
  if (!result.ok) throw new Error(`${code} failed: ${result.detail}`);
  return result.value;
};

const BASELINE = new Code("baselineSupport()", () => baselineSupport());

/** The policy `text` parses to, under `support` when one is given. */
function pol(text: string, support?: Support | Code): Code {
  const code = `parsePolicy(${show(text)}${support === undefined ? "" : `, ${show(support)}`}).value`;
  return new Code(code, () => value(parsePolicy(text, support instanceof Code ? (support.build() as Support) : support), code));
}

/** The facts `text` reads as. */
function facts(text: string): Code {
  const code = `parseFacts(${show(text)}).value`;
  return new Code(code, () => value(parseFacts(text), code));
}

type Layer = string | Code;
const layer = (given: Layer): Code => (given instanceof Code ? given : pol(given));

/** The combination of the policies the carriers' texts parse to. */
function comb(layers: { key?: Layer; header?: Layer; suffix?: Layer }): Code {
  const parts = Object.entries(layers).map(([name, given]): [string, Code] => [name, layer(given)]);
  const code = `combinePolicies({${parts.map(([name, made]) => `${name}: ${made.code}`).join(", ")}})`;
  return new Code(code, () => combinePolicies(Object.fromEntries(parts.map(([name, made]) => [name, made.build()]))));
}

/** A copy, made by hand, of the value `made` builds, with `fields` changed. */
function copy(made: Code, fields: Record<string, unknown> = {}): Code {
  const members = showMembers(fields);
  return new Code(`{...${made.code}${members === "" ? "" : `, ${members}`}}`, () => ({ ...(made.build() as object), ...fields }));
}

/** The routes a model list publishes for `model`. */
function listed(list: unknown, model: string): Code {
  return new Code(`publishedRoutes(${show(list)}, ${show(model)})`, () => publishedRoutes(list instanceof Code ? list.build() : list, model));
}

/** The routes a model list whose one model is `m` publishes for `m`, given that model's `routes` member. */
const routes = (rows: unknown): Code => listed({ data: [{ id: "m", routes: rows }] }, "m");

/** A model list given as JSON text, decoded by JSON.parse, so that a repeated member is decoded as JSON does. */
const json = (text: string): Code => new Code(`JSON.parse(${show(text)})`, () => JSON.parse(text));

/** The support of a detection reply that is valid. */
function detected(reply: { status: number; body: unknown; credentialed: boolean }): Code {
  const code = `parseDetection(${show(reply)}).value.support`;
  return new Code(code, () => value(parseDetection({ ...reply, body: reply.body instanceof Code ? reply.body.build() : reply.body }), code).support);
}

const reply = (body: unknown, credentialed = true) => ({ status: 200, body, credentialed });

// ---- Constants mirrored as literals. ----

table(Object.entries, [["S4", [LIMITS], [["policyBytes", 512], ["pairs", 16], ["items", 16]]]]);
table(Object.entries, [["G1 G3 G5", [REFUSAL_STATUS], [["unsupported", 400], ["unsatisfiable", 400], ["unavailable", 503]]]]);
table(Object.isFrozen, [
  ["", [LIMITS], true],
  ["", [REFUSAL_STATUS], true],
  ["", [COUNTRIES], true],
]);

const COUNTRY_CODES = (
  "ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq br bs bt bv bw by bz " +
  "ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et fi fj fk fm fo fr " +
  "ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp " +
  "ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt " +
  "mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw " +
  "sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz " +
  "ua ug um us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw"
).split(" ");
table(Object.keys, [["S7", [COUNTRIES], COUNTRY_CODES]]);
// The digest of the sorted codes, as checked once against an independent ISO 3166-1 listing.
const sha256OfSortedKeys: (record: object) => string = (record) => createHash("sha256").update(Object.keys(record).sort().join(",")).digest("hex");
table(sha256OfSortedKeys, [["S7", [COUNTRIES], "792d849dd15e8c7053629d4ce0683b28565d05f4f1f5431d13284245313534c6"]]);

table(baselineSupport, [["C6", [], BASELINE_LISTS]], { asPlainData: true });
// Two calls give six distinct sets, before either result is changed.
const distinctSets: (a: Support, b: Support) => boolean[] = (a, b) => [a.keys !== b.keys, a.attest !== b.attest, a.sort !== b.sort];
table(distinctSets, [["", [BASELINE, BASELINE], [true, true, true]]]);
// What changing one result's sets leaves in the next result, and in parsePolicy's default.
// A support from baselineSupport() holds plain sets, which an untyped caller can change.
type ChangeableSupport = { keys: Set<string>; attest: Set<string>; sort: Set<string> };
const changeThenCall: (first: ChangeableSupport, then: () => unknown) => unknown = (first, then) => {
  first.keys.delete("zdr");
  first.attest.delete("prompt");
  first.attest.add("custom");
  first.sort.delete("throughput");
  first.sort.add("custom");
  return then();
};
table(changeThenCall, [["", [BASELINE, baselineSupport], BASELINE_LISTS]], { asPlainData: true });
table(changeThenCall, [
  ["", [BASELINE, () => parsePolicy("zdr+attest=prompt+sort=throughput")], ok(P({ zdr: true, attest: ["prompt"], sort: "throughput" }))],
  ["", [BASELINE, () => parsePolicy("attest=custom")], no("attest", "value not accepted")],
  ["", [BASELINE, () => parsePolicy("sort=custom")], no("sort", "value not accepted")],
]);
table(changeThenCall, [["", [BASELINE, () => parseDetection({ status: 200, body: { route_policy: "1" }, credentialed: true })], ok({ support: BASELINE_LISTS, keyPolicy: null })]], { asPlainData: true });

// ---- parsePolicy and fitsPolicyGrammar: grammar, limits, values and the order of checks (S1 to S10, S16). ----

const NINE = "zdr+notrain+bits=8+region=us,de+attest=weights,prompt+only=a,b+ignore=c+sort=latency+order=b,a";
table(parsePolicy, [
  ["S1", [NINE], ok(P({ zdr: true, notrain: true, bits: 8, region: ["us", "de"], attest: ["weights", "prompt"], only: ["a", "b"], ignore: ["c"], sort: "latency", order: ["b", "a"] }))],
  ["S1 S10", ["sort=price"], ok(P({ sort: "price" }))],
  ["S10", ["sort=latency"], ok(P({ sort: "latency" }))],
  ["S10", ["sort=throughput"], ok(P({ sort: "throughput" }))],
  ["S5", ["zdr"], ok(P({ zdr: true }))],
  ["S5", ["notrain"], ok(P({ notrain: true }))],
  ["S8", ["attest=weights"], ok(P({ attest: ["weights"] }))],
  ["S8", ["attest=prompt"], ok(P({ attest: ["prompt"] }))],
]);
table(keysOf, [["", [pol(NINE)], ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "sort", "order"]]]);

table(parsePolicy, [
  ["S1", [""], no(null, 'malformed key in ""')],
  ["S1", ["+"], no(null, 'malformed key in ""')],
  ["S1", ["zdr+"], no(null, 'malformed key in ""')],
  ["S1", ["+zdr"], no(null, 'malformed key in ""')],
  ["S1", ["zdr++notrain"], no(null, 'malformed key in ""')],
  ["S1", ["only="], no("only", 'malformed item ""')],
  ["S1", ["only=a,"], no("only", 'malformed item ""')],
  ["S1", ["only=,a"], no("only", 'malformed item ""')],
  ["S1", ["zdr "], no(null, 'malformed key in "zdr "')],
  ["S1", [" zdr"], no(null, 'malformed key in " zdr"')],
  ["S1", ["zdr+ notrain"], no(null, 'malformed key in " notrain"')],
  ["S1", ["only=a, b"], no("only", 'malformed item " b"')],
  ["S1", ["=a"], no(null, 'malformed key in "=a"')],
  ["S1", ["zdr="], no("zdr", 'malformed item ""')],
  ["S1", ["bits==8"], no("bits", 'malformed item "=8"')],
  ["S1", ["zdr\n"], no(null, 'malformed key in "zdr\n"')],
  ["S1", ["zdr\t+notrain"], no(null, 'malformed key in "zdr\t"')],
]);

table(parsePolicy, [
  ["S2", ["k".repeat(16)], no("k".repeat(16), "key not accepted")],
  ["S2", ["k".repeat(17)], no(null, `malformed key in "${"k".repeat(17)}"`)],
  ["S2", [`only=${"a".repeat(32)}`], ok(P({ only: ["a".repeat(32)] }))],
  ["S2", [`only=${"a".repeat(33)}`], no("only", `malformed item "${"a".repeat(33)}"`)],
  ...["Zdr", "1zdr", "z_dr", "z-dr", "a.b", "acme.tier=2", "a.", ".a", "zdr\u00e9", "__proto__"].map((key): [string, string[], unknown] => ["S2", [key], no(null, `malformed key in "${key}"`)]),
  ["S2", ["only=0a,a_b,a.b,a-b,constructor,valueof"], ok(P({ only: ["0a", "a_b", "a.b", "a-b", "constructor", "valueof"] }))],
  ...["A", "_a", ".a", "-a", "a b", "a/b", "a:b", "a~b", "__proto__", "\u00e9"].map((item): [string, string[], unknown] => ["S2", [`only=${item}`], no("only", `malformed item "${item}"`)]),
]);

table(parsePolicy, [
  ["S3", ["zdr+zdr"], no("zdr", "repeated key")],
  ["S3", ["only=a+only=b"], no("only", "repeated key")],
  ["S3", ["only=a,a"], no("only", "repeated item")],
  ["S3", ["region=us,de,us"], no("region", "repeated item")],
]);

const items = (n: number): string[] => Array.from({ length: n }, (_, i) => `p${i}`);
const FIFTEEN_LONG = Array.from({ length: 15 }, (_, i) => String.fromCharCode(97 + i).repeat(32));
const AT_512 = `only=${[...FIFTEEN_LONG, "p".repeat(12)].join(",")}`;
const AT_513 = `only=${[...FIFTEEN_LONG, "p".repeat(13)].join(",")}`;
table(parsePolicy, [
  ["S4", [`only=${items(16).join(",")}`], ok(P({ only: items(16) }))],
  ["S4", [`only=${items(17).join(",")}`], no("only", "more than 16 items")],
  ["S4", [AT_512], ok(P({ only: [...FIFTEEN_LONG, "p".repeat(12)] }))],
  ["S4", [AT_513], no(null, "longer than 512 bytes")],
  // 264 characters, 514 bytes.
  ["S4", [`only=a+ignore=${"\u00e9".repeat(250)}`], no(null, "longer than 512 bytes")],
  ["S2", ["only=a+ignore=\u00e9"], no("ignore", 'malformed item "\u00e9"')],
]);

table(parsePolicy, [
  ["S5", ["zdr=yes"], no("zdr", "takes no value")],
  ["S5", ["notrain=1"], no("notrain", "takes no value")],
  ["S6", ["bits=1"], ok(P({ bits: 1 }))],
  ["S6", ["bits=64"], ok(P({ bits: 64 }))],
  ["S6", ["bits=8"], ok(P({ bits: 8 }))],
  ...["0", "65", "08", "8.0", "8,16", "x", "100"].map((bits): [string, string[], unknown] => ["S6", [`bits=${bits}`], no("bits", "takes one integer from 1 to 64")]),
  ["S6", ["bits"], no("bits", "takes one integer from 1 to 64")],
  ["S2", ["bits=-8"], no("bits", 'malformed item "-8"')],
]);

table(
  parsePolicy,
  COUNTRY_CODES.map((code): [string, string[], unknown] => ["S7", [`region=${code}`], ok(P({ region: [code] }))]),
);
table(parsePolicy, [
  ["S7", ["region=us,de,jp"], ok(P({ region: ["us", "de", "jp"] }))],
  ...["ab", "eu", "uk", "xk", "xa", "zz", "usa", "u", "u1", "us,deu", "us,ab", "constructor"].map((region): [string, string[], unknown] => ["S7", [`region=${region}`], no("region", "takes a list of assigned ISO 3166-1 alpha-2 codes")]),
  ["S7", ["region"], no("region", "takes a list of assigned ISO 3166-1 alpha-2 codes")],
]);

const NARROW_VALUES = sup(BASELINE_LISTS.keys, ["weights"], ["price"]);
const CUSTOM_VALUES = sup(BASELINE_LISTS.keys, ["weights", "custom"], ["price", "custom"]);
table(parsePolicy, [
  ["S8", ["attest=weights,other"], no("attest", "value not accepted")],
  ["S8", ["attest"], no("attest", "value not accepted")],
  ["S10", ["sort=cheap"], no("sort", "value not accepted")],
  ["S10", ["sort=price,latency"], no("sort", "value not accepted")],
  ["S10", ["sort"], no("sort", "value not accepted")],
  ["S8 S10", ["attest=weights+sort=price", NARROW_VALUES], ok(P({ attest: ["weights"], sort: "price" }))],
  ["S8 G21", ["attest=prompt", NARROW_VALUES], no("attest", "value not accepted")],
  ["S8 G21", ["attest=weights,prompt", NARROW_VALUES], no("attest", "value not accepted")],
  ["S10 G21", ["sort=latency", NARROW_VALUES], no("sort", "value not accepted")],
  ["S8", ["attest=custom", CUSTOM_VALUES], no("attest", "value not accepted")],
  ["S10", ["sort=custom", CUSTOM_VALUES], no("sort", "value not accepted")],
  ["S8 G21", ["attest=prompt", CUSTOM_VALUES], no("attest", "value not accepted")],
  ["S10 G21", ["sort=latency", CUSTOM_VALUES], no("sort", "value not accepted")],
  ["S8 S10", ["attest=weights+sort=price", CUSTOM_VALUES], ok(P({ attest: ["weights"], sort: "price" }))],
]);

table(parsePolicy, [
  ...["only", "ignore", "order"].flatMap((key): [string, string[], unknown][] => [
    ["S9", [key], no(key, "takes a list of provider ids")],
    ["S9", [`${key}=nosuch,constructor,0`], ok(P({ [key]: ["nosuch", "constructor", "0"] }))],
  ]),
]);

const PAIRS16 = items(16).map((p) => `k${p}`);
table(parsePolicy, [
  ["S16", [`bits=0+${PAIRS16.slice(0, 15).join("+")}`], no("bits", "takes one integer from 1 to 64")],
  ["S4 S16", [`bits=0+${PAIRS16.join("+")}`], no(null, "more than 16 pairs")],
  ["S4 S16", [`bits=0+only=${"a".repeat(32)},${"b,".repeat(250)}c`], no(null, "longer than 512 bytes")],
  ["S16", ["bits=0+only=a,a"], no("bits", "takes one integer from 1 to 64")],
  ["S16", ["only=a,a+bits=0"], no("only", "repeated item")],
  ["S16", ["zdr=1+only="], no("zdr", "takes no value")],
  ["S16", ["only=+zdr=1"], no("only", 'malformed item ""')],
  ["S16", ["later+?"], no("later", "key not accepted")],
  ["S16", ["?+later"], no(null, 'malformed key in "?"')],
  ["S16", ["zdr+later=1"], no("later", "key not accepted")],
  ["S16", ["later+bits=999"], no("later", "key not accepted")],
  ["S16", ["bits=999+later"], no("bits", "takes one integer from 1 to 64")],
  ["S16", ["zdr+Bad=1+bits=0"], no(null, 'malformed key in "Bad=1"')],
  ["S16", ["zdr+notrain+zdr+bits=0"], no("zdr", "repeated key")],
]);

const ONLY_AND_SORT = { ...sup([], [], []), keys: new Set(["only", "sort"]), attest: new Set(["weights", "prompt"]), sort: new Set(["price", "latency", "throughput"]) };
table(parsePolicy, [
  ["G21", ["zdr", ONLY_AND_SORT], no("zdr", "key not accepted")],
  ["G21", ["only=a+bits=8", ONLY_AND_SORT], no("bits", "key not accepted")],
  ["", ["only=a+sort=price", ONLY_AND_SORT], ok(P({ only: ["a"], sort: "price" }))],
  ["G21", ["later", sup(["later"], ["weights", "prompt"], ["price", "latency", "throughput"])], no("later", "key not defined")],
  ["G21", ["zdr", sup([], [], [])], no("zdr", "key not accepted")],
]);

table(fitsPolicyGrammar, [
  ["S1", ["zdr"], ok(true)],
  ["S1", ["zdr+bits=8"], ok(true)],
  ...["later", "later=x,y+zdr", "bits=999", "zdr=yes", "sort=unknown", "region=zz"].map((text): [string, string[], unknown] => ["S1", [text], ok(true)]),
  ["S1", [""], no(null, 'malformed key in ""')],
  ["S1", ["zdr+"], no(null, 'malformed key in ""')],
  ["S2", ["ZDR"], no(null, 'malformed key in "ZDR"')],
  ["S3", ["zdr+zdr"], no("zdr", "repeated key")],
  ["S3", ["only=a,a"], no("only", "repeated item")],
  ["S1", ["only="], no("only", 'malformed item ""')],
  ["S1", ["only=a b"], no("only", 'malformed item "a b"')],
  ["S2", [`only=${"a".repeat(33)}`], no("only", `malformed item "${"a".repeat(33)}"`)],
]);
table(parsePolicy, [
  ...["later", "later=x,y+zdr"].map((text): [string, string[], unknown] => ["", [text], no("later", "key not accepted")]),
  ["", ["bits=999"], no("bits", "takes one integer from 1 to 64")],
  ["", ["sort=unknown"], no("sort", "value not accepted")],
  ["", ["region=zz"], no("region", "takes a list of assigned ISO 3166-1 alpha-2 codes")],
]);
const grammarPairs = (count: number, item: string) => Array.from({ length: count }, (_, i) => `k${String(i).padStart(2, "0")}=${item}`).join("+");
table(fitsPolicyGrammar, [
  // 527 bytes, 494 bytes.
  ["S4", [grammarPairs(16, "x".repeat(28))], no(null, "longer than 512 bytes")],
  ["S4", [grammarPairs(15, "x".repeat(28))], ok(true)],
  ["S4", [grammarPairs(17, "x")], no(null, "more than 16 pairs")],
  ["S4", [grammarPairs(16, "x")], ok(true)],
  // Exactly 512 bytes, and 513.
  ["S4", [AT_512], ok(true)],
  ["S4", [AT_513], no(null, "longer than 512 bytes")],
  ["S4", [`k00=${"x".repeat(508)}`], no("k00", `malformed item "${"x".repeat(508)}"`)],
]);

// ---- Values the parser made, and values it did not. ----

const MADE = pol("zdr+region=us,de+only=a+order=a");
const READ = facts("zdr+region=us+attest=weights");
const frozenParts: (made: object) => boolean[] = (made) => [made, ...Object.values(made)].filter((part) => typeof part === "object" && part !== null).map((part) => Object.isFrozen(part));
table(frozenParts, [
  ["", [MADE], [true, true, true, true, true, true]],
  ["", [comb({ key: MADE, suffix: "ignore=x" })], [true, true, true, true, true, true]],
  ["", [READ], [true, true, true]],
]);
const orderShared: (made: Policy) => boolean = (made) => combinePolicies({ key: made }).order === made.order;
table(orderShared, [["", [MADE], false]]);
table(combinePolicies, [["G11", [{ key: MADE }], P({ zdr: true, region: ["us", "de"], only: ["a"], order: ["a"] })]]);

const FORGED_POLICIES = [copy(MADE), copy(MADE, { bits: 65 }), copy(MADE, { bits: Number.NaN }), copy(MADE, { region: [] }), copy(MADE, { only: ["a,b"] }), copy(MADE, { sort: "custom" })];
const ROUTE_A = { provider: "a", facts: READ };
const ZERO: () => number = () => 0;
for (const forged of FORGED_POLICIES) {
  table(meets, [["", [ROUTE_A, forged], NOT_A_POLICY]]);
  table(formatPolicy, [["", [forged], NOT_A_POLICY]]);
  table(keysOf, [["", [forged], NOT_A_POLICY]]);
  table(hasRequirements, [["", [forged], NOT_A_POLICY]]);
  table(supports, [["", [BASELINE, forged], NOT_A_POLICY]]);
  table(combinePolicies, [
    ["", [{ key: MADE, header: forged }], NOT_A_POLICY],
    ["", [{ suffix: forged }], NOT_A_POLICY],
  ]);
  table(orderRoutes, [["", [[ROUTE_A], forged, ZERO], NOT_A_POLICY]]);
  table(clearedToSend, [["", [BASELINE, [MADE, forged]], NOT_A_POLICY]]);
  table(readOutcome, [["", [H(["provider=a"]), forged, null], NOT_A_POLICY]]);
}

const FORGED_FACTS = [copy(READ), copy(READ, { bits: 65 }), copy(READ, { bits: Number.NaN }), copy(READ, { region: [] }), copy(READ, { region: ["ab"] })];
for (const forged of FORGED_FACTS) {
  table(meets, [
    ["", [{ provider: "a", facts: forged }, MADE], NOT_FACTS],
    ["", [{ provider: "a", facts: forged }, pol("only=a")], NOT_FACTS],
  ]);
  table(readOutcome, [["", [H(["provider=a"]), pol("zdr"), new Map([["a", { facts: forged, evidence: null }]])], NOT_FACTS]]);
}

const POLICY_AS_FACTS = comb({ key: "region=it", suffix: "region=jp" });
const FACTS_AS_POLICY = READ;
table(meets, [
  ["", [{ provider: "a", facts: POLICY_AS_FACTS }, pol("region=us")], NOT_FACTS],
  ["", [{ provider: "a", facts: POLICY_AS_FACTS }, pol("only=a")], NOT_FACTS],
  ["", [ROUTE_A, FACTS_AS_POLICY], NOT_A_POLICY],
]);
table(formatPolicy, [["", [FACTS_AS_POLICY], NOT_A_POLICY]]);
table(keysOf, [["", [FACTS_AS_POLICY], NOT_A_POLICY]]);
table(combinePolicies, [["", [{ key: FACTS_AS_POLICY }], NOT_A_POLICY]]);
table(orderRoutes, [["", [[ROUTE_A], FACTS_AS_POLICY, ZERO], NOT_A_POLICY]]);
table(readOutcome, [
  ["", [H(["provider=a"]), FACTS_AS_POLICY, null], NOT_A_POLICY],
  ["", [H(["provider=a"]), pol("zdr"), new Map([["a", { facts: POLICY_AS_FACTS, evidence: null }]])], NOT_FACTS],
]);

const FORGED = copy(MADE);
for (const support of [null, BASELINE, sup([], [], [])]) {
  table(clearedToSend, [
    ...(support === BASELINE ? [] : [["", [support, [MADE, FORGED]], NOT_A_POLICY] as const]),
    ["", [support, [FORGED, MADE]], NOT_A_POLICY],
    ["", [support, [pol("sort=price"), FORGED]], NOT_A_POLICY],
    ["", [support, [MADE, facts("zdr")]], NOT_A_POLICY],
  ]);
}
table(formatPolicy, [null, undefined, "zdr", 5].map((notMade): [string, unknown[], unknown] => ["", [notMade], NOT_A_POLICY]));

const ZDR_ONLY_A = pol("zdr+only=a");
const FORGED_ZDR_ONLY_A = copy(ZDR_ONLY_A);
table(combinePolicies, [
  ["", [{ key: FORGED_ZDR_ONLY_A, header: ZDR_ONLY_A, suffix: ZDR_ONLY_A }], NOT_A_POLICY],
  ["", [{ key: ZDR_ONLY_A, header: FORGED_ZDR_ONLY_A, suffix: ZDR_ONLY_A }], NOT_A_POLICY],
  ["", [{ key: ZDR_ONLY_A, header: ZDR_ONLY_A, suffix: FORGED_ZDR_ONLY_A }], NOT_A_POLICY],
]);
for (const support of [null, BASELINE]) {
  table(clearedToSend, [
    ["", [support, [FORGED_ZDR_ONLY_A, ZDR_ONLY_A, ZDR_ONLY_A]], NOT_A_POLICY],
    ["", [support, [ZDR_ONLY_A, FORGED_ZDR_ONLY_A, ZDR_ONLY_A]], NOT_A_POLICY],
    ["", [support, [ZDR_ONLY_A, ZDR_ONLY_A, FORGED_ZDR_ONLY_A]], NOT_A_POLICY],
  ]);
}
table(providerAllowed, [
  ["", ["a", FORGED_ZDR_ONLY_A], NOT_A_POLICY],
  ["", ["a", {}], NOT_A_POLICY],
  ["", ["a", ZDR_ONLY_A], true],
]);
const A_ZDR = routes([{ provider: "a", facts: "zdr" }]);
const B_THEN_FORGED_A = new Map([
  ["b", { facts: facts("zdr"), evidence: null }],
  ["a", { facts: copy(facts("zdr")), evidence: null }],
]);
table(someRouteMeets, [
  ["C16", [A_ZDR, ZDR_ONLY_A], true],
  ["", [A_ZDR, FORGED_ZDR_ONLY_A], NOT_A_POLICY],
  ["C16", [routes([{ provider: "b", facts: "zdr" }, { provider: "a", facts: "zdr" }]), ZDR_ONLY_A], true],
  ["", [B_THEN_FORGED_A, ZDR_ONLY_A], NOT_FACTS],
]);
table(readOutcome, [["", [H(["provider=a"]), ZDR_ONLY_A, B_THEN_FORGED_A], NOT_FACTS]]);

// ---- formatPolicy, keysOf, hasRequirements, supports (C1, C2, C10). ----

table(formatPolicy, [
  ["", [pol("zdr")], ok("zdr")],
  ["", [pol("sort=price")], ok("sort=price")],
  ["", [pol("order=b,a+sort=throughput")], ok("sort=throughput+order=b,a")],
  ["", [pol("ignore=c+only=a,b+attest=prompt+region=de,us+bits=16+notrain+zdr")], ok("zdr+notrain+bits=16+region=de,us+attest=prompt+only=a,b+ignore=c")],
  ["", [pol("sort=price+zdr+bits=8")], ok("zdr+bits=8+sort=price")],
]);
table(parsePolicy, [
  ["", ["sort=throughput+order=b,a"], ok(P({ sort: "throughput", order: ["b", "a"] }))],
  ["", ["zdr+notrain+bits=16+region=de,us+attest=prompt+only=a,b+ignore=c"], ok(P({ zdr: true, notrain: true, bits: 16, region: ["de", "us"], attest: ["prompt"], only: ["a", "b"], ignore: ["c"] }))],
  ["", ["zdr+bits=8+sort=price"], ok(P({ zdr: true, bits: 8, sort: "price" }))],
]);

const SIXTEEN_IGNORED = `ignore=${items(16).join(",")}`;
const LONG_A = Array.from({ length: 15 }, (_, i) => `a${String(i).padStart(2, "0")}`.padEnd(32, "x"));
const LONG_B = Array.from({ length: 15 }, (_, i) => `b${String(i).padStart(2, "0")}`.padEnd(32, "x"));
table(formatPolicy, [
  ["C10", [comb({})], no(null, 'malformed key in ""')],
  ["C10", [comb({ key: "region=us", suffix: "region=de" })], no("region", 'malformed item ""')],
  ["C10", [comb({ key: "only=a", suffix: "only=b" })], no("only", 'malformed item ""')],
  ["C10", [comb({ key: SIXTEEN_IGNORED, suffix: "ignore=extra" })], no("ignore", "more than 16 items")],
  ["", [comb({ key: "zdr+region=us,de", suffix: "region=de+sort=price" })], ok("zdr+region=de+sort=price")],
  ["", [pol(`only=${LONG_A.join(",")}`)], ok(`only=${LONG_A.join(",")}`)],
  ["", [pol(`ignore=${LONG_B.join(",")}`)], ok(`ignore=${LONG_B.join(",")}`)],
  ["C10", [comb({ key: `only=${LONG_A.join(",")}`, suffix: `ignore=${LONG_B.join(",")}` })], no(null, "longer than 512 bytes")],
  ["G11", [comb({ key: "ignore=a,b", suffix: "ignore=a,c" })], ok("ignore=a,c,b")],
]);
table(combinePolicies, [
  ["G11", [{}], P()],
  ["G11", [{ key: pol(SIXTEEN_IGNORED), suffix: pol("ignore=extra") }], P({ ignore: ["extra", ...items(16)] })],
  ["G11", [{ key: pol(`only=${LONG_A.join(",")}`), suffix: pol(`ignore=${LONG_B.join(",")}`) }], P({ only: LONG_A, ignore: LONG_B })],
]);

table(hasRequirements, [
  ...["sort=price", "order=a", "sort=price+order=a"].map((text): [string, unknown[], unknown] => ["C2", [pol(text)], false]),
  ...["zdr", "notrain", "bits=8", "region=us", "attest=weights", "only=a", "ignore=a"].flatMap((text): [string, unknown[], unknown][] => [
    ["C1", [pol(text)], true],
    ["C1", [pol(`sort=price+${text}`)], true],
  ]),
]);

const NARROW = sup(["zdr", "sort", "attest", "bits", "region", "only"], ["weights"], ["price"]);
table(supports, [
  ["", [NARROW, pol("zdr+sort=price+attest=weights")], true],
  ["C1", [NARROW, pol("notrain")], false],
  ["C1", [NARROW, pol("zdr+ignore=a")], false],
  ["C1", [NARROW, pol("zdr+order=a")], false],
  ["C1", [NARROW, pol("ignore=a")], false],
  ["C1", [NARROW, pol("order=a")], false],
  ["C1", [NARROW, pol("sort=latency")], false],
  ["C1", [NARROW, pol("attest=prompt")], false],
  ["C1", [NARROW, pol("attest=weights,prompt")], false],
  ["C1", [NARROW, pol("attest=prompt,weights")], false],
  ["", [NARROW, pol("bits=64+region=fr+only=constructor")], true],
  ["C1", [sup(["zdr", "sort", "attest", "region", "only"], ["weights"], ["price"]), pol("bits=64")], false],
  ["C1", [sup(["zdr", "sort", "attest", "bits", "only"], ["weights"], ["price"]), pol("region=fr")], false],
  ["C1", [sup(["zdr", "sort", "attest", "bits", "region"], ["weights"], ["price"]), pol("only=constructor")], false],
  ["", [sup(["zdr", "sort", "attest", "region", "only"], ["weights"], ["price"]), pol("region=fr+only=constructor")], true],
]);

// ---- splitModel (S11). ----

table(splitModel, [
  ["S11", ["example-model"], { id: "example-model", policy: null }],
  ["S11", ["vendor/example-model:free+zdr+sort=price"], { id: "vendor/example-model:free", policy: "zdr+sort=price" }],
  ["S11", ["example-model+"], { id: "example-model", policy: "" }],
  ["S11", ["+zdr"], { id: "", policy: "zdr" }],
  ["S11", [""], { id: "", policy: null }],
]);

// ---- combinePolicies (G11, G12, G13). ----

table(combinePolicies, [
  [
    "G11",
    [{ key: pol("zdr+bits=8+region=us,de,fr+only=a,b,c+ignore=x+attest=weights"), header: pol("notrain+bits=16+region=de,fr+ignore=y"), suffix: pol("bits=4+region=fr,gb+only=b,c,d+attest=prompt") }],
    P({ zdr: true, notrain: true, bits: 16, region: ["fr"], attest: ["prompt", "weights"], only: ["b", "c"], ignore: ["y", "x"] }),
  ],
  // Each layer is the one that wins the maximum, and each removes a different member from the intersections.
  ["G11 G13", [{ key: pol("bits=32"), header: pol("bits=8"), suffix: pol("bits=16") }], P({ bits: 32 })],
  ["G11", [{ key: pol("bits=8"), header: pol("bits=32"), suffix: pol("bits=16") }], P({ bits: 32 })],
  ["G11", [{ key: pol("bits=8"), header: pol("bits=16"), suffix: pol("bits=32") }], P({ bits: 32 })],
  ["G11", [{ key: pol("bits=8"), suffix: pol("bits=32") }], P({ bits: 32 })],
  ["G11 G13", [{ key: pol("bits=32"), header: pol("bits=16") }], P({ bits: 32 })],
  ["G11 G13", [{ key: pol("bits=32"), suffix: pol("bits=4") }], P({ bits: 32 })],
  ["G11", [{ key: pol("region=de,fr,gb"), header: pol("region=us,fr,gb"), suffix: pol("region=us,de,gb") }], P({ region: ["gb"] })],
  ["G11", [{ key: pol("only=b,c,d"), header: pol("only=a,c,d"), suffix: pol("only=a,b,d") }], P({ only: ["d"] })],
  ["G11", [{ key: pol("ignore=a,b+attest=weights"), header: pol("ignore=b,c+attest=weights,prompt"), suffix: pol("ignore=a,c") }], P({ ignore: ["a", "c", "b"], attest: ["weights", "prompt"] })],
  ["G11", [{ key: pol("attest=weights"), header: pol("attest=weights,prompt") }], P({ attest: ["weights", "prompt"] })],
  ["G11 G13", [{ key: pol("attest=weights"), header: pol("attest=prompt") }], P({ attest: ["prompt", "weights"] })],
  ["G11", [{ header: pol("attest=weights"), suffix: pol("attest=prompt") }], P({ attest: ["prompt", "weights"] })],
  ["G11 G13", [{ key: pol("attest=prompt"), suffix: pol("attest=weights") }], P({ attest: ["weights", "prompt"] })],
  ["G11 G13", [{ key: pol("ignore=x"), header: pol("ignore=y"), suffix: pol("ignore=z") }], P({ ignore: ["z", "y", "x"] })],
  ["G11", [{ header: pol("zdr"), suffix: pol("notrain") }], P({ zdr: true, notrain: true })],
]);
table(meets, [
  ["G6 G11", [{ provider: "a", facts: facts("zdr") }, comb({ header: "zdr", suffix: "notrain" })], false],
  ["G6 G11", [{ provider: "a", facts: facts("notrain") }, comb({ header: "zdr", suffix: "notrain" })], false],
  ["G6", [{ provider: "a", facts: facts("zdr+notrain") }, comb({ header: "zdr", suffix: "notrain" })], true],
]);

table(combinePolicies, [
  ["G11 G12", [{ key: pol("region=us"), suffix: pol("region=de") }], P({ region: [] })],
  ["G11 G12", [{ key: pol("only=a"), header: pol("only=b") }], P({ only: [] })],
  ["G11 G12", [{ header: pol("region=us"), suffix: pol("region=ca") }], P({ region: [] })],
  ["G11 G12", [{ header: pol("region=it"), suffix: pol("region=jp") }], P({ region: [] })],
  ["G11 G12", [{ header: pol("only=p"), suffix: pol("only=q") }], P({ only: [] })],
  ["G11", [{ key: pol("region=de"), header: pol("region=us,de,fr"), suffix: pol("region=us,de") }], P({ region: ["de"] })],
  ["G11", [{ key: pol("only=c"), header: pol("only=a,b,c"), suffix: pol("only=b,c") }], P({ only: ["c"] })],
  ["G11 G12", [{ key: pol("region=us"), header: pol("region=us,de"), suffix: pol("region=de") }], P({ region: [] })],
  ["G11 G13", [{ key: pol("region=us"), header: pol("region=us,de") }], P({ region: ["us"] })],
  ["G11 G13", [{ key: pol("only=a"), suffix: pol("only=a,b") }], P({ only: ["a"] })],
]);
const EMPTY_REGION = comb({ key: "region=us", suffix: "region=de" });
const EMPTY_ONLY = comb({ key: "only=a", header: "only=b" });
const EMPTY_ONLY_PQ = comb({ header: "only=p", suffix: "only=q" });
table(meets, [
  ["G6 G12", [{ provider: "a", facts: facts("region=us") }, EMPTY_REGION], false],
  ["G6 G12", [{ provider: "a", facts: facts("region=de") }, EMPTY_REGION], false],
  ["G6", [{ provider: "a", facts: facts("") }, EMPTY_REGION], false],
  ["G6 G12", [{ provider: "a", facts: facts("region=us") }, EMPTY_ONLY], false],
  ["G6 G12", [{ provider: "b", facts: facts("") }, EMPTY_ONLY], false],
]);
table(providerAllowed, [
  ["G12", ["p", EMPTY_ONLY_PQ], false],
  ["G12", ["q", EMPTY_ONLY_PQ], false],
  ["", ["p", pol("only=p")], true],
  ["", ["q", pol("only=q")], true],
]);

table(combinePolicies, [
  ["G11", [{ key: pol("sort=price+order=a"), header: pol("sort=latency+order=b"), suffix: pol("sort=throughput") }], P({ sort: "throughput", order: ["b"] })],
  ["G11", [{ key: pol("sort=price+order=a"), header: pol("sort=latency") }], P({ sort: "latency", order: ["a"] })],
  ["G11", [{ key: pol("sort=price+order=a") }], P({ sort: "price", order: ["a"] })],
  ["G11", [{ header: pol("sort=latency+order=b") }], P({ sort: "latency", order: ["b"] })],
  ["G11", [{ suffix: pol("sort=throughput+order=c") }], P({ sort: "throughput", order: ["c"] })],
  ["G11", [{ key: pol("sort=price"), suffix: pol("sort=latency") }], P({ sort: "latency" })],
  ["G11", [{ key: pol("order=a"), header: pol("order=b"), suffix: pol("order=c,d") }], P({ order: ["c", "d"] })],
  ["G11", [{ key: pol("order=a"), header: pol("order=b") }], P({ order: ["b"] })],
  ["G11", [{ key: pol("order=a"), suffix: pol("order=c") }], P({ order: ["c"] })],
  ["G11", [{ key: pol("order=a"), header: pol("sort=price"), suffix: pol("sort=latency") }], P({ sort: "latency", order: ["a"] })],
  ["G11", [{ key: pol("sort=price"), header: pol("order=b"), suffix: pol("zdr") }], P({ zdr: true, sort: "price", order: ["b"] })],
]);

// A requirement stated by one carrier alone, beside preferences in the other two.
const PREFERENCE_LAYERS = { key: "sort=price", header: "order=x", suffix: "sort=latency" } as const;
const LEFT_PREFERENCES = { key: { sort: "latency", order: ["x"] }, header: { sort: "latency", order: null }, suffix: { sort: "price", order: ["x"] } };
const ONE_REQUIREMENT: [text: string, field: string, value: unknown][] = [
  ["zdr", "zdr", true],
  ["notrain", "notrain", true],
  ["bits=16", "bits", 16],
  ["region=us", "region", ["us"]],
  ["only=a", "only", ["a"]],
  ["ignore=a", "ignore", ["a"]],
  ["attest=prompt", "attest", ["prompt"]],
];
for (const carrier of ["key", "header", "suffix"] as const) {
  table(
    combinePolicies,
    ONE_REQUIREMENT.map(([text, field, kept]): [string, unknown[], unknown] => [
      carrier === "key" ? "G11 G13" : "G11",
      [Object.fromEntries(Object.entries({ ...PREFERENCE_LAYERS, [carrier]: text }).map(([name, given]) => [name, pol(given)]))],
      P({ ...LEFT_PREFERENCES[carrier], [field]: kept }),
    ]),
  );
}

// The strong policy in one carrier, and a weaker or preference policy in another: the more specific layer's union
// items come first (suffix, then header, then key).
const STRONG = "zdr+notrain+bits=16+region=us+attest=weights+only=a+ignore=b";
const KEPT = { zdr: true, notrain: true, bits: 16, region: ["us"], attest: ["weights"], only: ["a"], ignore: ["b"] };
const CARRIERS = ["key", "header", "suffix"] as const;
for (const owner of CARRIERS) {
  for (const other of CARRIERS) {
    if (other === owner) continue;
    const otherFirst = CARRIERS.indexOf(other) > CARRIERS.indexOf(owner);
    const tags = owner === "key" ? "G11 G13" : "G11";
    table(combinePolicies, [
      [tags, [{ [owner]: pol(STRONG), [other]: pol("sort=price") }], P({ ...KEPT, sort: "price" })],
      [tags, [{ [owner]: pol(STRONG), [other]: pol("bits=1") }], P(KEPT)],
      [tags, [{ [owner]: pol(STRONG), [other]: pol("region=us,de,fr") }], P(KEPT)],
      [tags, [{ [owner]: pol(STRONG), [other]: pol("only=a,b,c") }], P(KEPT)],
      [tags, [{ [owner]: pol(STRONG), [other]: pol("attest=prompt") }], P({ ...KEPT, attest: otherFirst ? ["prompt", "weights"] : ["weights", "prompt"] })],
      [tags, [{ [owner]: pol(STRONG), [other]: pol("ignore=c") }], P({ ...KEPT, ignore: otherFirst ? ["c", "b"] : ["b", "c"] })],
    ]);
  }
}

// ---- parseFacts and parsePublishedFacts (S12, S13). ----

const LATER_FACTS = "zdr+bits=8+region=us,de+attest=weights,later+later+newkey=x,y+provider=p+constructor=x";
table(parseFacts, [
  ["S13", [""], ok(F())],
  ["S13", [LATER_FACTS], ok(F({ zdr: true, bits: 8, region: ["us", "de"], attest: ["weights"] }))],
  ["S13", ["attest=prompt,next"], ok(F({ attest: ["prompt"] }))],
  ["S13", ["attest=next"], ok(F())],
  ["S13", ["attest=next,later"], ok(F())],
  ["S13", ["later"], ok(F())],
  ["S5 S13", ["zdr"], ok(F({ zdr: true }))],
  ["S5 S13", ["notrain"], ok(F({ notrain: true }))],
  ["S5 S13", ["zdr+notrain"], ok(F({ zdr: true, notrain: true }))],
  ["S6 S13", ["bits=16"], ok(F({ bits: 16 }))],
  ["S7 S13", ["region=us,de"], ok(F({ region: ["us", "de"] }))],
  ["S13", ["attest=weights,prompt"], ok(F({ attest: ["weights", "prompt"] }))],
  ["S13", ["newflag+zdr+region=us"], ok(F({ zdr: true, region: ["us"] }))],
  ["S13", ["zdr+newflag+attest=weights,later"], ok(F({ zdr: true, attest: ["weights"] }))],
  ["S4 S13", [PAIRS16.join("+")], ok(F())],
  ["S4", [[...PAIRS16, "kp16"].join("+")], no(null, "more than 16 pairs")],
]);
table(meets, [
  ["G6 S13", [{ provider: "a", facts: facts(LATER_FACTS) }, pol("zdr+bits=8+region=us,de+attest=weights")], true],
  ["G6", [{ provider: "a", facts: facts(LATER_FACTS) }, pol("notrain")], false],
  ["G6", [{ provider: "a", facts: facts(LATER_FACTS) }, pol("attest=prompt")], false],
  ["G6", [{ provider: "a", facts: facts(LATER_FACTS) }, pol("attest=weights,prompt")], false],
  ["", [{ provider: "a", facts: facts("later") }, pol("only=a")], true],
  ["G6 S13", [{ provider: "a", facts: facts("attest=weights,later") }, pol("attest=weights")], true],
]);
table(parseFacts, [
  ...[["only=x", "only"], ["ignore=x", "ignore"], ["ignore", "ignore"], ["sort", "sort"], ["sort=price", "sort"], ["order=x", "order"], ["zdr+order=x", "order"], ["zdr+only=a", "only"]].map(
    ([text, key]): [string, unknown[], unknown] => ["S13", [text], no(key!, "is not a fact")],
  ),
  ["S5 S13", ["zdr=1"], no("zdr", "takes no value")],
  ["S5 S13", ["notrain=x"], no("notrain", "takes no value")],
  ["S6 S13", ["bits=0"], no("bits", "takes one integer from 1 to 64")],
  ["S6 S13", ["bits=65"], no("bits", "takes one integer from 1 to 64")],
  ["S6 S13", ["bits"], no("bits", "takes one integer from 1 to 64")],
  ["S6 S13", ["bits=8,16"], no("bits", "takes one integer from 1 to 64")],
  ["S7 S13", ["region=usa"], no("region", "takes a list of assigned ISO 3166-1 alpha-2 codes")],
  ["S7 S13", ["region=ab"], no("region", "takes a list of assigned ISO 3166-1 alpha-2 codes")],
  ["S7 S13", ["region=us,eu"], no("region", "takes a list of assigned ISO 3166-1 alpha-2 codes")],
  ["S7 S13", ["region"], no("region", "takes a list of assigned ISO 3166-1 alpha-2 codes")],
  ["S13", ["attest"], no("attest", "takes a list")],
  ["S13", ["zdr+attest"], no("attest", "takes a list")],
  ["S3", ["zdr+zdr"], no("zdr", "repeated key")],
  ["S1", ["+"], no(null, 'malformed key in ""')],
  ["S1", ["zdr+"], no(null, 'malformed key in ""')],
  ["S2", ["Zdr"], no(null, 'malformed key in "Zdr"')],
  ["S2", ["attest=Weights"], no("attest", 'malformed item "Weights"')],
  ["S3 S13", ["extended=2+extended=4+zdr"], no("extended", "repeated key")],
  ["S3 S13", ["zdr+extended+extended"], no("extended", "repeated key")],
  ["S3", ["attest=weights+attest=prompt"], no("attest", "repeated key")],
  ["S3", ["extended=a,a"], no("extended", "repeated item")],
]);
const FLAG_VALUES: [text: string, key: string][] = [["zdr=no", "zdr"], ["notrain=no", "notrain"], ["zdr=no+notrain=no", "zdr"], ["zdr=yes", "zdr"], ["notrain=1+zdr", "notrain"], ["zdr+notrain=0", "notrain"]];
table(parseFacts, FLAG_VALUES.map(([text, key]): [string, unknown[], unknown] => ["S5 S13", [text], no(key, "takes no value")]));
table(parsePublishedFacts, FLAG_VALUES.map(([text, key]): [string, unknown[], unknown] => ["S5 S12", [text], no(key, "takes no value")]));

table(parsePublishedFacts, [
  ["S12", [""], ok(F())],
  ["S12", ["zdr+notrain+bits=8+region=us+attest=weights,prompt"], ok(F({ zdr: true, notrain: true, bits: 8, region: ["us"], attest: ["weights", "prompt"] }))],
  ["S12", ["later"], no("later", "is not a fact")],
  ["S12", ["zdr+newkey=1"], no("newkey", "is not a fact")],
  ["S12", ["provider=a"], no("provider", "is not a fact")],
  ["S12", ["attest=custom"], no("attest", "holds an attest value this revision does not define")],
  ["S12", ["attest=weights,custom"], no("attest", "holds an attest value this revision does not define")],
  ["S12", ["only=a"], no("only", "is not a fact")],
  ["S7 S12", ["region=ab"], no("region", "takes a list of assigned ISO 3166-1 alpha-2 codes")],
  ["S6 S12", ["bits=0"], no("bits", "takes one integer from 1 to 64")],
  ["S12", ["extended=2+extended=4+zdr"], no("extended", "is not a fact")],
  ["S12", ["zdr+extended+extended"], no("extended", "is not a fact")],
  ["S3", ["zdr+zdr"], no("zdr", "repeated key")],
  ["S3 S12", ["attest=weights+attest=prompt"], no("attest", "repeated key")],
]);

// ---- meets and providerAllowed (G6, S9). ----

const MEETS: [policy: string, provider: string, facts: string, met: boolean][] = [
  ["zdr", "a", "zdr", true],
  ["zdr", "a", "notrain", false],
  ["notrain", "a", "zdr+notrain", true],
  ["notrain", "a", "", false],
  ["notrain", "a", "zdr", false],
  ["bits=8", "a", "bits=8", true],
  ["bits=8", "a", "bits=16", true],
  ["bits=64", "a", "bits=64", true],
  ["bits=8", "a", "bits=4", false],
  ["bits=8", "a", "bits=7", false],
  ["bits=16", "a", "zdr+bits=4", false],
  ["bits=8", "a", "zdr", false],
  ["region=us,de", "a", "region=us", true],
  ["region=us,de", "a", "region=de,us", true],
  ["region=us", "a", "region=us,de", false],
  ["region=us", "a", "", false],
  ["region=it,fr", "a", "region=it,fr", true],
  ["region=it,fr", "a", "region=it,fr,de", false],
  ["region=it,fr", "a", "region=de,it,fr", false],
  ["region=it,fr,de", "a", "region=it,fr,de,es", false],
  ["region=es,de,fr,it", "a", "region=it,fr,de,es", true],
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
  ["zdr+bits=8+region=us+only=a", "a", "bits=8+region=us", false],
  ["zdr+bits=8+region=us+only=a", "a", "zdr+region=us", false],
  ["zdr+bits=8+region=us+only=a", "a", "zdr+bits=4+region=us", false],
  ["zdr+bits=8+region=us+only=a", "a", "zdr+bits=8", false],
  ["zdr+ignore=a", "a", "zdr", false],
  ["zdr+only=a", "a", "", false],
  ["zdr+bits=8", "aurora", "notrain+bits=16", false],
  ["zdr+bits=8", "aurora", "zdr+bits=4", false],
];
table(meets, MEETS.map(([text, provider, read, met]): [string, unknown[], unknown] => ["G6", [{ provider, facts: facts(read) }, pol(text)], met]));

const ALLOWED: [policy: string, provider: string, allowed: boolean][] = [
  ["zdr+bits=8", "aurora", true],
  ["only=aurora,basalt", "aurora", true],
  ["only=aurora,basalt", "cobalt", false],
  ["ignore=cobalt", "cobalt", false],
  ["ignore=cobalt", "aurora", true],
  ["only=aurora+ignore=aurora", "aurora", false],
];
table(providerAllowed, ALLOWED.map(([text, provider, allowed]): [string, unknown[], unknown] => ["G6", [provider, pol(text)], allowed]));
table(meets, ALLOWED.map(([text, provider, allowed]): [string, unknown[], unknown] => ["G6", [{ provider, facts: facts("zdr+notrain+bits=16") }, pol(text)], allowed]));

// ---- orderRoutes (G35, G24). ----

// Each sort ranks these five differently. A rank is the route's member named by the sort; no other sort is ranked.
const FIVE = [
  { provider: "a", price: 3, latency: 2, throughput: -30 },
  { provider: "b", price: 1, latency: 3, throughput: -10 },
  { provider: "c", price: 2, latency: 1, throughput: -20 },
  { provider: "d", price: 2, latency: 4, throughput: -20 },
  { provider: "e", price: 5, latency: 5, throughput: -5 },
];
const rankBy: (route: object, sort: string) => number = (route, sort) => {
  if (sort !== "price" && sort !== "latency" && sort !== "throughput") throw new RangeError(`no rank for sort ${sort}`);
  return Reflect.get(route, sort);
};
const five = (ids: string): typeof FIVE => [...ids].map((id) => FIVE.find((route) => route.provider === id)!);
table(
  orderRoutes,
  (
    [
      ["sort=price", "bcdae", "G35"],
      ["sort=latency", "cabde", "G35"],
      ["sort=throughput", "acdbe", "G35"],
      ["order=d,a", "dabce", "G35"],
      ["order=e,d,c", "edcab", "G35"],
      ["order=e,d,c,b", "edcba", "G35"],
      ["order=d+sort=price", "dbcae", "G35"],
      ["order=d+sort=latency", "dcabe", "G35"],
      ["order=d+sort=throughput", "dacbe", "G35"],
      ["order=c,nosuch+sort=price", "cbdae", "G35 G24"],
      ["order=nosuch", "abcde", "G35"],
      ["order=nosuch,d", "dabce", "G35 G24"],
      ["zdr", "abcde", "G35"],
    ] as const
  ).map(([text, ids, tags]): [string, unknown[], unknown] => [tags, [FIVE, pol(text), rankBy], five(ids)]),
);
// The input array after ordering it.
const inputAfter: (routes: { provider: string }[], policy: Policy, rank: (route: { provider: string }, sort: string) => number) => unknown = (routes, policy, rank) => (orderRoutes(routes, policy, rank), routes);
table(inputAfter, [
  ["", [FIVE, pol("sort=price"), rankBy], FIVE],
  ["", [FIVE, pol("order=d+sort=latency"), rankBy], FIVE],
]);
const THREE = [
  { provider: "a", price: 3 },
  { provider: "b", price: 1 },
  { provider: "c", price: 2 },
];
const [TA, TB, TC] = THREE;
table(orderRoutes, [
  ["G35", [THREE, pol("order=c,b,a+sort=price"), rankBy], [TC, TB, TA]],
  ["G35", [THREE, pol("order=a,c+sort=price"), rankBy], [TA, TC, TB]],
  ["G35", [THREE, pol("order=c,b,a"), rankBy], [TC, TB, TA]],
  ["G35", [THREE, pol("sort=price"), rankBy], [TB, TC, TA]],
]);

// ---- Route-Applied, provider ids, evidence URIs (S14, S17, S18). ----

const IDS = ["aurora", "a", "0", "data-east", "a.b_c", "constructor", "null", "a".repeat(32)];
table(formatApplied, IDS.map((id): [string, unknown[], unknown] => ["S14", [id], `provider=${id}`]));
table(parseApplied, IDS.map((id): [string, unknown[], unknown] => ["S14", [`provider=${id}`], ok(id)]));
table(isProviderId, IDS.map((id): [string, unknown[], unknown] => ["S17", [id], true]));
table(parseApplied, [
  ...(
    [
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
      ["provider=a,provider=b", "is not exactly one provider id"],
      ["provider=a, provider=b", "is not exactly one provider id"],
      ["provider=a,b", "is not exactly one provider id"],
      ["provider=a, b", "is not exactly one provider id"],
      ["provider=a,", "is not exactly one provider id"],
      ["route=a", "does not begin with the provider"],
    ] as const
  ).map(([text, detail]): [string, unknown[], unknown] => ["S14", [text], no("provider", detail)]),
]);

const NOT_IDS = ["", "org/provider", "Data-East", "a b", "-a", "a,b", "a+b", "a".repeat(33)];
table(isProviderId, [
  ...[...NOT_IDS, null, undefined, 5, true, ["aurora"]].map((id): [string, unknown[], unknown] => ["S17", [id], false]),
  ["", [{}], false],
]);
table(formatApplied, [
  ...NOT_IDS.map((id): [string, unknown[], unknown] => ["S17", [id], throws("RangeError", `"${id}" is not a provider id`)]),
  ["S17", [null], throws("RangeError", '"null" is not a provider id')],
  ["S17", [undefined], throws("RangeError", '"undefined" is not a provider id')],
  ["S17", [5], throws("RangeError", '"5" is not a provider id')],
  ["S17", [true], throws("RangeError", '"true" is not a provider id')],
  ["", [{}], throws("RangeError", '"[object Object]" is not a provider id')],
  ["S17", [["aurora"]], throws("RangeError", '"aurora" is not a provider id')],
]);

const EVIDENCE_ACCEPTED = [
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
  ...["1", "443", "44300", "65535"].map((port) => `https://basalt.example:${port}/a`),
  ...["proof.example", "1.example", "123.a1", "a.b.c1", "x1", "1x", "a-1", "xn--1ca"].map((host) => `https://${host}/report`),
];
// Refused strings that no mutation of the grammar made to accept them, so they carry no requirement id.
const EVIDENCE_REFUSED_UNTAGGED = ["", "/attestation", "https:", "https://?a", "urn:example:evidence:1", "https://basalt.example:port/a"];
const EVIDENCE_REFUSED = [
  "basalt.example/attestation",
  "//basalt.example/a",
  "https://",
  "https:///a",
  "https://basalt.example?a",
  "http://basalt.example/a",
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
  ...["0", "00", "0443", "65536", "99999", "100000", "-1"].map((port) => `https://basalt.example:${port}/a`),
  ...["proof.123", "127.0.0.1", "1", "123", "a.b.0", "192.168.1.1"].flatMap((host) => [`https://${host}/report`, `https://${host}`, `https://${host}:8443/report`]),
];
table(isEvidenceUri, [
  ...EVIDENCE_ACCEPTED.map((uri): [string, unknown[], unknown] => ["S18", [uri], true]),
  ...EVIDENCE_REFUSED.map((uri): [string, unknown[], unknown] => ["S18", [uri], false]),
  ...EVIDENCE_REFUSED_UNTAGGED.map((uri): [string, unknown[], unknown] => ["", [uri], false]),
  ...[null, undefined, 5, {}].map((notString): [string, unknown[], unknown] => ["", [notString], false]),
  ["S18", [["https://a.example/x"]], false],
]);

// ---- Route-Refused (S15) and REFUSAL_STATUS. ----

table(formatRefused, [
  ["S15", ["unsupported", "bits"], "reason=unsupported+key=bits"],
  ["S15", ["unsupported", "later"], "reason=unsupported+key=later"],
  ["S15", ["unsupported"], "reason=unsupported"],
  ["S15", ["unsupported", null], "reason=unsupported"],
  ["S15", ["unsatisfiable"], "reason=unsatisfiable"],
  ["S15", ["unavailable"], "reason=unavailable"],
  ...["bad key", "Bad", "", "a.b", "k".repeat(17), false, true, ["bits"]].map((key): [string, unknown[], unknown] => ["S15", ["unsupported", key], throws("RangeError", `cannot name key "${String(key)}" in a "unsupported" refusal`)]),
  ...[5, {}].map((key): [string, unknown[], unknown] => ["", ["unsupported", key], throws("RangeError", `cannot name key "${String(key)}" in a "unsupported" refusal`)]),
  ...["other", "constructor", "", ["unsupported"]].map((reason): [string, unknown[], unknown] => ["S15", [reason], throws("RangeError", `"${String(reason)}" is not a refusal reason`)]),
  ...[null, undefined, 5].map((reason): [string, unknown[], unknown] => ["", [reason], throws("RangeError", `"${String(reason)}" is not a refusal reason`)]),
  ["S15", ["unavailable", "bits"], throws("RangeError", 'cannot name key "bits" in a "unavailable" refusal')],
  ["S15", ["unsatisfiable", "bits"], throws("RangeError", 'cannot name key "bits" in a "unsatisfiable" refusal')],
]);
table(parseRefused, [
  ["S15", ["reason=unsupported+key=bits"], ok({ reason: "unsupported", key: "bits" })],
  ["S15", ["reason=unsupported+key=later"], ok({ reason: "unsupported", key: "later" })],
  ["S15", ["reason=unsupported"], ok({ reason: "unsupported", key: null })],
  ["S15", ["reason=unsatisfiable"], ok({ reason: "unsatisfiable", key: null })],
  ["S15", ["reason=unavailable"], ok({ reason: "unavailable", key: null })],
  ...["a", "zone7", "a".repeat(16)].map((key): [string, unknown[], unknown] => ["S15", [`reason=unsupported+key=${key}`], ok({ reason: "unsupported", key })]),
  ...["", "key=bits"].map((text): [string, unknown[], unknown] => ["", [text], no(null, "not a Route-Refused value")]),
  ...[
    "reason=other",
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
    ...["7zone", "7", "_a", "-a", "A", "a_b", "a-b", "a".repeat(17), "a b", "a+b"].map((key) => `reason=unsupported+key=${key}`),
  ].map((text): [string, unknown[], unknown] => ["S15", [text], no(null, "not a Route-Refused value")]),
  ["S15", ["reason=unsatisfiable+key=bits"], no("key", 'a key is named only with "unsupported"')],
  ["S15", ["reason=unavailable+key=bits"], no("key", 'a key is named only with "unsupported"')],
]);

// ---- Detection: parseDetection, formatDetection, clearedToSend (C1, C2, C6, C13, G20, G21, G22, G36). ----

table(
  parseDetection,
  [
    ["C6", [reply({ route_policy: "1", extra: { anything: true } })], ok({ support: BASELINE_LISTS, keyPolicy: null })],
    ["C6", [reply({ route_policy: "1", keys: [], attest: [], sort: [] })], ok({ support: lists([], [], []), keyPolicy: null })],
    ["C6", [reply({ route_policy: "1", attest: [], sort: [] })], ok({ support: lists(BASELINE_LISTS.keys, [], []), keyPolicy: null })],
    [
      "C6 C13",
      [reply({ route_policy: "1", keys: ["zdr", "later", "sort", "attest"], attest: ["weights", "later"], sort: ["price", "later"], key_policy: "zdr+later=x+sort=later+attest=later" })],
      ok({ support: lists(["zdr", "attest", "sort"], ["weights"], ["price"]), keyPolicy: "zdr+later=x+sort=later+attest=later" }),
    ],
    ["C6 C13", [reply({ route_policy: "1", keys: ["zdr", "later"], key_policy: "later=slow" })], ok({ support: lists(["zdr"], ["weights", "prompt"], ["price", "latency", "throughput"]), keyPolicy: "later=slow" })],
    ["C6", [reply({ route_policy: "1", key_policy: "zdr" })], ok({ support: BASELINE_LISTS, keyPolicy: "zdr" })],
    ["C6", [reply({ route_policy: "1", key_policy: "zdr" }, false)], no("key_policy", "is present in a reply to a request without credentials")],
    ["C6", [reply({ route_policy: "1", key_policy: "only=slow" })], ok({ support: BASELINE_LISTS, keyPolicy: "only=slow" })],
    ["C6", [reply({ route_policy: "1", key_policy: "zdr+notrain" })], ok({ support: BASELINE_LISTS, keyPolicy: "zdr+notrain" })],
    // Bodies that give some of the three lists and omit the rest.
    ["C6", [reply({ route_policy: "1", keys: ["attest", "sort"] })], ok({ support: lists(["attest", "sort"], ["weights", "prompt"], ["price", "latency", "throughput"]), keyPolicy: null })],
    ["C6", [reply({ route_policy: "1", keys: ["attest"], sort: ["price"] })], ok({ support: lists(["attest"], ["weights", "prompt"], ["price"]), keyPolicy: null })],
    ["C6", [reply({ route_policy: "1", keys: ["attest"], attest: ["weights"] })], ok({ support: lists(["attest"], ["weights"], ["price", "latency", "throughput"]), keyPolicy: null })],
    ["C6", [reply({ route_policy: "1", attest: ["weights"] })], ok({ support: lists(BASELINE_LISTS.keys, ["weights"], ["price", "latency", "throughput"]), keyPolicy: null })],
    ["C6", [reply({ route_policy: "1", sort: ["price"] })], ok({ support: lists(BASELINE_LISTS.keys, ["weights", "prompt"], ["price"]), keyPolicy: null })],
    ["C6", [reply({ route_policy: "1", keys: ["zdr"] })], ok({ support: lists(["zdr"], ["weights", "prompt"], ["price", "latency", "throughput"]), keyPolicy: null })],
    ["C6", [reply({ route_policy: "1", sort: ["latency"], keys: ["only"] })], ok({ support: lists(["only"], ["weights", "prompt"], ["latency"]), keyPolicy: null })],
    // Lists and a bound policy that the body only inherits are not its members.
    ["C6", [reply(Object.assign(Object.create({ keys: ["zdr"], attest: [], sort: [] }), { route_policy: "1" }))], ok({ support: BASELINE_LISTS, keyPolicy: null })],
    ["C6", [reply(Object.assign(Object.create({ key_policy: "zdr" }), { route_policy: "1" }), false)], ok({ support: BASELINE_LISTS, keyPolicy: null })],
    // Repeated members, as JSON.parse decodes them.
    ["", [reply(json('{"route_policy":"1","keys":[],"keys":["zdr"]}'))], ok({ support: lists(["zdr"], ["weights", "prompt"], ["price", "latency", "throughput"]), keyPolicy: null })],
    ["", [reply(json('{"route_policy":"1","keys":["zdr"],"keys":[]}'))], ok({ support: lists([], ["weights", "prompt"], ["price", "latency", "throughput"]), keyPolicy: null })],
    ["", [reply(json('{"route_policy":"2","route_policy":"1","sort":["price"],"sort":[]}'))], ok({ support: lists(BASELINE_LISTS.keys, ["weights", "prompt"], []), keyPolicy: null })],
    ["C6", [reply(json('{"route_policy":"1","route_policy":"2"}'))], no("route_policy", 'is not the string "1"')],
    ["", [reply(json('{"route_policy":"1","sort":[],"sort":["price"]}'))], ok({ support: lists(BASELINE_LISTS.keys, ["weights", "prompt"], ["price"]), keyPolicy: null })],
    ...['{"route_policy":1}', '{"route_policy":1.00000000000000001}', '{"route_policy":0.99999999999999999}', '{"route_policy":1e0}'].map((text): [string, unknown[], unknown] => [
      "C6",
      [reply(json(text))],
      no("route_policy", 'is not the string "1"'),
    ]),
  ],
  { asPlainData: true },
);

const SPARSE_KEYS: unknown[] = ["zdr"];
SPARSE_KEYS.length = 3;
const SPARSE_ATTEST: unknown[] = [];
SPARSE_ATTEST.length = 1;
const NOT_VERSION = no("route_policy", 'is not the string "1"');
const underLists = (detail: string) => no("key_policy", `fails the order of checks under the reply's lists: ${detail}`);
const NO_DETECTION: [body: unknown, failure: unknown][] = [
  [null, no(null, "not a JSON object")],
  [[], no(null, "not a JSON object")],
  ["text", no(null, "not a JSON object")],
  [{}, NOT_VERSION],
  [{ route_policy: 1 }, NOT_VERSION],
  [{ route_policy: "1.0" }, NOT_VERSION],
  [{ route_policy: "2" }, NOT_VERSION],
  [{ route_policy: " 1" }, NOT_VERSION],
  [{ route_policy: true }, NOT_VERSION],
  [{ route_policy: ["1"] }, NOT_VERSION],
  [Object.create({ route_policy: "1" }), NOT_VERSION],
  [{ route_policy: "1", keys: "zdr" }, no("keys", "is not a list of keys")],
  [{ route_policy: "1", keys: ["bits", "bad key"] }, no("keys", "is not a list of keys")],
  [{ route_policy: "1", keys: ["a.b"] }, no("keys", "is not a list of keys")],
  [{ route_policy: "1", keys: [1] }, no("keys", "is not a list of keys")],
  [{ route_policy: "1", keys: SPARSE_KEYS }, no("keys", "is not a list of keys")],
  [{ route_policy: "1", attest: SPARSE_ATTEST }, no("attest", "is not a list of items")],
  [{ route_policy: "1", sort: [1] }, no("sort", "is not a list of items")],
  [{ route_policy: "1", sort: ["a,b"] }, no("sort", "is not a list of items")],
  [{ route_policy: "1", attest: {} }, no("attest", "is not a list of items")],
  [{ route_policy: "1", attest: ["Weights"] }, no("attest", "is not a list of items")],
  [{ route_policy: "1", key_policy: 5 }, no("key_policy", "is not a string")],
  [{ route_policy: "1", key_policy: "" }, underLists('malformed key in ""')],
  [{ route_policy: "1", key_policy: "only=" }, underLists('malformed item ""')],
  [{ route_policy: "1", key_policy: "bits=0" }, underLists("takes one integer from 1 to 64")],
  [{ route_policy: "1", keys: [], key_policy: "zdr" }, underLists("key not listed")],
  [{ route_policy: "1", keys: ["zdr"], key_policy: "zdr+notrain" }, underLists("key not listed")],
  [{ route_policy: "1", sort: ["price"], key_policy: "sort=latency" }, underLists("value not accepted")],
  [{ route_policy: "1", attest: ["weights"], key_policy: "attest=prompt" }, underLists("value not accepted")],
  [{ route_policy: "1", key_policy: "region=ab" }, underLists("takes a list of assigned ISO 3166-1 alpha-2 codes")],
  [{ route_policy: "1", key_policy: "later" }, underLists("key not listed")],
  [{ route_policy: "1", key_policy: "zdr+zdr" }, underLists("repeated key")],
  [{ route_policy: "1", key_policy: "only=a+only=b" }, underLists("repeated key")],
  [{ route_policy: "1", key_policy: "only=a,a" }, underLists("repeated item")],
  [{ route_policy: "1", key_policy: "sort=price+sort=price" }, underLists("repeated key")],
  [{ route_policy: "1", key_policy: "zdr+notrain+zdr" }, underLists("repeated key")],
];
table(parseDetection, NO_DETECTION.map(([body, failure]): [string, unknown[], unknown] => ["C6", [reply(body)], failure]));
const STATUSES = [201, 204, 206, 301, 304, 400, 401, 403, 404, 500, 503, 0, 2000, Number.NaN];
for (const credentialed of [true, false]) {
  table(
    parseDetection,
    [
      ["C6", [{ status: 200, body: { route_policy: "1" }, credentialed }], ok({ support: BASELINE_LISTS, keyPolicy: null })],
      ...STATUSES.map((status): [string, unknown[], unknown] => ["C6", [{ status, body: { route_policy: "1" }, credentialed }], no(null, `status is ${status}, not 200`)]),
    ],
    { asPlainData: true },
  );
}

const NEWER_SUPPORT = detected(reply({ route_policy: "1", keys: ["zdr", "later", "sort", "attest"], attest: ["weights", "later"], sort: ["price", "later"], key_policy: "zdr+later=x+sort=later+attest=later" }));
const NONE_SUPPORT = detected(reply({ route_policy: "1", keys: [], attest: [], sort: [] }));
const NO_VALUES_SUPPORT = detected(reply({ route_policy: "1", attest: [], sort: [] }));
const MINIMAL_SUPPORT = detected(reply({ route_policy: "1", extra: { anything: true } }));
table(supports, [
  ["C6", [MINIMAL_SUPPORT, pol("attest=weights,prompt+sort=throughput")], true],
  ["C1 C6", [NONE_SUPPORT, pol("zdr")], false],
  ["C1 C6", [NO_VALUES_SUPPORT, pol("attest=weights")], false],
  ["C1 C6", [NO_VALUES_SUPPORT, pol("sort=price")], false],
  ["C6", [NO_VALUES_SUPPORT, pol("zdr+order=a")], true],
  ["", [NEWER_SUPPORT, pol("zdr")], true],
  ["C1", [NEWER_SUPPORT, pol("notrain")], false],
]);
table(parsePolicy, [
  ["C6 G21", ["zdr", NONE_SUPPORT], no("zdr", "key not accepted")],
  ["C6", ["zdr+later=x+sort=later+attest=later", NEWER_SUPPORT], no("later", "key not accepted")],
  ["C6", ["later=slow", detected(reply({ route_policy: "1", keys: ["zdr", "later"], key_policy: "later=slow" }))], no("later", "key not accepted")],
]);

const PARTIAL: [tags: string, body: Record<string, unknown>, policy: string, cleared: boolean][] = [
  ["C6", { keys: ["attest", "sort"] }, "attest=prompt", true],
  ["C6", { keys: ["attest", "sort"] }, "attest=weights+sort=throughput", true],
  ["C6", { keys: ["attest", "sort"] }, "attest=weights+sort=price", true],
  ["C6", { keys: ["attest"], sort: ["price"] }, "attest=weights,prompt", true],
  ["C1", { keys: ["attest"], attest: ["weights"] }, "attest=prompt", false],
  ["C6", { attest: ["weights"] }, "zdr+sort=latency", true],
  ["C6", { attest: ["weights"] }, "only=a+ignore=b+order=c", true],
  ["C1", { attest: ["weights"] }, "attest=prompt", false],
  ["C6", { sort: ["price"] }, "attest=prompt", true],
  ["C1", { sort: ["price"] }, "zdr+sort=latency", false],
  ["", { keys: ["zdr"] }, "zdr", true],
  ["C1", { keys: ["zdr"] }, "attest=prompt", false],
  ["", { keys: ["only"], sort: ["latency"] }, "only=a", true],
  ["C1", { keys: ["only"], sort: ["latency"] }, "only=a+sort=latency", false],
  ["", { keys: ["only", "sort"], sort: ["latency"] }, "only=a+sort=latency", true],
  ["C1", { keys: ["only", "sort"], sort: ["latency"] }, "only=a+sort=price", false],
];
table(
  clearedToSend,
  PARTIAL.map(([tags, body, text, cleared]): [string, unknown[], unknown] => [tags, [detected(reply({ route_policy: "1", ...body })), [pol(text)]], cleared]),
);
table(clearedToSend, [["C6", [detected(reply({ route_policy: "1" }, false)), [pol("zdr")]], true]]);

const DETECTION_SUPPORT = sup(["zdr", "sort", "attest"], ["prompt"], ["latency", "price"]);
table(formatDetection, [
  ["G20", [DETECTION_SUPPORT, "zdr+sort=latency"], { route_policy: "1", keys: ["zdr", "sort", "attest"], attest: ["prompt"], sort: ["latency", "price"], key_policy: "zdr+sort=latency" }],
  ["G20", [DETECTION_SUPPORT], { route_policy: "1", keys: ["zdr", "sort", "attest"], attest: ["prompt"], sort: ["latency", "price"] }],
  ["G20", [DETECTION_SUPPORT, null], { route_policy: "1", keys: ["zdr", "sort", "attest"], attest: ["prompt"], sort: ["latency", "price"] }],
  ["G20", [sup([], [], [])], { route_policy: "1", keys: [], attest: [], sort: [] }],
  ["G20", [BASELINE], { route_policy: "1", ...BASELINE_LISTS }],
  ...(
    [
      ["bits=0", "key not accepted"],
      ["", 'malformed key in ""'],
      ["notrain", "key not accepted"],
      ["sort=throughput", "value not accepted"],
      ["attest=weights", "value not accepted"],
      ["zdr+zdr", "repeated key"],
      ["later", "key not accepted"],
    ] as const
  ).map(([bound, detail]): [string, unknown[], unknown] => ["G22 G36", [DETECTION_SUPPORT, bound], throws("RangeError", `key policy "${bound}" fails the order of checks: ${detail}`)]),
  ...(
    [
      [sup(["zdr", "bad key"], BASELINE_LISTS.attest, BASELINE_LISTS.sort), "keys holds what this revision does not define: bad key"],
      [sup(["zdr", "later"], BASELINE_LISTS.attest, BASELINE_LISTS.sort), "keys holds what this revision does not define: later"],
      [sup(BASELINE_LISTS.keys, ["weights", "custom"], BASELINE_LISTS.sort), "attest holds what this revision does not define: custom"],
      [sup(BASELINE_LISTS.keys, ["Weights"], BASELINE_LISTS.sort), "attest holds what this revision does not define: Weights"],
      [sup(BASELINE_LISTS.keys, BASELINE_LISTS.attest, ["price", "a,b"]), "sort holds what this revision does not define: a,b"],
      [sup(BASELINE_LISTS.keys, BASELINE_LISTS.attest, ["cheapest"]), "sort holds what this revision does not define: cheapest"],
    ] as const
  ).flatMap(([bad, message]): [string, unknown[], unknown][] => [
    ["G20", [bad], throws("RangeError", message)],
    ["G20", [bad, "zdr"], throws("RangeError", message)],
  ]),
  ["G20", [{ keys: new Set([undefined, "zdr"]), attest: new Set(), sort: new Set() }], throws("RangeError", "keys holds what this revision does not define: undefined")],
  ["G20", [{ keys: new Set(["zdr"]), attest: new Set([null]), sort: new Set() }], throws("RangeError", "attest holds what this revision does not define: null")],
  ["G20", [{ keys: new Set(["zdr"]), attest: new Set(), sort: new Set([undefined]) }], throws("RangeError", "sort holds what this revision does not define: undefined")],
]);
const formatted = (bound: string): Code => new Code(`JSON.parse(JSON.stringify(formatDetection(${show(DETECTION_SUPPORT)}, ${show(bound)})))`, () => JSON.parse(JSON.stringify(formatDetection(DETECTION_SUPPORT, bound))));
table(
  parseDetection,
  ["zdr+sort=latency", "zdr", "attest=prompt", "sort=price+zdr"].map((bound): [string, unknown[], unknown] => [
    "G20",
    [reply(formatted(bound))],
    ok({ support: lists(["zdr", "attest", "sort"], ["prompt"], ["price", "latency"]), keyPolicy: bound }),
  ]),
  { asPlainData: true },
);

const ZDR_SORT_ONLY = sup(["zdr", "sort", "only"], [], ["price"]);
table(clearedToSend, [
  ["C2", [null, []], true],
  ["C2", [null, [pol("sort=latency")]], true],
  ["C2", [null, [pol("sort=latency"), pol("order=a")]], true],
  ["C2", [null, [pol("order=a")]], true],
  ["C2", [ZDR_SORT_ONLY, [pol("sort=latency")]], true],
  ["C2", [sup([], [], []), [pol("sort=latency+order=a")]], true],
  ["C1", [null, [pol("zdr")]], false],
  ["", [ZDR_SORT_ONLY, [pol("zdr")]], true],
  ["C1", [ZDR_SORT_ONLY, [pol("notrain")]], false],
  ["", [ZDR_SORT_ONLY, [pol("zdr+sort=price")]], true],
  ["C1", [ZDR_SORT_ONLY, [pol("zdr+sort=latency")]], false],
  ["C1", [ZDR_SORT_ONLY, [pol("zdr"), pol("sort=latency")]], false],
  ["C1", [ZDR_SORT_ONLY, [pol("sort=latency"), pol("zdr")]], false],
  ["C1", [ZDR_SORT_ONLY, [pol("zdr"), pol("order=a")]], false],
  ["", [ZDR_SORT_ONLY, [pol("zdr"), pol("sort=price")]], true],
  ["", [ZDR_SORT_ONLY, [pol("sort=price"), pol("only=a")]], true],
  ["C1", [null, [pol("sort=price"), pol("only=a")]], false],
  ["C1", [ZDR_SORT_ONLY, [pol("zdr+sort=latency"), pol("sort=price")]], false],
]);
table(supports, [["", [ZDR_SORT_ONLY, comb({ header: "zdr+sort=latency", suffix: "sort=price" })], true]]);

// ---- publishedRoutes (C4). ----

const THIRTEEN = [
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
];
const EVIDENCE = "https://basalt.example/attestation";
const AURORA_EVIDENCE = "https://aurora.example/attestation";
const ATTEST_ROWS = [
  { provider: "basalt", facts: "bits=16+region=us,de+attest=weights,prompt", evidence: EVIDENCE },
  { provider: "aurora", facts: "zdr+attest=weights", evidence: AURORA_EVIDENCE },
  { provider: "silent", facts: "attest=weights,prompt" },
];
const PRE_SEND_ROWS = [
  { provider: "aurora", facts: "zdr+notrain+bits=8+region=us" },
  { provider: "basalt", facts: "bits=16+region=ca" },
  { provider: "broken", facts: "zdr+region=de+bits=0" },
  { provider: "twice", facts: "zdr+region=fr" },
  { provider: "twice", facts: "zdr+region=fr" },
];
const OUTCOME_ROWS = [
  { provider: "aurora", facts: "zdr+notrain+bits=8+region=us" },
  { provider: "basalt", facts: "bits=16+region=us,de+attest=weights,prompt", evidence: EVIDENCE },
  { provider: "cobalt", facts: "" },
  { provider: "delta", facts: "zdr+region=us,de" },
  { provider: "echo", facts: "region=us" },
  { provider: "newer", facts: "newflag+zdr+region=us" },
  { provider: "broken", facts: "zdr+region=us+bits=0" },
  { provider: "twice", facts: "zdr+region=us" },
  { provider: "twice", facts: "zdr+region=us" },
];
const LATER_ROWS = [
  { provider: "broken", facts: "zdr+bits=0" },
  { provider: "twice", facts: "zdr" },
  { provider: "twice", facts: "zdr" },
  { provider: "cobalt", facts: "" },
  { provider: "aurora", facts: "zdr" },
];
const P_ZDR = [{ provider: "p", facts: "zdr" }];
const P_ZDR_PUBLISHED = [["p", { facts: F({ zdr: true }), evidence: null }]];

table(
  publishedRoutes,
  [
    [
      "C4",
      [{ data: [{ id: "m", routes: THIRTEEN }] }, "m"],
      [
        ["aurora", { facts: F({ zdr: true, notrain: true, bits: 8, region: ["us"] }), evidence: null }],
        ["basalt", { facts: F({ bits: 16, attest: ["weights", "prompt"] }), evidence: EVIDENCE }],
        ["cobalt", { facts: F(), evidence: null }],
        ["broken", null],
        ["nofacts", null],
        ["twice", null],
        ["badevidence", { facts: F({ attest: ["weights"] }), evidence: null }],
        ["newer", { facts: F({ zdr: true, attest: ["weights"] }), evidence: null }],
      ],
    ],
    [
      "C4",
      [{ data: [{ id: "m", routes: ATTEST_ROWS }] }, "m"],
      [
        ["basalt", { facts: F({ bits: 16, region: ["us", "de"], attest: ["weights", "prompt"] }), evidence: EVIDENCE }],
        ["aurora", { facts: F({ zdr: true, attest: ["weights"] }), evidence: AURORA_EVIDENCE }],
        ["silent", { facts: F({ attest: ["weights", "prompt"] }), evidence: null }],
      ],
    ],
    [
      "C4",
      [{ data: [{ id: "m", routes: PRE_SEND_ROWS }] }, "m"],
      [
        ["aurora", { facts: F({ zdr: true, notrain: true, bits: 8, region: ["us"] }), evidence: null }],
        ["basalt", { facts: F({ bits: 16, region: ["ca"] }), evidence: null }],
        ["broken", null],
        ["twice", null],
      ],
    ],
    [
      "C4",
      [{ data: [{ id: "m", routes: LATER_ROWS }] }, "m"],
      [
        ["broken", null],
        ["twice", null],
        ["cobalt", { facts: F(), evidence: null }],
        ["aurora", { facts: F({ zdr: true }), evidence: null }],
      ],
    ],
    ["C4", [{ data: [{ id: "m", routes: [{ provider: "p", facts: "zdr" }, { provider: "p", facts: "zdr" }, { provider: "p", facts: "zdr" }] }] }, "m"], [["p", null]]],
    ["C4", [{ data: [{ id: "m", routes: [Object.create({ provider: "p", facts: "zdr" })] }] }, "m"], []],
    ["C4", [{ data: [{ id: "m", routes: [{ provider: "p", facts: 5 }] }] }, "m"], [["p", null]]],
    ["C4", [{ data: [{ id: "m", routes: [{ provider: "p", facts: null }] }] }, "m"], [["p", null]]],
    ["C4", [{ data: [{ id: "m", routes: [{ provider: "p", facts: true }] }] }, "m"], [["p", null]]],
    ["C4", [{ data: { length: 1, 0: { id: "m", routes: P_ZDR } } }, "m"], []],
    ["", [{ data: [Object.assign(() => undefined, { id: "m", routes: P_ZDR })] }, "m"], []],
    ...[undefined, null, "routes", 5, [], "not-a-list"].map((none): [string, unknown[], unknown] => ["", [{ data: [{ id: "m", routes: none }] }, "m"], []]),
    ["C4", [{ data: [{ id: "m", routes: { 0: { provider: "p", facts: "zdr" } } }] }, "m"], []],
  ],
  { asPlainData: true },
);

// The model a request names, among others in the list.
const M_N_LIST = {
  data: [
    { id: "m", routes: [{ provider: "p", facts: "zdr" }] },
    { id: "m+zdr", routes: [{ provider: "p", facts: "notrain" }] },
    { id: "n", routes: [{ provider: "p", facts: "notrain" }] },
  ],
};
const TARGET = { id: "m", routes: P_ZDR };
const SIBLINGS: unknown[][] = [
  [null, TARGET],
  [TARGET, "text", 5, []],
  [{ id: "other", routes: 7 }, TARGET],
  [{ id: "twin", routes: [] }, { id: "twin", routes: [] }, TARGET],
  [{ routes: [{ provider: "p", facts: "notrain" }] }, TARGET],
  [{ id: ["m"], routes: [{ provider: "p", facts: "notrain" }] }, TARGET],
];
// Lists that publish no routes for m, each with the ids its publishedRoutes row is tagged with.
const NO_ROUTES_FOR_M: [tags: string, list: unknown][] = [
  ["C4", { data: [{ id: "m", routes: P_ZDR }, { id: "m", routes: [{ provider: "p", facts: "notrain" }] }] }],
  ["C4", { data: [{ id: "m", routes: P_ZDR }, { id: "m", routes: P_ZDR }] }],
  ["C4", { data: [{ id: "other", routes: P_ZDR }] }],
  ["", { data: [] }],
  ["", { data: [{ id: "m" }] }],
  ["", { data: [{ id: "m", routes: {} }] }],
  ["", { data: [{ id: "m", routes: "p" }] }],
  ["C4", { data: { id: "m", routes: P_ZDR } }],
  ["C4", [{ id: "m", routes: P_ZDR }]],
  ["C4", { models: [{ id: "m", routes: P_ZDR }] }],
  ["C4", Object.create({ data: [{ id: "m", routes: P_ZDR }] })],
  ["C4", { data: [Object.create({ id: "m", routes: P_ZDR })] }],
  ["C4", { data: [{ id: ["m"], routes: P_ZDR }] }],
  ["", null],
  ["", "text"],
];
const OTHER_FIRST = { object: "list", data: [{ id: "other", routes: [{ provider: "q", facts: "notrain" }] }, { id: "m", routes: P_ZDR }] };
const OTHER_AFTER = { data: [{ id: "m", routes: P_ZDR }, { id: "other", routes: [{ provider: "q", facts: "notrain" }] }] };
const EMPTY_ID = { data: [{ id: "", routes: P_ZDR }] };
const DUPLICATED_LIST = json('{"data":[],"data":[{"id":"x","id":"m","routes":[],"routes":[{"provider":"q","provider":"p","facts":"notrain","facts":"zdr"}]}]}');
const DUPLICATED_REVERSED = json('{"data":[{"id":"m","routes":[{"provider":"p","facts":"zdr"}]}],"data":[{"id":"m","id":"x","routes":[{"provider":"p","facts":"zdr"}]},{"id":"n","routes":[{"provider":"q","facts":"notrain"}]}]}');

table(
  publishedRoutes,
  [
    ...["m", "m+zdr", "m+zdr+sort=price", "m+"].map((model): [string, unknown[], unknown] => ["C4", [M_N_LIST, model], P_ZDR_PUBLISHED]),
    ["C4", [M_N_LIST, "n"], [["p", { facts: F({ notrain: true }), evidence: null }]]],
    ["C4", [M_N_LIST, "n+sort=price"], [["p", { facts: F({ notrain: true }), evidence: null }]]],
    ["C4", [{ data: [{ id: "m+zdr", routes: P_ZDR }] }, "m+zdr"], []],
    ...SIBLINGS.map((data): [string, unknown[], unknown] => ["C4", [{ data }, "m"], P_ZDR_PUBLISHED]),
    ...NO_ROUTES_FOR_M.map(([tags, list]): [string, unknown[], unknown] => [tags, [list, "m"], []]),
    ["C4", [OTHER_FIRST, "m"], P_ZDR_PUBLISHED],
    ["C4", [OTHER_AFTER, "m"], P_ZDR_PUBLISHED],
    ["C4", [OTHER_FIRST, "other"], [["q", { facts: F({ notrain: true }), evidence: null }]]],
    ...["", "+zdr", "+"].map((model): [string, unknown[], unknown] => ["C4", [EMPTY_ID, model], []]),
    ["", [DUPLICATED_LIST, "m"], P_ZDR_PUBLISHED],
    ["C4", [DUPLICATED_REVERSED, "m"], []],
    ["C4", [DUPLICATED_REVERSED, "n"], [["q", { facts: F({ notrain: true }), evidence: null }]]],
  ],
  { asPlainData: true },
);

// ---- readOutcome and readRefusal (C3, C4, C5). ----

const OUTCOME = routes(OUTCOME_ROWS);
const ZDR_US = pol("zdr+region=us");
const AURORA = H(["provider=aurora"]);

// The facts aurora publishes decide, wherever aurora stands and whatever the other route publishes.
const AURORA_CASES: [facts: string, met: boolean][] = [
  ["zdr+region=us", true],
  ["newflag+zdr+region=us", true],
  ["region=us", false],
  ["zdr", false],
];
table(readOutcome, [
  ...AURORA_CASES.flatMap(([read, met]): [string, unknown[], unknown][] => {
    const expected = met ? honored("aurora", null, true) : missesPolicy("aurora");
    const opposite = { provider: "basalt", facts: met ? "" : "zdr+region=us" };
    return [
      ["C4", [AURORA, ZDR_US, routes([opposite, { provider: "aurora", facts: read }])], expected],
      ...(met ? [["C4", [AURORA, ZDR_US, routes([{ provider: "basalt", facts: "zdr+region=us" }, { provider: "aurora", facts: read }])], expected] as [string, unknown[], unknown]] : []),
      ["C4", [AURORA, ZDR_US, routes([{ provider: "aurora", facts: read }, opposite])], expected],
    ];
  }),
  ["C4", [AURORA, ZDR_US, routes([{ provider: "basalt", facts: "zdr+region=us" }])], unpublished("aurora")],
  ["C4", [AURORA, ZDR_US, routes([{ provider: "basalt", facts: "" }])], unpublished("aurora")],
  ["C4", [AURORA, ZDR_US, OUTCOME], honored("aurora", null, true)],
  ["C4", [H(["provider=newer"]), ZDR_US, OUTCOME], honored("newer", null, true)],
  ...(
    [
      [[], "no Route-Applied"],
      [["provider=aurora", "provider=basalt"], "more than one Route-Applied"],
      [["provider=aurora", "provider=aurora"], "more than one Route-Applied"],
      [["provider=aurora, provider=aurora"], "Route-Applied is not valid: is not exactly one provider id"],
      [["provider=aurora,provider=aurora"], "Route-Applied is not valid: is not exactly one provider id"],
      [["provider=aurora,aurora"], "Route-Applied is not valid: is not exactly one provider id"],
      [["aurora"], "Route-Applied is not valid: does not begin with the provider"],
      [[""], "Route-Applied is not valid: does not begin with the provider"],
    ] as const
  ).map(([lines, why]): [string, unknown[], unknown] => ["C3", [H([...lines]), ZDR_US, OUTCOME], notHonored(why)]),
  ["C4", [H(["provider=cobalt"]), ZDR_US, OUTCOME], missesPolicy("cobalt")],
  ["C4", [H(["provider=delta"]), ZDR_US, OUTCOME], missesPolicy("delta")],
  ["C4", [H(["provider=echo"]), ZDR_US, OUTCOME], missesPolicy("echo")],
  ["C4", [H(["provider=broken"]), ZDR_US, OUTCOME], unusable("broken")],
  ["C4", [H(["provider=twice"]), ZDR_US, OUTCOME], unusable("twice")],
  ["C4", [H(["provider=nosuch"]), ZDR_US, OUTCOME], unpublished("nosuch")],
  ["C4", [AURORA, pol("zdr+bits=16"), OUTCOME], missesPolicy("aurora")],
  ["C4", [AURORA, pol("zdr+bits=8"), OUTCOME], honored("aurora", null, true)],
  ["C4", [H(["provider=cobalt"]), pol("only=cobalt"), OUTCOME], honored("cobalt", null, true)],
  ["C4", [H(["provider=cobalt"]), pol("only=cobalt"), routes(OUTCOME_ROWS.filter((row) => row.provider !== "cobalt"))], unpublished("cobalt")],
  ["C4", [H(["provider=cobalt"]), pol("only=cobalt"), routes([{ provider: "cobalt", facts: "bits=0" }])], unusable("cobalt")],
  ["C4", [H(["provider=cobalt"]), pol("only=cobalt"), routes([{ provider: "cobalt", facts: "" }, { provider: "cobalt", facts: "" }])], unusable("cobalt")],
  ["C4", [AURORA, pol("only=cobalt"), OUTCOME], missesPolicy("aurora")],
  ["C4", [AURORA, pol("zdr+ignore=aurora"), OUTCOME], missesPolicy("aurora")],
  ["C4", [H(["provider=broken"]), pol("only=broken"), OUTCOME], unusable("broken")],
  ["C4", [H(["provider=twice"]), pol("only=twice"), OUTCOME], unusable("twice")],
  ...[[], {}, "not-a-list", undefined].flatMap((none): [string, unknown[], unknown][] => [
    ["C4", [AURORA, ZDR_US, routes(none)], unpublished("aurora")],
    ["C4", [AURORA, pol("only=aurora"), routes(none)], unpublished("aurora")],
  ]),
  ["", [AURORA, ZDR_US, null], honored("aurora", null, false)],
  ["", [AURORA, pol("only=cobalt,aurora"), null], honored("aurora", null, false)],
  ["", [AURORA, pol("ignore=cobalt,basalt"), null], honored("aurora", null, false)],
  ["C3", [AURORA, pol("only=cobalt"), null], excluded("aurora")],
  ["C3", [AURORA, pol("zdr+ignore=aurora"), null], excluded("aurora")],
  ["C3", [AURORA, pol("ignore=cobalt,aurora"), null], excluded("aurora")],
  ["C3", [H(["provider=aurora", "provider=aurora"]), ZDR_US, null], notHonored("more than one Route-Applied")],
  ["C3", [H([]), ZDR_US, null], notHonored("no Route-Applied")],
  ["C5", [H([], ["reason=unsupported+key=bits"]), ZDR_US, OUTCOME], refused("unsupported", "bits")],
  ["C5", [H([], ["reason=unavailable"]), ZDR_US, OUTCOME], refused("unavailable", null)],
  ["C5", [H([], ["garbage"]), ZDR_US, OUTCOME], refused(null, null)],
  ["C5", [H([], ["reason=unsupported", "reason=unavailable"]), ZDR_US, OUTCOME], refused(null, null)],
  ["C5", [H(["provider=aurora"], ["reason=unsatisfiable"]), ZDR_US, OUTCOME], refused("unsatisfiable", null)],
  ["C5", [H(["provider=aurora"], [""]), ZDR_US, OUTCOME], refused(null, null)],
]);

// attest: Route-Evidence must be one valid URI, and with the model list the one published for the applied route.
const ATTEST = routes(ATTEST_ROWS);
const BOTH = pol("attest=weights,prompt");
const basalt = (evidence: string[]) => H(["provider=basalt"], [], evidence);
const INVALID_EVIDENCE = [
  [],
  [EVIDENCE, EVIDENCE],
  [`${EVIDENCE}, ${EVIDENCE}`],
  [`${EVIDENCE},${EVIDENCE}`],
  ["/attestation"],
  ["not a uri"],
  [""],
  ["https://[::1"],
  ["https://a@b@basalt.example/attestation"],
  ["https://basalt.example/%GG"],
  ["http://basalt.example/attestation"],
  ["HTTPS://basalt.example/attestation"],
];
const OTHER_URIS = ["https://elsewhere.example/attestation", "https://basalt.example/other", "https://basalt.example/attestation/", "https://basalt.example:443/attestation", "https://basalt.example/attestation?x=1"];
const BASALT_FULL = "bits=16+region=us,de+attest=weights,prompt";
const OTHER_URI = "https://basalt.example/other";
table(readOutcome, [
  ["C4", [basalt([EVIDENCE]), BOTH, ATTEST], honored("basalt", EVIDENCE, true)],
  ["", [basalt([EVIDENCE]), BOTH, null], honored("basalt", EVIDENCE, false)],
  ...INVALID_EVIDENCE.flatMap((evidence): [string, unknown[], unknown][] => [
    ["C3", [basalt(evidence), BOTH, ATTEST], NO_EVIDENCE],
    ["C3", [basalt(evidence), BOTH, null], NO_EVIDENCE],
  ]),
  ...OTHER_URIS.flatMap((uri): [string, unknown[], unknown][] => [
    ["C4", [basalt([uri]), BOTH, ATTEST], otherEvidence("basalt")],
    ["", [basalt([uri]), BOTH, null], honored("basalt", uri, false)],
  ]),
  ["C4", [H(["provider=silent"], [], [EVIDENCE]), BOTH, ATTEST], otherEvidence("silent")],
  ["C4", [H(["provider=aurora"], [], [AURORA_EVIDENCE]), BOTH, ATTEST], missesPolicy("aurora")],
  ["C4", [H(["provider=aurora"], [], [AURORA_EVIDENCE]), pol("attest=weights"), ATTEST], honored("aurora", AURORA_EVIDENCE, true)],
  ["", [H(["provider=aurora"]), pol("zdr"), ATTEST], honored("aurora", null, true)],
  ["", [H(["provider=aurora"], [], [EVIDENCE]), pol("zdr"), ATTEST], honored("aurora", null, true)],
  // The response stays the same; only the list changes.
  ["C4", [basalt([EVIDENCE]), BOTH, routes(ATTEST_ROWS.slice(1))], unpublished("basalt")],
  ["C4", [basalt([EVIDENCE]), BOTH, routes([{ provider: "basalt", facts: "attest=weights", evidence: EVIDENCE }])], missesPolicy("basalt")],
  ["C4", [basalt([EVIDENCE]), BOTH, routes([{ provider: "basalt", facts: "bits=16+region=us,de", evidence: EVIDENCE }])], missesPolicy("basalt")],
  ["C4", [basalt([EVIDENCE]), BOTH, routes([{ provider: "basalt", facts: BASALT_FULL, evidence: OTHER_URI }])], otherEvidence("basalt")],
  ["C4", [basalt([EVIDENCE]), BOTH, routes([{ provider: "basalt", facts: BASALT_FULL }])], otherEvidence("basalt")],
  ["C4", [basalt([EVIDENCE]), BOTH, routes([{ provider: "basalt", facts: BASALT_FULL, evidence: "bad URI" }])], otherEvidence("basalt")],
  ["C4", [basalt([EVIDENCE]), BOTH, routes([{ provider: "basalt", facts: BASALT_FULL, evidence: EVIDENCE }])], honored("basalt", EVIDENCE, true)],
  ["C4", [basalt([EVIDENCE]), BOTH, routes([{ provider: "aurora", facts: BASALT_FULL, evidence: EVIDENCE }, { provider: "basalt", facts: "attest=weights", evidence: EVIDENCE }])], missesPolicy("basalt")],
  ["C4", [basalt([OTHER_URI]), BOTH, routes([{ provider: "basalt", facts: BASALT_FULL, evidence: OTHER_URI }])], honored("basalt", OTHER_URI, true)],
  ["C4", [basalt([OTHER_URI]), BOTH, routes([{ provider: "aurora", facts: "zdr+attest=weights", evidence: EVIDENCE }, { provider: "basalt", facts: BASALT_FULL, evidence: OTHER_URI }])], honored("basalt", OTHER_URI, true)],
  ["C4", [basalt([EVIDENCE]), BOTH, routes([{ provider: "aurora", facts: "zdr+attest=weights", evidence: EVIDENCE }, { provider: "basalt", facts: BASALT_FULL, evidence: OTHER_URI }])], otherEvidence("basalt")],
  ["C4", [basalt([EVIDENCE]), BOTH, routes([{ provider: "basalt", facts: BASALT_FULL, evidence: EVIDENCE }, { provider: "aurora", facts: "zdr+attest=weights", evidence: OTHER_URI }])], honored("basalt", EVIDENCE, true)],
  ["C3", [basalt(["https://basalt.example/a b"]), BOTH, routes([{ provider: "basalt", facts: BASALT_FULL, evidence: EVIDENCE }])], NO_EVIDENCE],
]);

const BASALT_ATTESTS = routes([{ provider: "basalt", facts: "attest=weights,prompt", evidence: EVIDENCE }]);
table(readOutcome, [
  ...["attest=prompt", "attest=weights", "attest=weights,prompt", "zdr+attest=prompt"].flatMap((text): [string, unknown[], unknown][] => [
    ...(text === "attest=weights,prompt" ? [] : [["C3", [basalt([]), pol(text), null], NO_EVIDENCE] as [string, unknown[], unknown]]),
    ["C3", [basalt([]), pol(text), BASALT_ATTESTS], NO_EVIDENCE],
  ]),
  ["C4", [basalt([]), pol("only=basalt"), BASALT_ATTESTS], honored("basalt", null, true)],
  ["C4", [basalt([]), pol("only=basalt"), routes([{ provider: "aurora", facts: "attest=weights,prompt", evidence: EVIDENCE }])], unpublished("basalt")],
  ["C4", [basalt([]), pol("only=basalt"), routes([{ provider: "basalt", facts: "zdr=1" }])], unusable("basalt")],
  ["C4", [basalt([EVIDENCE]), pol("attest=prompt"), BASALT_ATTESTS], honored("basalt", EVIDENCE, true)],
  ["", [basalt([EVIDENCE]), pol("attest=weights"), null], honored("basalt", EVIDENCE, false)],
  ["C4", [basalt([EVIDENCE]), pol("attest=prompt"), routes([{ provider: "basalt", facts: "attest=weights,prompt" }])], otherEvidence("basalt")],
  ["C4", [basalt([EVIDENCE]), pol("attest=prompt"), routes([{ provider: "basalt", facts: "attest=weights,prompt", evidence: "bad URI" }])], otherEvidence("basalt")],
]);

// Combinations no route can meet.
const P_RESPONSE = H(["provider=p"]);
const P_IT_JP = routes([{ provider: "p", facts: "zdr+region=it,jp" }]);
const IT_JP = comb({ header: "region=it", suffix: "region=jp" });
table(readOutcome, [
  ["C3", [P_RESPONSE, IT_JP, null], EMPTY_COMBINATION],
  ["C3", [P_RESPONSE, IT_JP, P_IT_JP], EMPTY_COMBINATION],
  ["C3", [P_RESPONSE, EMPTY_ONLY_PQ, null], excluded("p")],
  ["G12", [P_RESPONSE, EMPTY_ONLY_PQ, P_IT_JP], missesPolicy("p")],
  ["C3", [H(["provider=q"]), EMPTY_ONLY_PQ, null], excluded("q")],
  ["", [P_RESPONSE, pol("only=p"), null], honored("p", null, false)],
  ["", [H(["provider=q"]), pol("only=q"), null], honored("q", null, false)],
  ["C4", [P_RESPONSE, pol("region=it,jp"), P_IT_JP], honored("p", null, true)],
  ["C5", [H(["provider=p"], ["reason=unsatisfiable"]), IT_JP, null], refused("unsatisfiable", null)],
]);

// The model the request names, looked up in the list.
const ZDR = pol("zdr");
const NOTRAIN = pol("notrain");
table(readOutcome, [
  ...["m", "m+zdr", "m+zdr+sort=price", "m+"].flatMap((model): [string, unknown[], unknown][] => [
    ["C4", [P_RESPONSE, ZDR, listed(M_N_LIST, model)], honored("p", null, true)],
    ["C4", [P_RESPONSE, NOTRAIN, listed(M_N_LIST, model)], missesPolicy("p")],
  ]),
  ["C4", [P_RESPONSE, ZDR, listed(M_N_LIST, "n")], missesPolicy("p")],
  ["C4", [P_RESPONSE, NOTRAIN, listed(M_N_LIST, "n+sort=price")], honored("p", null, true)],
  ...SIBLINGS.flatMap((data): [string, unknown[], unknown][] => [
    ["C4", [P_RESPONSE, ZDR, listed({ data }, "m")], honored("p", null, true)],
    ["C4", [P_RESPONSE, ZDR, listed({ data: data.map((entry) => (entry === TARGET ? { id: "m", routes: [{ provider: "p", facts: "notrain" }] } : entry)) }, "m")], missesPolicy("p")],
    ["C4", [P_RESPONSE, ZDR, listed({ data: data.map((entry) => (entry === TARGET ? { id: "m", routes: [{ provider: "q", facts: "zdr" }] } : entry)) }, "m")], unpublished("p")],
  ]),
  ...NO_ROUTES_FOR_M.map(([, list]): [string, unknown[], unknown] => ["C4", [P_RESPONSE, ZDR, listed(list, "m")], unpublished("p")]),
  ["C4", [P_RESPONSE, ZDR, listed({ data: [TARGET] }, "m")], honored("p", null, true)],
  ["C4", [P_RESPONSE, ZDR, listed(OTHER_FIRST, "m")], honored("p", null, true)],
  ["C4", [H(["provider=q"]), ZDR, listed(OTHER_FIRST, "m")], unpublished("q")],
  ["C4", [P_RESPONSE, NOTRAIN, listed(OTHER_FIRST, "m")], missesPolicy("p")],
  ...["", "+zdr", "+"].map((model): [string, unknown[], unknown] => ["C4", [P_RESPONSE, ZDR, listed(EMPTY_ID, model)], unpublished("p")]),
  ["C4", [P_RESPONSE, ZDR, listed(DUPLICATED_LIST, "m")], honored("p", null, true)],
  ["C4", [P_RESPONSE, NOTRAIN, listed(DUPLICATED_LIST, "m")], missesPolicy("p")],
]);

table(readOutcome, [
  ["C5", [H([], ["reason=unsatisfiable"]), BOTH, null], refused("unsatisfiable", null)],
  ["C5", [H([], ["reason=unsatisfiable"]), BOTH, listed({ data: [] }, "m")], refused("unsatisfiable", null)],
  ["C5", [H(["provider=p"], ["garbage"]), BOTH, null], refused(null, null)],
]);
table(readRefusal, [
  ["C5", [H(["provider=aurora"])], null],
  ["C11", [H(["provider=aurora"], ["reason=unsupported+key=tier"])], { reason: "unsupported", key: "tier" }],
  ["C11", [H(["provider=aurora"], ["reason=unsatisfiable"])], { reason: "unsatisfiable", key: null }],
  ["C5", [H(["provider=aurora"], ["nonsense"])], { reason: null, key: null }],
  ["C5", [H(["provider=aurora"], [""])], { reason: null, key: null }],
  ["C5", [H(["provider=aurora"], ["reason=unsatisfiable", "reason=unsatisfiable"])], { reason: null, key: null }],
]);

// ---- someRouteMeets (C16). ----

const PRE_SEND = routes(PRE_SEND_ROWS);
const withoutRows = (...providers: string[]) => routes(PRE_SEND_ROWS.filter((row) => !providers.includes(row.provider)));
table(someRouteMeets, [
  ...["zdr", "zdr+region=us", "region=ca", "bits=16", "only=basalt", "ignore=aurora", "sort=price"].map((text): [string, unknown[], unknown] => ["C16", [PRE_SEND, pol(text)], true]),
  // The same catalog without the route that qualified.
  ["C16", [withoutRows("aurora"), pol("zdr")], false],
  ["C16", [withoutRows("aurora"), pol("zdr+region=us")], false],
  ["C16", [withoutRows("basalt"), pol("region=ca")], false],
  ["C16", [withoutRows("basalt"), pol("bits=16")], false],
  ["C16", [withoutRows("basalt"), pol("only=basalt")], false],
  ["", [withoutRows("basalt"), pol("ignore=aurora")], false],
  ["", [withoutRows("aurora", "basalt"), pol("sort=price")], false],
  ["C16", [withoutRows("basalt"), pol("sort=price")], true],
  ["C16", [withoutRows("aurora"), pol("sort=price")], true],
  ...["zdr+region=ca", "zdr+bits=16", "only=nosuch", "region=de", "region=fr", "only=broken", "only=twice"].map((text): [string, unknown[], unknown] => ["C16", [PRE_SEND, pol(text)], false]),
  ["", [PRE_SEND, pol("attest=weights")], false],
  ["C16 G12", [PRE_SEND, comb({ header: "region=us", suffix: "region=ca" })], false],
  ["C16", [PRE_SEND, pol("region=us")], true],
  // The same providers, published once each with valid facts.
  ["C16", [routes([{ provider: "broken", facts: "zdr+region=de" }, { provider: "twice", facts: "zdr+region=fr" }]), pol("only=broken")], true],
  ["C16", [routes([{ provider: "broken", facts: "zdr+region=de" }, { provider: "twice", facts: "zdr+region=fr" }]), pol("only=twice")], true],
  ["C16", [routes([{ provider: "broken", facts: "zdr+region=de" }, { provider: "twice", facts: "zdr+region=fr" }]), pol("region=de")], true],
  ["C16", [routes([{ provider: "broken", facts: "zdr+region=de" }, { provider: "twice", facts: "zdr+region=fr" }]), pol("region=fr")], true],
  ["", [routes([]), pol("sort=price")], false],
  ["", [PRE_SEND, copy(pol("zdr"))], NOT_A_POLICY],
  ["", [routes([]), copy(pol("zdr"))], NOT_A_POLICY],
]);

const LATER = routes(LATER_ROWS);
table(someRouteMeets, [
  ["C16", [LATER, pol("zdr")], true],
  ["C16", [LATER, pol("zdr+only=aurora")], true],
  ["C16", [LATER, pol("zdr+ignore=aurora")], false],
  ["C16", [LATER, pol("only=cobalt")], true],
  ["C16", [LATER, pol("zdr+only=cobalt")], false],
  ["C16", [LATER, pol("only=cobalt,aurora+zdr")], true],
]);
// The providers someRouteMeets reaches, in order, and its result.
const visiting: (published: ReadonlyMap<string, PublishedRoute | null>, policy: Policy) => unknown = (published, policy) => {
  const visited: string[] = [];
  const counting = new Map(published);
  Object.defineProperty(counting, Symbol.iterator, {
    value: function* () {
      for (const entry of published) {
        visited.push(entry[0]);
        yield entry;
      }
    },
  });
  return { result: someRouteMeets(counting, policy), visited };
};
table(visiting, [
  ["C16", [LATER, pol("only=cobalt")], { result: true, visited: ["broken", "twice", "cobalt"] }],
  ["C16", [LATER, pol("zdr")], { result: true, visited: ["broken", "twice", "cobalt", "aurora"] }],
  ["C16", [LATER, pol("zdr+only=cobalt")], { result: false, visited: ["broken", "twice", "cobalt", "aurora"] }],
]);

// attest: a route meets it here only with a valid evidence URI.
const WITH_EVIDENCE = routes([{ provider: "basalt", facts: "attest=weights,prompt", evidence: EVIDENCE }]);
const WITHOUT_EVIDENCE = routes([{ provider: "basalt", facts: "attest=weights,prompt" }]);
const BAD_EVIDENCE = routes([{ provider: "basalt", facts: "attest=weights,prompt", evidence: "bad URI" }]);
const SECOND_URI = routes([{ provider: "basalt", facts: "attest=weights,prompt", evidence: "https://proof.example/basalt?run=2" }]);
const OTHER_PROVIDER = routes([{ provider: "basaltine", facts: "attest=weights,prompt", evidence: EVIDENCE }]);
table(someRouteMeets, [
  ...["attest=prompt", "attest=weights,prompt", "attest=weights+only=basalt"].flatMap((text): [string, unknown[], unknown][] => [
    ["C16", [WITH_EVIDENCE, pol(text)], true],
    ["C16", [WITHOUT_EVIDENCE, pol(text)], false],
    ["C16", [BAD_EVIDENCE, pol(text)], false],
    ["C16", [SECOND_URI, pol(text)], true],
  ]),
  ["C16", [OTHER_PROVIDER, pol("attest=weights+only=basalt")], false],
  ["C16", [OTHER_PROVIDER, pol("attest=weights")], true],
  ...[WITH_EVIDENCE, WITHOUT_EVIDENCE, BAD_EVIDENCE].map((published): [string, unknown[], unknown] => ["C16", [published, pol("only=basalt")], true]),
  ["C16", [routes([{ provider: "basalt", facts: "attest=weights", evidence: EVIDENCE }]), pol("attest=weights,prompt")], false],
]);

// A key's bound policy combined with the request's.
const SLOW_OTHER = routes([{ provider: "slow", facts: "" }, { provider: "other", facts: "zdr" }]);
const SLOW_ZDR = routes([{ provider: "slow", facts: "zdr" }, { provider: "other", facts: "zdr" }]);
table(someRouteMeets, [
  ["C16", [SLOW_OTHER, pol("zdr")], true],
  ["C16", [SLOW_OTHER, comb({ key: "only=slow", header: "zdr" })], false],
  ["C16", [SLOW_OTHER, comb({ key: "only=slow" })], true],
  ["C16", [SLOW_ZDR, comb({ key: "only=slow", header: "zdr" })], true],
  ["C16", [SLOW_OTHER, comb({ key: "only=other", header: "zdr" })], true],
  ["C16", [SLOW_OTHER, comb({ key: "only=slow", header: "notrain" })], false],
]);
