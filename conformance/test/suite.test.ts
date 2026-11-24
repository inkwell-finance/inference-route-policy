import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as relayRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from "node:zlib";
import { formatApplied, formatRefused, REFUSAL_STATUS, splitModel, type RefusalReason } from "../../core/src/index.ts";
import { startDemo } from "../../gateway/src/demo.ts";
import { createGateway, type RequestHandler, type Route } from "../../gateway/src/gateway.ts";
import { serve } from "../../gateway/src/serve.ts";
import { parseBase, request as wireRequest, type Probe } from "../src/http.ts";
import { auditResults } from "../src/outcomes.ts";
import { INFERENCE_ENDPOINTS, resultContext, runConformance, type Endpoint } from "../src/suite.ts";
import { expectReport, reportTest, failure, skip, expectationsFor } from "./report.ts";
import { expectedByCase, discovery, catalogs, get, inference, received, error } from "./report-cases.ts";

const key = "probe-key";
const policyKey = "probe-policy-key";
const model = "other/example-model.v2";
const refusal = "route-refused";
const applied = "route-applied";
const evidence = "route-evidence";
const wideningPolicy = "bits=9";
const streamingPolicy = "zdr";
const idList = ["G1", "G2", "G3", "G6", "G7", "G8", "G9", "G10", "G11", "G12", "G13", "G15", "G17", "G19", "G20", "G21", "G22", "G23", "G24", "G25", "G26", "G29"] as const;
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
  G13: ({ auth, header, suffix, next, rewrite }) => auth?.endsWith(policyKey) && header === wideningPolicy && suffix === wideningPolicy
    ? rewrite({ neutralKey: true }) : next(),
  G15: async ({ body, header, next }) => {
    const reply = await next();
    return body.stream === true && header === streamingPolicy ? change(reply, { replace: { [applied]: null } }) : reply;
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
  G25: ({ body, header, next }) => body.model === 4 && header === "bits=0" ? protocolError("unsupported", "bits") : next(),
  G26: async ({ request, auth, header, suffix, next }) => {
    const reply = await next();
    return request.method === "POST" && reply.ok && auth?.endsWith(key) && header === null && suffix === null ? change(reply, { replace: { [evidence]: "https://aurora.example/" } }) : reply;
  },
  G29: ({ header, suffix, next, rewrite }) => header === "bits=64" && suffix === "bits=0" ? rewrite({ suffix: null }) : next(),
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

reportTest("G12: the suite sends catalog providers first-x and second_y in both selector orientations", {
  "G12 [chat/completions]": ["PASS","the exercised empty intersections returned unsatisfiable in both carrier orders; observed 4 × HTTP 400 reason=unsatisfiable"],
}, async (t, expected) => {
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
  assert.ok(intersections.has("only=first-x|only=second_y"));
  assert.ok(intersections.has("only=second_y|only=first-x"));
  expectReport(report, expected);
});

const faultTitles: Record<Id, string> = {
  G1: "a relay for zdr++notrain fails instead of satisfying the unsupported check",
  G2: "bits=0+only=a,a fails when the refusal names only",
  G3: "bits=64 fails when the refusal is unavailable",
  G6: "bits=1 fails when attributed to cobalt",
  G7: "zdr+order=basalt fails when the preference leaves no eligible route",
  G8: "a relay for the +bits=64 alias fails suffix checking",
  G9: "mixed-case duplicate headers fail when the refusal names only",
  G10: "a request carrying just the bound zdr key fails when it relays basalt",
  G11: "header only=x,x and suffix bits=0 fail when the refusal names bits",
  G12: "header region=us with suffix region=de fails if their union relays",
  G13: `dropping the bound zdr from requests carrying ${wideningPolicy} in both carriers fails`,
  G15: `the streaming ${streamingPolicy} relay fails without Route-Applied`,
  G17: "Basalt's evidence URI with an added slash fails exact comparison",
  G19: "bits=64 unsatisfiable fails if it also names provider=aurora",
  G20: "anonymous detection fails with a numeric route_policy of 1",
  G21: "accepting sort=throughput fails when detection lists just price and latency",
  G22: "an anonymous key_policy=zdr produces a disclosure diagnostic",
  G23: "a duplicate aurora route fails catalog validation",
  G24: "order=routeprobe0 fails if it excludes qualifying routes",
  G25: "model=4 and bits=0 fail when a policy refusal replaces the headerless 400",
  G26: "an unbound policy-free relay fails if it carries Route-Evidence",
  G29: "header bits=64 with suffix bits=0 fails if unsatisfiable takes precedence",
};

for (const id of idList) reportTest(`${id}: ${faultTitles[id]} (BB fixture)`, expectedByCase.fault[id]!, async (t, expected) => {
  const report = await run(t, fixture(faults[id]));
  expectReport(report, expected);
});

reportTest("G22: an anonymous detection object carrying key_policy=zdr fails", {
  "G20": failure(get("/route-policy", null), received(200, JSON.stringify({"route_policy":"1","key_policy":"zdr"})), "a complete valid detection reply: is present in a reply to a request without credentials"),
  "G22": failure(get("/route-policy", null), received(200, JSON.stringify({"route_policy":"1","key_policy":"zdr"})), "key_policy absent for anonymous detection"),
}, async (t, expected) => {
  const report = await run(t, fixture(faults.G22));
  expectReport(report, expected);
});

reportTest("G22: key_policy=sort=latency fails when the credential advertises price", {
  "G20": failure(get("/route-policy"), received(200, JSON.stringify({"route_policy":"1","keys":["sort"],"sort":["price"],"key_policy":"sort=latency"})), "a complete valid detection reply: fails the order of checks under the reply's lists: value not accepted"),
  "G22": failure(get("/route-policy"), received(200, JSON.stringify({"route_policy":"1","keys":["sort"],"sort":["price"],"key_policy":"sort=latency"})), "key_policy valid under the advertised lists: fails the order of checks under the reply's lists: value not accepted"),
  "G10 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP",
}, async (t, expected) => {
  const report = await run(t, fixture(({ path, auth, next }) => path === "/v1/route-policy" && auth === `Bearer ${policyKey}`
    ? Response.json({ route_policy: "1", keys: ["sort"], sort: ["price"], key_policy: "sort=latency" })
    : next()));
  expectReport(report, expected);
});

reportTest("G23: a +zdr display alias without its base entry fails catalog validation", {
  "G23": failure(get("/models"), received(200, "{\"data\":[{\"id\":\"other/example-model.v2+zdr\",\"routes\":[{\"provider\":\"aurora\",\"facts\":\"zdr+notrain+bits=8+region=us\"},{\"provider\":\"basalt\",\"facts\":\"bits=16+region=us,de+attest=weights,prompt\",\"evidence\":\"https://basalt.example/attestation\"},{\"provider\":\"cobalt\",\"facts\":\"\"}]},{\"id\":\"other/example-model.v2-other\",\"routes\":[{\"provider\":\"aurora\",\"facts\":\"zdr+notrain+bits=8+region=us\"},{\"provider\":\"basalt\",\"facts\":\"bits=16+region=us,de+attest=weights,prompt\",\"evidence\":\"https://basalt.example/attestation\"},{\"provid…"), "display alias \"other/example-model.v2+zdr\" has no base model \"other/example-model.v2\""),
  "G1 [chat/completions]": "SKIP", "G2 [chat/completions]": "SKIP", "G3 [chat/completions]": "SKIP",
  "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G8 [chat/completions]": "SKIP",
  "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP",
  "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP",
  "G17 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
  "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
  "G19 [chat/completions]": "SKIP",
}, async (t, expected) => {
  const report = await run(t, fixture(({ path, next }) => path === "/v1/models"
    ? Response.json({ data: [{ id: `${model}+zdr`, routes: published }, { id: `${model}-other`, routes: published }] })
    : next()));
  expectReport(report, expected);
});

reportTest("G23: a +zdr display alias passes when its base entry follows it", catalogs(2), async (t, expected) => {
  const report = await run(t, fixture(({ path, next }) => path === "/v1/models"
    ? Response.json({ data: [{ id: `${model}+zdr`, routes: published }, { id: model, routes: published }] })
    : next()));
  expectReport(report, expected);
});

for (const variation of ["content-length", "chunked", "mixed-case headers", "extra headers", "informational replies", "stacked field lines"] as const) {
  reportTest(`G20: discovery passes through the fixture using ${variation}`, discovery(3), async (t, expected) => {
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
    expectReport(report, expected);
  });
}

reportTest("G20: discovery uses GET when HEAD returns 405 and OPTIONS returns 204", discovery(3), async (t, expected) => {
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
  expectReport(report, expected);
});

reportTest("G23: HTTP 204 from /models skips catalog validation", {
  "G23": skip("an inspectable model list; /models returned HTTP 204 No Content"),
  "G1 [chat/completions]": "SKIP", "G2 [chat/completions]": "SKIP", "G3 [chat/completions]": "SKIP",
  "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G8 [chat/completions]": "SKIP",
  "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP",
  "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP",
  "G17 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
  "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
  "G19 [chat/completions]": "SKIP",
}, async (t, expected) => {
  let catalogs = 0;
  const report = await run(t, fixture(({ path, next }) => {
    if (path !== "/v1/models") return next();
    catalogs++;
    return new Response(null, { status: 204 });
  }));
  assert.equal(catalogs, 2);
  expectReport(report, expected);
});

const contentCodings = [
  ["gzip", gzipSync],
  ["X-GZip", gzipSync],
  ["deflate", deflateSync],
  ["br", brotliCompressSync],
  ["zstd", zstdCompressSync],
  ["gzip, identity, br", (body: Uint8Array) => brotliCompressSync(gzipSync(body))],
] as const;

for (const [coding, encode] of contentCodings) reportTest(`G20: discovery through ${coding} Content-Encoding`, discovery(3), async (t, expected) => {
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
  const relay = await wireRequest(parseBase(base), {
    path: "chat/completions", credential: { header: "authorization", key }, raw: JSON.stringify({ model }), policies: ["zdr"],
  }, 1_000);
  assert.deepEqual(relay.body, { text: "served by aurora.example" });
  assert.deepEqual(used, new Set(["/v1/route-policy", "/v1/models", "ordinary", "refusal", "relay"]));
  expectReport(report, expected);
});

const uninspectableCases = [
  ["route-policy", ["G20", "G22"]], ["models", ["G23"]],
] as const;
const unsupportedCoding = "x-reversed-octets";
for (const [surface, affected] of uninspectableCases) reportTest(`${affected[0]}: ${unsupportedCoding} on ${surface}`, expectedByCase.coding[surface], async (t, expected) => {
  let encoded = 0;
  const report = await run(t, fixture(async ({ request, path, next }) => {
    const reply = await next();
    const kind = request.method === "GET" ? path.split("/").at(-1) : undefined;
    if (kind !== surface || reply.body === null) return reply;
    const headers = new Headers(reply.headers);
    headers.delete("content-length");
    headers.set("content-encoding", unsupportedCoding);
    encoded++;
    return new Response(new Uint8Array(await reply.arrayBuffer()).reverse(), { status: reply.status, headers });
  }));
  assert.ok(encoded > 0);
  expectReport(report, expected);
});

for (const variation of ["charset", "BOM", "trailing whitespace"] as const) reportTest(`G20: discovery JSON with ${variation}`, discovery(3), async (t, expected) => {
  const varied = new Set<string>();
  const report = await run(t, fixture(async ({ request, path, next }) => {
    const reply = await next();
    if (request.method !== "GET" || reply.body === null || !reply.headers.get("content-type")?.startsWith("application/json")) return reply;
    varied.add(path);
    const text = await reply.text();
    return variation === "charset" ? change(reply, { body: text, replace: { "content-type": "Application/JSON; Charset=UTF-8" } })
      : change(reply, { body: variation === "BOM" ? `\uFEFF${text}` : `${text} \r\n\t` });
  }));
  assert.deepEqual(varied, new Set(["/v1/route-policy", "/v1/models"]));
  expectReport(report, expected);
});

reportTest("G25: HTTP 200 for an omitted model skips that own-error control", {
  "G25 [chat/completions]": skip("missing model field subcase: no-policy control did not establish an ordinary error (HTTP 200)"),
}, async (t, expected) => {
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
  expectReport(report, expected);
});

for (const mode of ["relay", "uncertain origin"] as const) {
  const title = mode === "relay" ? "G25: an attributed 422 for the default model skips own-error precedence"
    : "G25: the omitted-model provider returns 422, but the accepted-policy control returns 409";
  reportTest(title, expectedByCase.defaultModel[mode]!, async (t, expected) => {
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
    const server = fixture(async ({ request, auth, body, header, next }) => {
      if (auth !== `Bearer ${key}` || request.method !== "POST") return next();
      if (Object.keys(body).length === 0 && await request.clone().text() === "{}") {
        const before = recipients.length;
        const reply = mode === "uncertain origin" && header === "zdr"
          ? Response.json({ error: { message: "temporarily not available" } }, { status: 409 })
          : await target(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ model }) }));
        controls.push({ policy: header, status: reply.status, provider: reply.headers.get(applied), recipients: recipients.slice(before) });
        return reply;
      }
      return next();
    }, target);
    const base = await baseAt(t, serve(server, 0));
    const report = await runConformance({ base, key, policyKey, endpoints: ["chat/completions"] });
    const plain = { policy: null, status: 422, provider: null, recipients: ["aurora.example"] };
    const witness = mode === "uncertain origin" ? { policy: "zdr", status: 409, provider: null, recipients: [] }
      : { policy: "zdr", status: 422, provider: "provider=aurora", recipients: ["aurora.example"] };
    assert.deepEqual(controls.slice(0, 2), [plain, witness]);
    assert.equal(controls.some(({ policy }) => policy === "bits=0"), false);
    if (mode === "relay") {
      const reply = await wireRequest(parseBase(base), {
        path: "chat/completions", credential: { key, header: "authorization" }, raw: "{}", policies: ["bits=0"],
      }, 3_000);
      assert.deepEqual([reply.status, reply.refused, controls.at(-1)],
        [400, ["reason=unsupported+key=bits"], { policy: "bits=0", status: 400, provider: null, recipients: [] }]);
    }
    expectReport(report, expected);
  });
}

