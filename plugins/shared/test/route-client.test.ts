import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Decision } from "../src/decide.ts";
import { addWatcher, withdrawReleases } from "../src/fetch-gate.ts";
import type { Fetch, Target } from "../src/gateway-client.ts";
import { OPENROUTER_BASE } from "../src/openrouter.ts";
import type { Report } from "../src/outcome.ts";
import { holdPolicy } from "../src/held.ts";
import { placeOf, type RequestContext } from "../src/request.ts";
import { RouteClient, type Located, type Prepared } from "../src/route-client.ts";
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
  elsewhere.requests.length = 0;
  gateway.replies.detection = { status: 200, body: { route_policy: "1" } };
  gateway.replies.models = { status: 200, body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr" }] }] } };
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=aurora" }, body: {} };
}

function blockedFor(decision: Decision, pattern: RegExp): void {
  assert.ok(decision.action === "block", `expected a block, got ${decision.action}`);
  assert.match(decision.reason, pattern);
}

const decide = (c: RouteClient, t: Target, model = "demo-model"): Promise<Prepared> => c.decide({ target: t, unexact: null }, model, null);

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
    ["attest not a list", () => (gateway.replies.detection = { status: 200, body: { route_policy: "1", attest: "weights" } }), /attest is not a list of items/],
    ["sort not a list", () => (gateway.replies.detection = { status: 200, body: { route_policy: "1", sort: "price" } }), /sort is not a list of items/],
    ["key_policy not a string", () => (gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: 7 } }), /key_policy is not a string/],
    ["key_policy not a valid policy", () => (gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "zdr+zdr" } }), /key_policy fails the order of checks/],
  ];
  for (const [name, arrange, refusal] of cases) {
    reset();
    arrange();
    const { decision } = await decide(client("zdr").client, target());
    if (refusal === null) assert.equal(decision.action, "send", name);
    else blockedFor(decision, refusal);
  }
  // A fetch that fails outright: no reply at all is no detection either.
  reset();
  const refused: Fetch = async () => {
    throw new TypeError("connection refused");
  };
  const c = new RouteClient({ carriers: "header", env: { ROUTE_POLICY: "zdr" }, fetch: refused, onReport: () => {} });
  blockedFor((await decide(c, target())).decision, /no valid detection reply \(detection could not be fetched: connection refused\)/);
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
    assert.deepEqual(gateway.requests.map((r) => [r.path.slice(r.path.lastIndexOf("/")), r.headers[name]]), [["/route-policy", "secret"], ["/models", "secret"]], `detection and the list read with ${name}, and nothing else read`);
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
  // Two reachable base URLs, the same credential, each its own catalog: each decision follows its own.
  elsewhere.requests.length = 0;
  elsewhere.replies.detection = { status: 200, body: { route_policy: "1" } };
  elsewhere.replies.models = { status: 200, body: { data: [{ id: "demo-model", routes: [{ provider: "cobalt", facts: "zdr" }] }] } };
  c.set("only=aurora");
  assert.equal((await decide(c, target("k1"))).decision.action, "send", "aurora is in this base URL's list");
  blockedFor((await decide(c, target("k1", elsewhere.base))).decision, /no route the model list publishes/);
  assert.equal((await decide(c, target("k1"))).decision.action, "send", "and still is, after the other's was read");
  assert.equal(elsewhere.requests.filter((r) => r.path.endsWith("/models")).length, 1);
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
  // The same bearer and cookie, told apart only by a header of the gateway's own.
  reset();
  const tenant = (token: string): Target => ({ base: gateway.base, query: "", context: [["authorization", "Bearer a"], ["cookie", "who=east"], ["x-tenant-token", token]] });
  gateway.replies.models = (headers) => ({
    status: 200,
    body: { data: [{ id: "demo-model", routes: [{ provider: headers["x-tenant-token"] === "t1" ? "aurora" : "cobalt", facts: "" }] }] },
  });
  const { client: d } = client("only=aurora");
  assert.equal((await decide(d, tenant("t1"))).decision.action, "send");
  blockedFor((await decide(d, tenant("t2"))).decision, /no route the model list publishes/);
  assert.deepEqual(gateway.requests.filter((r) => r.path.endsWith("/models")).map((r) => r.headers["x-tenant-token"]), ["t1", "t2"]);
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

