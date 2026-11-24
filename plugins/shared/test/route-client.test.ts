// Each test is one situation of the route client against a fake gateway on real HTTP, and one thing observed of
// it, compared whole: a decision, the reads and POSTs the gateway received, the reports, or the /route text.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { formatPolicy, parsePublishedFacts, type Policy } from "../../../core/src/index.ts";
import type { Decision } from "../src/decide.ts";
import { addWatcher, withdrawReleases } from "../src/fetch-gate.ts";
import type { Fetch, Target } from "../src/gateway-client.ts";
import { holdPolicy } from "../src/held.ts";
import { OPENROUTER_BASE } from "../src/openrouter.ts";
import type { Report } from "../src/outcome.ts";
import { CREDENTIAL_HEADERS, placeOf, type RequestContext } from "../src/request.ts";
import { RouteClient, type Located, type Prepared } from "../src/route-client.ts";
import { fakeGateway, type FakeGateway, type Reply } from "./fixtures.ts";

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

function client(policy: string | null = "zdr", timeoutMs = 2000, fetchImpl?: Fetch): { client: RouteClient; reports: Report[] } {
  const reports: Report[] = [];
  const c = new RouteClient({ carriers: "header", env: policy === null ? {} : { ROUTE_POLICY: policy }, timeoutMs, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }), onReport: (r) => reports.push(r) });
  watching.push(addWatcher({ check: (outgoing) => c.check(outgoing), stopped: (reason) => c.blocked(reason) }));
  return { client: c, reports };
}

const bearer = (key: string): RequestContext => [["authorization", `Bearer ${key}`]];
const target = (key: string | null = "k", base = gateway.base, query = ""): Target => ({ base, query, context: key === null ? [] : bearer(key) });
const at = (t: Target): Located => ({ target: t, unexact: null });
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const list = (...routes: [string, string][]): Reply => ({ status: 200, body: { data: [{ id: "demo-model", routes: routes.map(([provider, facts]) => ({ provider, facts })) }] } });
const models = (byModel: Record<string, [string, string][]>): Reply => ({
  status: 200,
  body: { data: Object.entries(byModel).map(([id, routes]) => ({ id, routes: routes.map(([provider, facts]) => ({ provider, facts })) })) },
});

function reset(): void {
  for (const stop of watching.splice(0)) stop();
  for (const g of [gateway, elsewhere]) {
    g.requests.length = 0;
    g.replies.detection = { status: 200, body: { route_policy: "1" } };
    g.replies.models = list(["aurora", "zdr"]);
    g.replies.inference = { status: 200, headers: { "route-applied": "provider=aurora" }, body: {} };
  }
}

/** The reads and POSTs a gateway received, as "METHOD /endpoint?query bearer". */
const wire = (g: FakeGateway = gateway): string[] => g.requests.map((r) => `${r.method} ${r.path.replace(/^\/v\d*/, "")} ${String(r.headers.authorization ?? "-")}`);

const decide = (c: RouteClient, t: Target, model = "demo-model"): Promise<Prepared> => c.decide(at(t), model, null);

