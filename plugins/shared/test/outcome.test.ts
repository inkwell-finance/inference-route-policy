// Each test is one case: the result headers a response carries, what was sent, and the one report or line that
// comes of it. Generated tests take their title from the row they run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { combinePolicies, publishedRoutes, type ResultHeaders } from "../../../core/src/index.ts";
import { describeReport, interpret, isQuiet, type Sent } from "../src/outcome.ts";
import { EVIDENCE, MODEL_LIST, policy } from "./fixtures.ts";

const headers = (applied: string[] = [], refused: string[] = [], evidence: string[] = []): ResultHeaders => ({ applied, refused, evidence });
const protocol = (text: string, list: unknown = null): Sent => ({ kind: "protocol", policy: policy(text), routes: list === null ? null : publishedRoutes(list, "demo-model") });
const NO_POLICY: Sent = { kind: "protocol", policy: null, routes: null };
const TRANSLATED: Sent = { kind: "translated" };
const show = (value: unknown): string => JSON.stringify(value);
const routesOf = (...routes: Record<string, unknown>[]): unknown => ({ data: [{ id: "demo-model", routes }] });

// ---- C3: Route-Applied without a model list.
const UNCHECKED_AURORA = { kind: "honored", provider: "aurora", checked: false, evidence: null };
test(`C3: Route-Applied provider=aurora on a zdr request without a model list is ${show(UNCHECKED_AURORA)}`, () => {
  assert.deepEqual(interpret(headers(["provider=aurora"]), protocol("zdr")), UNCHECKED_AURORA);
});

test("C3: Route-Applied provider= followed by a 32-character id on a zdr request without a model list is honored", () => {
  const id = "a".repeat(32);
  assert.deepEqual(interpret(headers([`provider=${id}`]), protocol("zdr")), { kind: "honored", provider: id, checked: false, evidence: null });
});

for (const [applied, why] of [
  [[], "no Route-Applied"],
  [["provider=aurora", "provider=basalt"], "more than one Route-Applied"],
  [["provider=aurora, provider=basalt"], "Route-Applied is not valid: is not exactly one provider id"],
  [["aurora"], "Route-Applied is not valid: does not begin with the provider"],
  [["providers=aurora"], "Route-Applied is not valid: does not begin with the provider"],
  [["provider="], "Route-Applied is not valid: is not exactly one provider id"],
  [["provider=Aurora!"], "Route-Applied is not valid: is not exactly one provider id"],
  [[`provider=${"a".repeat(33)}`], "Route-Applied is not valid: is not exactly one provider id"],
] as const) {
  test(`C3: Route-Applied ${show(applied)} on a zdr request without a model list is not honored, because ${why}`, () => {
    assert.deepEqual(interpret(headers([...applied]), protocol("zdr")), { kind: "not-honored", why });
  });
}

test("C3: Route-Applied provider=basalt on an only=aurora request without a model list is not honored, basalt being excluded", () => {
  assert.deepEqual(interpret(headers(["provider=basalt"]), protocol("only=aurora")), { kind: "not-honored", why: 'provider "basalt" is excluded by the policy sent' });
});

test("C3: Route-Applied provider=aurora on an ignore=aurora request without a model list is not honored, aurora being excluded", () => {
  assert.deepEqual(interpret(headers(["provider=aurora"]), protocol("ignore=aurora")), { kind: "not-honored", why: 'provider "aurora" is excluded by the policy sent' });
});

// ---- C3: Route-Evidence on an attest request.
test("C3: one Route-Evidence that is an evidence URI on an attest=weights request is honored with that evidence", () => {
  assert.deepEqual(interpret(headers(["provider=basalt"], [], [EVIDENCE]), protocol("attest=weights")), { kind: "honored", provider: "basalt", checked: false, evidence: EVIDENCE });
});

const AT_LIMIT = `https://basalt.example/${"a".repeat(512 - "https://basalt.example/".length)}`;
test("C3: one 512-byte evidence URI on an attest=weights request is honored with it", () => {
  assert.equal(AT_LIMIT.length, 512);
  assert.deepEqual(interpret(headers(["provider=basalt"], [], [AT_LIMIT]), protocol("attest=weights")), { kind: "honored", provider: "basalt", checked: false, evidence: AT_LIMIT });
});

