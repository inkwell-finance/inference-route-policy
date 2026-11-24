import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { adapterContract } from "../../shared/test/adapter-contract.ts";
import { FakeHarness } from "../../shared/test/fake-harness.ts";
import { fakeGateway, routeOpenRouterTo, type FakeGateway } from "../../shared/test/fixtures.ts";
import routePolicy from "../src/index.ts";

delete process.env["ROUTE_POLICY"];
routeOpenRouterTo(() => gateway.base);

let gateway: FakeGateway;
before(async () => {
  gateway = await fakeGateway();
});
after(async () => {
  await gateway.close();
});
beforeEach(async () => {
  await FakeHarness.endAll();
  gateway.requests.length = 0;
  gateway.replies.detection = { status: 200, body: { route_policy: "1" } };
  gateway.replies.models = { status: 200, body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr+notrain" }, { provider: "cobalt", facts: "" }] }] } };
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=aurora" }, body: {} };
});

/** omp with the plugin loaded and `policy` set through `/route`. */
async function omp(policy?: string): Promise<FakeHarness> {
  const harness = new FakeHarness(gateway.base, { headerHook: false });
  routePolicy(harness.api);
  await harness.emit("session_start", { type: "session_start" });
  if (policy !== undefined) await harness.command("route", policy);
  return harness;
}

const notices = (harness: FakeHarness): string[] => harness.shown.filter((s) => s.method === "notify").map((s) => s.text ?? "");
const BLOCKED = "Blocked by the route policy plugin, nothing was sent: ";
const NO_DETECTION = (): string => `${BLOCKED}${gateway.base} has no valid detection reply (detection reply is not valid: status is 404, not 200), so no requirement may be sent there`;
async function shownBy(harness: FakeHarness, run: () => Promise<unknown>): Promise<unknown[]> {
  const from = harness.shown.length;
  await run();
  return harness.shown.slice(from);
}
/** A payload that counts how often it is serialized. */
function counted(model: string): { payload: Record<string, unknown>; serialized: () => number } {
  let count = 0;
  return {
    payload: {
      model,
      messages: [{ role: "user", content: "secret prompt" }],
      toJSON(): unknown {
        count += 1;
        return { model, messages: [] };
      },
    },
    serialized: () => count,
  };
}

// ---- C1: no detection.
for (const [label, held, model] of [
  ["held zdr", "zdr", "demo-model"],
  ["typed +zdr", undefined, "demo-model+zdr"],
] as const) {
  test(`C1: omp: with detection answering 404, a request with ${label} is blocked: no valid detection reply`, async () => {
    gateway.replies.detection = { status: 404 };
    const harness = await omp(held);
    harness.model.id = model;
    const result = await harness.request({ model, messages: [] });
    assert.deepEqual([result.error, gateway.inference()], [NO_DETECTION(), []]);
  });
  test(`C1: omp: with detection answering 404, the payload of a request with ${label} is never serialized`, async () => {
    gateway.replies.detection = { status: 404 };
    const harness = await omp(held);
    harness.model.id = model;
    const { payload, serialized } = counted(model);
    await harness.request(payload);
    assert.equal(serialized(), 0);
  });
}

// ---- C10: the suffix carrier.
test("C10: omp: held zdr+sort=price with typed +notrain+sort=latency is sent with body model demo-model+zdr+notrain+sort=latency and no Route-Policy header", async () => {
  const harness = await omp("zdr+sort=price");
  harness.model.id = "demo-model+notrain+sort=latency";
  assert.ok((await harness.request({ model: harness.model.id, messages: [] })).sent);
  assert.deepEqual(gateway.inference().map((r) => [JSON.parse(r.body), r.headers["route-policy"]]), [[{ model: "demo-model+zdr+notrain+sort=latency", messages: [] }, undefined]]);
});

// ---- C3, C4: what is shown.
for (const provider of ["aurora", "basalt"]) {
  test(`C3, C4: omp: held zdr answered by ${provider}, published with zdr, is shown quietly on the status line`, async () => {
    gateway.replies.models = { status: 200, body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr+notrain" }, { provider: "basalt", facts: "zdr" }] }] } };
    gateway.replies.inference = { status: 200, headers: { "route-applied": `provider=${provider}` }, body: {} };
    const harness = await omp("zdr");
    const text = `route policy honored: served by ${provider}; its published facts meet the policy (they are the gateway's claims, not verified by this client) (request for demo-model+zdr to ${gateway.base})`;
    assert.deepEqual(await shownBy(harness, () => harness.request()), [{ method: "setStatus", text }]);
  });
}

test("C3, C4: omp: held zdr answered by cobalt, published without zdr, is shown on the status line and as a notice", async () => {
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {} };
  const harness = await omp("zdr");
  const text = `route policy NOT honored: route "cobalt" does not meet the policy sent (request for demo-model+zdr to ${gateway.base})`;
  assert.deepEqual(await shownBy(harness, () => harness.request()), [{ method: "setStatus", text }, { method: "notify", text }]);
});

test("C5, C11: omp: held notrain answered 400 with Route-Refused reason=unsupported+key=bits is shown with reason and key", async () => {
  gateway.replies.inference = { status: 400, headers: { "route-refused": "reason=unsupported+key=bits" }, body: { error: { message: "unsupported" } } };
  const harness = await omp("notrain");
  const text = `route policy refused by the gateway: unsupported (key bits) (request for demo-model+notrain to ${gateway.base})`;
  assert.deepEqual(await shownBy(harness, () => harness.request()), [{ method: "setStatus", text }, { method: "notify", text }]);
});

// ---- C1: failures inside the plugin.
test("C1: omp: a request with held zdr whose key lookup throws keychain locked is blocked: the plugin failed", async () => {
  const harness = await omp("zdr");
  harness.resolveAuth = async () => {
    throw new Error("keychain locked");
  };
  const result = await harness.request();
  assert.deepEqual([result.error, harness.handlerErrors, gateway.inference()], [`${BLOCKED}the plugin failed: keychain locked`, [], []]);
});

test("C1: omp: with detection answering 404 and a UI that throws, a request with held zdr is blocked", async () => {
  gateway.replies.detection = { status: 404 };
  const harness = await omp("zdr");
  harness.uiThrows = true;
  const result = await harness.request();
  assert.deepEqual([result.error, harness.handlerErrors, gateway.inference()], [NO_DETECTION(), [], []]);
});

test("C1: omp: a request with held zdr whose context model has baseUrl 42 is blocked", async () => {
  const harness = await omp("zdr");
  harness.contextModel = { id: "demo-model", baseUrl: 42 };
  const result = await harness.request();
  assert.deepEqual([result.error, harness.handlerErrors, gateway.inference()], [`${BLOCKED}the harness did not say which model and base URL the request is for`, [], []]);
});

test("C1: omp: a request with held zdr whose key lookup never settles is blocked after 20 seconds", async () => {
  const harness = await omp("zdr");
  harness.resolveAuth = () => new Promise(() => {});
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = harness.request();
    // Let the handler start and reach its pending lookup before time moves.
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(20_000);
    const result = await pending;
    assert.deepEqual([result.sent, result.error], [false, `${BLOCKED}the plugin failed: it could not decide within 20 seconds`]);
  } finally {
    mock.timers.reset();
  }
});