/** A decision as plain data: policies as their text, routes as their providers and facts' text. */
function view(decision: Decision): unknown {
  const text = (p: Policy | null): string | null => (p === null ? null : formatPolicy(p).ok ? (formatPolicy(p) as { value: string }).value : "unwritable");
  if (decision.action === "block") return decision;
  if (decision.action === "translate") return { action: "translate", model: decision.model, provider: decision.provider, sent: text(decision.sent) };
  return { action: "send", model: decision.model, header: decision.header, sent: text(decision.sent), routes: decision.routes === null ? null : [...decision.routes.keys()] };
}
const sendView = (model: string, header: string | null, sent: string | null, routes: string[] | null = null): unknown => ({ action: "send", model, header, sent, routes });
const blockView = (reason: string): unknown => ({ action: "block", reason });

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
/** Waits until `done` holds, for at most two seconds: a condition on the real gateway, not a guessed delay. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((wake) => setTimeout(wake, 5));
  assert.ok(done(), "timed out waiting");
}
const ROUTE_ERR = /not one the plugin released/;

// ---- C6: what a detection reply is.
test("C6: with the detection reply {route_policy: \"1\"}, held zdr is sent with header zdr and the routes of the list", async () => {
  reset();
  assert.deepEqual(view((await decide(client("zdr").client, target())).decision), sendView("demo-model", "zdr", "zdr", ["aurora"]));
});

for (const [name, reply, reason] of [
  ["status 404", { status: 404, body: { route_policy: "1" } }, "detection reply is not valid: status is 404, not 200"],
  ["status 500", { status: 500, body: { route_policy: "1" } }, "detection reply is not valid: status is 500, not 200"],
  ["route_policy 1 as a number", { status: 200, body: { route_policy: 1 } }, 'detection reply is not valid: route_policy is not the string "1"'],
  ["no route_policy", { status: 200, body: { keys: ["zdr"] } }, 'detection reply is not valid: route_policy is not the string "1"'],
  ["route_policy \"2\"", { status: 200, body: { route_policy: "2" } }, 'detection reply is not valid: route_policy is not the string "1"'],
  ["an empty body", { status: 200 }, "detection reply is not valid: not a JSON object"],
  ["an array body", { status: 200, body: [{ route_policy: "1" }] }, "detection reply is not valid: not a JSON object"],
  ["a string body", { status: 200, body: "route_policy" }, "detection reply is not valid: not a JSON object"],
  ["a null body", { status: 200, body: null }, "detection reply is not valid: not a JSON object"],
  ["the text {route_policy", { status: 200, raw: "{route_policy" }, "detection reply is not valid: not a JSON object"],
  ["keys \"zdr\"", { status: 200, body: { route_policy: "1", keys: "zdr" } }, "detection reply is not valid: keys is not a list of keys"],
  ["keys [\"zdr\", 7]", { status: 200, body: { route_policy: "1", keys: ["zdr", 7] } }, "detection reply is not valid: keys is not a list of keys"],
  ["attest \"weights\"", { status: 200, body: { route_policy: "1", attest: "weights" } }, "detection reply is not valid: attest is not a list of items"],
  ["attest [\"weights\", \"Bad!\"]", { status: 200, body: { route_policy: "1", attest: ["weights", "Bad!"] } }, "detection reply is not valid: attest is not a list of items"],
  ["sort \"price\"", { status: 200, body: { route_policy: "1", sort: "price" } }, "detection reply is not valid: sort is not a list of items"],
  ["key_policy 7", { status: 200, body: { route_policy: "1", key_policy: 7 } }, "detection reply is not valid: key_policy is not a string"],
] as const) {
  test(`C6: with a detection reply of ${name}, held zdr is blocked: ${reason}`, async () => {
    reset();
    gateway.replies.detection = reply;
    assert.deepEqual(view((await decide(client("zdr").client, target())).decision), blockView(`${gateway.base} has no valid detection reply (${reason}), so no requirement may be sent there`));
  });
}

test("C6: with a detection reply whose key_policy is zdr+zdr, held zdr is blocked: the key policy fails the order of checks", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "zdr+zdr" } };
  const { decision } = await decide(client("zdr").client, target());
  assert.ok(decision.action === "block");
  assert.match(decision.reason, new RegExp(`^${escaped(gateway.base)} has no valid detection reply \\(detection reply is not valid: key_policy fails the order of checks under the reply's lists: .*\\), so no requirement may be sent there$`));
});

for (const [name, body] of [
  ['keys ["zdr", "future"]', { route_policy: "1", keys: ["zdr", "future"] }],
  ['attest ["weights", "prompt", "future"]', { route_policy: "1", attest: ["weights", "prompt", "future"] }],
  ['sort ["price", "future"]', { route_policy: "1", sort: ["price", "future"] }],
  ["an unknown member later: {x: 1}", { route_policy: "1", later: { x: 1 } }],
] as const) {
  test(`C6: with a detection reply carrying ${name}, held zdr is sent with header zdr`, async () => {
    reset();
    gateway.replies.detection = { status: 200, body };
    assert.deepEqual(view((await decide(client("zdr").client, target())).decision), sendView("demo-model", "zdr", "zdr", ["aurora"]));
  });
}

test("C6: when the detection fetch rejects with connection refused, held zdr is blocked: detection could not be fetched", async () => {
  reset();
  const refused: Fetch = async () => {
    throw new TypeError("connection refused");
  };
  assert.deepEqual(view((await decide(client("zdr", 2000, refused).client, target())).decision), blockView(`${gateway.base} has no valid detection reply (detection could not be fetched: connection refused), so no requirement may be sent there`));
});

test("C6: when the detection reply takes 300 ms and the client waits 50 ms, held zdr is blocked: detection could not be fetched", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1" }, delayMs: 300 };
  const { decision } = await decide(client("zdr", 50).client, target("abandoned"));
  assert.ok(decision.action === "block");
  assert.match(decision.reason, /has no valid detection reply \(detection could not be fetched: .*\), so no requirement may be sent there$/);
});

test("C6: at http://127.0.0.1:9/v1, where nothing listens, held zdr is blocked: detection could not be fetched", async () => {
  reset();
  assert.deepEqual(view((await decide(client("zdr").client, target("k", "http://127.0.0.1:9/v1"))).decision), blockView("http://127.0.0.1:9/v1 has no valid detection reply (detection could not be fetched: fetch failed), so no requirement may be sent there"));
});

test("C6, C14: with a detection reply 302 to another origin's valid reply, held zdr is blocked: status is 302", async () => {
  reset();
  gateway.replies.detection = { status: 302, headers: { location: `${elsewhere.base}/route-policy` } };
  assert.deepEqual(view((await decide(client("zdr").client, target())).decision), blockView(`${gateway.base} has no valid detection reply (detection reply is not valid: status is 302, not 200), so no requirement may be sent there`));
});

test("C6, C14: with a detection reply 302 to another origin, the other origin receives nothing", async () => {
  reset();
  gateway.replies.detection = { status: 302, headers: { location: `${elsewhere.base}/route-policy` } };
  await decide(client("zdr").client, target());
  assert.deepEqual(elsewhere.requests, []);
});

test("C6, C14: with a model list reply 307 to another origin's list, held only=nosuch is sent holding no list", async () => {
  reset();
  gateway.replies.models = { status: 307, headers: { location: `${elsewhere.base}/models` } };
  elsewhere.replies.models = list(["aurora", ""]);
  assert.deepEqual(view((await decide(client("only=nosuch").client, target())).decision), sendView("demo-model", "only=nosuch", "only=nosuch"));
});

test("C6, C14: with a model list reply 307 to another origin, the other origin receives nothing", async () => {
  reset();
  gateway.replies.models = { status: 307, headers: { location: `${elsewhere.base}/models` } };
  await decide(client("only=nosuch").client, target());
  assert.deepEqual(elsewhere.requests, []);
});

// ---- C6: credentials and key_policy.
const KEYED = { status: 200, body: { route_policy: "1", key_policy: "zdr" } };
const WITHOUT_CREDENTIALS = "detection reply is not valid: key_policy is present in a reply to a request without credentials";
for (const [name, context] of [
  ["no headers", []],
  ["a traceparent header alone", [["traceparent", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"]]],
  ["an x-tenant-token header alone", [["x-tenant-token", "t"]]],
  ['authorization ""', [["authorization", ""]]],
  ['authorization "   "', [["authorization", "   "]]],
  ['x-api-key "  "', [["x-api-key", "  "]]],
] as const) {
  test(`C6: a detection reply with key_policy zdr, read with ${name}, blocks held zdr: no credentials were sent`, async () => {
    reset();
    gateway.replies.detection = KEYED;
    const t: Target = { base: gateway.base, query: "", context: context.map(([n, v]) => [n, v] as const) };
    assert.deepEqual(view((await decide(client("zdr").client, t)).decision), blockView(`${gateway.base} has no valid detection reply (${WITHOUT_CREDENTIALS}), so no requirement may be sent there`));
  });
}

test(`C6: for each of the ${CREDENTIAL_HEADERS.length} names in CREDENTIAL_HEADERS, a detection reply with key_policy zdr read with only that header "secret" sends held zdr, both reads carrying it`, async () => {
  assert.ok(CREDENTIAL_HEADERS.length > 0);
  for (const name of CREDENTIAL_HEADERS) {
    reset();
    gateway.replies.detection = KEYED;
    const { decision } = await decide(client("zdr").client, { base: gateway.base, query: "", context: [[name, "secret"]] });
    assert.deepEqual(view(decision), sendView("demo-model", "zdr", "zdr", ["aurora"]), name);
    assert.deepEqual(gateway.requests.map((r) => [r.path.slice(r.path.lastIndexOf("/")), r.headers[name]]), [["/route-policy", "secret"], ["/models", "secret"]], name);
  }
});

// ---- C14: one place, one cache.
test("C14: two decisions for k1 at one base URL read detection and the model list once", async () => {
  reset();
  const { client: c } = client("zdr");
  await decide(c, target("k1"));
  await decide(c, target("k1"));
  assert.deepEqual(wire(), [`GET /route-policy Bearer k1`, `GET /models Bearer k1`]);
});

test("C14: a decision for k2 after one for k1 at the same base URL reads both again with k2", async () => {
  reset();
  const { client: c } = client("zdr");
  await decide(c, target("k1"));
  await decide(c, target("k2"));
  assert.deepEqual(wire(), ["GET /route-policy Bearer k1", "GET /models Bearer k1", "GET /route-policy Bearer k2", "GET /models Bearer k2"]);
});

test("C14: a decision at the base URL with a trailing slash after one without reads nothing again", async () => {
  reset();
  const { client: c } = client("zdr");
  await decide(c, target("k"));
  await decide(c, target("k", `${gateway.base}/`));
  assert.deepEqual(wire(), ["GET /route-policy Bearer k", "GET /models Bearer k"]);
});

test("C4, C14: held only=aurora at two ports, the second's list publishing cobalt only, is blocked at the second after being sent at the first", async () => {
  reset();
  elsewhere.replies.models = list(["cobalt", "zdr"]);
  const { client: c } = client("only=aurora");
  await decide(c, target("k"));
  assert.deepEqual(view((await decide(c, target("k", elsewhere.base))).decision), blockView(`no route the model list publishes for demo-model meets the policy, so the gateway would refuse it only after receiving the content`));
});

test("C4, C14: held only=aurora at the first port is sent again after the second port's list, which publishes cobalt only, was read", async () => {
  reset();
  elsewhere.replies.models = list(["cobalt", "zdr"]);
  const { client: c } = client("only=aurora");
  await decide(c, target("k"));
  await decide(c, target("k", elsewhere.base));
  assert.deepEqual(wire(elsewhere), ["GET /route-policy Bearer k", "GET /models Bearer k"], "the second port's list was read");
  assert.deepEqual(view((await decide(c, target("k"))).decision), sendView("demo-model", "only=aurora", "only=aurora", ["aurora"]));
});

const SAME_ORIGIN = (): string => `${new URL(gateway.base).origin}/v2`;
test("C4, C14: held only=aurora at /v2 on the same origin as /v1, /v2's list publishing cobalt only, is blocked at /v2 after being sent at /v1", async () => {
  reset();
  gateway.replies.models = (_headers, path) => (path.startsWith("/v2") ? list(["cobalt", "zdr"]) : list(["aurora", "zdr"]));
  const { client: c } = client("only=aurora");
  assert.deepEqual(view((await decide(c, target("k"))).decision), sendView("demo-model", "only=aurora", "only=aurora", ["aurora"]));
  assert.deepEqual(view((await decide(c, target("k", SAME_ORIGIN()))).decision), blockView("no route the model list publishes for demo-model meets the policy, so the gateway would refuse it only after receiving the content"));
});

test("C6, C14: held zdr at /v2 on the same origin as /v1, /v2's detection reply being 404, is blocked at /v2 after being sent at /v1", async () => {
  reset();
  gateway.replies.detection = (_headers, path) => (path.startsWith("/v2") ? { status: 404 } : { status: 200, body: { route_policy: "1" } });
  const { client: c } = client("zdr");
  await decide(c, target("k"));
  assert.deepEqual(view((await decide(c, target("k", SAME_ORIGIN()))).decision), blockView(`${SAME_ORIGIN()} has no valid detection reply (detection reply is not valid: status is 404, not 200), so no requirement may be sent there`));
});

// ---- C1, C14: the whole context.
const cookieCatalog = (headers: Record<string, unknown>): Reply => list([headers.cookie === "who=east" ? "aurora" : "cobalt", ""]);
const tokenCatalog = (headers: Record<string, unknown>): Reply => list([headers["x-tenant-token"] === "t1" ? "aurora" : "cobalt", ""]);
const withCookie = (cookie: string): Target => ({ base: gateway.base, query: "", context: [["authorization", "Bearer a"], ["cookie", cookie]] });
const withToken = (token: string): Target => ({ base: gateway.base, query: "", context: [["authorization", "Bearer a"], ["cookie", "who=east"], ["x-tenant-token", token]] });

test("C1, C14: held only=aurora with bearer a and cookie who=west, whose catalog publishes cobalt only, is blocked after the same with cookie who=east was sent", async () => {
  reset();
  gateway.replies.models = (headers) => cookieCatalog(headers);
  const { client: c } = client("only=aurora");
  assert.deepEqual(view((await decide(c, withCookie("who=east"))).decision), sendView("demo-model", "only=aurora", "only=aurora", ["aurora"]));
  assert.deepEqual(view((await decide(c, withCookie("who=west"))).decision), blockView("no route the model list publishes for demo-model meets the policy, so the gateway would refuse it only after receiving the content"));
});

test("C1, C14: decisions with cookie who=east then who=west read detection and the list once each with that cookie and bearer a", async () => {
  reset();
  gateway.replies.models = (headers) => cookieCatalog(headers);
  const { client: c } = client("only=aurora");
  await decide(c, withCookie("who=east"));
  await decide(c, withCookie("who=west"));
  assert.deepEqual(gateway.requests.map((r) => [r.path.slice(r.path.lastIndexOf("/")), r.headers.authorization, r.headers.cookie]), [
    ["/route-policy", "Bearer a", "who=east"],
    ["/models", "Bearer a", "who=east"],
    ["/route-policy", "Bearer a", "who=west"],
    ["/models", "Bearer a", "who=west"],
  ]);
});

test("C1, C14: held only=aurora with x-tenant-token t2, whose catalog publishes cobalt only, is blocked after the same with t1 was sent", async () => {
  reset();
  gateway.replies.models = (headers) => tokenCatalog(headers);
  const { client: c } = client("only=aurora");
  assert.deepEqual(view((await decide(c, withToken("t1"))).decision), sendView("demo-model", "only=aurora", "only=aurora", ["aurora"]));
  assert.deepEqual(view((await decide(c, withToken("t2"))).decision), blockView("no route the model list publishes for demo-model meets the policy, so the gateway would refuse it only after receiving the content"));
});

test("C1, C14: held zdr with x-tenant-token t2, whose detection reply is 401, is blocked after the same with t1 was sent", async () => {
  reset();
  gateway.replies.detection = (headers) => (headers["x-tenant-token"] === "t1" ? { status: 200, body: { route_policy: "1" } } : { status: 401 });
  const { client: c } = client("zdr");
  await decide(c, withToken("t1"));
  assert.deepEqual(view((await decide(c, withToken("t2"))).decision), blockView(`${gateway.base} has no valid detection reply (detection reply is not valid: status is 401, not 200), so no requirement may be sent there`));
});

test("C1, C14: decisions with x-tenant-token t1 then t2 read detection and the list once each with that token", async () => {
  reset();
  const { client: c } = client("zdr");
  await decide(c, withToken("t1"));
  await decide(c, withToken("t2"));
  assert.deepEqual(gateway.requests.map((r) => [r.path.slice(r.path.lastIndexOf("/")), r.headers["x-tenant-token"]]), [["/route-policy", "t1"], ["/models", "t1"], ["/route-policy", "t2"], ["/models", "t2"]]);
});

// ---- C1, C14: the query.
const tenantCatalog = (path: string): Reply => list([path.includes("tenant=east") ? "aurora" : "cobalt", ""]);
for (const query of ["?tenant=west", ""]) {
  test(`C1, C14: held only=aurora with query ${JSON.stringify(query)}, whose catalog publishes cobalt only, is blocked after the same with ?tenant=east was sent`, async () => {
    reset();
    gateway.replies.models = (_headers, path) => tenantCatalog(path);
    const { client: c } = client("only=aurora");
    assert.deepEqual(view((await decide(c, target("k", gateway.base, "?tenant=east"))).decision), sendView("demo-model", "only=aurora", "only=aurora", ["aurora"]));
    assert.deepEqual(view((await decide(c, target("k", gateway.base, query))).decision), blockView("no route the model list publishes for demo-model meets the policy, so the gateway would refuse it only after receiving the content"));
  });
}

test("C1, C14: decisions with ?tenant=east, ?tenant=west, no query, and ?tenant=east again read each place's detection and list once, with its query", async () => {
  reset();
  const { client: c } = client("zdr");
  for (const query of ["?tenant=east", "?tenant=west", "", "?tenant=east"]) await decide(c, target("k", gateway.base, query));
  assert.deepEqual(wire(), ["?tenant=east", "?tenant=west", ""].flatMap((q) => [`GET /route-policy${q} Bearer k`, `GET /models${q} Bearer k`]));
});

const THREE = ["", "?", "?t=1"];
test('C1, C14: requests released for no query, "?", and "?t=1", then sent, make the gateway requests for each with exactly its own request target', async () => {
  reset();
  const { client: c } = client("zdr");
  const sends: (() => Promise<Response>)[] = [];
  for (const query of THREE) sends.push(release(c, await decide(c, target("k", gateway.base, query))));
  for (const send of sends) await sendText(send);
  assert.deepEqual(wire(), [...THREE.flatMap((q) => [`GET /route-policy${q} Bearer k`, `GET /models${q} Bearer k`]), ...THREE.map((q) => `POST /chat/completions${q} Bearer k`)]);
});

for (const releasedFor of THREE) {
  for (const sentTo of THREE.filter((q) => q !== releasedFor)) {
    test(`C1, C14: a request released for query ${JSON.stringify(releasedFor)} and sent with query ${JSON.stringify(sentTo)} is stopped`, async () => {
      reset();
      const { client: c } = client("zdr");
      const prepared = await decide(c, target("k", gateway.base, releasedFor));
      assert.ok(prepared.decision.action === "send");
      const body = JSON.stringify({ model: "demo-model", messages: [] });
      c.release({ ...prepared, decision: prepared.decision }, "zdr", body);
      await assert.rejects(fetch(`${gateway.base}/chat/completions${sentTo}`, { method: "POST", headers: { authorization: "Bearer k", "route-policy": "zdr" }, body }), ROUTE_ERR);
      withdrawReleases(c);
      assert.deepEqual(gateway.inference(), []);
    });
  }
}

// ---- C1, C14: another context at fetch.
const CHECKED = "this request to {base} is not one the plugin released: its URL, headers (it carries {names} besides the usual ones), body, or Route-Policy header differs from what was checked, or it was already sent once";
for (const [name, headers, names] of [
  ["authorization Bearer demo-key-zdr instead of Bearer demo-key", { authorization: "Bearer demo-key-zdr" }, "authorization"],
  ["an added x-api-key", { authorization: "Bearer demo-key", "x-api-key": "demo-key-zdr" }, "authorization, x-api-key"],
  ["an added api-key", { authorization: "Bearer demo-key", "api-key": "demo-key-zdr" }, "api-key, authorization"],
  ["an added x-goog-api-key", { authorization: "Bearer demo-key", "x-goog-api-key": "demo-key-zdr" }, "authorization, x-goog-api-key"],
  ["an added cookie session=1", { authorization: "Bearer demo-key", cookie: "session=1" }, "authorization, cookie"],
  ["an added proxy-authorization", { authorization: "Bearer demo-key", "proxy-authorization": "Basic eA==" }, "authorization, proxy-authorization"],
  ["an added x-tenant-token", { authorization: "Bearer demo-key", "x-tenant-token": "t" }, "authorization, x-tenant-token"],
] as const) {
  const leave = async (c: RouteClient): Promise<void> => {
    release(c, await decide(c, target("demo-key")));
    const body = JSON.stringify({ model: "demo-model", messages: [] });
    await assert.rejects(fetch(`${gateway.base}/chat/completions`, { method: "POST", headers: { ...headers, "route-policy": "zdr" }, body }), ROUTE_ERR);
  };
  test(`C1, C14: a request checked for Bearer demo-key and leaving with ${name} is stopped`, async () => {
    reset();
    await leave(client("zdr").client);
    assert.deepEqual(gateway.inference(), []);
  });
  test(`C1, C14: a request checked for Bearer demo-key and leaving with ${name} is reported blocked: "${CHECKED.replace("{names}", names)}"`, async () => {
    reset();
    const { client: c, reports } = client("zdr");
    await leave(c);
    assert.deepEqual(reports, [{ kind: "blocked", reason: CHECKED.replace("{base}", gateway.base).replace("{names}", names) }]);
  });
}

for (const [name, headers] of [
  ["cookie who=west instead of who=east", { authorization: "Bearer k", cookie: "who=west" }],
  ["no cookie", { authorization: "Bearer k" }],
] as const) {
  test(`C1, C14: a request checked with cookie who=east and leaving with ${name} is stopped`, async () => {
    reset();
    const { client: c } = client("zdr");
    release(c, await decide(c, { base: gateway.base, query: "", context: [["authorization", "Bearer k"], ["cookie", "who=east"]] }));
    const body = JSON.stringify({ model: "demo-model", messages: [] });
    await assert.rejects(fetch(`${gateway.base}/chat/completions`, { method: "POST", headers: { ...headers, "route-policy": "zdr" }, body }), ROUTE_ERR);
    assert.deepEqual(gateway.inference(), []);
  });
}

// ---- C14: discarding after not honored.
const ONLY_COBALT = { status: 200, body: { route_policy: "1", key_policy: "only=cobalt" } };
const KEYED_LIST = models({ "demo-model": [["aurora", "zdr"], ["cobalt", "zdr"]], "other-model": [["aurora", "zdr"]] });
/** A decision for other-model with no policy: blocked while a reply with key policy only=cobalt is held for its place. */
async function probe(c: RouteClient, t: Target): Promise<unknown> {
  const held = c.held;
  c.held = { kind: "none" };
  const { decision } = await decide(c, t, "other-model");
  c.held = held;
  return view(decision);
}
const KEY_BLOCK = blockView("no route the model list publishes for other-model meets the key's own policy, so the gateway would refuse it only after receiving the content");
const east = (key: string): Target => target(key, gateway.base, "?tenant=east");