test("C1, C14: no query, an empty query, and a query are three base URLs: each is read and sent with exactly its own request target, and a request to another of them is stopped", async () => {
  reset();
  const { client: c } = client("zdr");
  const given: [string, string][] = [[gateway.base, ""], [`${gateway.base}?`, "?"], [`${gateway.base}?t=1`, "?t=1"]];
  const sends: (() => Promise<Response>)[] = [];
  for (const [base, query] of given) {
    assert.deepEqual(placeOf(base), { place: { base: gateway.base, query }, unexact: null }, base);
    sends.push(release(c, await decide(c, { base: gateway.base, query, context: bearer("k") })));
  }
  for (const send of sends) await sendText(send);
  const path = new URL(gateway.base).pathname;
  assert.deepEqual(
    gateway.requests.map((r) => `${r.method} ${r.path}`),
    ["", "?", "?t=1"].flatMap((q) => [`GET ${path}/route-policy${q}`, `GET ${path}/models${q}`]).concat(["", "?", "?t=1"].map((q) => `POST ${path}/chat/completions${q}`)),
  );
  // Released for one of them, sent to another: stopped, whichever way round.
  const body = JSON.stringify({ model: "demo-model", messages: [] });
  const headers = { authorization: "Bearer k", "route-policy": "zdr" };
  const places = ["", "?", "?t=1"];
  for (const [releasedFor, sentTo] of places.flatMap((a) => places.filter((b) => b !== a).map((b) => [a, b] as const))) {
    const prepared = await decide(c, { base: gateway.base, query: releasedFor, context: bearer("k") });
    assert.ok(prepared.decision.action === "send");
    c.release({ ...prepared, decision: prepared.decision }, "zdr", body);
    await assert.rejects(fetch(`${gateway.base}/chat/completions${sentTo}`, { method: "POST", headers, body }), /not one the plugin released/, `released for "${releasedFor}", sent to "${sentTo}"`);
    // The release unused, it is withdrawn, as at the end of a session, so the next pair starts from none.
    withdrawReleases(c);
  }
  assert.equal(gateway.inference().length, 3);
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
  // One report for each, naming exactly the headers that request carried, and none of their values.
  const carried = ["authorization", "authorization, x-api-key", "api-key, authorization", "authorization, x-goog-api-key", "authorization, cookie", "authorization, proxy-authorization", "authorization, x-tenant-token"];
  assert.deepEqual(
    reports.map((r) => (r.kind === "blocked" ? r.reason : r.kind)),
    carried.map((names) => `this request to ${gateway.base} is not one the plugin released: its URL, headers (it carries ${names} besides the usual ones), body, or Route-Policy header differs from what was checked, or it was already sent once`),
  );
  assert.ok(reports.every((r) => r.kind === "blocked" && !/demo-key|session=1|eA==|=t\b/.test(r.reason)), "names only, never values");
});

