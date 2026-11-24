// Each test is one request in one situation, and the one decision it gets, compared whole: its action, the model
// and header it sends with, the policy it counts as sent, and the routes it holds (or why it is blocked).
import assert from "node:assert/strict";
import { test } from "node:test";
import { baselineSupport, formatDetection, formatPolicy, type Detection } from "../../../core/src/index.ts";
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

/** A decision as plain data: policies as their text, routes as their providers and evidence. */
function view(decision: Decision): unknown {
  const text = (p: Parameters<typeof formatPolicy>[0] | null): string | null => (p === null ? null : formatPolicy(p).ok ? (formatPolicy(p) as { value: string }).value : "unwritable");
  switch (decision.action) {
    case "block":
      return decision;
    case "translate":
      return { action: "translate", model: decision.model, provider: decision.provider, sent: text(decision.sent) };
    case "send":
      return {
        action: "send",
        model: decision.model,
        header: decision.header,
        sent: text(decision.sent),
        routes: decision.routes === null ? null : [...decision.routes].map(([provider, route]) => [provider, route?.evidence ?? null]),
      };
  }
}

const sendView = (model: string, header: string | null, sent: string | null, routes: unknown = null): unknown => ({ action: "send", model, header, sent, routes });
const blockView = (reason: string): unknown => ({ action: "block", reason });
const NO_DETECTION = `${BASE} has no valid detection reply (status is 404, not 200), so no requirement may be sent there`;
const unlisted = (what: string): string => `${BASE} does not list ${what} in its detection reply`;
const KEYS = [...baselineSupport().keys];
const ATTEST = [...baselineSupport().attest];
const SORTS = [...baselineSupport().sort];
/** A detection reply listing everything the baseline does but `keys`, `attest`, and `sort` as given. */
const listing = (keys: readonly string[], attest: readonly string[] = ATTEST, sort: readonly string[] = SORTS): Detection =>
  detection({ ...formatDetection(baselineSupport()), keys: [...keys], attest: [...attest], sort: [...sort] });
const USE: Readonly<Record<string, string>> = { zdr: "zdr", notrain: "notrain", bits: "bits=8", region: "region=us", attest: "attest=weights", only: "only=aurora", ignore: "ignore=cobalt", sort: "sort=price", order: "order=aurora" };
/** A policy that uses `key` and carries a requirement, so that it needs detection (C2). */
const using = (key: string): string => (key === "zdr" ? "zdr+notrain" : `zdr+${USE[key] ?? ""}`);

// ---- C1: no valid detection reply.
for (const carriers of ["header", "suffix"] as const) {
  for (const [name, situation] of [
    ["held zdr", { held: held("zdr") }],
    ["typed +notrain", { model: "demo-model+notrain" }],
    ["a configured Route-Policy bits=8", { configured: "bits=8" }],
    ["held zdr and typed +notrain", { held: held("zdr"), model: "demo-model+notrain" }],
    ["held sort=price and typed +zdr", { held: held("sort=price"), model: "demo-model+zdr" }],
    ["held zdr and typed +sort=latency", { held: held("zdr"), model: "demo-model+sort=latency" }],
  ] as const) {
    test(`C1: with the ${carriers} carrier and no detection reply, a request with ${name} is blocked for having no valid detection reply`, () => {
      assert.deepEqual(view(decideFor({ ...situation, carriers, detection: null })), blockView(NO_DETECTION));
    });
  }
}

// ---- C1: what the reply must list.
for (const carrier of ["held on the header", "typed into the model"] as const) {
  test(`C1: for each of the ${KEYS.length} keys of baselineSupport(), a requirement using it ${carrier} is blocked when the reply lists every key but it`, () => {
    assert.ok(KEYS.length > 0);
    for (const key of KEYS) {
      const policy = using(key);
      const situation = carrier === "held on the header" ? { held: held(policy) } : { model: `demo-model+${policy}` };
      assert.deepEqual(view(decideFor({ ...situation, detection: listing(KEYS.filter((k) => k !== key)) })), blockView(unlisted(key)), key);
    }
  });
}

