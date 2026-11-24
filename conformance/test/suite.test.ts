import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as relayRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from "node:zlib";
import { combinePolicies, formatApplied, formatRefused, parsePolicy, REFUSAL_STATUS, splitModel, type RefusalReason } from "../../core/src/index.ts";
import { startDemo } from "../../gateway/src/demo.ts";
import { createGateway, type RequestHandler, type Route } from "../../gateway/src/gateway.ts";
import { serve } from "../../gateway/src/serve.ts";
import { parseBase, request as wireRequest } from "../src/http.ts";
import { auditResults } from "../src/outcomes.ts";
import { INFERENCE_ENDPOINTS, runConformance, type Endpoint, type Report } from "../src/suite.ts";

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
  G10: ({ request, auth, header, suffix, next, rewrite }) => request.method === "POST" && auth?.endsWith(policyKey) && header === null && suffix === null
    ? rewrite({ neutralKey: true, header: "only=basalt" }) : next(),
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
    return header === "bits=64" ? change(reply, { replace: { [applied]: formatApplied("aurora") } }) : reply;
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
  G25: ({ body, header, next }) => typeof body.model === "number" && header === "bits=0" ? protocolError("unsupported", "bits") : next(),
  G26: async ({ request, auth, header, suffix, next }) => {
    const reply = await next();
    return request.method === "POST" && reply.ok && auth?.endsWith(key) && header === null && suffix === null ? change(reply, { replace: { [evidence]: "https://aurora.example/" } }) : reply;
  },
  G29: ({ header, suffix, next, rewrite }) => header === "bits=64" && suffix === "bits=0" ? rewrite({ suffix: null }) : next(),
  G34: async ({ header, next }) => {
    const reply = await next();
    return header === "bits=0" && reply.status === 400 ? change(reply, { body: '{"error":"unsupported"}' }) : reply;
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

function assertFailure(report: Report, id: string, detail: RegExp) {
  const verdict = report.checks.find((check) => check.id === id);
  assert.equal(verdict?.status, "FAIL", JSON.stringify(report.checks.filter((check) => check.status !== "PASS")));
  assert.match(verdict.detail, detail);
}

test(`${idList.join(" ")}: the reference implementation passes every black-box check without model or provider assumptions`, async (t) => {
  const otherRoutes = routes.map((route, i) => ({ ...route, provider: ["first-x", "second_y", "third.z"][i]! }));
  const renamed = createGateway({
    models: { [model]: otherRoutes }, keys: { [key]: {}, [policyKey]: { policy: "zdr" } },
    fetch: (url: string) => Response.json({ text: `served by ${new URL(url).hostname}` }),
  });
  const intersections = new Set<string>();
  const report = await run(t, fixture(({ id, header, suffix, next }) => {
    if (id === model && header?.startsWith("only=") && suffix?.startsWith("only=")) {
      intersections.add(`${header}|${suffix}`);
    }
    return next();
  }, renamed));
  assert.deepEqual(new Set(report.checks.map(({ id }) => id)), new Set(idList));
  assert.deepEqual(report.checks.filter((c) => c.status !== "PASS"), []);
  assert.equal(report.passed, idList.length);
  for (const { detail } of report.checks) assert.match(detail, /; observed \d+ × HTTP \d{3}/);
  assert.ok(intersections.has("only=first-x|only=second_y"));
  assert.ok(intersections.has("only=second_y|only=first-x"));
});

const faultDetails: Record<Id, RegExp> = {
  G1: /required: the policy must be refused as unsupported$/,
  G2: /"refused":\["reason=unsupported\+key=only"\].*; required: the first failure names bits$/,
  G3: /"refused":\["reason=unavailable"\].*; required: HTTP 400 with only a valid unsatisfiable refusal$/,
  G6: /"applied":\["provider=cobalt"\].*; required: the named published route must meet/,
  G7: /required: an accepted preference cannot disqualify the matching published routes$/,
  G8: /required: no published route meets even the known suffix requirements$/,
  G9: /"refused":\["reason=unsupported\+key=only"\].*; required: two raw Route-Policy lines return 400 unsupported without a key$/,
  G10: /"applied":\["provider=basalt"\].*; required: the relayed route must meet the detected key default/,
  G11: /required: swapping malformed carriers reports only, the header's first failure$/,
  G12: /required: 400 unsatisfiable for an empty intersection in either carrier order$/,
  G13: /required: neither explicit carrier can weaken the detected key default$/,
  G15: /"applied":\[\].*; required: one valid Route-Applied naming a published provider for this model$/,
  G17: /required: Route-Evidence exactly matches the applied route's published URI$/,
  G19: /"refused":\["reason=unsatisfiable"\].*; required: a refusal has neither Route-Applied nor Route-Evidence$/,
  G20: /required: a complete valid detection reply: is not the string "1"$/,
  G21: /required: unlisted sort refuses sort=throughput$/,
  G22: /required: key_policy absent for anonymous detection$/,
  G23: /required: invalid or repeated provider on .*"provider":"aurora"/,
  G24: /required: an unknown provider id does not remove the remaining matching routes$/,
  G25: /"status":400,.*"refused":\["reason=unsupported\+key=bits"\].*; required: the same ordinary error status 400 as the no-policy control, with no result headers$/,
  G26: /required: no Route-Refused or Route-Evidence without a policy$/,
  G29: /required: unsupported takes precedence over unsatisfiable$/,
  G34: /required: the refusal uses this endpoint's ordinary error format; \$\.error has type string/,
};

for (const id of idList) test(`${id}: conformance rejects the gateway that breaks this requirement`, async (t) => {
  const report = await run(t, fixture(faults[id]));
  const failure = report.checks.find((check) => check.id === id);
  assert.ok(failure);
  assert.equal(failure.status, "FAIL", JSON.stringify(report.checks.filter((check) => check.status !== "PASS")));
  assert.match(failure.detail, /sent \{.*; received .*; required:/);
  assert.match(failure.detail, faultDetails[id]);
  assert.ok(report.failed > 0);
});

test("G20 G22: an anonymous key_policy makes the full detection reply invalid", async (t) => {
  const report = await run(t, fixture(faults.G22));
  assertFailure(report, "G20", /required: .*is present in a reply to a request without credentials$/);
  assertFailure(report, "G22", faultDetails.G22);
});

test("G20 G22: a credentialed key_policy must use its own complete advertised support", async (t) => {
  const report = await run(t, fixture(({ path, auth, next }) => path === "/v1/route-policy" && auth === `Bearer ${policyKey}`
    ? Response.json({ route_policy: "1", keys: ["sort"], sort: ["price"], key_policy: "sort=latency" })
    : next()));
  assertFailure(report, "G20", /required: a complete valid detection reply: .*value not accepted$/);
  assertFailure(report, "G22", /required: key_policy valid under the advertised lists: .*value not accepted$/);
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

for (const variation of ["content-length", "chunked", "mixed-case headers", "extra headers", "informational replies", "stacked field lines"] as const) {
  test(`G9 G19 G20 G23 G34: inspect final responses with ${variation}`, async (t) => {
    const upstream = await baseAt(t, serve(good, 0), "");
    const exercised = new Set<string>();
    const proxy = createServer((incoming, outgoing) => {
      const target = new URL(incoming.url ?? "/", upstream);
      const relay = relayRequest(target, { method: incoming.method, headers: incoming.rawHeaders }, async (reply) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of reply) chunks.push(chunk);
          const bytes = Buffer.concat(chunks);
          const headers: string[] = [];
          const payload = variation === "stacked field lines" ? brotliCompressSync(gzipSync(bytes)) : bytes;
          let result = false;
          for (let i = 0; i < reply.rawHeaders.length; i += 2) {
            const name = reply.rawHeaders[i]!.toLowerCase();
            if (["connection", "keep-alive", "content-length", "transfer-encoding"].includes(name)) continue;
            result ||= name.startsWith("route-");
            headers.push(variation === "mixed-case headers" ? name.replace(/(^|-)[a-z]/g, (s) => s.toUpperCase()) : name, reply.rawHeaders[i + 1]!);
          }
          if (variation === "stacked field lines") headers.push("Content-Encoding", "gzip", "content-encoding", "br");
          if (variation === "extra headers") headers.push("x-opaque-peer", "ignored", "trailer", "x-final-tag");
          if (variation === "informational replies") {
            outgoing.writeContinue();
            outgoing.writeEarlyHints({ link: "</hint>; rel=preload", [refusal]: "not-a-final-result" });
          }
          const split = variation === "chunked" && payload.length > 1;
          if (!split && variation !== "extra headers") headers.push("content-length", String(payload.length));
          outgoing.writeHead(reply.statusCode!, headers);
          if (split) {
            outgoing.write(payload.subarray(0, 1));
            // Leave the first chunk readable before sending the second.
            await delay(5);
          }
          if (variation === "extra headers") outgoing.addTrailers({ "x-final-tag": "also ignored" });
          if (result || incoming.method === "GET") exercised.add(incoming.method === "GET" ? target.pathname : reply.statusCode === 400 ? "refusal" : "relay");
          outgoing.end(split ? payload.subarray(1) : payload);
        } catch {
          outgoing.destroy();
        }
      });
      relay.on("error", () => outgoing.destroy());
      incoming.pipe(relay);
    }).listen(0, "127.0.0.1");
    const base = await baseAt(t, proxy);
    const interim: number[] = [];
    const chunkSizes: number[] = [];
    const final = await new Promise<{ headers: string[]; trailers: string[] }>((resolve, reject) => {
      const probe = relayRequest(`${base}/route-policy`, (reply) => {
        reply.on("error", reject);
        reply.on("end", () => resolve({ headers: reply.rawHeaders, trailers: reply.rawTrailers }));
        reply.on("data", (chunk: Buffer) => chunkSizes.push(chunk.length));
      });
      probe.on("information", ({ statusCode }) => interim.push(statusCode));
      probe.on("error", reject);
      probe.end();
    });
    if (variation === "content-length") assert.ok(final.headers.includes("content-length"));
    if (variation === "chunked") {
      assert.ok(final.headers.includes("chunked"));
      assert.equal(chunkSizes[0], 1);
      assert.ok(chunkSizes.length > 1);
    }
    if (variation === "mixed-case headers") assert.ok(final.headers.includes("Content-Type"));
    if (variation === "extra headers") {
      assert.ok(final.headers.includes("x-opaque-peer"));
      assert.deepEqual(final.trailers, ["x-final-tag", "also ignored"]);
    }
    if (variation === "informational replies") assert.deepEqual(interim, [100, 103]);
    if (variation === "stacked field lines") assert.deepEqual(final.headers.filter((value) => value.toLowerCase() === "content-encoding"), ["Content-Encoding", "content-encoding"]);
    exercised.clear();
    const report = await runConformance({ base, key, policyKey, endpoints: ["chat/completions"] });
    assert.deepEqual(exercised, new Set(["/v1/route-policy", "/v1/models", "refusal", "relay"]));
    assert.deepEqual(report.checks.filter(({ status }) => status !== "PASS"), []);
  });
}

test("G20 G23: HEAD may be rejected and OPTIONS may return 204; discovery uses GET", async (t) => {
  const methods = new Set<string>();
  const base = await baseAt(t, serve(async (request, transport) => {
    methods.add(`${request.method} ${new URL(request.url).pathname}`);
    if (request.method === "HEAD") return new Response(null, { status: 405 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { allow: "GET, OPTIONS" } });
    return good(request, transport);
  }, 0));
  const metadata = ["route-policy", "models"];
  for (const path of metadata) {
    assert.equal((await fetch(`${base}/${path}`, { method: "HEAD" })).status, 405);
    assert.equal((await fetch(`${base}/${path}`, { method: "OPTIONS" })).status, 204);
  }
  assert.deepEqual(methods, new Set(metadata.flatMap((name) => [`HEAD /v1/${name}`, `OPTIONS /v1/${name}`])));
  methods.clear();
  const report = await runConformance({ base, key, policyKey, endpoints: ["chat/completions"] });
  assert.deepEqual(methods, new Set(["GET /v1/route-policy", "GET /v1/models", "POST /v1/chat/completions"]));
  assert.deepEqual(report.checks.filter(({ status }) => status !== "PASS"), []);
});

test("G23: a 204 empty catalog leaves route publication unverified", async (t) => {
  let catalogs = 0;
  const report = await run(t, fixture(({ path, next }) => {
    if (path !== "/v1/models") return next();
    catalogs++;
    return new Response(null, { status: 204 });
  }));
  assert.equal(catalogs, 2);
  const verdict = report.checks.find(({ id }) => id === "G23");
  assert.equal(verdict?.status, "SKIP");
  assert.match(verdict.detail, /model list.*HTTP 204/);
  assert.equal(report.failed, 0);
});

const contentCodings = [
  ["gzip", gzipSync],
  ["X-GZip", gzipSync],
  ["deflate", deflateSync],
  ["br", brotliCompressSync],
  ["zstd", zstdCompressSync],
  ["gzip, identity, br", (body: Uint8Array) => brotliCompressSync(gzipSync(body))],
] as const;

for (const [coding, encode] of contentCodings) test(`G20 G23 G34: decode ${coding} on metadata, errors and relays`, async (t) => {
  const used = new Set<string>();
  const handler = fixture(async ({ request, path, next }) => {
    const reply = await next();
    if (reply.body === null) return reply;
    assert.equal(request.headers.get("accept-encoding"), "identity");
    used.add(request.method === "GET" ? path : reply.headers.has(refusal) ? "refusal" : reply.ok ? "relay" : "ordinary");
    const headers = new Headers(reply.headers);
    headers.delete("content-length");
    headers.set("content-encoding", coding);
    return new Response(new Uint8Array(encode(new Uint8Array(await reply.arrayBuffer()))), { status: reply.status, headers });
  });
  const base = await baseAt(t, serve(handler, 0));
  const report = await runConformance({ base, key, policyKey, endpoints: ["chat/completions"] });
  assert.deepEqual(report.checks.filter(({ status }) => status !== "PASS"), []);
  const relay = await wireRequest(parseBase(base), {
    path: "chat/completions", credential: { header: "authorization", key }, raw: JSON.stringify({ model }), policies: ["zdr"],
  }, 1_000);
  assert.deepEqual(relay.body, { text: "served by aurora.example" });
  assert.deepEqual(used, new Set(["/v1/route-policy", "/v1/models", "ordinary", "refusal", "relay"]));
});

const uninspectableCases = [
  ["route-policy", ["G20", "G22"]], ["models", ["G23"]], ["refusal", ["G34"]], ["ordinary", ["G34"]],
] as const;
for (const [surface, affected] of uninspectableCases) test(`${affected.join(" ")}: uninspectable content coding on ${surface} names the missing body precondition`, async (t) => {
  const coding = "x-reversed-octets";
  let encoded = 0;
  const report = await run(t, fixture(async ({ request, path, next }) => {
    const reply = await next();
    const kind = request.method === "GET" ? path.split("/").at(-1)
      : reply.headers.has(refusal) ? "refusal" : reply.ok || reply.headers.has(applied) ? "relay" : "ordinary";
    if (kind !== surface || reply.body === null) return reply;
    const headers = new Headers(reply.headers);
    headers.delete("content-length");
    headers.set("content-encoding", coding);
    encoded++;
    return new Response(new Uint8Array(await reply.arrayBuffer()).reverse(), { status: reply.status, headers });
  }));
  assert.ok(encoded > 0);
  assert.deepEqual(report.checks.filter(({ status }) => status === "FAIL"), []);
  for (const id of affected) {
    const verdict = report.checks.find((check) => check.id === id);
    assert.equal(verdict?.status, "SKIP");
    assert.match(verdict.detail, new RegExp(coding));
  }
  if (surface === "refusal" || surface === "ordinary") assert.equal(report.checks.find(({ id }) => id === "G19")?.status, "PASS");
});

for (const variation of ["charset", "BOM", "trailing whitespace"] as const) test(`G20 G23 G34: ${variation} does not change a JSON envelope`, async (t) => {
  const varied = new Set<string>();
  const report = await run(t, fixture(async ({ request, path, next }) => {
    const reply = await next();
    if (reply.body === null || !reply.headers.get("content-type")?.startsWith("application/json")
      || (request.method === "POST" && !reply.headers.has(refusal))) return reply;
    varied.add(request.method === "GET" ? path : "refusal");
    const text = await reply.text();
    return variation === "charset" ? change(reply, { body: text, replace: { "content-type": "Application/JSON; Charset=UTF-8" } })
      : change(reply, { body: variation === "BOM" ? `\uFEFF${text}` : `${text} \r\n\t` });
  }));
  assert.deepEqual(varied, new Set(["/v1/route-policy", "/v1/models", "refusal"]));
  assert.deepEqual(report.checks.filter(({ status }) => status !== "PASS"), []);
});

test("G25: an omitted model can use the gateway's default, while a nonstring model still witnesses precedence", async (t) => {
  const defaults = new Set<string | null>();
  let defaultChallenges = 0;
  let rejectedWrongTypes = 0;
  const report = await run(t, fixture(async ({ path, request, id, body, header, auth, next }) => {
    if (id === "" && Object.keys(body).length === 0 && await request.clone().text() === "{}") {
      if (header !== null) {
        defaultChallenges++;
        return protocolError("unsupported", "bits");
      }
      defaults.add(auth);
      return good(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ model }) }));
    }
    const reply = await next();
    if (path === "/v1/chat/completions" && typeof body.model === "number" && header === "bits=0") {
      assert.equal(reply.status, 400);
      assert.equal(reply.headers.has(refusal), false);
      rejectedWrongTypes++;
    }
    return reply;
  }));
  assert.ok(defaults.has(`Bearer ${key}`));
  assert.equal(defaultChallenges, 0);
  assert.equal(rejectedWrongTypes, 1);
  const verdict = report.checks.find(({ id }) => id === "G25");
  assert.equal(verdict?.status, "SKIP");
  assert.match(verdict.detail, /missing model field.*HTTP 200/);
  assert.equal(report.failed, 0);
});

