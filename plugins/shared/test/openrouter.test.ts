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

test("C9: notrain, only, and ignore map to the documented filters, and sort and order to the documented preferences", () => {
  assert.deepEqual(provider("notrain"), { data_collection: "deny" });
  assert.deepEqual(provider("only=aurora,basalt"), { only: ["aurora", "basalt"] });
  assert.deepEqual(provider("ignore=cobalt"), { ignore: ["cobalt"] });
  assert.deepEqual(provider("sort=throughput+order=basalt,aurora"), { sort: "throughput", order: ["basalt", "aurora"] });
});

test("C9: bits maps to every documented quantization level at or above the floor, and unknown precision never qualifies", () => {
  assert.deepEqual(provider("bits=8"), { quantizations: ["int8", "fp8", "mxfp8", "fp16", "bf16", "fp32"] });
  assert.deepEqual(provider("bits=5"), { quantizations: ["int8", "fp6", "fp8", "mxfp8", "fp16", "bf16", "fp32"] });
  assert.deepEqual(provider("bits=32"), { quantizations: ["fp32"] });
  assert.ok(!JSON.stringify(provider("bits=1")["quantizations"]).includes("unknown"));
  const above = translateToOpenRouter(policy("bits=33"));
  assert.equal(above.ok, false, "no level qualifies, and an empty list must not reach the wire");
});

test("C9: zdr, region, and attest have no hard filter there, so the whole policy is refused", () => {
  for (const text of ["zdr", "notrain+zdr", "region=us", "attest=weights", "only=aurora+attest=prompt"]) {
    const translation = translateToOpenRouter(policy(text));
    assert.equal(translation.ok, false, text);
  }
  const zdr = translateToOpenRouter(policy("zdr"));
  assert.ok(!zdr.ok);
  assert.match(zdr.why, /Safety Retention/);
});

test("C9: an only list that combined to empty is refused rather than sent as an empty filter", () => {
  const empty = combinePolicies({ header: policy("only=aurora"), suffix: policy("only=basalt") });
  assert.equal(translateToOpenRouter(empty).ok, false);
});

test("C9: translation applies only to OpenRouter's documented base URL", () => {
  assert.ok(isOpenRouter("https://openrouter.ai/api/v1"));
  assert.ok(isOpenRouter("https://openrouter.ai/api/v1/"));
  assert.ok(!isOpenRouter("https://openrouter.ai/api/v2"));
  assert.ok(!isOpenRouter("https://eu.openrouter.ai/api/v1"));
});
