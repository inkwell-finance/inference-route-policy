import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Decision } from "../src/decide.ts";
import { addWatcher } from "../src/fetch-gate.ts";
import type { Target } from "../src/gateway-client.ts";
import type { Report } from "../src/outcome.ts";
import type { AuthContext } from "../src/request.ts";
import { RouteClient, type Prepared } from "../src/route-client.ts";
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

// Each test's clients watch the fetch gate as the plugin's would, until the next test starts.
const watching: (() => void)[] = [];

function client(policy = "zdr", timeoutMs = 2000): { client: RouteClient; reports: Report[] } {
  const reports: Report[] = [];
  const c = new RouteClient({ carriers: "header", env: { ROUTE_POLICY: policy }, timeoutMs, onReport: (r) => reports.push(r) });
  watching.push(addWatcher({ check: (outgoing) => c.check(outgoing), stopped: (reason) => c.blocked(reason) }));
  return { client: c, reports };
}

const bearer = (key: string): AuthContext => [["authorization", `Bearer ${key}`]];
const target = (key: string | null = "k", base = gateway.base): Target => ({ base, auth: key === null ? [] : bearer(key) });

// Counted by credential: a request an earlier test abandoned on a timeout can still land after `reset`.
const reads = (path: string, credentials: readonly string[]): number =>
  gateway.requests.filter((r) => r.path.endsWith(path) && credentials.some((k) => r.headers.authorization === `Bearer ${k}`)).length;
const detectionRequests = (...credentials: string[]): number => reads("/route-policy", credentials.length > 0 ? credentials : ["k"]);
const listRequests = (...credentials: string[]): number => reads("/models", credentials.length > 0 ? credentials : ["k"]);

function reset(): void {
  for (const stop of watching.splice(0)) stop();
  gateway.requests.length = 0;
  gateway.replies.detection = { status: 200, body: { route_policy: "1" } };
  gateway.replies.models = { status: 200, body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr" }] }] } };
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=aurora" }, body: {} };
}

function blockedFor(decision: Decision, pattern: RegExp): void {
  assert.ok(decision.action === "block", `expected a block, got ${decision.action}`);
  assert.match(decision.reason, pattern);
}

const decide = (c: RouteClient, t: Target, model = "demo-model"): Promise<Prepared> => c.decide(t, model, null);

/** Releases a decided request as the plugin does, and returns the fetch that sends exactly those bytes. */
function release(c: RouteClient, prepared: Prepared): () => Promise<Response> {
  const { decision } = prepared;
  assert.ok(decision.action !== "block", decision.action === "block" ? decision.reason : "");
  const header = decision.action === "send" ? decision.header : null;
  const body = JSON.stringify({ model: decision.model, messages: [] });
  c.release({ ...prepared, decision }, header, body);
  const headers = new Headers(Object.fromEntries(prepared.target.auth));
  if (header !== null) headers.set("route-policy", header);
  return async () => fetch(`${prepared.target.base}/chat/completions`, { method: "POST", headers, body });
}

const sendText = async (send: () => Promise<Response>): Promise<void> => {
  await (await send()).text();
};

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
    const { decision } = await decide(client("zdr").client, target());
    if (refusal === null) assert.equal(decision.action, "send", name);
    else blockedFor(decision, refusal);
  }
});

test("C6, C14: another origin's valid reply, reached by a redirect, never authorizes a request; nor does its model list", async () => {
  reset();
  elsewhere.replies.detection = { status: 200, body: { route_policy: "1" } };
  gateway.replies.detection = { status: 302, headers: { location: `${elsewhere.base}/route-policy` } };
  blockedFor((await decide(client("zdr").client, target())).decision, /status is 302, not 200/);
  assert.equal(elsewhere.requests.length, 0, "the redirect was not followed");

  reset();
  gateway.replies.models = { status: 307, headers: { location: `${elsewhere.base}/models` } };
  elsewhere.replies.models = { status: 200, body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "" }] }] } };
  const { decision } = await decide(client("only=nosuch").client, target());
  assert.ok(decision.action === "send", "no list is held, so the gateway decides");
  assert.equal(decision.routes, null);
  assert.equal(elsewhere.requests.length, 0);
});

test("C6: a key_policy in the reply to a request without credentials makes the reply invalid", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "zdr" } };
  blockedFor((await decide(client().client, target(null))).decision, /key_policy is present in a reply to a request without credentials/);
  assert.equal(gateway.requests.at(-1)?.headers.authorization, undefined, "the request carried no credentials");
  assert.equal((await decide(client().client, target())).decision.action, "send");
});

test("C6: a detection fetch that cannot complete in time, or cannot connect, is no detection", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1" }, delayMs: 300 };
  blockedFor((await decide(client("zdr", 50).client, target("abandoned"))).decision, /detection could not be fetched/);
  blockedFor((await decide(client().client, target("k", "http://127.0.0.1:9/v1"))).decision, /detection could not be fetched/);
});

