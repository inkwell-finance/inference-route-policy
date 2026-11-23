import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Decision } from "../src/decide.ts";
import type { Verdict } from "../src/fetch-gate.ts";
import type { Target } from "../src/gateway-client.ts";
import type { Report } from "../src/outcome.ts";
import type { Outgoing } from "../src/request.ts";
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

const decide = async (c: RouteClient, target: Target, model = "demo-model"): Promise<Prepared> => c.decide(target, model, null);

/** Releases a decided request as the plugin does, and returns it as it would leave through `fetch`. */
function release(c: RouteClient, prepared: Prepared): Outgoing {
  const { decision } = prepared;
  assert.ok(decision.action !== "block", decision.action === "block" ? decision.reason : "");
  const header = decision.action === "send" ? decision.header : null;
  c.release({ ...prepared, decision }, { base: prepared.target.base, credential: prepared.target.credential, model: decision.model, header });
  return { url: `${prepared.target.base}/chat/completions`, method: "POST", credential: prepared.target.credential, model: decision.model, header };
}

/** What the gate says, completing a released call with `applied` and `refused` result headers. */
function leave(c: RouteClient, outgoing: Outgoing, applied: string[] = [], refused: string[] = []): Verdict {
  const verdict = c.gate(outgoing);
  if (verdict.kind === "released") verdict.complete({ status: refused.length > 0 ? 400 : 200, result: { applied, refused, evidence: [] } });
  return verdict;
}

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
    const { decision } = await decide(client("zdr").client, { base: gateway.base, credential: "k" });
    if (refusal === null) assert.equal(decision.action, "send", name);
    else blockedFor(decision, refusal);
  }
});

test("C6, C14: another origin's valid reply, reached by a redirect, never authorizes a request; nor does its model list", async () => {
  reset();
  elsewhere.replies.detection = { status: 200, body: { route_policy: "1" } };
  gateway.replies.detection = { status: 302, headers: { location: `${elsewhere.base}/route-policy` } };
  const target = { base: gateway.base, credential: "k" };
  blockedFor((await decide(client("zdr").client, target)).decision, /status is 302, not 200/);
  assert.equal(elsewhere.requests.length, 0, "the redirect was not followed");

  reset();
  gateway.replies.models = { status: 307, headers: { location: `${elsewhere.base}/models` } };
  elsewhere.replies.models = { status: 200, body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "" }] }] } };
  const { decision } = await decide(client("only=nosuch").client, target);
  assert.ok(decision.action === "send", "no list is held, so the gateway decides");
  assert.equal(decision.routes, null);
  assert.equal(elsewhere.requests.length, 0);
});

test("C6: a key_policy in the reply to a request without credentials makes the reply invalid", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "zdr" } };
  blockedFor((await decide(client().client, { base: gateway.base, credential: null })).decision, /key_policy is present in a reply to a request without credentials/);
  assert.equal(gateway.requests.at(-1)?.headers.authorization, undefined, "the request carried no credentials");
  assert.equal((await decide(client().client, { base: gateway.base, credential: "k" })).decision.action, "send");
  assert.equal(gateway.requests.find((r) => r.path.endsWith("/route-policy") && r.headers.authorization !== undefined)?.headers.authorization, "Bearer k");
});

test("C6: a detection fetch that cannot complete in time, or cannot connect, is no detection", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1" }, delayMs: 300 };
  blockedFor((await decide(client("zdr", 50).client, { base: gateway.base, credential: "abandoned" })).decision, /detection could not be fetched/);
  blockedFor((await decide(client().client, { base: "http://127.0.0.1:9/v1", credential: "k" })).decision, /detection could not be fetched/);
});