for (const mode of ["relay", "borrowed shape", "uncertain origin"] as const) {
  const title = mode === "relay" ? "G25: an attributed default-model 422 does not witness own-error precedence"
    : mode === "borrowed shape" ? "G34: a default-model relay cannot certify the refusal's error shape"
      : "G25 G34: a default-model 422 with an inconclusive accepted-policy control cannot certify precedence or shape";
  test(title, async (t) => {
    const providerError = { error: "the provider rejected the input" };
    const recipients: string[] = [];
    const controls: { policy: string | null; status: number; provider: string | null; recipients: string[] }[] = [];
    const target = createGateway({
      models: { [model]: routes }, keys: { [key]: {}, [policyKey]: { policy: "zdr" } },
      fetch: async (...args: Parameters<typeof fetch>) => {
        const request = new Request(...args);
        const host = new URL(request.url).hostname;
        if (await request.text() !== JSON.stringify({ model })) return Response.json({ text: `served by ${host}` });
        recipients.push(host);
        return Response.json(providerError, { status: 422 });
      },
    });
    let altered = false;
    const server = fixture(async ({ request, auth, body, header, suffix, next }) => {
      if (auth !== `Bearer ${key}` || request.method !== "POST") return next();
      if (Object.keys(body).length === 0 && await request.clone().text() === "{}") {
        const before = recipients.length;
        const reply = mode === "uncertain origin" && header === "zdr"
          ? Response.json({ error: { message: "temporarily not available" } }, { status: 409 })
          : await target(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ model }) }));
        controls.push({ policy: header, status: reply.status, provider: reply.headers.get(applied), recipients: recipients.slice(before) });
        return reply;
      }
      const reply = await next();
      if (mode === "relay" || altered || header !== "bits=0" || suffix !== null || body.model !== model) return reply;
      assert.equal(reply.headers.get(refusal), "reason=unsupported+key=bits");
      altered = true;
      return change(reply, { body: JSON.stringify(providerError) });
    }, target);
    const base = await baseAt(t, serve(server, 0));
    const report = await runConformance({ base, key, policyKey, endpoints: ["chat/completions"] });
    const plain = { policy: null, status: 422, provider: null, recipients: ["aurora.example"] };
    const witness = mode === "uncertain origin" ? { policy: "zdr", status: 409, provider: null, recipients: [] }
      : { policy: "zdr", status: 422, provider: "provider=aurora", recipients: ["aurora.example"] };
    assert.deepEqual(controls.slice(0, 2), [plain, witness]);
    assert.equal(controls.some(({ policy }) => policy === "bits=0"), false);
    assert.equal(altered, mode !== "relay");
    const precedence = report.checks.find(({ id }) => id === "G25");
    assert.equal(precedence?.status, "SKIP");
    assert.match(precedence.detail, mode === "uncertain origin"
      ? /missing model field.*did not establish error origin \(no-policy HTTP 422; HTTP 409\)/
      : /missing model field.*accepted-policy control reached routing \(HTTP 422\)/);
    const shape = report.checks.find(({ id }) => id === "G34");
    if (mode === "borrowed shape") {
      assertFailure(report, "G34", /provider rejected the input.*; required: .*\$\.error has type string/);
      assert.equal(report.failed, 1);
    } else {
      assert.equal(report.failed, 0, JSON.stringify(report.checks));
      assert.equal(shape?.status, mode === "relay" ? "PASS" : "SKIP");
      if (mode === "uncertain origin") assert.match(shape.detail, /ordinary error with this refusal shape; missing model field: .*did not establish error origin/);
      if (mode === "relay") {
        const reply = await wireRequest(parseBase(base), {
          path: "chat/completions", credential: { key, header: "authorization" }, raw: "{}", policies: ["bits=0"],
        }, 3_000);
        assert.equal(reply.status, 400);
        assert.deepEqual(reply.refused, ["reason=unsupported+key=bits"]);
        assert.deepEqual(controls.at(-1), { policy: "bits=0", status: 400, provider: null, recipients: [] });
      }
    }
  });
}