// ---- C2: no policy.
const PLAIN = { model: "demo-model", messages: [{ role: "user", content: "hi" }] };
test("C2: omp: a request with no policy is sent with its body bytes as the harness serialized them", async () => {
  const harness = await omp();
  assert.ok((await harness.request(PLAIN)).sent);
  assert.deepEqual(gateway.inference().map((r) => r.body), [JSON.stringify(PLAIN)]);
});

test("C2: omp: a request with no policy is sent with authorization Bearer demo-key and content-type only, no Route-Policy header", async () => {
  const harness = await omp();
  await harness.request(PLAIN);
  const own = (headers: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(headers).filter(([h]) => !["host", "connection", "content-length", "accept", "accept-language", "accept-encoding", "sec-fetch-mode", "user-agent"].includes(h)));
  assert.deepEqual(gateway.inference().map((r) => own(r.headers)), [{ authorization: "Bearer demo-key", "content-type": "application/json" }]);
});

test("C2: omp: a request with no policy reads nothing before it is sent", async () => {
  const harness = await omp();
  await harness.request(PLAIN);
  assert.deepEqual(gateway.requests.map((r) => r.method), ["POST"]);
});

// ---- C10: /route.
test('C10: omp: /route zdr shows "Route policy set: zdr"', async () => {
  const harness = await omp();
  assert.deepEqual(await shownBy(harness, () => harness.command("route", "zdr")), [{ method: "notify", text: "Route policy set: zdr" }]);
});

test('C10: omp: /route zdr+zdr after zdr shows the notice "Not a valid policy, nothing changed: repeated key"', async () => {
  const harness = await omp("zdr");
  assert.deepEqual(await shownBy(harness, () => harness.command("route", "zdr+zdr")), [{ method: "notify", text: "Not a valid policy, nothing changed: repeated key" }]);
});

test("C10: omp: after /route zdr then /route zdr+zdr, the next request is sent with model demo-model+zdr", async () => {
  const harness = await omp("zdr");
  await harness.command("route", "zdr+zdr");
  await harness.request();
  assert.deepEqual(gateway.inference().map((r) => JSON.parse(r.body).model), ["demo-model+zdr"]);
});

const ROUTE_AFTER_ZDR = [
  "Route policy: zdr (set in this session)",
  "Gateway {base}, read with the credential in authorization: detection valid; accepts zdr, notrain, bits, region, attest, only, ignore, sort, order",
  "Key policy: none",
  "Last result: none yet in this session",
];
test(`C10: omp: /route after zdr shows the lines ${JSON.stringify(ROUTE_AFTER_ZDR)}`, async () => {
  const harness = await omp("zdr");
  await harness.command("route", "");
  assert.deepEqual((notices(harness).at(-1) ?? "").split("\n"), ROUTE_AFTER_ZDR.map((line) => line.replace("{base}", gateway.base)));
});