test("C14: a detection reply and a model list are kept per base URL and credential, and used for no other", async () => {
  reset();
  const { client: c } = client("zdr");
  const target = { base: gateway.base, credential: "k1" };
  await decide(c, target);
  await decide(c, target);
  assert.deepEqual([detectionRequests("k1", "k2"), listRequests("k1", "k2")], [1, 1], "reused for the same base URL and credential");
  await decide(c, { base: gateway.base, credential: "k2" });
  assert.deepEqual([detectionRequests("k1", "k2"), listRequests("k1", "k2")], [2, 2], "fetched again for another credential");
  await decide(c, { base: `${gateway.base}/`, credential: "k2" });
  assert.deepEqual([detectionRequests("k1", "k2"), listRequests("k1", "k2")], [2, 2], "a trailing slash names the same base URL");
  blockedFor((await decide(c, { base: "http://127.0.0.1:9/v1", credential: "k2" })).decision, /127\.0\.0\.1:9\/v1 has no valid detection reply/);
});

test("C1, C14: a request leaving with another key than the one it was checked for is stopped at the gate", async () => {
  reset();
  const { client: c } = client("zdr");
  const outgoing = release(c, await decide(c, { base: gateway.base, credential: "demo-key" }));
  const verdict = c.gate({ ...outgoing, credential: "demo-key-zdr" });
  assert.ok(verdict.kind === "stop");
  assert.match(verdict.reason, /not one the plugin checked: its key, model, or Route-Policy header differs/);
  assert.equal(c.gate(outgoing).kind, "released", "the key it was checked for goes");
  // Nor may the model or the policy header change on the way out.
  assert.equal(c.gate({ ...outgoing, model: "demo-model+notrain" }).kind, "stop");
  assert.equal(c.gate({ ...outgoing, header: null }).kind, "stop");
  assert.equal(c.gate({ ...outgoing, model: undefined }).kind, "stop", "a body the gate cannot read is not a released one");
});

test("C1: with no policy anywhere, an unreleased request to a watched base URL goes, and one elsewhere is not the gate's", async () => {
  reset();
  const { client: c } = client("zdr");
  const outgoing = release(c, await decide(c, { base: gateway.base, credential: "k" }));
  c.held = { kind: "none" };
  assert.equal(c.gate({ ...outgoing, credential: "other", header: null }).kind, "pass");
  assert.equal(c.gate({ ...outgoing, credential: "other" }).kind, "stop", "a Route-Policy header is a policy at stake");
  assert.equal(c.gate({ ...outgoing, credential: "other", header: null, model: "demo-model+zdr" }).kind, "stop", "a typed suffix is a policy at stake");
  assert.equal(c.gate({ ...outgoing, url: "http://elsewhere.test/v1/chat/completions" }).kind, "pass");
});

test("C14: a not-honored result discards the detection reply of its own credential, and only that one", async () => {
  reset();
  const { client: c, reports } = client("zdr");
  const [one, two] = [{ base: gateway.base, credential: "k1" }, { base: gateway.base, credential: "k2" }];
  const sentOne = release(c, await decide(c, one));
  const sentTwo = release(c, await decide(c, two));
  // Each response is read on the call that made it, so completion order does not matter.
  const second = c.gate(sentTwo);
  const first = c.gate(sentOne);
  assert.ok(second.kind === "released" && first.kind === "released");
  second.complete({ status: 200, result: { applied: ["provider=cobalt"], refused: [], evidence: [] } });
  first.complete({ status: 200, result: { applied: ["provider=aurora"], refused: [], evidence: [] } });
  assert.deepEqual(reports.map((r) => r.kind), ["not-honored", "honored"]);
  await decide(c, one);
  await decide(c, two);
  assert.deepEqual([detectionRequests("k1"), detectionRequests("k2")], [1, 2], "k2's reply was discarded and fetched again; k1's was kept");
});

test("C14: a request decided before its detection reply was discarded is not current, and the gate stops it", async () => {
  reset();
  const { client: c } = client("zdr");
  const target = { base: gateway.base, credential: "k" };
  const a = release(c, await decide(c, target));
  const prepared = await decide(c, target);
  assert.ok(c.isCurrent(prepared));
  leave(c, a, ["provider=cobalt"]);
  assert.equal(c.isCurrent(prepared), false, "the decision relied on the discarded reply");
  const verdict = c.gate(a);
  assert.ok(verdict.kind === "stop");
  assert.match(verdict.reason, /discarded before it left/);
  // Decided again, on a fresh reply, it goes.
  assert.equal(c.gate(release(c, await decide(c, target))).kind, "released");
});

