import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Decision } from "../src/decide.ts";
import { addWatcher } from "../src/fetch-gate.ts";
import type { Target } from "../src/gateway-client.ts";
import type { Report } from "../src/outcome.ts";
import type { RequestContext } from "../src/request.ts";
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

const bearer = (key: string): RequestContext => [["authorization", `Bearer ${key}`]];
const target = (key: string | null = "k", base = gateway.base): Target => ({ base, query: "", context: key === null ? [] : bearer(key) });
/** A target with every part of its key set, so a cache that drops any one of them is seen to. */
const placed = (key = "k", base = gateway.base): Target => ({ base, query: "?tenant=east", context: bearer(key) });

// Counted by credential: a request an earlier test abandoned on a timeout can still land after `reset`.
const reads = (path: string, credentials: readonly string[]): number =>
  gateway.requests.filter((r) => r.path.includes(path) && credentials.some((k) => r.headers.authorization === `Bearer ${k}`)).length;
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
  const headers = new Headers(Object.fromEntries(prepared.target.context));
  if (header !== null) headers.set("route-policy", header);
  return async () => fetch(`${prepared.target.base}/chat/completions${prepared.target.query}`, { method: "POST", headers, body });
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
    ["status 500", () => (gateway.replies.detection = { status: 500, body: { route_policy: "1" } }), /status is 500, not 200/],
    ["route_policy missing", () => (gateway.replies.detection = { status: 200, body: { keys: ["zdr"] } }), /route_policy is not the string "1"/],
    ["route_policy another version", () => (gateway.replies.detection = { status: 200, body: { route_policy: "2" } }), /route_policy is not the string "1"/],
    ["an array", () => (gateway.replies.detection = { status: 200, body: [{ route_policy: "1" }] }), /not a JSON object/],
    ["a string", () => (gateway.replies.detection = { status: 200, body: "route_policy" }), /not a JSON object/],
    ["null", () => (gateway.replies.detection = { status: 200, body: null }), /not a JSON object/],
    ["text that is not JSON", () => (gateway.replies.detection = { status: 200, raw: "{route_policy" }), /not a JSON object/],
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