test("G1 G29: an unlisted preference cannot turn into unavailable on an advertisement probe", async (t) => {
  const report = await run(t, fixture(async ({ header, next }) => {
    const reply = await next();
    return header === "sort=probe0" ? change(reply, { status: 503, replace: { [refusal]: formatRefused("unavailable") } }) : reply;
  }));
  assertFailure(report, "G1", /sort=probe0.*reason=unavailable.*; required: HTTP 400 with only a valid unsupported refusal$/);
  assertFailure(report, "G29", /sort=probe0.*reason=unavailable.*; required: unsupported takes precedence over unavailable$/);
});

test("G2: unsupported key attribution is also checked on advertisement probes", async (t) => {
  const report = await run(t, fixture(async ({ header, next }) => {
    const reply = await next();
    return header === "sort=probe0" ? change(reply, { replace: { [refusal]: formatRefused("unsupported") } }) : reply;
  }));
  assertFailure(report, "G2", /sort=probe0.*"refused":\["reason=unsupported"\].*; required: the first failure names sort$/);
});

test("G3: an unsatisfiable reply with a forbidden applied header is not a passing refusal", async (t) => {
  const report = await run(t, fixture(async ({ header, next }) => {
    const reply = await next();
    return header === "bits=64" ? change(reply, { replace: { [applied]: formatApplied("aurora") } }) : reply;
  }));
  assertFailure(report, "G3", /"applied":\["provider=aurora"\],"refused":\["reason=unsatisfiable"\].*; required: HTTP 400 with only a valid unsatisfiable refusal$/);
});

test("G6: a suffix relay without a provider cannot prove the combined policy was met", async (t) => {
  const report = await run(t, fixture(async ({ suffix, header, next }) => {
    const reply = await next();
    return suffix === "zdr" && header === null ? change(reply, { replace: { [applied]: null } }) : reply;
  }));
  assertFailure(report, "G6", /\+zdr.*"applied":\[\].*; required: the named published route must meet/);
});

test("G10: dropping the key default only on a second model with no qualifying route is detected", async (t) => {
  const second = `${model}-second`;
  const target = createGateway({
    models: { [model]: routes, [second]: [routes[2]!] }, keys: { [key]: {}, [policyKey]: { policy: "zdr" } },
    fetch: (url: string) => Response.json({ provider: new URL(url).hostname }),
  });
  const relays = new Map<string, unknown>();
  const report = await run(t, fixture(async ({ auth, id, suffix, header, next, rewrite }) => {
    if (auth !== `Bearer ${policyKey}` || suffix !== null || header !== null || (id !== model && id !== second)) return next();
    const reply = id === second ? await rewrite({ neutralKey: true, header: "only=cobalt" }) : await next();
    relays.set(id, await reply.clone().json());
    return reply;
  }, target));
  assert.deepEqual(relays, new Map([[model, { provider: "aurora.example" }], [second, { provider: "cobalt.example" }]]));
  assertFailure(report, "G10", /-second.*"applied":\["provider=cobalt"\].*; required: the relayed route must meet the detected key default/);
});

test("G11: a valid pair repeated across carriers must not be rejected as a duplicate", async (t) => {
  const report = await run(t, fixture(({ header, suffix, next, rewrite }) => header === "zdr" && suffix === header
    ? rewrite({ header: "zdr+zdr", suffix: null }) : next()));
  assertFailure(report, "G11", /"refused":\["reason=unsupported\+key=zdr"\].*; required: a valid policy repeated across carriers is not a duplicate within one carrier$/);
});

test("G12: conformance catches a widened region intersection in the reverse carrier orientation", async (t) => {
  const report = await run(t, fixture(({ header, suffix, next, rewrite }) => header === "region=de" && suffix === "region=us"
    ? rewrite({ header: "region=us,de", suffix: null }) : next()));
  assertFailure(report, "G12", faultDetails.G12);
});

test("G21: a bound credential cannot ignore a disallowed item beside an accepted attest item", async (t) => {
  const report = await run(t, fixture(({ auth, header, next, rewrite }) => auth === `Bearer ${policyKey}` && header === "attest=weights,probe0"
    ? rewrite({ header: "attest=weights" }) : next()));
  assertFailure(report, "G21", /required: unlisted attest refuses attest=weights,probe0$/);
});

test("G7: a preference in the suffix cannot exclude a route that meets the header requirement", async (t) => {
  const report = await run(t, fixture(({ header, suffix, next, rewrite }) => header === "zdr" && suffix === "order=basalt"
    ? rewrite({ header: "only=routeprobe0", suffix: null }) : next()));
  assertFailure(report, "G7", /order=basalt.*"refused":\["reason=unsatisfiable"\].*; required: an accepted preference cannot disqualify/);
});

test("G13: correct bound-key filtering on one model does not hide widening on a different model", async (t) => {
  const second = `${model}-second`;
  const target = createGateway({
    models: { [model]: routes, [second]: [{ ...routes[1]!, provider: "second-basalt" }] },
    keys: { [key]: {}, [policyKey]: { policy: "zdr" } },
    fetch: () => Response.json({ output: "served" }),
  });
  const observed = new Map<string, string | null>();
  const report = await run(t, fixture(async ({ auth, id, suffix, header, next, rewrite }) => {
    if (auth !== `Bearer ${policyKey}` || suffix !== null) return next();
    if (id === model && header === "bits=9") {
      const reply = await next();
      observed.set(id, reply.headers.get(refusal));
      return reply;
    }
    if (id === second && header === "only=second-basalt") {
      const reply = await rewrite({ neutralKey: true });
      observed.set(id, reply.headers.get(applied));
      return reply;
    }
    return next();
  }, target));
  assert.deepEqual(observed, new Map([[model, "reason=unsatisfiable"], [second, "provider=second-basalt"]]));
  assertFailure(report, "G13", /"applied":\["provider=second-basalt"\].*; required: neither explicit carrier can weaken the detected key default$/);
});

test("G24: an unknown provider does not invalidate a list that also names a qualifying provider", async (t) => {
  const report = await run(t, fixture(({ header, next, rewrite }) => header === "only=routeprobe0,aurora"
    ? rewrite({ header: "only=routeprobe0" }) : next()));
  assertFailure(report, "G24", faultDetails.G24);
});

test("G10 G13 G23: each credential's own catalog determines its model and matching routes", async (t) => {
  const catalogReads: string[] = [];
  const inferenceRelays = new Map<string, Set<string>>();
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
  const report = await run(t, async (request, transport) => {
    const bearer = request.headers.get("authorization");
    const apiKey = request.headers.get("x-api-key");
    const carrier = apiKey === null ? "bearer" : "api";
    const role = apiKey === policyKey || bearer === `Bearer ${policyKey}` ? "bound" : "ordinary";
    const id = `${carrier}/${role}-model`;
    if (new URL(request.url).pathname === "/v1/models"
      && (apiKey === key || apiKey === policyKey || bearer === `Bearer ${key}` || bearer === `Bearer ${policyKey}`)) catalogReads.push(id);
    const handler = scopedGateways.get(id);
    assert.ok(handler);
    const body: unknown = request.method === "POST" ? await request.clone().json().catch(() => null) : null;
    const reply = await handler(request, transport);
    const named = reply.headers.get(applied);
    if (named !== null) {
      assert.ok(typeof body === "object" && body !== null && "model" in body && typeof body.model === "string");
      const baseModel = splitModel(body.model).id;
      if (baseModel === `${id}-aux`) {
        assert.equal(named, "provider=routeprobe0");
        return reply;
      }
      assert.equal(baseModel, id);
      let observed = inferenceRelays.get(id);
      if (observed === undefined) inferenceRelays.set(id, observed = new Set());
      observed.add(named);
    }
    return reply;
  }, INFERENCE_ENDPOINTS);
  assert.deepEqual(catalogReads.sort(), [...scopedGateways.keys()].sort());
  assert.deepEqual([...inferenceRelays.keys()].sort(), [...scopedGateways.keys()].sort());
  for (const [id, observed] of inferenceRelays) {
    const prefix = id.replace(/-model$/, "").replace("/", "-");
    assert.deepEqual(observed, new Set(id.endsWith("/bound-model") ? [`provider=${prefix}-0`]
      : [`provider=${prefix}-0`, `provider=${prefix}-1`, `provider=${prefix}-2`]));
  }
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

function gatewayWithEnrichedErrors(defect?: "missing-envelope" | "problem-type" | "request-id-type" | "nested-type" | "array-member-type" | "empty-body"): RequestHandler {
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
    const issues = refused ? [{ severity: 3, field: "model" }, { severity: 2 }]
      : [{ severity: 1 }, { severity: 2, field: "id" }, { severity: 3 }];
    const envelope = {
      ...body, error,
      problem: defect === "problem-type" && refused ? "policy" : {
        issues: defect === "array-member-type" && refused ? [...issues, { severity: "low" }] : issues,
        category: refused ? "policy" : "input",
      },
      request_id: refused ? (defect === "request-id-type" ? 7 : "second") : "first",
    };
    return change(reply, { body: JSON.stringify(envelope) });
  };
}

test("G34: equal nested shapes allow different scalar values, array order, and repetitions", async (t) => {
  const report = await run(t, gatewayWithEnrichedErrors());
  assert.equal(report.checks.find(({ id }) => id === "G34")?.status, "PASS");
});

const enrichedErrorDetails = {
  "problem-type": /\$\.problem has type string/,
  "request-id-type": /\$\.request_id has type number/,
  "nested-type": /\$\.error\.details\.retryable has type string/,
  "array-member-type": /\$\.problem\.issues\[\]\.severity has type string/,
  "empty-body": /required: a refusal has a nonempty error body/,
};

for (const defect of ["problem-type", "request-id-type", "nested-type", "array-member-type", "empty-body"] as const) {
  test(`G34: conformance rejects ${defect} in a refusal against an endpoint with enriched errors`, async (t) => {
    const report = await run(t, gatewayWithEnrichedErrors(defect));
    assert.deepEqual(report.checks.filter(({ status }) => status !== "PASS").map(({ id, status }) => [id, status]), [["G34", "FAIL"]]);
    assertFailure(report, "G34", enrichedErrorDetails[defect]);
  });
}

test("G34: omission of problem and request_id alone is inconclusive even when every sampled control includes them", async (t) => {
  const report = await run(t, gatewayWithEnrichedErrors("missing-envelope"));
  assert.equal(report.failed, 0);
  const check = report.checks.find(({ id }) => id === "G34");
  assert.equal(check?.status, "SKIP");
  assert.match(check.detail, /missing refusal members \$\.problem, \$\.request_id cannot be established/);
});

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
  assert.match(verdict.detail, /unknown model subcase: no-policy control did not establish an ordinary error \(HTTP 200\)/);
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
  assert.match(verdict.detail, /unknown model subcase: accepted-policy control reached routing \(HTTP 422\)/);
});

