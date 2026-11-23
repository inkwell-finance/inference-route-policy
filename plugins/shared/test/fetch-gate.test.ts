import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { addRelease, addWatcher, type Release } from "../src/fetch-gate.ts";
import { placeOf, type Completion } from "../src/request.ts";
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

/** Releases BODY for key `k` and policy `zdr`; returns what the owner was told. */
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

/** A watcher that stops every POST to the fake gateway's origin that no release matched. */
function watchAll(): string[] {
  const stops: string[] = [];
  removals.push(addWatcher({ check: (o) => (o.path.startsWith(new URL(gateway.base).origin) ? "not released" : null), stopped: (r) => stops.push(r) }));
  return stops;
}

/** Waits until `done` holds, for at most two seconds. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((wake) => setTimeout(wake, 5));
  assert.ok(done(), "timed out waiting");
}

const post = (init: { headers?: RequestInit["headers"]; body?: string; url?: string | undefined } = {}): Promise<Response> =>
  fetch(init.url ?? `${gateway.base}/chat/completions`, { method: "POST", headers: init.headers ?? { authorization: "Bearer k", "route-policy": "zdr" }, body: init.body ?? BODY });

test("C1: a POST no release matches fails in fetch, before anything reaches the gateway, when a watcher says a policy is at stake", async () => {
  const stops = watchAll();
  await assert.rejects(post(), /^Error: Blocked by the route policy plugin, nothing was sent: not released$/);
  assert.equal(gateway.requests.length, 0);
  assert.deepEqual(stops, ["not released"], "the watching session is told");
});

test("C1: a watcher that throws stops the request rather than letting it pass", async () => {
  removals.push(addWatcher({ check: () => { throw new Error("broken watcher"); }, stopped: () => {} }));
  await assert.rejects(post(), /the plugin failed while checking the request: broken watcher/);
  assert.equal(gateway.requests.length, 0);
});

test("C1, C5: a released request goes once, with its own response read on that call, a 400 refusal included", async () => {
  const stops = watchAll();
  const owner = release();
  gateway.replies.inference = { status: 400, headers: { "route-refused": "reason=unsatisfiable" }, body: { error: { message: "no" } } };
  const response = await post();
  assert.deepEqual(await response.json(), { error: { message: "no" } }, "the response reaches the caller untouched");
  assert.deepEqual(owner.completions, [{ status: 400, result: { applied: [], refused: ["reason=unsatisfiable"], evidence: [] } }]);
  // Used up: a resend of the same bytes is not released again.
  await assert.rejects(post(), /not released/);
  assert.equal(gateway.inference().length, 1);
  assert.deepEqual(stops, ["not released"]);
});

test("C1, C14: a release whose decision is no longer current is stopped and its owner told", async () => {
  const owner = release({ current: () => false });
  await assert.rejects(post(), /the detection reply this request was checked against was discarded before it left/);
  assert.equal(gateway.requests.length, 0);
  assert.equal(owner.stops.length, 1);
});

test("C1, C9, C14: only the released bytes go: another key, an added credential header, another policy header, or another body is not the release", async () => {
  watchAll();
  release();
  const variants: { headers?: RequestInit["headers"]; body?: string; url?: string }[] = [
    { headers: { authorization: "Bearer other", "route-policy": "zdr" } },
    { headers: { authorization: "Bearer k", "x-api-key": "k2", "route-policy": "zdr" } },
    { headers: { authorization: "Bearer k", cookie: "session=1", "route-policy": "zdr" } },
    { headers: { authorization: "Bearer k", "x-tenant-token": "t", "route-policy": "zdr" } },
    { url: `${gateway.base}/chat/completions?key=1` },
    { url: `${new URL(gateway.base).origin}/other/chat/completions` },
    { headers: { authorization: "Bearer k", "route-policy": "zdr+notrain" } },
    { headers: { authorization: "Bearer k" } },
    { headers: [["authorization", "Bearer k"], ["route-policy", "zdr"], ["route-policy", "zdr"]] },
    { body: JSON.stringify({ model: "demo-model", messages: [{ role: "user", content: "secret" }], provider: {} }) },
    { body: `${BODY} ` },
  ];
  for (const variant of variants) await assert.rejects(post(variant), /not released/, JSON.stringify(variant));
  assert.equal(gateway.requests.length, 0);
});

test("C1: headers known not to identify the caller may come and go: each of them, on the wire, still matches the release", async () => {
  const usual = ["accept", "accept-encoding", "accept-language", "content-length", "content-type", "user-agent", "x-stainless-arch", "x-stainless-lang", "x-stainless-os", "x-stainless-package-version", "x-stainless-retry-count", "x-stainless-runtime", "x-stainless-runtime-version", "x-stainless-timeout"];
  watchAll();
  for (const name of usual) {
    const owner = release();
    // fetch computes content-length itself; any value given here is replaced, so the header is still present.
    await (await post({ headers: { authorization: "Bearer k", "route-policy": "zdr", [name]: name === "content-length" ? String(BODY.length) : "x" } })).text();
    assert.equal(owner.completions.length, 1, name);
  }
});

test("C1: the release matches whatever form the headers take: an object in any case, an array, or a Headers", async () => {
  const forms: RequestInit["headers"][] = [
    { authorization: "Bearer k", "route-policy": "zdr" },
    { Authorization: "Bearer k", "Route-Policy": "zdr" },
    { AUTHORIZATION: "Bearer k", "ROUTE-POLICY": "zdr" },
    { aUtHoRiZaTiOn: "Bearer k", "rOuTe-PoLiCy": "zdr" },
    [["authorization", "Bearer k"], ["route-policy", "zdr"]],
    [["Authorization", "Bearer k"], ["ROUTE-POLICY", "zdr"]],
    new Headers({ Authorization: "Bearer k", "Route-Policy": "zdr" }),
  ];
  for (const headers of forms) {
    const owner = release();
    await (await post({ headers })).text();
    assert.equal(owner.completions.length, 1);
  }
});

test("C1: a Request object's own body cannot be compared, so it is not a release", async () => {
  watchAll();
  release();
  const request = new Request(`${gateway.base}/chat/completions`, { method: "POST", headers: { authorization: "Bearer k", "route-policy": "zdr" }, body: BODY });
  await assert.rejects(fetch(request), /not released/);
  assert.equal(gateway.requests.length, 0);
});

test("C1, C5: when two sessions released the same bytes, whose call it is cannot be told, so it is stopped and both are told", async () => {
  const first = release({ owner: { session: 1 } });
  const second = release({ owner: { session: 2 } });
  await assert.rejects(post(), /two sessions released this same request/);
  assert.equal(gateway.requests.length, 0);
  assert.deepEqual([first.stops.length, second.stops.length], [1, 1]);
});

test("C5: of two sessions with requests in flight together, each hears only its own response, the first to leave finishing last", async () => {
  const OTHER = JSON.stringify({ model: "other-model", messages: [] });
  const mine = release({ owner: { session: 1 } });
  const theirs = release({ owner: { session: 2 }, body: OTHER });
  gateway.replies.inference = (request) =>
    request.body === BODY
      ? { status: 200, headers: { "route-applied": "provider=aurora" }, body: {}, delayMs: 200 }
      : { status: 400, headers: { "route-refused": "reason=unsatisfiable" }, body: {}, delayMs: 20 };
  const first = post();
  await until(() => gateway.inference().length === 1);
  await Promise.all([first.then((r) => r.text()), post({ body: OTHER }).then((r) => r.text())]);
  assert.deepEqual(mine.completions.map((c) => [c.status, c.result.applied]), [[200, ["provider=aurora"]]]);
  assert.deepEqual(theirs.completions.map((c) => [c.status, c.result.refused]), [[400, ["reason=unsatisfiable"]]]);
});

test("C1: a released request does not follow a redirect: its body goes nowhere else", async () => {
  const owner = release();
  gateway.replies.inference = { status: 307, headers: { location: `${elsewhere.base}/chat/completions` } };
  const response = await post();
  assert.equal(response.status, 307);
  assert.equal(elsewhere.requests.length, 0);
  assert.equal(owner.completions[0]?.status, 307);
});

test("C3: repeated Route-Applied lines reach the reader as one joined value", async () => {
  const owner = release();
  gateway.replies.inference = { status: 200, headers: { "route-applied": ["provider=aurora", "provider=basalt"] }, body: {} };
  await (await post()).text();
  assert.deepEqual(owner.completions[0]?.result.applied, ["provider=aurora, provider=basalt"]);
});

test("C1, C14: a request goes only where fetch puts it on the wire for the released base URL, and each form that differs there is stopped", async () => {
  // Every POST no release matches is stopped, wherever it goes.
  removals.push(addWatcher({ check: () => "not released", stopped: () => {} }));
  const G = new URL(gateway.base).origin;
  const port = new URL(gateway.base).port;
  // `target` is the request target the gateway receives, or, for a request that must not go, why it is stopped.
  type Row = { name: string; base: string; url: string; target: string | RegExp };
  const rows: Row[] = [
    { name: "trailing slash on the base", base: `${G}/v1/`, url: `${G}/v1/chat/completions`, target: "/v1/chat/completions" },
    { name: "an empty segment after the base", base: `${G}/v1/`, url: `${G}/v1//chat/completions`, target: /not released/ },
    { name: "dot segments, resolved before sending", base: `${G}/v1`, url: `${G}/v1/x/../chat/completions`, target: "/v1/chat/completions" },
    { name: "a percent-encoded path, not decoded", base: `${G}/v1`, url: `${G}/v%31/chat/completions`, target: /not released/ },
    { name: "+ in the query, kept", base: `${G}/v1?q=a+b`, url: `${G}/v1/chat/completions?q=a+b`, target: "/v1/chat/completions?q=a+b" },
    { name: "%20 for +", base: `${G}/v1?q=a+b`, url: `${G}/v1/chat/completions?q=a%20b`, target: /not released/ },
    { name: "percent-encoding case", base: `${G}/v1?q=%2b`, url: `${G}/v1/chat/completions?q=%2B`, target: /not released/ },
    { name: "uppercase scheme, lowercased before sending", base: `${G}/v1`, url: `HTTP://127.0.0.1:${port}/v1/chat/completions`, target: "/v1/chat/completions" },
    { name: "a trailing dot on an IPv4 host, removed before sending", base: `${G}/v1`, url: `http://127.0.0.1.:${port}/v1/chat/completions`, target: "/v1/chat/completions" },
    { name: "a fragment, never sent", base: `${G}/v1`, url: `${G}/v1/chat/completions#part`, target: "/v1/chat/completions" },
    { name: "an empty query before a fragment", base: `${G}/v1?`, url: `${G}/v1/chat/completions?#part`, target: "/v1/chat/completions?" },
    { name: "an empty query dropped", base: `${G}/v1?`, url: `${G}/v1/chat/completions`, target: /not released/ },
    { name: "credentials in the URL", base: `${G}/v1`, url: `http://user:secret@127.0.0.1:${port}/v1/chat/completions`, target: /credentials/ },
  ];
  for (const row of rows) {
    gateway.requests.length = 0;
    const place = placeOf(row.base);
    assert.ok(place !== null, row.name);
    const owner = release({ ...place });
    const sending = fetch(row.url, { method: "POST", headers: { authorization: "Bearer k", "route-policy": "zdr" }, body: BODY });
    if (row.target instanceof RegExp) {
      await assert.rejects(sending, row.target, row.name);
      assert.equal(gateway.requests.length, 0, row.name);
    } else {
      await (await sending).text();
      assert.deepEqual([gateway.requests.map((r) => r.path), owner.completions.length], [[row.target], 1], row.name);
    }
    // An unused release is withdrawn, so each row starts with only its own.
    removals.pop()?.();
  }
});

test("C1, C14: header lines as fetch sends them: repeated lines go as one joined line, and values trimmed, as the release was read", async () => {
  watchAll();
  const owner = release({ context: [["authorization", "Bearer k"], ["x-tenant", "a, b"]] });
  await (await post({ headers: [["Authorization", "  Bearer k  "], ["x-tenant", "a"], ["X-Tenant", "b"], ["route-policy", "zdr"]] })).text();
  assert.equal(owner.completions.length, 1);
  const raw = gateway.inference()[0]?.rawHeaders ?? [];
  const lines = (name: string): string[] => raw.flatMap((value, i) => (i % 2 === 1 && raw[i - 1]?.toLowerCase() === name ? [value] : []));
  assert.deepEqual([lines("x-tenant"), lines("authorization")], [["a, b"], ["Bearer k"]], "one line each, as the metadata reads sent them");
});

test("C1, C14: a base URL is the same place however the parser was handed it, and a different one when the parser keeps the difference", () => {
  const same: [string, string][] = [
    ["HTTP://GateWay.Test/v1", "http://gateway.test/v1"],
    ["http://gateway.test:80/v1", "http://gateway.test/v1"],
    ["https://gateway.test:443/v1", "https://gateway.test/v1"],
    ["http://[0:0:0:0:0:0:0:1]:8/v1", "http://[::1]:8/v1"],
    ["http://gateway.test/a/./b/../v1/", "http://gateway.test/a/v1"],
    ["http://gateway.test/v1#part", "http://gateway.test/v1"],
  ];
  for (const [given, base] of same) assert.deepEqual(placeOf(given), { base, query: "" }, given);
  const different: [string, string][] = [
    ["http://gateway.test./v1", "http://gateway.test/v1"],
    ["http://gateway.test/V1", "http://gateway.test/v1"],
    ["http://gateway.test/%761", "http://gateway.test/v1"],
  ];
  for (const [given, other] of different) assert.notDeepEqual(placeOf(given), placeOf(other), given);
  assert.equal(placeOf("http://user:secret@gateway.test/v1"), null, "credentials in the URL name no place fetch can send to");
});

test("C1: a GET is never stopped, and a POST no watcher claims goes", async () => {
  watchAll();
  await (await fetch(`${gateway.base}/models`)).text();
  await (await post({ url: `${elsewhere.base}/chat/completions` })).text();
  assert.equal(elsewhere.inference().length, 1);
});
