import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDetection, splitModel, type Detection } from "../../../core/src/index.ts";
import { decide, readLayers, type Carriers, type Decision, type GatewayState } from "../src/decide.ts";
import { holdPolicy, type Held } from "../src/held.ts";
import { OPENROUTER_BASE } from "../src/openrouter.ts";
import { detection, MODEL_LIST } from "./fixtures.ts";

const BASE = "http://gateway.test/v1";
const NONE: Held = { kind: "none" };
const held = (text: string): Held => holdPolicy(text, "session");

interface Situation {
  held?: Held;
  model?: string;
  configured?: string | null;
  carriers?: Carriers;
  base?: string;
  detection?: Detection | null;
  list?: unknown;
}

/** Decides one request; by default with a valid baseline detection reply and no model list held. */
function decideFor(situation: Situation): Decision {
  const read = readLayers(situation.held ?? NONE, situation.model ?? "demo-model", situation.configured ?? null);
  if (!read.ok) return { action: "block", reason: read.reason };
  const gateway: GatewayState = {
    base: situation.base ?? BASE,
    detection: situation.detection === undefined ? detection() : situation.detection,
    noDetection: "status is 404, not 200",
    modelList: situation.list === undefined ? null : { list: situation.list },
  };
  return decide(read.value, situation.carriers ?? "header", gateway);
}

function sent(decision: Decision): Extract<Decision, { action: "send" }> {
  assert.ok(decision.action === "send", decision.action === "block" ? decision.reason : decision.action);
  return decision;
}

test("C1: a requirement on either carrier is not sent to a base URL without a valid detection reply", () => {
  for (const carriers of ["header", "suffix"] as const) {
    const ownPolicy = decideFor({ held: held("zdr"), carriers, detection: null });
    assert.equal(ownPolicy.action, "block");
    assert.match(ownPolicy.action === "block" ? ownPolicy.reason : "", /no valid detection reply \(status is 404, not 200\)/);
    assert.equal(decideFor({ model: "demo-model+notrain", carriers, detection: null }).action, "block");
    assert.equal(decideFor({ configured: "bits=8", carriers, detection: null }).action, "block");
  }
});

test("C1: the reply must list every key and every attest and sort value of every policy on the request, preferences included", () => {
  const without = (keys: string[], attest = ["weights", "prompt"], sort = ["price", "latency", "throughput"]): Detection =>
    detection({ route_policy: "1", keys, attest, sort });
  const all = ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "sort", "order"];
  const lacking = (key: string) => without(all.filter((k) => k !== key));
  // The held policy on the header and the typed one on the suffix are both checked.
  assert.equal(decideFor({ held: held("zdr"), model: "demo-model+bits=8", detection: lacking("bits") }).action, "block");
  assert.equal(decideFor({ held: held("zdr+order=aurora"), detection: lacking("order") }).action, "block");
  assert.equal(decideFor({ held: held("zdr"), model: "demo-model+sort=price", detection: without(all, ["weights", "prompt"], ["latency"]) }).action, "block");
  assert.equal(decideFor({ held: held("attest=prompt"), detection: without(all, ["weights"]) }).action, "block");
  const missing = decideFor({ held: held("zdr+order=aurora"), detection: lacking("order") });
  assert.match(missing.action === "block" ? missing.reason : "", /does not list order/);
  sent(decideFor({ held: held("zdr+attest=prompt+sort=latency+order=aurora"), model: "demo-model+bits=8" }));
});

test("C2: a request whose policies hold only preferences is sent without detection", () => {
  const decision = sent(decideFor({ held: held("sort=price+order=basalt"), model: "demo-model+sort=latency", detection: null }));
  assert.equal(decision.header, "sort=price+order=basalt");
  assert.equal(decision.model, "demo-model+sort=latency");
});

test("C10: with both carriers the held policy goes by the header and a typed suffix stays as typed", () => {
  const decision = sent(decideFor({ held: held("zdr+sort=price"), model: "demo-model+notrain+sort=latency", carriers: "header" }));
  assert.equal(decision.header, "zdr+sort=price");
  assert.equal(decision.model, "demo-model+notrain+sort=latency");
  assert.deepEqual(
    { zdr: decision.sent?.zdr, notrain: decision.sent?.notrain, sort: decision.sent?.sort },
    { zdr: true, notrain: true, sort: "latency" },
    "what was sent combines both, the suffix the more specific",
  );
});

test("C10: with one carrier the two are combined into the suffix, the typed one the more specific", () => {
  const decision = sent(decideFor({ held: held("zdr+region=us,de+sort=price"), model: "demo-model+region=de,fr+sort=latency", carriers: "suffix" }));
  assert.equal(decision.header, null);
  assert.equal(decision.model, "demo-model+zdr+region=de+sort=latency");
});

test("C10: with one carrier, a combination that cannot be written blocks the request and nothing weaker is sent", () => {
  const emptyRegion = decideFor({ held: held("region=us"), model: "demo-model+region=de", carriers: "suffix" });
  assert.equal(emptyRegion.action, "block");
  assert.match(emptyRegion.action === "block" ? emptyRegion.reason : "", /cannot be written/);
  // Nine ignored providers held and eight typed are each a valid list; their union of seventeen is over the limit.
  const ignore = (prefix: string, count: number) => `ignore=${Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(",")}`;
  const situation = { held: held(`zdr+${ignore("a", 9)}`), model: `demo-model+${ignore("b", 8)}` };
  assert.equal(decideFor({ ...situation, carriers: "suffix" }).action, "block");
  // With both carriers nothing has to be combined, so the same request goes.
  sent(decideFor({ ...situation, carriers: "header" }));
});

