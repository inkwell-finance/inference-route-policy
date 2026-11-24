// Each test is one POST (or GET) through the fetch gate in one situation, and one thing observed of it: whether it
// is stopped (fetch rejects and the gateway receives nothing), whether it goes (and what the gateway receives),
// or what a release's owner or a watcher is told or hears.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { addRelease, addWatcher, type Release } from "../src/fetch-gate.ts";
import { NOT_CONTEXT, placeOf, type Completion } from "../src/request.ts";
import { fakeGateway, type FakeGateway } from "./fixtures.ts";

let gateway: FakeGateway;
let elsewhere: FakeGateway;
const removals: (() => void)[] = [];
before(async () => {
  gateway = await fakeGateway();
  elsewhere = await fakeGateway();
});
after(async () => {
  await gateway.close();
  await elsewhere.close();
});
beforeEach(() => {
  for (const remove of removals.splice(0)) remove();
  gateway.requests.length = 0;
  elsewhere.requests.length = 0;
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=aurora" }, body: { ok: true } };
});

const BODY = JSON.stringify({ model: "demo-model", messages: [{ role: "user", content: "secret" }] });
const BLOCKED = (reason: string): string => `Blocked by the route policy plugin, nothing was sent: ${reason}`;

/** Releases BODY for bearer k and policy zdr at the gateway's base URL; returns what its owner hears and is told. */
function release(overrides: Partial<Release> = {}): { completions: Completion[]; stops: string[] } {
  const seen = { completions: [] as Completion[], stops: [] as string[] };
  removals.push(
    addRelease({
      owner: overrides.owner ?? seen,
      base: gateway.base,
      query: "",
      context: [["authorization", "Bearer k"]],
      header: "zdr",
      body: BODY,
      current: () => true,
      stopped: (reason) => seen.stops.push(reason),
      complete: (completion) => seen.completions.push(completion),
      ...overrides,
    }),
  );
  return seen;
}

/** A watcher that stops every POST to the gateway's origin no release matched, as "not released"; returns what it is told. */
function watchAll(): string[] {
  const stops: string[] = [];
  removals.push(addWatcher({ check: (o) => (o.path.startsWith(new URL(gateway.base).origin) ? "not released" : null), stopped: (r) => stops.push(r) }));
  return stops;
}

const post = (init: { headers?: RequestInit["headers"]; body?: string; url?: string } = {}): Promise<Response> =>
  fetch(init.url ?? `${gateway.base}/chat/completions`, { method: "POST", headers: init.headers ?? { authorization: "Bearer k", "route-policy": "zdr" }, body: init.body ?? BODY });

/** Asserts a POST is stopped: fetch rejects with `reason`, and neither gateway receives anything. */
async function stopped(sending: Promise<Response>, reason: string): Promise<void> {
  await assert.rejects(sending, (error: unknown) => error instanceof Error && error.message === BLOCKED(reason));
  assert.deepEqual([gateway.requests, elsewhere.requests], [[], []]);
}

const OK_COMPLETION = (applied: string[] = ["provider=aurora"]): Completion => ({ status: 200, result: { applied, refused: [], evidence: [] } });

test('C1: a POST no release matches, with a watcher answering "not released", is stopped with that reason', async () => {
  watchAll();
  await stopped(post(), "not released");
});

test('C1: a POST no release matches, with a watcher answering "not released", has the watcher told "not released"', async () => {
  const stops = watchAll();
  await assert.rejects(post());
  assert.deepEqual(stops, ["not released"]);
});

test('C1: a POST no release matches, while a release for another body waits, with a watcher answering "not released", is stopped with that reason', async () => {
  watchAll();
  release({ body: JSON.stringify({ model: "other-model", messages: [] }) });
  await stopped(post(), "not released");
});

test("C1: a POST no release matches, with a watcher that throws broken watcher, is stopped as a failure of the plugin", async () => {
  removals.push(addWatcher({ check: () => { throw new Error("broken watcher"); }, stopped: () => {} }));
  await stopped(post(), "the plugin failed while checking the request: broken watcher");
});

test("C1: the released POST reaches the gateway as [POST, /chat/completions, the released body, policy header zdr]", async () => {
  release();
  await (await post()).text();
  assert.deepEqual(gateway.requests.map((r) => [r.method, r.path.replace(/^.*\/v1/, ""), r.body, r.headers["route-policy"]]), [["POST", "/chat/completions", BODY, "zdr"]]);
});

