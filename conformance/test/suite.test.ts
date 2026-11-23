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

test("G10 G13 G23: an inaccessible policy-key catalog does not borrow models from the ordinary credential", async (t) => {
  let catalogDenied = 0;
  const report = await run(t, async (request, transport) => {
    if (new URL(request.url).pathname === "/v1/models" && request.headers.get("authorization") === `Bearer ${policyKey}`) {
      catalogDenied++;
      return Response.json({ error: { type: "access_denied", message: "no catalog permission" } }, { status: 403 });
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
      assert.match(verdict.detail, /gateway answered its own error 429 to the (no-policy control|control without explicit policy)/);
    }
    assert.equal(report.checks.find((c) => c.endpoint === endpoint && c.id === "G25")?.status, "PASS");
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