test("C14: a not-honored result discards the detection reply of its own credential, and only that one, while another credential's request is in flight and finishes first", async () => {
  reset();
  // A key policy, only=cobalt, that demo-model's routes meet and other-model's do not: a request for other-model
  // with no policy of its own is blocked exactly while that detection reply is held for its place.
  const keyed = { status: 200, body: { route_policy: "1", key_policy: "only=cobalt" } };
  const list = { status: 200, body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr" }, { provider: "cobalt", facts: "zdr" }] }, { id: "other-model", routes: [{ provider: "aurora", facts: "zdr" }] }] } };
  gateway.replies.detection = keyed;
  gateway.replies.models = list;
  elsewhere.replies.detection = keyed;
  elsewhere.replies.models = list;
  const { client: c, reports } = client("zdr");
  // k1's request leaves first and comes back last, not honored; k2's leaves second and comes back first, honored.
  gateway.replies.inference = (request) =>
    request.headers.authorization === "Bearer k1"
      ? { status: 200, headers: { "route-applied": "provider=basalt" }, body: {}, delayMs: 200 }
      : { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {}, delayMs: 20 };
  const sendOne = release(c, await decide(c, placed("k1")));
  const sendTwo = release(c, await decide(c, placed("k2")));
  // The same credential at another query, and at another origin, holds its own reply.
  const westK1: Target = { ...placed("k1"), query: "?tenant=west" };
  const elsewhereK1 = target("k1", elsewhere.base);
  await decide(c, westK1);
  await decide(c, elsewhereK1);
  const policyFree = async (t: Target): Promise<Decision> => {
    c.held = { kind: "none" };
    const { decision } = await decide(c, t, "other-model");
    c.held = holdPolicy("zdr", "session");
    return decision;
  };
  for (const t of [placed("k1"), placed("k2"), westK1, elsewhereK1]) blockedFor(await policyFree(t), /meets the key's own policy/);
  await Promise.all([sendText(sendOne), sendText(sendTwo)]);
  assert.deepEqual(reports.map((r) => r.kind), ["honored", "not-honored"]);
  // Before anything is read again: k1's reply at its place is gone, held copy included; every other one is kept.
  assert.equal(view(await policyFree(placed("k1"))), '{"action":"send","model":"other-model","header":null,"sent":null,"routes":["aurora"]}', "judged by the list alone, the key policy unknown");
  for (const t of [placed("k2"), westK1, elsewhereK1]) blockedFor(await policyFree(t), /meets the key's own policy/);
  await decide(c, placed("k1"));
  await decide(c, placed("k2"));
  assert.deepEqual([detectionRequests("k1"), detectionRequests("k2")], [2 + 1, 1], "k1's reply at its place was read again; west's and k2's were kept");
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

  // Waiting on a detection read itself: two requests out, the first comes back not honored and the detection reply
  // is read again, slowly; the second comes back not honored while that read is still out.
  reset();
  const { client: d } = client("zdr");
  gateway.replies.models = { status: 200, body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr" }] }, { id: "other-model", routes: [{ provider: "aurora", facts: "zdr" }] }] } };
  gateway.replies.inference = (request) => ({ status: 200, headers: { "route-applied": "provider=cobalt" }, body: {}, delayMs: request.body.includes("other-model") ? 200 : 10 });
  const first = release(d, await decide(d, target(), "demo-model"));
  const second = release(d, await decide(d, target(), "other-model"));
  const bothBack = Promise.all([sendText(first), sendText(second)]);
  for (let i = 0; i < 400 && d.lastReport === null; i++) await new Promise((wake) => setTimeout(wake, 5));
  gateway.replies.detection = { status: 200, body: { route_policy: "1" }, delayMs: 400 };
  const coldDeciding = decide(d, target(), "demo-model");
  await bothBack;
  const cold = await coldDeciding;
  assert.equal(detectionRequests(), 2, "the detection reply was read again, once");
  assert.equal(d.isCurrent(cold), false, "the second discard landed during the detection read, so its decision is stale");
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
  // Each leaves a little after the one before, without waiting for it to arrive.
  const pending: Promise<void>[] = [];
  for (const [name, send] of [["aurora", sendAurora], ["basalt", sendBasalt], ["cobalt", sendCobalt]] as const) {
    pending.push(track(name, send));
    await new Promise((wake) => setTimeout(wake, 30));
  }
  await Promise.all(pending);
  assert.deepEqual(gateway.inference().map((r) => r.headers["route-policy"]), ["only=aurora", "only=basalt", "only=cobalt"], "they left in this order");
  assert.deepEqual(finished, ["cobalt", "basalt", "aurora"], "completed in the reverse of the order they left");
  const seen = (reports: Report[]): string[] => reports.map((r) => (r.kind === "honored" ? `honored ${r.provider}` : r.kind));
  assert.deepEqual(seen(first.reports), ["honored basalt", "honored aurora"], "the first session hears its own two, each against its own policy");
  assert.deepEqual(seen(second.reports), ["honored cobalt"], "the second session hears its own one");
});

test("C4: each response is read against the routes its own request was released with, while another request with other routes is in flight", async () => {
  reset();
  gateway.replies.models = {
    status: 200,
    body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr" }, { provider: "basalt", facts: "" }] }, { id: "other-model", routes: [{ provider: "cobalt", facts: "zdr" }] }] },
  };
  // demo-model's request is served by basalt, which its list publishes without zdr; other-model's by cobalt, which
  // meets it. The first to leave comes back last.
  gateway.replies.inference = (request) =>
    request.body.includes('"demo-model"')
      ? { status: 200, headers: { "route-applied": "provider=basalt" }, body: {}, delayMs: 200 }
      : { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {}, delayMs: 20 };
  const { client: c, reports } = client("zdr");
  const sendDemo = release(c, await decide(c, target(), "demo-model"));
  const sendOther = release(c, await decide(c, target(), "other-model"));
  await Promise.all([sendText(sendDemo), sendText(sendOther)]);
  assert.deepEqual(reports, [
    { kind: "honored", provider: "cobalt", checked: true, evidence: null },
    { kind: "not-honored", why: 'route "basalt" does not meet the policy sent' },
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
  assert.deepEqual(reports, [{ kind: "not-honored", why: "the gateway answered with a redirect (status 307), which the plugin does not follow with content" }]);
  await decide(c, target());
  assert.equal(detectionRequests(), 2);
});

test("C5, C8: a redirect never outranks a refusal, and a translated request answered with one is still unconfirmed", async () => {
  const redirect = "the gateway answered with a redirect (status 308), which the plugin does not follow with content";
  const cases: [string, Record<string, string>, Report][] = [
    ["translated, no refusal", {}, { kind: "unconfirmed", note: redirect }],
    ["translated, a refusal", { "route-refused": "reason=unavailable" }, { kind: "refused", reason: "unavailable", key: null }],
    ["translated, an unreadable refusal", { "route-refused": "reason=maybe" }, { kind: "refused", reason: null, key: null }],
    ["protocol, no refusal", {}, { kind: "not-honored", why: redirect }],
    ["protocol, a refusal", { "route-refused": "reason=unavailable" }, { kind: "refused", reason: "unavailable", key: null }],
    ["protocol, an unreadable refusal", { "route-refused": "reason=maybe" }, { kind: "refused", reason: null, key: null }],
  ];
  for (const [name, headers, expected] of cases) {
    reset();
    const { client: c, reports } = client("only=aurora");
    const policy = c.held.kind === "policy" ? c.held.policy : assert.fail("held");
    gateway.replies.inference = { status: 308, headers: { location: `${elsewhere.base}/chat/completions`, ...headers } };
    const prepared: Prepared = name.startsWith("translated")
      ? { decision: { action: "translate", model: "vendor/model", provider: { only: ["aurora"] }, sent: policy }, target: target(), unexact: null, generation: 0 }
      : await decide(c, target());
    await sendText(release(c, prepared));
    assert.deepEqual(reports, [expected], name);
  }
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
  // An object that publishes routes is read for them: one requirement its route meets, another it does not.
  reset();
  gateway.replies.models = { status: 200, body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr" }] }] } };
  const met = (await decide(client("zdr").client, target())).decision;
  assert.ok(met.action === "send" && met.routes !== null && [...met.routes.keys()].join() === "aurora", view(met));
  blockedFor((await decide(client("notrain").client, target())).decision, /no route the model list publishes/);
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

// Replies that differ by place: the query names a team whose key policy no route meets, and a second key has a
// key policy of its own that no route meets either. Every other place gets a plain reply.
function differingPlaces(): void {
  gateway.replies.detection = (headers, path) =>
    path.includes("team=R%27D")
      ? { status: 200, body: { route_policy: "1", key_policy: "only=nosuch" } }
      : headers.authorization === "Bearer k2"
        ? { status: 200, body: { route_policy: "1", key_policy: "notrain" } }
        : { status: 200, body: { route_policy: "1" } };
  gateway.replies.models = { status: 200, body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr" }, { provider: "cobalt", facts: "" }] }] } };
}

/** A decision as data, for comparing two: its routes by provider. */
const view = (decision: Decision): string => JSON.stringify(decision, (_key, value: unknown) => (value instanceof Map ? [...value.keys()] : value));

test("C14: a base URL that cannot be used as written holds nothing, so a request with no policy goes as the harness sends it, before and after its rewritten spelling was read", async () => {
  reset();
  differingPlaces();
  const written = placeOf(`${gateway.base}?team=R'D`);
  assert.ok(written !== null && written.unexact !== null);
  const inexact: Located = { target: { ...written.place, context: bearer("k") }, unexact: written.unexact };
  const encoded: Located = { target: { ...written.place, context: bearer("k") }, unexact: null };
  const { client: c } = client("zdr");
  const asGiven = { action: "send", model: "demo-model", header: null, sent: null, routes: null };
  const body = JSON.stringify({ model: "demo-model", messages: [] });
  // Sent as the harness sends it: to where fetch puts the base URL, with no policy header, the body untouched.
  const goes = async (): Promise<void> => {
    const before = gateway.requests.length;
    await (await fetch(`${gateway.base}/chat/completions?team=R'D`, { method: "POST", headers: { authorization: "Bearer k" }, body })).text();
    const sent = gateway.requests.slice(before);
    assert.deepEqual(sent.map((r) => [r.method, r.path.slice(r.path.indexOf("/chat")), r.headers["route-policy"], r.body]), [["POST", "/chat/completions?team=R%27D", undefined, body]]);
  };
  c.held = { kind: "none" };
  let reads = gateway.requests.length;
  assert.equal(view((await c.decide(inexact, "demo-model", null)).decision), view(asGiven as Decision), "cold");
  assert.equal(gateway.requests.length, reads, "nothing read for it, cold");
  await goes();
  // The encoded spelling is a place of its own. A request there with a policy reads its detection and catalog;
  // then its key policy, which no route meets, blocks even a request there with none.
  c.held = holdPolicy("zdr", "session");
  blockedFor((await c.decide(encoded, "demo-model", null)).decision, /meets the policy combined with the key's own/);
  c.held = { kind: "none" };
  blockedFor((await c.decide(encoded, "demo-model", null)).decision, /meets the key's own policy/);
  reads = gateway.requests.length;
  assert.equal(view((await c.decide(inexact, "demo-model", null)).decision), view(asGiven as Decision), "warm: the same request, the same decision");
  assert.equal(gateway.requests.length, reads, "nothing read for it, warm");
  await goes();
});

// Three models, each published with routes of its own, and three catalogs: the team's and another origin's list
// the same models with other routes. Facts differ by route, so one policy is met for one model and not another.
const FACTS: Readonly<Record<string, readonly string[]>> = { aurora: ["zdr", "notrain"], basalt: ["zdr"], cobalt: [] };
type Catalog = "plain" | "team" | "other";
const CATALOGS: Readonly<Record<Catalog, Readonly<Record<string, readonly string[]>>>> = {
  plain: { alfa: ["aurora"], bravo: ["basalt"], charlie: ["cobalt"] },
  team: { alfa: ["basalt", "cobalt"], bravo: ["aurora"], charlie: ["aurora", "basalt"] },
  other: { alfa: ["cobalt"], bravo: ["basalt", "aurora"], charlie: ["basalt"] },
};
const listOf = (catalog: Catalog): unknown => ({
  data: Object.entries(CATALOGS[catalog]).map(([id, providers]) => ({ id, routes: providers.map((provider) => ({ provider, facts: (FACTS[provider] ?? []).join("+") })) })),
});

// Replies that differ by place: the team's key policy and k2's are each met by some routes and not others; the
// other origin has its own catalog and no key policy.
function placesWithCatalogs(): void {
  gateway.replies.detection = (headers, path) =>
    path.includes("team=R%27D")
      ? { status: 200, body: { route_policy: "1", key_policy: "zdr" } }
      : headers.authorization === "Bearer k2"
        ? { status: 200, body: { route_policy: "1", key_policy: "notrain" } }
        : { status: 200, body: { route_policy: "1" } };
  gateway.replies.models = (_headers, path) => ({ status: 200, body: listOf(path.includes("team=") ? "team" : "plain") });
  elsewhere.requests.length = 0;
  elsewhere.replies.detection = { status: 200, body: { route_policy: "1" } };
  elsewhere.replies.models = { status: 200, body: listOf("other") };
}

test("C14: whatever was read before for other places, credentials, and models, each request gets the decision it gets in a fresh client that read only its own place, and each model is judged by its own routes there", async (t) => {
  const written = placeOf(`${gateway.base}?team=R'D`);
  assert.ok(written !== null && written.unexact !== null);
  // Each place with what an independent reading of the spec says of it: its catalog and its key's own policy.
  const places: { at: Located; catalog: Catalog; keyPolicy: string | null }[] = [
    { at: { target: target("k1"), unexact: null }, catalog: "plain", keyPolicy: null },
    { at: { target: { ...written.place, context: bearer("k1") }, unexact: null }, catalog: "team", keyPolicy: "zdr" },
    { at: { target: { ...written.place, context: bearer("k1") }, unexact: written.unexact }, catalog: "team", keyPolicy: null },
    { at: { target: { ...written.place, context: bearer("k2") }, unexact: null }, catalog: "team", keyPolicy: "zdr" },
    { at: { target: target("k2"), unexact: null }, catalog: "plain", keyPolicy: "notrain" },
    { at: { target: target("k1", elsewhere.base), unexact: null }, catalog: "other", keyPolicy: null },
  ];
  const policies = [null, "zdr", "sort=price", "only=aurora", "notrain"];
  const models = ["alfa", "bravo", "charlie"].flatMap((id) => [id, `${id}+zdr`, `${id}+sort=latency`]);
  const requirements = (policy: string | null): string[] => (policy === null ? [] : policy.split("+").filter((part) => part === "zdr" || part === "notrain" || part.startsWith("only=")));
  const meets = (provider: string, required: readonly string[]): boolean =>
    required.every((r) => (r.startsWith("only=") ? r.slice(5).split(",").includes(provider) : (FACTS[provider] ?? []).includes(r)));
  // What the generator produced, per dimension, resolved: each must take at least two values, or the title's
  // "other places, credentials, and models" would not be exercised.
  const seen = { inexactAfterEncoded: new Set<string>(), origin: new Set<string>(), place: new Set<string>(), credential: new Set<string>(), model: new Set<string>(), suffix: new Set<string>(), policy: new Set<string>(), outcome: new Set<string>(), routesChecked: new Set<string>() };
  for (const seed of [1, 7, 42, 99]) {
    reset();
    placesWithCatalogs();
    // A small deterministic generator: the interleaving is random but the same on every run.
    let state = seed;
    const pick = <T,>(items: readonly T[]): T => {
      state = (state * 1103515245 + 12345) % 2147483648;
      const item = items[state % items.length];
      assert.ok(item !== undefined);
      return item;
    };
    const steps: { place: number; policy: string | null; model: string }[] = [];
    // The places whose model list an earlier request read: a request with no policy is judged by it (C16).
    const listHeld = new Set<number>();
    const { client: warm } = client("zdr");
    // Fifty random steps, then a fixed ending that every seed shares: the encoded team place read with a policy,
    // then the same place as written, with none, which must hold nothing of it.
    const plan = Array.from({ length: 50 }, () => ({ place: pick(places.map((_, index) => index)), policy: pick(policies), model: pick(models) }));
    plan.push({ place: 1, policy: "zdr", model: "alfa" }, { place: 2, policy: null, model: "alfa" });
    for (const [i, step] of plan.entries()) {
      steps.push(step);
      const place = places[step.place];
      assert.ok(place !== undefined);
      const decideIn = async (c: RouteClient, s: typeof step): Promise<Decision> => {
        c.held = s.policy === null ? { kind: "none" } : holdPolicy(s.policy, "session");
        const at = places[s.place]?.at;
        assert.ok(at !== undefined);
        return (await c.decide(at, s.model, null)).decision;
      };
      const decision = await decideIn(warm, step);
      const label = `seed ${seed}, step ${i}: ${JSON.stringify(step)}`;
      // The expected decision, from the replies and the spec alone.
      const [base = "", typed = null] = step.model.split("+");
      const anyPolicy = step.policy !== null || typed !== null;
      const required = [...requirements(step.policy), ...requirements(typed)];
      let expected: string;
      if (place.at.unexact !== null) {
        expected = anyPolicy ? "block: not as written" : "send";
      } else {
        if (anyPolicy && (required.length > 0 || place.keyPolicy !== null)) listHeld.add(step.place);
        const all = [...required, ...requirements(place.keyPolicy)];
        const routes = CATALOGS[place.catalog][base] ?? [];
        expected = !listHeld.has(step.place) ? "send" : all.length > 0 && !routes.some((p) => meets(p, all)) ? "block: unmet" : "send with routes";
      }
      const got =
        decision.action === "block"
          ? /cannot be used exactly as written/.test(decision.reason)
            ? "block: not as written"
            : new RegExp(`no route the model list publishes for ${base} meets`).test(decision.reason)
              ? "block: unmet"
              : `block: ${decision.reason}`
          : decision.action === "send" && decision.routes !== null
            ? "send with routes"
            : decision.action;
      assert.equal(got, expected, label);
      // The reference: a fresh client that has seen only the earlier requests to this same place.
      const { client: fresh } = client("zdr");
      const own = place.at.unexact === null ? steps.slice(0, -1).filter((s) => s.place === step.place) : [];
      for (const earlier of own) await decideIn(fresh, earlier);
      assert.equal(view(decision), view(await decideIn(fresh, step)), label);
      // And judged by its own model's routes in its own place's catalog, never another model's.
      if (decision.action === "send" && decision.routes !== null) {
        assert.deepEqual([...decision.routes.keys()], CATALOGS[place.catalog][base], label);
        seen.routesChecked.add(base);
      }
      seen.origin.add(new URL(place.at.target.base).origin);
      seen.place.add(`${place.at.target.base}${place.at.target.query}|${place.at.unexact === null ? "as written" : "not as written"}`);
      seen.credential.add(place.at.target.context.map(([, value]) => value).join());
      seen.model.add(base);
      seen.suffix.add(typed ?? "none");
      seen.policy.add(String(step.policy));
      seen.outcome.add(got);
      if (place.at.unexact !== null && !anyPolicy && listHeld.has(1)) seen.inexactAfterEncoded.add("probed");
    }
  }
  for (const [dimension, values] of Object.entries(seen)) {
    t.diagnostic(`${dimension}: ${[...values].join(" / ")}`);
    assert.ok(values.size >= (dimension === "inexactAfterEncoded" ? 1 : 2), `${dimension} takes ${values.size} value(s)`);
  }
  assert.deepEqual([seen.model.size, seen.routesChecked.size, seen.place.size, seen.origin.size, seen.outcome.size], [3, 3, 4, 2, 4], "every model, place, origin, and kind of outcome");
});

test("C14, C15: a request the previous session released is still stopped when stale, but its stop is not shown in the next session", async () => {
  reset();
  const { client: c, reports } = client("zdr");
  const sendA = release(c, await decide(c, target()));
  const sendB = release(c, await decide(c, target(), "demo-model"));
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {} };
  await sendText(sendA);
  c.newSession();
  await assert.rejects(sendB(), /discarded before it left/);
  assert.deepEqual(reports.map((r) => r.kind), ["not-honored"], "the stop of B is not reported in the new session");
  assert.equal(c.lastReport, null);
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

  // A read that could not connect at all, once for each endpoint, then a reply: read again, and decided anew.
  reset();
  const failOnce = new Set(["/route-policy", "/models"]);
  const attempts: string[] = [];
  const flaky: Fetch = async (input, init) => {
    const path = new URL(input).pathname;
    const endpoint = path.slice(path.lastIndexOf("/"));
    attempts.push(endpoint);
    if (failOnce.delete(endpoint)) throw new TypeError("connection refused");
    return fetch(input, init);
  };
  const d = new RouteClient({ carriers: "header", env: { ROUTE_POLICY: "only=cobalt" }, fetch: flaky, onReport: () => {} });
  blockedFor((await decide(d, target())).decision, /detection could not be fetched: connection refused/);
  const noList = (await decide(d, target())).decision;
  assert.ok(noList.action === "send" && noList.routes === null, "detection read again; the list could not be, so none is held");
  blockedFor((await decide(d, target())).decision, /no route the model list publishes/);
  assert.deepEqual(attempts, ["/route-policy", "/route-policy", "/models", "/models"]);
});

test("C15: a new client, as in the next run, holds no detection reply or model list from the last", async () => {
  reset();
  // A key policy no route meets: whoever holds this reply and list blocks even a request with no policy.
  gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "only=nosuch" } };
  const { client: last } = client("zdr");
  blockedFor((await decide(last, target())).decision, /meets the policy combined with the key's own/);
  last.held = { kind: "none" };
  blockedFor((await decide(last, target())).decision, /meets the key's own policy/);
  // The next run's client, before it reads anything: a request with no policy goes, judged by nothing held.
  const { client: next } = client("zdr");
  next.held = { kind: "none" };
  const reads = gateway.requests.length;
  assert.equal(view((await decide(next, target())).decision), view({ action: "send", model: "demo-model", header: null, sent: null, routes: null }));
  assert.equal(gateway.requests.length, reads);
  next.held = holdPolicy("zdr", "session");
  await decide(next, target());
  assert.deepEqual([detectionRequests(), listRequests()], [2, 2], "and it reads both for itself");
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
  assert.equal((await decide(c, { ...placed(), base: elsewhere.base })).decision.action, "send", "another base URL with the same key holds nothing either");
  // A bound policy a published route meets: the held list is used, and lets the request go.
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "only=aurora" } };
  const { client: d } = client("zdr");
  await decide(d, placed());
  d.held = { kind: "none" };
  const met = (await decide(d, placed())).decision;
  assert.ok(met.action === "send" && met.routes !== null && [...met.routes.keys()].join() === "aurora", view(met));
});

test("C8: the response to a translated request is reported unconfirmed, with or without route headers, and a refusal as a refusal", async () => {
  reset();
  const { client: c, reports } = client("only=aurora");
  const policy = c.held.kind === "policy" ? c.held.policy : assert.fail("held");
  const translated = (): Prepared => ({ decision: { action: "translate", model: "vendor/model", provider: { only: ["aurora"] }, sent: policy }, target: target(), unexact: null, generation: 0 });
  gateway.replies.inference = { status: 200, body: {} };
  await sendText(release(c, translated()));
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=aurora" }, body: {} };
  await sendText(release(c, translated()));
  for (const headers of [{ "route-evidence": "https://basalt.example/attestation" }, { "route-applied": ["provider=aurora", "provider=basalt"] }, { "route-applied": "aurora" }]) {
    gateway.replies.inference = { status: 200, headers, body: {} };
    await sendText(release(c, translated()));
  }
  gateway.replies.inference = { status: 503, headers: { "route-refused": "reason=unavailable" }, body: {} };
  await sendText(release(c, translated()));
  assert.deepEqual(reports, [...Array.from({ length: 5 }, () => ({ kind: "unconfirmed" })), { kind: "refused", reason: "unavailable", key: null }]);
});

const at = (t: Target): Located => ({ target: t, unexact: null });
const c0 = (): RouteClient => client("zdr").client;

test("C13, C12: /route shows the key's own policy as locked, and one the client cannot interpret as text only", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "zdr+region=us" } };
  assert.match(await client().client.describe(at(target())), /Key policy \(locked, applied by the gateway to every request with this key\): zdr\+region=us/);
  gateway.replies.detection = { status: 200, body: { route_policy: "1", keys: ["zdr", "residency"], key_policy: "zdr+residency=eu" } };
  const text = await client().client.describe(at(target()));
  assert.match(text, /Key policy \(locked\): "zdr\+residency=eu", which this client cannot interpret; shown as text and relied on for nothing/);
  assert.match(text, /^Route policy: zdr \(from ROUTE_POLICY\)$/m);
  assert.match(text, /^Last result: none yet in this session$/m);
  // Relied on for nothing: its zdr, which aurora does not meet, would block notrain if any part of it counted.
  gateway.replies.detection = { status: 200, body: { route_policy: "1", keys: ["zdr", "notrain", "residency"], key_policy: "zdr+residency=eu" } };
  gateway.replies.models = { status: 200, body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "notrain" }] }] } };
  const relied = (await decide(client("notrain").client, target())).decision;
  assert.ok(relied.action === "send" && relied.routes !== null, view(relied));
});

test("C1: /route shows when a base URL has no detection, and why", async () => {
  const cases: [string, () => void, Target, string][] = [
    ["404", () => (gateway.replies.detection = { status: 404 }), target(), "detection reply is not valid: status is 404, not 200"],
    ["not JSON", () => (gateway.replies.detection = { status: 200, raw: "{" }), target(), "detection reply is not valid: not a JSON object"],
    ["no connection", () => {}, target("k", "http://127.0.0.1:9/v1"), "detection could not be fetched: fetch failed"],
  ];
  for (const [name, arrange, place, why] of cases) {
    reset();
    arrange();
    const text = await client().client.describe(at(place));
    assert.match(text, new RegExp(`: no detection \\(${why.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)$`, "m"), name);
  }
});

test("C1, C14: /route says which place and credential its detection line is for, read for each the way a request's guard reads it", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", keys: ["zdr"] } };
  const { client: c } = client("zdr");
  // What a caller is told depends on who it is: a read without east's credentials gets nothing valid.
  gateway.replies.detection = (headers) => (headers.cookie === "who=east" && headers.authorization === "Bearer k" ? { status: 200, body: { route_policy: "1", keys: ["zdr"] } } : { status: 401 });
  const east = await c.describe(at({ base: gateway.base, query: "?tenant=east", context: [["authorization", "Bearer k"], ["cookie", "who=east"]] }));
  gateway.replies.detection = (headers) => (headers["x-api-key"] === "k2" ? { status: 200, body: { route_policy: "1", keys: ["zdr", "notrain"] } } : { status: 401 });
  const west = await c.describe(at({ base: gateway.base, query: "?tenant=west", context: [["x-api-key", "k2"]] }));
  assert.match(east, new RegExp(`^Gateway ${gateway.base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?tenant=east, read with the credential in authorization, cookie: detection valid; accepts zdr$`, "m"));
  assert.match(west, /\?tenant=west, read with the credential in x-api-key: detection valid; accepts zdr, notrain$/m);
  assert.doesNotMatch(east + west, /Bearer k|who=east|k2/, "header names only, never values");
  assert.deepEqual(
    gateway.requests.filter((r) => r.path.includes("/route-policy")).map((r) => [r.path.slice(r.path.indexOf("?")), r.headers.authorization, r.headers.cookie, r.headers["x-api-key"]]),
    [["?tenant=east", "Bearer k", "who=east", undefined], ["?tenant=west", undefined, undefined, "k2"]],
    "each read with exactly the credentials its line names",
  );
});