for (const [carrier, place] of [["held on the header", "held"], ["typed into the model", "typed"]] as const) {
  test(`C1: for each of the ${ATTEST.length} attest values of baselineSupport(), zdr+attest=<it> ${carrier} is blocked when the reply lists every attest value but it`, () => {
    assert.ok(ATTEST.length > 0);
    for (const item of ATTEST) {
      const policy = `zdr+attest=${item}`;
      const situation = place === "held" ? { held: held(policy) } : { model: `demo-model+${policy}` };
      assert.deepEqual(view(decideFor({ ...situation, detection: listing(KEYS, ATTEST.filter((a) => a !== item)) })), blockView(unlisted(`attest=${item}`)), item);
    }
  });
  test(`C1: for each of the ${SORTS.length} sort values of baselineSupport(), zdr+sort=<it> ${carrier} is blocked when the reply lists every sort value but it`, () => {
    assert.ok(SORTS.length > 0);
    for (const order of SORTS) {
      const policy = `zdr+sort=${order}`;
      const situation = place === "held" ? { held: held(policy) } : { model: `demo-model+${policy}` };
      assert.deepEqual(view(decideFor({ ...situation, detection: listing(KEYS, ATTEST, SORTS.filter((s) => s !== order)) })), blockView(unlisted(`sort=${order}`)), order);
    }
  });
}

for (const [name, situation, reply, missing] of [
  ["held attest=weights,prompt, the reply listing prompt only", { held: held("attest=weights,prompt") }, listing(KEYS, ["prompt"]), "attest=weights"],
  ["held attest=weights,prompt, the reply listing weights only", { held: held("attest=weights,prompt") }, listing(KEYS, ["weights"]), "attest=prompt"],
  ["typed +zdr+attest=weights,prompt, the reply listing weights only", { model: "demo-model+zdr+attest=weights,prompt" }, listing(KEYS, ["weights"]), "attest=prompt"],
  ["held attest=weights and typed +attest=prompt, the reply listing weights only", { held: held("attest=weights"), model: "demo-model+attest=prompt" }, listing(KEYS, ["weights"]), "attest=prompt"],
  ["held attest=weights and typed +attest=prompt, the reply listing prompt only", { held: held("attest=weights"), model: "demo-model+attest=prompt" }, listing(KEYS, ["prompt"]), "attest=weights"],
  ["held zdr+sort=price and typed +sort=latency, the reply listing latency only", { held: held("zdr+sort=price"), model: "demo-model+sort=latency" }, listing(KEYS, ATTEST, ["latency"]), "sort=price"],
  ["held zdr+sort=throughput, the reply listing price and latency", { held: held("zdr+sort=throughput") }, listing(KEYS, ATTEST, ["price", "latency"]), "sort=throughput"],
  ["held zdr and typed +bits=8, the reply not listing bits", { held: held("zdr"), model: "demo-model+bits=8" }, listing(KEYS.filter((k) => k !== "bits")), "bits"],
  ["held bits=8 and typed +zdr, the reply not listing bits", { held: held("bits=8"), model: "demo-model+zdr" }, listing(KEYS.filter((k) => k !== "bits")), "bits"],
  ["held zdr and a configured Route-Policy bits=8, the reply not listing bits", { held: held("zdr"), configured: "bits=8" }, listing(KEYS.filter((k) => k !== "bits")), "bits"],
] as const) {
  test(`C1: a request with ${name} is blocked for ${missing} not being listed`, () => {
    assert.deepEqual(view(decideFor({ ...situation, detection: reply })), blockView(unlisted(missing)));
  });
}

test("C1: held zdr+attest=prompt+sort=latency+order=aurora with typed +bits=8, the reply listing everything, is sent with header zdr+attest=prompt+sort=latency+order=aurora", () => {
  assert.deepEqual(view(decideFor({ held: held("zdr+attest=prompt+sort=latency+order=aurora"), model: "demo-model+bits=8" })), sendView("demo-model+bits=8", "zdr+attest=prompt+sort=latency+order=aurora", "zdr+bits=8+attest=prompt+sort=latency+order=aurora"));
});

// ---- C2: preferences alone need no detection.
test("C2: held sort=price+order=basalt with typed +sort=latency and no detection reply is sent with header sort=price+order=basalt and the model as typed", () => {
  assert.deepEqual(view(decideFor({ held: held("sort=price+order=basalt"), model: "demo-model+sort=latency", detection: null })), sendView("demo-model+sort=latency", "sort=price+order=basalt", "sort=latency+order=basalt"));
});

// ---- C1: no policy at all.
for (const [name, reply] of [
  ["no detection reply", null],
  ["a full detection reply", detection({ route_policy: "1" })],
  ["a detection reply listing no keys", detection({ route_policy: "1", keys: [] })],
  ["a detection reply with key policy zdr", detection({ route_policy: "1", key_policy: "zdr" })],
] as const) {
  test(`C1: a request with no policy and ${name} is sent as it is`, () => {
    assert.deepEqual(view(decideFor({ detection: reply })), sendView("demo-model", null, null));
  });
}

