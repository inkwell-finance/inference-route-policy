import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as relayRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { formatApplied, formatRefused, REFUSAL_STATUS, splitModel, type RefusalReason } from "../../core/src/index.ts";
import { startDemo } from "../../gateway/src/demo.ts";
import { createGateway, type RequestHandler, type Route } from "../../gateway/src/gateway.ts";
import { serve } from "../../gateway/src/serve.ts";
import { INFERENCE_ENDPOINTS, runConformance, type Endpoint } from "../src/suite.ts";

const key = "probe-key";
const policyKey = "probe-policy-key";
const model = "other/example-model.v2";
const refusal = "route-refused";
const applied = "route-applied";
const evidence = "route-evidence";
const idList = ["G1", "G2", "G3", "G6", "G7", "G8", "G9", "G10", "G11", "G12", "G13", "G15", "G17", "G19", "G20", "G21", "G22", "G23", "G24", "G25", "G26", "G29", "G34"] as const;
type Id = (typeof idList)[number];

const published = [
  { provider: "aurora", facts: "zdr+notrain+bits=8+region=us" },
  { provider: "basalt", facts: "bits=16+region=us,de+attest=weights,prompt", evidence: "https://basalt.example/attestation" },
  { provider: "cobalt", facts: "" },
];
const routes: Route[] = published.map((route, i) => ({ ...route, url: `https://${route.provider}.example/v1`, price: i + 1, latencyMs: 4 - i, throughput: i + 1 }));
const good = createGateway({
  models: { [model]: routes }, keys: { [key]: {}, [policyKey]: { policy: "zdr" } },
  fetch: (url: string) => Response.json({ text: `served by ${new URL(url).hostname}` }),
});

const unavailableGateway = createGateway({
  models: { [model]: routes }, keys: { [key]: {}, [policyKey]: { policy: "zdr" } },
  fetch: () => new Response("provider failure", { status: 503 }),
});

interface Exchange {
  request: Request;
  transport: Parameters<RequestHandler>[1];
  headers: Headers;
  path: string;
  header: string | null;
  suffix: string | null;
  id: string;
  body: Record<string, unknown>;
  auth: string | null;
  next: () => Promise<Response>;
  rewrite: (options: { header?: string | null; suffix?: string | null; neutralKey?: boolean }) => Promise<Response>;
}
type Mutation = (exchange: Exchange) => Promise<Response> | Response;

function change(response: Response, { status = response.status, replace = {}, body = response.body }: { status?: number; replace?: Record<string, string | null>; body?: string | Response["body"] }): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(replace)) {
    if (value === null) headers.delete(name); else headers.set(name, value);
  }
  return new Response(body, { status, headers });
}

function fixture(mutate: Mutation, target = good): RequestHandler {
  return async (request, transport) => {
    const path = new URL(request.url).pathname;
    const decoded: unknown = request.method === "POST" ? await request.clone().json().catch(() => null) : null;
    const body = typeof decoded === "object" && decoded !== null && !Array.isArray(decoded) ? Object.fromEntries(Object.entries(decoded)) : {};
    const { id, policy: suffix } = splitModel(typeof body.model === "string" ? body.model : "");
    const headers = new Headers(request.headers);
    const header = headers.get("route-policy");
    const auth = headers.get("authorization") ?? headers.get("x-api-key");
    const next = () => target(request, transport);
    const rewrite: Exchange["rewrite"] = (edit) => {
      const changed = new Headers(headers);
      if (edit.header === null) changed.delete("route-policy");
      else if (edit.header !== undefined) changed.set("route-policy", edit.header);
      if (edit.neutralKey) {
        if (changed.has("x-api-key")) changed.set("x-api-key", key);
        if (changed.has("authorization")) changed.set("authorization", `Bearer ${key}`);
      }
      const replaced = edit.suffix === undefined ? body : { ...body, model: edit.suffix === null ? id : `${id}+${edit.suffix}` };
      return target(new Request(request.url, { method: request.method, headers: changed, body: JSON.stringify(replaced) }));
    };
    return mutate({ request, transport, headers, path, header, suffix, id, body, auth, next, rewrite });
  };
}

const faults: Record<Id, Mutation> = {
  G1: ({ header, next, rewrite }) => header === "zdr++notrain" ? rewrite({ header: "zdr" }) : next(),
  G2: async ({ header, next }) => {
    const reply = await next();
    return header === "bits=0+only=a,a" ? change(reply, { replace: { [refusal]: formatRefused("unsupported", "only") } }) : reply;
  },
  G3: async ({ header, suffix, next }) => {
    const reply = await next();
    return header === "bits=64" && suffix === null ? change(reply, { status: 503, replace: { [refusal]: formatRefused("unavailable") } }) : reply;
  },
  G6: async ({ header, next }) => {
    const reply = await next();
    return header === "bits=1" ? change(reply, { replace: { [applied]: formatApplied("cobalt") } }) : reply;
  },
  G7: ({ header, next, rewrite }) => header === "zdr+order=basalt" ? rewrite({ header: "only=routeprobe0" }) : next(),
  G8: ({ suffix, header, next, rewrite }) => suffix === "bits=64" && header === null ? rewrite({ suffix: null }) : next(),
  G9: ({ request, transport, next }) => transport?.repeatedRoutePolicy ? good(request) : next(),
  G10: ({ request, auth, header, suffix, next, rewrite }) => request.method === "POST" && auth?.endsWith(policyKey) && header === null && suffix === null ? rewrite({ neutralKey: true }) : next(),
  G11: ({ header, suffix, next, rewrite }) => header === "only=x,x" && suffix === "bits=0" ? rewrite({ header: suffix, suffix: header }) : next(),
  G12: ({ header, suffix, next, rewrite }) => header === "region=us" && suffix === "region=de" ? rewrite({ header: "region=us,de", suffix: null }) : next(),
  G13: ({ auth, header, suffix, next, rewrite }) => auth?.endsWith(policyKey) && header !== null && suffix !== null ? rewrite({ neutralKey: true }) : next(),
  G15: async ({ body, next }) => {
    const reply = await next();
    return body.stream === true ? change(reply, { replace: { [applied]: null } }) : reply;
  },
  G17: async ({ header, next }) => {
    const reply = await next();
    return header === "attest=weights" ? change(reply, { replace: { [evidence]: "https://basalt.example/attestation/" } }) : reply;
  },
  G19: async ({ header, next }) => {
    const reply = await next();
    return header === "zdr" ? change(reply, { replace: { [refusal]: formatRefused("unsatisfiable") } }) : reply;
  },
  G20: async ({ path, auth, next }) => path === "/v1/route-policy" && auth === null ? Response.json({ route_policy: 1 }) : next(),
  G21: async ({ path, next }) => {
    const reply = await next();
    if (path !== "/v1/route-policy") return reply;
    const body: unknown = await reply.json();
    assert.ok(typeof body === "object" && body !== null);
    return Response.json({ ...body, sort: ["price", "latency"] });
  },
  G22: async ({ path, auth, next }) => path === "/v1/route-policy" && auth === null ? Response.json({ route_policy: "1", key_policy: "zdr" }) : next(),
  G23: async ({ path, next }) => path === "/v1/models" ? Response.json({ data: [{ id: model, routes: [...published, published[0]] }] }) : next(),
  G24: ({ header, next, rewrite }) => header === "order=routeprobe0" ? rewrite({ header: "only=routeprobe0" }) : next(),
  G25: async ({ id, header, next }) => id.startsWith("route-conformance-unknown-") && header !== null ? Response.json({ error: { message: "checked policy before own error" } }, { status: 400, headers: { [refusal]: formatRefused("unsupported", "routeprobeinvalid") } }) : next(),
  G26: async ({ request, auth, header, suffix, next }) => {
    const reply = await next();
    return request.method === "POST" && reply.ok && auth?.endsWith(key) && header === null && suffix === null ? change(reply, { replace: { [evidence]: "https://aurora.example/" } }) : reply;
  },
  G29: ({ header, suffix, next, rewrite }) => header === "bits=64" && suffix === "bits=0" ? rewrite({ suffix: null }) : next(),
  G34: async ({ header, next }) => {
    const reply = await next();
    return header === "bits=0" && reply.status === 400 ? change(reply, { body: '{"message":"unsupported"}' }) : reply;
  },
};