test("C14: after k1's request at ?tenant=east comes back not honored, a request with no policy there is judged without its detection reply", async () => {
  reset();
  for (const g of [gateway, elsewhere]) {
    g.replies.detection = ONLY_COBALT;
    g.replies.models = KEYED_LIST;
  }
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=basalt" }, body: {} };
  const { client: c } = client("zdr");
  const send = release(c, await decide(c, east("k1")));
  assert.deepEqual(await probe(c, east("k1")), KEY_BLOCK);
  await sendText(send);
  assert.deepEqual(await probe(c, east("k1")), sendView("other-model", null, null, ["aurora"]));
});

for (const [name, other] of [
  ["k2 at ?tenant=east", (): Target => east("k2")],
  ["k1 at ?tenant=west", (): Target => target("k1", gateway.base, "?tenant=west")],
  ["k1 at the other port", (): Target => target("k1", elsewhere.base)],
] as const) {
  test(`C14: after k1's request at ?tenant=east comes back not honored, ${name} keeps its detection reply, held and read`, async () => {
    reset();
    for (const g of [gateway, elsewhere]) {
      g.replies.detection = ONLY_COBALT;
      g.replies.models = KEYED_LIST;
    }
    gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=basalt" }, body: {} };
    const { client: c } = client("zdr");
    const send = release(c, await decide(c, east("k1")));
    await decide(c, other());
    await sendText(send);
    const reads = (g: FakeGateway): number => g.requests.filter((r) => r.path.includes("/route-policy")).length;
    const before = reads(gateway) + reads(elsewhere);
    assert.deepEqual(await probe(c, other()), KEY_BLOCK, "held");
    await decide(c, other());
    assert.equal(reads(gateway) + reads(elsewhere), before, "read: not read again");
  });
}

test("C14: with k1's request (leaving first, answered not honored after 200 ms) and k2's (leaving second, honored after 20 ms) both at the gateway before either is answered, the report kinds are [honored, not-honored]", async () => {
  reset();
  const { client: c, reports } = client("zdr");
  gateway.replies.inference = (request) =>
    request.headers.authorization === "Bearer k1"
      ? { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {}, delayMs: 200 }
      : { status: 200, headers: { "route-applied": "provider=aurora" }, body: {}, delayMs: 20 };
  const one = release(c, await decide(c, east("k1")));
  const two = release(c, await decide(c, east("k2")));
  const first = sendText(one);
  await until(() => gateway.inference().length === 1);
  const second = sendText(two);
  await until(() => gateway.inference().length === 2);
  assert.deepEqual([...reports], [], "both at the gateway, neither answered");
  await Promise.all([first, second]);
  assert.deepEqual(reports.map((r) => r.kind), ["honored", "not-honored"]);
});

test("C14: a request decided before its detection reply was discarded is not current", async () => {
  reset();
  const { client: c } = client("zdr");
  const sendA = release(c, await decide(c, target()));
  const prepared = await decide(c, target());
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {} };
  await sendText(sendA);
  assert.equal(c.isCurrent(prepared), false);
});