reportTest("G29: sort=probe0 returning unavailable fails the precedence check", {
  "G1 [chat/completions]": failure(inference(model, [["Route-Policy","sort=probe0"]]), received(503, error("Route policy unsupported", "invalid_request_error", true), [], ["reason=unavailable"]), "HTTP 400 with only a valid unsupported refusal"),
  "G29 [chat/completions]": failure(inference(model, [["Route-Policy","sort=probe0"]]), received(503, error("Route policy unsupported", "invalid_request_error", true), [], ["reason=unavailable"]), "unsupported takes precedence over unavailable"),
  "G21 [chat/completions]": "FAIL",
}, async (t, expected) => {
  const report = await run(t, fixture(async ({ header, next }) => {
    const reply = await next();
    return header === "sort=probe0" ? change(reply, { status: 503, replace: { [refusal]: formatRefused("unavailable") } }) : reply;
  }));
  expectReport(report, expected);
});

reportTest("G2: unsupported for sort=probe0 fails when it omits key=sort", {
  "G2 [chat/completions]": failure(inference(model, [["Route-Policy","sort=probe0"]]), received(400, error("Route policy unsupported", "invalid_request_error", true), [], ["reason=unsupported"]), "the first failure names sort"),
  "G21 [chat/completions]": "FAIL",
}, async (t, expected) => {
  const report = await run(t, fixture(async ({ header, next }) => {
    const reply = await next();
    return header === "sort=probe0" ? change(reply, { replace: { [refusal]: formatRefused("unsupported") } }) : reply;
  }));
  expectReport(report, expected);
});

reportTest("G3: bits=64 returning unsatisfiable with provider=aurora fails", {
  "G3 [chat/completions]": failure(inference(model, [["Route-Policy","bits=64"]]), received(400, error("Route policy unsatisfiable", "invalid_request_error", true), ["provider=aurora"], ["reason=unsatisfiable"]), "HTTP 400 with only a valid unsatisfiable refusal"),
  "G1 [chat/completions]": "FAIL", "G9 [chat/completions]": "FAIL", "G11 [chat/completions]": "FAIL",
  "G21 [chat/completions]": "FAIL", "G29 [chat/completions]": "FAIL", "G19 [chat/completions]": "FAIL",
}, async (t, expected) => {
  const report = await run(t, fixture(async ({ header, next }) => {
    const reply = await next();
    return header === "bits=64" ? change(reply, { replace: { [applied]: formatApplied("aurora") } }) : reply;
  }));
  expectReport(report, expected);
});

reportTest("G6: a +zdr relay with no Route-Applied fails the qualification check", {
  "G6 [chat/completions]": failure(inference(model + "+zdr"), received(200, JSON.stringify({"text":"served by aurora.example"})), "the named published route must meet at least the known requirements; an unknown key default cannot admit an excluded route"),
  "G8 [chat/completions]": "FAIL", "G15 [chat/completions]": "FAIL",
}, async (t, expected) => {
  const report = await run(t, fixture(async ({ suffix, header, next }) => {
    const reply = await next();
    return suffix === "zdr" && header === null ? change(reply, { replace: { [applied]: null } }) : reply;
  }));
  expectReport(report, expected);
});

reportTest("G10: the -second model relaying cobalt on the zdr key fails even when the base model relays aurora", {
  "G10 [chat/completions]": failure(inference(model + "-second"), received(200, JSON.stringify({"provider":"cobalt.example"}), ["provider=cobalt"]), "the relayed route must meet the detected key default even in the presence of explicit carriers"),
  "G3 [chat/completions]": "FAIL", "G6 [chat/completions]": "FAIL",
}, async (t, expected) => {
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
  expectReport(report, expected);
});

reportTest("G11: zdr sent in the header and suffix fails the check if the gateway reports a duplicate", {
  "G11 [chat/completions]": failure(inference(model + "+zdr", [["Route-Policy","zdr"]]), received(400, error("Route policy unsupported", "invalid_request_error", true), [], ["reason=unsupported+key=zdr"]), "a valid policy repeated across carriers is not a duplicate within one carrier"),
  "G2 [chat/completions]": "FAIL", "G21 [chat/completions]": "FAIL",
}, async (t, expected) => {
  const report = await run(t, fixture(({ header, suffix, next, rewrite }) => header === "zdr" && suffix === header
    ? rewrite({ header: "zdr+zdr", suffix: null }) : next()));
  expectReport(report, expected);
});

reportTest("G12: header region=de and suffix region=us fail when the gateway relays their union", {
  "G12 [chat/completions]": failure(inference(model + "+region=us", [["Route-Policy","region=de"]]), received(200, JSON.stringify({"text":"served by aurora.example"}), ["provider=aurora"]), "400 unsatisfiable for an empty intersection in either carrier order"),
  "G3 [chat/completions]": "FAIL", "G6 [chat/completions]": "FAIL",
}, async (t, expected) => {
  const report = await run(t, fixture(({ header, suffix, next, rewrite }) => header === "region=de" && suffix === "region=us"
    ? rewrite({ header: "region=us,de", suffix: null }) : next()));
  expectReport(report, expected);
});

reportTest("G21: the bound key sending attest=weights,probe0 fails if the gateway accepts the pair", {
  "G21 [chat/completions]": failure(inference(model, [["Route-Policy","attest=weights,probe0"]]), received(400, error("Route policy unsatisfiable", "invalid_request_error", true), [], ["reason=unsatisfiable"]), "unlisted attest refuses attest=weights,probe0"),
  "G1 [chat/completions]": "FAIL", "G29 [chat/completions]": "FAIL",
}, async (t, expected) => {
  const report = await run(t, fixture(({ auth, header, next, rewrite }) => auth === `Bearer ${policyKey}` && header === "attest=weights,probe0"
    ? rewrite({ header: "attest=weights" }) : next()));
  expectReport(report, expected);
});

reportTest("G7: the order=basalt suffix fails if it makes header zdr unsatisfiable", {
  "G7 [chat/completions]": failure(inference(model + "+order=basalt", [["Route-Policy","zdr"]]), received(400, error("Route policy unsatisfiable", "invalid_request_error", true), [], ["reason=unsatisfiable"]), "an accepted preference cannot disqualify the matching published routes"),
  "G3 [chat/completions]": "FAIL",
}, async (t, expected) => {
  const report = await run(t, fixture(({ header, suffix, next, rewrite }) => header === "zdr" && suffix === "order=basalt"
    ? rewrite({ header: "only=routeprobe0", suffix: null }) : next()));
  expectReport(report, expected);
});