test("C1: a request for vendor/model with no policy at OpenRouter's base URL and no detection reply is sent as it is", () => {
  assert.deepEqual(view(decideFor({ base: OPENROUTER_BASE, detection: null, model: "vendor/model" })), sendView("vendor/model", null, null));
});

// ---- C10: carriers.
test("C10: with the header carrier, held zdr+sort=price and typed +notrain+sort=latency is sent with header zdr+sort=price and model demo-model+notrain+sort=latency", () => {
  assert.deepEqual(view(decideFor({ held: held("zdr+sort=price"), model: "demo-model+notrain+sort=latency", carriers: "header" })), sendView("demo-model+notrain+sort=latency", "zdr+sort=price", "zdr+notrain+sort=latency"));
});

test("C10: with the header carrier, held zdr and typed +sort=latency+notrain is sent with model demo-model+sort=latency+notrain as typed", () => {
  assert.deepEqual(view(decideFor({ held: held("zdr"), model: "demo-model+sort=latency+notrain", carriers: "header" })), sendView("demo-model+sort=latency+notrain", "zdr", "zdr+notrain+sort=latency"));
});

test("C10: with the suffix carrier, held zdr+region=us,de+sort=price and typed +region=de,fr+sort=latency is sent with model demo-model+zdr+region=de+sort=latency and no header", () => {
  assert.deepEqual(view(decideFor({ held: held("zdr+region=us,de+sort=price"), model: "demo-model+region=de,fr+sort=latency", carriers: "suffix" })), sendView("demo-model+zdr+region=de+sort=latency", null, "zdr+region=de+sort=latency"));
});

const UNWRITABLE = (detail: string): string => `the held policy and the typed suffix combine to one that cannot be written as a policy (${detail}); no weaker one is sent in its place`;
test("C10: with the suffix carrier, held region=us and typed +region=de is blocked: they combine to one that cannot be written", () => {
  assert.deepEqual(view(decideFor({ held: held("region=us"), model: "demo-model+region=de", carriers: "suffix" })), blockView(UNWRITABLE('malformed item ""')));
});

const ignore = (prefix: string, count: number): string => `ignore=${Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(",")}`;
test("C10: with the suffix carrier, held zdr plus 9 ignored providers and typed 8 other ignored providers is blocked: they combine to one that cannot be written", () => {
  assert.deepEqual(view(decideFor({ held: held(`zdr+${ignore("a", 9)}`), model: `demo-model+${ignore("b", 8)}`, carriers: "suffix" })), blockView(UNWRITABLE("more than 16 items")));
});

test("C10: with the header carrier, held zdr plus 9 ignored providers and typed 8 other ignored providers is sent, each on its own carrier", () => {
  assert.deepEqual(view(decideFor({ held: held(`zdr+${ignore("a", 9)}`), model: `demo-model+${ignore("b", 8)}`, carriers: "header" })), sendView(`demo-model+${ignore("b", 8)}`, `zdr+${ignore("a", 9)}`, "unwritable"));
});

test("C10: with the header carrier, held zdr+sort=price and a configured Route-Policy bits=8+sort=latency is sent with header zdr+bits=8+sort=price", () => {
  assert.deepEqual(view(decideFor({ held: held("zdr+sort=price"), configured: "bits=8+sort=latency", carriers: "header" })), sendView("demo-model", "zdr+bits=8+sort=price", "zdr+bits=8+sort=price"));
});

test("C10: with the header carrier, held region=us and a configured Route-Policy region=de is blocked: they combine to one that cannot be written", () => {
  assert.deepEqual(view(decideFor({ held: held("region=us"), configured: "region=de", carriers: "header" })), blockView('the held policy and the configured Route-Policy header combine to one that cannot be written as a policy (malformed item "")'));
});

test("C10: with the suffix carrier, held zdr and a configured Route-Policy bits=8 is sent with header bits=8 and model demo-model+zdr", () => {
  assert.deepEqual(view(decideFor({ held: held("zdr"), configured: "bits=8", carriers: "suffix" })), sendView("demo-model+zdr", "bits=8", "zdr+bits=8"));
});

