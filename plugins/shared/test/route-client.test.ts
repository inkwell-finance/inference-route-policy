import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Decision } from "../src/decide.ts";
import type { Exchange } from "../src/observe.ts";
import type { Report } from "../src/outcome.ts";
import { RouteClient } from "../src/route-client.ts";
import { fakeGateway, type FakeGateway } from "./fixtures.ts";

let gateway: FakeGateway;
before(async () => {
  gateway = await fakeGateway();
});
after(async () => {
  await gateway.close();
});

function client(policy = "zdr", timeoutMs = 2000): { client: RouteClient; reports: Report[] } {
  const reports: Report[] = [];
  return { client: new RouteClient({ carriers: "header", env: { ROUTE_POLICY: policy }, timeoutMs, onReport: (r) => reports.push(r) }), reports };
}

// Counted by credential: a request an earlier test abandoned on a timeout can still land after `reset`.
const reads = (path: string, credentials: readonly string[]): number =>
  gateway.requests.filter((r) => r.path.endsWith(path) && credentials.some((k) => r.headers.authorization === `Bearer ${k}`)).length;
const detectionRequests = (...credentials: string[]): number => reads("/route-policy", credentials.length > 0 ? credentials : ["k"]);
const listRequests = (...credentials: string[]): number => reads("/models", credentials.length > 0 ? credentials : ["k"]);

function reset(): void {
  gateway.requests.length = 0;
  gateway.replies.detection = { status: 200, body: { route_policy: "1" } };
  gateway.replies.models = { status: 200, body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr" }] }] } };
}

function exchange(decision: Decision, applied: string[], url = `${gateway.base}/chat/completions`): Exchange {
  assert.notEqual(decision.action, "block");
  return {
    url,
    method: "POST",
    model: decision.action === "block" ? null : decision.model,
    routePolicy: decision.action === "send" ? decision.header : null,
    status: 200,
    result: { applied, refused: [], evidence: [] },
  };
}

test("C6: a valid detection reply clears a requirement; anything else, a failed fetch included, is no detection", async () => {
  const cases: [string, () => void, Decision["action"]][] = [
    ["valid", () => {}, "send"],
    ["status 404", () => (gateway.replies.detection = { status: 404, body: { route_policy: "1" } }), "block"],
    ["route_policy a number", () => (gateway.replies.detection = { status: 200, body: { route_policy: 1 } }), "block"],
    ["not JSON", () => (gateway.replies.detection = { status: 200 }), "block"],
    ["keys not a list", () => (gateway.replies.detection = { status: 200, body: { route_policy: "1", keys: "zdr" } }), "block"],
    ["unknown members ignored", () => (gateway.replies.detection = { status: 200, body: { route_policy: "1", later: { x: 1 }, keys: ["zdr", "future"] } }), "send"],
  ];
  for (const [name, arrange, expected] of cases) {
    reset();
    arrange();
    const { client: c } = client("zdr");
    assert.equal((await c.decide({ base: gateway.base, credential: "k" }, "demo-model", null)).action, expected, name);
  }
});

test("C6: a key_policy in the reply to a request without credentials makes the reply invalid", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "zdr" } };
  assert.equal((await client().client.decide({ base: gateway.base, credential: null }, "demo-model", null)).action, "block");
  assert.equal(gateway.requests.at(-1)?.headers.authorization, undefined, "the request carried no credentials");
  assert.equal((await client().client.decide({ base: gateway.base, credential: "k" }, "demo-model", null)).action, "send");
  assert.equal(gateway.requests.find((r) => r.path.endsWith("/route-policy") && r.headers.authorization !== undefined)?.headers.authorization, "Bearer k");
});

test("C6: a detection fetch that cannot complete in time, or cannot connect, is no detection", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1" }, delayMs: 300 };
  const timedOut = await client("zdr", 50).client.decide({ base: gateway.base, credential: "abandoned" }, "demo-model", null);
  assert.equal(timedOut.action, "block");
  assert.match(timedOut.action === "block" ? timedOut.reason : "", /could not be fetched/);
  const unreachable = await client().client.decide({ base: "http://127.0.0.1:9/v1", credential: "k" }, "demo-model", null);
  assert.equal(unreachable.action, "block");
});

test("C14: a detection reply and a model list are kept per base URL and credential, and used for no other", async () => {
  reset();
  const { client: c } = client("zdr");
  const target = { base: gateway.base, credential: "k1" };
  await c.decide(target, "demo-model", null);
  await c.decide(target, "demo-model", null);
  assert.deepEqual([detectionRequests("k1", "k2"), listRequests("k1", "k2")], [1, 1], "reused for the same base URL and credential");
  await c.decide({ base: gateway.base, credential: "k2" }, "demo-model", null);
  assert.deepEqual([detectionRequests("k1", "k2"), listRequests("k1", "k2")], [2, 2], "fetched again for another credential");
  await c.decide({ base: `${gateway.base}/`, credential: "k2" }, "demo-model", null);
  assert.deepEqual([detectionRequests("k1", "k2"), listRequests("k1", "k2")], [2, 2], "a trailing slash names the same base URL");
  // A reply from one base URL never clears a request to another: this one has none.
  assert.equal((await c.decide({ base: "http://127.0.0.1:9/v1", credential: "k2" }, "demo-model", null)).action, "block");
});

