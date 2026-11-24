import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { MODEL_IN_URL_APIS } from "../../shared/src/plugin.ts";
import { adapterContract } from "../../shared/test/adapter-contract.ts";
import { FakeHarness } from "../../shared/test/fake-harness.ts";
import { fakeGateway, routeOpenRouterTo, type FakeGateway } from "../../shared/test/fixtures.ts";
import routePolicy from "../src/index.ts";

delete process.env["ROUTE_POLICY"];

let gateway: FakeGateway;
routeOpenRouterTo(() => gateway.base);
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
  gateway.replies.models = { status: 200, body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr+notrain+bits=8" }] }] } };
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=aurora" }, body: {} };
});

/** pi with the plugin loaded and `policy` set through `/route`. */
async function pi(policy?: string): Promise<FakeHarness> {
  const harness = new FakeHarness(gateway.base, { headerHook: true });
  routePolicy(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  if (policy !== undefined) await harness.command("route", policy);
  return harness;
}

const BLOCKED = "Blocked by the route policy plugin, nothing was sent: ";
const UNPREPARED = `${BLOCKED}the plugin did not see this request's headers, so it cannot tell which policy they carry`;
const prepare = (harness: FakeHarness, headers: Record<string, string | null> = {}): Promise<unknown> => harness.emit("before_provider_headers", { type: "before_provider_headers", headers });
const payloadHook = (harness: FakeHarness, payload: Record<string, unknown>): Promise<unknown> => harness.emit("before_provider_request", { type: "before_provider_request", payload }, "payload");
/** What serializing a hook's returned payload does: its JSON, or the error a blocked payload throws. */
function serialized(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// ---- C10: carriers.
test("C10: pi: held zdr+sort=price with typed +sort=latency+bits=8 is sent with Route-Policy zdr+sort=price and body model demo-model+sort=latency+bits=8 as typed", async () => {
  const harness = await pi("zdr+sort=price");
  harness.model.id = "demo-model+sort=latency+bits=8";
  assert.ok((await harness.request({ model: harness.model.id, messages: [] })).sent);
  assert.deepEqual(gateway.inference().map((r) => [r.headers["route-policy"], JSON.parse(r.body)]), [["zdr+sort=price", { model: "demo-model+sort=latency+bits=8", messages: [] }]]);
});

test("C10: pi: held zdr with a configured route-policy bits=8 is sent with Route-Policy zdr+bits=8", async () => {
  const harness = await pi("zdr");
  harness.model.headers = { "route-policy": "bits=8" };
  await harness.request();
  assert.deepEqual(gateway.inference().map((r) => r.headers["route-policy"]), ["zdr+bits=8"]);
});

for (const [label, configured, expected] of [
  ["ROUTE-POLICY bits=8", { "ROUTE-POLICY": "bits=8" }, { "ROUTE-POLICY": null, "Route-Policy": "zdr+bits=8" }],
  ["Route-Policy bits=8 and route-policy notrain", { "Route-Policy": "bits=8", "route-policy": "notrain" }, { "Route-Policy": "zdr+notrain", "route-policy": null }],
] as const) {
  test(`C10: pi: held zdr's header hook, given the configured ${label}, leaves only Route-Policy set, to the combination`, async () => {
    const harness = await pi("zdr");
    harness.model.headers = { ...configured };
    const headers: Record<string, string | null> = { ...configured };
    await prepare(harness, headers);
    assert.deepEqual(headers, expected);
  });
}

// ---- C1: no detection.
for (const [label, held, model, configured] of [
  ["held zdr", "zdr", "demo-model", undefined],
  ["typed +zdr", undefined, "demo-model+zdr", undefined],
  ["a configured route-policy zdr", undefined, "demo-model", { "route-policy": "zdr" }],
] as const) {
  test(`C1: pi: with detection answering route_policy 1 as a number, a request with ${label} is blocked: no valid detection reply`, async () => {
    gateway.replies.detection = { status: 200, body: { route_policy: 1 } };
    const harness = await pi(held);
    harness.model.id = model;
    if (configured !== undefined) harness.model.headers = { ...configured };
    const result = await harness.request({ model, messages: [] });
    assert.deepEqual([result.error, gateway.inference()], [`${BLOCKED}${gateway.base} has no valid detection reply (detection reply is not valid: route_policy is not the string "1"), so no requirement may be sent there`, []]);
  });
}

// ---- C1: payloads and their headers.
for (const [label, held, model, configured] of [
  ["held zdr", "zdr", "demo-model", undefined],
  ["typed +zdr", undefined, "demo-model+zdr", undefined],
  ["no policy", undefined, "demo-model", undefined],
  ["a configured route-policy zdr", undefined, "demo-model", { "route-policy": "zdr" }],
] as const) {
  test(`C1: pi: a payload for ${model} with ${label}, whose headers the plugin never prepared, is blocked`, async () => {
    const harness = await pi(held);
    harness.model.id = model;
    if (configured !== undefined) harness.model.headers = { ...configured };
    assert.equal(serialized(await payloadHook(harness, { model, messages: [] })), UNPREPARED);
  });
}

test("C1: pi: a payload after headers prepared with held zdr and then with none is blocked: its header is unknowable", async () => {
  const harness = await pi("zdr");
  await prepare(harness);
  await harness.command("route", "clear");
  await prepare(harness);
  assert.equal(serialized(await payloadHook(harness, { model: "demo-model", messages: [] })), `${BLOCKED}requests for this model were prepared with different policies or keys at once; resend it`);
});

test("C14: pi: a payload after headers prepared with Bearer demo-key and with Bearer demo-key-zdr is blocked: its key is unknowable", async () => {
  const harness = await pi("zdr");
  await prepare(harness, { authorization: "Bearer demo-key" });
  await prepare(harness, { authorization: "Bearer demo-key-zdr" });
  assert.equal(serialized(await payloadHook(harness, { model: "demo-model", messages: [] })), `${BLOCKED}requests for this model were prepared with different policies or keys at once; resend it`);
});

test("C1: pi: a request with held zdr whose key lookup throws keychain locked is blocked: its headers could not be prepared", async () => {
  const harness = await pi("zdr");
  harness.resolveAuth = async () => {
    throw new Error("keychain locked");
  };
  const result = await harness.request();
  assert.deepEqual([result.error, harness.handlerErrors, gateway.inference()], [`${BLOCKED}the plugin could not prepare the headers of a request in flight, so which policy this one carries is unknowable`, [], []]);
});

test("C1: pi: a request with held zdr whose header hook's key lookup never settles is blocked after 20 seconds, not given an earlier preparation", async () => {
  const harness = await pi("zdr");
  await prepare(harness);
  let calls = 0;
  harness.resolveAuth = () => (calls++ === 0 ? new Promise(() => {}) : Promise.resolve({ ok: true, apiKey: "demo-key" }));
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = harness.request();
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(20_000);
    const result = await pending;
    assert.deepEqual([result.error, gateway.inference()], [`${BLOCKED}the plugin could not prepare the headers of a request in flight, so which policy this one carries is unknowable`, []]);
  } finally {
    mock.timers.reset();
  }
});

test("C5, C11: pi: held notrain answered 503 with Route-Refused reason=unavailable is shown with its reason", async () => {
  gateway.replies.inference = { status: 503, headers: { "route-refused": "reason=unavailable" }, body: {} };
  const harness = await pi("notrain");
  const from = harness.shown.length;
  await harness.request();
  const text = `route policy refused by the gateway: unavailable (request for demo-model to ${gateway.base})`;
  assert.deepEqual(harness.shown.slice(from), [{ method: "setStatus", text }, { method: "notify", text }]);
});

test("C1: pi: a payload for other-model, with headers prepared for demo-model, is blocked", async () => {
  const harness = await pi("zdr");
  const result = await harness.request({ model: "other-model", messages: [] });
  assert.deepEqual([result.error, gateway.inference()], [`${BLOCKED}the request's model is not the one its headers were prepared for`, []]);
});

test("C1: pi: a payload for other-model, with headers prepared only while demo-model was selected, is blocked as unprepared", async () => {
  const harness = await pi("zdr");
  await prepare(harness);
  harness.model.id = "other-model";
  assert.equal(serialized(await payloadHook(harness, { model: "other-model", messages: [] })), UNPREPARED);
});

// ---- C14: preparations and discards.
test("C14: pi: a payload whose headers were prepared before another request came back not honored is blocked as discarded", async () => {
  const harness = await pi("zdr");
  await prepare(harness);
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {} };
  await harness.request();
  assert.equal(serialized(await payloadHook(harness, { model: "demo-model", messages: [] })), `${BLOCKED}the detection reply this request was checked against was discarded since; it is not sent`);
});