test("C14: a request decided before its detection reply was discarded is stopped at fetch as discarded", async () => {
  reset();
  const { client: c } = client("zdr");
  const sendA = release(c, await decide(c, target()));
  const sendB = release(c, await decide(c, target()));
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {} };
  await sendText(sendA);
  await assert.rejects(sendB(), /the detection reply this request was checked against was discarded before it left; send it again/);
  assert.equal(gateway.inference().length, 1);
});

/** Two identical requests released around a discard: the one decided before it, and the one decided after. */
async function aroundDiscard(): Promise<{ c: RouteClient; before: () => Promise<Response>; after: () => Promise<Response> }> {
  const { client: c } = client("zdr");
  const sendA = release(c, await decide(c, target()));
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {} };
  const before = release(c, await decide(c, target()));
  await sendText(sendA);
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=aurora" }, body: {} };
  return { c, before, after: release(c, await decide(c, target())) };
}

test("C1, C14: of two identical requests, the one decided before a discard is stopped at fetch", async () => {
  reset();
  const { c, before } = await aroundDiscard();
  await assert.rejects(before(), /discarded before it left/);
  // The release decided after the discard is not sent here; withdrawn, it cannot meet a later test's request.
  withdrawReleases(c);
});

test("C1, C14: of two identical requests, the one decided after a discard reaches the gateway once the first was stopped", async () => {
  reset();
  const { before, after } = await aroundDiscard();
  await assert.rejects(before());
  const posts = gateway.inference().length;
  await sendText(after);
  assert.equal(gateway.inference().length - posts, 1);
});

test("C1, C5: a second send of a released request with held zdr is stopped as already sent once", async () => {
  reset();
  const { client: c, reports } = client("zdr");
  const send = release(c, await decide(c, target()));
  await sendText(send);
  await assert.rejects(send(), ROUTE_ERR);
  assert.deepEqual([gateway.inference().length, reports.map((r) => r.kind)], [1, ["honored", "blocked"]]);
});

test("C14: a decision waiting 300 ms on a model list read, while a not-honored response discards its detection reply, is not current", async () => {
  reset();
  gateway.replies.models = { status: 500 };
  const { client: c } = client("zdr");
  const sendA = release(c, await decide(c, east("k")));
  gateway.replies.models = { ...list(["aurora", "zdr"]), delayMs: 300 };
  const deciding = decide(c, east("k"));
  gateway.replies.inference = { status: 200, body: {} };
  await sendText(sendA);
  assert.equal(c.isCurrent(await deciding), false);
});

test("C14: a decision waiting 400 ms on a detection read, while a second not-honored response discards the reply again, is not current", async () => {
  reset();
  const { client: c } = client("zdr");
  gateway.replies.models = models({ "demo-model": [["aurora", "zdr"]], "other-model": [["aurora", "zdr"]] });
  gateway.replies.inference = (request) => ({ status: 200, headers: { "route-applied": "provider=cobalt" }, body: {}, delayMs: request.body.includes("other-model") ? 200 : 10 });
  const first = release(c, await decide(c, target(), "demo-model"));
  const second = release(c, await decide(c, target(), "other-model"));
  const both = Promise.all([sendText(first), sendText(second)]);
  await until(() => c.lastReport !== null);
  gateway.replies.detection = { status: 200, body: { route_policy: "1" }, delayMs: 400 };
  const deciding = decide(c, target(), "demo-model");
  await both;
  assert.equal(c.isCurrent(await deciding), false);
});

// ---- C5, C4: responses read for their own request.
test("C5: requests for only=aurora, only=basalt (one session) and only=cobalt (another), leaving 30 ms apart, arrive in that order", async () => {
  reset();
  gateway.replies.models = list(["aurora", ""], ["basalt", ""], ["cobalt", ""]);
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
  const pending: Promise<void>[] = [];
  for (const send of [sendAurora, sendBasalt, sendCobalt]) {
    pending.push(sendText(send));
    await new Promise((wake) => setTimeout(wake, 30));
  }
  await Promise.all(pending);
  assert.deepEqual(gateway.inference().map((r) => r.headers["route-policy"]), ["only=aurora", "only=basalt", "only=cobalt"]);
});

test("C5: requests for only=aurora and only=basalt (one session) and only=cobalt (another), answered in reverse order, are each reported honored by their own provider to their own session", async () => {
  reset();
  gateway.replies.models = list(["aurora", ""], ["basalt", ""], ["cobalt", ""]);
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
  const pending: Promise<void>[] = [];
  for (const [name, send] of [["aurora", sendAurora], ["basalt", sendBasalt], ["cobalt", sendCobalt]] as const) {
    pending.push(track(name, send));
    await new Promise((wake) => setTimeout(wake, 30));
  }
  await Promise.all(pending);
  const seen = (reports: Report[]): string[] => reports.map((r) => (r.kind === "honored" ? `honored ${r.provider}` : r.kind));
  assert.deepEqual([finished, seen(first.reports), seen(second.reports)], [["cobalt", "basalt", "aurora"], ["honored basalt", "honored aurora"], ["honored cobalt"]]);
});

test('C4: with demo-model\'s request (aurora zdr, basalt without zdr; answered by basalt) and other-model\'s (basalt zdr; answered by basalt) both at the gateway before either is answered, the reports are [honored by basalt, not honored: route "basalt" does not meet the policy sent]', async () => {
  reset();
  // The same provider is published for both models, with opposite facts: each response must be read against its own.
  gateway.replies.models = models({ "demo-model": [["aurora", "zdr"], ["basalt", ""]], "other-model": [["basalt", "zdr"]] });
  gateway.replies.inference = (request) => ({ status: 200, headers: { "route-applied": "provider=basalt" }, body: {}, delayMs: request.body.includes('"demo-model"') ? 200 : 20 });
  const { client: c, reports } = client("zdr");
  const sendDemo = release(c, await decide(c, target(), "demo-model"));
  const sendOther = release(c, await decide(c, target(), "other-model"));
  const first = sendText(sendDemo);
  await until(() => gateway.inference().length === 1);
  const second = sendText(sendOther);
  await until(() => gateway.inference().length === 2);
  assert.deepEqual([...reports], []);
  await Promise.all([first, second]);
  assert.deepEqual(reports, [
    { kind: "honored", provider: "basalt", checked: true, evidence: null },
    { kind: "not-honored", why: 'route "basalt" does not meet the policy sent' },
  ]);
});

// ---- C1, C14, C5, C8: redirects.
const redirect = (status: number): string => `the gateway answered with a redirect (status ${status}), which the plugin does not follow with content`;
for (const status of [307, 308]) {
  test(`C1, C14: a released zdr request answered ${status} to another origin, with Route-Applied provider=aurora, is reported not honored`, async () => {
    reset();
    const { client: c, reports } = client("zdr");
    gateway.replies.inference = { status, headers: { location: `${elsewhere.base}/chat/completions`, "route-applied": "provider=aurora" } };
    await sendText(release(c, await decide(c, target())));
    assert.deepEqual(reports, [{ kind: "not-honored", why: redirect(status) }]);
  });
  test(`C1, C14: a released zdr request answered ${status} to another origin is not followed: the other origin receives nothing`, async () => {
    reset();
    const { client: c } = client("zdr");
    gateway.replies.inference = { status, headers: { location: `${elsewhere.base}/chat/completions` } };
    await sendText(release(c, await decide(c, target())));
    assert.deepEqual(elsewhere.requests, []);
  });
  test(`C1, C14: after a released zdr request is answered ${status}, the next decision reads detection again`, async () => {
    reset();
    const { client: c } = client("zdr");
    gateway.replies.inference = { status, headers: { location: `${elsewhere.base}/chat/completions` } };
    await sendText(release(c, await decide(c, target())));
    await decide(c, target());
    assert.deepEqual(wire().filter((w) => w.startsWith("GET /route-policy")), ["GET /route-policy Bearer k", "GET /route-policy Bearer k"]);
  });
}

for (const status of [302, 307, 308]) {
  for (const [kind, refusal, expected] of [
    ["translated", {}, { kind: "unconfirmed", note: redirect(status) }],
    ["translated", { "route-refused": "reason=unavailable" }, { kind: "refused", reason: "unavailable", key: null }],
    ["translated", { "route-refused": "reason=maybe" }, { kind: "refused", reason: null, key: null }],
    ["protocol", {}, { kind: "not-honored", why: redirect(status) }],
    ["protocol", { "route-refused": "reason=unavailable" }, { kind: "refused", reason: "unavailable", key: null }],
    ["protocol", { "route-refused": "reason=maybe" }, { kind: "refused", reason: null, key: null }],
  ] as const) {
    test(`C5, C8: a ${kind} request answered ${status} with ${JSON.stringify(refusal)} is reported ${JSON.stringify(expected)}`, async () => {
      reset();
      const { client: c, reports } = client("only=aurora");
      const policy = c.held.kind === "policy" ? c.held.policy : assert.fail("held");
      gateway.replies.inference = { status, headers: { location: `${elsewhere.base}/chat/completions`, ...refusal } };
      const prepared: Prepared = kind === "translated"
        ? { decision: { action: "translate", model: "vendor/model", provider: { only: ["aurora"] }, sent: policy }, target: target(), unexact: null, generation: 0 }
        : await decide(c, target());
      await sendText(release(c, prepared));
      assert.deepEqual(reports, [expected]);
    });
  }
}

// ---- C4, C16: what a model list reply is.
for (const [name, reply] of [
  ["an object without routes", { status: 200, body: { data: "none" } }],
  ["an array", { status: 200, body: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "" }] }] }],
  ['the string "aurora"', { status: 200, body: "aurora" }],
  ['the string ""', { status: 200, body: "" }],
  ["the number 7", { status: 200, body: 7 }],
  ["the number 0", { status: 200, body: 0 }],
  ["true", { status: 200, body: true }],
  ["false", { status: 200, body: false }],
  ["null", { status: 200, body: null }],
] as const) {
  test(`C4, C16: with a model list reply of ${name}, held only=aurora is blocked: the list held publishes no route that meets it`, async () => {
    reset();
    gateway.replies.models = reply;
    assert.deepEqual(view((await decide(client("only=aurora").client, target())).decision), blockView("no route the model list publishes for demo-model meets the policy, so the gateway would refuse it only after receiving the content"));
  });
}