reportTest("G13: the -second model admitting second-basalt for the bound zdr key fails", {
  "G13 [chat/completions]": failure(inference(model + "-second", [["Route-Policy","only=second-basalt"]]), received(200, JSON.stringify({"output":"served"}), ["provider=second-basalt"]), "neither explicit carrier can weaken the detected key default"),
  "G3 [chat/completions]": "FAIL", "G6 [chat/completions]": "FAIL", "G10 [chat/completions]": "FAIL",
}, async (t, expected) => {
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
  expectReport(report, expected);
});

reportTest("G24: only=routeprobe0,aurora fails if the gateway answers unsatisfiable", {
  "G24 [chat/completions]": failure(inference(model, [["Route-Policy","only=routeprobe0,aurora"]]), received(400, error("Route policy unsatisfiable", "invalid_request_error", true), [], ["reason=unsatisfiable"]), "an unknown provider id does not remove the remaining matching routes"),
  "G3 [chat/completions]": "FAIL",
}, async (t, expected) => {
  const report = await run(t, fixture(({ header, next, rewrite }) => header === "only=routeprobe0,aurora"
    ? rewrite({ header: "only=routeprobe0" }) : next()));
  expectReport(report, expected);
});

reportTest("G23: the Bearer and x-api-key catalog probes keep the ordinary and bound model IDs separate", catalogs(4), async (t, expected) => {
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
  expectReport(report, expected);
}, INFERENCE_ENDPOINTS);

for (const status of [402, 403]) reportTest(`G23: HTTP ${status} on the policy-key catalog leaves that model scope unavailable`, {
  "G23": skip("an accessible /models response for each supplied credential"),
  "G10 [chat/completions]": skip("a published base model for the bound key"),
  "G13 [chat/completions]": skip("an accepted explicit policy whose routes are all excluded by the bound requirement"),
  "G21 [chat/completions]": "SKIP",
}, async (t, expected) => {
  let catalogDenied = 0;
  const report = await run(t, async (request, transport) => {
    if (new URL(request.url).pathname === "/v1/models" && request.headers.get("authorization") === `Bearer ${policyKey}`) {
      catalogDenied++;
      return Response.json({ error: { type: "access_denied", message: "catalog access requires an entitlement" } }, { status });
    }
    return good(request, transport);
  });
  assert.equal(catalogDenied, 1);
  expectReport(report, expected);
});

reportTest("G25: a headerless HTTP 200 for the unpublished probe model is not an ordinary-error control", {
  "G25 [chat/completions]": skip("unknown model subcase: no-policy control did not establish an ordinary error (HTTP 200)"),
}, async (t, expected) => {
  let undisclosedRequests = 0;
  const report = await run(t, fixture(async ({ id, next, request, transport, suffix, body }) => {
    if (!id.startsWith("route-conformance-unknown-")) return next();
    undisclosedRequests++;
    const resolved = suffix === null ? model : `${model}+${suffix}`;
    const reply = await good(new Request(request.url, { method: request.method, headers: request.headers, body: JSON.stringify({ ...body, model: resolved }) }), transport);
    assert.equal(reply.status, 200);
    for (const field of [applied, refusal, evidence]) assert.equal(reply.headers.get(field), null);
    return reply;
  }));
  assert.equal(undisclosedRequests, 1);
  expectReport(report, expected);
});

reportTest("G25: a headerless 422 for the unpublished model is excluded when zdr returns Route-Applied", {
  "G25 [chat/completions]": skip("unknown model subcase: accepted-policy control reached routing (HTTP 422)"),
}, async (t, expected) => {
  const controls: (string | null)[] = [];
  const report = await run(t, fixture(async ({ id, next, request, transport, header, body }) => {
    if (!id.startsWith("route-conformance-unknown-")) return next();
    controls.push(header);
    const reply = await good(new Request(request.url, { method: request.method, headers: request.headers, body: JSON.stringify({ ...body, model }) }), transport);
    assert.equal(reply.headers.get(applied), header === "zdr" ? "provider=aurora" : null);
    assert.equal(reply.headers.get(refusal), null);
    assert.equal(reply.headers.get(evidence), null);
    return change(reply, { status: 422, body: "provider could not process the input" });
  }));
  assert.deepEqual(controls, [null, "zdr"]);
  expectReport(report, expected);
});

for (const status of [400, 422] as const) reportTest(`G25: the synthetic key discovers region=de and attributes the provider’s HTTP ${status}`, expectedByCase.syntheticError[status], async (t, expected) => {
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
  expectReport(report, expected);
});

for (const sample of [
  { label: "unknown model", status: 422 },
  { label: "unrecognized credential", status: 418 },
] as const) {
  for (const defect of [false, true]) reportTest(`G25: ${sample.label} HTTP ${sample.status} ${defect ? "fails when bits=0 turns it into unsupported" : "passes when bits=0 preserves the bare error"}`, expectedByCase.stableError[`${sample.label}:${defect ? "refused" : "bare"}`]!, async (t, expected) => {
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
    expectReport(report, expected);
  });
}

reportTest("G25: a 422 control retried as 409 leaves the status-precedence check inconclusive", {
  "G25 [chat/completions]": skip("a stable ordinary error; the two no-policy controls returned HTTP 422 and HTTP 409"),
}, async (t, expected) => {
  let plain = 0;
  const report = await run(t, fixture(({ id, header, next }) => {
    if (!id.startsWith("route-conformance-unknown-")) return next();
    const status = header === "zdr" || (header === null && plain++ === 0) ? 422 : 409;
    return Response.json({ error: { type: "invalid_request_error", message: "could not resolve model" } }, { status });
  }));
  assert.equal(plain, 2);
  expectReport(report, expected);
});

reportTest("G25: bits=0 returning 409 fails against the stable unpublished-model HTTP 422", {
  "G25 [chat/completions]": failure(inference("route-conformance-unknown-0+bits=0", [["Route-Policy","bits=0"]]), received(409, error("could not resolve model", "invalid_request_error", true)), "the same ordinary error status 422 as the no-policy control, with no result headers"),
}, async (t, expected) => {
  const report = await run(t, fixture(({ id, header, next }) => id.startsWith("route-conformance-unknown-")
    ? Response.json({ error: { type: "invalid_request_error", message: "could not resolve model" } }, { status: header === "bits=0" ? 409 : 422 })
    : next()));
  expectReport(report, expected);
});

reportTest("G6: a relay attributed to aurora fails the only=basalt probe", {
  "G6 [chat/completions]": failure(inference(model, [["Route-Policy","only=basalt"]]), received(200, JSON.stringify({"text":"served by aurora.example"}), ["provider=aurora"]), "the named published route must meet at least the known requirements; an unknown key default cannot admit an excluded route"),
  "G3 [chat/completions]": "FAIL", "G12 [chat/completions]": "FAIL", "G13 [chat/completions]": "FAIL",
}, async (t, expected) => {
  const report = await run(t, fixture(({ header, next, rewrite }) => header === "only=basalt" ? rewrite({ header: "only=aurora" }) : next()));
  expectReport(report, expected);
});

reportTest("G9: ignoring the mixed-case bits=64 header fails despite a valid rejection of duplicate lines", {
  "G9 [chat/completions]": failure(inference(model, [["rOuTe-PoLiCy","bits=64"]]), received(200, JSON.stringify({"text":"served by aurora.example"})), "no published route meets even the known mixed-case header requirements"),
  "G3 [chat/completions]": "FAIL", "G6 [chat/completions]": "FAIL", "G15 [chat/completions]": "FAIL",
  "G21 [chat/completions]": "FAIL",
}, async (t, expected) => {
  let duplicates = 0;
  const report = await run(t, fixture(async ({ id, header, suffix, transport, next, rewrite }) => {
    if (header === "bits=64" && suffix === null) return rewrite({ header: null });
    const reply = await next();
    if (id === model && transport?.repeatedRoutePolicy) {
      assert.equal(reply.headers.get(refusal), "reason=unsupported");
      duplicates++;
    }
    return reply;
  }));
  assert.equal(duplicates, 1);
  expectReport(report, expected);
});

reportTest("G17: the bound attest=weights request without a header or suffix fails if Basalt omits Route-Evidence", {
  "G17 [chat/completions]": failure(inference(model), received(200, JSON.stringify({"output":"served"}), ["provider=basalt"]), "one Route-Evidence is required by the known attest requirement"),
}, async (t, expected) => {
  const target = createGateway({
    models: { [model]: routes }, keys: { [key]: {}, [policyKey]: { policy: "attest=weights" } },
    fetch: () => Response.json({ output: "served" }),
  });
  const report = await run(t, fixture(async ({ request, auth, header, suffix, id, next }) => {
    const reply = await next();
    if (request.method !== "POST" || auth !== `Bearer ${policyKey}` || header !== null || suffix !== null || id !== model) return reply;
    assert.equal(reply.headers.get(evidence), "https://basalt.example/attestation");
    return change(reply, { replace: { [evidence]: null } });
  }, target));
  expectReport(report, expected);
});

reportTest("G21: unsupported for advertised bits=32 fails even alongside provider=aurora", {
  "G21 [chat/completions]": failure(inference(model, [["Route-Policy","bits=32"]]), received(400, error("Route policy unsatisfiable", "invalid_request_error", true), ["provider=aurora"], ["reason=unsupported+key=bits"]), "advertised support accepts every key and value sent; unsupported is not justified"),
  "G2 [chat/completions]": "FAIL", "G3 [chat/completions]": "FAIL", "G19 [chat/completions]": "FAIL",
}, async (t, expected) => {
  const report = await run(t, fixture(async ({ header, next }) => {
    const reply = await next();
    return header === "bits=32" ? change(reply, { replace: { [applied]: formatApplied("aurora"), [refusal]: formatRefused("unsupported", "bits") } }) : reply;
  }));
  expectReport(report, expected);
});