test('C14: pi: after a request came back not honored, the next request makes the gateway requests ["GET /v1/route-policy", "POST /v1/chat/completions"]', async () => {
  const harness = await pi("zdr");
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {} };
  await harness.request();
  gateway.requests.length = 0;
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=aurora" }, body: {} };
  await harness.request();
  assert.deepEqual(gateway.requests.map((r) => `${r.method} ${r.path}`), ["GET /v1/route-policy", "POST /v1/chat/completions"]);
});

test("C14: pi: with a stale preparation queued ahead of a fresh one, the next payload alone, sent with the fresh headers, is the one POST that reaches the gateway", async () => {
  const harness = await pi("zdr");
  await prepare(harness);
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {} };
  await harness.request();
  const fresh: Record<string, string | null> = {};
  await prepare(harness, fresh);
  assert.equal(serialized(await payloadHook(harness, { model: "demo-model", messages: [] })), `${BLOCKED}the detection reply this request was checked against was discarded since; it is not sent`);
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=aurora" }, body: {} };
  const posts = gateway.inference().length;
  const body = serialized(await payloadHook(harness, { model: "demo-model", messages: [] }));
  const headers = { authorization: "Bearer demo-key", "content-type": "application/json", ...Object.fromEntries(Object.entries(fresh).filter((e): e is [string, string] => e[1] !== null)) };
  await (await fetch(`${gateway.base}/chat/completions`, { method: "POST", headers, body })).text();
  assert.deepEqual(gateway.inference().slice(posts).map((r) => [r.body, r.headers["route-policy"]]), [[JSON.stringify({ model: "demo-model", messages: [] }), "zdr"]]);
});