for (const [name, reply] of [
  ["the text {not json", { status: 200, raw: "{not json" }],
  ["an empty body", { status: 200 }],
] as const) {
  test(`C4, C16: with a model list reply of ${name}, held only=aurora is sent holding no list`, async () => {
    reset();
    gateway.replies.models = reply;
    assert.deepEqual(view((await decide(client("only=aurora").client, target())).decision), sendView("demo-model", "only=aurora", "only=aurora"));
  });
}

test("C4, C16: with a model list publishing aurora with zdr, held zdr is sent with route aurora", async () => {
  reset();
  assert.deepEqual(view((await decide(client("zdr").client, target())).decision), sendView("demo-model", "zdr", "zdr", ["aurora"]));
});

test("C4, C16: with a model list publishing aurora with zdr, held notrain is blocked: no published route meets it", async () => {
  reset();
  assert.deepEqual(view((await decide(client("notrain").client, target())).decision), blockView("no route the model list publishes for demo-model meets the policy, so the gateway would refuse it only after receiving the content"));
});

// ---- C14: a base URL not usable as written.
function teamPlaces(): { inexact: Located; encoded: Located } {
  const written = placeOf(`${gateway.base}?team=R'D`);
  assert.ok(written !== null && written.unexact !== null);
  return { inexact: { target: { ...written.place, context: bearer("k") }, unexact: written.unexact }, encoded: { target: { ...written.place, context: bearer("k") }, unexact: null } };
}
function teamReplies(): void {
  gateway.replies.detection = (_headers, path) => (path.includes("team=R%27D") ? { status: 200, body: { route_policy: "1", key_policy: "only=nosuch" } } : { status: 200, body: { route_policy: "1" } });
  gateway.replies.models = list(["aurora", "zdr"], ["cobalt", ""]);
}
/** Reads ?team=R%27D with held zdr: its key policy only=nosuch is then held for that place. */
async function warmEncoded(c: RouteClient, encoded: Located): Promise<void> {
  c.held = holdPolicy("zdr", "session");
  await c.decide(encoded, "demo-model", null);
  c.held = { kind: "none" };
}

test("C14: a request with no policy for ?team=R'D, which cannot be used as written, is sent as it is", async () => {
  reset();
  teamReplies();
  const { inexact } = teamPlaces();
  const { client: c } = client(null);
  assert.deepEqual(view((await c.decide(inexact, "demo-model", null)).decision), sendView("demo-model", null, null));
});

test("C14: a request with no policy for ?team=R'D, after ?team=R%27D's key policy only=nosuch was read, is sent as it is", async () => {
  reset();
  teamReplies();
  const { inexact, encoded } = teamPlaces();
  const { client: c } = client(null);
  await warmEncoded(c, encoded);
  assert.deepEqual(view((await c.decide(inexact, "demo-model", null)).decision), sendView("demo-model", null, null));
});

test("C14: a request with no policy for ?team=R%27D, after its key policy only=nosuch was read, is blocked by it", async () => {
  reset();
  teamReplies();
  const { encoded } = teamPlaces();
  const { client: c } = client(null);
  await warmEncoded(c, encoded);
  assert.deepEqual(view((await c.decide(encoded, "demo-model", null)).decision), blockView("no route the model list publishes for demo-model meets the key's own policy, so the gateway would refuse it only after receiving the content"));
});

test("C14: decisions with no policy for ?team=R'D, before and after ?team=R%27D was read, read nothing", async () => {
  reset();
  teamReplies();
  const { inexact, encoded } = teamPlaces();
  const { client: c } = client(null);
  await c.decide(inexact, "demo-model", null);
  await warmEncoded(c, encoded);
  const reads = gateway.requests.length;
  await c.decide(inexact, "demo-model", null);
  assert.deepEqual([reads, gateway.requests.length], [2, 2]);
});

test('C14: a POST with no policy to ?team=R\'D, after ?team=R%27D was read, reaches the gateway as [path "/chat/completions?team=R%27D", authorization "Bearer k", route-policy undefined, the body sent]', async () => {
  reset();
  teamReplies();
  const { inexact, encoded } = teamPlaces();
  const { client: c } = client(null);
  await c.decide(inexact, "demo-model", null);
  await warmEncoded(c, encoded);
  await c.decide(inexact, "demo-model", null);
  const body = JSON.stringify({ model: "demo-model", messages: [] });
  await (await fetch(`${gateway.base}/chat/completions?team=R'D`, { method: "POST", headers: { authorization: "Bearer k" }, body })).text();
  assert.deepEqual(gateway.inference().map((r) => [r.path.replace(/^\/v\d*/, ""), r.headers.authorization, r.headers["route-policy"], r.body]), [["/chat/completions?team=R%27D", "Bearer k", undefined, body]]);
});

// ---- C14: what one place's decisions depend on.
// Three models, each published with routes of its own, and catalogs that differ by place. Facts differ by route,
// so one policy is met for one model and not another. Each place states its catalog and key policy, from which
// the test works out each decision whole, independently of the plugin.
const FACTS: Readonly<Record<string, readonly string[]>> = { aurora: ["zdr", "notrain"], basalt: ["zdr"], cobalt: [] };
/** Only basalt publishes evidence, so a decision's routes carry each route's own. */
const EVIDENCE: Readonly<Record<string, string>> = { basalt: "https://basalt.example/attestation" };
type Catalog = "plain" | "team" | "other" | "path";
const CATALOGS: Readonly<Record<Catalog, Readonly<Record<string, readonly string[]>>>> = {
  plain: { alfa: ["aurora"], bravo: ["basalt"], charlie: ["cobalt"] },
  team: { alfa: ["basalt", "cobalt"], bravo: ["aurora"], charlie: ["aurora", "basalt"] },
  other: { alfa: ["cobalt"], bravo: ["basalt", "aurora"], charlie: ["basalt"] },
  path: { alfa: ["aurora", "basalt"], bravo: ["cobalt"], charlie: ["basalt", "cobalt"] },
};
const listOf = (catalog: Catalog): unknown => ({
  data: Object.entries(CATALOGS[catalog]).map(([id, providers]) => ({ id, routes: providers.map((provider) => ({ provider, facts: (FACTS[provider] ?? []).join("+"), ...(EVIDENCE[provider] === undefined ? {} : { evidence: EVIDENCE[provider] }) })) })),
});
const catalogAt = (path: string): Catalog => (path.startsWith("/v2") ? "path" : path.includes("team=") ? "team" : "plain");
function placesWithCatalogs(): void {
  gateway.replies.detection = (headers, path) =>
    path.includes("team=R%27D")
      ? { status: 200, body: { route_policy: "1", key_policy: "zdr" } }
      : headers.authorization === "Bearer k2" && !path.startsWith("/v2")
        ? { status: 200, body: { route_policy: "1", key_policy: "notrain" } }
        : headers["x-tenant-token"] === "t9"
          ? { status: 200, body: { route_policy: "1", key_policy: "only=basalt" } }
          : { status: 200, body: { route_policy: "1" } };
  gateway.replies.models = (_headers, path) => ({ status: 200, body: listOf(catalogAt(path)) });
  elsewhere.replies.detection = { status: 200, body: { route_policy: "1" } };
  elsewhere.replies.models = { status: 200, body: listOf("other") };
}