test("C1, C14: a block names the base URL with its query, the place whose detection it is about", async () => {
  reset();
  gateway.replies.detection = { status: 404 };
  blockedFor((await decide(c0(), placed())).decision, new RegExp(`^${gateway.base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?tenant=east has no valid detection reply`));
});

test("C9: /route mentions translation only for OpenRouter's base URL, which has no detection", async () => {
  reset();
  const notFound: Fetch = async () => new Response("", { status: 404 });
  const c = new RouteClient({ carriers: "header", env: { ROUTE_POLICY: "zdr" }, fetch: notFound, onReport: () => {} });
  const there = await c.describe(at({ base: OPENROUTER_BASE, query: "", context: bearer("k") }));
  assert.match(there, /: no detection \(detection reply is not valid: status is 404, not 200\); policies are translated into OpenRouter's own fields where it has a filter for them$/m);
  gateway.replies.detection = { status: 404 };
  assert.doesNotMatch(await client().client.describe(at(target())), /OpenRouter/);
  // OpenRouter's base URL with a valid detection reply is spoken to in this protocol: nothing is translated.
  const valid: Fetch = async () => new Response(JSON.stringify({ route_policy: "1" }), { status: 200 });
  const d = new RouteClient({ carriers: "header", env: { ROUTE_POLICY: "zdr" }, fetch: valid, onReport: () => {} });
  const answered = await d.describe(at({ base: OPENROUTER_BASE, query: "", context: bearer("k") }));
  assert.match(answered, /: detection valid; accepts /);
  assert.doesNotMatch(answered, /translated/);
});

test("C6: /route says a key's own policy is none only for a request with a credential; without one it is unknown", async () => {
  reset();
  const { client: c } = client("zdr");
  assert.match(await c.describe(at(target())), /^Key policy: none$/m);
  const anonymous = await c.describe(at(target(null)));
  assert.match(anonymous, /^Key policy: unknown, the request carries no credential$/m);
  assert.match(anonymous, /read without a credential: detection valid/);
  assert.doesNotMatch(anonymous, /^Key policy: none$/m);
  for (const reply of [{ status: 404 }, { status: 200, raw: "{" }]) {
    gateway.replies.detection = reply;
    const failed = await client().client.describe(at(target(null)));
    assert.match(failed, /read without a credential: no detection/);
    assert.doesNotMatch(failed, /Key policy/, "nothing claims there is no key policy, or any");
  }
});

test("C14: /route reads nothing for a base URL that cannot be used as written, or for no place at all, and says why", async () => {
  reset();
  // Every fetch the client attempts is recorded, wherever it goes and whether or not it could connect.
  const attempted: string[] = [];
  const spy: Fetch = async (input, init) => {
    attempted.push(input);
    return fetch(input, init);
  };
  const c = new RouteClient({ carriers: "header", env: { ROUTE_POLICY: "zdr" }, fetch: spy, onReport: () => {} });
  const inexact = await c.describe({ target: target(), unexact: "the base URL cannot be used exactly as written: its query would be sent otherwise" });
  assert.match(inexact, /: no detection \(the base URL cannot be used exactly as written: its query would be sent otherwise\)$/m);
  assert.doesNotMatch(inexact, /detection valid|Key policy/);
  const nowhere = await c.describe({ why: "the harness did not say which model and base URL the request is for" });
  assert.match(nowhere, /^Gateway: unknown, nothing was read \(the harness did not say which model and base URL the request is for\)$/m);
  assert.deepEqual([attempted, gateway.requests.length], [[], 0], "nothing was attempted for either");
});

test("C14: /route after a not-honored result reads detection again, and shows what the gateway says now, not the discarded reply", async () => {
  reset();
  const { client: c } = client("zdr");
  assert.match(await c.describe(at(target())), /detection valid; accepts zdr, notrain, bits, region, attest, only, ignore, sort, order$/m);
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {} };
  await sendText(release(c, await decide(c, target())));
  gateway.replies.detection = { status: 404 };
  const after = await c.describe(at(target()));
  assert.match(after, /no detection \(detection reply is not valid: status is 404, not 200\)/);
  assert.doesNotMatch(after, /detection valid/);
  // A valid reply that changed is shown as it is now, not as it was.
  gateway.replies.detection = { status: 200, body: { route_policy: "1", keys: ["zdr"] } };
  assert.match(await c.describe(at(target())), /detection valid; accepts zdr$/m);
});

test("C3, C5: /route's last result names the request it was for: its model and base URL", async () => {
  reset();
  gateway.replies.models = {
    status: 200,
    body: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr" }] }, { id: "other-model", routes: [{ provider: "aurora", facts: "zdr" }] }] },
  };
  const { client: c } = client("zdr");
  await sendText(release(c, await decide(c, target(), "demo-model")));
  // The second request goes to another origin as well as another model and query.
  elsewhere.replies.detection = { status: 200, body: { route_policy: "1" } };
  elsewhere.replies.models = gateway.replies.models;
  elsewhere.replies.inference = { status: 400, headers: { "route-refused": "reason=unsatisfiable" }, body: {} };
  await sendText(release(c, await decide(c, placed("k", elsewhere.base), "other-model")));
  const text = await c.describe(at(target()));
  assert.match(text, new RegExp(`^Last result \\(request for other-model to ${elsewhere.base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?tenant=east\\): route policy refused by the gateway: unsatisfiable$`, "m"));
});