async function baseAt(t: TestContext, server: ReturnType<typeof createServer>, path = "/v1"): Promise<string> {
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return `http://127.0.0.1:${address.port}${path}`;
}

async function run(t: TestContext, handler: RequestHandler, endpoints: readonly Endpoint[] = ["chat/completions"], path = "/v1") {
  return runConformance({ base: await baseAt(t, serve(handler, 0), path), key, policyKey, endpoints });
}

test(`${idList.join(" ")}: the reference implementation passes every black-box check without model or provider assumptions`, async (t) => {
  const report = await run(t, good);
  assert.deepEqual(new Set(report.checks.map(({ id }) => id)), new Set(idList));
  assert.deepEqual(report.checks.filter((c) => c.status !== "PASS"), []);
  assert.equal(report.passed, idList.length);
});

for (const id of idList) test(`${id}: conformance rejects the gateway that breaks this requirement`, async (t) => {
  const report = await run(t, fixture(faults[id]));
  const failure = report.checks.find((check) => check.id === id);
  assert.ok(failure);
  assert.equal(failure.status, "FAIL", JSON.stringify(report.checks.filter((check) => check.status !== "PASS")));
  assert.match(failure.detail, /sent \{.*; received .*; required:/);
  assert.ok(report.failed > 0);
});

test("G20 G22: an anonymous key_policy makes the full detection reply invalid", async (t) => {
  const report = await run(t, fixture(faults.G22));
  for (const id of ["G20", "G22"]) assert.equal(report.checks.find((c) => c.id === id)?.status, "FAIL");
});

test("G20 G22: a credentialed key_policy must use its own complete advertised support", async (t) => {
  const report = await run(t, fixture(({ path, auth, next }) => path === "/v1/route-policy" && auth === `Bearer ${policyKey}`
    ? Response.json({ route_policy: "1", keys: ["sort"], sort: ["price"], key_policy: "sort=latency" })
    : next()));
  for (const id of ["G20", "G22"]) assert.equal(report.checks.find((c) => c.id === id)?.status, "FAIL");
});

test("G23: a catalog cannot substitute a display alias for its base entry", async (t) => {
  const report = await run(t, fixture(({ path, next }) => path === "/v1/models"
    ? Response.json({ data: [{ id: `${model}+zdr`, routes: published }, { id: `${model}-other`, routes: published }] })
    : next()));
  const verdict = report.checks.find(({ id }) => id === "G23");
  assert.equal(verdict?.status, "FAIL");
  assert.match(verdict.detail, /display alias .* has no base model/);
});

test("G23: a display alias may appear before its base entry", async (t) => {
  const report = await run(t, fixture(({ path, next }) => path === "/v1/models"
    ? Response.json({ data: [{ id: `${model}+zdr`, routes: published }, { id: model, routes: published }] })
    : next()));
  assert.equal(report.checks.find(({ id }) => id === "G23")?.status, "PASS");
  assert.equal(report.failed, 0);
});

test("G1 G29: an unlisted preference cannot turn into unavailable on an advertisement probe", async (t) => {
  const report = await run(t, fixture(async ({ header, next }) => {
    const reply = await next();
    return header === "sort=probe0" ? change(reply, { status: 503, replace: { [refusal]: formatRefused("unavailable") } }) : reply;
  }));
  for (const id of ["G1", "G29"]) assert.equal(report.checks.find((c) => c.id === id)?.status, "FAIL");
});

test("G2: unsupported key attribution is also checked on advertisement probes", async (t) => {
  const report = await run(t, fixture(async ({ header, next }) => {
    const reply = await next();
    return header === "sort=probe0" ? change(reply, { replace: { [refusal]: formatRefused("unsupported") } }) : reply;
  }));
  assert.equal(report.checks.find(({ id }) => id === "G2")?.status, "FAIL");
});

test("G3: an unsatisfiable reply with a forbidden applied header is not a passing refusal", async (t) => {
  const report = await run(t, fixture(async ({ header, next }) => {
    const reply = await next();
    return header === "bits=64" ? change(reply, { replace: { [applied]: formatApplied("aurora") } }) : reply;
  }));
  assert.equal(report.checks.find(({ id }) => id === "G3")?.status, "FAIL");
});

test("G6: a suffix relay without a provider cannot prove the combined policy was met", async (t) => {
  const report = await run(t, fixture(async ({ suffix, header, next }) => {
    const reply = await next();
    return suffix === "zdr" && header === null ? change(reply, { replace: { [applied]: null } }) : reply;
  }));
  assert.equal(report.checks.find(({ id }) => id === "G6")?.status, "FAIL");
});

test("G10: a matching model does not hide a lost key default on a second model", async (t) => {
  const second = `${model}-second`;
  const target = createGateway({
    models: { [model]: routes, [second]: [routes[2]!] }, keys: { [key]: {}, [policyKey]: { policy: "zdr" } },
    fetch: () => Response.json({ output: "served" }),
  });
  const report = await run(t, async (request, transport) => {
    if (request.method === "POST" && request.headers.get("authorization") === `Bearer ${policyKey}` && !request.headers.has("route-policy")) {
      const body: unknown = await request.clone().json().catch(() => null);
      if (body !== null && typeof body === "object" && "model" in body && body.model === second) {
        const headers = new Headers(request.headers);
        headers.set("authorization", `Bearer ${key}`);
        return target(new Request(request, { headers }), transport);
      }
    }
    return target(request, transport);
  });
  assert.equal(report.checks.find(({ id }) => id === "G10")?.status, "FAIL");
});

test("G11: a valid pair repeated across carriers must not be rejected as a duplicate", async (t) => {
  const report = await run(t, fixture(({ header, suffix, next, rewrite }) => header === "zdr" && suffix === header
    ? rewrite({ header: "zdr+zdr", suffix: null }) : next()));
  assert.equal(report.checks.find(({ id }) => id === "G11")?.status, "FAIL");
});

test("G12: a region intersection must be empty in both carrier orientations", async (t) => {
  const report = await run(t, fixture(({ header, suffix, next, rewrite }) => header === "region=de" && suffix === "region=us"
    ? rewrite({ header: "region=us,de", suffix: null }) : next()));
  assert.equal(report.checks.find(({ id }) => id === "G12")?.status, "FAIL");
});

test("G21: a bound credential cannot ignore a disallowed item beside an accepted attest item", async (t) => {
  const report = await run(t, fixture(({ auth, header, next, rewrite }) => auth === `Bearer ${policyKey}` && header === "attest=weights,probe0"
    ? rewrite({ header: "attest=weights" }) : next()));
  assert.equal(report.checks.find(({ id }) => id === "G21")?.status, "FAIL");
});

test("G7: a preference in the suffix cannot exclude a route that meets the header requirement", async (t) => {
  const report = await run(t, fixture(({ header, suffix, next, rewrite }) => header === "zdr" && suffix === "order=basalt"
    ? rewrite({ header: "only=routeprobe0", suffix: null }) : next()));
  assert.equal(report.checks.find(({ id }) => id === "G7")?.status, "FAIL");
});

test("G13: proper narrowing on one model does not hide a widened default on another", async (t) => {
  const second = `${model}-second`;
  const target = createGateway({
    models: { [model]: routes, [second]: routes }, keys: { [key]: {}, [policyKey]: { policy: "zdr" } },
    fetch: () => Response.json({ output: "served" }),
  });
  const report = await run(t, async (request, transport) => {
    if (request.method === "POST" && request.headers.get("authorization") === `Bearer ${policyKey}` && request.headers.get("route-policy") === "bits=9") {
      const body: unknown = await request.clone().json().catch(() => null);
      if (body !== null && typeof body === "object" && "model" in body && body.model === second) {
        const headers = new Headers(request.headers);
        headers.set("authorization", `Bearer ${key}`);
        return target(new Request(request, { headers }), transport);
      }
    }
    return target(request, transport);
  });
  assert.equal(report.checks.find(({ id }) => id === "G13")?.status, "FAIL");
});

test("G24: an unknown provider does not invalidate a list that also names a qualifying provider", async (t) => {
  const report = await run(t, fixture(({ header, next, rewrite }) => header === "only=routeprobe0,aurora"
    ? rewrite({ header: "only=routeprobe0" }) : next()));
  assert.equal(report.checks.find(({ id }) => id === "G24")?.status, "FAIL");
});

test("G10 G13 G23: each credential's own catalog determines its model and matching routes", async (t) => {
  const catalogReads: string[] = [];
  const scopedGateways = new Map<string, RequestHandler>();
  for (const carrier of ["bearer", "api"] as const) {
    for (const role of ["ordinary", "bound"] as const) {
      const id = `${carrier}/${role}-model`;
      const localRoutes = routes.map((route, i) => ({ ...route, provider: `${carrier}-${role}-${i}` })).reverse();
      scopedGateways.set(id, createGateway({
        models: { [id]: localRoutes, [`${id}-aux`]: [{ ...routes[0]!, provider: "routeprobe0" }] },
        keys: { [key]: {}, [policyKey]: { policy: "zdr" } },
        fetch: () => Response.json({ output: "served" }),
      }));
    }
  }
  const report = await run(t, (request, transport) => {
    const bearer = request.headers.get("authorization");
    const apiKey = request.headers.get("x-api-key");
    const carrier = apiKey === null ? "bearer" : "api";
    const role = apiKey === policyKey || bearer === `Bearer ${policyKey}` ? "bound" : "ordinary";
    const id = `${carrier}/${role}-model`;
    if (new URL(request.url).pathname === "/v1/models") catalogReads.push(id);
    const handler = scopedGateways.get(id);
    assert.ok(handler);
    return handler(request, transport);
  }, INFERENCE_ENDPOINTS);
  assert.deepEqual(catalogReads.sort(), [...scopedGateways.keys()].sort());
  assert.deepEqual(report.checks.filter(({ status }) => status !== "PASS"), []);
});

test("G10 G13 G23: an inaccessible policy-key catalog does not borrow models from the ordinary credential", async (t) => {
  let catalogDenied = 0;
  const report = await run(t, async (request, transport) => {
    if (new URL(request.url).pathname === "/v1/models" && request.headers.get("authorization") === `Bearer ${policyKey}`) {
      catalogDenied++;
      return Response.json({ error: { type: "access_denied", message: "catalog access requires an entitlement" } }, { status: 402 });
    }
    return good(request, transport);
  });
  assert.equal(catalogDenied, 1);
  assert.equal(report.failed, 0);
  for (const id of ["G10", "G13", "G23"]) assert.equal(report.checks.find((c) => c.id === id)?.status, "SKIP", id);
});

function gatewayWithEnrichedErrors(defect?: "missing-envelope" | "nested-type" | "array-member-type" | "empty-body"): RequestHandler {
  return async (request, transport) => {
    const reply = await good(request, transport);
    if (request.method !== "POST" || reply.status < 400) return reply;
    const body: unknown = await reply.json();
    assert.ok(body !== null && typeof body === "object" && "error" in body && body.error !== null && typeof body.error === "object");
    const refused = reply.headers.has(refusal);
    const error = {
      ...body.error,
      code: refused ? "policy_refusal" : "bad_request",
      details: { retryable: defect === "nested-type" && refused ? "no" : false },
    };
    if (defect === "missing-envelope" && refused) return change(reply, { body: JSON.stringify({ error }) });
    if (defect === "empty-body" && refused) return change(reply, { body: "" });
    const issues = refused ? [{ severity: 1 }] : [{ severity: 1 }, { severity: 2 }];
    const envelope = {
      ...body, error,
      problem: {
        issues: defect === "array-member-type" && refused ? [...issues, { severity: "low" }] : issues,
        category: refused ? "policy" : "input",
      },
      request_id: refused ? "second" : "first",
    };
    return change(reply, { body: JSON.stringify(envelope) });
  };
}

test("G34: matching nested envelopes may have different codes, messages, and list lengths", async (t) => {
  const report = await run(t, gatewayWithEnrichedErrors());
  assert.equal(report.checks.find(({ id }) => id === "G34")?.status, "PASS");
});

for (const defect of ["missing-envelope", "nested-type", "array-member-type", "empty-body"] as const) {
  test(`G34: conformance rejects ${defect} in a refusal against an endpoint with enriched errors`, async (t) => {
    const report = await run(t, gatewayWithEnrichedErrors(defect));
    assert.deepEqual(report.checks.filter(({ status }) => status !== "PASS").map(({ id, status }) => [id, status]), [["G34", "FAIL"]]);
  });
}

test("G25: a model not published in the catalog can still resolve", async (t) => {
  let undisclosedRequests = 0;
  const report = await run(t, fixture(({ id, next, request, transport, suffix, body }) => {
    if (!id.startsWith("route-conformance-unknown-")) return next();
    undisclosedRequests++;
    const resolved = suffix === null ? model : `${model}+${suffix}`;
    return good(new Request(request.url, { method: request.method, headers: request.headers, body: JSON.stringify({ ...body, model: resolved }) }), transport);
  }));
  assert.equal(undisclosedRequests, 1);
  assert.equal(report.failed, 0);
  const verdict = report.checks.find(({ id }) => id === "G25");
  assert.equal(verdict?.status, "SKIP");
  assert.match(verdict.detail, /unknown-model subcase: no-policy control did not establish an ordinary error \(HTTP 200\)/);
});

test("G25: an unpublished model can relay a headerless 422 without causing a false own-error finding", async (t) => {
  const controls: (string | null)[] = [];
  const report = await run(t, fixture(async ({ id, next, request, transport, header, body }) => {
    if (!id.startsWith("route-conformance-unknown-")) return next();
    controls.push(header);
    const reply = await good(new Request(request.url, { method: request.method, headers: request.headers, body: JSON.stringify({ ...body, model }) }), transport);
    return reply.headers.has(refusal) ? reply : change(reply, { status: 422, body: "provider could not process the input" });
  }));
  assert.deepEqual(controls, [null, "zdr"]);
  assert.equal(report.failed, 0);
  const verdict = report.checks.find(({ id }) => id === "G25");
  assert.equal(verdict?.status, "SKIP");
  assert.match(verdict.detail, /accepted-policy control reached routing for the unpublished model \(HTTP 422\)/);
});

for (const status of [400, 422]) test(`G25: a reference gateway accepting any key may relay a headerless provider ${status}`, async (t) => {
  const credentialControls: { header: string | null; status: number; applied: string | null; providerCalls: number }[] = [];
  let providerCalls = 0;
  const target = createGateway({
    models: { [model]: routes },
    fetch: () => {
      providerCalls++;
      return Response.json({ providerError: "rejected by the provider" }, { status });
    },
  });
  const report = await run(t, async (request, transport) => {
    const before = providerCalls;
    const reply = await target(request, transport);
    if (request.headers.get("authorization")?.startsWith("Bearer route-conformance-invalid-")) {
      credentialControls.push({ header: request.headers.get("route-policy"), status: reply.status, applied: reply.headers.get(applied), providerCalls: providerCalls - before });
    }
    return reply;
  });
  assert.deepEqual(credentialControls, [
    { header: null, status, applied: null, providerCalls: 1 },
    { header: null, status: 400, applied: null, providerCalls: 0 },
  ]);
  assert.equal(report.failed, 0);
  const verdict = report.checks.find(({ id }) => id === "G25");
  assert.equal(verdict?.status, "SKIP");
  assert.match(verdict.detail, new RegExp(`headerless HTTP ${status} did not distinguish credential rejection from a provider relay`));
});

for (const sample of [
  { label: "unknown model", status: 422 },
  { label: "unrecognized credential", status: 418 },
] as const) {
  for (const defect of [false, true]) test(`G25: ${sample.label} HTTP ${sample.status} ${defect ? "cannot become a policy refusal" : "can remain an ordinary error"}`, async (t) => {
    const requests: (string | null)[] = [];
    const report = await run(t, fixture(({ id, auth, header, next }) => {
      const selected = sample.label === "unknown model" ? id.startsWith("route-conformance-unknown-") : auth?.startsWith("Bearer route-conformance-invalid-");
      if (!selected) return next();
      requests.push(header);
      const mutated = defect && header !== null;
      const body = { error: { type: "invalid_request_error", message: mutated ? "bad policy" : sample.label } };
      return mutated
        ? Response.json(body, { status: 400, headers: { [refusal]: formatRefused("unsupported", "bits") } })
        : Response.json(body, { status: sample.status });
    }));
    assert.deepEqual(requests, sample.label === "unknown model" ? [null, "zdr", "bits=0"] : [null, null, "bits=0"]);
    const verdict = report.checks.find(({ id }) => id === "G25");
    assert.equal(verdict?.status, defect ? "FAIL" : "PASS");
    if (defect) assert.match(verdict.detail, /reason=unsupported/);
    else assert.equal(report.failed, 0);
  });
}

test("G25: different ordinary statuses do not establish a violation if the no-policy control changes too", async (t) => {
  let plain = 0;
  const report = await run(t, fixture(({ id, header, next }) => {
    if (!id.startsWith("route-conformance-unknown-")) return next();
    const status = header === null && plain++ === 0 ? 422 : 409;
    return Response.json({ error: { type: "invalid_request_error", message: "could not resolve model" } }, { status });
  }));
  assert.equal(plain, 2);
  assert.equal(report.failed, 0);
  const verdict = report.checks.find(({ id }) => id === "G25");
  assert.equal(verdict?.status, "SKIP");
  assert.match(verdict.detail, /two no-policy controls returned HTTP 422 and HTTP 409/);
});

test("G25: a stable nonstandard ordinary status is not interchangeable with another ordinary error", async (t) => {
  const report = await run(t, fixture(({ id, header, next }) => id.startsWith("route-conformance-unknown-")
    ? Response.json({ error: { type: "invalid_request_error", message: "could not resolve model" } }, { status: header === null ? 422 : 409 })
    : next()));
  const verdict = report.checks.find(({ id }) => id === "G25");
  assert.equal(verdict?.status, "FAIL");
  assert.match(verdict.detail, /same ordinary error status 422 as the no-policy control/);
});

test("G6: pinning a second provider catches a gateway that always uses the first one for only", async (t) => {
  const report = await run(t, fixture(({ header, next, rewrite }) => header === "only=basalt" ? rewrite({ header: "only=aurora" }) : next()));
  assert.equal(report.checks.find(({ id }) => id === "G6")?.status, "FAIL");
});

test("G9: rejecting raw duplicates does not excuse ignoring an unsatisfiable single header", async (t) => {
  const report = await run(t, fixture(({ header, suffix, next, rewrite }) => header === "bits=64" && suffix === null ? rewrite({ header: null }) : next()));
  assert.equal(report.checks.find(({ id }) => id === "G9")?.status, "FAIL");
});

test("G17: attest in the bound policy requires evidence even with no explicit carrier", async (t) => {
  const target = createGateway({
    models: { [model]: routes }, keys: { [key]: {}, [policyKey]: { policy: "attest=weights" } },
    fetch: () => Response.json({ output: "served" }),
  });
  const report = await run(t, async (request, transport) => {
    const reply = await target(request, transport);
    if (request.method !== "POST" || request.headers.get("authorization") !== `Bearer ${policyKey}` || request.headers.has("route-policy")) return reply;
    return change(reply, { replace: { [evidence]: null } });
  });
  assert.equal(report.checks.find(({ id }) => id === "G17")?.status, "FAIL");
});

test("G21: an applied header does not mask rejection of a valid listed value", async (t) => {
  const report = await run(t, fixture(async ({ header, next }) => {
    const reply = await next();
    return header === "bits=32" ? change(reply, { replace: { [applied]: formatApplied("aurora"), [refusal]: formatRefused("unsupported", "bits") } }) : reply;
  }));
  assert.equal(report.checks.find(({ id }) => id === "G21")?.status, "FAIL");
});

test("G25 G1 G6 G10 G13: ordinary HTTP 429 blocks policy probes without any conformance failures", async (t) => {
  const usableInputs: { header: string | null; id: string; suffix: string | null; body: Record<string, unknown>; auth: string | null }[] = [];
  const report = await run(t, fixture(({ request, header, id, suffix, body, auth, next }) => {
    if (request.method !== "POST") return next();
    if (id === model) usableInputs.push({ header, id, suffix, body, auth });
    return Response.json({ error: { type: "rate_limit", message: "try later" } }, { status: 429 });
  }), INFERENCE_ENDPOINTS);
  assert.equal(report.failed, 0, JSON.stringify(report.checks.filter(({ status }) => status === "FAIL")));
  for (const endpoint of INFERENCE_ENDPOINTS) {
    for (const id of ["G1", "G6", "G10", "G13"]) {
      const verdict = report.checks.find((c) => c.endpoint === endpoint && c.id === id);
      assert.equal(verdict?.status, "SKIP");
      assert.match(verdict.detail, /(no-policy control|control without explicit policy).* returned headerless HTTP 429; cannot distinguish an own error from a relay/);
    }
    const verdict = report.checks.find((c) => c.endpoint === endpoint && c.id === "G25");
    assert.equal(verdict?.status, "SKIP");
    assert.match(verdict.detail, /bad-credentials subcase: headerless HTTP 429 did not distinguish credential rejection/);
  }
  const i = usableInputs.findIndex(({ suffix }) => suffix !== null);
  assert.ok(i >= 0, "a suffix probe was sent");
  const probe = usableInputs[i]!;
  const control = usableInputs[i + 1]!;
  assert.deepEqual(control, { ...probe, header: null, suffix: null, body: { ...probe.body, model: probe.id } });
});

test("G2 G19: a matching ordinary status does not excuse a forbidden policy result header", async (t) => {
  const report = await run(t, fixture(({ request, header, next }) => {
    if (request.method !== "POST") return next();
    return Response.json({ error: { type: "rate_limit", message: "try later" } }, { status: 429,
      ...(header === "bits=0+only=a,a" ? { headers: { [refusal]: formatRefused("unsupported", "bits") } } : {}),
    });
  }));
  for (const id of ["G2", "G19"]) assert.equal(report.checks.find((c) => c.id === id)?.status, "FAIL");
});

test("G15 G17 G34: all qualifying routes may be unavailable, with a correctly shaped refusal", async (t) => {
  const report = await run(t, unavailableGateway);
  assert.equal(report.failed, 0, JSON.stringify(report.checks.filter(({ status }) => status === "FAIL")));
  assert.equal(report.checks.find(({ id }) => id === "G15")?.status, "SKIP");
  assert.equal(report.checks.find(({ id }) => id === "G17")?.status, "SKIP");
  assert.equal(report.checks.find(({ id }) => id === "G34")?.status, "PASS");
});

test("G34: an isolated malformed unavailable refusal is caught outside the dedicated evidence and stream probes", async (t) => {
  let changed = false;
  const report = await run(t, async (request, transport) => {
    const reply = await unavailableGateway(request, transport);
    if (!changed && request.headers.get("route-policy") === "bits=1" && reply.headers.get(refusal) === formatRefused("unavailable")) {
      changed = true;
      return change(reply, { body: "service unavailable", replace: { "content-type": "text/plain" } });
    }
    return reply;
  });
  assert.ok(changed, "the satisfiable probe actually observed the broken 503");
  assert.deepEqual(report.checks.filter(({ status }) => status === "FAIL").map(({ id }) => id), ["G34"]);
  assert.match(report.checks.find(({ id }) => id === "G34")!.detail, /service unavailable/);
});

for (const { condition, config, skipped } of [
  { condition: "only a subset of keys and enumerated values is accepted", config: { accept: { keys: ["zdr", "attest", "sort"], attest: ["prompt"], sort: ["latency"] } }, skipped: ["G12", "G24"] },
  { condition: "no request keys are accepted", config: { accept: { keys: [], attest: [], sort: [] }, keys: { [key]: {}, [policyKey]: {} } }, skipped: ["G3", "G6", "G10", "G17"] },
  { condition: "one route qualifies for every satisfiable policy", config: { models: { [model]: [routes[0]!] } }, skipped: ["G13", "G17"] },
  { condition: "no route publishes attest", config: { models: { [model]: [routes[0]!, routes[2]!] } }, skipped: ["G17"] },
  { condition: "no credential carries a default policy", config: { keys: { [key]: {}, [policyKey]: {} } }, skipped: ["G10", "G13"] },
  { condition: "the accessible model catalog is empty", config: { models: {} }, skipped: ["G1", "G15", "G17"] },
] as const) {
  test(`G10 G12 G13 G15 G17 G21 G23 G24: no false failures when ${condition}`, async (t) => {
    const target = createGateway({
      models: { [model]: routes }, keys: { [key]: {}, [policyKey]: { policy: "zdr" } },
      fetch: () => Response.json({ output: "served" }), ...config,
    });
    const report = await run(t, target);
    assert.equal(report.failed, 0, JSON.stringify(report.checks.filter(({ status }) => status === "FAIL")));
    for (const id of skipped) assert.equal(report.checks.find((c) => c.id === id)?.status, "SKIP", id);
  });
}

test("G8 G15 G19: a published model may be unavailable on one API surface despite resolving on another", async (t) => {
  const report = await run(t, async (request, transport) => new URL(request.url).pathname === "/v1/responses"
    ? Response.json({ error: { type: "not_found_error", message: "not supported on this endpoint" } }, { status: 404 })
    : good(request, transport), ["chat/completions", "responses"]);
  assert.equal(report.failed, 0, JSON.stringify(report.checks.filter(({ status }) => status === "FAIL")));
  for (const id of ["G8", "G15", "G19"]) {
    assert.equal(report.checks.find((c) => c.endpoint === "chat/completions" && c.id === id)?.status, "PASS");
    assert.equal(report.checks.find((c) => c.endpoint === "responses" && c.id === id)?.status, "SKIP");
  }
});

test("G25 G15: transient throttling of a single streaming probe is not a missing relay header", async (t) => {
  let ordinaryOwnErrors = 0;
  const report = await run(t, fixture(({ body, header, next }) => {
    if (body.stream === true && header !== null && ordinaryOwnErrors++ === 0) {
      return Response.json({ error: { type: "rate_limit", message: "try again" } }, { status: 429 });
    }
    return next();
  }));
  assert.equal(ordinaryOwnErrors, 1);
  assert.equal(report.failed, 0);
  assert.match(report.checks.find(({ id }) => id === "G15")!.detail, /transient headerless HTTP 429/);
});

test("G15: an interrupted non-SSE relay still exposes the committed result headers", async (t) => {
  let interrupted = 0;
  const report = await run(t, fixture(({ body, next }) => {
    if (body.stream !== true) return next();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        interrupted++;
        controller.error(new Error("connection fell away after headers"));
      },
    }, { highWaterMark: 0 }); // The adapter commits headers before pulling the body.
    return new Response(stream, { headers: { [applied]: formatApplied("aurora"), "content-type": "application/octet-stream" } });
  }));
  assert.equal(interrupted, 1);
  assert.equal(report.failed, 0);
  assert.equal(report.checks.find(({ id }) => id === "G15")?.status, "PASS");
});