test("C14: the detection reply is discarded when a requirement comes back not honored, and fetched again before the next", async () => {
  reset();
  const { client: c, reports } = client("zdr");
  const target = { base: gateway.base, credential: "k" };
  const honored = await c.decide(target, "demo-model", null);
  assert.notEqual(honored.action, "block");
  if (honored.action === "block") return;
  c.sending(target, honored);
  c.observe(exchange(honored, ["provider=aurora"]));
  assert.equal(reports.at(-1)?.kind, "honored");
  await c.decide(target, "demo-model", null);
  assert.equal(detectionRequests(), 1, "an honored result keeps the reply");

  const next = await c.decide(target, "demo-model", null);
  if (next.action === "block") assert.fail(next.reason);
  c.sending(target, next);
  c.observe(exchange(next, ["provider=cobalt"]));
  assert.equal(reports.at(-1)?.kind, "not-honored");
  await c.decide(target, "demo-model", null);
  assert.equal(detectionRequests(), 2, "a not-honored result discards it");
});

test("C14: failed reads are not kept, so the next request tries again", async () => {
  reset();
  gateway.replies.detection = { status: 503 };
  const { client: c } = client("zdr");
  const target = { base: gateway.base, credential: "k" };
  assert.equal((await c.decide(target, "demo-model", null)).action, "block");
  gateway.replies.detection = { status: 200, body: { route_policy: "1" } };
  assert.equal((await c.decide(target, "demo-model", null)).action, "send");
});

test("C15: a new client, as in the next run, holds no detection reply or model list from the last", async () => {
  reset();
  const target = { base: gateway.base, credential: "k" };
  await client().client.decide(target, "demo-model", null);
  await client().client.decide(target, "demo-model", null);
  assert.deepEqual([detectionRequests(), listRequests()], [2, 2]);
});

test("C4: a response is read against the routes of the list held when the request was sent", async () => {
  reset();
  const { client: c, reports } = client("zdr");
  const target = { base: gateway.base, credential: "k" };
  const decision = await c.decide(target, "demo-model", null);
  if (decision.action === "block") assert.fail(decision.reason);
  c.sending(target, decision);
  c.observe(exchange(decision, ["provider=aurora"]));
  assert.deepEqual(reports.at(-1), { kind: "honored", provider: "aurora", checked: true, evidence: null });
});

test("C3: only a response to a request this client let through, on its base URL with its carriers, is read", async () => {
  reset();
  const { client: c, reports } = client("zdr");
  const target = { base: gateway.base, credential: "k" };
  const decision = await c.decide(target, "demo-model", null);
  if (decision.action !== "send") assert.fail("expected send");
  c.sending(target, decision);
  c.observe({ ...exchange(decision, ["provider=aurora"]), routePolicy: null });
  c.observe(exchange(decision, ["provider=aurora"], "http://elsewhere.test/v1/chat/completions"));
  c.observe({ ...exchange(decision, ["provider=aurora"]), method: "GET" });
  assert.equal(reports.length, 0);
  c.observe(exchange(decision, ["provider=aurora"]));
  c.observe(exchange(decision, ["provider=aurora"]));
  assert.equal(reports.length, 1, "each request is read once");
});

test("C8: the response to a translated request is reported unconfirmed", () => {
  const { client: c, reports } = client("notrain");
  const target = { base: "https://openrouter.ai/api/v1", credential: "k" };
  const decision: Decision = { action: "translate", model: "vendor/model", provider: { data_collection: "deny" }, sent: c.held.kind === "policy" ? c.held.policy : assert.fail() };
  c.sending(target, decision);
  c.observe({ url: "https://openrouter.ai/api/v1/chat/completions", method: "POST", model: "vendor/model", routePolicy: null, status: 200, result: { applied: [], refused: [], evidence: [] } });
  assert.deepEqual(reports, [{ kind: "unconfirmed" }]);
});

test("C13, C12: /route shows the key's own policy as locked, and one the client cannot interpret as text only", async () => {
  reset();
  const target = { base: gateway.base, credential: "k" };
  gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "zdr+region=us" } };
  assert.match(await client().client.describe(target), /Key policy \(locked, applied by the gateway to every request with this key\): zdr\+region=us/);
  gateway.replies.detection = { status: 200, body: { route_policy: "1", keys: ["zdr", "residency"], key_policy: "zdr+residency=eu" } };
  const text = await client().client.describe(target);
  assert.match(text, /Key policy \(locked\): "zdr\+residency=eu", which this client cannot interpret; shown as text and relied on for nothing/);
  assert.match(text, /^Route policy: zdr \(from ROUTE_POLICY\)$/m);
  assert.match(text, /^Last result: none yet$/m);
});

test("C1: /route shows when a base URL has no detection, and why", async () => {
  reset();
  gateway.replies.detection = { status: 404 };
  assert.match(await client().client.describe({ base: gateway.base, credential: "k" }), /: no detection \(detection reply is not valid: status is 404, not 200\)/);
});
