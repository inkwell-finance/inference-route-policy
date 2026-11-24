import assert from "node:assert/strict";
import { test } from "node:test";
import { combinePolicies } from "../../../core/src/index.ts";
import { isOpenRouter, translateToOpenRouter } from "../src/openrouter.ts";
import { policy } from "./fixtures.ts";

for (const [text, provider] of [
  ["only=aurora,basalt", { only: ["aurora", "basalt"] }],
  ["ignore=cobalt", { ignore: ["cobalt"] }],
  ["ignore=cobalt,basalt", { ignore: ["cobalt", "basalt"] }],
  ["sort=throughput+order=basalt,aurora", { sort: "throughput", order: ["basalt", "aurora"] }],
  ["only=aurora+ignore=cobalt+sort=price", { only: ["aurora"], ignore: ["cobalt"], sort: "price" }],
  ["only=aurora,cobalt+ignore=basalt,dante", { only: ["aurora", "cobalt"], ignore: ["basalt", "dante"] }],
  ["sort=latency", { sort: "latency" }],
] as const) {
  test(`C9: ${text} translates to the OpenRouter provider field ${JSON.stringify(provider)}`, () => {
    assert.deepEqual(translateToOpenRouter(policy(text)), { ok: true, provider });
  });
}

const REASONS: [string, string][] = [
  ["zdr", "zdr has no hard filter there (its zdr field still admits Safety Retention endpoints)"],
  ["notrain", "notrain has no hard filter there (data_collection covers the model providers, not OpenRouter itself)"],
  ["bits=8", "bits has no hard filter there (quantizations names levels, not a floor on every weight)"],
  ["region=us", "region has no request field there"],
  ["attest=weights", "attest has no counterpart there"],
];
for (const [requirement, why] of REASONS) {
  for (const beside of ["", "+only=aurora", "+sort=price"]) {
    test(`C9: ${requirement}${beside} is refused for OpenRouter: ${why}`, () => {
      assert.deepEqual(translateToOpenRouter(policy(`${requirement}${beside}`)), { ok: false, why: `cannot be translated for OpenRouter: ${why}` });
    });
  }
}

test("C9: only=aurora on the header with only=basalt on the suffix is refused for OpenRouter: only combines to an empty list", () => {
  const empty = combinePolicies({ header: policy("only=aurora"), suffix: policy("only=basalt") });
  assert.deepEqual(translateToOpenRouter(empty), { ok: false, why: "cannot be translated for OpenRouter: only combines to an empty list, which no route can meet" });
});

for (const base of ["https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/"]) {
  test(`C9: ${base} is OpenRouter's base URL`, () => {
    assert.equal(isOpenRouter(base), true);
  });
}

for (const base of [
  "https://openrouter.ai/api/v2",
  "https://eu.openrouter.ai/api/v1",
  "http://openrouter.ai/api/v1",
  "https://openrouter.ai:8443/api/v1",
  "https://openrouter.ai/api/v1?tenant=east",
  "https://openrouter.ai/api/v1?",
]) {
  test(`C9: ${base} is not OpenRouter's base URL`, () => {
    assert.equal(isOpenRouter(base), false);
  });
}