test("G15 G17 G19 S14 S15 S18: result rules also audit responses received by carrier and advertisement probes", async (t) => {
  const report = await run(t, fixture(async ({ header, suffix, next }) => {
    const reply = await next();
    if (suffix === "zdr" && header === null) return change(reply, { replace: {
      [applied]: "provider=aurora, provider=basalt", [evidence]: "https://_invalid.example/",
    } });
    if (header === "sort=throughput" && suffix === null) return change(reply, { replace: { [refusal]: "reason=unavailable+key=zdr" } });
    return reply;
  }));
  for (const id of ["G15", "G17", "G19"]) assert.equal(report.checks.find((c) => c.id === id)?.status, "FAIL", id);
  assert.match(report.checks.find(({ id }) => id === "G15")!.detail, /S14/);
  assert.match(report.checks.find(({ id }) => id === "G17")!.detail, /S18/);
  assert.match(report.checks.find(({ id }) => id === "G19")!.detail, /S15/);
});

test("G19: missing refusal header fails when the matching no-policy control reaches routing", async (t) => {
  const report = await run(t, fixture(async ({ header, next }) => {
    const reply = await next();
    return header === "bits=64" && reply.headers.has(refusal) ? change(reply, { replace: { [refusal]: null } }) : reply;
  }));
  const verdict = report.checks.find(({ id }) => id === "G19");
  assert.equal(verdict?.status, "FAIL");
  assert.match(verdict.detail, /the no-policy control reached routing/);
});