test("C10: a held policy and a configured Route-Policy header combine into the one header the plugin sends", () => {
  assert.equal(sent(decideFor({ held: held("zdr+sort=price"), configured: "bits=8+sort=latency", carriers: "header" })).header, "zdr+bits=8+sort=price");
  // Where the plugin cannot set headers, the configured one goes as it is and the held one rides the suffix.
  const suffixOnly = sent(decideFor({ held: held("zdr"), configured: "bits=8", carriers: "suffix" }));
  assert.deepEqual([suffixOnly.header, suffixOnly.model], ["bits=8", "demo-model+zdr"]);
});

test("C10: an invalid held policy, typed suffix, or configured header blocks instead of being dropped", () => {
  assert.equal(decideFor({ held: holdPolicy("zdr+zdr", "env") }).action, "block");
  assert.equal(decideFor({ model: "demo-model+zdr=1" }).action, "block");
  assert.equal(decideFor({ configured: "bits=0" }).action, "block");
});

test("C16: with the model list held, a request no published route meets is not sent", () => {
  const blocked = decideFor({ held: held("only=nosuch"), list: MODEL_LIST });
  assert.equal(blocked.action, "block");
  assert.match(blocked.action === "block" ? blocked.reason : "", /no route the model list publishes for demo-model meets/);
  // The same policy without a list goes, and the gateway decides.
  sent(decideFor({ held: held("only=nosuch") }));
  // Each route meets part of zdr+bits=16; none meets all of it.
  assert.equal(decideFor({ held: held("zdr"), model: "demo-model+bits=16", list: MODEL_LIST }).action, "block");
  const ok = sent(decideFor({ held: held("zdr"), model: "demo-model+bits=8", list: MODEL_LIST }));
  assert.deepEqual([...(ok.routes?.keys() ?? [])], ["aurora", "basalt", "cobalt"], "routes are looked up by the id without its suffix");
});

test("C16: a route meets attest only when it publishes a valid evidence URI", () => {
  const list = (evidence: unknown) => ({ data: [{ id: "demo-model", routes: [{ provider: "basalt", facts: "attest=weights", evidence }] }] });
  sent(decideFor({ held: held("attest=weights"), list: list("https://basalt.example/attestation") }));
  assert.equal(decideFor({ held: held("attest=weights"), list: list("http://basalt.example/attestation") }).action, "block");
});

test("C16, C12: an interpretable key policy joins the check; one the client cannot interpret is relied on for nothing", () => {
  const withKey = (keyPolicy: string, keys: string[]) => detection({ ...formatDetection({ keys: new Set(), attest: new Set(["weights", "prompt"]), sort: new Set(["price"]) }), keys, key_policy: keyPolicy });
  const nine = ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "sort", "order"];
  // notrain is met by aurora alone; the key's only=cobalt excludes it.
  assert.equal(decideFor({ held: held("notrain"), list: MODEL_LIST, detection: withKey("only=cobalt", nine) }).action, "block");
  // A key from a later revision makes the key policy uninterpretable: it plays no part, so aurora still qualifies.
  sent(decideFor({ held: held("notrain"), list: MODEL_LIST, detection: withKey("only=cobalt+future", [...nine, "future"]) }));
});

test("C16: a key policy's requirements count even when the request carries only preferences", () => {
  const keyed = detection({ ...formatDetection({ keys: new Set(["zdr", "only", "sort"]), attest: new Set(), sort: new Set(["price"]) }), key_policy: "only=nosuch" });
  assert.equal(decideFor({ held: held("sort=price"), list: MODEL_LIST, detection: keyed }).action, "block");
});

test("C9: with no detection reply, a policy for OpenRouter is translated into its provider field and the suffix is removed", () => {
  const decision = decideFor({ base: OPENROUTER_BASE, detection: null, held: held("notrain+only=aurora"), model: "vendor/model+sort=price", carriers: "suffix" });
  assert.equal(decision.action, "translate");
  if (decision.action !== "translate") return;
  assert.equal(decision.model, "vendor/model");
  assert.deepEqual(decision.provider, { data_collection: "deny", only: ["aurora"], sort: "price" });
  assert.equal(splitModel(decision.model).policy, null);
});

test("C9: a requirement OpenRouter has no hard filter for blocks the whole request", () => {
  for (const policy of ["zdr", "region=us", "attest=weights", "notrain+bits=64"]) {
    assert.equal(decideFor({ base: OPENROUTER_BASE, detection: null, held: held(policy) }).action, "block", policy);
  }
  // A configured Route-Policy header could not be removed by a harness without a header hook, so it blocks there.
  assert.equal(decideFor({ base: OPENROUTER_BASE, detection: null, configured: "notrain", carriers: "suffix" }).action, "block");
  assert.equal(decideFor({ base: OPENROUTER_BASE, detection: null, configured: "notrain", carriers: "header" }).action, "translate");
});

test("C9: a gateway at the OpenRouter base that answers detection is spoken to in this protocol", () => {
  sent(decideFor({ base: `${OPENROUTER_BASE}/`, held: held("zdr") }));
});

test("C1: a request no policy reaches is sent as it is, whatever detection says", () => {
  const decision = sent(decideFor({ detection: null }));
  assert.deepEqual([decision.model, decision.header, decision.sent], ["demo-model", null, null]);
});