test("C14: a detection reply and a model list are kept per base URL and credential, and used for no other", async () => {
  reset();
  const { client: c } = client("zdr");
  await decide(c, target("k1"));
  await decide(c, target("k1"));
  assert.deepEqual([detectionRequests("k1", "k2"), listRequests("k1", "k2")], [1, 1], "reused for the same base URL and credential");
  await decide(c, target("k2"));
  assert.deepEqual([detectionRequests("k1", "k2"), listRequests("k1", "k2")], [2, 2], "fetched again for another credential");
  await decide(c, target("k2", `${gateway.base}/`));
  assert.deepEqual([detectionRequests("k1", "k2"), listRequests("k1", "k2")], [2, 2], "a trailing slash names the same base URL");
  blockedFor((await decide(c, target("k2", "http://127.0.0.1:9/v1"))).decision, /127\.0\.0\.1:9\/v1 has no valid detection reply/);
});

test("C1, C14: metadata is read with the whole authentication context the request carries, and kept by all of it", async () => {
  reset();
  const { client: c } = client("zdr");
  const both = (apiKey: string): Target => ({ base: gateway.base, auth: [["authorization", "Bearer a"], ["x-api-key", apiKey]] });
  await decide(c, both("b"));
  await decide(c, both("c"));
  const gets = gateway.requests.filter((r) => r.path.endsWith("/route-policy"));
  assert.deepEqual(gets.map((r) => [r.headers.authorization, r.headers["x-api-key"]]), [["Bearer a", "b"], ["Bearer a", "c"]], "a different x-api-key is another context, read again");
});

test("C1, C14: a request leaving with another authentication context than the one it was checked for is stopped at fetch", async () => {
  reset();
  const { client: c, reports } = client("zdr");
  const prepared = await decide(c, target("demo-key"));
  release(c, prepared);
  const body = JSON.stringify({ model: "demo-model", messages: [] });
  for (const headers of [{ authorization: "Bearer demo-key-zdr", "route-policy": "zdr" }, { authorization: "Bearer demo-key", "x-api-key": "demo-key-zdr", "route-policy": "zdr" }]) {
    await assert.rejects(fetch(`${gateway.base}/chat/completions`, { method: "POST", headers, body }), /is not one the plugin released/);
  }
  assert.equal(gateway.inference().length, 0);
  assert.equal(reports.at(-1)?.kind, "blocked", "the user is told");
});

test("C14: a not-honored result discards the detection reply of its own credential, and only that one", async () => {
  reset();
  const { client: c, reports } = client("zdr");
  const sendOne = release(c, await decide(c, target("k1")));
  const sendTwo = release(c, await decide(c, target("k2")));
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {} };
  await sendText(sendTwo);
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=aurora" }, body: {} };
  await sendText(sendOne);
  assert.deepEqual(reports.map((r) => r.kind), ["not-honored", "honored"]);
  await decide(c, target("k1"));
  await decide(c, target("k2"));
  assert.deepEqual([detectionRequests("k1"), detectionRequests("k2")], [1, 2], "k2's reply was discarded and fetched again; k1's was kept");
});

test("C14: a request decided before its detection reply was discarded is not current, and is stopped at fetch", async () => {
  reset();
  const { client: c } = client("zdr");
  const sendA = release(c, await decide(c, target()));
  const prepared = await decide(c, target(), "demo-model");
  const sendB = release(c, prepared);
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {} };
  await sendText(sendA);
  assert.equal(c.isCurrent(prepared), false, "the decision relied on the discarded reply");
  await assert.rejects(sendB(), /discarded before it left/);
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=aurora" }, body: {} };
  await sendText(release(c, await decide(c, target())));
  assert.equal(detectionRequests(), 2, "decided again on a fresh reply, it goes");
});

test("C1, C5: a release is used once; a resend of the same request is stopped while a policy is held", async () => {
  reset();
  const { client: c, reports } = client("zdr");
  const send = release(c, await decide(c, target()));
  await sendText(send);
  await assert.rejects(send(), /already sent once/);
  assert.equal(gateway.inference().length, 1);
  assert.deepEqual(reports.map((r) => r.kind), ["honored", "blocked"]);
});