test("G9 G15 G17 G25 G34: the real demo passes on all requested endpoints with zero skips", async (t) => {
  const { server, base } = await startDemo(0);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const report = await runConformance({ base: `${base}/v1`, key: "demo-key", policyKey: "demo-key-zdr", endpoints: INFERENCE_ENDPOINTS });
  assert.deepEqual(report.checks.filter((c) => c.status !== "PASS"), []);
  for (const endpoint of INFERENCE_ENDPOINTS) for (const id of ["G9", "G15", "G17", "G25", "G34"]) assert.ok(report.checks.some((c) => c.endpoint === endpoint && c.id === id && c.status === "PASS"));
});

test("G7 G24: two unpublished order ids cannot make qualifying routes unsatisfiable", async (t) => {
  const credentials = new Set<string | null>();
  const report = await run(t, fixture(async ({ auth, header, next }) => {
    const reply = await next();
    if (header !== "order=0,a-b_c.d") return reply;
    credentials.add(auth);
    assert.ok(reply.headers.has(applied));
    return Response.json({ error: { message: "no routes", type: "invalid_request_error" } },
      { status: 400, headers: { [refusal]: formatRefused("unsatisfiable") } });
  }));
  assert.deepEqual(credentials, new Set([`Bearer ${key}`, `Bearer ${policyKey}`]));
  for (const id of ["G3", "G7", "G24"]) {
    const verdict = report.checks.find((check) => check.id === id);
    assert.equal(verdict?.status, "FAIL");
    assert.match(verdict.detail, /order=0,a-b_c\.d/);
  }
});