for (const status of [400, 422]) test(`G25: synthetic-key discovery supplies a qualifying accepted policy that attributes a headerless provider ${status}`, async (t) => {
  const credentialControls: { header: string | null; status: number; applied: string | null; providerCalls: number }[] = [];
  const discovery: string[] = [];
  let providerCalls = 0;
  const fetchProvider = () => {
    providerCalls++;
    return Response.json({ providerError: "rejected by the provider" }, { status });
  };
  const ordinary = createGateway({ models: { [model]: routes }, fetch: fetchProvider });
  const syntheticKey = createGateway({
    models: { [model]: [{ ...routes[1]!, facts: "bits=16+region=de" }] },
    accept: { keys: ["zdr", "region"] }, fetch: fetchProvider,
  });
  const report = await run(t, async (request, transport) => {
    const synthetic = request.headers.get("authorization")?.startsWith("Bearer route-conformance-invalid-") === true;
    if (synthetic && request.method === "GET") discovery.push(new URL(request.url).pathname);
    const before = providerCalls;
    const reply = await (synthetic ? syntheticKey : ordinary)(request, transport);
    if (request.method === "POST" && synthetic) {
      credentialControls.push({ header: request.headers.get("route-policy"), status: reply.status, applied: reply.headers.get(applied), providerCalls: providerCalls - before });
    }
    return reply;
  });
  assert.deepEqual(discovery, ["/v1/route-policy", "/v1/models"]);
  assert.deepEqual(credentialControls, [
    { header: null, status, applied: null, providerCalls: 1 },
    { header: "region=de", status, applied: "provider=basalt", providerCalls: 1 },
  ]);
  assert.equal(report.failed, 0);
  const verdict = report.checks.find(({ id }) => id === "G25");
  assert.equal(verdict?.status, "SKIP");
  assert.match(verdict.detail, new RegExp(`bad-credentials subcase: accepted-policy control reached routing \\(HTTP ${status}\\)`));
});

for (const sample of [
  { label: "unknown model", status: 422 },
  { label: "unrecognized credential", status: 418 },
] as const) {
  for (const defect of [false, true]) test(`G25: ${sample.label} HTTP ${sample.status} ${defect ? "cannot become a policy refusal" : "can remain an ordinary error"}`, async (t) => {
    const requests: (string | null)[] = [];
    const report = await run(t, fixture(({ request, id, auth, header, next }) => {
      const selected = sample.label === "unknown model" ? id.startsWith("route-conformance-unknown-") : auth?.startsWith("Bearer route-conformance-invalid-");
      if (request.method !== "POST" || !selected) return next();
      requests.push(header);
      const mutated = defect && header === "bits=0";
      const body = { error: { type: "invalid_request_error", message: mutated ? "bad policy" : sample.label } };
      return mutated
        ? Response.json(body, { status: 400, headers: { [refusal]: formatRefused("unsupported", "bits") } })
        : Response.json(body, { status: sample.status });
    }));
    assert.deepEqual(requests, sample.label === "unknown model" ? [null, "zdr", "bits=0"] : [null, "zdr", null, "bits=0"]);
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
    const status = header === "zdr" || (header === null && plain++ === 0) ? 422 : 409;
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
    ? Response.json({ error: { type: "invalid_request_error", message: "could not resolve model" } }, { status: header === "bits=0" ? 409 : 422 })
    : next()));
  const verdict = report.checks.find(({ id }) => id === "G25");
  assert.equal(verdict?.status, "FAIL");
  assert.match(verdict.detail, /same ordinary error status 422 as the no-policy control/);
});

test("G6: conformance catches a relay from the first provider when only pins the second", async (t) => {
  const report = await run(t, fixture(({ header, next, rewrite }) => header === "only=basalt" ? rewrite({ header: "only=aurora" }) : next()));
  assertFailure(report, "G6", /only=basalt.*"applied":\["provider=aurora"\].*; required: the named published route must meet/);
});

test("G9: rejecting raw duplicates does not excuse ignoring an unsatisfiable single header", async (t) => {
  const report = await run(t, fixture(({ header, suffix, next, rewrite }) => header === "bits=64" && suffix === null ? rewrite({ header: null }) : next()));
  assertFailure(report, "G9", /bits=64.*; required: no published route meets even the known mixed-case header requirements$/);
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
  assertFailure(report, "G17", /"applied":\["provider=basalt"\],"refused":\[\],"evidence":\[\].*; required: one Route-Evidence is required by the known attest requirement$/);
});

