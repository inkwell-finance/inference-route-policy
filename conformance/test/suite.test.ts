import assert from "node:assert/strict";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { formatApplied, formatRefused, splitModel } from "../../core/src/index.ts";
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

function fixture(mutate: Mutation): RequestHandler {
  return async (request, transport) => {
    const path = new URL(request.url).pathname;
    const decoded: unknown = request.method === "POST" ? await request.clone().json().catch(() => null) : null;
    const body = typeof decoded === "object" && decoded !== null && !Array.isArray(decoded) ? Object.fromEntries(Object.entries(decoded)) : {};
    const { id, policy: suffix } = splitModel(typeof body.model === "string" ? body.model : "");
    const headers = new Headers(request.headers);
    const header = headers.get("route-policy");
    const auth = headers.get("authorization") ?? headers.get("x-api-key");
    const next = () => good(request, transport);
    const rewrite: Exchange["rewrite"] = (edit) => {
      const changed = new Headers(headers);
      if (edit.header === null) changed.delete("route-policy");
      else if (edit.header !== undefined) changed.set("route-policy", edit.header);
      if (edit.neutralKey) {
        if (changed.has("x-api-key")) changed.set("x-api-key", key);
        if (changed.has("authorization")) changed.set("authorization", `Bearer ${key}`);
      }
      const replaced = edit.suffix === undefined ? body : { ...body, model: edit.suffix === null ? id : `${id}+${edit.suffix}` };
      return good(new Request(request.url, { method: request.method, headers: changed, body: JSON.stringify(replaced) }));
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

async function run(t: TestContext, handler: RequestHandler, endpoints: readonly Endpoint[] = ["chat/completions"]) {
  const server = serve(handler, 0);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return runConformance({ base: `http://127.0.0.1:${address.port}/v1`, key, policyKey, endpoints });
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
  assert.deepEqual(report.checks.filter(({ status }) => status !== "PASS"), []);
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

test("G9 G15 G17 G25 G34: the real demo passes on all requested endpoints with zero skips", async (t) => {
  const { server, base } = await startDemo(0);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const report = await runConformance({ base: `${base}/v1`, key: "demo-key", policyKey: "demo-key-zdr", endpoints: INFERENCE_ENDPOINTS });
  assert.deepEqual(report.checks.filter((c) => c.status !== "PASS"), []);
  for (const endpoint of INFERENCE_ENDPOINTS) for (const id of ["G9", "G15", "G17", "G25", "G34"]) assert.ok(report.checks.some((c) => c.endpoint === endpoint && c.id === id && c.status === "PASS"));
});
