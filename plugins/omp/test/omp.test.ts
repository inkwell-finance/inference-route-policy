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
beforeEach(() => {
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

const notices = (harness: FakeHarness): string[] => harness.shown.filter((s) => s.method === "notify").map((s) => s.text);

test("C1: omp: a requirement with no valid detection reply is blocked before serialization, and nothing reaches the gateway", async () => {
  gateway.replies.detection = { status: 404 };
  const harness = await omp("zdr");
  const result = await harness.request();
  assert.equal(result.sent, false);
  assert.match(result.error ?? "", /^Blocked by the route policy plugin, nothing was sent: .* has no valid detection reply/);
  assert.equal(gateway.inference().length, 0);
  assert.match(notices(harness).at(-1) ?? "", /^request blocked by the route policy plugin/);
});

test("C10: omp: the held policy rides the model suffix, combined with one the user typed", async () => {
  const harness = await omp("zdr+sort=price");
  harness.model.id = "demo-model+notrain+sort=latency";
  const result = await harness.request({ model: harness.model.id, messages: [] });
  assert.ok(result.sent);
  const [request] = gateway.inference();
  assert.deepEqual(JSON.parse(request?.body ?? "{}"), { model: "demo-model+zdr+notrain+sort=latency", messages: [] });
  assert.equal(request?.headers["route-policy"], undefined, "omp gives the plugin no header to set");
});

test("C3, C4: omp: an honored response is checked against the model list and shown quietly in the status line", async () => {
  const harness = await omp("zdr");
  await harness.request();
  assert.equal(harness.shown.at(-1)?.method, "setStatus");
  assert.match(harness.shown.at(-1)?.text ?? "", /^route policy honored: served by aurora; its published facts meet the policy/);
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {} };
  await harness.request();
  assert.match(notices(harness).at(-1) ?? "", /^route policy NOT honored: route "cobalt" does not meet the policy sent$/);
});

test("C5, C11: omp: a refusal on a 400 response is shown with its reason and key", async () => {
  gateway.replies.inference = { status: 400, headers: { "route-refused": "reason=unsupported+key=bits" }, body: { error: { message: "unsupported" } } };
  // aurora meets notrain, so the model list lets the request go and the gateway's refusal is what comes back.
  const harness = await omp("notrain");
  const result = await harness.request();
  assert.equal(result.status, 400);
  assert.equal(notices(harness).at(-1), "route policy refused by the gateway: unsupported (key bits)");
});

test("C1: omp: a failure inside the plugin blocks the request instead of sending it without its policy", async () => {
  const failingAuth = await omp("zdr");
  failingAuth.resolveAuth = async () => {
    throw new Error("keychain locked");
  };
  assert.match((await failingAuth.request()).error ?? "", /the plugin failed: keychain locked/);

  const failingUI = await omp("zdr");
  gateway.replies.detection = { status: 404 };
  failingUI.uiThrows = true;
  assert.equal((await failingUI.request()).sent, false, "a UI that throws while reporting the block does not undo it");

  const noModel = await omp("zdr");
  noModel.contextModel = { id: "demo-model", baseUrl: 42 };
  assert.equal((await noModel.request()).sent, false);
  assert.equal(gateway.inference().length, 0);
  assert.deepEqual([...failingAuth.handlerErrors, ...failingUI.handlerErrors, ...noModel.handlerErrors], [], "the plugin's handler itself never throws");
});

test("C1: omp: a guard that cannot decide before omp's 30-second handler budget runs out blocks the request", async () => {
  const harness = await omp("zdr");
  harness.resolveAuth = () => new Promise(() => {});
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = harness.request();
    // Let the handler start and reach its pending lookup before time moves.
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(20_000);
    const result = await pending;
    assert.equal(result.sent, false);
    assert.match(result.error ?? "", /could not decide within 20 seconds/);
  } finally {
    mock.timers.reset();
  }
});

test("C2: omp: with no policy at all, requests go as they are and nothing is fetched first", async () => {
  const harness = await omp();
  const payload = { model: "demo-model", messages: [{ role: "user", content: "hi" }] };
  assert.ok((await harness.request(payload)).sent);
  assert.deepEqual(JSON.parse(gateway.inference()[0]?.body ?? "{}"), payload);
  assert.equal(gateway.requests.filter((r) => r.method === "GET").length, 0);
});

test("C10: omp: /route sets, shows, and clears the policy; an invalid one changes nothing", async () => {
  const harness = await omp("zdr");
  assert.equal(notices(harness).at(-1), "Route policy set: zdr");
  await harness.command("route", "zdr+zdr");
  assert.match(notices(harness).at(-1) ?? "", /^Not a valid policy, nothing changed/);
  await harness.command("route", "");
  assert.match(notices(harness).at(-1) ?? "", /^Route policy: zdr \(set in this session\)\nGateway http:\/\/127\.0\.0\.1:\d+\/v1: detection valid/);
  await harness.command("route", "clear");
  await harness.request();
  assert.equal(JSON.parse(gateway.inference()[0]?.body ?? "{}").model, "demo-model", "a cleared policy is no longer sent");
  assert.deepEqual(harness.entries.map((e) => e.data), [{ policy: "zdr" }, { policy: null }]);
});

test("C10: omp: the held policy survives a session resume", async () => {
  const first = await omp("notrain");
  const resumed = new FakeHarness(gateway.base, { headerHook: false });
  resumed.entries.push(...first.entries);
  routePolicy(resumed.api);
  await resumed.emit("session_start", { type: "session_start" });
  await resumed.request();
  assert.equal(JSON.parse(gateway.inference()[0]?.body ?? "{}").model, "demo-model+notrain");
});

test("C15: omp: the session records the held policy and nothing a gateway said", async () => {
  const harness = await omp("zdr");
  await harness.request();
  await harness.command("route", "");
  assert.deepEqual(harness.entries.map((e) => [e.customType, e.data]), [["inference-route-policy", { policy: "zdr" }]]);
});

adapterContract("omp", omp, () => gateway);

test("C10: omp: a request with no model field to carry the policy in is blocked", async () => {
  const harness = await omp("zdr");
  const result = await harness.request({ messages: [] });
  assert.match(result.error ?? "", /the request has no model field to carry the policy/);
  assert.equal(gateway.inference().length, 0);
});