test("C10: omp: /route clear after zdr sends the next request as demo-model", async () => {
  const harness = await omp("zdr");
  await harness.command("route", "clear");
  await harness.request();
  assert.deepEqual(gateway.inference().map((r) => JSON.parse(r.body).model), ["demo-model"]);
});

test("C10: omp: /route zdr then /route clear record the entries {policy: zdr} and {policy: null}", async () => {
  const harness = await omp("zdr");
  await harness.command("route", "clear");
  assert.deepEqual(harness.entries.map((e) => e.data), [{ policy: "zdr" }, { policy: null }]);
});

// ---- C10: resume.
for (const [changes, model] of [
  [["notrain", "zdr", "clear", "zdr+notrain"], "demo-model+zdr+notrain"],
  [["notrain", "zdr", "clear"], "demo-model"],
] as const) {
  test(`C10: omp: a session resumed after /route ${changes.join(", /route ")}, followed by unrelated entries, sends model ${model}`, async () => {
    const first = await omp();
    for (const change of changes) await first.command("route", change);
    const resumed = new FakeHarness(gateway.base, { headerHook: false });
    resumed.entries.push(...first.entries, { type: "custom", customType: "another-plugin", data: { policy: "bits=8" } }, { type: "message", customType: "", data: { policy: "bits=8" } });
    routePolicy(resumed.api);
    await resumed.emit("session_start", { type: "session_start" });
    await resumed.request();
    assert.deepEqual(gateway.inference().map((r) => JSON.parse(r.body).model), [model]);
  });
}

// ---- C15: what the session records.
test("C15: omp: after three responses to held zdr (honored, refused, not honored), then /route reading key policy only=aurora, the session's entries are [{customType: inference-route-policy, policy: zdr}]", async () => {
  const harness = await omp("zdr");
  await harness.request();
  gateway.replies.inference = { status: 400, headers: { "route-refused": "reason=unsatisfiable" }, body: {} };
  await harness.request();
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {} };
  await harness.request();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "only=aurora" } };
  await harness.command("route", "");
  assert.deepEqual(harness.entries.map((e) => [e.customType, e.data]), [["inference-route-policy", { policy: "zdr" }]]);
});

adapterContract("omp", omp, () => gateway);

// ---- C10: the model a payload names.
const TWO_MODELS = { status: 200, body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr+notrain" }] }, { id: "other-model", routes: [{ provider: "cobalt", facts: "notrain" }] }] } };
test("C10: omp: with demo-model selected, a payload for other-model with held notrain is sent as other-model+notrain", async () => {
  gateway.replies.models = TWO_MODELS;
  const harness = await omp("notrain");
  assert.ok((await harness.request({ model: "other-model", messages: [] })).sent);
  assert.deepEqual(gateway.inference().map((r) => JSON.parse(r.body).model), ["other-model+notrain"]);
});

test("C10: omp: with demo-model selected, a payload for other-model with held zdr is blocked by other-model's routes", async () => {
  gateway.replies.models = TWO_MODELS;
  const harness = await omp("zdr");
  const result = await harness.request({ model: "other-model", messages: [] });
  assert.deepEqual([result.error, gateway.inference()], [`${BLOCKED}no route the model list publishes for other-model meets the policy, so the gateway would refuse it only after receiving the content`, []]);
});

test("C10: omp: with demo-model+notrain selected, a payload for other-model+notrain is sent as other-model+notrain", async () => {
  gateway.replies.models = TWO_MODELS;
  const harness = await omp();
  harness.model.id = "demo-model+notrain";
  assert.ok((await harness.request({ model: "other-model+notrain", messages: [] })).sent);
  assert.deepEqual(gateway.inference().map((r) => JSON.parse(r.body).model), ["other-model+notrain"]);
});

for (const [selected, payload] of [
  ["demo-model+notrain", "other-model+zdr"],
  ["demo-model", "other-model+notrain"],
  ["demo-model+notrain", "other-model"],
  ["demo-model+only=east", "demo-model"],
] as const) {
  test(`C10: omp: with ${selected} selected, a payload for ${payload} is blocked: their typed suffixes differ`, async () => {
    gateway.replies.models = TWO_MODELS;
    const harness = await omp(selected.endsWith("only=east") ? "only=west" : undefined);
    harness.model.id = selected;
    const result = await harness.request({ model: payload, messages: [] });
    assert.deepEqual([result.error, gateway.inference()], [`${BLOCKED}the request names the model "${payload}" while "${selected}" is selected; the policy typed into one is not in the other`, []]);
  });
}

test("C10: omp: a payload {messages} with no model field, with held zdr, is blocked: no model field to carry the policy", async () => {
  const harness = await omp("zdr");
  const result = await harness.request({ messages: [] });
  assert.deepEqual([result.error, gateway.inference()], [`${BLOCKED}the request has no model field to carry the policy`, []]);
});
