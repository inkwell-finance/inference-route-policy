import assert from "node:assert/strict";
import { test } from "node:test";
import { combinePolicies, publishedRoutes, type ResultHeaders } from "../../../core/src/index.ts";
import { describeReport, interpret, isQuiet, type Report, type Sent } from "../src/outcome.ts";
import { EVIDENCE, MODEL_LIST, policy } from "./fixtures.ts";

const headers = (applied: string[] = [], refused: string[] = [], evidence: string[] = []): ResultHeaders => ({ applied, refused, evidence });
const protocol = (text: string, list: unknown = null): Sent => ({
  kind: "protocol",
  policy: policy(text),
  routes: list === null ? null : publishedRoutes(list, "demo-model"),
});
const NO_POLICY: Sent = { kind: "protocol", policy: null, routes: null };
const TRANSLATED: Sent = { kind: "translated" };

test("C3: without a model list, a response is honored only by one valid Route-Applied naming a provider the policy allows", () => {
  assert.deepEqual(interpret(headers(["provider=aurora"]), protocol("zdr")), { kind: "honored", provider: "aurora", checked: false, evidence: null });
  // Not one valid Route-Applied: none, two lines, two joined into one value, a bare slug, a wrong prefix, an empty
  // or invalid provider id. Each is not honored, and says why.
  const invalid: [string[], RegExp][] = [
    [[], /^no Route-Applied$/],
    [["provider=aurora", "provider=basalt"], /^more than one Route-Applied$/],
    [["provider=aurora, provider=basalt"], /^Route-Applied is not valid/],
    [["aurora"], /^Route-Applied is not valid/],
    [["providers=aurora"], /^Route-Applied is not valid/],
    [["provider="], /^Route-Applied is not valid/],
    [["provider=Aurora!"], /^Route-Applied is not valid/],
  ];
  for (const [applied, why] of invalid) {
    const report = interpret(headers(applied), protocol("zdr"));
    assert.ok(report.kind === "not-honored", JSON.stringify(applied));
    assert.match(report.why, why, JSON.stringify(applied));
  }
  // A valid one naming a provider the policy does not allow: by only, and by ignore.
  assert.equal(interpret(headers(["provider=basalt"]), protocol("only=aurora")).kind, "not-honored");
  assert.equal(interpret(headers(["provider=aurora"]), protocol("ignore=aurora")).kind, "not-honored");
});

test("C3: a policy sent with attest needs exactly one Route-Evidence that is an evidence URI", () => {
  assert.deepEqual(interpret(headers(["provider=basalt"], [], [EVIDENCE]), protocol("attest=weights")), { kind: "honored", provider: "basalt", checked: false, evidence: EVIDENCE });
  // None, two, and each way a single value fails to be an evidence URI: another scheme, a port past 65535, an
  // uppercase host, a host whose last label is all digits.
  for (const evidence of [[], [EVIDENCE, EVIDENCE], ["http://basalt.example/a"], ["https://basalt.example:65536/a"], ["https://Basalt.example/a"], ["https://basalt.123/a"]]) {
    assert.equal(interpret(headers(["provider=basalt"], [], evidence), protocol("attest=weights")).kind, "not-honored", JSON.stringify(evidence));
  }
  assert.equal(interpret(headers(["provider=basalt"], [], ["https://basalt.example:65535/a"]), protocol("attest=weights")).kind, "honored", "the highest port is a port");
});

test("C3: policies sent that combine to an empty region are never honored", () => {
  const sent = (extra: string): Sent => ({ kind: "protocol", policy: combinePolicies({ header: policy(`region=us${extra}`), suffix: policy("region=de") }), routes: null });
  assert.equal(interpret(headers(["provider=aurora"]), sent("")).kind, "not-honored");
  // With attest and its one valid evidence URI as well, the rest of the response is in order: still never.
  assert.equal(interpret(headers(["provider=basalt"], [], [EVIDENCE]), sent("+attest=weights")).kind, "not-honored");
});

