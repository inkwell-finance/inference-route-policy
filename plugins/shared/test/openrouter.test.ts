import assert from "node:assert/strict";
import { test } from "node:test";
import { combinePolicies } from "../../../core/src/index.ts";
import { isOpenRouter, translateToOpenRouter } from "../src/openrouter.ts";
import { policy } from "./fixtures.ts";

const provider = (text: string): Record<string, unknown> => {
  const translation = translateToOpenRouter(policy(text));
  assert.ok(translation.ok, translation.ok ? "" : translation.why);
  return translation.provider;
};

function refused(text: string, why: RegExp): void {
  const translation = translateToOpenRouter(policy(text));
  assert.ok(!translation.ok, `${text} should not translate`);
  assert.match(translation.why, why);
}

test("C9: only and ignore map to the documented provider filters, and sort and order to the documented preferences", () => {
  assert.deepEqual(provider("only=aurora,basalt"), { only: ["aurora", "basalt"] });
  assert.deepEqual(provider("ignore=cobalt"), { ignore: ["cobalt"] });
  assert.deepEqual(provider("sort=throughput+order=basalt,aurora"), { sort: "throughput", order: ["basalt", "aurora"] });
  assert.deepEqual(provider("only=aurora+ignore=cobalt+sort=price"), { only: ["aurora"], ignore: ["cobalt"], sort: "price" });
});

test("C9: each requirement with no documented hard filter refuses the whole policy, for its own reason", () => {
  refused("zdr", /zdr has no hard filter there \(its zdr field still admits Safety Retention endpoints\)/);
  refused("notrain", /notrain has no hard filter there \(data_collection covers the model providers, not OpenRouter itself\)/);
  refused("bits=8", /bits has no hard filter there \(quantizations names levels, not a floor on every weight\)/);
  refused("region=us", /region has no request field there/);
  refused("attest=weights", /attest has no counterpart there/);
  // One unmappable requirement refuses a policy whose other parts map.
  refused("only=aurora+notrain", /notrain has no hard filter/);
});

test("C9: an only list that combined to empty is refused rather than sent as an empty filter", () => {
  const empty = combinePolicies({ header: policy("only=aurora"), suffix: policy("only=basalt") });
  const translation = translateToOpenRouter(empty);
  assert.ok(!translation.ok);
  assert.match(translation.why, /only combines to an empty list/);
});

test("C9: translation applies only to OpenRouter's documented base URL", () => {
  assert.ok(isOpenRouter("https://openrouter.ai/api/v1"));
  assert.ok(isOpenRouter("https://openrouter.ai/api/v1/"));
  assert.ok(!isOpenRouter("https://openrouter.ai/api/v2"));
  assert.ok(!isOpenRouter("https://eu.openrouter.ai/api/v1"));
});
