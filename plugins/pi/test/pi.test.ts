import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
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

const notices = (harness: FakeHarness): string[] => harness.shown.filter((s) => s.method === "notify").map((s) => s.text);
const sentBody = (): unknown => JSON.parse(gateway.inference()[0]?.body ?? "{}");

test("C10: pi: the held policy goes by the Route-Policy header and a typed suffix stays as typed", async () => {
  const harness = await pi("zdr+sort=price");
  harness.model.id = "demo-model+bits=8";
  assert.ok((await harness.request({ model: harness.model.id, messages: [] })).sent);
  const [request] = gateway.inference();
  assert.equal(request?.headers["route-policy"], "zdr+sort=price");
  assert.deepEqual(sentBody(), { model: "demo-model+bits=8", messages: [] });
  assert.match(harness.shown.at(-1)?.text ?? "", /^route policy honored: served by aurora/);
});

test("C10: pi: a Route-Policy header from the provider configuration is replaced by its combination with the held policy", async () => {
  const harness = await pi("zdr");
  harness.model.headers = { "route-policy": "bits=8" };
  await harness.request();
  assert.equal(gateway.inference()[0]?.headers["route-policy"], "zdr+bits=8");
});

test("C1: pi: a requirement with no valid detection reply is blocked and nothing reaches the gateway", async () => {
  gateway.replies.detection = { status: 200, body: { route_policy: 1 } };
  const harness = await pi("zdr");
  const result = await harness.request();
  assert.equal(result.sent, false);
  assert.equal(gateway.inference().length, 0);
  assert.match(notices(harness).at(-1) ?? "", /no valid detection reply/);
});

test("C1: pi: a payload whose headers the plugin never prepared is blocked", async () => {
  const harness = await pi("zdr");
  const payload = await harness.emit("before_provider_request", { type: "before_provider_request", payload: { model: "demo-model", messages: [] } }, "payload");
  assert.throws(() => JSON.stringify(payload), /did not see this request's headers/);
});

test("C1: pi: requests prepared with different policies at once block the next payload, since its header is unknowable", async () => {
  const harness = await pi("zdr");
  await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} });
  await harness.command("route", "clear");
  await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} });
  const payload = await harness.emit("before_provider_request", { type: "before_provider_request", payload: { model: "demo-model", messages: [] } }, "payload");
  assert.throws(() => JSON.stringify(payload), /prepared with different policies/);
});

test("C1: pi: a failure inside the plugin blocks the request instead of sending it without its policy", async () => {
  const harness = await pi("zdr");
  harness.resolveAuth = async () => {
    throw new Error("keychain locked");
  };
  // The header hook fails first, so the payload is blocked as one whose headers could not be prepared.
  assert.match((await harness.request()).error ?? "", /could not prepare the headers of a request in flight/);
  assert.equal(gateway.inference().length, 0);
  assert.deepEqual(harness.handlerErrors, []);
});

test("C1: pi: header preparation that never finishes is bounded, and its request is blocked, not given an earlier preparation", async () => {
  const harness = await pi("zdr");
  // A request whose headers were prepared, but whose payload never came, leaves a send decision waiting.
  await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} });
  let calls = 0;
  harness.resolveAuth = () => (calls++ === 0 ? new Promise(() => {}) : Promise.resolve({ ok: true, apiKey: "demo-key" }));
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = harness.request();
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(20_000);
    const result = await pending;
    assert.equal(result.sent, false);
    assert.match(result.error ?? "", /could not prepare the headers of a request in flight/);
  } finally {
    mock.timers.reset();
  }
  assert.equal(gateway.inference().length, 0);
});

test("C5, C11: pi: a 503 refusal is shown with its reason", async () => {
  gateway.replies.inference = { status: 503, headers: { "route-refused": "reason=unavailable" }, body: {} };
  const harness = await pi("notrain");
  await harness.request();
  assert.equal(notices(harness).at(-1), `route policy refused by the gateway: unavailable (request for demo-model to ${gateway.base})`);
});