reportTest("G25: headerless HTTP 429 on every POST leaves own-error precedence inconclusive", {
  "G1 [chat/completions]": skip("probe and no-policy control both returned headerless HTTP 429; cannot distinguish an own error from a relay"),
  "G6 [chat/completions]": skip("probe and no-policy control both returned headerless HTTP 429; cannot distinguish an own error from a relay"),
  "G10 [chat/completions]": skip("probe and control without explicit policy (same bound key) both returned headerless HTTP 429; cannot distinguish an own error from a relay"),
  "G13 [chat/completions]": skip("probe and control without explicit policy (same bound key) both returned headerless HTTP 429; cannot distinguish an own error from a relay"),
  "G25 [chat/completions]": skip("bad-credentials subcase: headerless HTTP 429 did not distinguish credential rejection from a provider relay"),
  "G1 [responses]": skip("probe and no-policy control both returned headerless HTTP 429; cannot distinguish an own error from a relay"),
  "G6 [responses]": skip("probe and no-policy control both returned headerless HTTP 429; cannot distinguish an own error from a relay"),
  "G10 [responses]": skip("probe and control without explicit policy (same bound key) both returned headerless HTTP 429; cannot distinguish an own error from a relay"),
  "G13 [responses]": skip("probe and control without explicit policy (same bound key) both returned headerless HTTP 429; cannot distinguish an own error from a relay"),
  "G25 [responses]": skip("bad-credentials subcase: headerless HTTP 429 did not distinguish credential rejection from a provider relay"),
  "G1 [messages]": skip("probe and no-policy control both returned headerless HTTP 429; cannot distinguish an own error from a relay"),
  "G6 [messages]": skip("probe and no-policy control both returned headerless HTTP 429; cannot distinguish an own error from a relay"),
  "G10 [messages]": skip("probe and control without explicit policy (same bound key) both returned headerless HTTP 429; cannot distinguish an own error from a relay"),
  "G13 [messages]": skip("probe and control without explicit policy (same bound key) both returned headerless HTTP 429; cannot distinguish an own error from a relay"),
  "G25 [messages]": skip("bad-credentials subcase: headerless HTTP 429 did not distinguish credential rejection from a provider relay"),
  "G2 [chat/completions]": "SKIP", "G3 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP",
  "G8 [chat/completions]": "SKIP", "G9 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP",
  "G12 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP", "G17 [chat/completions]": "SKIP",
  "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP",
  "G29 [chat/completions]": "SKIP", "G19 [chat/completions]": "SKIP", "G2 [responses]": "SKIP",
  "G3 [responses]": "SKIP", "G7 [responses]": "SKIP", "G8 [responses]": "SKIP", "G9 [responses]": "SKIP",
  "G11 [responses]": "SKIP", "G12 [responses]": "SKIP", "G15 [responses]": "SKIP", "G17 [responses]": "SKIP",
  "G21 [responses]": "SKIP", "G24 [responses]": "SKIP", "G26 [responses]": "SKIP", "G29 [responses]": "SKIP",
  "G19 [responses]": "SKIP", "G2 [messages]": "SKIP", "G3 [messages]": "SKIP", "G7 [messages]": "SKIP",
  "G8 [messages]": "SKIP", "G9 [messages]": "SKIP", "G11 [messages]": "SKIP", "G12 [messages]": "SKIP",
  "G15 [messages]": "SKIP", "G17 [messages]": "SKIP", "G21 [messages]": "SKIP", "G24 [messages]": "SKIP",
  "G26 [messages]": "SKIP", "G29 [messages]": "SKIP", "G19 [messages]": "SKIP",
}, async (t, expected) => {
  const usableInputs: { header: string | null; id: string; suffix: string | null; body: Record<string, unknown>; auth: string | null }[] = [];
  const report = await run(t, fixture(({ request, header, id, suffix, body, auth, next }) => {
    if (request.method !== "POST") return next();
    if (id === model) usableInputs.push({ header, id, suffix, body, auth });
    return Response.json({ error: { type: "rate_limit", message: "try later" } }, { status: 429 });
  }), INFERENCE_ENDPOINTS);
  const i = usableInputs.findIndex(({ suffix }) => suffix !== null);
  assert.ok(i >= 0, "a suffix probe was sent");
  const probe = usableInputs[i]!;
  const control = usableInputs[i + 1]!;
  assert.deepEqual(control, { ...probe, header: null, suffix: null, body: { ...probe.body, model: probe.id } });
  expectReport(report, expected);
}, INFERENCE_ENDPOINTS);

reportTest("G25: headerless HTTP 429 confined to synthetic-credential POSTs passes own-error precedence", {
  "G25 [chat/completions]": ["PASS","corroborated ordinary errors retained their status and no route headers when challenged with a policy; observed 9 × HTTP 400, 6 × HTTP 404, 4 × HTTP 429, 2 × HTTP 200, 1 × HTTP 200 provider=aurora"],
  "G25 [responses]": ["PASS","corroborated ordinary errors retained their status and no route headers when challenged with a policy; observed 9 × HTTP 400, 6 × HTTP 404, 4 × HTTP 429, 2 × HTTP 200, 1 × HTTP 200 provider=aurora"],
  "G25 [messages]": ["PASS","corroborated ordinary errors retained their status and no route headers when challenged with a policy; observed 9 × HTTP 400, 6 × HTTP 404, 4 × HTTP 429, 2 × HTTP 200, 1 × HTTP 200 provider=aurora"],
}, async (t, expected) => {
  const synthetic = new Map<string, string[]>();
  const report = await run(t, fixture(async ({ auth, request, path, id, header, next }) => {
    if (request.method !== "POST" || !auth?.replace(/^Bearer /, "").startsWith("route-conformance-invalid-")) return next();
    const raw = await request.text();
    const probes = synthetic.get(path) ?? [];
    probes.push(raw === "{" && header === null ? "malformed JSON" : `${id}:${header ?? ""}`);
    synthetic.set(path, probes);
    return Response.json({ error: { type: "rate_limit", message: "try later" } }, { status: 429 });
  }), INFERENCE_ENDPOINTS);
  for (const endpoint of INFERENCE_ENDPOINTS) {
    assert.deepEqual(synthetic.get(`/v1/${endpoint}`), [`${model}:`, `${model}:zdr`, "malformed JSON", `${model}:bits=0`]);
  }
  expectReport(report, expected);
}, INFERENCE_ENDPOINTS);

reportTest("G19: HTTP 429 carrying unsupported+key=bits fails the refusal status check", {
  "G19 [chat/completions]": failure(inference(model, [["Route-Policy","bits=0+only=a,a"]]), received(429, error("try later", "rate_limit", true), [], ["reason=unsupported+key=bits"]), "S15: one valid Route-Refused value with its corresponding HTTP status"),
  "G1 [chat/completions]": "FAIL", "G2 [chat/completions]": "FAIL", "G3 [chat/completions]": "SKIP",
  "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G8 [chat/completions]": "SKIP",
  "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP",
  "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP",
  "G17 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
  "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
}, async (t, expected) => {
  const report = await run(t, fixture(({ request, header, next }) => {
    if (request.method !== "POST") return next();
    return Response.json({ error: { type: "rate_limit", message: "try later" } }, { status: 429,
      ...(header === "bits=0+only=a,a" ? { headers: { [refusal]: formatRefused("unsupported", "bits") } } : {}),
    });
  }));
  expectReport(report, expected);
});

reportTest("G15: an unavailable-only fixture leaves relay attribution unverified", {
  "G15 [chat/completions]": skip("a policy relay with a published model catalog to verify its provider"),
  "G17 [chat/completions]": skip("a relay with a known attest requirement and published evidence"),
  "G6 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP",
}, async (t, expected) => {
  const report = await run(t, unavailableGateway);
  expectReport(report, expected);
});

for (const { condition, config, skipped } of [
  { condition: "detection lists zdr, attest=prompt and sort=latency", config: { accept: { keys: ["zdr", "attest", "sort"], attest: ["prompt"], sort: ["latency"] } }, skipped: ["G12", "G24"] },
  { condition: "detection lists an empty keys array", config: { accept: { keys: [], attest: [], sort: [] }, keys: { [key]: {}, [policyKey]: {} } }, skipped: ["G3", "G6", "G10", "G17"] },
  { condition: "the catalog contains a single Aurora route", config: { models: { [model]: [routes[0]!] } }, skipped: ["G13", "G17"] },
  { condition: "the catalog contains Aurora and Cobalt without attest", config: { models: { [model]: [routes[0]!, routes[2]!] } }, skipped: ["G17"] },
  { condition: "both credentials are unbound", config: { keys: { [key]: {}, [policyKey]: {} } }, skipped: ["G10", "G13"] },
  { condition: "/models returns an empty data array", config: { models: {} }, skipped: ["G1", "G15", "G17"] },
] as const) {
  reportTest(`${skipped[0]}: ${condition}`, expectedByCase.capabilities[condition]!, async (t, expected) => {
    const target = createGateway({
      models: { [model]: routes }, keys: { [key]: {}, [policyKey]: { policy: "zdr" } },
      fetch: () => Response.json({ output: "served" }), ...config,
    });
    const report = await run(t, target);
    expectReport(report, expected);
  });
}

reportTest("G8: a 404 on responses skips suffix checking while chat/completions passes", {
  "G8 [chat/completions]": ["PASS","suffixed probes resolved the published base and returned outcomes consistent with the suffix; observed 1 × HTTP 400 reason=unsupported, 1 × HTTP 400 reason=unsatisfiable, 1 × HTTP 200 provider=aurora"],
  "G15 [chat/completions]": ["PASS","policy relays with a checked catalog named published providers; observed 56 × HTTP 200 provider=aurora, 5 × HTTP 200 provider=basalt; https://basalt.example/attestation, 8 × HTTP 200 provider=basalt, 4 × HTTP 200 provider=cobalt"],
  "G19 [chat/completions]": ["PASS","observed refusals and policy relays used exclusive single result headers; observed 7 × HTTP 400 reason=unsupported, 6 × HTTP 400 reason=unsupported+key=bits, 1 × HTTP 400 reason=unsupported+key=region, 3 × HTTP 400 reason=unsupported+key=only, 1 × HTTP 400 reason=unsupported+key=zdr, 39 × HTTP 400 reason=unsatisfiable, 56 × HTTP 200 provider=aurora, 5 × HTTP 200 provider=basalt; https://basalt.example/attestation, 8 × HTTP 200 provider=basalt, 4 × HTTP 200 provider=cobalt, 2 × HTTP 400 reason=unsupported+key=probe0, 4 × HTTP 400 reason=unsupported+key=attest, 2 × HTTP 400 reason=unsupported+key=sort"],
  "G8 [responses]": skip("probe and no-policy control both returned headerless HTTP 404; cannot distinguish an own error from a relay"),
  "G15 [responses]": skip("probe and no-policy control both returned headerless HTTP 404; cannot distinguish an own error from a relay"),
  "G19 [responses]": skip("an observed policy refusal or relay"),
  "G1 [responses]": "SKIP", "G2 [responses]": "SKIP", "G3 [responses]": "SKIP", "G6 [responses]": "SKIP",
  "G7 [responses]": "SKIP", "G9 [responses]": "SKIP", "G10 [responses]": "SKIP", "G11 [responses]": "SKIP",
  "G12 [responses]": "SKIP", "G13 [responses]": "SKIP", "G17 [responses]": "SKIP", "G21 [responses]": "SKIP",
  "G24 [responses]": "SKIP", "G25 [responses]": "SKIP", "G26 [responses]": "SKIP", "G29 [responses]": "SKIP",
}, async (t, expected) => {
  const report = await run(t, async (request, transport) => new URL(request.url).pathname === "/v1/responses"
    ? Response.json({ error: { type: "not_found_error", message: "not supported on this endpoint" } }, { status: 404 })
    : good(request, transport), ["chat/completions", "responses"]);
  expectReport(report, expected);
}, ["chat/completions","responses"]);

