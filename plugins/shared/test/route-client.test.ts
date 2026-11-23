import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Decision } from "../src/decide.ts";
import type { Target } from "../src/gateway-client.ts";
import type { Exchange } from "../src/observe.ts";
import type { Report } from "../src/outcome.ts";
import { RouteClient } from "../src/route-client.ts";
import { fakeGateway, type FakeGateway } from "./fixtures.ts";

let gateway: FakeGateway;
let elsewhere: FakeGateway;
before(async () => {
  gateway = await fakeGateway();
  elsewhere = await fakeGateway();
});
after(async () => {
  await gateway.close();
  await elsewhere.close();
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

function blockedFor(decision: Decision, pattern: RegExp): void {
  assert.ok(decision.action === "block", `expected a block, got ${decision.action}`);
  assert.match(decision.reason, pattern);
}

/** Lets a decided request through as the plugin does: records it, with the body it serializes to. */
function send(c: RouteClient, target: Target, decision: Decision, body = JSON.stringify({ model: decision.action === "block" ? "" : decision.model, messages: [] })): Exchange {
  assert.ok(decision.action !== "block", decision.action === "block" ? decision.reason : "");
  c.sending(target, decision, body);
  return {
    url: `${target.base}/chat/completions`,
    method: "POST",
    body,
    credential: target.credential,
    routePolicy: decision.action === "send" ? decision.header : null,
    status: 200,
    result: { applied: [], refused: [], evidence: [] },
  };
}

const answered = (exchange: Exchange, applied: string[]): Exchange => ({ ...exchange, result: { applied, refused: [], evidence: [] } });

test("C6: a valid detection reply clears a requirement; anything else, a failed fetch included, is no detection", async () => {
  const cases: [string, () => void, RegExp | null][] = [
    ["valid", () => {}, null],
    ["status 404", () => (gateway.replies.detection = { status: 404, body: { route_policy: "1" } }), /status is 404, not 200/],
    ["route_policy a number", () => (gateway.replies.detection = { status: 200, body: { route_policy: 1 } }), /route_policy is not the string "1"/],
    ["not JSON", () => (gateway.replies.detection = { status: 200 }), /not a JSON object/],
    ["keys not a list", () => (gateway.replies.detection = { status: 200, body: { route_policy: "1", keys: "zdr" } }), /keys is not a list of keys/],
    ["unknown members ignored", () => (gateway.replies.detection = { status: 200, body: { route_policy: "1", later: { x: 1 }, keys: ["zdr", "future"] } }), null],
  ];
  for (const [name, arrange, refusal] of cases) {
    reset();
    arrange();
    const decision = await client("zdr").client.decide({ base: gateway.base, credential: "k" }, "demo-model", null);
    if (refusal === null) assert.equal(decision.action, "send", name);
    else blockedFor(decision, refusal);
  }
});

test("C6, C14: another origin's valid reply, reached by a redirect, never authorizes a request; nor does its model list", async () => {
  reset();
  elsewhere.replies.detection = { status: 200, body: { route_policy: "1" } };
  elsewhere.replies.models = { status: 200, body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr" }] }] } };
  gateway.replies.detection = { status: 302, headers: { location: `${elsewhere.base}/route-policy` } };
  const target = { base: gateway.base, credential: "k" };
  blockedFor(await client("zdr").client.decide(target, "demo-model", null), /status is 302, not 200/);
  assert.equal(elsewhere.requests.length, 0, "the redirect was not followed");

  // With detection valid here, a list redirected to another origin is no list: only=nosuch is not blocked by it.
  reset();
  gateway.replies.models = { status: 307, headers: { location: `${elsewhere.base}/models` } };
  elsewhere.replies.models = { status: 200, body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "" }] }] } };
  const withRedirectedList = await client("only=nosuch").client.decide(target, "demo-model", null);
  assert.equal(withRedirectedList.action, "send");
  assert.equal(withRedirectedList.action === "send" ? withRedirectedList.routes : "unset", null, "no list is held");
  assert.equal(elsewhere.requests.length, 0);
});

test("C6: a key_policy in the reply to a request without credentials makes the reply invalid", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "zdr" } };
  blockedFor(await client().client.decide({ base: gateway.base, credential: null }, "demo-model", null), /key_policy is present in a reply to a request without credentials/);
  assert.equal(gateway.requests.at(-1)?.headers.authorization, undefined, "the request carried no credentials");
  assert.equal((await client().client.decide({ base: gateway.base, credential: "k" }, "demo-model", null)).action, "send");
  assert.equal(gateway.requests.find((r) => r.path.endsWith("/route-policy") && r.headers.authorization !== undefined)?.headers.authorization, "Bearer k");
});