test("C1: pi: a payload naming another model than its headers were prepared for is blocked", async () => {
  const harness = await pi("zdr");
  const result = await harness.request({ model: "other-model", messages: [] });
  assert.match(result.error ?? "", /the request's model is not the one its headers were prepared for/);
});

test("C14: pi: a request prepared before another came back not honored is not released, and no stale detection decides it", async () => {
  const harness = await pi("zdr");
  // B's headers are prepared while A is out; A then comes back not honored, which discards the detection reply.
  await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} });
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {} };
  await harness.request();
  assert.match(notices(harness).at(-1) ?? "", /NOT honored/);
  const reads = gateway.requests.filter((r) => r.path.endsWith("/route-policy")).length;
  gateway.requests.length = 0;
  const payload = await harness.emit("before_provider_request", { type: "before_provider_request", payload: { model: "demo-model", messages: [] } }, "payload");
  assert.throws(() => JSON.stringify(payload), /the detection reply this request was checked against was discarded since; it is not sent/);
  assert.ok(reads >= 1);
  // The next request reads detection again before anything goes.
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=aurora" }, body: {} };
  assert.ok((await harness.request()).sent);
  assert.equal(gateway.requests.filter((r) => r.path.endsWith("/route-policy")).length, 1);
});

test("C14: pi: preparations are taken in the order they were made: a stale one ahead of a fresh one blocks the first payload, and the fresh one serves the next", async () => {
  const harness = await pi("zdr");
  const headers = async (): Promise<unknown> => harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} });
  const payload = async (): Promise<unknown> => harness.emit("before_provider_request", { type: "before_provider_request", payload: { model: "demo-model", messages: [] } }, "payload");
  // Prepared on the first detection reply, then left waiting while a request comes back not honored.
  await headers();
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {} };
  await harness.request();
  // Prepared again, on a fresh reply: the queue is now [stale, fresh].
  await headers();
  const stale = await payload();
  assert.throws(() => JSON.stringify(stale), /discarded since; it is not sent/);
  assert.deepEqual(JSON.parse(JSON.stringify(await payload())), { model: "demo-model", messages: [] }, "the fresh preparation is released");
});

test("C14: pi: requests for one model prepared with different keys at once block the next payload", async () => {
  const harness = await pi("zdr");
  await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: { authorization: "Bearer demo-key" } });
  await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: { authorization: "Bearer demo-key-zdr" } });
  const payload = await harness.emit("before_provider_request", { type: "before_provider_request", payload: { model: "demo-model", messages: [] } }, "payload");
  assert.throws(() => JSON.stringify(payload), /prepared with different policies or keys at once/);
});

adapterContract("pi", pi, () => gateway);

test("C1: pi: headers prepared for one model are not taken by another model's payload", async () => {
  const harness = await pi("zdr");
  await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} });
  harness.model.id = "other-model";
  const payload = await harness.emit("before_provider_request", { type: "before_provider_request", payload: { model: "other-model", messages: [] } }, "payload");
  assert.throws(() => JSON.stringify(payload), /did not see this request's headers/);
});

test("C1, C14: pi: a Google API request carries its key in x-goog-api-key, which the plugin reads detection with and the gate expects", async () => {
  const harness = await pi("zdr");
  harness.model.api = "google-generative-ai";
  assert.ok((await harness.request({ contents: [] })).sent);
  assert.ok(gateway.requests.filter((r) => r.method === "GET").every((r) => r.headers["x-goog-api-key"] === "demo-key" && r.headers.authorization === undefined));
});

test("C10: pi: each API that names its model in the URL may send a body without a model, its policy on the header alone", async () => {
  for (const api of ["google-generative-ai", "google-vertex", "google-gemini-cli", "bedrock-converse-stream"]) {
    gateway.requests.length = 0;
    const harness = await pi("zdr");
    harness.model.api = api;
    assert.ok((await harness.request({ contents: [] })).sent, api);
    assert.equal(gateway.inference()[0]?.headers["route-policy"], "zdr", api);
  }
});

test("C10: pi: a request to an API that names its model in the body is blocked when its payload has none, even with the policy on the header", async () => {
  const harness = await pi("zdr");
  harness.model.api = "openai-responses";
  assert.match((await harness.request({ input: "fixture" })).error ?? "", /has no model in its body, which the openai-responses API needs/);
  assert.equal(gateway.inference().length, 0);
});

test("C10: pi: the held policy survives a session resume", async () => {
  const first = await pi("notrain");
  const resumed = new FakeHarness(gateway.base, { headerHook: true });
  resumed.entries.push(...first.entries);
  routePolicy(resumed.api);
  await resumed.emit("session_start", { type: "session_start", reason: "resume" });
  await resumed.request();
  assert.equal(gateway.inference()[0]?.headers["route-policy"], "notrain");
});