reportTest("G15: a transient headerless 429 on the streaming probe is inconclusive", {
  "G15 [chat/completions]": skip("gateway answered a transient headerless HTTP 429; the no-policy control did not establish that routing was reached"),
}, async (t, expected) => {
  let ordinaryOwnErrors = 0;
  const report = await run(t, fixture(({ body, header, next }) => {
    if (body.stream === true && header !== null && ordinaryOwnErrors++ === 0) {
      return Response.json({ error: { type: "rate_limit", message: "try again" } }, { status: 429 });
    }
    return next();
  }));
  assert.equal(ordinaryOwnErrors, 1);
  expectReport(report, expected);
});

reportTest("G15: a non-SSE 200 whose body aborts still exposes provider=aurora", {
  "G15 [chat/completions]": ["PASS","policy relays with a checked catalog named published providers; observed 56 × HTTP 200 provider=aurora, 5 × HTTP 200 provider=basalt; https://basalt.example/attestation, 8 × HTTP 200 provider=basalt, 4 × HTTP 200 provider=cobalt"],
}, async (t, expected) => {
  let interrupted = 0;
  const handler = fixture(({ body, next }) => {
    if (body.stream !== true) return next();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        interrupted++;
        controller.error(new Error("connection fell away after headers"));
      },
    }, { highWaterMark: 0 }); // The adapter commits headers before pulling the body.
    return new Response(stream, { status: 200, headers: { [applied]: formatApplied("aurora"), "content-type": "application/octet-stream" } });
  });
  const base = await baseAt(t, serve(handler, 0));
  const report = await runConformance({ base, key, policyKey, endpoints: ["chat/completions"] });
  assert.equal(interrupted, 1);
  const reply = await wireRequest(parseBase(base), {
    path: "chat/completions", credential: { header: "authorization", key }, raw: JSON.stringify({ model, stream: true }),
  }, 3_000);
  assert.equal(interrupted, 2);
  assert.equal(reply.status, 200);
  assert.equal(reply.contentType, "application/octet-stream");
  assert.deepEqual(reply.applied, ["provider=aurora"]);
  assert.equal(reply.hasBody, false);
  expectReport(report, expected);
});

reportTest("G15: a +zdr relay with comma-joined provider attribution fails the result audit", {
  "G15 [chat/completions]": failure(inference(model + "+zdr"), received(200, JSON.stringify({"text":"served by aurora.example"}), ["provider=aurora, provider=basalt"], [], ["https://_invalid.example/"]), "S14: a Route-Applied value is exactly provider=<provider id>"),
  "G17 [chat/completions]": failure(inference(model + "+zdr"), received(200, JSON.stringify({"text":"served by aurora.example"}), ["provider=aurora, provider=basalt"], [], ["https://_invalid.example/"]), "S18: every Route-Evidence value is an evidence URI"),
  "G19 [chat/completions]": failure(inference(model, [["Route-Policy","sort=throughput"]]), received(200, JSON.stringify({"text":"served by cobalt.example"}), ["provider=cobalt"], ["reason=unavailable+key=zdr"]), "S15: one valid Route-Refused value with its corresponding HTTP status"),
  "G6 [chat/completions]": "FAIL", "G8 [chat/completions]": "FAIL", "G21 [chat/completions]": "FAIL",
}, async (t, expected) => {
  const report = await run(t, fixture(async ({ header, suffix, next }) => {
    const reply = await next();
    if (suffix === "zdr" && header === null) return change(reply, { replace: {
      [applied]: "provider=aurora, provider=basalt", [evidence]: "https://_invalid.example/",
    } });
    if (header === "sort=throughput" && suffix === null) return change(reply, { replace: { [refusal]: "reason=unavailable+key=zdr" } });
    return reply;
  }));
  expectReport(report, expected);
});

reportTest("G19: a headerless bits=64 rejection fails when its no-policy control reaches routing", {
  "G19 [chat/completions]": failure(inference(model, [["Route-Policy","bits=64"]]), received(400, error("Route policy unsatisfiable", "invalid_request_error", true)), "a policy refusal has a Route-Refused header; the no-policy control reached routing"),
  "G1 [chat/completions]": "FAIL", "G3 [chat/completions]": "FAIL", "G9 [chat/completions]": "FAIL",
  "G11 [chat/completions]": "FAIL", "G21 [chat/completions]": "FAIL", "G29 [chat/completions]": "FAIL",
}, async (t, expected) => {
  const report = await run(t, fixture(async ({ header, next }) => {
    const reply = await next();
    return header === "bits=64" && reply.headers.has(refusal) ? change(reply, { replace: { [refusal]: null } }) : reply;
  }));
  expectReport(report, expected);
});

reportTest(`G19: the demo has a PASS result-header check on ${INFERENCE_ENDPOINTS.join(", ")}`, {
  "G19 [chat/completions]": ["PASS","observed refusals and policy relays used exclusive single result headers; observed 7 × HTTP 400 reason=unsupported, 6 × HTTP 400 reason=unsupported+key=bits, 1 × HTTP 400 reason=unsupported+key=region, 3 × HTTP 400 reason=unsupported+key=only, 1 × HTTP 400 reason=unsupported+key=zdr, 39 × HTTP 400 reason=unsatisfiable, 55 × HTTP 200 provider=aurora, 5 × HTTP 200 provider=basalt; https://basalt.example/attestation, 9 × HTTP 200 provider=basalt, 4 × HTTP 200 provider=cobalt, 2 × HTTP 400 reason=unsupported+key=probe0, 4 × HTTP 400 reason=unsupported+key=attest, 2 × HTTP 400 reason=unsupported+key=sort"],
  "G19 [responses]": ["PASS","observed refusals and policy relays used exclusive single result headers; observed 7 × HTTP 400 reason=unsupported, 6 × HTTP 400 reason=unsupported+key=bits, 1 × HTTP 400 reason=unsupported+key=region, 3 × HTTP 400 reason=unsupported+key=only, 1 × HTTP 400 reason=unsupported+key=zdr, 39 × HTTP 400 reason=unsatisfiable, 55 × HTTP 200 provider=aurora, 5 × HTTP 200 provider=basalt; https://basalt.example/attestation, 9 × HTTP 200 provider=basalt, 4 × HTTP 200 provider=cobalt, 2 × HTTP 400 reason=unsupported+key=probe0, 4 × HTTP 400 reason=unsupported+key=attest, 2 × HTTP 400 reason=unsupported+key=sort"],
  "G19 [messages]": ["PASS","observed refusals and policy relays used exclusive single result headers; observed 7 × HTTP 400 reason=unsupported, 6 × HTTP 400 reason=unsupported+key=bits, 1 × HTTP 400 reason=unsupported+key=region, 3 × HTTP 400 reason=unsupported+key=only, 1 × HTTP 400 reason=unsupported+key=zdr, 39 × HTTP 400 reason=unsatisfiable, 55 × HTTP 200 provider=aurora, 5 × HTTP 200 provider=basalt; https://basalt.example/attestation, 9 × HTTP 200 provider=basalt, 4 × HTTP 200 provider=cobalt, 2 × HTTP 400 reason=unsupported+key=probe0, 4 × HTTP 400 reason=unsupported+key=attest, 2 × HTTP 400 reason=unsupported+key=sort"],
}, async (t, expected) => {
  const { server, base } = await startDemo(0);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const report = await runConformance({ base: `${base}/v1`, key: "demo-key", policyKey: "demo-key-zdr", endpoints: INFERENCE_ENDPOINTS });
  expectReport(report, expected);
}, INFERENCE_ENDPOINTS);