test("C14: in seeded sequences (seeds 1, 7, 42, 99) of 52 decisions over 9 places, each decision equals the one worked out from the replies and the spec", async (t) => {
  const written = placeOf(`${gateway.base}?team=R'D`);
  assert.ok(written !== null && written.unexact !== null);
  const v2 = `${new URL(gateway.base).origin}/v2`;
  const places: { at: Located; catalog: Catalog; keyPolicy: string | null }[] = [
    { at: { target: target("k1"), unexact: null }, catalog: "plain", keyPolicy: null },
    { at: { target: { ...written.place, context: bearer("k1") }, unexact: null }, catalog: "team", keyPolicy: "zdr" },
    { at: { target: { ...written.place, context: bearer("k1") }, unexact: written.unexact }, catalog: "team", keyPolicy: null },
    { at: { target: { ...written.place, context: bearer("k2") }, unexact: null }, catalog: "team", keyPolicy: "zdr" },
    { at: { target: target("k2"), unexact: null }, catalog: "plain", keyPolicy: "notrain" },
    { at: { target: target("k1", elsewhere.base), unexact: null }, catalog: "other", keyPolicy: null },
    { at: { target: target("k1", v2), unexact: null }, catalog: "path", keyPolicy: null },
    { at: { target: target("k2", v2), unexact: null }, catalog: "path", keyPolicy: null },
    { at: { target: { base: gateway.base, query: "", context: [["authorization", "Bearer k1"], ["x-tenant-token", "t9"]] }, unexact: null }, catalog: "plain", keyPolicy: "only=basalt" },
  ];
  const policies = [null, "zdr", "sort=price", "only=aurora", "notrain"];
  const modelIds = ["alfa", "bravo", "charlie"].flatMap((id) => [id, `${id}+zdr`, `${id}+sort=latency`]);
  const requirements = (p: string | null): string[] => (p === null ? [] : p.split("+").filter((part) => part === "zdr" || part === "notrain" || part.startsWith("only=")));
  const meetsAll = (provider: string, required: readonly string[]): boolean => required.every((r) => (r.startsWith("only=") ? r.slice(5).split(",").includes(provider) : (FACTS[provider] ?? []).includes(r)));
  const placesSeen = new Set<number>();
  for (const seed of [1, 7, 42, 99]) {
    reset();
    placesWithCatalogs();
    let state = seed;
    const pick = <T,>(items: readonly T[]): T => {
      state = (state * 1103515245 + 12345) % 2147483648;
      const item = items[state % items.length];
      assert.ok(item !== undefined);
      return item;
    };
    const plan = Array.from({ length: 50 }, () => ({ place: pick(places.map((_, i) => i)), policy: pick(policies), model: pick(modelIds) }));
    plan.push({ place: 1, policy: "zdr", model: "alfa" }, { place: 2, policy: null, model: "alfa" });
    const listHeld = new Set<number>();
    const { client: c } = client("zdr");
    for (const [i, step] of plan.entries()) {
      const place = places[step.place];
      assert.ok(place !== undefined);
      placesSeen.add(step.place);
      c.held = step.policy === null ? { kind: "none" } : holdPolicy(step.policy, "session");
      const decision = (await c.decide(place.at, step.model, null)).decision;
      const [base = "", typed = null] = step.model.split("+");
      const anyPolicy = step.policy !== null || typed !== null;
      const required = [...requirements(step.policy), ...requirements(typed)];
      const routes = CATALOGS[place.catalog][base] ?? [];
      const sent = (() => {
        const layered = [step.policy, typed].filter((p) => p !== null);
        if (layered.length === 0) return null;
        // The suffix is the more specific: its sort replaces the held one.
        const parts = new Map<string, string>();
        for (const p of layered) for (const part of p.split("+")) parts.set(part.split("=")[0] ?? part, part);
        const order = ["zdr", "notrain", "only", "sort"];
        return [...parts.entries()].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).map(([, part]) => part).join("+");
      })();
      let expected: unknown;
      if (place.at.unexact !== null) {
        expected = anyPolicy ? blockView(place.at.unexact) : sendView(step.model, null, null);
      } else {
        if (anyPolicy && (required.length > 0 || place.keyPolicy !== null)) listHeld.add(step.place);
        const all = [...required, ...requirements(place.keyPolicy)];
        const held = listHeld.has(step.place);
        expected =
          held && all.length > 0 && !routes.some((p) => meetsAll(p, all))
            ? blockView(`no route the model list publishes for ${base} meets the ${sent === null ? "key's own policy" : place.keyPolicy === null ? "policy" : "policy combined with the key's own"}, so the gateway would refuse it only after receiving the content`)
            : sendView(step.model, step.policy, sent, held ? [...routes] : null);
      }
      assert.deepEqual(view(decision), expected, `seed ${seed}, step ${i}: ${JSON.stringify(step)}`);
      // The routes' values too: each provider's published facts and evidence, as the list states them.
      if (decision.action === "send" && decision.routes !== null) {
        const published = routes.map((provider) => {
          const facts = parsePublishedFacts((FACTS[provider] ?? []).join("+"));
          assert.ok(facts.ok);
          return [provider, { facts: facts.value, evidence: EVIDENCE[provider] ?? null }];
        });
        assert.deepEqual([...decision.routes], published, `seed ${seed}, step ${i}: routes`);
      }
    }
  }
  t.diagnostic(`places decided: ${[...placesSeen].sort().join(", ")}`);
  assert.equal(placesSeen.size, places.length, "every place is decided");
});

// ---- C14, C15: sessions.
/** A stale request released in the session before: its sibling came back not honored, then a new session began. */
async function staleFromLastSession(): Promise<{ c: RouteClient; reports: Report[]; send: () => Promise<Response> }> {
  const { client: c, reports } = client("zdr");
  const sendA = release(c, await decide(c, target()));
  const send = release(c, await decide(c, target()));
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {} };
  await sendText(sendA);
  c.newSession();
  return { c, reports, send };
}

test("C14, C15: a request released in the previous session and stale is stopped at fetch as discarded", async () => {
  reset();
  const { send } = await staleFromLastSession();
  await assert.rejects(send(), /discarded before it left/);
});

test("C14, C15: a request released in the previous session and stopped at fetch leaves the new session's last result null and adds no report", async () => {
  reset();
  const { c, reports, send } = await staleFromLastSession();
  await assert.rejects(send());
  assert.deepEqual([reports.map((r) => r.kind), c.lastReport], [["not-honored"], null]);
});

// ---- C14: failed reads.
for (const [name, failing] of [
  ["status 503", { status: 503 }],
  ["the text {route", { status: 200, raw: "{route" }],
] as const) {
  const afterFailure = async (): Promise<Prepared> => {
    gateway.replies.detection = failing;
    const { client: c } = client("zdr");
    await decide(c, target());
    gateway.replies.detection = { status: 200, body: { route_policy: "1" } };
    return decide(c, target());
  };
  test(`C14: after a detection read for held zdr answered ${name}, the next decision makes the reads [GET /route-policy, GET /route-policy, GET /models]`, async () => {
    reset();
    await afterFailure();
    assert.deepEqual(wire(), ["GET /route-policy Bearer k", "GET /route-policy Bearer k", "GET /models Bearer k"]);
  });
  test(`C14: after a detection read for held zdr answered ${name}, the next decision is sent with header zdr`, async () => {
    reset();
    assert.deepEqual(view((await afterFailure()).decision), sendView("demo-model", "zdr", "zdr", ["aurora"]));
  });
}

for (const [name, reply] of [
  ["status 503", { status: 503 }],
  ["the text {not json", { status: 200, raw: "{not json" }],
] as const) {
  test(`C14: when a model list read answers ${name}, held only=cobalt is sent holding no list`, async () => {
    reset();
    gateway.replies.models = reply;
    assert.deepEqual(view((await decide(client("only=cobalt").client, target())).decision), sendView("demo-model", "only=cobalt", "only=cobalt"));
  });
  test(`C14: after a model list read answered ${name}, the next decision makes the reads [GET /route-policy, GET /models, GET /models]`, async () => {
    reset();
    gateway.replies.models = reply;
    const { client: c } = client("only=cobalt");
    await decide(c, target());
    gateway.replies.models = list(["aurora", "zdr"]);
    await decide(c, target());
    assert.deepEqual(wire(), ["GET /route-policy Bearer k", "GET /models Bearer k", "GET /models Bearer k"]);
  });
  test(`C14: after a model list read answered ${name}, the next decision for held only=cobalt is blocked by the list then read`, async () => {
    reset();
    gateway.replies.models = reply;
    const { client: c } = client("only=cobalt");
    await decide(c, target());
    gateway.replies.models = list(["aurora", "zdr"]);
    assert.deepEqual(view((await decide(c, target())).decision), blockView("no route the model list publishes for demo-model meets the policy, so the gateway would refuse it only after receiving the content"));
  });
}

/** A fetch whose first read of `endpoint` rejects with connection refused; every read is logged by path. */
function flakyOnce(endpoint: string): { fetch: Fetch; reads: string[] } {
  let failures = 1;
  const reads: string[] = [];
  return {
    reads,
    fetch: async (input, init) => {
      const path = new URL(input).pathname;
      reads.push(path.slice(path.lastIndexOf("/")));
      if (path.endsWith(endpoint) && failures-- > 0) throw new TypeError("connection refused");
      return fetch(input, init);
    },
  };
}

test("C14: after a detection read rejects with connection refused, the next decision makes the reads [/route-policy, /route-policy, /models]", async () => {
  reset();
  const flaky = flakyOnce("/route-policy");
  const { client: c } = client("zdr", 2000, flaky.fetch);
  await decide(c, target());
  await decide(c, target());
  assert.deepEqual(flaky.reads, ["/route-policy", "/route-policy", "/models"]);
});

test("C14: after a detection read rejects with connection refused, the next decision is sent with header zdr", async () => {
  reset();
  const { client: c } = client("zdr", 2000, flakyOnce("/route-policy").fetch);
  await decide(c, target());
  assert.deepEqual(view((await decide(c, target())).decision), sendView("demo-model", "zdr", "zdr", ["aurora"]));
});

test("C14: when a model list read rejects with connection refused, held only=cobalt is sent holding no list", async () => {
  reset();
  const { client: c } = client("only=cobalt", 2000, flakyOnce("/models").fetch);
  assert.deepEqual(view((await decide(c, target())).decision), sendView("demo-model", "only=cobalt", "only=cobalt"));
});

test("C14: after a model list read rejects with connection refused, the next decision makes the reads [/route-policy, /models, /models]", async () => {
  reset();
  const flaky = flakyOnce("/models");
  const { client: c } = client("only=cobalt", 2000, flaky.fetch);
  await decide(c, target());
  await decide(c, target());
  assert.deepEqual(flaky.reads, ["/route-policy", "/models", "/models"]);
});

test("C14: after a model list read rejects with connection refused, the next decision for held only=cobalt is blocked by the list then read", async () => {
  reset();
  const { client: c } = client("only=cobalt", 2000, flakyOnce("/models").fetch);
  await decide(c, target());
  assert.deepEqual(view((await decide(c, target())).decision), blockView("no route the model list publishes for demo-model meets the policy, so the gateway would refuse it only after receiving the content"));
});

// ---- C15: a new client.
test("C15: a new client's request with no policy, after another client read a key policy only=nosuch and its list, is sent holding nothing", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "only=nosuch" } };
  await decide(client("zdr").client, target());
  const { client: next } = client(null);
  assert.deepEqual(view((await decide(next, target())).decision), sendView("demo-model", null, null));
});

test("C15: a first client's request with no policy stays blocked by its own key policy only=cobalt after a second client read key policy only=aurora at the same place", async () => {
  reset();
  // Both lists publish aurora only: the first's key policy only=cobalt is unmet, the second's only=aurora met.
  let keyPolicy = "only=cobalt";
  gateway.replies.detection = () => ({ status: 200, body: { route_policy: "1", key_policy: keyPolicy } });
  const { client: first } = client("zdr");
  await decide(first, target());
  keyPolicy = "only=aurora";
  const { client: second } = client("zdr");
  await decide(second, target());
  first.held = { kind: "none" };
  const reads = gateway.requests.length;
  assert.deepEqual(view((await decide(first, target())).decision), blockView("no route the model list publishes for demo-model meets the key's own policy, so the gateway would refuse it only after receiving the content"));
  assert.equal(gateway.requests.length, reads);
});

// ---- C16: a bound key policy and the list held.
test("C16: held sort=price with key policy only=missing makes the reads [GET /route-policy, GET /models]", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "only=missing" } };
  await decide(client("sort=price").client, target());
  assert.deepEqual(wire(), ["GET /route-policy Bearer k", "GET /models Bearer k"]);
});