test("C3: one evidence URI with port 65535 on an attest=weights request is honored with it", () => {
  const uri = "https://basalt.example:65535/a";
  assert.deepEqual(interpret(headers(["provider=basalt"], [], [uri]), protocol("attest=weights")), { kind: "honored", provider: "basalt", checked: false, evidence: uri });
});

for (const [name, evidence] of [
  ["no Route-Evidence", []],
  ["two Route-Evidence lines", [EVIDENCE, EVIDENCE]],
  ["an http:// URI", ["http://basalt.example/a"]],
  ["a URI with port 65536", ["https://basalt.example:65536/a"]],
  ["a URI with an uppercase host", ["https://Basalt.example/a"]],
  ["a URI whose host ends in an all-digit label", ["https://basalt.123/a"]],
  ["a 513-byte URI", [`${AT_LIMIT}a`]],
] as const) {
  test(`C3: ${name} on an attest=weights request is not honored`, () => {
    assert.deepEqual(interpret(headers(["provider=basalt"], [], [...evidence]), protocol("attest=weights")), { kind: "not-honored", why: "attest was required and there is not exactly one valid Route-Evidence" });
  });
}

const EMPTY_REGION = (extra: string): Sent => ({ kind: "protocol", policy: combinePolicies({ header: policy(`region=us${extra}`), suffix: policy("region=de") }), routes: null });
test("C3: header region=us with suffix region=de, answered by provider=aurora, is not honored", () => {
  assert.deepEqual(interpret(headers(["provider=aurora"]), EMPTY_REGION("")), { kind: "not-honored", why: "the policies sent combine to one no route can meet" });
});

test("C3: header region=us+attest=weights with suffix region=de, answered by provider=basalt and one valid evidence URI, is not honored", () => {
  assert.deepEqual(interpret(headers(["provider=basalt"], [], [EVIDENCE]), EMPTY_REGION("+attest=weights")), { kind: "not-honored", why: "the policies sent combine to one no route can meet" });
});

// ---- C4: with the model list held when the request was sent.
const CHECKED_AURORA = { kind: "honored", provider: "aurora", checked: true, evidence: null };
test(`C4: provider=aurora, published once with zdr, on a zdr request is ${show(CHECKED_AURORA)}`, () => {
  assert.deepEqual(interpret(headers(["provider=aurora"]), protocol("zdr", MODEL_LIST)), CHECKED_AURORA);
});