reportTest("G7: order=0,a-b_c.d fails when the gateway reports unsatisfiable despite a qualifying route", {
  "G3 [chat/completions]": failure(inference(model, [["Route-Policy","order=0,a-b_c.d"]]), received(400, error("no routes", "invalid_request_error"), [], ["reason=unsatisfiable"]), "unsatisfiable requires that no published route meet the combined policy"),
  "G7 [chat/completions]": failure(inference(model, [["Route-Policy","order=0,a-b_c.d"]]), received(400, error("no routes", "invalid_request_error"), [], ["reason=unsatisfiable"]), "an accepted preference cannot disqualify the matching published routes"),
  "G24 [chat/completions]": failure(inference(model, [["Route-Policy","order=0,a-b_c.d"]]), received(400, error("no routes", "invalid_request_error"), [], ["reason=unsatisfiable"]), "an unknown provider id does not remove the remaining matching routes"),
}, async (t, expected) => {
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
  expectReport(report, expected);
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
  { id: "G1", clause: "bits=0 with HTTP 422 unsupported fails", mutate: responseFor("bits=0", { status: 422 }) },
  { id: "G1", clause: "bits=0 with HTTP 400 unsatisfiable fails", mutate: responseFor("bits=0", { replace: { [refusal]: formatRefused("unsatisfiable") } }) },
  { id: "G2", clause: "bits=0+only=a,a fails if unsupported omits the key", mutate: responseFor("bits=0+only=a,a", { replace: { [refusal]: formatRefused("unsupported") } }) },
  { id: "G2", clause: "Bad+bits=0 fails if unsupported names bits", mutate: responseFor("Bad+bits=0", { replace: { [refusal]: formatRefused("unsupported", "bits") } }) },
  { id: "G3", clause: "bits=64 with HTTP 422 unsatisfiable fails", mutate: responseFor("bits=64", { status: 422 }) },
  { id: "G3", clause: "bits=64 with an unsatisfiable key=bits fails", mutate: responseFor("bits=64", { replace: { [refusal]: "reason=unsatisfiable+key=bits" } }) },
  { id: "G3", clause: "bits=64 fails if the gateway relays the bits=1 response", mutate: ({ header, suffix, rewrite, next }) => header === "bits=64" && suffix === null ? rewrite({ header: "bits=1" }) : next() },
  ...([
    ["zdr", "cobalt", "missing retention fact"], ["notrain", "cobalt", "missing training fact"],
    ["bits=9", "aurora", "bit precision below the floor"], ["region=us", "basalt", "route countries exceed allowed region"],
    ["attest=weights", "aurora", "missing attestation item"], ["only=basalt", "aurora", "provider absent from only"],
    ["ignore=aurora", "aurora", "provider named in ignore"],
  ] as const).map(([policy, provider, clause]): Clause =>
    ({ id: "G6", clause, mutate: responseFor(policy, { replace: { [applied]: formatApplied(provider) } }) })),
  { id: "G7", clause: "zdr+order=basalt fails if Basalt is named", mutate: responseFor("zdr+order=basalt", { replace: { [applied]: formatApplied("basalt") } }) },
  { id: "G7", clause: "sort=throughput with unsatisfiable fails", mutate: responseFor("sort=throughput", { status: 400, body: JSON.stringify(refusalEnvelope),
    replace: { [applied]: null, [refusal]: formatRefused("unsatisfiable") } }) },
  { id: "G8", clause: "a 404 from the +zdr alias fails when its base model resolves", mutate: ({ suffix, header, next }) => header === null && suffix === "zdr"
    ? Response.json(refusalEnvelope, { status: 404 }) : next() },
  { id: "G9", clause: "two Route-Policy lines fail if the gateway produces the zdr relay", mutate: ({ transport, rewrite, next }) => transport?.repeatedRoutePolicy ? rewrite({ header: "zdr" }) : next() },
  { id: "G9", clause: "two Route-Policy lines with unsupported+key=only fail", mutate: async ({ transport, next }) => {
    const reply = await next();
    return transport?.repeatedRoutePolicy ? change(reply, { replace: { [refusal]: formatRefused("unsupported", "only") } }) : reply;
  } },
  { id: "G10", clause: "the zdr-bound key fails if header only=basalt relays Basalt", mutate: ({ auth, header, rewrite, next }) =>
    auth === `Bearer ${policyKey}` && header === "only=basalt" ? rewrite({ neutralKey: true }) : next() },
  { id: "G11", clause: "header zdr fails if suffix bits=0 is bypassed", mutate: ({ header, suffix, rewrite, next }) =>
    header === "zdr" && suffix === "bits=0" ? rewrite({ suffix: null }) : next() },
  ...([
    ["zdr", "notrain", "routing to the zdr-only route fails when the suffix also requires notrain", combinationTarget],
    ["bits=1", "bits=9", "routing to the 8-bit route fails when the suffix requires bits=9", good],
    ["region=us,de", "region=de,jp", "the us,de-only route fails when the suffix also requires region=de,jp", combinationTarget],
    ["only=aurora,basalt", "only=basalt,cobalt", "Aurora fails when only=aurora,basalt intersects only=basalt,cobalt", good],
    ["attest=weights", "attest=prompt", "the weights-only route fails when the suffix also requires prompt", combinationTarget],
    ["ignore=aurora", "ignore=basalt", "Basalt fails when the suffix adds ignore=basalt to ignore=aurora", good],
  ] as const).map(([head, tail, clause, target]): Clause => ({
    id: "G11", clause, target, mutate: ({ header, suffix, rewrite, next }) => {
      if (header !== head || suffix !== tail) return next();
      const bad = head.startsWith("region=") ? "only=aurora+region=us,de" :
        head.startsWith("attest=") ? "only=aurora+attest=weights" :
        head.startsWith("only=") ? "only=aurora" : head;
      return rewrite({ header: bad, suffix: null });
    },
  })),
  { id: "G12", clause: "header only=aurora and suffix only=basalt fail if the gateway relays", mutate: ({ header, suffix, rewrite, next }) =>
    header === "only=aurora" && suffix === "only=basalt" ? rewrite({ suffix: null }) : next() },
  { id: "G13", clause: "header only=basalt fails when it overrides the bound zdr", mutate: ({ auth, header, suffix, rewrite, next }) =>
    auth === `Bearer ${policyKey}` && header === "only=basalt" && suffix === null ? rewrite({ neutralKey: true }) : next() },
  { id: "G13", clause: "suffix only=basalt fails when it overrides the bound zdr", mutate: ({ auth, header, suffix, rewrite, next }) =>
    auth === `Bearer ${policyKey}` && header === null && suffix === "only=basalt" ? rewrite({ neutralKey: true }) : next() },
  { id: "G13", clause: "header bits=8 fails if it drops the bound bits=16 floor", target: bitsKeyTarget,
    mutate: ({ auth, header, rewrite, next }) => auth === `Bearer ${policyKey}` && header === "bits=8" ? rewrite({ neutralKey: true }) : next() },
  { id: "G15", clause: "the zdr relay fails when Route-Applied names unpublished", mutate: responseFor("zdr", { replace: { [applied]: formatApplied("unpublished") } }) },
  { id: "G17", clause: "attest=weights fails when the applied provider supplies no evidence", mutate: responseFor("attest=weights", { replace: { [evidence]: null } }) },
  { id: "G17", clause: "only=basalt fails when it returns Basalt’s attestation URI without attest", mutate: responseFor("only=basalt", { replace: { [evidence]: "https://basalt.example/attestation" } }) },
  { id: "G19", clause: "bits=64 unsatisfiable with provider=aurora fails the result check", mutate: responseFor("bits=64", { replace: { [applied]: formatApplied("aurora") } }) },
  { id: "G19", clause: "bits=64 unsatisfiable with a Route-Evidence URI fails the result check", mutate: responseFor("bits=64", { replace: { [evidence]: "https://aurora.example/evidence" } }) },
  { id: "G20", clause: "anonymous detection HTTP 401 fails", mutate: detectionResponse({ route_policy: "1" }, { status: 401 }) },
  { id: "G20", clause: "credentialed detection HTTP 201 fails", mutate: detectionResponse({ route_policy: "1" }, { status: 201, credentialed: true }) },
  { id: "G20", clause: "an array as the detection body fails", mutate: detectionResponse([]) },
  { id: "G20", clause: "detection keys containing Not-A-Key fails", mutate: detectionResponse({ route_policy: "1", keys: ["Not-A-Key"] }) },
  { id: "G20", clause: "detection attest containing a,b as one item fails", mutate: detectionResponse({ route_policy: "1", attest: ["a,b"] }) },
  { id: "G20", clause: "detection sort set to the string price fails", mutate: detectionResponse({ route_policy: "1", sort: "price" }) },
  { id: "G21", clause: "a relay instead of unsupported for probe0 fails", mutate: ({ header, rewrite, next }) =>
    header === "probe0" ? rewrite({ header: "zdr" }) : next() },
  { id: "G21", clause: "accepting attest=probe0 as attest=weights fails", mutate: ({ header, rewrite, next }) =>
    header === "attest=probe0" ? rewrite({ header: "attest=weights" }) : next() },
  ...(["bits=32", "region=jp,de", "only=0,a-b_c.d", "ignore=0,a-b_c.d", "order=0,a-b_c.d"] as const)
    .map((policy): Clause => ({
      id: "G21", clause: `unsupported for advertised ${policy} fails`,       mutate: ({ header, suffix, next }) => header === policy && suffix === null
        ? protocolError("unsupported", policy.split("=")[0]) : next(),
    })),
  { id: "G22", clause: "the numeric key_policy 1 fails", mutate: detectionResponse({ route_policy: "1", key_policy: 1 }, { credentialed: true }) },
  { id: "G22", clause: "key_policy=zdr+zdr fails", mutate: detectionResponse({ route_policy: "1", key_policy: "zdr+zdr" }, { credentialed: true }) },
  { id: "G22", clause: "key_policy=notrain fails with only zdr advertised", mutate: detectionResponse({ route_policy: "1", keys: ["zdr"], key_policy: "notrain" }, { credentialed: true }) },
  ...([
    ["a /models top-level array fails", []],
    ["a /models data object fails", { data: { id: model, routes: published } }],
    ["a null catalog entry fails", { data: [null] }],
    ["duplicate other/example-model.v2 entries fail", { data: [{ id: model, routes: [] }, { id: model, routes: [] }] }],
    ["other/example-model.v2 without routes fails", { data: [{ id: model }] }],
    ["provider Aurora with uppercase A fails the catalog check", { data: [{ id: model, routes: [{ provider: "Aurora", facts: "" }] }] }],
    ["Aurora without facts fails the catalog check", { data: [{ id: model, routes: [{ provider: "aurora" }] }] }],
    ["Aurora facts zdr+zdr fail the catalog check", { data: [{ id: model, routes: [{ provider: "aurora", facts: "zdr+zdr" }] }] }],
    ["Basalt facts attest=weights without evidence fail the catalog check", { data: [{ id: model, routes: [{ provider: "basalt", facts: "attest=weights" }] }] }],
    ["Basalt evidence beginning with http:// fails the catalog check", { data: [{ id: model, routes: [{ provider: "basalt", facts: "attest=weights", evidence: "http://basalt.example/" }] }] }],
  ] as const).map(([clause, value]): Clause => ({ id: "G23", clause, mutate: catalogResponse(value) })),
  { id: "G24", clause: "only=routeprobe0 fails if the gateway relays as zdr", mutate: ({ header, rewrite, next }) =>
    header === "only=routeprobe0" ? rewrite({ header: "zdr" }) : next() },
  { id: "G24", clause: "only=routeprobe0,aurora fails if the gateway drops aurora", mutate: ({ header, rewrite, next }) =>
    header === "only=routeprobe0,aurora" ? rewrite({ header: "only=routeprobe0" }) : next() },
  { id: "G24", clause: "ignore=routeprobe0 fails if the gateway answers unsatisfiable", mutate: ({ header, rewrite, next }) =>
    header === "ignore=routeprobe0" ? rewrite({ header: "only=routeprobe0" }) : next() },
  { id: "G24", clause: "ignore=routeprobe0,aurora fails if the gateway relays Aurora", mutate: ({ header, rewrite, next }) =>
    header === "ignore=routeprobe0,aurora" ? rewrite({ header: "only=aurora" }) : next() },
  { id: "G24", clause: "order=routeprobe0,aurora fails when the gateway reports unsupported", mutate: ({ header, next }) =>
    header === "order=routeprobe0,aurora" ? protocolError("unsupported", "order") : next() },
  { id: "G25", clause: "model=4 with header bits=0 fails if it returns unsupported instead of the model error", mutate: ({ header, body, next }) =>
    header === "bits=0" && body.model === 4 ? protocolError("unsupported", "bits") : next() },
  ...([applied, refusal, evidence] as const).map((name): Clause => ({
    id: "G25", clause: `malformed JSON with repeated Route-Policy lines fails if ${name} is present`,
    mutate: async ({ request, transport, header, next }) => {
      if (!transport?.repeatedRoutePolicy || header === null || await request.clone().text() !== "{") return next();
      const reply = await next();
      return change(reply, { replace: { [name]: name === applied ? formatApplied("aurora")
        : name === refusal ? formatRefused("unsupported", "bits") : "https://aurora.example/evidence" } });
    },
  })),
  { id: "G26", clause: "an ordinary credential with no explicit policy fails if it gets unavailable", mutate: async ({ request, auth, header, suffix, next }) => {
    const reply = await next();
    return request.method === "POST" && auth === `Bearer ${key}` && header === null && suffix === null && reply.ok
      ? protocolError("unavailable") : reply;
  } },
  { id: "G29", clause: "bits=64 fails the precedence check when it returns unavailable", mutate: ({ header, suffix, next }) =>
    header === "bits=64" && suffix === null ? protocolError("unavailable") : next() },
  { id: "G29", clause: "header zdr with suffix bits=0 fails the precedence check when it returns unavailable", mutate: ({ header, suffix, next }) =>
    header === "zdr" && suffix === "bits=0" ? protocolError("unavailable") : next() },
];

for (const { id, clause, mutate, target } of clauses) reportTest(`${id}: ${clause}`, expectationsFor(expectedByCase.clause, clause), async (t, expected) => {
  let reached = false;
  const report = await run(t, fixture(async (exchange) => {
    let original: Response | undefined;
    const reply = await mutate({ ...exchange, next: async () => {
      original = await exchange.next();
      return original;
    } });
    reached ||= reply !== original;
    return reply;
  }, target));
  assert.ok(reached, "the suite reached the deliberately broken branch");
  expectReport(report, expected);
});

for (const name of [applied, refusal, evidence] as const) reportTest(`G19: duplicating ${name} on the wire fails the result check`, expectedByCase.duplicate[name], async (t, expected) => {
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
  expectReport(report, expected);
});

for (const broken of [false, true]) reportTest(`G25: bound-key HTTP 429 ${broken ? "fails when bits=0 returns unsupported" : "passes when bits=0 returns the bare 429"}`, expectedByCase.boundThrottle[broken ? "refused" : "bare"]!, async (t, expected) => {
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
  expectReport(report, expected);
});

reportTest("G2: unsupported+key=zdr fails when the streaming probe uses advertised zdr", {
  "G2 [chat/completions]": failure(inference(model, [["Route-Policy","zdr"]], true), received(400, error("fixture refusal", "invalid_request_error"), [], ["reason=unsupported+key=zdr"]), "no accepted key can be named as a failing key"),
  "G21 [chat/completions]": failure(inference(model, [["Route-Policy","zdr"]], true), received(400, error("fixture refusal", "invalid_request_error"), [], ["reason=unsupported+key=zdr"]), "advertised support accepts every key and value sent; unsupported is not justified"),
  "G15 [chat/completions]": "FAIL",
}, async (t, expected) => {
  let broken = 0;
  const report = await run(t, fixture(({ body, header, next }) => {
    if (body.stream !== true || header !== "zdr") return next();
    broken++;
    return protocolError("unsupported", "zdr");
  }));
  assert.equal(broken, 1);
  expectReport(report, expected);
});

reportTest("G22: HTTP 201 fails detection status but leaves its key_policy=zdr valid", {
  "G20": failure(get("/route-policy"), received(201, JSON.stringify({"route_policy":"1","keys":["zdr","notrain","bits","region","attest","only","ignore","sort","order"],"attest":["weights","prompt"],"sort":["price","latency","throughput"],"key_policy":"zdr"})), "a complete valid detection reply: status is 201, not 200"),
  "G22": ["PASS","the anonymous reply omitted key_policy; every observed credentialed key_policy was valid under its own lists; observed 2 × HTTP 200, 1 × HTTP 201"],
  "G10 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP",
}, async (t, expected) => {
  const report = await run(t, fixture(async ({ path, auth, next }) => {
    const reply = await next();
    if (path !== "/v1/route-policy" || auth !== `Bearer ${policyKey}`) return reply;
    const body: unknown = await reply.clone().json();
    assert.ok(body !== null && typeof body === "object" && "key_policy" in body);
    assert.equal(body.key_policy, "zdr");
    return change(reply, { status: 201 });
  }));
  expectReport(report, expected);
});

reportTest("G20: detection preserves the exact tenant=east query and its two tag values", discovery(5), async (t, expected) => {
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
  expectReport(report, expected);
}, INFERENCE_ENDPOINTS);

test("G20: a fragment or URL credentials rejects the base before the detection request", async (t) => {
  let requests = 0;
  const base = await baseAt(t, serve((request, transport) => { requests++; return good(request, transport); }, 0));
  for (const invalid of [`${base}#debug`, `${base}#`, base.replace("://", "://operator@"), base.replace("://", "://:secret@")]) {
    await assert.rejects(runConformance({ base: invalid }), /without a fragment or credentials/);
  }
  assert.equal(requests, 0);
});

reportTest("G15: a delayed zdr relay passes when responses is the selected endpoint", {
  "G15 [responses]": ["PASS","policy relays with a checked catalog named published providers; observed 56 × HTTP 200 provider=aurora, 5 × HTTP 200 provider=basalt; https://basalt.example/attestation, 8 × HTTP 200 provider=basalt, 4 × HTTP 200 provider=cobalt"],
}, async (t, expected) => {
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
  expectReport(report, expected);
}, ["responses"]);

for (const query of ["", "?", "?tenant=east", "?a=first&a=second", "?tag=O'Brien", "?tag=O%27Brien", "?tag=a%2bb&tag=a+b&flag=%3F"]) {
  reportTest(`G20: discovery preserves the raw target with ${query === "" ? "no query" : JSON.stringify(query)}`, discovery(5), async (t, expected) => {
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
    expectReport(report, expected);
  }, INFERENCE_ENDPOINTS);
}

for (const [component, suffix] of [
  ["query", "?tenant=two words"], ["path", "/two words"], ["path", "/naïve"],
  ["query", "?tenant=\tq"], ["query", "?tenant=\r\nq"], ["query", "?tenant=\x00q"], ["path", "\\tenant"],
]) test(`G20: a base ${component} containing raw ${JSON.stringify(suffix)} is rejected before detection`, async (t) => {
  let count = 0;
  const base = await baseAt(t, serve((request, transport) => { count++; return good(request, transport); }, 0));
  await assert.rejects(runConformance({ base: `${base}${suffix}` }), {
    name: "TypeError", message: "cannot reproduce the base URL's request target exactly; supply an escaped HTTP(S) URL",
  });
  assert.equal(count, 0);
});

for (const { title, policy, lists } of [
  { title: "key_policy=17 fails even when keys is the string zdr", policy: 17, lists: { keys: "zdr" } },
  { title: "key_policy=null fails even when sort is null", policy: null, lists: { sort: null } },
  { title: "key_policy=zdr++notrain fails even when attest contains bad value", policy: "zdr++notrain", lists: { attest: ["bad value"] } },
  { title: "key_policy=later=valid skips when keys is the string zdr", policy: "later=valid", lists: { keys: "zdr" } },
  { title: "key_policy=later=valid passes when keys advertises later", policy: "later=valid", lists: { keys: ["later"] } },
] as const) reportTest(`G22: ${title}`, expectedByCase.boundDiscovery[title]!, async (t, expected) => {
  const report = await run(t, fixture(detectionResponse({ route_policy: "1", ...lists, key_policy: policy }, { credentialed: true })));
  expectReport(report, expected);
});

reportTest("G22: a null detection body leaves key_policy unverified", {
  "G20": failure(get("/route-policy", null), received(200, JSON.stringify(null)), "a complete valid detection reply: not a JSON object"),
  "G22": skip("an inspectable detection object under each supplied credential and anonymously"),
}, async (t, expected) => {
  const report = await run(t, fixture(detectionResponse(null)));
  expectReport(report, expected);
});

reportTest("G11: accepting no policy keys leaves the valid header-and-suffix check unverified", {
  "G11 [chat/completions]": skip("a combined-policy witness distinguishing omission of the header and suffix"),
  "G3 [chat/completions]": "SKIP", "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP",
  "G8 [chat/completions]": "SKIP", "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP",
  "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP",
  "G17 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP", "G25 [chat/completions]": "SKIP",
  "G29 [chat/completions]": "SKIP",
}, async (t, expected) => {
  const target = createGateway({
    models: { [model]: routes }, keys: { [key]: {}, [policyKey]: {} }, accept: { keys: [] },
    fetch: () => Response.json({ output: "served" }),
  });
  const report = await run(t, target);
  expectReport(report, expected);
});

for (const broken of ["none", "header", "suffix"] as const) {
  reportTest(`G11: zdr and notrain on an Aurora-only catalog ${broken === "none" ? "pass when both orientations refuse" : `fail when the fixture drops notrain from the ${broken}`}`, expectedByCase.carrierFlags[broken]!, async (t, expected) => {
    const open = createGateway({
      models: { [model]: [{ ...routes[0]!, facts: "zdr" }] }, accept: { keys: ["zdr", "notrain"] },
      fetch: () => Response.json({ output: "served" }),
    });
    const pairs = new Set<string>();
    const report = await run(t, fixture(async ({ header, suffix, next, rewrite }) => {
      if ((header !== "zdr" || suffix !== "notrain") && (header !== "notrain" || suffix !== "zdr")) return next();
      pairs.add(`${header}:${suffix}`);
      if (broken === "header" && header === "notrain") return rewrite({ header: null });
      if (broken === "suffix" && suffix === "notrain") return rewrite({ suffix: null });
      const reply = await next();
      assert.equal(reply.status, 400);
      assert.equal(reply.headers.get(refusal), "reason=unsatisfiable");
      return reply;
    }, open));
    assert.ok(pairs.size > 0);
    if (broken === "none") assert.deepEqual(pairs, new Set(["zdr:notrain", "notrain:zdr"]));
    if (broken === "header") assert.ok(pairs.has("notrain:zdr"));
    if (broken === "suffix") assert.ok(pairs.has("zdr:notrain"));
    expectReport(report, expected);
  });
}

reportTest("G11: a one-route zdr catalog leaves header and suffix omission indistinguishable", {
  "G11 [chat/completions]": skip("a combined-policy witness distinguishing omission of the header and suffix"),
  "G3 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP",
  "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G17 [chat/completions]": "SKIP",
  "G24 [chat/completions]": "SKIP", "G25 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
}, async (t, expected) => {
  const open = createGateway({
    models: { [model]: [routes[0]!] }, accept: { keys: ["zdr"] },
    fetch: () => Response.json({ output: "served" }),
  });
  const report = await run(t, open);
  expectReport(report, expected);
});

for (const order of [[0, 1], [1, 0]] as const) reportTest(`G11: bits=1 plus bits=64 ${order[0] === 0 ? "passes after bits=1 alone relays aurora" : "skips when bits=1 alone also relays basalt"}`, expectedByCase.carrierFloor[order[0]]!, async (t, expected) => {
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
  expectReport(report, expected);
});

reportTest("G12: a region=jp header and region=de suffix fail when an incompatible relay is returned", {
  "G12 [chat/completions]": failure(inference(model + "+region=de", [["Route-Policy","region=jp"]]), received(200, JSON.stringify({"output":"served"}), ["provider=aurora"]), "400 unsatisfiable for an empty intersection in either carrier order"),
  "G3 [chat/completions]": "FAIL", "G6 [chat/completions]": "FAIL", "G7 [chat/completions]": "SKIP",
  "G10 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G17 [chat/completions]": "SKIP",
  "G24 [chat/completions]": "SKIP", "G25 [chat/completions]": "SKIP",
}, async (t, expected) => {
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
  expectReport(report, expected);
});

reportTest("G12: a catalog with no region fact skips the region intersection witness", {
  "G12 [chat/completions]": skip("a qualifying published region to distinguish an empty region intersection"),
  "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP",
  "G11 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP",
  "G17 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP", "G25 [chat/completions]": "SKIP",
}, async (t, expected) => {
  const target = createGateway({
    models: { [model]: [routes[2]!] }, accept: { keys: ["region"] },
    fetch: () => Response.json({ output: "served" }),
  });
  const report = await run(t, target);
  expectReport(report, expected);
});

reportTest("G10: one route already meeting the zdr default leaves its narrowing unverified", {
  "G10 [chat/completions]": skip("a published model whose qualification can distinguish applying the bound key policy"),
  "G13 [chat/completions]": "SKIP", "G17 [chat/completions]": "SKIP",
}, async (t, expected) => {
  const target = createGateway({
    models: { [model]: [routes[0]!] }, keys: { [key]: {}, [policyKey]: { policy: "zdr" } },
    fetch: () => Response.json({ output: "served" }),
  });
  const report = await run(t, target);
  expectReport(report, expected);
});

reportTest("G13: the zdr-bound key leaves weakening unverified when the explicit probes still match aurora", {
  "G13 [chat/completions]": skip("an accepted explicit policy whose routes are all excluded by the bound requirement"),
  "G3 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP", "G12 [chat/completions]": "SKIP",
  "G17 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
}, async (t, expected) => {
  const target = createGateway({
    models: { [model]: [routes[0]!, routes[2]!] }, accept: { keys: ["zdr", "sort"] },
    keys: { [key]: {}, [policyKey]: { policy: "zdr" } },
    fetch: () => Response.json({ output: "served" }),
  });
  const report = await run(t, target);
  expectReport(report, expected);
});

reportTest("G7: sort=price is compatible with a catalog holding one route and no accepted requirements", {
  "G7 [chat/completions]": ["PASS","accepted preference probes returned a qualifying provider or unavailable, not unsatisfiable; observed 2 × HTTP 200 provider=aurora"],
  "G3 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP",
  "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G17 [chat/completions]": "SKIP",
  "G24 [chat/completions]": "SKIP", "G25 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
}, async (t, expected) => {
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
  expectReport(report, expected);
});

for (const [impossible, partner, keys] of [
  ["bits=64", "bits=1", ["bits"]], ["bits=1", "sort=price", ["bits", "sort"]],
] as const) reportTest(`G11: ${impossible} with ${partner} is probed in both carrier orientations`, expectedByCase.carrierPairs[impossible]!, async (t, expected) => {
  const target = createGateway({
    models: { [model]: [{ ...routes[0]!, facts: impossible === "bits=64" ? "bits=8" : "" }] },
    accept: { keys, sort: ["price"] },
    fetch: () => Response.json({ output: "served" }),
  });
  const pairs = new Set<string>();
  const report = await run(t, fixture(({ header, suffix, next }) => {
    if (header !== null && suffix !== null && [header, suffix].includes(impossible) && [header, suffix].includes(partner)) {
      pairs.add(`${header}:${suffix}`);
    }
    return next();
  }, target));
  assert.deepEqual(pairs, new Set([`${partner}:${impossible}`, `${impossible}:${partner}`]));
  expectReport(report, expected);
});

for (const broken of [false, true]) reportTest(`G3: only=0,a-b_c.d with future=narrow ${broken ? "fails for a local relay" : "passes for an unsatisfiable refusal"}`, expectedByCase.opaqueBound[broken ? "relay" : "refused"]!, async (t, expected) => {
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
  for (const reply of replies) assert.deepEqual(reply, broken ? { status: 200, applied: "provider=local" } : { status: 400, applied: null });
  expectReport(report, expected);
});

for (const [header, suffix, overlap] of [["only=aurora", "only=basalt", "only=aurora,basalt"], ["region=us", "region=de", "region=us,de"]] as const) {
  const probe: Probe = { path: "responses", raw: JSON.stringify({ model: `${model}+${suffix}` }), policies: [header] };
  const sent = { method: "POST", path: "/responses", credentialHeader: null, routePolicyLines: [["Route-Policy", header]], body: probe.raw };
  const audit = (reply: Parameters<typeof auditResults>[0][number]["reply"], request = probe) =>
    auditResults([{ probe: request, reply }], (candidate) => resultContext(candidate, undefined));
  test(`G3: an HTTP 200 relay fails for ${header} plus suffix ${suffix} with no detection or catalog`, () => {
    const reply = { status: 200, body: { text: "served" }, hasBody: true, contentType: "application/json",
      applied: ["provider=aurora"], refused: [], evidence: [], received: "200 provider=aurora" };
    const overlapProbe = { ...probe, policies: [overlap] };
    const overlapReply = { ...reply, applied: ["provider=basalt"], received: "200 provider=basalt" };
    assert.deepEqual([audit(reply), audit(overlapReply, overlapProbe)], [
      { failures: new Map([
        ["G3", failure(sent, reply.received, "no route can meet even the known requirements, regardless of any unknown key requirements")[1]],
        ["G6", failure(sent, reply.received, "the named published route must meet at least the known requirements; an unknown key default cannot admit an excluded route")[1]],
      ]), catalogRelays: [], attestedRelays: [], results: [{ probe, reply }] },
      { failures: new Map(), catalogRelays: [], attestedRelays: [], results: [{ probe: overlapProbe, reply: overlapReply }] },
    ]);
  });
  test(`G29: HTTP 503 unavailable fails for ${header} plus suffix ${suffix} with no detection or catalog`, () => {
    const reply = { status: 503, body: undefined, hasBody: true, contentType: "text/plain",
      applied: [], refused: ["reason=unavailable"], evidence: [], received: "503 reason=unavailable" };
    assert.deepEqual(audit(reply), {
      failures: new Map([
        ["G3", failure(sent, reply.received, "unavailable presupposes a qualifying route, but none meets even the known requirements")[1]],
        ["G29", failure(sent, reply.received, "unavailable must not mask a refusal before routing")[1]],
      ]), catalogRelays: [], attestedRelays: [], results: [{ probe, reply }],
    });
  });
}

for (const reason of ["unsupported", "unavailable"] as const) reportTest(`G29: with detection at 404, disjoint aurora and basalt selectors ${reason === "unsupported" ? "leave unsupported inconclusive" : "make unavailable fail"}`, expectedByCase.undetected[reason]!, async (t, expected) => {
  let intersection = 0;
  const report = await run(t, fixture(({ path, header, suffix, next }) => {
    if (path === "/v1/route-policy") return new Response(null, { status: 404 });
    if (header !== "only=aurora" || suffix !== "only=basalt") return next();
    intersection++;
    return protocolError(reason, reason === "unsupported" ? "only" : undefined);
  }));
  assert.equal(intersection, 1);
  expectReport(report, expected);
});

reportTest("G24: only=0,a-b_c.d fails when both providers are unpublished and the gateway reports unavailable", {
  "G24 [chat/completions]": failure(inference(model, [["Route-Policy","only=0,a-b_c.d"]]), received(503, error("fixture refusal", "invalid_request_error"), [], ["reason=unavailable"]), "a valid selector containing an unknown provider is not unsupported and cannot make a nonexistent route available"),
  "G3 [chat/completions]": "FAIL", "G29 [chat/completions]": "FAIL",
}, async (t, expected) => {
  const report = await run(t, fixture(({ header, next }) =>
    header === "only=0,a-b_c.d" ? protocolError("unavailable") : next()));
  expectReport(report, expected);
});