test("C5: the owner of the released POST hears its 400 response with Route-Refused reason=unsatisfiable", async () => {
  const owner = release();
  gateway.replies.inference = { status: 400, headers: { "route-refused": "reason=unsatisfiable" }, body: { error: { message: "no" } } };
  await (await post()).text();
  assert.deepEqual(owner, { completions: [{ status: 400, result: { applied: [], refused: ["reason=unsatisfiable"], evidence: [] } }], stops: [] });
});

test("C1: the released POST's 400 response reaches the caller with its body untouched", async () => {
  release();
  gateway.replies.inference = { status: 400, headers: { "route-refused": "reason=unsatisfiable" }, body: { error: { message: "no" } } };
  const response = await post();
  assert.deepEqual([response.status, await response.json()], [400, { error: { message: "no" } }]);
});

test('C1: a second POST of the released bytes, with a watcher answering "not released", is stopped with that reason', async () => {
  watchAll();
  release();
  await (await post()).text();
  gateway.requests.length = 0;
  await stopped(post(), "not released");
});

const STALE = "the detection reply this request was checked against was discarded before it left; send it again";
test("C14: a POST of a release whose decision is no longer current is stopped as discarded", async () => {
  release({ current: () => false });
  await stopped(post(), STALE);
});

test("C14: the owner of a release whose decision is no longer current is told it was discarded", async () => {
  const owner = release({ current: () => false });
  await assert.rejects(post());
  assert.deepEqual(owner.stops, [STALE]);
});

test("C14: the owner of a release whose decision is no longer current hears no response", async () => {
  const owner = release({ current: () => false });
  await assert.rejects(post());
  assert.deepEqual(owner.completions, []);
});

for (const [name, variant] of [
  ["bearer other instead of k", { headers: { authorization: "Bearer other", "route-policy": "zdr" } }],
  ["an added x-api-key", { headers: { authorization: "Bearer k", "x-api-key": "k2", "route-policy": "zdr" } }],
  ["an added x-goog-api-key", { headers: { authorization: "Bearer k", "x-goog-api-key": "k2", "route-policy": "zdr" } }],
  ["an added api-key", { headers: { authorization: "Bearer k", "api-key": "k2", "route-policy": "zdr" } }],
  ["an added cookie", { headers: { authorization: "Bearer k", cookie: "session=1", "route-policy": "zdr" } }],
  ["an added proxy-authorization", { headers: { authorization: "Bearer k", "proxy-authorization": "Basic eA==", "route-policy": "zdr" } }],
  ["an added x-tenant-token", { headers: { authorization: "Bearer k", "x-tenant-token": "t", "route-policy": "zdr" } }],
  ["the query ?key=1", { url: "QUERY" }],
  ["the path /other/chat/completions", { url: "OTHER" }],
  ["policy header zdr+notrain", { headers: { authorization: "Bearer k", "route-policy": "zdr+notrain" } }],
  ["no policy header", { headers: { authorization: "Bearer k" } }],
  ["two route-policy lines zdr", { headers: [["authorization", "Bearer k"], ["route-policy", "zdr"], ["route-policy", "zdr"]] }],
  ["an added provider member in the body", { body: JSON.stringify({ model: "demo-model", messages: [{ role: "user", content: "secret" }], provider: {} }) }],
  ["a trailing space after the body", { body: `${BODY} ` }],
] as const) {
  test(`C1, C14: a POST differing from the release only by ${name}, with a watcher answering "not released", is stopped with that reason`, async () => {
    watchAll();
    release();
    const url = "url" in variant ? (variant.url === "QUERY" ? `${gateway.base}/chat/completions?key=1` : `${new URL(gateway.base).origin}/other/chat/completions`) : undefined;
    const headers = "headers" in variant ? (variant.headers as RequestInit["headers"]) : undefined;
    const body = "body" in variant ? variant.body : undefined;
    await stopped(post({ ...(url === undefined ? {} : { url }), ...(headers === undefined ? {} : { headers }), ...(body === undefined ? {} : { body }) }), "not released");
  });
}

test('C1: a POST with policy header zdr to a release made with no policy header, with a watcher answering "not released", is stopped with that reason', async () => {
  watchAll();
  release({ header: null });
  await stopped(post(), "not released");
});

