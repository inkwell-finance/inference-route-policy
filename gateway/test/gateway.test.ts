import assert from "node:assert/strict";
import { test } from "node:test";
import { createGateway, ENDPOINTS, type Endpoint, type GatewayConfig, type Route } from "../src/gateway.ts";

const root = "http://gateway.example/v1";
const model = "demo-model";
const evidence = "https://basalt.example:443/attestation?nonce=demo";
const routes: Route[] = [
  { provider: "aurora", url: "http://aurora.example/v1", facts: "zdr+notrain+bits=8+region=us", price: 3, latencyMs: 2, throughput: 30 },
  { provider: "basalt", url: "http://basalt.example/v1", facts: "bits=16+region=us,de+attest=weights,prompt", evidence, model: "upstream-model", apiKey: "upstream-key", price: 1, latencyMs: 3, throughput: 20 },
  { provider: "cobalt", url: "http://cobalt.example/v1", facts: "", price: 2, latencyMs: 1, throughput: 10 },
];
const keys = { open: {}, locked: { policy: "zdr" }, region: { policy: "region=us" }, precise: { policy: "bits=16" }, attest: { policy: "attest=weights" }, preferences: { policy: "sort=price+order=basalt" } };
const resultNames = ["route-applied", "route-refused", "route-evidence"];
const formatBody = (id: string, stream: boolean) => JSON.stringify({ model: id, stream, input: "content" });

interface Recorded {
  provider: string;
  path: string;
  body: string;
  headers: Headers;
  redirect: Request["redirect"];
}

function setup(behavior?: (attempt: Recorded) => Response | Promise<Response>, config?: Partial<GatewayConfig>) {
  const calls: Recorded[] = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const attempt = { provider: url.hostname.split(".")[0]!, path: url.pathname, body: await request.text(), headers: request.headers, redirect: request.redirect };
    calls.push(attempt);
    return behavior === undefined ? new Response(`served by ${attempt.provider}`) : behavior(attempt);
  };
  return { calls, gateway: createGateway({ models: { [model]: routes }, keys, fetch: providerFetch, ...config }) };
}

function inference(endpoint: Endpoint, body: string, key = "open", extra?: RequestInit["headers"]): Request {
  const headers = new Headers(extra);
  headers.set("authorization", `bEaReR ${key}`);
  return new Request(`${root}/${endpoint}`, { method: "POST", body, headers });
}

function noHeaders(response: Response): void {
  for (const name of resultNames) assert.equal(response.headers.get(name), null, name);
}

async function assertRefusal(response: Response, status: number, reason: string) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("route-refused"), reason);
  assert.equal(response.headers.get("route-applied"), null);
  assert.equal(response.headers.get("route-evidence"), null);
  return response.json();
}