test("G21: an applied header does not mask rejection of a valid listed value", async (t) => {
  const report = await run(t, fixture(async ({ header, next }) => {
    const reply = await next();
    return header === "bits=32" ? change(reply, { replace: { [applied]: formatApplied("aurora"), [refusal]: formatRefused("unsupported", "bits") } }) : reply;
  }));
  assertFailure(report, "G21", /bits=32.*"refused":\["reason=unsupported\+key=bits"\].*; required: advertised support accepts every key and value sent/);
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

test("G19: a matching ordinary status does not excuse a refusal header with the wrong HTTP status", async (t) => {
  const report = await run(t, fixture(({ request, header, next }) => {
    if (request.method !== "POST") return next();
    return Response.json({ error: { type: "rate_limit", message: "try later" } }, { status: 429,
      ...(header === "bits=0+only=a,a" ? { headers: { [refusal]: formatRefused("unsupported", "bits") } } : {}),
    });
  }));
  const verdict = report.checks.find((c) => c.id === "G19");
  assert.equal(verdict?.status, "FAIL");
  assert.match(verdict.detail, /"status":429,.*"refused":\["reason=unsupported\+key=bits"\].*; required: S15: one valid Route-Refused value with its corresponding HTTP status$/);
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
  assertFailure(report, "G34", /service unavailable.*; required: .*media type text\/plain was not used by any ordinary error control/);
});

for (const { condition, config, skipped } of [
  { condition: "only a subset of keys and enumerated values is accepted", config: { accept: { keys: ["zdr", "attest", "sort"], attest: ["prompt"], sort: ["latency"] } }, skipped: ["G12", "G24"] },
  { condition: "no request keys are accepted", config: { accept: { keys: [], attest: [], sort: [] }, keys: { [key]: {}, [policyKey]: {} } }, skipped: ["G3", "G6", "G10", "G17"] },
  { condition: "one route qualifies for every satisfiable policy", config: { models: { [model]: [routes[0]!] } }, skipped: ["G13", "G17"] },
  { condition: "no route publishes attest", config: { models: { [model]: [routes[0]!, routes[2]!] } }, skipped: ["G17"] },
  { condition: "no credential carries a default policy", config: { keys: { [key]: {}, [policyKey]: {} } }, skipped: ["G10", "G13"] },
  { condition: "the accessible model catalog is empty", config: { models: {} }, skipped: ["G1", "G15", "G17"] },
] as const) {
  test(`${skipped.join(" ")}: no false failures and dependent checks skip when ${condition}`, async (t) => {
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

test("G15: transient throttling of a single streaming probe is not a missing relay header", async (t) => {
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

test("G3 G7 G24: two unpublished order ids cannot make qualifying routes unsatisfiable", async (t) => {
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
  assertFailure(report, "G3", /order=0,a-b_c\.d.*; required: unsatisfiable requires that no published route meet/);
  assertFailure(report, "G7", /order=0,a-b_c\.d.*; required: an accepted preference cannot disqualify/);
  assertFailure(report, "G24", /order=0,a-b_c\.d.*; required: an unknown provider id does not remove/);
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
  required: string;
  mutate: Mutation;
  target?: RequestHandler;
}

const clauses: Clause[] = [
  { id: "G1", clause: "unsupported must use HTTP 400", required: "HTTP 400 with only a valid unsupported refusal", mutate: responseFor("bits=0", { status: 422 }) },
  { id: "G1", clause: "failing syntax cannot be classified as unsatisfiable", required: "HTTP 400 with only a valid unsupported refusal", mutate: responseFor("bits=0", { replace: { [refusal]: formatRefused("unsatisfiable") } }) },
  { id: "G2", clause: "the first bad pair cannot omit its key", required: "the first failure names bits", mutate: responseFor("bits=0+only=a,a", { replace: { [refusal]: formatRefused("unsupported") } }) },
  { id: "G2", clause: "a malformed key cannot name a later key", required: "the first failure names no key", mutate: responseFor("Bad+bits=0", { replace: { [refusal]: formatRefused("unsupported", "bits") } }) },
  { id: "G3", clause: "unsatisfiable must use HTTP 400", required: "HTTP 400 with only a valid unsatisfiable refusal", mutate: responseFor("bits=64", { status: 422 }) },
  { id: "G3", clause: "unsatisfiable cannot attribute a key", required: "HTTP 400 with only a valid unsatisfiable refusal", mutate: responseFor("bits=64", { replace: { [refusal]: "reason=unsatisfiable+key=bits" } }) },
  { id: "G3", clause: "no qualifying provider cannot be relayed", required: "the policy must be refused as unsatisfiable", mutate: ({ header, suffix, rewrite, next }) => header === "bits=64" && suffix === null ? rewrite({ header: "bits=1" }) : next() },
  ...([
    ["zdr", "cobalt", "missing retention fact"], ["notrain", "cobalt", "missing training fact"],
    ["bits=9", "aurora", "bit precision below the floor"], ["region=us", "basalt", "route countries exceed allowed region"],
    ["attest=weights", "aurora", "missing attestation item"], ["only=basalt", "aurora", "provider absent from only"],
    ["ignore=aurora", "aurora", "provider named in ignore"],
  ] as const).map(([policy, provider, clause]): Clause =>
    ({ id: "G6", clause, required: "the named published route must meet at least the known requirements; an unknown key default cannot admit an excluded route", mutate: responseFor(policy, { replace: { [applied]: formatApplied(provider) } }) })),
  { id: "G7", clause: "a preference cannot admit an excluded provider", required: "preference must leave the same candidates (aurora), even if it points elsewhere", mutate: responseFor("zdr+order=basalt", { replace: { [applied]: formatApplied("basalt") } }) },
  { id: "G7", clause: "a sort alone cannot make matching routes unsatisfiable", required: "an accepted preference cannot disqualify the matching published routes", mutate: responseFor("sort=throughput", { status: 400, body: JSON.stringify(refusalEnvelope),
    replace: { [applied]: null, [refusal]: formatRefused("unsatisfiable") } }) },
  { id: "G8", clause: "a valid suffix must resolve through the base id", required: "suffixed request resolves to a qualifying route or unavailable", mutate: ({ suffix, header, next }) => header === null && suffix === "zdr"
    ? Response.json(refusalEnvelope, { status: 404 }) : next() },
  { id: "G9", clause: "duplicates cannot select the first field line", required: "two raw Route-Policy lines return 400 unsupported without a key", mutate: ({ transport, rewrite, next }) => transport?.repeatedRoutePolicy ? rewrite({ header: "zdr" }) : next() },
  { id: "G9", clause: "duplicate lines must not name a key", required: "two raw Route-Policy lines return 400 unsupported without a key", mutate: async ({ transport, next }) => {
    const reply = await next();
    return transport?.repeatedRoutePolicy ? change(reply, { replace: { [refusal]: formatRefused("unsupported", "only") } }) : reply;
  } },
  { id: "G10", clause: "the key default also applies with an explicit filter", required: "the relayed route must meet the detected key default even in the presence of explicit carriers", mutate: ({ auth, header, rewrite, next }) =>
    auth === `Bearer ${policyKey}` && header === "only=basalt" ? rewrite({ neutralKey: true }) : next() },
  { id: "G11", clause: "a valid header cannot bypass independent suffix validation", required: "a valid header does not bypass validation of the suffix", mutate: ({ header, suffix, rewrite, next }) =>
    header === "zdr" && suffix === "bits=0" ? rewrite({ suffix: null }) : next() },
  ...([
    ["zdr", "notrain", "retain both boolean requirements", combinationTarget],
    ["bits=1", "bits=9", "combine precision by maximum, not minimum", good],
    ["region=us,de", "region=de,jp", "intersect overlapping regions instead of replacing the suffix", combinationTarget],
    ["only=aurora,basalt", "only=basalt,cobalt", "intersect overlapping provider lists", good],
    ["attest=weights", "attest=prompt", "union distinct attestation items", combinationTarget],
    ["ignore=aurora", "ignore=basalt", "union exclusions", good],
  ] as const).map(([head, tail, clause, target]): Clause => ({
    id: "G11", clause, target, required: "both valid carriers constrain the request", mutate: ({ header, suffix, rewrite, next }) => {
      if (header !== head || suffix !== tail) return next();
      const bad = head.startsWith("region=") ? "only=aurora+region=us,de" :
        head.startsWith("attest=") ? "only=aurora+attest=weights" :
        head.startsWith("only=") ? "only=aurora" : head;
      return rewrite({ header: bad, suffix: null });
    },
  })),
  { id: "G12", clause: "an empty only intersection must refuse independently of region", required: "400 unsatisfiable for an empty intersection in either carrier order", mutate: ({ header, suffix, rewrite, next }) =>
    header === "only=aurora" && suffix === "only=basalt" ? rewrite({ suffix: null }) : next() },
  { id: "G13", clause: "an explicit header cannot remove the bound requirement", required: "neither explicit carrier can weaken the detected key default", mutate: ({ auth, header, suffix, rewrite, next }) =>
    auth === `Bearer ${policyKey}` && header === "only=basalt" && suffix === null ? rewrite({ neutralKey: true }) : next() },
  { id: "G13", clause: "an explicit suffix cannot remove the bound requirement", required: "neither explicit carrier can weaken the detected key default", mutate: ({ auth, header, suffix, rewrite, next }) =>
    auth === `Bearer ${policyKey}` && header === null && suffix === "only=basalt" ? rewrite({ neutralKey: true }) : next() },
  { id: "G13", clause: "an explicit weaker precision cannot lower the bound minimum", required: "neither explicit carrier can weaken the detected key default", target: bitsKeyTarget,
    mutate: ({ auth, header, rewrite, next }) => auth === `Bearer ${policyKey}` && header === "bits=8" ? rewrite({ neutralKey: true }) : next() },
  { id: "G15", clause: "a well-formed provider id must be published for the model", required: "one valid Route-Applied naming a published provider for this model", mutate: responseFor("zdr", { replace: { [applied]: formatApplied("unpublished") } }) },
  { id: "G17", clause: "attested relays must supply evidence", required: "one Route-Evidence is required by the known attest requirement", mutate: responseFor("attest=weights", { replace: { [evidence]: null } }) },
  { id: "G17", clause: "unattested relays cannot supply evidence", required: "no Route-Evidence when the combined policy does not require attest", mutate: responseFor("only=basalt", { replace: { [evidence]: "https://basalt.example/attestation" } }) },
  { id: "G19", clause: "a refusal cannot carry Route-Applied", required: "a refusal has neither Route-Applied nor Route-Evidence", mutate: responseFor("bits=64", { replace: { [applied]: formatApplied("aurora") } }) },
  { id: "G19", clause: "a refusal cannot carry Route-Evidence", required: "a refusal has neither Route-Applied nor Route-Evidence", mutate: responseFor("bits=64", { replace: { [evidence]: "https://aurora.example/evidence" } }) },
  { id: "G20", clause: "anonymous detection must return 200", required: "a complete valid detection reply: status is 401, not 200", mutate: detectionResponse({ route_policy: "1" }, { status: 401 }) },
  { id: "G20", clause: "credentialed detection must return 200", required: "a complete valid detection reply: status is 201, not 200", mutate: detectionResponse({ route_policy: "1" }, { status: 201, credentialed: true }) },
  { id: "G20", clause: "detection must be a JSON object", required: "a complete valid detection reply: not a JSON object", mutate: detectionResponse([]) },
  { id: "G20", clause: "keys must be a list with valid key tokens", required: "a complete valid detection reply: is not a list of keys", mutate: detectionResponse({ route_policy: "1", keys: ["Not-A-Key"] }) },
  { id: "G20", clause: "attest must be a list with valid item tokens", required: "a complete valid detection reply: is not a list of items", mutate: detectionResponse({ route_policy: "1", attest: ["a,b"] }) },
  { id: "G20", clause: "sort must be a list with valid item tokens", required: "a complete valid detection reply: is not a list of items", mutate: detectionResponse({ route_policy: "1", sort: "price" }) },
  { id: "G21", clause: "unknown unlisted keys must be refused, not silently dropped", required: "unlisted key probe0 is unsupported", mutate: ({ header, rewrite, next }) =>
    header === "probe0" ? rewrite({ header: "zdr" }) : next() },
  { id: "G21", clause: "unlisted attest values must be refused", required: "unlisted attest refuses attest=probe0", mutate: ({ header, rewrite, next }) =>
    header === "attest=probe0" ? rewrite({ header: "attest=weights" }) : next() },
  ...(["bits=32", "region=jp,de", "only=0,a-b_c.d", "ignore=0,a-b_c.d", "order=0,a-b_c.d"] as const)
    .map((policy): Clause => ({
      id: "G21", clause: `listed fixed domain must accept ${policy}`, required: "advertised support accepts every key and value sent; unsupported is not justified",
      mutate: ({ header, suffix, next }) => header === policy && suffix === null
        ? protocolError("unsupported", policy.split("=")[0]) : next(),
    })),
  { id: "G22", clause: "a bound key policy must be a string", required: "key_policy is a string", mutate: detectionResponse({ route_policy: "1", key_policy: 1 }, { credentialed: true }) },
  { id: "G22", clause: "a bound policy cannot repeat a key", required: "key_policy fits the policy grammar: repeated key", mutate: detectionResponse({ route_policy: "1", key_policy: "zdr+zdr" }, { credentialed: true }) },
  { id: "G22", clause: "a bound policy cannot name an unlisted key", required: "key_policy valid under the advertised lists: fails the order of checks under the reply's lists: key not listed", mutate: detectionResponse({ route_policy: "1", keys: ["zdr"], key_policy: "notrain" }, { credentialed: true }) },
  ...([
    ["top-level model list is an object", "models response must be an object with a data array", []],
    ["data is an array", "models response must be an object with a data array", { data: { id: model, routes: published } }],
    ["model entry is an object with an id", "invalid or repeated model entry: null", { data: [null] }],
    ["model ids are unique", "invalid or repeated model entry: {\"id\":\"other/example-model.v2\",\"routes\":[]}", { data: [{ id: model, routes: [] }, { id: model, routes: [] }] }],
    ["model has a routes array", "invalid or repeated model entry: {\"id\":\"other/example-model.v2\"}", { data: [{ id: model }] }],
    ["provider id obeys the grammar", "invalid or repeated provider on other/example-model.v2: {\"provider\":\"Aurora\",\"facts\":\"\"}", { data: [{ id: model, routes: [{ provider: "Aurora", facts: "" }] }] }],
    ["route must publish facts", "facts must be a string for other/example-model.v2/aurora", { data: [{ id: model, routes: [{ provider: "aurora" }] }] }],
    ["published facts obey the grammar", "invalid facts for other/example-model.v2/aurora: repeated key", { data: [{ id: model, routes: [{ provider: "aurora", facts: "zdr+zdr" }] }] }],
    ["a route with attest publishes evidence", "invalid or missing evidence URI for other/example-model.v2/basalt", { data: [{ id: model, routes: [{ provider: "basalt", facts: "attest=weights" }] }] }],
    ["published evidence has an evidence URI", "invalid or missing evidence URI for other/example-model.v2/basalt", { data: [{ id: model, routes: [{ provider: "basalt", facts: "attest=weights", evidence: "http://basalt.example/" }] }] }],
  ] as const).map(([clause, required, value]): Clause => ({ id: "G23", clause, required, mutate: catalogResponse(value) })),
  { id: "G24", clause: "unknown only must match nothing", required: "an unknown provider id does not make an excluded route qualify", mutate: ({ header, rewrite, next }) =>
    header === "only=routeprobe0" ? rewrite({ header: "zdr" }) : next() },
  { id: "G24", clause: "an unknown only entry cannot erase a known match", required: "an unknown provider id does not remove the remaining matching routes", mutate: ({ header, rewrite, next }) =>
    header === "only=routeprobe0,aurora" ? rewrite({ header: "only=routeprobe0" }) : next() },
  { id: "G24", clause: "unknown ignore cannot remove other providers", required: "an unknown provider id does not remove the remaining matching routes", mutate: ({ header, rewrite, next }) =>
    header === "ignore=routeprobe0" ? rewrite({ header: "only=routeprobe0" }) : next() },
  { id: "G24", clause: "unknown ignore cannot erase a known exclusion", required: "an unknown provider beside a known provider does not change ignore", mutate: ({ header, rewrite, next }) =>
    header === "ignore=routeprobe0,aurora" ? rewrite({ header: "only=aurora" }) : next() },
  { id: "G24", clause: "mixed order cannot reject an unknown id as invalid", required: "a syntactically valid unknown provider id is not an unsupported value", mutate: ({ header, next }) =>
    header === "order=routeprobe0,aurora" ? protocolError("unsupported", "order") : next() },
  { id: "G25", clause: "nonstring model errors must precede policy validation", required: "the same ordinary error status 400 as the no-policy control, with no result headers", mutate: ({ header, body, next }) =>
    header === "bits=0" && typeof body.model === "number" ? protocolError("unsupported", "bits") : next() },
  ...([applied, refusal, evidence] as const).map((name): Clause => ({
    id: "G25", clause: `an unreadable body must not return ${name}`,
    required: "the same ordinary error status 400 as the no-policy control, with no result headers", mutate: async ({ request, transport, header, body, next }) => {
      const reply = await next();
      if (request.method !== "POST" || !transport?.repeatedRoutePolicy || header === null || Object.keys(body).length > 0) return reply;
      return change(reply, { replace: { [name]: name === applied ? formatApplied("aurora")
        : name === refusal ? formatRefused("unsupported", "bits") : "https://aurora.example/evidence" } });
    },
  })),
  { id: "G26", clause: "policy-free inference cannot carry a refusal", required: "no Route-Refused or Route-Evidence without a policy", mutate: async ({ request, auth, header, suffix, next }) => {
    const reply = await next();
    return request.method === "POST" && auth === `Bearer ${key}` && header === null && suffix === null && reply.ok
      ? protocolError("unavailable") : reply;
  } },
  { id: "G29", clause: "unsatisfiable takes precedence over unavailable", required: "unsatisfiable takes precedence over unavailable", mutate: ({ header, suffix, next }) =>
    header === "bits=64" && suffix === null ? protocolError("unavailable") : next() },
  { id: "G29", clause: "an unsupported policy cannot be masked by unavailable", required: "unsupported takes precedence over unavailable", mutate: ({ header, suffix, next }) =>
    header === "zdr" && suffix === "bits=0" ? protocolError("unavailable") : next() },
];

function receivedHead(reply: Response): string {
  const value = (name: string) => {
    const text = reply.headers.get(name);
    return text === null ? [] : [text];
  };
  return JSON.stringify({
    status: reply.status, contentType: reply.headers.get("content-type") ?? undefined,
    applied: value(applied), refused: value(refusal), evidence: value(evidence),
  }).slice(0, -1);
}

for (const { id, clause, required, mutate, target } of clauses) test(`${id}: clause matrix — ${clause}`, async (t) => {
  const altered = new Set<string>();
  const report = await run(t, fixture(async (exchange) => {
    let original: Response | undefined;
    const reply = await mutate({ ...exchange, next: async () => {
      original = await exchange.next();
      return original;
    } });
    if (reply !== original) altered.add(receivedHead(reply));
    return reply;
  }, target));
  assert.ok(altered.size > 0, "the suite reached the deliberately broken branch");
  const verdict = report.checks.find((entry) => entry.id === id);
  assert.equal(verdict?.status, "FAIL", JSON.stringify(report.checks.filter((entry) => entry.status !== "PASS")));
  assert.match(verdict.detail, /sent \{.*; received .*; required:/);
  assert.ok([...altered].some((head) => verdict.detail.includes(`; received ${head}`)), verdict.detail);
  assert.equal(verdict.detail.split("; required: ").at(-1), required);
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
    } else if (header !== null && header !== "zdr") return next();
    return Response.json({ error: { message: "try later", type: "rate_limit" } }, { status: 429 });
  }));
  assert.ok(challengeSeen);
  const verdict = report.checks.find(({ id }) => id === "G25");
  assert.equal(verdict?.status, broken ? "FAIL" : "PASS");
  if (broken) assert.match(verdict.detail, /both bound-key controls are throttled/);
  else assert.equal(report.failed, 0);
});

test("G25 G34: a corroborated Responses rate limit supplies the only matching refusal shape for its credential", async (t) => {
  const problem = { type: "urn:demo:rejected", title: "Request rejected" };
  const media = { "content-type": "application/problem+json" };
  const throttled = new Set<string | null>();
  let ordinaryRefusals = 0;
  const report = await run(t, fixture(async ({ id, auth, header, suffix, body, next }) => {
    if (auth !== `Bearer ${policyKey}` || id !== model || suffix !== null) return next();
    if ((header === null || header === "zdr" || header === "bits=0") && typeof body.input === "string" && body.max_output_tokens === 16
      && !Object.hasOwn(body, "route_conformance_unknown_field")) {
      throttled.add(header);
      return Response.json(problem, { status: 429, headers: media });
    }
    const reply = await next();
    if (header !== "only=0,a-b_c.d") return reply;
    assert.equal(reply.headers.get(refusal), "reason=unsatisfiable");
    ordinaryRefusals++;
    return change(reply, { body: JSON.stringify(problem), replace: media });
  }), ["responses"]);
  assert.deepEqual(throttled, new Set([null, "zdr", "bits=0"]));
  assert.equal(ordinaryRefusals, 1);
  assert.equal(report.failed, 0, JSON.stringify(report.checks.filter(({ status }) => status === "FAIL")));
  assert.equal(report.checks.find(({ id }) => id === "G25")?.status, "PASS");
  assert.equal(report.checks.find(({ id }) => id === "G34")?.status, "PASS");
});

test("G2 G21: the audit catches unsupported and invented attribution on a separate streaming probe", async (t) => {
  let broken = 0;
  const report = await run(t, fixture(({ body, header, next }) => {
    if (body.stream !== true || header !== "zdr") return next();
    broken++;
    return protocolError("unsupported", "zdr");
  }));
  assert.equal(broken, 1);
  assertFailure(report, "G2", /stream\\":true.*; required: no accepted key can be named as a failing key$/);
  assertFailure(report, "G21", /stream\\":true.*; required: advertised support accepts every key and value sent/);
});

test("G20 G22: bad credentialed detection status does not itself invalidate an otherwise valid key policy", async (t) => {
  const report = await run(t, fixture(async ({ path, auth, next }) => {
    const reply = await next();
    if (path !== "/v1/route-policy" || auth !== `Bearer ${policyKey}`) return reply;
    return change(reply, { status: 201 });
  }));
  assertFailure(report, "G20", /required: a complete valid detection reply: status is 201, not 200$/);
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

test("G15: a single selected endpoint may commit a valid response slowly", async (t) => {
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

for (const query of ["", "?", "?tenant=east", "?a=first&a=second", "?tag=O'Brien", "?tag=O%27Brien", "?tag=a%2bb&tag=a+b&flag=%3F"]) {
  test(`G20 G23 G9: raw request targets retain ${query === "" ? "no query" : JSON.stringify(query)}`, async (t) => {
    const upstream = await baseAt(t, serve(good, 0), "");
    const paths = ["route-policy", "models", ...INFERENCE_ENDPOINTS].map((endpoint) => `/v1/${endpoint}${query}`);
    const actual = new Set<string | undefined>();
    const proxy = createServer((incoming, outgoing) => {
      actual.add(incoming.url);
      if (incoming.url === undefined || !paths.includes(incoming.url)) {
        outgoing.writeHead(404).end();
        return;
      }
      const relay = relayRequest(new URL(incoming.url, upstream), { method: incoming.method, headers: incoming.rawHeaders }, (reply) => {
        outgoing.writeHead(reply.statusCode!, reply.rawHeaders);
        reply.pipe(outgoing);
        outgoing.on("close", () => reply.destroy());
      });
      relay.on("error", () => outgoing.destroy());
      incoming.pipe(relay);
    }).listen(0, "127.0.0.1");
    const report = await runConformance({ base: await baseAt(t, proxy, `/v1${query}`), key, policyKey, endpoints: INFERENCE_ENDPOINTS });
    assert.deepEqual(actual, new Set(paths));
    assert.deepEqual(report.checks.filter(({ status }) => status !== "PASS"), []);
    assert.equal(report.passed, 63);
  });
}

test("G20 G23: an unescaped base request target is rejected before any probe", async (t) => {
  let count = 0;
  const base = await baseAt(t, serve((request, transport) => { count++; return good(request, transport); }, 0));
  for (const invalid of [`${base}?tenant=two words`, `${base}/naïve`, `${base}?tenant=\tq`, `${base}?tenant=\r\nq`, `${base}?tenant=\x00q`, `${base}\\tenant`]) {
    await assert.rejects(runConformance({ base: invalid }), /cannot reproduce the base URL's request target exactly/);
  }
  assert.equal(count, 0);
});

for (const { title, policy, lists, verdict, detail } of [
  { title: "numeric policy is invalid even with malformed keys", policy: 17, lists: { keys: "zdr" }, verdict: "FAIL", detail: /key_policy is a string/ },
  { title: "null policy is invalid even with a malformed sort list", policy: null, lists: { sort: null }, verdict: "FAIL", detail: /key_policy is a string/ },
  { title: "malformed policy grammar fails even with malformed attest", policy: "zdr++notrain", lists: { attest: ["bad value"] }, verdict: "FAIL", detail: /key_policy fits the policy grammar/ },
  { title: "valid grammar is inconclusive when support cannot be read", policy: "later=valid", lists: { keys: "zdr" }, verdict: "SKIP", detail: /valid advertised lists to check key_policy: keys/ },
  { title: "valid later-revision policy can be checked under its advertised support", policy: "later=valid", lists: { keys: ["later"] }, verdict: "PASS", detail: /valid under its own lists/ },
] as const) test(`G22: ${title}`, async (t) => {
  const report = await run(t, fixture(detectionResponse({ route_policy: "1", ...lists, key_policy: policy }, { credentialed: true })));
  const check = report.checks.find(({ id }) => id === "G22");
  assert.equal(check?.status, verdict);
  assert.match(check.detail, detail);
});

test("G22: a non-object detection reply cannot establish absence of a key policy", async (t) => {
  const report = await run(t, fixture(detectionResponse(null)));
  assertFailure(report, "G20", /required: a complete valid detection reply: not a JSON object$/);
  const check = report.checks.find(({ id }) => id === "G22");
  assert.equal(check?.status, "SKIP");
  assert.match(check.detail, /an inspectable detection object/);
});

for (const [mode, assertion] of [
  ["optional-observed", "passes when a sampled problem JSON has the same optional errors array"],
  ["optional-unseen", "skips when no sampled problem JSON shows the refusal's errors member"],
  ["known-bad-type", "fails when the refusal changes errors[].field from string to number"],
] as const) {
  test(`G34: ${assertion}`, async (t) => {
    const additionalControls = new Set<string | null>();
    const report = await run(t, async (request, transport) => {
      const raw = request.method === "POST" ? await request.clone().text() : undefined;
      const reply = await good(request, transport);
      if (raw === undefined || reply.status < 400) return reply;
      const refused = reply.headers.has(refusal);
      if (raw === '{"model":null}') additionalControls.add(request.headers.get("authorization"));
      const showOptional = refused ? request.headers.get("route-policy") !== "bits=64"
        : mode !== "optional-unseen" && raw === '{"model":null}';
      const problem = { type: "about:blank", title: "Invalid request",
        ...(showOptional ? { errors: [{ field: mode === "known-bad-type" && refused ? 4 : "model" }] } : {}),
      };
      return change(reply, { body: JSON.stringify(problem), replace: { "content-type": "application/problem+json" } });
    });
    assert.deepEqual(additionalControls, new Set([`Bearer ${key}`, `Bearer ${policyKey}`]));
    const check = report.checks.find(({ id }) => id === "G34");
    const expected = mode === "optional-observed" ? "PASS" : mode === "optional-unseen" ? "SKIP" : "FAIL";
    assert.equal(check?.status, expected, JSON.stringify(report.checks.filter(({ status }) => status !== "PASS")));
    if (mode === "optional-unseen") assert.match(check.detail, /ordinary error control showing refusal member \$\.errors/);
    if (mode === "known-bad-type") assert.match(check.detail, /errors\[\]\.field has type number/);
    if (mode !== "known-bad-type") assert.equal(report.failed, 0);
  });
}

test("G8 G9 G11: structural policy errors alone cannot verify an accepted carrier", async (t) => {
  const target = createGateway({
    models: { [model]: routes }, keys: { [key]: {}, [policyKey]: {} }, accept: { keys: [] },
    fetch: () => Response.json({ output: "served" }),
  });
  const report = await run(t, target);
  assert.equal(report.failed, 0);
  for (const id of ["G8", "G9", "G11"]) assert.equal(report.checks.find((entry) => entry.id === id)?.status, "SKIP");
});

for (const broken of ["none", "header", "suffix"] as const) {
  test(`G11: a one-route catalog exposes ${broken === "none" ? "both valid carrier orders" : `dropping the impossible ${broken} requirement`}`, async (t) => {
    const open = createGateway({
      models: { [model]: [{ ...routes[0]!, facts: "zdr" }] }, accept: { keys: ["zdr", "notrain"] },
      fetch: () => Response.json({ output: "served" }),
    });
    const pairs = new Set<string>();
    const report = await run(t, fixture(({ header, suffix, next, rewrite }) => {
      if ((header !== "zdr" || suffix !== "notrain") && (header !== "notrain" || suffix !== "zdr")) return next();
      pairs.add(`${header}:${suffix}`);
      if (broken === "header" && header === "notrain") return rewrite({ header: null });
      if (broken === "suffix" && suffix === "notrain") return rewrite({ suffix: null });
      return next();
    }, open));
    const check = report.checks.find(({ id }) => id === "G11");
    assert.equal(check?.status, broken === "none" ? "PASS" : "FAIL");
    if (broken === "none") assert.deepEqual(pairs, new Set(["zdr:notrain", "notrain:zdr"]));
    if (broken === "header") assert.ok(pairs.has("notrain:zdr"));
    if (broken === "suffix") assert.ok(pairs.has("zdr:notrain"));
    if (broken !== "none") assert.match(check.detail, /both valid carriers constrain the request/);
  });
}

test("G11: a policy satisfied by the sole route in both carriers cannot demonstrate omission of either", async (t) => {
  const open = createGateway({
    models: { [model]: [routes[0]!] }, accept: { keys: ["zdr"] },
    fetch: () => Response.json({ output: "served" }),
  });
  const report = await run(t, open);
  const check = report.checks.find(({ id }) => id === "G11");
  assert.equal(check?.status, "SKIP");
  assert.match(check.detail, /distinguishing omission of the header and suffix/);
});

for (const order of [[0, 1], [1, 0]] as const) test(`G11: provider-only narrowing ${order[0] === 0 ? "is observable with the weaker provider first" : "is inconclusive when the comparison relays name the same provider"}`, async (t) => {
  const modelRoutes = [{ ...routes[0]!, facts: "bits=8" }, { ...routes[1]!, facts: "bits=64", evidence: undefined }];
  const open = createGateway({
    models: { [model]: order.map((i) => {
      const { evidence: _evidence, ...route } = modelRoutes[i]!;
      return route;
    }) }, accept: { keys: ["bits"] },
    fetch: () => Response.json({ output: "served" }),
  });
  const relays = new Map<string, string | null>();
  const report = await run(t, fixture(async ({ id, header, suffix, next }) => {
    const reply = await next();
    if (id === model && (header === "bits=1" || suffix === "bits=1")) relays.set(`${header}|${suffix}`, reply.headers.get(applied));
    return reply;
  }, open));
  const weakerAlone = order[0] === 0 ? "provider=aurora" : "provider=basalt";
  assert.equal(relays.get("bits=1|null"), weakerAlone);
  assert.equal(relays.get("null|bits=1"), weakerAlone);
  assert.equal(relays.get("bits=1|bits=64"), "provider=basalt");
  assert.equal(relays.get("bits=64|bits=1"), "provider=basalt");
  const check = report.checks.find(({ id }) => id === "G11");
  assert.equal(check?.status, order[0] === 0 ? "PASS" : "SKIP");
});

for (const comparable of [true, false]) test(`G34: a missing traceId ${comparable ? "matches a negative output token limit error" : "is inconclusive even when all field controls include it"}`, async (t) => {
  const fieldControls = new Set<string | null>();
  const report = await run(t, fixture(async ({ body, request, auth, next }) => {
    if (request.method !== "POST") return next();
    const problem = { type: "about:blank", title: "Bad request" };
    const headers = { "content-type": "application/problem+json" };
    if (body.model === model && body.max_output_tokens === -1) {
      fieldControls.add(auth);
      return Response.json(comparable ? problem : { ...problem, traceId: "ordinary" }, { status: 400, headers });
    }
    const reply = await next();
    if (reply.status < 400) return reply;
    const details = reply.headers.has(refusal) ? problem : { ...problem, traceId: "ordinary" };
    return change(reply, { body: JSON.stringify(details), replace: headers });
  }), ["responses"]);
  assert.deepEqual(fieldControls, new Set([`Bearer ${key}`, `Bearer ${policyKey}`]));
  const check = report.checks.find(({ id }) => id === "G34");
  assert.equal(check?.status, comparable ? "PASS" : "SKIP");
  if (comparable) assert.match(check.detail, /matches an ordinary error shape observed on this endpoint and credential/);
  else assert.match(check.detail, /missing refusal members \$\.traceId cannot be established/);
  assert.equal(report.failed, 0, JSON.stringify(report.checks.filter(({ status }) => status === "FAIL")));
});

test("G12: a non-default published region exposes dropped intersections", async (t) => {
  const target = createGateway({
    models: { [model]: [{ ...routes[0]!, facts: "region=jp" }] }, accept: { keys: ["region"] },
    fetch: () => Response.json({ output: "served" }),
  });
  let altered = 0;
  const report = await run(t, fixture(({ header, suffix, next, rewrite }) => {
    if (header !== "region=jp" || suffix !== "region=de") return next();
    altered++;
    return rewrite({ suffix: null });
  }, target));
  assert.equal(altered, 1);
  assertFailure(report, "G12", /region=jp.*region=de.*; required: 400 unsatisfiable for an empty intersection in either carrier order$/);
});

test("G12: no route with a region fact cannot distinguish empty intersection from either input alone", async (t) => {
  const target = createGateway({
    models: { [model]: [routes[2]!] }, accept: { keys: ["region"] },
    fetch: () => Response.json({ output: "served" }),
  });
  const report = await run(t, target);
  assert.equal(report.failed, 0);
  const check = report.checks.find(({ id }) => id === "G12");
  assert.equal(check?.status, "SKIP");
  assert.match(check.detail, /a qualifying published region/);
});

test("G10: a sole route already meeting the bound requirement cannot show its narrowing effect", async (t) => {
  const target = createGateway({
    models: { [model]: [routes[0]!] }, keys: { [key]: {}, [policyKey]: { policy: "zdr" } },
    fetch: () => Response.json({ output: "served" }),
  });
  const report = await run(t, target);
  assert.equal(report.failed, 0);
  const check = report.checks.find(({ id }) => id === "G10");
  assert.equal(check?.status, "SKIP");
  assert.match(check.detail, /qualification can distinguish applying the bound key policy/);
});

test("G13: a common provider cannot establish a bound requirement was retained", async (t) => {
  const target = createGateway({
    models: { [model]: [routes[0]!, routes[2]!] }, accept: { keys: ["zdr", "sort"] },
    keys: { [key]: {}, [policyKey]: { policy: "zdr" } },
    fetch: () => Response.json({ output: "served" }),
  });
  const report = await run(t, target);
  assert.equal(report.failed, 0);
  const check = report.checks.find(({ id }) => id === "G13");
  assert.equal(check?.status, "SKIP");
  assert.match(check.detail, /routes are all excluded by the bound requirement/);
});

test("G7: a sort-only gateway can demonstrate that a preference does not remove its route", async (t) => {
  const target = createGateway({
    models: { [model]: [routes[0]!] }, accept: { keys: ["sort"], sort: ["price"] },
    fetch: () => Response.json({ output: "served" }),
  });
  let header = false;
  let suffix = false;
  const report = await run(t, fixture((probe) => {
    header ||= probe.header === "sort=price";
    suffix ||= probe.suffix === "sort=price";
    return probe.next();
  }, target));
  assert.ok(header && suffix);
  assert.equal(report.checks.find(({ id }) => id === "G7")?.status, "PASS");
});

for (const additional of ["bits", "sort"] as const) test(`G11: impossible precision is tested in both orders with a matching ${additional} carrier`, async (t) => {
  const target = createGateway({
    models: { [model]: [{ ...routes[0]!, facts: additional === "bits" ? "bits=8" : "" }] },
    accept: { keys: additional === "bits" ? ["bits"] : ["bits", "sort"], sort: ["price"] },
    fetch: () => Response.json({ output: "served" }),
  });
  const partner = additional === "bits" ? "bits=1" : "sort=price";
  const impossible = additional === "bits" ? "bits=64" : "bits=1";
  const pairs = new Set<string>();
  const report = await run(t, fixture(({ header, suffix, next }) => {
    if (header !== null && suffix !== null && [header, suffix].includes(impossible) && [header, suffix].includes(partner)) {
      pairs.add(`${header}:${suffix}`);
    }
    return next();
  }, target));
  assert.deepEqual(pairs, new Set([`${partner}:${impossible}`, `${impossible}:${partner}`]));
  assert.equal(report.checks.find(({ id }) => id === "G11")?.status, "PASS");
});

for (const broken of [false, true]) test(`G3 G6: opaque future defaults ${broken ? "cannot admit an explicitly excluded provider" : "preserve explicit impossibility without proving complete qualification"}`, async (t) => {
  const local = { ...routes[0]!, provider: "local" };
  const policy = "only=0,a-b_c.d";
  let opaqueRefusals = 0;
  const replies: { status: number; applied: string | null }[] = [];
  const report = await run(t, fixture(async ({ path, auth, header, next, rewrite }) => {
    if (path === "/v1/route-policy" && auth !== null) {
      return Response.json({ route_policy: "1", keys: ["only", "order", "future"], key_policy: "future=narrow" });
    }
    if (header === "order=0,a-b_c.d") {
      opaqueRefusals++;
      return protocolError("unsatisfiable");
    }
    if (header !== policy) return next();
    const reply = broken ? await rewrite({ header: "only=local" }) : await next();
    replies.push({ status: reply.status, applied: reply.headers.get(applied) });
    return reply;
  }, createGateway({
    models: { [model]: [local] }, keys: { [key]: { policy: "order=local" }, [policyKey]: { policy: "order=local" } }, accept: { keys: ["only", "order"] },
    fetch: () => Response.json({ output: "served" }),
  })));
  assert.equal(replies.length, 2);
  assert.equal(opaqueRefusals, 2, "compatible explicit policies are not proof of qualification under an opaque default");
  for (const reply of replies) assert.deepEqual(reply, broken ? { status: 200, applied: "provider=local" } : { status: 400, applied: null });
  assert.equal(report.checks.find(({ id }) => id === "G3")?.status, broken ? "FAIL" : "PASS");
  if (broken) assertFailure(report, "G3", /only=0,a-b_c\.d.*; required: the policy must be refused as unsatisfiable$/);
  const qualification = report.checks.find(({ id }) => id === "G6");
  if (!broken) assert.equal(report.checks.find(({ id }) => id === "G15")?.status, "PASS");
  assert.equal(qualification?.status, broken ? "FAIL" : "SKIP", JSON.stringify(report.checks.filter(({ status }) => status === "FAIL")));
  if (broken) assert.match(qualification.detail, /only=0,a-b_c\.d.*known requirements/);
  else assert.equal(report.failed, 0);
});

test("G3 G29: an unavailable reply cannot claim qualification after a known empty intersection without detection", () => {
  const header = parsePolicy("only=aurora");
  const suffix = parsePolicy("only=basalt");
  assert.ok(header.ok && suffix.ok);
  const known = combinePolicies({ header: header.value, suffix: suffix.value });
  const audit = auditResults([{
    probe: { path: "responses", raw: JSON.stringify({ model: `${model}+only=basalt` }), policies: ["only=aurora"] },
    reply: { status: 503, body: undefined, hasBody: true, contentType: "text/plain", applied: [], refused: ["reason=unavailable"], evidence: [], received: "503 reason=unavailable" },
  }], () => ({ carriesPolicy: true, known, impossible: true }));
  assert.match(audit.failures.get("G3") ?? "", /unavailable presupposes a qualifying route/);
  assert.match(audit.failures.get("G29") ?? "", /unavailable must not mask a refusal before routing/);
});

test("G3: a relay cannot claim qualification after a known empty intersection without detection", () => {
  const header = parsePolicy("only=aurora");
  const suffix = parsePolicy("only=basalt");
  assert.ok(header.ok && suffix.ok);
  const known = combinePolicies({ header: header.value, suffix: suffix.value });
  const audit = auditResults([{
    probe: { path: "responses", raw: JSON.stringify({ model: `${model}+only=basalt` }), policies: ["only=aurora"] },
    reply: { status: 200, body: { text: "served" }, hasBody: true, contentType: "application/json",
      applied: ["provider=aurora"], refused: [], evidence: [], received: "200 provider=aurora" },
  }], () => ({ carriesPolicy: true, known, impossible: true }));
  assert.match(audit.failures.get("G3") ?? "", /no route can meet even the known requirements/);
});

test("G24: a selector naming only unpublished providers cannot return unavailable", async (t) => {
  const report = await run(t, fixture(({ header, next }) =>
    header === "only=0,a-b_c.d" ? protocolError("unavailable") : next()));
  assertFailure(report, "G24", /only=0,a-b_c\.d.*"refused":\["reason=unavailable"\].*; required: a valid selector containing an unknown provider is not unsupported and cannot make a nonexistent route available$/);
});

for (const { title, media, ordinary, refused, note } of [
  { title: "XML does not get a structural verdict", media: "application/xml", ordinary: "<error><message>bad request</message></error>", refused: "<completion><text>synthetic success</text></completion>", note: /refusal body is application\/xml; structure not compared/ },
  { title: "JSON-looking text/plain does not get a structural verdict", media: "text/plain", ordinary: '{"error":{"message":"bad request"}}', refused: '{"error":{"message":"bad policy"}}', note: /refusal body is text\/plain; structure not compared/ },
  { title: "a refusal array element cannot be assembled from two observed shapes", media: "application/problem+json", ordinary: '{"problems":[{"column":3},{"path":"/m"}]}', refused: '{"problems":[{"column":3,"path":"/m"}]}', note: /same whole refusal shape \(difference at \$\.problems\[\]\)/ },
  { title: "a proper subset of the observed array element shapes is inconclusive", media: "application/problem+json", ordinary: '{"problems":[{"column":3},{"path":"/m"}]}', refused: '{"problems":[{"column":3}]}', note: /same whole refusal shape \(difference at \$\.problems\[\]\)/ },
] as const) test(`G34: ${title}`, async (t) => {
  const seen = new Set<string>();
  const report = await run(t, async (request, transport) => {
    const reply = await good(request, transport);
    if (request.method !== "POST" || reply.status < 400) return reply;
    const body = reply.headers.has(refusal) ? refused : ordinary;
    seen.add(body);
    return change(reply, { body, replace: { "content-type": media } });
  });
  assert.deepEqual(seen, new Set([ordinary, refused]));
  assert.equal(report.failed, 0);
  const check = report.checks.find(({ id }) => id === "G34");
  assert.equal(check?.status, "SKIP");
  assert.match(check.detail, note);
});

test("G34: complete JSON shapes cannot be assembled across ordinary error bodies", async (t) => {
  const report = await run(t, async (request, transport) => {
    const raw = request.method === "POST" ? await request.clone().text() : undefined;
    const reply = await good(request, transport);
    if (raw === undefined || reply.status < 400) return reply;
    const body = reply.headers.has(refusal) ? { column: 3, path: "/m" } : raw === "{" ? { column: 3 } : { path: "/m" };
    return change(reply, { body: JSON.stringify(body) });
  });
  assert.equal(report.failed, 0);
  const check = report.checks.find(({ id }) => id === "G34");
  assert.equal(check?.status, "SKIP");
  assert.match(check.detail, /same whole refusal shape \(difference at \$\.(path|column)\)/);
});

test("G34: malformed declared JSON fails and names the sampled error count and kinds", async (t) => {
  const report = await run(t, fixture(async ({ next }) => {
    const reply = await next();
    return reply.headers.has(refusal) ? change(reply, { body: '{"error":' }) : reply;
  }));
  const check = report.checks.find(({ id }) => id === "G34");
  assert.equal(check?.status, "FAIL");
  assert.match(check.detail, /expected a JSON error body/);
  assert.match(check.detail, /\bbased on [1-9]\d* sampled ordinary errors\b/);
  assert.match(check.detail, /malformed JSON, HTTP 400 application\/json/);
  assert.match(check.detail, /wrong model type, HTTP 400 application\/json/);
});

test("G34: a JSON refusal without a comparable ordinary error cannot establish a shape", async (t) => {
  const report = await run(t, fixture(async ({ request, next }) => {
    const reply = await next();
    return request.method === "POST" && reply.status >= 400 && !reply.headers.has(refusal) ? change(reply, { body: "" }) : reply;
  }));
  const check = report.checks.find(({ id }) => id === "G34");
  assert.equal(check?.status, "SKIP");
  assert.match(check.detail, /ordinary JSON error body under the same credential/);
});

test("G34: no observed Route-Refused field means there is no refusal shape to verify", async (t) => {
  const report = await run(t, fixture(async ({ next }) => {
    const reply = await next();
    return reply.headers.has(refusal) ? change(reply, { replace: { [refusal]: null } }) : reply;
  }));
  const check = report.checks.find(({ id }) => id === "G34");
  assert.equal(check?.status, "SKIP");
  assert.match(check.detail, /an observed refusal/);
});

for (const scope of ["endpoint", "credential"] as const) test(`G34: a matching JSON shape from another ${scope} cannot certify the refusal`, () => {
  const context = { carriesPolicy: true };
  const probe = { path: "responses", credential: { key, header: "authorization" } } as const;
  const reply = {
    status: 400, body: { error: { message: "bad request" } }, hasBody: true, contentType: "application/json",
    applied: [], refused: [], evidence: [], received: "HTTP 400",
  };
  const elsewhere = scope === "endpoint" ? { ...probe, path: "chat/completions" }
    : { ...probe, credential: { ...probe.credential, key: policyKey } };
  const audit = auditResults([
    { probe: elsewhere, reply, ordinaryControl: "wrong input field" },
    { probe, reply: { ...reply, refused: [formatRefused("unsupported")] } },
  ], () => context);
  assert.equal(audit.failures.has("G34"), false);
  assert.equal(audit.shapeUnverified, "an ordinary JSON error body under the same credential");
});

test("G34: whole-shape matching reads each nested singleton node once per body as depth increases", () => {
  for (const depth of [0, 1, 2, 4, 8, 16, 32]) {
    let reads = 0;
    function nested(value: number): unknown {
      let node: unknown = { get leaf() { reads++; return value; } };
      for (let i = 0; i < depth; i++) {
        const child = node;
        const array: unknown[] = [null];
        Object.defineProperty(array, 0, { get() { reads++; return child; } });
        node = array;
      }
      return node;
    }
    const probe = { path: "responses" };
    const reply = { status: 400, hasBody: true, contentType: "application/json", applied: [], refused: [], evidence: [], received: "HTTP 400" };
    const audit = auditResults([
      { probe, reply: { ...reply, body: nested(1) }, ordinaryControl: "wrong input field" },
      { probe, reply: { ...reply, body: nested(2), refused: [formatRefused("unsupported")] } },
    ], () => ({ carriesPolicy: true }));
    assert.equal(audit.failures.has("G34"), false);
    assert.equal(audit.shapeUnverified, undefined);
    assert.equal(reads, 2 * (depth + 1), `array depth ${depth}`);
  }
});