const NAMES = NOT_CONTEXT.filter((name) => name !== "route-policy");
test(`C1: for each of the ${NAMES.length} names in NOT_CONTEXT but route-policy, a POST adding that header goes as the release`, async () => {
  assert.ok(NAMES.length > 0);
  watchAll();
  for (const name of NAMES) {
    const owner = release();
    // fetch computes content-length itself; any value given here is replaced, so the header is still present.
    await (await post({ headers: { authorization: "Bearer k", "route-policy": "zdr", [name]: name === "content-length" ? String(BODY.length) : "x" } })).text();
    assert.deepEqual(owner, { completions: [OK_COMPLETION()], stops: [] }, name);
  }
});

for (const [name, headers] of [
  ["a lowercase object", { authorization: "Bearer k", "route-policy": "zdr" }],
  ["a title-case object", { Authorization: "Bearer k", "Route-Policy": "zdr" }],
  ["an uppercase object", { AUTHORIZATION: "Bearer k", "ROUTE-POLICY": "zdr" }],
  ["a mixed-case object", { aUtHoRiZaTiOn: "Bearer k", "rOuTe-PoLiCy": "zdr" }],
  ["a lowercase array", [["authorization", "Bearer k"], ["route-policy", "zdr"]]],
  ["a mixed-case array", [["Authorization", "Bearer k"], ["ROUTE-POLICY", "zdr"]]],
  ["a Headers", "HEADERS"],
] as const) {
  test(`C1: a POST with the released headers as ${name} goes as the release`, async () => {
    const owner = release();
    const given = headers === "HEADERS" ? new Headers({ Authorization: "Bearer k", "Route-Policy": "zdr" }) : (headers as RequestInit["headers"]);
    await (await post({ ...(given === undefined ? {} : { headers: given }) })).text();
    assert.deepEqual(owner, { completions: [OK_COMPLETION()], stops: [] });
  });
}

test('C1: a POST of a Request object carrying the released bytes, with a watcher answering "not released", is stopped with that reason', async () => {
  watchAll();
  release();
  await stopped(fetch(new Request(`${gateway.base}/chat/completions`, { method: "POST", headers: { authorization: "Bearer k", "route-policy": "zdr" }, body: BODY })), "not released");
});

const AMBIGUOUS = "two sessions released this same request, so whose it is cannot be told";
test("C1, C5: a POST that two owners released alike is stopped as ambiguous", async () => {
  release({ owner: { session: 1 } });
  release({ owner: { session: 2 } });
  await stopped(post(), AMBIGUOUS);
});

test("C1, C5: of two owners that released a POST alike, the first and the second are told it is ambiguous", async () => {
  const first = release({ owner: { session: 1 } });
  const second = release({ owner: { session: 2 } });
  await assert.rejects(post());
  assert.deepEqual([first.stops, second.stops], [[AMBIGUOUS], [AMBIGUOUS]]);
});

test("C1, C5: of two owners that released a POST alike, the first and the second hear no response", async () => {
  const first = release({ owner: { session: 1 } });
  const second = release({ owner: { session: 2 } });
  await assert.rejects(post());
  assert.deepEqual([first.completions, second.completions], [[], []]);
});