test("C6: a key_policy in the reply to a request without credentials makes the reply invalid; only a header that carries a credential makes one credentialed", async () => {
  const at = (context: RequestContext): Target => ({ base: gateway.base, query: "", context });
  const anonymous: [string, RequestContext][] = [
    ["no headers", []],
    ["a trace header alone", [["traceparent", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"]]],
    ["an unknown header alone", [["x-tenant-token", "t"]]],
    ["an empty authorization", [["authorization", ""]]],
  ];
  for (const [name, context] of anonymous) {
    reset();
    gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "zdr" } };
    blockedFor((await decide(client().client, at(context))).decision, /key_policy is present in a reply to a request without credentials/);
    assert.equal(gateway.requests.filter((r) => r.path.endsWith("/route-policy")).length, 1, `${name}: detection was read`);
  }
  for (const name of ["authorization", "x-api-key", "x-goog-api-key", "api-key", "cookie", "proxy-authorization"]) {
    reset();
    gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "zdr" } };
    const { decision } = await decide(client().client, at([[name, "secret"]]));
    assert.equal(decision.action, "send", `${name} alone carries a credential`);
    assert.equal(gateway.requests.find((r) => r.path.endsWith("/route-policy"))?.headers[name], "secret", `detection read with ${name}`);
  }
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

test("C1, C14: detection and the model list are read with the whole context, and each context gets its own catalog and decision", async () => {
  reset();
  const { client: c } = client("only=aurora");
  // The same bearer with two cookies: the gateway knows two callers, and shows each its own catalog.
  const as = (cookie: string): Target => ({ base: gateway.base, query: "", context: [["authorization", "Bearer a"], ["cookie", cookie]] });
  gateway.replies.models = (headers) => ({
    status: 200,
    body: { data: [{ id: "demo-model", routes: [{ provider: headers.cookie === "who=east" ? "aurora" : "cobalt", facts: "" }] }] },
  });
  assert.equal((await decide(c, as("who=east"))).decision.action, "send", "aurora is in east's catalog");
  blockedFor((await decide(c, as("who=west"))).decision, /no route the model list publishes/);
  for (const path of ["/route-policy", "/models"]) {
    const gets = gateway.requests.filter((r) => r.path.endsWith(path));
    assert.deepEqual(gets.map((r) => [r.headers.authorization, r.headers.cookie]), [["Bearer a", "who=east"], ["Bearer a", "who=west"]], `${path} read once per context, with all of it`);
  }
});

test("C1, C14: a query string in the base URL is part of where the request goes: read with it, its own catalog and decision, and required on the request", async () => {
  reset();
  const { client: c } = client("only=aurora");
  // Two tenants behind one base URL, told apart by the query: each has its own catalog.
  gateway.replies.models = (_headers, path) => ({
    status: 200,
    body: { data: [{ id: "demo-model", routes: [{ provider: path.includes("tenant=east") ? "aurora" : "cobalt", facts: "" }] }] },
  });
  const t: Target = { base: gateway.base, query: "?tenant=east", context: bearer("k") };
  const send = release(c, await decide(c, t));
  blockedFor((await decide(c, { ...t, query: "?tenant=west" })).decision, /no route the model list publishes/);
  blockedFor((await decide(c, { ...t, query: "" })).decision, /no route the model list publishes/);
  assert.equal((await decide(c, t)).decision.action, "send", "east's catalog is still east's");
  for (const path of ["/route-policy", "/models"]) {
    const gets = gateway.requests.filter((r) => r.path.includes(path)).map((r) => r.path.slice(r.path.indexOf(path)));
    assert.deepEqual(gets, [`${path}?tenant=east`, `${path}?tenant=west`, path], `${path} read once for each place, with its query`);
  }
  await sendText(send);
  assert.ok(gateway.inference()[0]?.path.endsWith("/chat/completions?tenant=east"));
  release(c, await decide(c, t));
  const body = JSON.stringify({ model: "demo-model", messages: [] });
  // Everything as released but the query.
  await assert.rejects(fetch(`${gateway.base}/chat/completions?tenant=west`, { method: "POST", headers: { authorization: "Bearer k", "route-policy": "only=aurora" }, body }), /not one the plugin released/);
});

test("C1, C14: a request leaving with another context than the one it was checked for is stopped at fetch, and the user is told which headers it carried", async () => {
  reset();
  const { client: c, reports } = client("zdr");
  const prepared = await decide(c, target("demo-key"));
  release(c, prepared);
  const body = JSON.stringify({ model: "demo-model", messages: [] });
  for (const headers of [
    { authorization: "Bearer demo-key-zdr", "route-policy": "zdr" },
    { authorization: "Bearer demo-key", "x-api-key": "demo-key-zdr", "route-policy": "zdr" },
    { authorization: "Bearer demo-key", "api-key": "demo-key-zdr", "route-policy": "zdr" },
    { authorization: "Bearer demo-key", "x-goog-api-key": "demo-key-zdr", "route-policy": "zdr" },
    { authorization: "Bearer demo-key", cookie: "session=1", "route-policy": "zdr" },
    { authorization: "Bearer demo-key", "proxy-authorization": "Basic eA==", "route-policy": "zdr" },
    { authorization: "Bearer demo-key", "x-tenant-token": "t", "route-policy": "zdr" },
  ]) {
    await assert.rejects(fetch(`${gateway.base}/chat/completions`, { method: "POST", headers, body }), /is not one the plugin released/);
  }
  assert.equal(gateway.inference().length, 0);
  const last = reports.at(-1);
  assert.ok(last?.kind === "blocked");
  assert.match(last.reason, /it carries authorization, x-tenant-token besides the usual ones/);
  assert.doesNotMatch(last.reason, /demo-key/, "names only, never values");
});

test("C14: a not-honored result discards the detection reply of its own credential, and only that one, while another credential's request is in flight and finishes first", async () => {
  reset();
  const { client: c, reports } = client("zdr");
  // k1's request leaves first and comes back last, not honored; k2's leaves second and comes back first, honored.
  gateway.replies.inference = (request) =>
    request.headers.authorization === "Bearer k1"
      ? { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {}, delayMs: 200 }
      : { status: 200, headers: { "route-applied": "provider=aurora" }, body: {}, delayMs: 20 };
  const sendOne = release(c, await decide(c, placed("k1")));
  const sendTwo = release(c, await decide(c, placed("k2")));
  await Promise.all([sendText(sendOne), sendText(sendTwo)]);
  assert.deepEqual(reports.map((r) => r.kind), ["honored", "not-honored"]);
  await decide(c, placed("k1"));
  await decide(c, placed("k2"));
  assert.deepEqual([detectionRequests("k1"), detectionRequests("k2")], [2, 1], "k1's reply was discarded and fetched again; k2's was kept");
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
  const sendA = release(c, await decide(c, placed()));
  // B's decision waits on a slow model list; meanwhile A comes back with no Route-Applied, which is not honored.
  gateway.replies.models = { status: 200, body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr" }] }] }, delayMs: 300 };
  const deciding = decide(c, placed());
  gateway.replies.inference = { status: 200, body: {} };
  await sendText(sendA);
  const prepared = await deciding;
  assert.equal(c.isCurrent(prepared), false, "the generation is the one read before the wait");
});

test("C5: overlapping requests, completing in the reverse of the order they left, are each read by the session and against the policy that sent them", async () => {
  reset();
  gateway.replies.models = {
    status: 200,
    body: { data: [{ id: "demo-model", routes: ["aurora", "basalt", "cobalt"].map((provider) => ({ provider, facts: "" })) }] },
  };
  // Each request names one provider in its policy, and the gateway serves it by that one: each response honors
  // its own request's policy and no other's. The first to leave is answered last.
  const order = ["aurora", "basalt", "cobalt"];
  gateway.replies.inference = (request) => {
    const provider = order.find((p) => request.headers["route-policy"] === `only=${p}`) ?? "none";
    return { status: 200, headers: { "route-applied": `provider=${provider}` }, body: {}, delayMs: (order.length - order.indexOf(provider)) * 80 };
  };
  const first = client("only=aurora");
  const sendAurora = release(first.client, await decide(first.client, target()));
  first.client.set("only=basalt");
  const sendBasalt = release(first.client, await decide(first.client, target()));
  const second = client("only=cobalt");
  const sendCobalt = release(second.client, await decide(second.client, target()));
  const finished: string[] = [];
  const track = async (name: string, send: () => Promise<Response>): Promise<void> => {
    await sendText(send);
    finished.push(name);
  };
  await Promise.all([track("aurora", sendAurora), track("basalt", sendBasalt), track("cobalt", sendCobalt)]);
  assert.deepEqual(finished, ["cobalt", "basalt", "aurora"], "completed in the reverse of the order they left");
  const seen = (reports: Report[]): string[] => reports.map((r) => (r.kind === "honored" ? `honored ${r.provider}` : r.kind));
  assert.deepEqual(seen(first.reports), ["honored basalt", "honored aurora"], "the first session hears its own two, each against its own policy");
  assert.deepEqual(seen(second.reports), ["honored cobalt"], "the second session hears its own one");
});

test("C4: each response is read against the routes its own request was released with, while another request with other routes is in flight", async () => {
  reset();
  gateway.replies.models = {
    status: 200,
    body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr" }] }, { id: "other-model", routes: [{ provider: "cobalt", facts: "zdr" }] }] },
  };
  // Each model's request is served by the one route its list publishes for it; the first to leave comes back last.
  gateway.replies.inference = (request) =>
    request.body.includes('"demo-model"')
      ? { status: 200, headers: { "route-applied": "provider=aurora" }, body: {}, delayMs: 200 }
      : { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {}, delayMs: 20 };
  const { client: c, reports } = client("zdr");
  const sendDemo = release(c, await decide(c, target(), "demo-model"));
  const sendOther = release(c, await decide(c, target(), "other-model"));
  await Promise.all([sendText(sendDemo), sendText(sendOther)]);
  assert.deepEqual(reports, [
    { kind: "honored", provider: "cobalt", checked: true, evidence: null },
    { kind: "honored", provider: "aurora", checked: true, evidence: null },
  ]);
});

test("C1, C14: identical requests released in turn are matched in the order they were released: the one decided before a discard is stopped, the one after goes", async () => {
  reset();
  const { client: c } = client("zdr");
  const sendA = release(c, await decide(c, target()));
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {} };
  // B carries the same bytes as A, and is decided before A comes back not honored; C after, on a fresh reply.
  const sendB = release(c, await decide(c, target()));
  await sendText(sendA);
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=aurora" }, body: {} };
  const sendC = release(c, await decide(c, target()));
  // The first send of these bytes is B's, which relied on the discarded reply; the next is C's.
  await assert.rejects(sendB(), /discarded before it left/);
  await sendText(sendC);
  assert.equal(gateway.inference().length, 2, "A and C went; B did not");
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

test("C5, C8: a redirect never outranks a refusal, and a translated request answered with one is still unconfirmed", async () => {
  reset();
  const { client: c, reports } = client("only=aurora");
  const policy = c.held.kind === "policy" ? c.held.policy : assert.fail("held");
  gateway.replies.inference = { status: 308, headers: { location: `${elsewhere.base}/chat/completions` } };
  await sendText(release(c, { decision: { action: "translate", model: "vendor/model", provider: { only: ["aurora"] }, sent: policy }, target: target(), generation: 0 }));
  const translated = reports.at(-1);
  assert.ok(translated?.kind === "unconfirmed");
  assert.match(translated.note ?? "", /redirect \(status 308\)/);
  gateway.replies.inference = { status: 307, headers: { location: `${elsewhere.base}/chat/completions`, "route-refused": "reason=unavailable" } };
  await sendText(release(c, await decide(c, target())));
  assert.deepEqual(reports.at(-1), { kind: "refused", reason: "unavailable", key: null });
  assert.equal(elsewhere.requests.length, 0);
});

test("C4, C16: a model list reply of any JSON value is read as a list (object, array, string, number, true, false, null), and one that is not JSON is no list", async () => {
  const cases: [string, { body?: unknown; raw?: string }, boolean][] = [
    ["an object", { body: { data: "none" } }, true],
    ["an array", { body: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "" }] }] }, true],
    ["a string", { body: "aurora" }, true],
    ["a number", { body: 7 }, true],
    ["true", { body: true }, true],
    ["false", { body: false }, true],
    ["null", { body: null }, true],
    ["text that is not JSON", { raw: "{not json" }, false],
    ["an empty body", {}, false],
  ];
  for (const [name, reply, held] of cases) {
    reset();
    gateway.replies.models = { status: 200, ...reply };
    const { decision } = await decide(client("only=aurora").client, target());
    assert.equal(listRequests(), 1, `${name}: the list was read`);
    if (held) blockedFor(decision, /no route the model list publishes/);
    else assert.ok(decision.action === "send" && decision.routes === null, `${name}: no list is held, so the gateway decides`);
  }
});