test("C16: held sort=price with key policy only=missing is blocked: no route meets the policy combined with the key's own", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "only=missing" } };
  assert.deepEqual(view((await decide(client("sort=price").client, target())).decision), blockView("no route the model list publishes for demo-model meets the policy combined with the key's own, so the gateway would refuse it only after receiving the content"));
});

test("C16: with key policy only=missing and its list held for ?tenant=east, a request with no policy there is blocked without a new read", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "only=missing" } };
  const { client: c } = client("zdr");
  await decide(c, east("k"));
  c.held = { kind: "none" };
  assert.deepEqual(view((await decide(c, east("k"))).decision), blockView("no route the model list publishes for demo-model meets the key's own policy, so the gateway would refuse it only after receiving the content"));
  assert.equal(gateway.requests.filter((r) => r.path.includes("/models")).length, 1);
});

for (const [name, t] of [
  ["k2 at the same place", (): Target => east("k2")],
  ["k at the other port", (): Target => ({ ...east("k"), base: elsewhere.base })],
] as const) {
  test(`C16: with key policy only=missing and its list held for k at ?tenant=east, a request with no policy for ${name} is sent holding nothing`, async () => {
    reset();
    gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "only=missing" } };
    const { client: c } = client("zdr");
    await decide(c, east("k"));
    c.held = { kind: "none" };
    assert.deepEqual(view((await decide(c, t())).decision), sendView("demo-model", null, null));
  });
}

for (const [model, outcome, expected] of [
  ["demo-model", "sent with routes aurora and cobalt", sendView("demo-model", null, null, ["aurora", "cobalt"])],
  ["other-model", "blocked: no route meets the key's own policy", blockView("no route the model list publishes for other-model meets the key's own policy, so the gateway would refuse it only after receiving the content")],
] as const) {
  test(`C16: with key policy only=aurora and a held list where demo-model publishes aurora and other-model cobalt, a request with no policy for ${model} is ${outcome}`, async () => {
    reset();
    gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "only=aurora" } };
    gateway.replies.models = models({ "demo-model": [["aurora", "zdr"], ["cobalt", ""]], "other-model": [["cobalt", "zdr"]] });
    const { client: c } = client("zdr");
    await decide(c, target());
    c.held = { kind: "none" };
    assert.deepEqual(view((await decide(c, target(), model)).decision), expected);
  });
}

// ---- C8: translated responses.
for (const [name, reply, expected] of [
  ["no route headers", { status: 200, body: {} }, { kind: "unconfirmed" }],
  ["Route-Applied provider=aurora", { status: 200, headers: { "route-applied": "provider=aurora" }, body: {} }, { kind: "unconfirmed" }],
  ["an evidence URI alone", { status: 200, headers: { "route-evidence": "https://basalt.example/attestation" }, body: {} }, { kind: "unconfirmed" }],
  ["two Route-Applied lines", { status: 200, headers: { "route-applied": ["provider=aurora", "provider=basalt"] }, body: {} }, { kind: "unconfirmed" }],
  ["Route-Applied aurora", { status: 200, headers: { "route-applied": "aurora" }, body: {} }, { kind: "unconfirmed" }],
  ["503 with Route-Refused reason=unavailable", { status: 503, headers: { "route-refused": "reason=unavailable" }, body: {} }, { kind: "refused", reason: "unavailable", key: null }],
  ["503 with Route-Refused reason=maybe", { status: 503, headers: { "route-refused": "reason=maybe" }, body: {} }, { kind: "refused", reason: null, key: null }],
  ["503 with an empty Route-Refused", { status: 503, headers: { "route-refused": "" }, body: {} }, { kind: "refused", reason: null, key: null }],
] as const) {
  test(`C8: a translated request answered with ${name} is reported ${JSON.stringify(expected)}`, async () => {
    reset();
    const { client: c, reports } = client("only=aurora");
    const policy = c.held.kind === "policy" ? c.held.policy : assert.fail("held");
    gateway.replies.inference = reply as Reply;
    await sendText(release(c, { decision: { action: "translate", model: "vendor/model", provider: { only: ["aurora"] }, sent: policy }, target: target(), unexact: null, generation: 0 }));
    assert.deepEqual(reports, [expected]);
  });
}

// ---- /route.
const line = (base: string, as: string, rest: string): string => `Gateway ${base}, read ${as}: ${rest}`;
test("C13: /route with key policy zdr+region=us shows it as locked", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", key_policy: "zdr+region=us" } };
  const text = await client("zdr").client.describe(at(target()));
  assert.deepEqual(text.split("\n"), [
    "Route policy: zdr (from ROUTE_POLICY)",
    line(gateway.base, "with the credential in authorization", "detection valid; accepts zdr, notrain, bits, region, attest, only, ignore, sort, order"),
    "Key policy (locked, applied by the gateway to every request with this key): zdr+region=us",
    "Last result: none yet in this session",
  ]);
});

test('C12: /route with key policy zdr+residency=eu, which this client cannot interpret, shows it as text relied on for nothing', async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", keys: ["zdr", "residency"], key_policy: "zdr+residency=eu" } };
  const text = await client("zdr").client.describe(at(target()));
  assert.deepEqual(text.split("\n"), [
    "Route policy: zdr (from ROUTE_POLICY)",
    line(gateway.base, "with the credential in authorization", "detection valid; accepts zdr"),
    'Key policy (locked): "zdr+residency=eu", which this client cannot interpret; shown as text and relied on for nothing',
    "Last result: none yet in this session",
  ]);
});

test("C12: held notrain with the uninterpretable key policy zdr+residency=eu and a list where aurora publishes notrain only is sent", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", keys: ["zdr", "notrain", "residency"], key_policy: "zdr+residency=eu" } };
  gateway.replies.models = list(["aurora", "notrain"]);
  assert.deepEqual(view((await decide(client("notrain").client, target())).decision), sendView("demo-model", "notrain", "notrain", ["aurora"]));
});

test("C12: held sort=price with the uninterpretable key policy zdr+residency=eu reads no model list", async () => {
  reset();
  gateway.replies.detection = { status: 200, body: { route_policy: "1", keys: ["zdr", "sort", "residency"], key_policy: "zdr+residency=eu" } };
  await decide(client("sort=price").client, target());
  assert.deepEqual(wire(), ["GET /route-policy Bearer k"]);
});

for (const [name, arrange, place, why] of [
  ["404", () => (gateway.replies.detection = { status: 404 }), (): Target => target(), "detection reply is not valid: status is 404, not 200"],
  ["the text {", () => (gateway.replies.detection = { status: 200, raw: "{" }), (): Target => target(), "detection reply is not valid: not a JSON object"],
  ["no connection", () => {}, (): Target => target("k", "http://127.0.0.1:9/v1"), "detection could not be fetched: fetch failed"],
] as const) {
  test(`C1: /route at a base whose detection read answers ${name} shows the line "Gateway {base}, read with the credential in authorization: no detection (${why})"`, async () => {
    reset();
    arrange();
    const p = place();
    const text = await client("zdr").client.describe(at(p));
    assert.equal(text.split("\n")[1], line(p.base, "with the credential in authorization", `no detection (${why})`));
  });
}

const TENANTS = [
  ["?tenant=east", "bearer k and cookie who=east", [["authorization", "Bearer k"], ["cookie", "who=east"]], "authorization, cookie", "zdr"],
  ["?tenant=west", "x-api-key k2", [["x-api-key", "k2"]], "x-api-key", "zdr, notrain"],
] as const;
for (const [query, label, , names, accepts] of TENANTS) {
  test(`C1, C14: /route for ${query} with ${label}, after the other tenant's was shown, shows the line "Gateway {base}${query}, read with the credential in ${names}: detection valid; accepts ${accepts}"`, async () => {
    reset();
    gateway.replies.detection = (headers, path) =>
      path.includes("tenant=east") && headers.cookie === "who=east" && headers.authorization === "Bearer k"
        ? { status: 200, body: { route_policy: "1", keys: ["zdr"] } }
        : path.includes("tenant=west") && headers["x-api-key"] === "k2"
          ? { status: 200, body: { route_policy: "1", keys: ["zdr", "notrain"] } }
          : { status: 401 };
    const { client: c } = client("zdr");
    const shown = new Map<string, string>();
    // Both tenants are shown by one client, the other one first, so neither can borrow the other's reply.
    for (const [q, , ctx] of query === "?tenant=east" ? [...TENANTS].reverse() : TENANTS) {
      shown.set(q, (await c.describe(at({ base: gateway.base, query: q, context: ctx.map(([n, v]) => [n, v] as const) }))).split("\n")[1] ?? "");
    }
    assert.equal(shown.get(query), line(`${gateway.base}${query}`, `with the credential in ${names}`, `detection valid; accepts ${accepts}`));
  });
}

/** /route for one place with bearer k1, then k2, then k1 again; each bearer's reply lists other keys. */
async function routeByBearer(): Promise<string[]> {
  gateway.replies.detection = (headers) => ({ status: 200, body: { route_policy: "1", keys: headers.authorization === "Bearer k1" ? ["zdr"] : ["zdr", "notrain"] } });
  const { client: c } = client("zdr");
  const texts: string[] = [];
  for (const key of ["k1", "k2", "k1"]) texts.push((await c.describe(at(target(key)))).split("\n")[1] ?? "");
  return texts.map((t) => t.slice(t.indexOf(": ") + 2));
}

test("C1, C14: /route for one place with bearer k1, then k2, then k1 again makes the reads [GET /route-policy Bearer k1, GET /route-policy Bearer k2]", async () => {
  reset();
  await routeByBearer();
  assert.deepEqual(wire(), ["GET /route-policy Bearer k1", "GET /route-policy Bearer k2"]);
});

test('C1, C14: /route for one place with bearer k1, then k2, then k1 again shows ["detection valid; accepts zdr", "detection valid; accepts zdr, notrain", "detection valid; accepts zdr"]', async () => {
  reset();
  assert.deepEqual(await routeByBearer(), ["detection valid; accepts zdr", "detection valid; accepts zdr, notrain", "detection valid; accepts zdr"]);
});