test("C14: a discard that lands while a decision is still reading the gateway makes that decision stale", async () => {
  reset();
  gateway.replies.models = { status: 500 };
  const { client: c } = client("zdr");
  const sendA = release(c, await decide(c, target()));
  // B's decision waits on a slow model list; meanwhile A comes back with no Route-Applied, which is not honored.
  gateway.replies.models = { status: 200, body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr" }] }] }, delayMs: 300 };
  const deciding = decide(c, target());
  gateway.replies.inference = { status: 200, body: {} };
  await sendText(sendA);
  const prepared = await deciding;
  assert.equal(c.isCurrent(prepared), false, "the generation is the one read before the wait");
});

test("C5: every one of many overlapping requests is read on its own call, and each refusal reported as one", async () => {
  reset();
  const { client: c, reports } = client("zdr");
  const prepared = await decide(c, target());
  const sends = Array.from({ length: 40 }, () => release(c, prepared));
  gateway.replies.inference = { status: 400, headers: { "route-refused": "reason=unsatisfiable" }, body: {} };
  await Promise.all(sends.map(sendText));
  assert.equal(reports.length, 40);
  assert.ok(reports.every((r) => r.kind === "refused" && r.reason === "unsatisfiable"));
});

test("C4: each response is read against the routes of the list held when its own request was released, not a later one", async () => {
  reset();
  gateway.replies.models = {
    status: 200,
    body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr" }] }, { id: "other-model", routes: [{ provider: "cobalt", facts: "zdr" }] }] },
  };
  const { client: c, reports } = client("zdr");
  const sendFirst = release(c, await decide(c, target(), "demo-model"));
  release(c, await decide(c, target(), "other-model"));
  await sendText(sendFirst);
  assert.deepEqual(reports, [{ kind: "honored", provider: "aurora", checked: true, evidence: null }]);
});

test("C1, C14: a released request answered with a redirect is not followed, is reported not honored, and drops the detection reply", async () => {
  reset();
  const { client: c, reports } = client("zdr");
  gateway.replies.inference = { status: 307, headers: { location: `${elsewhere.base}/chat/completions` } };
  await sendText(release(c, await decide(c, target())));
  assert.equal(elsewhere.requests.length, 0);
  const last = reports.at(-1);
  assert.ok(last?.kind === "not-honored");
  assert.match(last.why, /redirect \(status 307\)/);
  await decide(c, target());
  assert.equal(detectionRequests(), 2);
});

test("C14: failed reads are not kept, so the next request tries again", async () => {
  reset();
  gateway.replies.detection = { status: 503 };
  const { client: c } = client("zdr");
  blockedFor((await decide(c, target())).decision, /status is 503/);
  gateway.replies.detection = { status: 200, body: { route_policy: "1" } };
  assert.equal((await decide(c, target())).decision.action, "send");
});

test("C15: a new client, as in the next run, holds no detection reply or model list from the last", async () => {
  reset();
  await decide(client().client, target());
  await decide(client().client, target());
  assert.deepEqual([detectionRequests(), listRequests()], [2, 2]);
});

test("C16: a request carrying only preferences fetches the model list when the key's own policy has a requirement", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "only=missing" } };
  blockedFor((await decide(client("sort=price").client, target())).decision, /meets the policy combined with the key's own/);
  assert.equal(listRequests(), 1);
});

test("C16: with a bound key policy, the list held for this base URL and credential blocks a request carrying only preferences or nothing", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "only=missing" } };
  const { client: c } = client("zdr");
  blockedFor((await decide(c, target())).decision, /meets the policy combined with the key's own/);
  c.set("sort=price");
  blockedFor((await decide(c, target())).decision, /meets the policy combined with the key's own/);
  c.held = { kind: "none" };
  blockedFor((await decide(c, target())).decision, /meets the key's own policy/);
  assert.equal(listRequests(), 1, "the held list was used, not fetched again");
  assert.equal((await decide(c, target("k2"))).decision.action, "send", "another credential holds nothing here");
});

test("C8: the response to a translated request is reported unconfirmed, with or without route headers, and a refusal as a refusal", async () => {
  reset();
  const { client: c, reports } = client("only=aurora");
  const policy = c.held.kind === "policy" ? c.held.policy : assert.fail("held");
  const translated = (): Prepared => ({ decision: { action: "translate", model: "vendor/model", provider: { only: ["aurora"] }, sent: policy }, target: target(), generation: 0 });
  gateway.replies.inference = { status: 200, body: {} };
  await sendText(release(c, translated()));
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=aurora" }, body: {} };
  await sendText(release(c, translated()));
  gateway.replies.inference = { status: 503, headers: { "route-refused": "reason=unavailable" }, body: {} };
  await sendText(release(c, translated()));
  assert.deepEqual(reports, [{ kind: "unconfirmed" }, { kind: "unconfirmed" }, { kind: "refused", reason: "unavailable", key: null }]);
});

test("C13, C12: /route shows the key's own policy as locked, and one the client cannot interpret as text only", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "zdr+region=us" } };
  assert.match(await client().client.describe(target()), /Key policy \(locked, applied by the gateway to every request with this key\): zdr\+region=us/);
  gateway.replies.detection = { status: 200, body: { route_policy: "1", keys: ["zdr", "residency"], key_policy: "zdr+residency=eu" } };
  const text = await client().client.describe(target());
  assert.match(text, /Key policy \(locked\): "zdr\+residency=eu", which this client cannot interpret; shown as text and relied on for nothing/);
  assert.match(text, /^Route policy: zdr \(from ROUTE_POLICY\)$/m);
  assert.match(text, /^Last result: none yet$/m);
});

test("C1: /route shows when a base URL has no detection, and why", async () => {
  reset();
  gateway.replies.detection = { status: 404 };
  assert.match(await client().client.describe(target()), /: no detection \(detection reply is not valid: status is 404, not 200\)/);
});
