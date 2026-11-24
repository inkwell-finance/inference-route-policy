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
const hopHeaders = {
  connection: "x-hop-first, X-Hop-Second", "x-hop-first": "discard", "x-hop-second": "discard",
  "keep-alive": "timeout=5", "proxy-connection": "keep-alive", "proxy-authenticate": "Basic realm=proxy",
  "proxy-authorization": "Basic ZGVtbw==", te: "trailers", trailer: "x-end", "transfer-encoding": "chunked", upgrade: "websocket",
};
const catalog = (entries: readonly Route[]) => ({ object: "list", data: [{ id: model, routes: entries.map(({ provider, facts, evidence }) =>
  ({ provider, facts, ...(evidence === undefined ? {} : { evidence }) })) }] });
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
  return response.json().catch((error: unknown) => assert.fail(`expected the gateway's JSON refusal body: ${String(error)}`));
}

const delta: Route = { ...routes[2]!, provider: "delta", url: "http://delta.example/v1", facts: "region=de+attest=prompt",
  evidence: "https://delta.example/report" };

for (const endpoint of ENDPOINTS) for (const stream of [false, true]) {
  const mode = `${endpoint}, stream=${stream}`;
  const call = (id = model, key = "open", header?: string) => inference(endpoint, formatBody(id, stream), key, header === undefined ? undefined : { "rOuTe-PoLiCy": header });

  test(`G2 ${mode}: a bits=0 header names bits ahead of a malformed only suffix`, async () => {
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

  test(`G4 ${mode}: a bits=0 header returns unsupported before a provider attempt`, async () => {
    const { gateway, calls } = setup();
    await assertRefusal(await gateway(call(model, "open", "bits=0")), 400, "reason=unsupported+key=bits");
    assert.deepEqual(calls, []);
  });

  test(`G12 ${mode}: a region=us header and region=de suffix refuse before a provider attempt`, async () => {
    const { gateway, calls } = setup(undefined, { models: { [model]: [...routes, delta] } });
    for (const [id, key, header] of [
      [model, "open", "bits=64"], [model, "open", "ignore=aurora,basalt,cobalt,delta"],
      [`${model}+region=de`, "open", "region=us"], [`${model}+only=aurora`, "open", "only=basalt"],
      [`${model}+region=us`, "open", "region=de"], [`${model}+only=basalt`, "open", "only=aurora"],
      [`${model}+bits=16`, "open", "zdr"], [`${model}+only=aurora`, "open", "ignore=aurora"],
      [`${model}+only=basalt`, "locked", undefined], [model, "locked", "only=basalt"], [`${model}+bits=16`, "locked", "region=us,de"],
      [model, "attest", "only=aurora"],
    ] as const) await assertRefusal(await gateway(call(id, key, header)), 400, "reason=unsatisfiable");
    assert.equal(calls.length, 0);
    for (const [id, key, header, provider] of [
      [model, "open", "region=us", "aurora"], [`${model}+region=de`, "open", undefined, "delta"],
    ] as const) {
      const relayed = await gateway(call(id, key, header));
      assert.equal(relayed.headers.get("route-applied"), `provider=${provider}`);
    }
    const narrowed = await gateway(call(`${model}+bits=1+only=aurora,basalt`, "locked", "region=us,de+ignore=cobalt"));
    assert.equal(narrowed.headers.get("route-applied"), "provider=aurora");
    assert.deepEqual(calls.map((row) => row.provider), ["aurora", "delta", "aurora"]);
  });

  for (const [key, requirement, provider] of [
    ["precise", "bits=1", "aurora"], ["region", "region=us,de", "basalt"],
    ["attest", "attest=prompt", "delta"], ["pinned", "only=basalt", "basalt"],
  ] as const) for (const carrier of ["header", "suffix"] as const) {
    const text = requirement.startsWith("only=") ? requirement : `${requirement}+only=${provider}`;
    test(`G13 ${mode}: ${key} plus ${carrier} ${text} refuses before reaching ${provider}`, async () => {
      const { gateway, calls } = setup(undefined, {
        keys: { ...keys, pinned: { policy: "only=aurora" } }, models: { [model]: [...routes, delta] },
      });
      await assertRefusal(await gateway(call(carrier === "suffix" ? `${model}+${text}` : model, key, carrier === "header" ? text : undefined)),
        400, "reason=unsatisfiable");
      assert.equal(calls.length, 0);
      const control = await gateway(call(model, "open", text));
      assert.equal(control.headers.get("route-applied"), `provider=${provider}`);
      assert.deepEqual(calls.map((row) => row.provider), [provider]);
    });
  }

  for (const carrier of ["authorization", "x-api-key"] as const) for (const [key, provider] of [["locked", "aurora"], ["precise", "basalt"]] as const) {
    test(`G10 ${mode}: ${carrier} with ${key} and no explicit policy calls ${provider}`, async () => {
      const { gateway, calls } = setup(undefined, { models: { [model]: [routes[2]!, ...routes.slice(0, 2)] } });
      const headers = new Headers({ [carrier]: carrier === "authorization" ? `Bearer ${key}` : key });
      const response = await gateway(new Request(`${root}/${endpoint}`, { method: "POST", headers, body: formatBody(model, stream) }));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("route-applied"), `provider=${provider}`);
      assert.deepEqual(calls.map((row) => row.provider), [provider]);
    });
  }

  test(`G14 ${mode}: the basalt override rewrites duplicate top-level model fields but preserves nested model bytes`, async () => {
    const payload = stream ? ["data: served by ", "basalt\n\n"] : ["{\"text\":", "\"served by basalt\"}"];
    const { gateway, calls } = setup(() => {
      let i = 0;
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        const part = payload[i++];
        if (part === undefined) controller.close(); else controller.enqueue(new TextEncoder().encode(part));
      } }), { status: 422, headers: {
        "route-applied": "provider=aurora,provider=cobalt", "route-refused": "reason=unsatisfiable", "route-evidence": "https://other.example/",
        ...hopHeaders, "x-keep": "yes", "content-type": stream ? "text/event-stream" : "application/json", "content-length": "999",
      } });
    });
    const raw = String.raw`{"mo\u0064el":false,"tools":[{"model":"caller","model":"nested"}],"large":123456789012345678901,"model":"demo-model+attest=prompt+order=cobalt","stream":${stream}}`;
    const response = await gateway(inference(endpoint, raw, "attest", {
      ...hopHeaders, "Route-Policy": "bits=16+sort=latency", "x-api-key": "attest", "x-keep": "yes",
      host: "client.example", "content-length": "23", expect: "100-continue", "content-encoding": "gzip", "accept-encoding": "br",
    }));
    assert.equal(response.status, 422);
    assert.equal(await response.text(), payload.join(""));
    assert.equal(response.headers.get("route-applied"), "provider=basalt");
    assert.equal(response.headers.get("route-evidence"), evidence);
    assert.equal(response.headers.get("route-refused"), null);
    for (const name of [...Object.keys(hopHeaders), "content-length"]) assert.equal(response.headers.get(name), null, name);
    assert.equal(response.headers.get("x-keep"), "yes");
    assert.deepEqual(calls.map((row) => row.provider), ["basalt"]);
    const [upstream] = calls;
    assert.ok(upstream);
    assert.equal(upstream.path, `/v1/${endpoint}`);
    assert.equal(upstream.body, `{"model":"upstream-model","tools":[{"model":"caller","model":"nested"}],"large":123456789012345678901,"stream":${stream}}`);
    for (const name of [...Object.keys(hopHeaders), "route-policy", "host", "content-length", "expect", "content-encoding"]) {
      assert.equal(upstream.headers.get(name), null, name);
    }
    assert.equal(upstream.headers.get("accept-encoding"), "identity");
    assert.equal(upstream.headers.get("x-keep"), "yes");
    assert.equal(upstream.headers.get("authorization"), endpoint === "messages" ? null : "Bearer upstream-key");
    assert.equal(upstream.headers.get("x-api-key"), endpoint === "messages" ? "upstream-key" : null);
    assert.equal(upstream.redirect, "manual");

    const published = await gateway(new Request(`${root}/models`));
    assert.deepEqual(await published.json(), catalog(routes));
    const noAttest = await gateway(call(model, "open", "only=basalt"));
    assert.equal(noAttest.headers.get("route-evidence"), null);
    const keyOnly = await gateway(call(model, "attest"));
    assert.equal(keyOnly.headers.get("route-applied"), "provider=basalt");
    assert.equal(keyOnly.headers.get("route-evidence"), evidence);
    const defaultModel = await gateway(call(`${model}+only=aurora`));
    assert.equal(defaultModel.headers.get("route-applied"), "provider=aurora");
    assert.equal(calls[3]!.body, JSON.stringify({ model, stream, input: "content" }));
    const plain = await gateway(call());
    noHeaders(plain);
    assert.deepEqual(calls.map((row) => row.provider), ["basalt", "basalt", "basalt", "aurora", "aurora"]);
  });

  test(`G37 ${mode}: a basalt network error leaves the relayed cobalt 418 attributed to cobalt`, async () => {
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
    assert.equal(plain.headers.get("route-applied"), null);
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

  test(`G5 ${mode}: after eligible Aurora 429 and Basalt network errors, excluded Cobalt is not tried`, async () => {
    const { gateway, calls } = setup(({ provider }) => {
      if (provider === "aurora") return new Response("retry", { status: 429 });
      if (provider === "basalt") throw new TypeError("network error");
      return new Response("incorrect fallback");
    });
    await assertRefusal(await gateway(call(`${model}+only=aurora,basalt`)), 503, "reason=unavailable");
    assert.deepEqual(calls.map(({ provider }) => provider), ["aurora", "basalt"]);
  });

  test(`G39 ${mode}: without a policy, Aurora's HTTP 418 and body are relayed unchanged`, async () => {
    const { gateway, calls } = setup(() => new Response("upstream result", { status: 418 }));
    const response = await gateway(call());
    assert.equal(response.status, 418);
    assert.equal(await response.text(), "upstream result");
    assert.deepEqual(calls.map(({ provider }) => provider), ["aurora"]);
    noHeaders(response);
  });

  test(`G25 ${mode}: a numeric model remains a headerless 400 with policy-header repetition flagged`, async () => {
    const { gateway, calls } = setup();
    const requestWithInvalidHeader = (body: string, key = "open") => inference(endpoint, body, key, { "Route-Policy": "bits=0" });
    const cases: [string, string, number][] = [
      [formatBody(`${model}+bits=0`, stream), "wrong", 401], ["{", "open", 400], ["null", "open", 400], ["[]", "open", 400],
      [`{"model":7,"stream":${stream}}`, "open", 400], [`{"model":"demo-model","model":7,"stream":${stream}}`, "open", 400], ["{}", "open", 400],
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

  test(`G31 ${mode}: the unknown model with bits=0 returns 404 without forwarding`, async () => {
    const { gateway, calls } = setup();
    const response = await gateway(call("unknown+bits=0"));
    assert.equal(response.status, 404);
    noHeaders(response);
    assert.deepEqual(calls, []);
  });

  for (const [reason, status, policy, key, errorType] of [
    ["unsupported", 400, "bits=0", "+key=bits", "invalid_request_error"],
    ["unsatisfiable", 400, "only=missing", "", "invalid_request_error"],
    ["unavailable", 503, "only=aurora", "", "overloaded_error"],
  ] as const) test(`G34 ${mode}: a ${reason} refusal uses the malformed-request error shape and media type`, async () => {
    const { gateway, calls } = setup(() => new Response("upstream failed", { status: 502 }));
    const malformed = await gateway(inference(endpoint, "{"));
    const refusal = await gateway(call(model, "open", policy));
    const error = (type: string, message: string) => endpoint === "messages"
      ? { type: "error", error: { type, message } } : { error: { type, message } };
    assert.deepEqual(
      [
        [malformed.status, malformed.headers.get("content-type"), malformed.headers.get("route-refused"), await malformed.json()],
        [refusal.status, refusal.headers.get("content-type"), refusal.headers.get("route-refused"), await refusal.json()],
        calls.map(({ provider }) => provider),
      ],
      [
        [400, "application/json", null, error("invalid_request_error", "Expected a JSON body")],
        [status, "application/json", `reason=${reason}${key}`, error(errorType, `Route policy ${reason}`)],
        reason === "unavailable" ? ["aurora"] : [],
      ],
    );
  });
}

test("G38: the locked and precise credentials return different key_policy strings at detection", async () => {
  const { gateway } = setup(undefined, {
    accept: { keys: ["zdr", "sort", "attest", "only", "bits", "region", "ignore", "order"], attest: ["weights"], sort: ["price"] },
    keys: { open: {}, locked: { policy: "sort=price+zdr" }, precise: { policy: "bits=16" } },
  });
  const detection = { route_policy: "1", keys: ["zdr", "sort", "attest", "only", "bits", "region", "ignore", "order"], attest: ["weights"], sort: ["price"] };
  for (const [headers, expected] of [
    [{}, detection], [{ authorization: "Bearer unknown" }, detection], [{ authorization: "Bearer open" }, detection],
    [{ "x-api-key": "locked" }, { ...detection, key_policy: "sort=price+zdr" }],
    [{ authorization: "Bearer locked" }, { ...detection, key_policy: "sort=price+zdr" }],
    [{ "x-api-key": "precise" }, { ...detection, key_policy: "bits=16" }],
    [{ authorization: "Bearer precise" }, { ...detection, key_policy: "bits=16" }],
  ] as const) {
    const response = await gateway(new Request(`${root}/route-policy`, { headers }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
  }
  const models: unknown = await (await gateway(new Request(`${root}/models`))).json();
  assert.deepEqual(models, catalog(routes));
  for (const [policy, key] of [["notrain", "notrain"], ["attest=prompt", "attest"], ["attest=weights,prompt", "attest"], ["sort=latency", "sort"]]) {
    await assertRefusal(await gateway(inference("chat/completions", formatBody(model, false), "open", { "Route-Policy": policy! })), 400, `reason=unsupported+key=${key}`);
  }
  for (const [policy, provider] of [
    ["bits=64", null], ["region=jp,de", null], ["only=0,a-b_c.d", null], ["ignore=0,a-b_c.d", "aurora"],
    ["order=0,a-b_c.d", "aurora"], ["attest=weights", "basalt"], ["sort=price", "basalt"],
  ] as const) {
    const response = await gateway(inference("chat/completions", formatBody(model, false), "open", { "Route-Policy": policy }));
    if (provider === null) await assertRefusal(response, 400, "reason=unsatisfiable");
    else {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("route-refused"), null);
      assert.equal(response.headers.get("route-applied"), `provider=${provider}`);
    }
  }
});

test("G36: a key policy containing bits=01 fails gateway creation with an invalid-policy error", async () => {
  const route = routes[0]!;
  const withRoute = (patch: object) => ({ models: { x: [{ ...route, ...patch }] } });
  const withPolicy = (policy: unknown) => ({ models: {}, keys: { k: { policy } } });
  for (const [invalid, message] of [
    [null, /^config must be an object$/], [[], /^config must be an object$/],
    [{}, /^models must be an object$/], [{ models: null }, /^models must be an object$/],
    [{ models: { "": [route] } }, /^invalid model id$/], [{ models: { "x+zdr": [route] } }, /^invalid model id$/],
    [{ models: { x: {} } }, /^model routes must be a list$/],
    [{ models: { x: [route, route] } }, /^invalid or repeated provider for model x$/],
    [withRoute({ provider: "Aurora" }), /^invalid or repeated provider for model x$/],
    [withRoute({ facts: "zdr+unknown" }), /^invalid route facts:/], [withRoute({ facts: [] }), /^route facts must be a string$/],
    [withRoute({ facts: "attest=weights" }), /^invalid or missing evidence URI$/],
    [withRoute({ evidence: "http://a.example/" }), /^invalid or missing evidence URI$/],
    ...["ftp://aurora.example/v1", "https://aurora.example/v1?", "https://aurora.example/v1?x=/v1", "https://aurora.example/v2"]
      .map((url) => [withRoute({ url }), /^provider url must be an HTTP\(S\) base URL ending in \/v1$/] as const),
    [withRoute({ url: "https://username@aurora.example/v1" }), /^invalid provider base URL$/],
    [withRoute({ price: NaN }), /^price must be a finite nonnegative number$/],
    [withRoute({ latencyMs: -1 }), /^latencyMs must be a finite nonnegative number$/],
    [withRoute({ throughput: "4" }), /^throughput must be a finite nonnegative number$/],
    [withRoute({ apiKey: "key\r\nOther: bad" }), /^invalid provider apiKey$/],
    [withRoute({ model: "" }), /^invalid provider model id$/],
    [{ models: {}, keys: { "bad key": {} } }, /^invalid gateway key$/],
    [withPolicy(null), /^key policy must be a string$/],
    ...["", "bits=01", "zdr+zdr", "later", `ignore=${"a".repeat(512)}`].map((policy) => [withPolicy(policy), /^invalid key policy:/] as const),
    [{ ...withPolicy("attest=prompt"), accept: { attest: ["weights"] } }, /^invalid key policy:/],
    [{ ...withPolicy("zdr"), accept: { keys: ["only"] } }, /^invalid key policy:/],
    [{ models: {}, accept: { keys: ["later"] } }, /^invalid accept.keys entry$/],
    [{ models: {}, accept: { keys: ["zdr", "zdr"] } }, /^invalid accept.keys entry$/],
    [{ models: {}, accept: { sort: "price" } }, /^accept.sort must be a list$/],
    [{ models: {}, fetch: "fetch" }, /^fetch must be a function$/],
  ] as const) assert.throws(() => createGateway(invalid), { name: "TypeError", message }, JSON.stringify(invalid));
});

test("G32: mutating the loaded Aurora route to empty facts leaves both publication and zdr routing unchanged", async () => {
  const mutable = { ...routes[0]!, facts: "zdr" };
  const { gateway, calls } = setup(undefined, { models: { [model]: [mutable] } });
  mutable.facts = "";
  mutable.provider = "unexpected";
  const list = await (await gateway(new Request(`${root}/models`))).json();
  assert.deepEqual(list, { object: "list", data: [{ id: model, routes: [{ provider: "aurora", facts: "zdr" }] }] });
  assert.equal((await gateway(inference("chat/completions", formatBody(model, false), "locked"))).headers.get("route-applied"), "provider=aurora");
  assert.deepEqual(calls.map((row) => row.provider), ["aurora"]);
});

test("G35: suffix sort=latency orders cobalt before basalt after the header puts aurora first", async () => {
  const { gateway, calls } = setup(() => new Response("retry", { status: 500 }));
  for (const [suffix, key, header, expected] of [
    [undefined, "preferences", undefined, ["basalt", "cobalt", "aurora"]],
    [undefined, "preferences", "sort=throughput", ["basalt", "aurora", "cobalt"]],
    [undefined, "preferences", "order=cobalt", ["cobalt", "basalt", "aurora"]],
    ["sort=price", "open", undefined, ["basalt", "cobalt", "aurora"]],
    ["sort=latency", "open", undefined, ["cobalt", "aurora", "basalt"]],
    ["sort=throughput", "open", undefined, ["aurora", "basalt", "cobalt"]],
    ["order=aurora", "open", "sort=price", ["aurora", "basalt", "cobalt"]],
    ["sort=latency", "preferences", "order=aurora+sort=throughput", ["aurora", "cobalt", "basalt"]],
    ["order=cobalt", "preferences", "order=aurora+sort=throughput", ["cobalt", "aurora", "basalt"]],
    ["order=cobalt,basalt", "open", "sort=throughput", ["cobalt", "basalt", "aurora"]],
  ] as const) {
    const id = suffix === undefined ? model : `${model}+${suffix}`;
    const response = await gateway(inference("chat/completions", formatBody(id, false), key, header === undefined ? undefined : { "Route-Policy": header }));
    await assertRefusal(response, 503, "reason=unavailable");
    assert.deepEqual(calls.splice(0).map(({ provider }) => provider), expected);
  }
});