const refusalEnvelope = { error: { message: "fixture refusal", type: "invalid_request_error" } };
function protocolError(reason: RefusalReason, keyName?: string): Response {
  const value = reason === "unsupported" ? formatRefused(reason, keyName) : formatRefused(reason);
  return Response.json(refusalEnvelope, { status: REFUSAL_STATUS[reason], headers: { [refusal]: value } });
}

function responseFor(policy: string, edit: Parameters<typeof change>[1]): Mutation {
  return async ({ header, suffix, next }) => {
    const reply = await next();
    return header === policy && suffix === null ? change(reply, edit) : reply;
  };
}

function detectionResponse(value: unknown, { status = 200, credentialed = false }: { status?: number; credentialed?: boolean } = {}): Mutation {
  return ({ path, auth, next }) => path === "/v1/route-policy" && (auth !== null) === credentialed
    ? Response.json(value, { status }) : next();
}

function catalogResponse(value: unknown): Mutation {
  return ({ path, next }) => path === "/v1/models" ? Response.json(value) : next();
}

const combinationTarget = createGateway({
  models: { [model]: routes.map((route, i) => ({
    ...route, evidence: `https://${route.provider}.example/evidence`,
    facts: ["zdr+bits=8+region=us,de+attest=weights", "notrain+bits=16+region=de,jp+attest=prompt", "bits=16+region=de+attest=weights,prompt"][i]!,
  })) },
  keys: { [key]: {}, [policyKey]: { policy: "zdr" } },
  fetch: () => Response.json({ output: "served" }),
});
const bitsKeyTarget = createGateway({
  models: { [model]: routes }, keys: { [key]: {}, [policyKey]: { policy: "bits=16" } },
  fetch: () => Response.json({ output: "served" }),
});

