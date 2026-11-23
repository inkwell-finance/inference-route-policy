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

test("C3: without a model list, a response is honored only by one valid Route-Applied naming a provider the policy allows", () => {
  assert.deepEqual(interpret(headers(["provider=aurora"]), protocol("zdr")), { kind: "honored", provider: "aurora", checked: false, evidence: null });
  assert.equal(interpret(headers(), protocol("zdr")).kind, "not-honored");
  assert.equal(interpret(headers(["provider=aurora", "provider=basalt"]), protocol("zdr")).kind, "not-honored");
  // A client that sees two lines joined into one value applies the same test.
  assert.equal(interpret(headers(["provider=aurora, provider=basalt"]), protocol("zdr")).kind, "not-honored");
  assert.equal(interpret(headers(["provider=basalt"]), protocol("only=aurora")).kind, "not-honored");
  assert.equal(interpret(headers(["provider=aurora"]), protocol("ignore=aurora")).kind, "not-honored");
});

test("C3: a policy sent with attest needs exactly one Route-Evidence that is an evidence URI", () => {
  assert.equal(interpret(headers(["provider=basalt"]), protocol("attest=weights")).kind, "not-honored");
  assert.equal(interpret(headers(["provider=basalt"], [], ["http://basalt.example/a"]), protocol("attest=weights")).kind, "not-honored");
  assert.equal(interpret(headers(["provider=basalt"], [], [EVIDENCE, EVIDENCE]), protocol("attest=weights")).kind, "not-honored");
  assert.deepEqual(interpret(headers(["provider=basalt"], [], [EVIDENCE]), protocol("attest=weights")), { kind: "honored", provider: "basalt", checked: false, evidence: EVIDENCE });
});

test("C3: policies sent that combine to an empty region are never honored", () => {
  const sent: Sent = { kind: "protocol", policy: combinePolicies({ header: policy("region=us"), suffix: policy("region=de") }), routes: null };
  assert.equal(interpret(headers(["provider=aurora"]), sent).kind, "not-honored");
});

test("C4: with the model list held when it was sent, the named route must be published once and meet the policy", () => {
  assert.deepEqual(interpret(headers(["provider=aurora"]), protocol("zdr", MODEL_LIST)), { kind: "honored", provider: "aurora", checked: true, evidence: null });
  // cobalt is published but publishes no zdr; nosuch is not published at all.
  assert.equal(interpret(headers(["provider=cobalt"]), protocol("zdr", MODEL_LIST)).kind, "not-honored");
  assert.equal(interpret(headers(["provider=nosuch"]), protocol("notrain", MODEL_LIST)).kind, "not-honored");
  const twice = { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr" }, { provider: "aurora", facts: "zdr" }] }] };
  assert.equal(interpret(headers(["provider=aurora"]), protocol("zdr", twice)).kind, "not-honored");
  const invalid = { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr+sort=price" }] }] };
  assert.equal(interpret(headers(["provider=aurora"]), protocol("zdr", invalid)).kind, "not-honored");
  // A list that publishes no routes for the model has been checked, and the provider is not among them.
  assert.equal(interpret(headers(["provider=aurora"]), protocol("zdr", { data: [] })).kind, "not-honored");
});

test("C4: Route-Evidence must be the same string the list publishes for the route", () => {
  assert.equal(interpret(headers(["provider=basalt"], [], [EVIDENCE]), protocol("attest=weights", MODEL_LIST)).kind, "honored");
  assert.equal(interpret(headers(["provider=basalt"], [], [`${EVIDENCE}/`]), protocol("attest=weights", MODEL_LIST)).kind, "not-honored");
});

test("C5: any Route-Refused is a refusal, whatever else the response carries and whether or not it parses", () => {
  assert.deepEqual(interpret(headers(["provider=aurora"], ["reason=unsupported+key=bits"]), protocol("bits=8")), { kind: "refused", reason: "unsupported", key: "bits" });
  assert.deepEqual(interpret(headers([], ["reason=maybe"]), protocol("zdr")), { kind: "refused", reason: null, key: null });
  // Also on a request the client sent no policy with: a key's own policy can be refused too.
  assert.deepEqual(interpret(headers([], ["reason=unsatisfiable"]), { kind: "protocol", policy: null, routes: null }), { kind: "refused", reason: "unsatisfiable", key: null });
  assert.deepEqual(interpret(headers([], ["reason=unavailable", "reason=unavailable"]), { kind: "translated" }), { kind: "refused", reason: null, key: null });
});

test("C8: a translated request's result is unconfirmed, never applied, whatever headers come back", () => {
  const report = interpret(headers(["provider=aurora"]), { kind: "translated" });
  assert.deepEqual(report, { kind: "unconfirmed" });
  assert.equal(isQuiet(report), false);
  assert.match(describeReport(report), /unconfirmed, not applied/);
});

test("C11: a refusal is shown with its reason and its key", () => {
  assert.equal(describeReport({ kind: "refused", reason: "unsupported", key: "bits" }), "route policy refused by the gateway: unsupported (key bits)");
  assert.equal(describeReport({ kind: "refused", reason: "unsatisfiable", key: null }), "route policy refused by the gateway: unsatisfiable");
  assert.match(describeReport({ kind: "refused", reason: null, key: null }), /could not be read/);
});

test("C7: an honored result never presents a fact or evidence as verified", () => {
  const reports: Report[] = [
    { kind: "honored", provider: "basalt", checked: true, evidence: EVIDENCE },
    { kind: "honored", provider: "aurora", checked: false, evidence: null },
  ];
  for (const report of reports) {
    const text = describeReport(report);
    assert.doesNotMatch(text.replaceAll("not verified", ""), /verified/);
    assert.ok(isQuiet(report));
  }
  assert.match(describeReport(reports[0]!), /evidence at https:\/\/basalt\.example\/attestation, not verified by this client/);
  assert.match(describeReport(reports[1]!), /not compared: no model list was held/);
});

test("C3: a policy that was not honored is shown, never reported as applied", () => {
  const report = interpret(headers(["provider=cobalt"]), protocol("zdr", MODEL_LIST));
  assert.equal(isQuiet(report), false);
  assert.match(describeReport(report), /^route policy NOT honored: route "cobalt" does not meet the policy sent$/);
});