test("C4, C14: each base URL has its own model list, and the decision follows the list of the base URL it goes to", async () => {
  reset();
  elsewhere.requests.length = 0;
  elsewhere.replies.detection = { status: 200, body: { route_policy: "1" } };
  elsewhere.replies.models = { status: 200, body: { data: [{ id: "demo-model", routes: [{ provider: "cobalt", facts: "" }] }] } };
  const { client: c } = client("only=aurora");
  assert.equal((await decide(c, target())).decision.action, "send", "aurora is in this base URL's list");
  blockedFor((await decide(c, target("k", elsewhere.base))).decision, /no route the model list publishes/);
  assert.equal(elsewhere.requests.filter((r) => r.path.endsWith("/models")).length, 1, "the other base URL's list was read");
});

test("C14: failed reads are not kept, so the next request tries again: a detection reply and a model list each", async () => {
  reset();
  gateway.replies.detection = { status: 503 };
  const { client: c } = client("zdr");
  blockedFor((await decide(c, target())).decision, /status is 503/);
  gateway.replies.detection = { status: 200, body: { route_policy: "1" } };
  gateway.replies.models = { status: 503 };
  const withoutList = (await decide(c, target())).decision;
  assert.ok(withoutList.action === "send" && withoutList.routes === null, "detection read again; no list held yet");
  gateway.replies.models = { status: 200, body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr" }] }] } };
  const withList = (await decide(c, target())).decision;
  assert.ok(withList.action === "send" && withList.routes !== null, "the list read again");
  assert.deepEqual([detectionRequests(), listRequests()], [2, 2]);
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
  blockedFor((await decide(c, placed())).decision, /meets the policy combined with the key's own/);
  c.set("sort=price");
  blockedFor((await decide(c, placed())).decision, /meets the policy combined with the key's own/);
  c.held = { kind: "none" };
  blockedFor((await decide(c, placed())).decision, /meets the key's own policy/);
  assert.equal(listRequests(), 1, "the held list was used, not fetched again");
  assert.equal((await decide(c, placed("k2"))).decision.action, "send", "another credential holds nothing here");
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