for (const [name, situation, reason] of [
  ["held zdr+zdr", { held: holdPolicy("zdr+zdr", "env") }, 'the held policy "zdr+zdr" is not valid: repeated key'],
  ["model demo-model+zdr=1", { model: "demo-model+zdr=1" }, 'the model id "demo-model+zdr=1" carries a suffix that is not a valid policy: takes no value'],
  ["a configured Route-Policy bits=0", { configured: "bits=0" }, 'the configured Route-Policy header "bits=0" is not a valid policy: takes one integer from 1 to 64'],
] as const) {
  test(`C10: a request with ${name} is blocked: "${reason}"`, () => {
    assert.deepEqual(view(decideFor(situation)), blockView(reason));
  });
}

// ---- C16: with the model list held.
const UNMET = (model: string, what: string): string => `no route the model list publishes for ${model} meets the ${what}, so the gateway would refuse it only after receiving the content`;
const TWO = { data: [...MODEL_LIST.data, { id: "other-model", routes: [{ provider: "cobalt", facts: "notrain" }] }] };
test("C16: held only=nosuch with MODEL_LIST held is blocked: no published route meets it", () => {
  assert.deepEqual(view(decideFor({ held: held("only=nosuch"), list: MODEL_LIST })), blockView(UNMET("demo-model", "policy")));
});
test("C16: held only=nosuch with no model list held is sent with header only=nosuch", () => {
  assert.deepEqual(view(decideFor({ held: held("only=nosuch") })), sendView("demo-model", "only=nosuch", "only=nosuch"));
});
test("C16: held zdr with typed +bits=16 and MODEL_LIST held is blocked: no published route meets both", () => {
  assert.deepEqual(view(decideFor({ held: held("zdr"), model: "demo-model+bits=16", list: MODEL_LIST })), blockView(UNMET("demo-model", "policy")));
});
test("C16: held zdr with typed +bits=8 and MODEL_LIST held is sent with demo-model's routes aurora, basalt, and cobalt", () => {
  assert.deepEqual(view(decideFor({ held: held("zdr"), model: "demo-model+bits=8", list: MODEL_LIST })), sendView("demo-model+bits=8", "zdr", "zdr+bits=8", [["aurora", null], ["basalt", "https://basalt.example/attestation"], ["cobalt", null]]));
});
test("C16: held zdr for other-model, whose only route cobalt publishes notrain, is blocked", () => {
  assert.deepEqual(view(decideFor({ held: held("zdr"), model: "other-model", list: TWO })), blockView(UNMET("other-model", "policy")));
});
test("C16: held notrain for other-model, whose only route cobalt publishes notrain, is sent with route cobalt", () => {
  assert.deepEqual(view(decideFor({ held: held("notrain"), model: "other-model", list: TWO })), sendView("other-model", "notrain", "notrain", [["cobalt", null]]));
});

const basalt = (evidence?: unknown): unknown => ({ data: [{ id: "demo-model", routes: [{ provider: "basalt", facts: "attest=weights", ...(evidence === undefined ? {} : { evidence }) }] }] });
test("C16: held attest=weights with basalt publishing evidence https://basalt.example/attestation is sent with that route", () => {
  assert.deepEqual(view(decideFor({ held: held("attest=weights"), list: basalt("https://basalt.example/attestation") })), sendView("demo-model", "attest=weights", "attest=weights", [["basalt", "https://basalt.example/attestation"]]));
});
for (const [name, evidence] of [
  ["evidence http://basalt.example/attestation", "http://basalt.example/attestation"],
  ["no evidence member", undefined],
  ["evidence null", null],
  ["evidence 7", 7],
  ['evidence ["https://basalt.example/attestation"]', ["https://basalt.example/attestation"]],
  ["a 513-byte evidence URI", `https://basalt.example/${"a".repeat(513 - "https://basalt.example/".length)}`],
] as const) {
  test(`C16: held attest=weights with basalt publishing ${name} is blocked: no published route meets it`, () => {
    assert.deepEqual(view(decideFor({ held: held("attest=weights"), list: basalt(evidence) })), blockView(UNMET("demo-model", "policy")));
  });
}

const keyed = (keyPolicy: string, keys: readonly string[] = KEYS): Detection =>
  detection({ ...formatDetection({ keys: new Set(), attest: new Set(["weights", "prompt"]), sort: new Set(["price"]) }), keys: [...keys], key_policy: keyPolicy });
