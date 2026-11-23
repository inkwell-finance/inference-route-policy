import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { FakeHarness } from "../../shared/test/fake-harness.ts";
import { fakeGateway, routeOpenRouterTo, type FakeGateway } from "../../shared/test/fixtures.ts";
import { OPENROUTER_BASE } from "../../shared/src/openrouter.ts";
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
beforeEach(() => {
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
  assert.equal((await harness.request()).sent, false);
  assert.equal(gateway.inference().length, 0);
  assert.deepEqual(harness.handlerErrors, []);
});

test("C5, C11: pi: a 503 refusal is shown with its reason", async () => {
  gateway.replies.inference = { status: 503, headers: { "route-refused": "reason=unavailable" }, body: {} };
  const harness = await pi("notrain");
  await harness.request();
  assert.equal(notices(harness).at(-1), "route policy refused by the gateway: unavailable");
});

test("C8, C9: pi: for OpenRouter the policy is translated into its provider field, the suffix removed, and the result unconfirmed", async () => {
  gateway.replies.detection = { status: 404 };
  const harness = await pi("notrain+only=aurora");
  harness.model = { id: "vendor/model+sort=price", baseUrl: OPENROUTER_BASE };
  assert.ok((await harness.request({ model: harness.model.id, messages: [] })).sent);
  assert.deepEqual(sentBody(), { model: "vendor/model", messages: [], provider: { data_collection: "deny", only: ["aurora"], sort: "price" } });
  assert.equal(gateway.inference()[0]?.headers["route-policy"], undefined);
  assert.match(notices(harness).at(-1) ?? "", /unconfirmed, not applied/);

  await harness.command("route", "zdr");
  assert.equal((await harness.request({ model: "vendor/model", messages: [] })).sent, false, "zdr has no hard filter there");
  await harness.command("route", "notrain");
  assert.equal((await harness.request({ model: "vendor/model", prompt: "x" })).sent, false, "only Chat Completions and Responses document the field");
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