test("C4: with the model list held when it was sent, the named route must be published once and meet the policy", () => {
  assert.deepEqual(interpret(headers(["provider=aurora"]), protocol("zdr", MODEL_LIST)), { kind: "honored", provider: "aurora", checked: true, evidence: null });
  // cobalt is published but publishes no zdr; nosuch is not published at all.
  assert.equal(interpret(headers(["provider=cobalt"]), protocol("zdr", MODEL_LIST)).kind, "not-honored");
  assert.equal(interpret(headers(["provider=nosuch"]), protocol("notrain", MODEL_LIST)).kind, "not-honored");
  // Published twice: the same provider twice in one model's routes, or the model itself twice, each entry valid.
  const twice = { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr" }, { provider: "aurora", facts: "zdr" }] }] };
  assert.equal(interpret(headers(["provider=aurora"]), protocol("zdr", twice)).kind, "not-honored");
  const modelTwice = { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr" }] }, { id: "demo-model", routes: [{ provider: "basalt", facts: "zdr" }] }] };
  assert.equal(interpret(headers(["provider=aurora"]), protocol("zdr", modelTwice)).kind, "not-honored");
  const invalid = { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr+sort=price" }] }] };
  assert.equal(interpret(headers(["provider=aurora"]), protocol("zdr", invalid)).kind, "not-honored");
  // A list that publishes no routes for the model has been checked, and the provider is not among them.
  assert.equal(interpret(headers(["provider=aurora"]), protocol("zdr", { data: [] })).kind, "not-honored");
});

test("C4: Route-Evidence must be the same string the list publishes for the route", () => {
  assert.equal(interpret(headers(["provider=basalt"], [], [EVIDENCE]), protocol("attest=weights", MODEL_LIST)).kind, "honored");
  assert.equal(interpret(headers(["provider=basalt"], [], [`${EVIDENCE}/`]), protocol("attest=weights", MODEL_LIST)).kind, "not-honored");
  // Two routes with evidence of their own: each response is compared with its own route's, never the other's.
  const AURORA = "https://aurora.example/attestation";
  const both = {
    data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "attest=weights", evidence: AURORA }, { provider: "basalt", facts: "attest=weights", evidence: EVIDENCE }] }],
  };
  assert.equal(interpret(headers(["provider=aurora"], [], [AURORA]), protocol("attest=weights", both)).kind, "honored");
  assert.equal(interpret(headers(["provider=aurora"], [], [EVIDENCE]), protocol("attest=weights", both)).kind, "not-honored");
  assert.equal(interpret(headers(["provider=basalt"], [], [AURORA]), protocol("attest=weights", both)).kind, "not-honored");
});

test("C5: any Route-Refused is a refusal, whatever else the response carries and whether or not it parses", () => {
  const unread = { kind: "refused", reason: null, key: null };
  // Parsed: with a Route-Applied beside it, on a protocol request, on one sent with no policy, on a translated one.
  assert.deepEqual(interpret(headers(["provider=aurora"], ["reason=unsupported+key=bits"]), protocol("bits=8")), { kind: "refused", reason: "unsupported", key: "bits" });
  assert.deepEqual(interpret(headers(["provider=aurora"], ["reason=unsatisfiable"]), NO_POLICY), { kind: "refused", reason: "unsatisfiable", key: null });
  assert.deepEqual(interpret(headers(["provider=aurora"], ["reason=unavailable"], [EVIDENCE]), TRANSLATED), { kind: "refused", reason: "unavailable", key: null });
  // With a valid Route-Applied and Route-Evidence beside it, on a policy they would have honored.
  assert.deepEqual(interpret(headers(["provider=basalt"], ["reason=unavailable"], [EVIDENCE]), protocol("attest=weights")), { kind: "refused", reason: "unavailable", key: null });
  // Not parsed: an unknown reason, an empty value, two lines, and two lines joined into one value; on every kind
  // of request, each with a Route-Applied beside it.
  for (const refused of [["reason=maybe"], [""], ["reason=unavailable", "reason=unavailable"], ["reason=unavailable, reason=unavailable"]]) {
    const kinds: Sent[] = [protocol("zdr"), NO_POLICY, TRANSLATED];
    for (const sent of kinds) {
      assert.deepEqual(interpret(headers(["provider=aurora"], refused), sent), unread, `${JSON.stringify(refused)} on ${sent.kind}`);
    }
  }
});