interface Clause {
  id: Id;
  clause: string;
  mutate: Mutation;
  target?: RequestHandler;
}

const clauses: Clause[] = [
  { id: "G1", clause: "unsupported must use HTTP 400", mutate: responseFor("bits=0", { status: 422 }) },
  { id: "G1", clause: "failing syntax cannot be classified as unsatisfiable", mutate: responseFor("bits=0", { replace: { [refusal]: formatRefused("unsatisfiable") } }) },
  { id: "G2", clause: "the first bad pair cannot omit its key", mutate: responseFor("bits=0+only=a,a", { replace: { [refusal]: formatRefused("unsupported") } }) },
  { id: "G2", clause: "a malformed key cannot name a later key", mutate: responseFor("Bad+bits=0", { replace: { [refusal]: formatRefused("unsupported", "bits") } }) },
  { id: "G3", clause: "unsatisfiable must use HTTP 400", mutate: responseFor("bits=64", { status: 422 }) },
  { id: "G3", clause: "unsatisfiable cannot attribute a key", mutate: responseFor("bits=64", { replace: { [refusal]: "reason=unsatisfiable+key=bits" } }) },
  { id: "G3", clause: "no qualifying provider cannot be relayed", mutate: ({ header, suffix, rewrite, next }) => header === "bits=64" && suffix === null ? rewrite({ header: "bits=1" }) : next() },
  ...([
    ["zdr", "cobalt", "missing retention fact"], ["notrain", "cobalt", "missing training fact"],
    ["bits=9", "aurora", "bit precision below the floor"], ["region=us", "basalt", "route countries exceed allowed region"],
    ["attest=weights", "aurora", "missing attestation item"], ["only=basalt", "aurora", "provider absent from only"],
    ["ignore=aurora", "aurora", "provider named in ignore"],
  ] as const).map(([policy, provider, clause]): Clause =>
    ({ id: "G6", clause, mutate: responseFor(policy, { replace: { [applied]: formatApplied(provider) } }) })),
  { id: "G7", clause: "a preference cannot admit an excluded provider", mutate: responseFor("zdr+order=basalt", { replace: { [applied]: formatApplied("basalt") } }) },
  { id: "G7", clause: "a sort alone cannot make matching routes unsatisfiable", mutate: responseFor("sort=throughput", { status: 400, body: JSON.stringify(refusalEnvelope),
    replace: { [applied]: null, [refusal]: formatRefused("unsatisfiable") } }) },
  { id: "G8", clause: "a valid suffix must resolve through the base id", mutate: ({ suffix, header, next }) => header === null && suffix === "zdr"
    ? Response.json(refusalEnvelope, { status: 404 }) : next() },
  { id: "G9", clause: "duplicates cannot select the first field line", mutate: ({ transport, rewrite, next }) => transport?.repeatedRoutePolicy ? rewrite({ header: "zdr" }) : next() },
  { id: "G9", clause: "duplicate lines must not name a key", mutate: async ({ transport, next }) => {
    const reply = await next();
    return transport?.repeatedRoutePolicy ? change(reply, { replace: { [refusal]: formatRefused("unsupported", "only") } }) : reply;
  } },
  { id: "G10", clause: "the key default also applies with an explicit filter", mutate: ({ auth, header, rewrite, next }) =>
    auth === `Bearer ${policyKey}` && header === "only=basalt" ? rewrite({ neutralKey: true }) : next() },
  { id: "G11", clause: "a valid header cannot bypass independent suffix validation", mutate: ({ header, suffix, rewrite, next }) =>
    header === "zdr" && suffix === "bits=0" ? rewrite({ suffix: null }) : next() },
  ...([
    ["zdr", "notrain", "retain both boolean requirements", combinationTarget],
    ["bits=1", "bits=9", "combine precision by maximum, not minimum", good],
    ["region=us,de", "region=de,jp", "intersect overlapping regions instead of replacing the suffix", combinationTarget],
    ["only=aurora,basalt", "only=basalt,cobalt", "intersect overlapping provider lists", good],
    ["attest=weights", "attest=prompt", "union distinct attestation items", combinationTarget],
    ["ignore=aurora", "ignore=basalt", "union exclusions", good],
  ] as const).map(([head, tail, clause, target]): Clause => ({
    id: "G11", clause, target, mutate: ({ header, suffix, rewrite, next }) => {
      if (header !== head || suffix !== tail) return next();
      const bad = head.startsWith("region=") ? "only=aurora+region=us,de" :
        head.startsWith("attest=") ? "only=aurora+attest=weights" :
        head.startsWith("only=") ? "only=aurora" : head;
      return rewrite({ header: bad, suffix: null });
    },
  })),
  { id: "G12", clause: "an empty only intersection must refuse independently of region", mutate: ({ header, suffix, rewrite, next }) =>
    header === "only=aurora" && suffix === "only=basalt" ? rewrite({ suffix: null }) : next() },
  { id: "G13", clause: "an explicit header cannot remove the bound requirement", mutate: ({ auth, header, suffix, rewrite, next }) =>
    auth === `Bearer ${policyKey}` && header === "only=basalt" && suffix === null ? rewrite({ neutralKey: true }) : next() },
  { id: "G13", clause: "an explicit suffix cannot remove the bound requirement", mutate: ({ auth, header, suffix, rewrite, next }) =>
    auth === `Bearer ${policyKey}` && header === null && suffix === "only=basalt" ? rewrite({ neutralKey: true }) : next() },
  { id: "G13", clause: "an explicit weaker precision cannot lower the bound minimum", target: bitsKeyTarget,
    mutate: ({ auth, header, rewrite, next }) => auth === `Bearer ${policyKey}` && header === "bits=8" ? rewrite({ neutralKey: true }) : next() },
  { id: "G15", clause: "a well-formed provider id must be published for the model", mutate: responseFor("zdr", { replace: { [applied]: formatApplied("unpublished") } }) },
  { id: "G17", clause: "attested relays must supply evidence", mutate: responseFor("attest=weights", { replace: { [evidence]: null } }) },
  { id: "G17", clause: "unattested relays cannot supply evidence", mutate: responseFor("zdr", { replace: { [evidence]: "https://aurora.example/evidence" } }) },
  { id: "G19", clause: "a refusal cannot carry Route-Applied", mutate: responseFor("bits=64", { replace: { [applied]: formatApplied("aurora") } }) },
  { id: "G19", clause: "a refusal cannot carry Route-Evidence", mutate: responseFor("bits=64", { replace: { [evidence]: "https://aurora.example/evidence" } }) },
  { id: "G20", clause: "anonymous detection must return 200", mutate: detectionResponse({ route_policy: "1" }, { status: 401 }) },
  { id: "G20", clause: "credentialed detection must return 200", mutate: detectionResponse({ route_policy: "1" }, { status: 201, credentialed: true }) },
  { id: "G20", clause: "detection must be a JSON object", mutate: detectionResponse([]) },
  { id: "G20", clause: "keys must be a list with valid key tokens", mutate: detectionResponse({ route_policy: "1", keys: ["Not-A-Key"] }) },
  { id: "G20", clause: "attest must be a list with valid item tokens", mutate: detectionResponse({ route_policy: "1", attest: ["a,b"] }) },
  { id: "G20", clause: "sort must be a list with valid item tokens", mutate: detectionResponse({ route_policy: "1", sort: "price" }) },
  { id: "G21", clause: "unknown unlisted keys must be refused, not silently dropped", mutate: ({ header, rewrite, next }) =>
    header === "probe0" ? rewrite({ header: "zdr" }) : next() },
  { id: "G21", clause: "unlisted attest values must be refused", mutate: ({ header, rewrite, next }) =>
    header === "attest=probe0" ? rewrite({ header: "attest=weights" }) : next() },
  ...(["bits=32", "region=jp,de", "only=0,a-b_c.d", "ignore=0,a-b_c.d", "order=0,a-b_c.d"] as const)
    .map((policy): Clause => ({
      id: "G21", clause: `listed fixed domain must accept ${policy}`, mutate: ({ header, suffix, next }) => header === policy && suffix === null
        ? protocolError("unsupported", policy.split("=")[0]) : next(),
    })),
  { id: "G22", clause: "a bound key policy must be a string", mutate: detectionResponse({ route_policy: "1", key_policy: 1 }, { credentialed: true }) },
  { id: "G22", clause: "a bound policy cannot repeat a key", mutate: detectionResponse({ route_policy: "1", key_policy: "zdr+zdr" }, { credentialed: true }) },
  { id: "G22", clause: "a bound policy cannot name an unlisted key", mutate: detectionResponse({ route_policy: "1", keys: ["zdr"], key_policy: "notrain" }, { credentialed: true }) },
  ...([
    ["top-level model list is an object", []],
    ["data is an array", { data: { id: model, routes: published } }],
    ["model entry is an object with an id", { data: [null] }],
    ["model ids are unique", { data: [{ id: model, routes: [] }, { id: model, routes: [] }] }],
    ["model has a routes array", { data: [{ id: model }] }],
    ["provider id obeys the grammar", { data: [{ id: model, routes: [{ provider: "Aurora", facts: "" }] }] }],
    ["route must publish facts", { data: [{ id: model, routes: [{ provider: "aurora" }] }] }],
    ["published facts obey the grammar", { data: [{ id: model, routes: [{ provider: "aurora", facts: "zdr+zdr" }] }] }],
    ["a route with attest publishes evidence", { data: [{ id: model, routes: [{ provider: "basalt", facts: "attest=weights" }] }] }],
    ["published evidence has an evidence URI", { data: [{ id: model, routes: [{ provider: "basalt", facts: "attest=weights", evidence: "http://basalt.example/" }] }] }],
  ] as const).map(([clause, value]): Clause => ({ id: "G23", clause, mutate: catalogResponse(value) })),
  { id: "G24", clause: "unknown only must match nothing", mutate: ({ header, rewrite, next }) =>
    header === "only=routeprobe0" ? rewrite({ header: "zdr" }) : next() },
  { id: "G24", clause: "an unknown only entry cannot erase a known match", mutate: ({ header, rewrite, next }) =>
    header === "only=routeprobe0,aurora" ? rewrite({ header: "only=routeprobe0" }) : next() },
  { id: "G24", clause: "unknown ignore cannot remove other providers", mutate: ({ header, rewrite, next }) =>
    header === "ignore=routeprobe0" ? rewrite({ header: "only=routeprobe0" }) : next() },
  { id: "G24", clause: "unknown ignore cannot erase a known exclusion", mutate: ({ header, rewrite, next }) =>
    header === "ignore=routeprobe0,aurora" ? rewrite({ header: "only=aurora" }) : next() },
  { id: "G24", clause: "mixed order cannot reject an unknown id as invalid", mutate: ({ header, next }) =>
    header === "order=routeprobe0,aurora" ? protocolError("unsupported", "order") : next() },
  { id: "G25", clause: "nonstring model errors must precede policy validation", mutate: ({ header, body, next }) =>
    header === "bits=0" && typeof body.model === "number" ? protocolError("unsupported", "bits") : next() },
  ...([applied, refusal, evidence] as const).map((name): Clause => ({
    id: "G25", clause: `an unreadable body must not return ${name}`, mutate: async ({ request, transport, header, body, next }) => {
      const reply = await next();
      if (request.method !== "POST" || !transport?.repeatedRoutePolicy || header === null || Object.keys(body).length > 0) return reply;
      return change(reply, { replace: { [name]: name === applied ? formatApplied("aurora")
        : name === refusal ? formatRefused("unsupported", "bits") : "https://aurora.example/evidence" } });
    },
  })),
  { id: "G26", clause: "policy-free inference cannot carry a refusal", mutate: async ({ request, auth, header, suffix, next }) => {
    const reply = await next();
    return request.method === "POST" && auth === `Bearer ${key}` && header === null && suffix === null && reply.ok
      ? protocolError("unavailable") : reply;
  } },
  { id: "G29", clause: "unsatisfiable takes precedence over unavailable", mutate: ({ header, suffix, next }) =>
    header === "bits=64" && suffix === null ? protocolError("unavailable") : next() },
  { id: "G29", clause: "an unsupported policy cannot be masked by unavailable", mutate: ({ header, suffix, next }) =>
    header === "zdr" && suffix === "bits=0" ? protocolError("unavailable") : next() },
];