for (const endpoint of ENDPOINTS) for (const stream of [false, true]) {
  const mode = `${endpoint}, stream=${stream}`;
  const call = (id = model, key = "open", header?: string) => inference(endpoint, formatBody(id, stream), key, header === undefined ? undefined : { "rOuTe-PoLiCy": header });

  test(`G1 G2 G4 G8 G9 G11 G29 ${mode}: verify carrier order, whole-string limits and no calls on unsupported`, async () => {
    const { gateway, calls } = setup();
    const cases: [string, string | undefined, string][] = [
      [`${model}+only=x,x`, "bits=0", "reason=unsupported+key=bits"],
      [`${model}+bits=0`, "only=x,x", "reason=unsupported+key=only"],
      [`${model}+bits=0`, "zdr", "reason=unsupported+key=bits"],
      [`${model}+unknown`, "only=missing", "reason=unsupported+key=unknown"],
      [`${model}+only=missing`, "bits=0", "reason=unsupported+key=bits"],
      [`${model}+`, undefined, "reason=unsupported"],
      [model, "Bad+bits=0", "reason=unsupported"],
      [model, `bits=0+${"x+".repeat(15)}x`, "reason=unsupported"],
      [model, `bits=0+ignore=${"a".repeat(512)}`, "reason=unsupported"],
      [`${model}+only=basalt+ignore=${"é".repeat(250)}`, undefined, "reason=unsupported"],
      [model, "zdr+zdr", "reason=unsupported+key=zdr"],
      [model, "", "reason=unsupported"],
    ];
    for (const [id, header, reason] of cases) await assertRefusal(await gateway(call(id, "open", header)), 400, reason);
    const repeated = new Headers();
    repeated.append("Route-Policy", "only=aurora");
    repeated.append("rOuTe-PoLiCy", "basalt");
    assert.equal(repeated.get("route-policy"), "only=aurora, basalt");
    await assertRefusal(await gateway(inference(endpoint, formatBody(model, stream), "open", repeated), { repeatedRoutePolicy: true }), 400, "reason=unsupported");
    // A single malformed list is not a transport duplicate and names its own key.
    await assertRefusal(await gateway(call(model, "open", "only=aurora, basalt")), 400, "reason=unsupported+key=only");
    assert.deepEqual(calls, []);
  });

  test(`G3 G4 G10 G11 G12 G13 ${mode}: three carriers narrow, and unsatisfiable sends nothing`, async () => {
    const { gateway, calls } = setup();
    for (const [id, key, header] of [
      [model, "open", "bits=64"], [model, "open", "ignore=aurora,basalt,cobalt"],
      [`${model}+region=de`, "open", "region=us"], [`${model}+only=aurora`, "open", "only=basalt"],
      [`${model}+bits=16`, "open", "zdr"], [`${model}+only=aurora`, "open", "ignore=aurora"],
      [`${model}+only=basalt`, "locked", undefined], [model, "locked", "only=basalt"], [`${model}+bits=16`, "locked", "region=us,de"],
      [`${model}+bits=1`, "precise", "only=aurora"], [`${model}+region=us,de`, "region", "only=basalt"],
      [`${model}+attest=prompt`, "attest", "only=aurora"],
    ] as const) await assertRefusal(await gateway(call(id, key, header)), 400, "reason=unsatisfiable");
    assert.equal(calls.length, 0);
    const bound = await gateway(call(model, "locked"));
    assert.equal(bound.headers.get("route-applied"), "provider=aurora");
    const narrowed = await gateway(call(`${model}+bits=1+only=aurora,basalt`, "locked", "region=us,de+ignore=cobalt"));
    assert.equal(narrowed.headers.get("route-applied"), "provider=aurora");
    assert.deepEqual(calls.map((row) => row.provider), ["aurora", "aurora"]);
  });

  test(`G5 G6 G7 G14 G15 G17 G18 G19 G32 G33 G37 S19 ${mode}: relay only the matching route with owned headers and exactly one top-level model`, async () => {
    const payload = stream ? ["data: served by ", "basalt\n\n"] : ["{\"text\":", "\"served by basalt\"}"];
    const { gateway, calls } = setup(() => {
      let i = 0;
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        const part = payload[i++];
        if (part === undefined) controller.close(); else controller.enqueue(new TextEncoder().encode(part));
      } }), { status: 422, headers: {
        "route-applied": "provider=aurora,provider=cobalt", "route-refused": "reason=unsatisfiable", "route-evidence": "https://other.example/",
        "connection": "x-upstream-hop", "x-upstream-hop": "discard", "x-keep": "yes", "content-type": stream ? "text/event-stream" : "application/json",
      } });
    });
    const raw = String.raw`{"mo\u0064el":false,"tools":[{"model":"caller","model":"nested"}],"large":123456789012345678901,"model":"demo-model+attest=prompt+order=cobalt","stream":${stream}}`;
    const response = await gateway(inference(endpoint, raw, "attest", { "Route-Policy": "bits=16+sort=latency", "x-api-key": "attest", connection: "x-request-hop", "x-request-hop": "discard", "x-keep": "yes", host: "client.example", "content-length": "23" }));
    assert.equal(response.status, 422);
    assert.equal(await response.text(), payload.join(""));
    assert.equal(response.headers.get("route-applied"), "provider=basalt");
    assert.equal(response.headers.get("route-evidence"), evidence);
    assert.equal(response.headers.get("route-refused"), null);
    assert.equal(response.headers.get("x-upstream-hop"), null);
    assert.equal(response.headers.get("x-keep"), "yes");
    assert.deepEqual(calls.map((row) => row.provider), ["basalt"]);
    const [upstream] = calls;
    assert.ok(upstream);
    assert.equal(upstream.path, `/v1/${endpoint}`);
    assert.equal(upstream.body, `{"model":"upstream-model","tools":[{"model":"caller","model":"nested"}],"large":123456789012345678901,"stream":${stream}}`);
    for (const name of ["route-policy", "connection", "x-request-hop", "host", "content-length"]) assert.equal(upstream.headers.get(name), null, name);
    assert.equal(upstream.headers.get("x-keep"), "yes");
    assert.equal(upstream.headers.get("authorization"), endpoint === "messages" ? null : "Bearer upstream-key");
    assert.equal(upstream.headers.get("x-api-key"), endpoint === "messages" ? "upstream-key" : null);
    assert.equal(upstream.redirect, "manual");

    const published = await gateway(new Request(`${root}/models`));
    assert.deepEqual(await published.json(), { object: "list", data: [{ id: model, routes: routes.map(({ provider, facts, evidence }) => ({ provider, facts, ...(evidence === undefined ? {} : { evidence }) })) }] });
    const noAttest = await gateway(call(model, "open", "only=basalt"));
    assert.equal(noAttest.headers.get("route-evidence"), null);
    assert.deepEqual(calls.map((row) => row.provider), ["basalt", "basalt"]);
  });

  test(`G5 G16 G26 G33 G34 G35 G37 G39 ${mode}: retry eligible failures; without policy keep the relayed status and omit refusal and evidence`, async () => {
    const { gateway, calls } = setup(({ provider }) => {
      if (provider === "aurora") return new Response("do not relay 429", { status: 429 });
      if (provider === "basalt") throw new TypeError("network error");
      return new Response("upstream result", { status: 418, headers: { "route-refused": "reason=unsupported", "route-evidence": evidence, "route-applied": "provider=basalt" } });
    });
    const restricted = await gateway(call(`${model}+only=basalt,aurora+sort=price`, "open", "order=aurora,cobalt"));
    const error = await assertRefusal(restricted, 503, "reason=unavailable");
    assert.deepEqual(error, endpoint === "messages" ? { type: "error", error: { type: "overloaded_error", message: "Route policy unavailable" } } : { error: { type: "overloaded_error", message: "Route policy unavailable" } });
    assert.deepEqual(calls.splice(0).map((row) => row.provider), ["aurora", "basalt"]);
    const relayed = await gateway(call(model, "open", "sort=price"));
    assert.equal(relayed.headers.get("route-applied"), "provider=cobalt");
    assert.equal(relayed.status, 418);
    assert.equal(await relayed.text(), "upstream result");
    assert.deepEqual(calls.splice(0).map((row) => row.provider), ["basalt", "cobalt"]);
    const plain = await gateway(call());
    assert.equal(plain.headers.get("route-refused"), null);
    assert.equal(plain.headers.get("route-evidence"), null);
    assert.equal(plain.status, 418);
    assert.equal(await plain.text(), "upstream result");
    assert.deepEqual(calls.splice(0).map((row) => row.provider), ["aurora", "basalt", "cobalt"]);
    const allFail = setup(() => new Response("private provider error", { status: 502 }));
    const failure = await allFail.gateway(call());
    assert.equal(failure.headers.get("route-refused"), null);
    assert.equal(failure.headers.get("route-evidence"), null);
    assert.equal(failure.status, 503);
    assert.doesNotMatch(await failure.text(), /private provider error/);
    const qualified = await allFail.gateway(call(model, "open", "only=basalt"));
    await assertRefusal(qualified, 503, "reason=unavailable");
    assert.deepEqual(allFail.calls.map((row) => row.provider), ["aurora", "basalt", "cobalt", "basalt"]);
  });

  test(`G24 G25 G31 G34 S19 ${mode}: unknown provider semantics, own errors before all policy checks, normal error envelopes`, async () => {
    const { gateway, calls } = setup();
    const requestWithInvalidHeader = (body: string, key = "open") => inference(endpoint, body, key, { "Route-Policy": "bits=0" });
    const cases: [string, string, number][] = [
      [formatBody(`${model}+bits=0`, stream), "wrong", 401], ["{", "open", 400], ["null", "open", 400], ["[]", "open", 400],
      ['{"model":7}', "open", 400], ['{"model":"demo-model","model":7}', "open", 400], ["{}", "open", 400],
      [formatBody("unknown+bits=0", stream), "open", 404], [formatBody("+bits=0", stream), "open", 404],
    ];
    for (const [body, key, status] of cases) {
      const ordinary = await gateway(inference(endpoint, body, key));
      const invalid = await gateway(requestWithInvalidHeader(body, key), { repeatedRoutePolicy: true });
      noHeaders(ordinary);
      noHeaders(invalid);
      assert.equal(ordinary.status, status);
      assert.equal(invalid.status, status);
      assert.deepEqual(await ordinary.json(), await invalid.json());
    }
    const conflict = await gateway(inference(endpoint, formatBody(model, stream), "open", { "x-api-key": "locked", "Route-Policy": "only=basalt" }));
    assert.equal(conflict.status, 401);
    noHeaders(conflict);
    const unsatisfied = await assertRefusal(await gateway(call(model, "open", "only=missing")), 400, "reason=unsatisfiable");
    const unsupported = await assertRefusal(await gateway(call(model, "open", "bits=0")), 400, "reason=unsupported+key=bits");
    for (const [body, message] of [[unsatisfied, "Route policy unsatisfiable"], [unsupported, "Route policy unsupported"]] as const) {
      const error = { error: { type: "invalid_request_error", message } };
      assert.deepEqual(body, endpoint === "messages" ? { type: "error", ...error } : error);
    }
    assert.equal(calls.length, 0);
    for (const [policy, provider] of [
      ["ignore=missing", "aurora"], ["ignore=missing,aurora", "basalt"], ["order=missing,basalt", "basalt"],
    ]) {
      const valid = await gateway(call(model, "open", policy));
      assert.equal(valid.headers.get("route-applied"), `provider=${provider}`);
    }
    assert.deepEqual(calls.map((row) => row.provider), ["aurora", "basalt", "basalt"]);
  });
}