// ---- C1, C14: Google's key header.
test('C1, C14: pi: a request with held zdr over google-generative-ai makes the gateway requests [GET, GET, POST], each with [x-goog-api-key, authorization] as ["demo-key", undefined]', async () => {
  const harness = await pi("zdr");
  harness.model.api = "google-generative-ai";
  assert.ok((await harness.request({ contents: [] })).sent);
  assert.deepEqual(gateway.requests.map((r) => [r.method, r.headers["x-goog-api-key"], r.headers.authorization]), [["GET", "demo-key", undefined], ["GET", "demo-key", undefined], ["POST", "demo-key", undefined]]);
});

for (const [label, wireKey] of [["x-goog-api-key other-key", "other-key"], ["no x-goog-api-key", null]] as const) {
  test(`C1, C14: pi: a request with held zdr over google-generative-ai leaving with ${label} is stopped at fetch`, async () => {
    const harness = await pi("zdr");
    harness.model.api = "google-generative-ai";
    harness.wireKey = wireKey;
    const result = await harness.request({ contents: [] });
    assert.deepEqual([result.sent, result.error?.includes("is not one the plugin released"), gateway.inference()], [false, true, []]);
  });
}

// ---- C10: where the model is named.
test(`C10: pi: for each of the ${MODEL_IN_URL_APIS.length} APIs in MODEL_IN_URL_APIS, held zdr with body {contents} is sent with Route-Policy zdr and that body`, async () => {
  assert.ok(MODEL_IN_URL_APIS.length > 0);
  for (const api of MODEL_IN_URL_APIS) {
    gateway.requests.length = 0;
    const harness = await pi("zdr");
    harness.model.api = api;
    assert.ok((await harness.request({ contents: [] })).sent, api);
    assert.deepEqual(gateway.inference().map((r) => [r.headers["route-policy"], r.body]), [["zdr", JSON.stringify({ contents: [] })]], api);
  }
});

for (const api of ["openai-completions", "openai-responses", "anthropic-messages", "azure-openai-responses", "mistral-conversations"]) {
  for (const held of ["zdr", "sort=price"]) {
    test(`C10: pi: held ${held} with body {input} and no model, over ${api}, is blocked: it has no model`, async () => {
      const harness = await pi(held);
      harness.model.api = api;
      const result = await harness.request({ input: "fixture" });
      assert.deepEqual([result.error, gateway.inference()], [`${BLOCKED}the request has no model in its body, which the ${api} API needs to carry the model and its suffix`, []]);
    });
  }
}

// ---- C10: resume.
for (const [changes, header] of [
  [["notrain", "zdr", "clear", "zdr+notrain"], "zdr+notrain"],
  [["notrain", "zdr", "clear"], undefined],
] as const) {
  test(`C10: pi: a session resumed after /route ${changes.join(", /route ")}, followed by unrelated entries, sends Route-Policy ${String(header)}`, async () => {
    const first = await pi();
    for (const change of changes) await first.command("route", change);
    const resumed = new FakeHarness(gateway.base, { headerHook: true });
    resumed.entries.push(...first.entries, { type: "custom", customType: "another-plugin", data: { policy: "bits=8" } }, { type: "message", customType: "", data: { policy: "bits=8" } });
    routePolicy(resumed.api);
    await resumed.emit("session_start", { type: "session_start", reason: "resume" });
    await resumed.request();
    assert.deepEqual(gateway.inference().map((r) => r.headers["route-policy"]), [header]);
  });
}

adapterContract("pi", pi, () => gateway);