for (const { id, clause, mutate, target } of clauses) test(`${id}: clause matrix — ${clause}`, async (t) => {
  let altered = 0;
  const report = await run(t, fixture(async (exchange) => {
    let original: Response | undefined;
    const reply = await mutate({ ...exchange, next: async () => {
      original = await exchange.next();
      return original;
    } });
    if (reply !== original) altered++;
    return reply;
  }, target));
  assert.ok(altered > 0, "the suite reached the deliberately broken branch");
  const verdict = report.checks.find((entry) => entry.id === id);
  assert.equal(verdict?.status, "FAIL", JSON.stringify(report.checks.filter((entry) => entry.status !== "PASS")));
  assert.match(verdict.detail, /sent \{.*; received .*; required:/);
});

for (const name of [applied, refusal, evidence]) test(`G19: two raw ${name} field lines are not one result`, async (t) => {
  const upstream = await baseAt(t, serve(good, 0), "");
  let duplicated = 0;
  const proxy = createServer((incoming, outgoing) => {
    const target = new URL(incoming.url ?? "/", upstream);
    const relay = relayRequest(target, { method: incoming.method, headers: incoming.rawHeaders }, (reply) => {
      const headers = [...reply.rawHeaders];
      for (let i = 0; i < headers.length; i += 2) {
        if (headers[i]!.toLowerCase() === name) {
          headers.push(name, headers[i + 1]!);
          duplicated++;
          break;
        }
      }
      outgoing.writeHead(reply.statusCode!, headers);
      reply.pipe(outgoing);
      outgoing.on("close", () => reply.destroy());
    });
    relay.on("error", () => outgoing.destroy());
    incoming.pipe(relay);
  }).listen(0, "127.0.0.1");
  const report = await runConformance({ base: await baseAt(t, proxy), key, policyKey, endpoints: ["chat/completions"] });
  assert.ok(duplicated > 0);
  const verdict = report.checks.find(({ id }) => id === "G19");
  assert.equal(verdict?.status, "FAIL");
  assert.match(verdict.detail, /at most one field line of each result header/);
});

for (const broken of [false, true]) test(`G25: a stable bound-key rate limit ${broken ? "cannot become a policy refusal" : "remains an ordinary error"}`, async (t) => {
  let challengeSeen = false;
  const report = await run(t, fixture(({ id, auth, header, suffix, next }) => {
    if (id !== model || auth !== `Bearer ${policyKey}` || suffix !== null) return next();
    if (header === "bits=0") {
      challengeSeen = true;
      if (broken) return protocolError("unsupported", "bits");
    } else if (header !== null) return next();
    return Response.json({ error: { message: "try later", type: "rate_limit" } }, { status: 429 });
  }));
  assert.ok(challengeSeen);
  const verdict = report.checks.find(({ id }) => id === "G25");
  assert.equal(verdict?.status, broken ? "FAIL" : "PASS");
  if (broken) assert.match(verdict.detail, /both bound-key controls are throttled/);
  else assert.equal(report.failed, 0);
});

test("G2 G21: the audit catches unsupported and invented attribution on a separate streaming probe", async (t) => {
  let broken = 0;
  const report = await run(t, fixture(({ body, header, next }) => {
    if (body.stream !== true || header !== "zdr") return next();
    broken++;
    return protocolError("unsupported", "zdr");
  }));
  assert.equal(broken, 1);
  for (const id of ["G2", "G21"]) {
    const verdict = report.checks.find((entry) => entry.id === id);
    assert.equal(verdict?.status, "FAIL");
    assert.match(verdict.detail, /stream\\":true/);
  }
});

test("G20 G22: bad credentialed detection status does not itself invalidate an otherwise valid key policy", async (t) => {
  const report = await run(t, fixture(async ({ path, auth, next }) => {
    const reply = await next();
    if (path !== "/v1/route-policy" || auth !== `Bearer ${policyKey}`) return reply;
    return change(reply, { status: 201 });
  }));
  assert.equal(report.checks.find(({ id }) => id === "G20")?.status, "FAIL");
  assert.equal(report.checks.find(({ id }) => id === "G22")?.status, "PASS");
});

test("G20 G23 G9: keep the exact tenant query on metadata and every inference endpoint", async (t) => {
  const paths = new Set<string>();
  const query = "?tenant=east&tag=a%2Bb&tag=a+b";
  let missingQuery = 0;
  const prefix = "/tenants/inference/v3";
  const report = await run(t, async (request, transport) => {
    const url = new URL(request.url);
    paths.add(url.pathname);
    if (url.search !== query) {
      missingQuery++;
      return new Response(null, { status: 404 });
    }
    url.pathname = `/v1${url.pathname.slice(prefix.length)}`;
    return good(new Request(url, {
      method: request.method, headers: request.headers, signal: request.signal,
      ...(request.body === null ? {} : { body: request.body, duplex: "half" }),
    }), transport);
  }, INFERENCE_ENDPOINTS, `${prefix}/${query}`);
  assert.equal(missingQuery, 0);
  assert.deepEqual(paths, new Set(["route-policy", "models", ...INFERENCE_ENDPOINTS].map((path) => `${prefix}/${path}`)));
  assert.equal(report.passed, 63);
  assert.equal(report.failed + report.skipped, 0);
});

test("G20: reject fragments and URL userinfo before making metadata requests", async (t) => {
  let requests = 0;
  const base = await baseAt(t, serve((request, transport) => { requests++; return good(request, transport); }, 0));
  for (const invalid of [`${base}#debug`, `${base}#`, base.replace("://", "://operator@"), base.replace("://", "://:secret@")]) {
    await assert.rejects(runConformance({ base: invalid }), /without a fragment or credentials/);
  }
  assert.equal(requests, 0);
});

test("G15 G20: a single selected endpoint may commit a valid response slowly", async (t) => {
  const inferred = new Set<string>();
  let waited = false;
  const report = await run(t, async (request, transport) => {
    if (request.method !== "POST") return good(request, transport);
    const path = new URL(request.url).pathname;
    inferred.add(path);
    if (path !== "/v1/responses") return new Response(null, { status: 404 });
    if (!waited && request.headers.get("route-policy") === "zdr") {
      waited = true;
      await delay(120);
    }
    return good(request, transport);
  }, ["responses"]);
  assert.ok(waited);
  assert.deepEqual(inferred, new Set(["/v1/responses"]));
  assert.equal(report.passed, 23);
  assert.equal(report.failed + report.skipped, 0);
});