test("C5, C14: every one of many overlapping requests is read on its own call; a refusal among them is reported as one", async () => {
  reset();
  const { client: c, reports } = client("zdr");
  const outgoing = release(c, await decide(c, { base: gateway.base, credential: "k" }));
  const calls = Array.from({ length: 40 }, () => c.gate(outgoing));
  calls.forEach((call, i) => {
    assert.ok(call.kind === "released");
    call.complete({ status: i === 0 ? 400 : 200, result: i === 0 ? { applied: [], refused: ["reason=unsatisfiable"], evidence: [] } : { applied: ["provider=aurora"], refused: [], evidence: [] } });
  });
  assert.equal(reports.length, 40);
  assert.deepEqual(reports[0], { kind: "refused", reason: "unsatisfiable", key: null });
  assert.ok(reports.slice(1).every((r) => r.kind === "honored"));
});

test("C14: failed reads are not kept, so the next request tries again", async () => {
  reset();
  gateway.replies.detection = { status: 503 };
  const { client: c } = client("zdr");
  const target = { base: gateway.base, credential: "k" };
  blockedFor((await decide(c, target)).decision, /status is 503/);
  gateway.replies.detection = { status: 200, body: { route_policy: "1" } };
  assert.equal((await decide(c, target)).decision.action, "send");
});

test("C15: a new client, as in the next run, holds no detection reply or model list from the last", async () => {
  reset();
  const target = { base: gateway.base, credential: "k" };
  await decide(client().client, target);
  await decide(client().client, target);
  assert.deepEqual([detectionRequests(), listRequests()], [2, 2]);
});

test("C16: a request carrying only preferences fetches the model list when the key's own policy has a requirement", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "only=missing" } };
  blockedFor((await decide(client("sort=price").client, { base: gateway.base, credential: "k" })).decision, /meets the policy combined with the key's own/);
  assert.equal(listRequests(), 1);
});

test("C16: with a bound key policy, the list held for this base URL and credential blocks a request carrying only preferences or nothing", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "only=missing" } };
  const target = { base: gateway.base, credential: "k" };
  const { client: c } = client("zdr");
  blockedFor((await decide(c, target)).decision, /meets the policy combined with the key's own/);
  c.set("sort=price");
  blockedFor((await decide(c, target)).decision, /meets the policy combined with the key's own/);
  c.held = { kind: "none" };
  blockedFor((await decide(c, target)).decision, /meets the key's own policy/);
  assert.equal(listRequests(), 1, "the held list was used, not fetched again");
  assert.equal((await decide(c, { base: gateway.base, credential: "k2" })).decision.action, "send", "another credential holds nothing here");
});

test("C4: a response is read against the routes of the list held when the request was sent", async () => {
  reset();
  const { client: c, reports } = client("zdr");
  leave(c, release(c, await decide(c, { base: gateway.base, credential: "k" })), ["provider=aurora"]);
  assert.deepEqual(reports.at(-1), { kind: "honored", provider: "aurora", checked: true, evidence: null });
});

test("C8: the response to a translated request is reported unconfirmed, with or without route headers, and a refusal as a refusal", () => {
  const { client: c, reports } = client("only=aurora");
  const policy = c.held.kind === "policy" ? c.held.policy : assert.fail("held");
  const target = { base: "https://openrouter.ai/api/v1", credential: "k" };
  const outgoing = release(c, { decision: { action: "translate", model: "vendor/model", provider: { only: ["aurora"] }, sent: policy }, target, generation: 0 });
  leave(c, outgoing);
  leave(c, outgoing, ["provider=aurora"]);
  leave(c, outgoing, [], ["reason=unavailable"]);
  assert.deepEqual(reports, [{ kind: "unconfirmed" }, { kind: "unconfirmed" }, { kind: "refused", reason: "unavailable", key: null }]);
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