test("C6: a detection fetch that cannot complete in time, or cannot connect, is no detection", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1" }, delayMs: 300 };
  blockedFor(await client("zdr", 50).client.decide({ base: gateway.base, credential: "abandoned" }, "demo-model", null), /detection could not be fetched/);
  blockedFor(await client().client.decide({ base: "http://127.0.0.1:9/v1", credential: "k" }, "demo-model", null), /detection could not be fetched/);
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
  blockedFor(await c.decide({ base: "http://127.0.0.1:9/v1", credential: "k2" }, "demo-model", null), /127\.0\.0\.1:9\/v1 has no valid detection reply/);
});

test("C14: a not-honored result discards the detection reply of its own credential, and only that one", async () => {
  reset();
  const { client: c, reports } = client("zdr");
  const [one, two] = [{ base: gateway.base, credential: "k1" }, { base: gateway.base, credential: "k2" }];
  const sentOne = send(c, one, await c.decide(one, "demo-model", null));
  const sentTwo = send(c, two, await c.decide(two, "demo-model", null));
  // The two bodies are the same bytes; only the credential tells the responses apart. They finish in reverse order.
  c.observe(answered(sentTwo, ["provider=cobalt"]));
  c.observe(answered(sentOne, ["provider=aurora"]));
  assert.deepEqual(reports.map((r) => r.kind), ["not-honored", "honored"]);
  await c.decide(one, "demo-model", null);
  await c.decide(two, "demo-model", null);
  assert.deepEqual([detectionRequests("k1"), detectionRequests("k2")], [1, 2], "k2's reply was discarded and fetched again; k1's was kept");
});

test("C3, C14: a response that cannot be tied to its request is never honored, and the detection it might answer is dropped", async () => {
  reset();
  const { client: c, reports } = client("zdr");
  const target = { base: gateway.base, credential: "k" };
  const exchange = send(c, target, await c.decide(target, "demo-model", null));
  c.observe({ ...answered(exchange, ["provider=aurora"]), body: `${exchange.body} ` });
  assert.deepEqual(reports, [{ kind: "untied", base: gateway.base }]);
  await c.decide(target, "demo-model", null);
  assert.equal(detectionRequests(), 2);
  // Responses to other credentials or other base URLs are not this client's to judge.
  c.observe({ ...answered(exchange, ["provider=aurora"]), credential: "other" });
  c.observe({ ...answered(exchange, ["provider=aurora"]), url: "http://elsewhere.test/v1/chat/completions" });
  c.observe({ ...answered(exchange, ["provider=aurora"]), method: "GET" });
  assert.equal(reports.length, 1);
  // The request itself is answered once.
  c.observe(answered(exchange, ["provider=aurora"]));
  c.observe(answered(exchange, ["provider=aurora"]));
  assert.deepEqual(reports.slice(1).map((r) => r.kind), ["honored"]);
});

test("C14: failed reads are not kept, so the next request tries again", async () => {
  reset();
  gateway.replies.detection = { status: 503 };
  const { client: c } = client("zdr");
  const target = { base: gateway.base, credential: "k" };
  blockedFor(await c.decide(target, "demo-model", null), /status is 503/);
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

test("C16: a request carrying only preferences fetches the model list when the key's own policy has a requirement", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "only=missing" } };
  blockedFor(await client("sort=price").client.decide({ base: gateway.base, credential: "k" }, "demo-model", null), /meets the policy combined with the key's own/);
  assert.equal(listRequests(), 1);
});

test("C16: with a bound key policy, the list held for this base URL and credential blocks a request carrying only preferences or nothing", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "only=missing" } };
  const target = { base: gateway.base, credential: "k" };
  const { client: c } = client("zdr");
  blockedFor(await c.decide(target, "demo-model", null), /meets the policy combined with the key's own/);
  c.set("sort=price");
  blockedFor(await c.decide(target, "demo-model", null), /meets the policy combined with the key's own/);
  c.held = { kind: "none" };
  blockedFor(await c.decide(target, "demo-model", null), /meets the key's own policy/);
  assert.equal(listRequests(), 1, "the held list was used, not fetched again");
  // Another credential holds nothing here, and a request with no policy fetches nothing: it goes, and the gateway decides.
  assert.equal((await c.decide({ base: gateway.base, credential: "k2" }, "demo-model", null)).action, "send");
});

test("C4: a response is read against the routes of the list held when the request was sent", async () => {
  reset();
  const { client: c, reports } = client("zdr");
  const target = { base: gateway.base, credential: "k" };
  c.observe(answered(send(c, target, await c.decide(target, "demo-model", null)), ["provider=aurora"]));
  assert.deepEqual(reports.at(-1), { kind: "honored", provider: "aurora", checked: true, evidence: null });
});

test("C8: the response to a translated request is reported unconfirmed", () => {
  const { client: c, reports } = client("only=aurora");
  const target = { base: "https://openrouter.ai/api/v1", credential: "k" };
  const policy = c.held.kind === "policy" ? c.held.policy : assert.fail("held");
  c.observe(answered(send(c, target, { action: "translate", model: "vendor/model", provider: { only: ["aurora"] }, sent: policy }), ["provider=aurora"]));
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