test("C1, C14: a block for held zdr at ?tenant=east, whose detection read answers 404, names the base URL with ?tenant=east", async () => {
  reset();
  gateway.replies.detection = { status: 404 };
  assert.deepEqual(view((await decide(client("zdr").client, east("k"))).decision), blockView(`${gateway.base}?tenant=east has no valid detection reply (detection reply is not valid: status is 404, not 200), so no requirement may be sent there`));
});

const TRANSLATION_NOTE = "; policies are translated into OpenRouter's own fields where it has a filter for them";
const notFound: Fetch = async () => new Response("", { status: 404 });
test("C9: /route at OpenRouter's base URL, whose detection read answers 404, shows the translation note", async () => {
  reset();
  const c = new RouteClient({ carriers: "header", env: { ROUTE_POLICY: "zdr" }, fetch: notFound, onReport: () => {} });
  const text = await c.describe(at({ base: OPENROUTER_BASE, query: "", context: bearer("k") }));
  assert.equal(text.split("\n")[1], line(OPENROUTER_BASE, "with the credential in authorization", `no detection (detection reply is not valid: status is 404, not 200)${TRANSLATION_NOTE}`));
});

for (const query of ["?tenant=east", "?"]) {
  test(`C9: /route at OpenRouter's base URL with query ${query}, whose detection read answers 404, shows no translation note`, async () => {
    reset();
    const c = new RouteClient({ carriers: "header", env: { ROUTE_POLICY: "zdr" }, fetch: notFound, onReport: () => {} });
    const text = await c.describe(at({ base: OPENROUTER_BASE, query, context: bearer("k") }));
    assert.equal(text.split("\n")[1], line(`${OPENROUTER_BASE}${query}`, "with the credential in authorization", "no detection (detection reply is not valid: status is 404, not 200)"));
  });
}

test("C9: /route at the fake gateway, whose detection read answers 404, shows no translation note", async () => {
  reset();
  gateway.replies.detection = { status: 404 };
  const text = await client("zdr").client.describe(at(target()));
  assert.equal(text.split("\n")[1], line(gateway.base, "with the credential in authorization", "no detection (detection reply is not valid: status is 404, not 200)"));
});

test("C9: /route at OpenRouter's base URL, whose detection read is valid, shows no translation note", async () => {
  reset();
  const valid: Fetch = async () => new Response(JSON.stringify({ route_policy: "1" }), { status: 200 });
  const c = new RouteClient({ carriers: "header", env: { ROUTE_POLICY: "zdr" }, fetch: valid, onReport: () => {} });
  const text = await c.describe(at({ base: OPENROUTER_BASE, query: "", context: bearer("k") }));
  assert.equal(text.split("\n")[1], line(OPENROUTER_BASE, "with the credential in authorization", "detection valid; accepts zdr, notrain, bits, region, attest, only, ignore, sort, order"));
});

test('C6: /route read with bearer k and no key_policy shows "Key policy: none"', async () => {
  reset();
  const text = await client("zdr").client.describe(at(target()));
  assert.equal(text.split("\n")[2], "Key policy: none");
});

for (const [name, context] of [
  ["no headers", []],
  ["a traceparent header alone", [["traceparent", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"]]],
  ['authorization "  "', [["authorization", "  "]]],
] as const) {
  test(`C6: /route read with ${name} and no key_policy shows "Key policy: unknown, the request carries no credential"`, async () => {
    reset();
    const text = await client("zdr").client.describe(at({ base: gateway.base, query: "", context: context.map(([n, v]) => [n, v] as const) }));
    assert.deepEqual(text.split("\n").slice(1, 3), [line(gateway.base, "without a credential", "detection valid; accepts zdr, notrain, bits, region, attest, only, ignore, sort, order"), "Key policy: unknown, the request carries no credential"]);
  });
}

for (const [name, reply] of [
  ["404", { status: 404 }],
  ["the text {", { status: 200, raw: "{" }],
] as const) {
  test(`C6: /route read with no headers, whose detection read answers ${name}, shows no key policy line`, async () => {
    reset();
    gateway.replies.detection = reply;
    const text = await client("zdr").client.describe(at(target(null)));
    assert.deepEqual(text.split("\n").filter((l) => l.startsWith("Key policy")), []);
  });
}

/** A client whose every fetch is logged, so a test can see that none was attempted. */
function spied(): { c: RouteClient; attempted: string[] } {
  const attempted: string[] = [];
  const spy: Fetch = async (input, init) => {
    attempted.push(input);
    return fetch(input, init);
  };
  return { c: new RouteClient({ carriers: "header", env: { ROUTE_POLICY: "zdr" }, fetch: spy, onReport: () => {} }), attempted };
}
const UNEXACT = "the base URL cannot be used exactly as written: its query would be sent otherwise";
const NO_PLACE = "the harness did not say which model and base URL the request is for";

test("C14: /route for a place not usable as written attempts no fetch", async () => {
  reset();
  const { c, attempted } = spied();
  await c.describe({ target: target(), unexact: UNEXACT });
  assert.deepEqual(attempted, []);
});

test(`C14: /route for a place not usable as written shows the lines ["Gateway {base}, read with the credential in authorization: no detection (${UNEXACT})", "Last result: none yet in this session"] after the held policy`, async () => {
  reset();
  const text = await spied().c.describe({ target: target(), unexact: UNEXACT });
  assert.deepEqual(text.split("\n").slice(1), [line(gateway.base, "with the credential in authorization", `no detection (${UNEXACT})`), "Last result: none yet in this session"]);
});

/** /route for ?team=R'D once ?team=R%27D's valid reply was read by the same client. */
async function routeInexactAfterEncoded(): Promise<{ attempted: string[]; line: string | undefined; why: string }> {
  teamReplies();
  const { c, attempted } = spied();
  const { inexact, encoded } = teamPlaces();
  await c.decide(encoded, "demo-model", null);
  attempted.length = 0;
  const text = await c.describe(inexact);
  return { attempted, line: text.split("\n")[1], why: inexact.unexact ?? "" };
}

test("C14: /route for ?team=R'D, after ?team=R%27D's valid reply was read, attempts no fetch", async () => {
  reset();
  assert.deepEqual((await routeInexactAfterEncoded()).attempted, []);
});

test('C14: /route for ?team=R\'D, after ?team=R%27D\'s valid reply was read, shows the line "Gateway {base}?team=R%27D, read with the credential in authorization: no detection (…)" with the reason it is not as written', async () => {
  reset();
  const shown = await routeInexactAfterEncoded();
  assert.equal(shown.line, line(`${gateway.base}?team=R%27D`, "with the credential in authorization", `no detection (${shown.why})`));
});

test("C14: /route for no place attempts no fetch", async () => {
  reset();
  const { c, attempted } = spied();
  await c.describe({ why: NO_PLACE });
  assert.deepEqual(attempted, []);
});

test(`C14: /route for no place shows the line "Gateway: unknown, nothing was read (${NO_PLACE})"`, async () => {
  reset();
  const text = await spied().c.describe({ why: NO_PLACE });
  assert.equal(text.split("\n")[1], `Gateway: unknown, nothing was read (${NO_PLACE})`);
});

test("C14: /route after a not-honored result, the detection read now answering 404, shows no detection", async () => {
  reset();
  const { client: c } = client("zdr");
  await c.describe(at(target()));
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {} };
  await sendText(release(c, await decide(c, target())));
  gateway.replies.detection = { status: 404 };
  assert.equal((await c.describe(at(target()))).split("\n")[1], line(gateway.base, "with the credential in authorization", "no detection (detection reply is not valid: status is 404, not 200)"));
});

test("C14: /route after a not-honored result, the detection read now listing zdr only, shows accepts zdr", async () => {
  reset();
  const { client: c } = client("zdr");
  await c.describe(at(target()));
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {} };
  await sendText(release(c, await decide(c, target())));
  gateway.replies.detection = { status: 200, body: { route_policy: "1", keys: ["zdr"] } };
  assert.equal((await c.describe(at(target()))).split("\n")[1], line(gateway.base, "with the credential in authorization", "detection valid; accepts zdr"));
});

const twoModels = (): void => {
  gateway.replies.models = models({ "demo-model": [["aurora", "zdr"]], "other-model": [["aurora", "zdr"]] });
  elsewhere.replies.models = models({ "demo-model": [["aurora", "zdr"]], "other-model": [["aurora", "zdr"]] });
};
test("C3, C5: /route after demo-model's honored result at the gateway and other-model's refusal at the other port's ?tenant=east shows the refusal, naming other-model and that place", async () => {
  reset();
  twoModels();
  const { client: c } = client("zdr");
  await sendText(release(c, await decide(c, target(), "demo-model")));
  elsewhere.replies.inference = { status: 400, headers: { "route-refused": "reason=unsatisfiable" }, body: {} };
  await sendText(release(c, await decide(c, target("k", elsewhere.base, "?tenant=east"), "other-model")));
  const text = await c.describe(at(target()));
  assert.equal(text.split("\n").at(-1), `Last result (request for other-model to ${elsewhere.base}?tenant=east): route policy refused by the gateway: unsatisfiable`);
});

test("C3, C5: /route after other-model's refusal at the other port and demo-model's honored result at the gateway shows the honored result, naming demo-model and the gateway", async () => {
  reset();
  twoModels();
  const { client: c } = client("zdr");
  elsewhere.replies.inference = { status: 400, headers: { "route-refused": "reason=unsatisfiable" }, body: {} };
  await sendText(release(c, await decide(c, target("k", elsewhere.base, "?tenant=east"), "other-model")));
  await sendText(release(c, await decide(c, target(), "demo-model")));
  const text = await c.describe(at(target()));
  assert.equal(text.split("\n").at(-1), `Last result (request for demo-model to ${gateway.base}): route policy honored: served by aurora; its published facts meet the policy (they are the gateway's claims, not verified by this client)`);
});