test("C16, C12: held notrain with key policy only=cobalt and MODEL_LIST held is blocked: no route meets both", () => {
  assert.deepEqual(view(decideFor({ held: held("notrain"), list: MODEL_LIST, detection: keyed("only=cobalt") })), blockView(UNMET("demo-model", "policy combined with the key's own")));
});
test("C16, C12: held notrain with the uninterpretable key policy only=cobalt+future and MODEL_LIST held is sent with demo-model's routes", () => {
  assert.deepEqual(view(decideFor({ held: held("notrain"), list: MODEL_LIST, detection: keyed("only=cobalt+future", ["zdr", "notrain", "only", "future"]) })), sendView("demo-model", "notrain", "notrain", [["aurora", null], ["basalt", "https://basalt.example/attestation"], ["cobalt", null]]));
});
test("C16: held sort=price with key policy only=nosuch and MODEL_LIST held is blocked: no route meets the key's own policy with it", () => {
  assert.deepEqual(view(decideFor({ held: held("sort=price"), list: MODEL_LIST, detection: keyed("only=nosuch") })), blockView(UNMET("demo-model", "policy combined with the key's own")));
});
test("C16: no policy with key policy only=nosuch and MODEL_LIST held is blocked: no route meets the key's own policy", () => {
  assert.deepEqual(view(decideFor({ list: MODEL_LIST, detection: keyed("only=nosuch") })), blockView(UNMET("demo-model", "key's own policy")));
});
test("C16: no policy with key policy only=aurora and MODEL_LIST held is sent with demo-model's routes", () => {
  assert.deepEqual(view(decideFor({ list: MODEL_LIST, detection: keyed("only=aurora") })), sendView("demo-model", null, null, [["aurora", null], ["basalt", "https://basalt.example/attestation"], ["cobalt", null]]));
});

// ---- C9: OpenRouter.
test("C9: at OpenRouter's base URL with no detection reply, held only=aurora+ignore=cobalt and typed vendor/model+sort=price is translated to model vendor/model and provider {only, ignore, sort}", () => {
  assert.deepEqual(view(decideFor({ base: OPENROUTER_BASE, detection: null, held: held("only=aurora+ignore=cobalt"), model: "vendor/model+sort=price", carriers: "suffix" })), {
    action: "translate",
    model: "vendor/model",
    provider: { only: ["aurora"], ignore: ["cobalt"], sort: "price" },
    sent: "only=aurora+ignore=cobalt+sort=price",
  });
});
for (const [policy, why] of [
  ["zdr", "zdr has no hard filter there (its zdr field still admits Safety Retention endpoints)"],
  ["notrain", "notrain has no hard filter there (data_collection covers the model providers, not OpenRouter itself)"],
  ["bits=8", "bits has no hard filter there (quantizations names levels, not a floor on every weight)"],
  ["region=us", "region has no request field there"],
  ["attest=weights", "attest has no counterpart there"],
] as const) {
  test(`C9: at OpenRouter's base URL with no detection reply, held only=aurora+${policy} is blocked: ${why}`, () => {
    assert.deepEqual(view(decideFor({ base: OPENROUTER_BASE, detection: null, held: held(`only=aurora+${policy}`) })), blockView(`the policy cannot be translated for OpenRouter: ${why}`));
  });
}
test("C9: at OpenRouter's base URL with no detection reply and the suffix carrier, a configured Route-Policy only=aurora is blocked: it cannot be removed", () => {
  assert.deepEqual(view(decideFor({ base: OPENROUTER_BASE, detection: null, configured: "only=aurora", carriers: "suffix" })), blockView("a Route-Policy header is configured for this provider, and this harness gives the plugin no way to remove it from a translated request"));
});
test("C9: at OpenRouter's base URL with no detection reply and the header carrier, a configured Route-Policy only=aurora is translated to provider {only: [aurora]}", () => {
  assert.deepEqual(view(decideFor({ base: OPENROUTER_BASE, detection: null, configured: "only=aurora", carriers: "header" })), { action: "translate", model: "demo-model", provider: { only: ["aurora"] }, sent: "only=aurora" });
});
test("C9: at OpenRouter's base URL with a valid detection reply and the header carrier, held zdr for vendor/model is sent with header zdr", () => {
  assert.deepEqual(view(decideFor({ base: `${OPENROUTER_BASE}/`, held: held("zdr"), model: "vendor/model", carriers: "header" })), sendView("vendor/model", "zdr", "zdr"));
});
test("C9: at OpenRouter's base URL with a valid detection reply and the suffix carrier, held zdr for vendor/model is sent with model vendor/model+zdr", () => {
  assert.deepEqual(view(decideFor({ base: OPENROUTER_BASE, held: held("zdr"), model: "vendor/model", carriers: "suffix" })), sendView("vendor/model+zdr", null, "zdr"));
});