for (const [name, list, applied, sent, why] of [
  ["cobalt, published without zdr", MODEL_LIST, "cobalt", "zdr", 'route "cobalt" does not meet the policy sent'],
  ["nosuch, not published", MODEL_LIST, "nosuch", "notrain", 'provider "nosuch" is not among the model\'s published routes'],
  ["aurora, published twice in one model", routesOf({ provider: "aurora", facts: "zdr" }, { provider: "aurora", facts: "zdr" }), "aurora", "zdr", 'provider "aurora" is published more than once or with invalid facts'],
  ["aurora, with facts that do not parse", routesOf({ provider: "aurora", facts: "zdr+sort=price" }), "aurora", "zdr", 'provider "aurora" is published more than once or with invalid facts'],
  ["aurora, under a model listed twice", { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr" }] }, { id: "demo-model", routes: [{ provider: "basalt", facts: "zdr" }] }] }, "aurora", "zdr", 'provider "aurora" is not among the model\'s published routes'],
  ["aurora, in a list with no data", { data: [] }, "aurora", "zdr", 'provider "aurora" is not among the model\'s published routes'],
  ["aurora, published with bits=8", routesOf({ provider: "aurora", facts: "bits=8" }), "aurora", "bits=16", 'route "aurora" does not meet the policy sent'],
] as const) {
  test(`C4: provider=${applied} on a ${sent} request with ${name} is not honored`, () => {
    assert.deepEqual(interpret(headers([`provider=${applied}`]), protocol(sent, list)), { kind: "not-honored", why });
  });
}

const AURORA_EVIDENCE = "https://aurora.example/attestation";
const BOTH_ATTEST = routesOf({ provider: "aurora", facts: "attest=weights", evidence: AURORA_EVIDENCE }, { provider: "basalt", facts: "attest=weights", evidence: EVIDENCE });
test("C4: provider=aurora with aurora's own published evidence on an attest=weights request is honored", () => {
  assert.deepEqual(interpret(headers(["provider=aurora"], [], [AURORA_EVIDENCE]), protocol("attest=weights", BOTH_ATTEST)), { kind: "honored", provider: "aurora", checked: true, evidence: AURORA_EVIDENCE });
});

for (const [name, provider, evidence] of [
  ["basalt's evidence", "aurora", EVIDENCE],
  ["aurora's evidence", "basalt", AURORA_EVIDENCE],
  ["its own evidence with a trailing slash", "basalt", `${EVIDENCE}/`],
  ["its own evidence with the path in uppercase", "basalt", EVIDENCE.toUpperCase().replace("HTTPS://BASALT.EXAMPLE", "https://basalt.example")],
] as const) {
  test(`C4: provider=${provider} with ${name} on an attest=weights request is not honored`, () => {
    assert.deepEqual(interpret(headers([`provider=${provider}`], [], [evidence]), protocol("attest=weights", BOTH_ATTEST)), { kind: "not-honored", why: `Route-Evidence is not the evidence published for "${provider}"` });
  });
}

// ---- C5: Route-Refused.
const KINDS: [string, Sent][] = [["a zdr request", protocol("zdr")], ["a request sent with no policy", NO_POLICY], ["a translated request", TRANSLATED]];
for (const [refused, expected] of [
  [["reason=unavailable"], { kind: "refused", reason: "unavailable", key: null }],
  [["reason=unsupported+key=bits"], { kind: "refused", reason: "unsupported", key: "bits" }],
  [["reason=maybe"], { kind: "refused", reason: null, key: null }],
  [[""], { kind: "refused", reason: null, key: null }],
  [["reason=unavailable", "reason=unavailable"], { kind: "refused", reason: null, key: null }],
  [["reason=unavailable", "reason=unsatisfiable"], { kind: "refused", reason: null, key: null }],
  [["reason=unavailable, reason=unavailable"], { kind: "refused", reason: null, key: null }],
] as const) {
  for (const [kind, sent] of KINDS) {
    test(`C5: Route-Refused ${show(refused)} beside provider=aurora and one evidence URI, on ${kind}, is ${show(expected)}`, () => {
      assert.deepEqual(interpret(headers(["provider=aurora"], [...refused], [EVIDENCE]), sent), expected);
    });
  }
}

// ---- C8: translated requests.
const UNCONFIRMED = "route policy translated into the gateway's own fields; the result is unconfirmed, not applied";
for (const [name, received] of [
  ["no route headers", headers()],
  ["Route-Applied provider=aurora", headers(["provider=aurora"])],
  ["Route-Applied provider=aurora and an evidence URI", headers(["provider=aurora"], [], [EVIDENCE])],
  ["an evidence URI alone", headers([], [], [EVIDENCE])],
  ["two Route-Applied values joined", headers(["provider=aurora, provider=basalt"])],
] as const) {
  test(`C8: a translated request answered with ${name} is {"kind":"unconfirmed"}`, () => {
    assert.deepEqual(interpret(received, TRANSLATED), { kind: "unconfirmed" });
  });
}
test(`C8: the report {"kind":"unconfirmed"} is shown as "${UNCONFIRMED}"`, () => {
  assert.equal(describeReport({ kind: "unconfirmed" }), UNCONFIRMED);
});
test('C8: the report {"kind":"unconfirmed"} is not quiet', () => {
  assert.equal(isQuiet({ kind: "unconfirmed" }), false);
});

// ---- C11: refusal lines.
for (const [report, text] of [
  [{ kind: "refused", reason: "unsupported", key: "bits" }, "route policy refused by the gateway: unsupported (key bits)"],
  [{ kind: "refused", reason: "unsatisfiable", key: null }, "route policy refused by the gateway: unsatisfiable"],
  [{ kind: "refused", reason: null, key: null }, "route policy refused by the gateway (its Route-Refused value could not be read)"],
] as const) {
  test(`C11: the report ${show(report)} is shown as "${text}"`, () => {
    assert.equal(describeReport(report), text);
  });
}

// ---- C7: honored lines.
const CLAIMS = "its published facts meet the policy (they are the gateway's claims, not verified by this client)";
const UNCOMPARED = "its published facts were not compared: no model list was held";
const NOT_VERIFIED = `; evidence at ${EVIDENCE}, not verified by this client`;
for (const [report, text] of [
  [{ kind: "honored", provider: "basalt", checked: true, evidence: EVIDENCE }, `route policy honored: served by basalt; ${CLAIMS}${NOT_VERIFIED}`],
  [{ kind: "honored", provider: "aurora", checked: false, evidence: null }, `route policy honored: served by aurora; ${UNCOMPARED}`],
  [{ kind: "honored", provider: "aurora", checked: true, evidence: null }, `route policy honored: served by aurora; ${CLAIMS}`],
  [{ kind: "honored", provider: "basalt", checked: false, evidence: EVIDENCE }, `route policy honored: served by basalt; ${UNCOMPARED}${NOT_VERIFIED}`],
] as const) {
  test(`C7: the report ${show(report)} is shown as "${text}"`, () => {
    assert.equal(describeReport(report), text);
  });
  test(`C7: the report ${show(report)} is quiet`, () => {
    assert.equal(isQuiet(report), true);
  });
}

// ---- C3: responses to requests sent without a policy.
for (const [name, applied, text] of [
  ["Route-Applied provider=aurora", ["provider=aurora"], "no route policy sent with this request; the gateway names aurora as its route"],
  ["Route-Applied provider=cobalt", ["provider=cobalt"], "no route policy sent with this request; the gateway names cobalt as its route"],
  ["no Route-Applied", [], "no route policy sent with this request"],
  ["Route-Applied aurora", ["aurora"], "no route policy sent with this request"],
  ["two Route-Applied lines", ["provider=aurora", "provider=basalt"], "no route policy sent with this request"],
  ["two Route-Applied values joined", ["provider=aurora, provider=basalt"], "no route policy sent with this request"],
] as const) {
  test(`C3: a response with ${name} to a request sent with no policy is shown as "${text}"`, () => {
    assert.equal(describeReport(interpret(headers([...applied]), NO_POLICY)), text);
  });
  test(`C3: a response with ${name} to a request sent with no policy is quiet`, () => {
    assert.equal(isQuiet(interpret(headers([...applied]), NO_POLICY)), true);
  });
}

// ---- C3: not honored, shown.
for (const [name, received, sent, why] of [
  ["no Route-Applied on a zdr request", headers(), protocol("zdr"), "no Route-Applied"],
  ["Route-Applied aurora on a zdr request", headers(["aurora"]), protocol("zdr"), "Route-Applied is not valid: does not begin with the provider"],
  ["provider=cobalt on an only=aurora request", headers(["provider=cobalt"]), protocol("only=aurora"), 'provider "cobalt" is excluded by the policy sent'],
  ["provider=nosuch on a zdr request with the model list", headers(["provider=nosuch"]), protocol("zdr", MODEL_LIST), 'provider "nosuch" is not among the model\'s published routes'],
  ["provider=cobalt on a zdr request with the model list", headers(["provider=cobalt"]), protocol("zdr", MODEL_LIST), 'route "cobalt" does not meet the policy sent'],
  ["provider=basalt without evidence on an attest=weights request", headers(["provider=basalt"]), protocol("attest=weights"), "attest was required and there is not exactly one valid Route-Evidence"],
  ["provider=aurora on region=us with region=de", headers(["provider=aurora"]), EMPTY_REGION(""), "the policies sent combine to one no route can meet"],
] as const) {
  test(`C3: ${name} is shown as "route policy NOT honored: ${why}"`, () => {
    assert.equal(describeReport(interpret(received, sent)), `route policy NOT honored: ${why}`);
  });
  test(`C3: ${name} is not quiet`, () => {
    assert.equal(isQuiet(interpret(received, sent)), false);
  });
}