test("G20 G21 G22 G23 G38: advertise the actual subset, publish independent facts, reveal only the supplied key's policy", async () => {
  const { gateway } = setup(undefined, { accept: { keys: ["zdr", "sort", "attest", "only", "bits", "region", "ignore", "order"], attest: ["weights"], sort: ["price"] }, keys: { open: {}, locked: { policy: "sort=price+zdr" } } });
  const detection = { route_policy: "1", keys: ["zdr", "sort", "attest", "only", "bits", "region", "ignore", "order"], attest: ["weights"], sort: ["price"] };
  for (const [headers, expected] of [
    [{}, detection], [{ authorization: "Bearer unknown" }, detection], [{ authorization: "Bearer open" }, detection],
    [{ "x-api-key": "locked" }, { ...detection, key_policy: "sort=price+zdr" }],
    [{ authorization: "Bearer locked" }, { ...detection, key_policy: "sort=price+zdr" }],
  ] as const) {
    const response = await gateway(new Request(`${root}/route-policy`, { headers }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
  }
  const models: unknown = await (await gateway(new Request(`${root}/models`))).json();
  assert.match(JSON.stringify(models), /zdr\+notrain\+bits=8\+region=us/);
  assert.match(JSON.stringify(models), /attest=weights,prompt/);
  for (const [policy, key] of [["notrain", "notrain"], ["attest=prompt", "attest"], ["attest=weights,prompt", "attest"], ["sort=latency", "sort"]]) {
    await assertRefusal(await gateway(inference("chat/completions", formatBody(model, false), "open", { "Route-Policy": policy! })), 400, `reason=unsupported+key=${key}`);
  }
  for (const policy of ["bits=64", "region=jp,de", "only=0,a-b_c.d", "ignore=0,a-b_c.d", "order=0,a-b_c.d", "attest=weights", "sort=price"]) {
    const response = await gateway(inference("chat/completions", formatBody(model, false), "open", { "Route-Policy": policy }));
    assert.ok(!response.headers.get("route-refused")?.includes("unsupported"));
  }
});

test("G36 G32: reject invalid configuration at startup and keep the validated route facts independent of caller mutation", async () => {
  const route = routes[0]!;
  for (const invalid of [
    null, [], {}, { models: null }, { models: { "": [route] } }, { models: { "x+zdr": [route] } }, { models: { x: {} } },
    { models: { x: [route, route] } }, { models: { x: [{ ...route, provider: "Aurora" }] } },
    { models: { x: [{ ...route, facts: "zdr+unknown" }] } }, { models: { x: [{ ...route, facts: [] }] } },
    { models: { x: [{ ...route, facts: "attest=weights" }] } }, { models: { x: [{ ...route, evidence: "http://a.example/" }] } },
    { models: { x: [{ ...route, url: "ftp://aurora.example/v1" }] } }, { models: { x: [{ ...route, url: "https://aurora.example/v1?" }] } },
    { models: { x: [{ ...route, url: "https://username@aurora.example/v1" }] } }, { models: { x: [{ ...route, url: "https://aurora.example/v2" }] } },
    { models: { x: [{ ...route, price: NaN }] } }, { models: { x: [{ ...route, latencyMs: -1 }] } }, { models: { x: [{ ...route, throughput: "4" }] } },
    { models: { x: [{ ...route, apiKey: "key\r\nOther: bad" }] } }, { models: { x: [{ ...route, model: "" }] } },
    ...[null, "", "bits=01", "zdr+zdr", "later", `ignore=${"a".repeat(512)}`].map((policy) => ({ models: {}, keys: { k: { policy } } })),
    { models: {}, keys: { k: { policy: "attest=prompt" } }, accept: { attest: ["weights"] } },
    { models: {}, keys: { k: { policy: "zdr" } }, accept: { keys: ["only"] } },
    { models: {}, accept: { keys: ["later"] } }, { models: {}, accept: { sort: "price" } }, { models: {}, fetch: "fetch" },
  ]) assert.throws(() => createGateway(invalid), Error, JSON.stringify(invalid));

  const mutable = { ...route, facts: "zdr" };
  const { gateway, calls } = setup(undefined, { models: { [model]: [mutable] } });
  mutable.facts = "";
  mutable.provider = "unexpected";
  const list = await (await gateway(new Request(`${root}/models`))).json();
  assert.deepEqual(list, { object: "list", data: [{ id: model, routes: [{ provider: "aurora", facts: "zdr" }] }] });
  assert.equal((await gateway(inference("chat/completions", formatBody(model, false), "locked"))).headers.get("route-applied"), "provider=aurora");
  assert.deepEqual(calls.map((row) => row.provider), ["aurora"]);
});

test("G11 G35: sort keys and explicit order rank every retry, with suffix over header over key per preference", async () => {
  const { gateway, calls } = setup(() => new Response("retry", { status: 500 }));
  for (const [suffix, key, header, expected] of [
    ["sort=price", "open", undefined, ["basalt", "cobalt", "aurora"]],
    ["sort=latency", "open", undefined, ["cobalt", "aurora", "basalt"]],
    ["sort=throughput", "open", undefined, ["aurora", "basalt", "cobalt"]],
    ["order=aurora", "open", "sort=price", ["aurora", "basalt", "cobalt"]],
    ["sort=latency", "preferences", "order=aurora+sort=throughput", ["aurora", "cobalt", "basalt"]],
    ["order=cobalt", "preferences", "order=aurora+sort=throughput", ["cobalt", "aurora", "basalt"]],
    ["order=cobalt,basalt", "open", "sort=throughput", ["cobalt", "basalt", "aurora"]],
  ] as const) {
    const response = await gateway(inference("chat/completions", formatBody(`${model}+${suffix}`, false), key, header === undefined ? undefined : { "Route-Policy": header }));
    await assertRefusal(response, 503, "reason=unavailable");
    assert.deepEqual(calls.splice(0).map(({ provider }) => provider), expected);
  }
});