/** Waits until `done` holds, for at most two seconds. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((wake) => setTimeout(wake, 5));
  assert.ok(done(), "timed out waiting");
}

test("C5: with mine (200 aurora, 200 ms) leaving before theirs (400 unsatisfiable, 20 ms), the owners' callbacks are [theirs with 400 and Route-Refused reason=unsatisfiable, mine with 200 and Route-Applied provider=aurora]", async () => {
  const OTHER = JSON.stringify({ model: "other-model", messages: [] });
  const heard: unknown[] = [];
  release({ owner: { session: 1 }, complete: (c) => heard.push(["mine", c]) });
  release({ owner: { session: 2 }, body: OTHER, complete: (c) => heard.push(["theirs", c]) });
  gateway.replies.inference = (request) =>
    request.body === BODY
      ? { status: 200, headers: { "route-applied": "provider=aurora" }, body: {}, delayMs: 200 }
      : { status: 400, headers: { "route-refused": "reason=unsatisfiable" }, body: {}, delayMs: 20 };
  const first = post();
  await until(() => gateway.inference().length === 1);
  await Promise.all([first.then((r) => r.text()), post({ body: OTHER }).then((r) => r.text())]);
  assert.deepEqual(heard, [
    ["theirs", { status: 400, result: { applied: [], refused: ["reason=unsatisfiable"], evidence: [] } }],
    ["mine", OK_COMPLETION()],
  ]);
});

test("C5: with mine (200 ms) leaving before theirs (20 ms), the callers' fetches finish in the order [theirs, mine]", async () => {
  const OTHER = JSON.stringify({ model: "other-model", messages: [] });
  release({ owner: { session: 1 } });
  release({ owner: { session: 2 }, body: OTHER });
  gateway.replies.inference = (request) => ({ status: 200, headers: {}, body: {}, delayMs: request.body === BODY ? 200 : 20 });
  const finished: string[] = [];
  const first = post().then(async (r) => {
    await r.text();
    finished.push("mine");
  });
  await until(() => gateway.inference().length === 1);
  await Promise.all([first, post({ body: OTHER }).then(async (r) => {
    await r.text();
    finished.push("theirs");
  })]);
  assert.deepEqual(finished, ["theirs", "mine"]);
});

for (const status of [301, 302, 303, 307, 308]) {
  test(`C1: a released POST answered ${status} with a location at another origin is not followed: the other origin receives nothing`, async () => {
    const owner = release();
    gateway.replies.inference = { status, headers: { location: `${elsewhere.base}/chat/completions` } };
    const response = await post();
    await response.text();
    assert.deepEqual([response.status, elsewhere.requests, owner.completions.map((c) => c.status)], [status, [], [status]]);
  });
}

for (const [lines, joined] of [
  [["provider=aurora", "provider=basalt"], "provider=aurora, provider=basalt"],
  [["provider=aurora", "provider=aurora"], "provider=aurora, provider=aurora"],
] as const) {
  test(`C3: Route-Applied lines ${JSON.stringify(lines)} reach the owner as the one value ${JSON.stringify(joined)}`, async () => {
    const owner = release();
    gateway.replies.inference = { status: 200, headers: { "route-applied": [...lines] }, body: {} };
    await (await post()).text();
    assert.deepEqual(owner.completions, [OK_COMPLETION([joined])]);
  });
}

const G = (): string => new URL(gateway.base).origin;
const PORT = (): string => new URL(gateway.base).port;
type WireRow = { name: string; base: () => string; url: () => string; target: string | null; reason?: string };
const WIRE: WireRow[] = [
  { name: "base /v1/ and a POST to /v1/chat/completions", base: () => `${G()}/v1/`, url: () => `${G()}/v1/chat/completions`, target: "/v1/chat/completions" },
  { name: "base /v1/ and a POST to /v1//chat/completions", base: () => `${G()}/v1/`, url: () => `${G()}/v1//chat/completions`, target: null },
  { name: "base /v1 and a POST to /v1/x/../chat/completions", base: () => `${G()}/v1`, url: () => `${G()}/v1/x/../chat/completions`, target: "/v1/chat/completions" },
  { name: "base /v1 and a POST to /v%31/chat/completions", base: () => `${G()}/v1`, url: () => `${G()}/v%31/chat/completions`, target: null },
  { name: "base /v1 and a POST to the sibling /v123/chat/completions", base: () => `${G()}/v1`, url: () => `${G()}/v123/chat/completions`, target: null },
  { name: "base /v1?q=a+b and a POST with ?q=a+b", base: () => `${G()}/v1?q=a+b`, url: () => `${G()}/v1/chat/completions?q=a+b`, target: "/v1/chat/completions?q=a+b" },
  { name: "base /v1?q=a+b and a POST with ?q=a%20b", base: () => `${G()}/v1?q=a+b`, url: () => `${G()}/v1/chat/completions?q=a%20b`, target: null },
  { name: "base /v1?q=%2b and a POST with ?q=%2B", base: () => `${G()}/v1?q=%2b`, url: () => `${G()}/v1/chat/completions?q=%2B`, target: null },
  { name: "base /v1 and a POST to HTTP://127.0.0.1", base: () => `${G()}/v1`, url: () => `HTTP://127.0.0.1:${PORT()}/v1/chat/completions`, target: "/v1/chat/completions" },
  { name: "base /v1 and a POST to 127.0.0.1. with a trailing dot", base: () => `${G()}/v1`, url: () => `http://127.0.0.1.:${PORT()}/v1/chat/completions`, target: "/v1/chat/completions" },
  { name: "base /v1 and a POST with the fragment #part", base: () => `${G()}/v1`, url: () => `${G()}/v1/chat/completions#part`, target: "/v1/chat/completions" },
  { name: "base /v1? and a POST with ?#part", base: () => `${G()}/v1?`, url: () => `${G()}/v1/chat/completions?#part`, target: "/v1/chat/completions?" },
  { name: "base /v1? and a POST with no query", base: () => `${G()}/v1?`, url: () => `${G()}/v1/chat/completions`, target: null },
  { name: "base /v1 and a POST to another port's /v1/chat/completions", base: () => `${G()}/v1`, url: () => `${elsewhere.base}/chat/completions`, target: null },
];
for (const row of WIRE) {
  if (row.target === null) {
    test(`C1, C14: with ${row.name}, the POST is stopped`, async () => {
      removals.push(addWatcher({ check: () => "not released", stopped: () => {} }));
      const read = placeOf(row.base());
      assert.ok(read !== null && read.unexact === null);
      release({ ...read.place });
      const sending = fetch(row.url(), { method: "POST", headers: { authorization: "Bearer k", "route-policy": "zdr" }, body: BODY });
      if (row.reason === undefined) await stopped(sending, "not released");
      else {
        await assert.rejects(sending, /credentials/);
        assert.deepEqual([gateway.requests, elsewhere.requests], [[], []]);
      }
    });
  } else {
    test(`C1, C14: with ${row.name}, the POST goes to ${row.target}`, async () => {
      removals.push(addWatcher({ check: () => "not released", stopped: () => {} }));
      const read = placeOf(row.base());
      assert.ok(read !== null && read.unexact === null);
      const owner = release({ ...read.place });
      await (await fetch(row.url(), { method: "POST", headers: { authorization: "Bearer k", "route-policy": "zdr" }, body: BODY })).text();
      assert.deepEqual([gateway.requests.map((r) => r.path), owner.completions.length], [[row.target], 1]);
    });
  }
}

const TENANT: [string, string][] = [["authorization", "Bearer k"], ["x-tenant", "a, b"]];
test('C1, C14: a POST with lines "  Bearer k  ", x-tenant a and X-Tenant b goes to a release read as authorization Bearer k and x-tenant "a, b", as one line each', async () => {
  const owner = release({ context: TENANT });
  await (await post({ headers: [["Authorization", "  Bearer k  "], ["x-tenant", "a"], ["X-Tenant", "b"], ["route-policy", "zdr"]] })).text();
  const raw = gateway.inference()[0]?.rawHeaders ?? [];
  const lines = (name: string): string[] => raw.flatMap((value, i) => (i % 2 === 1 && raw[i - 1]?.toLowerCase() === name ? [value] : []));
  assert.deepEqual([owner.completions.length, lines("x-tenant"), lines("authorization")], [1, ["a, b"], ["Bearer k"]]);
});

for (const [name, lines] of [
  ["no x-tenant", [["authorization", "Bearer k"]]],
  ["x-tenant b then a", [["authorization", "Bearer k"], ["x-tenant", "b"], ["x-tenant", "a"]]],
  ['x-tenant "a,b"', [["authorization", "Bearer k"], ["x-tenant", "a,b"]]],
  ["x-tenant a alone", [["authorization", "Bearer k"], ["x-tenant", "a"]]],
  ['authorization "  Bearer other  "', [["authorization", "  Bearer other  "], ["x-tenant", "a"], ["x-tenant", "b"]]],
  ["no authorization", [["x-tenant", "a"], ["x-tenant", "b"]]],
] as const) {
  test(`C1, C14: a POST with ${name}, to a release read as authorization Bearer k and x-tenant "a, b", is stopped`, async () => {
    watchAll();
    release({ context: TENANT });
    await stopped(post({ headers: [...lines.map(([n, v]) => [n, v] as [string, string]), ["route-policy", "zdr"]] }), "not released");
  });
}

test('C1: a GET to the gateway, with a watcher answering "not released", goes', async () => {
  watchAll();
  await (await fetch(`${gateway.base}/models`)).text();
  assert.deepEqual(gateway.requests.map((r) => r.method), ["GET"]);
});

test('C1: a GET to the gateway with the release\'s authorization and policy header, while that release waits, goes', async () => {
  watchAll();
  release();
  await (await fetch(`${gateway.base}/chat/completions`, { headers: { authorization: "Bearer k", "route-policy": "zdr" } })).text();
  assert.deepEqual(gateway.requests.map((r) => r.method), ["GET"]);
});

test('C1: a POST to another origin, with a watcher answering "not released" for the gateway only, goes', async () => {
  watchAll();
  await (await post({ url: `${elsewhere.base}/chat/completions` })).text();
  assert.deepEqual(elsewhere.requests.map((r) => r.method), ["POST"]);
});