test("C8: a translated request's success is unconfirmed, never applied: with no route headers, or with a misleading Route-Applied", () => {
  const text = "route policy translated into the gateway's own fields; the result is unconfirmed, not applied";
  for (const received of [headers(), headers(["provider=aurora"]), headers(["provider=aurora"], [], [EVIDENCE]), headers([], [], [EVIDENCE]), headers(["provider=aurora, provider=basalt"])]) {
    const report = interpret(received, TRANSLATED);
    assert.deepEqual(report, { kind: "unconfirmed" });
    assert.equal(isQuiet(report), false);
    assert.equal(describeReport(report), text, "the whole line: nothing in it says applied but the negation");
  }
});

test("C5, C8: a translated request's response that carries Route-Refused is a refusal, parsed or not", () => {
  assert.deepEqual(interpret(headers([], ["reason=unavailable"]), TRANSLATED), { kind: "refused", reason: "unavailable", key: null });
  for (const refused of [["reason=maybe"], [""]]) assert.deepEqual(interpret(headers([], refused), TRANSLATED), { kind: "refused", reason: null, key: null }, JSON.stringify(refused));
});

test("C11: a refusal is shown with its reason and its key", () => {
  assert.equal(describeReport({ kind: "refused", reason: "unsupported", key: "bits" }), "route policy refused by the gateway: unsupported (key bits)");
  assert.equal(describeReport({ kind: "refused", reason: "unsatisfiable", key: null }), "route policy refused by the gateway: unsatisfiable");
  assert.match(describeReport({ kind: "refused", reason: null, key: null }), /could not be read/);
});

test("C7: an honored result never presents a fact or evidence as verified", () => {
  // Every combination, each shown in exactly these words: the facts are the gateway's claims, the evidence is not
  // checked, and nothing else is said of either.
  const claims = "its published facts meet the policy (they are the gateway's claims, not verified by this client)";
  const uncompared = "its published facts were not compared: no model list was held";
  const evidence = `; evidence at ${EVIDENCE}, not verified by this client`;
  const cases: [Report, string][] = [
    [{ kind: "honored", provider: "basalt", checked: true, evidence: EVIDENCE }, `route policy honored: served by basalt; ${claims}${evidence}`],
    [{ kind: "honored", provider: "aurora", checked: false, evidence: null }, `route policy honored: served by aurora; ${uncompared}`],
    [{ kind: "honored", provider: "aurora", checked: true, evidence: null }, `route policy honored: served by aurora; ${claims}`],
    [{ kind: "honored", provider: "basalt", checked: false, evidence: EVIDENCE }, `route policy honored: served by basalt; ${uncompared}${evidence}`],
  ];
  for (const [report, text] of cases) {
    assert.equal(describeReport(report), text);
    assert.ok(isQuiet(report));
  }
});

test("C3: a response to a request sent without a policy says only that none was sent, and names its route as the gateway's", () => {
  // Read from the response's own headers: the route it names, or none when it names none it can read.
  assert.equal(describeReport(interpret(headers(["provider=aurora"]), NO_POLICY)), "no route policy sent with this request; the gateway names aurora as its route");
  assert.equal(describeReport(interpret(headers(["provider=cobalt"]), NO_POLICY)), "no route policy sent with this request; the gateway names cobalt as its route");
  assert.equal(describeReport(interpret(headers(), NO_POLICY)), "no route policy sent with this request");
  assert.equal(describeReport(interpret(headers(["aurora"]), NO_POLICY)), "no route policy sent with this request");
});

test("C3: a policy that was not honored is shown, never reported as applied", () => {
  // Each cause of a policy not honored: no Route-Applied, an invalid one, a provider the policy excludes, one not
  // published, one whose facts fail. Each is shown, in full, as not honored.
  const cases: [ResultHeaders, Sent, string][] = [
    [headers(), protocol("zdr"), "no Route-Applied"],
    [headers(["aurora"]), protocol("zdr"), "Route-Applied is not valid: does not begin with the provider"],
    [headers(["provider=cobalt"]), protocol("only=aurora"), 'provider "cobalt" is excluded by the policy sent'],
    [headers(["provider=nosuch"]), protocol("zdr", MODEL_LIST), 'provider "nosuch" is not among the model\'s published routes'],
    [headers(["provider=cobalt"]), protocol("zdr", MODEL_LIST), 'route "cobalt" does not meet the policy sent'],
  ];
  for (const [received, sent, why] of cases) {
    const report = interpret(received, sent);
    assert.equal(isQuiet(report), false, why);
    assert.equal(describeReport(report), `route policy NOT honored: ${why}`);
  }
});
