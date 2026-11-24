import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { createGateway, ENDPOINTS, type Route } from "../src/gateway.ts";
import { serve } from "../src/serve.ts";
import { startDemo } from "../src/demo.ts";

const model = "demo-model";
const route = (provider: string, url: string): Route => ({ provider, url, facts: "zdr", price: 1, latencyMs: 1, throughput: 1 });
const target = (id: string, streaming = false) => ({ method: "POST", body: JSON.stringify({ model: id, stream: streaming }), headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(3000) });
async function listening(t: TestContext, server: Server): Promise<string> {
  t.after(() => { server.closeAllConnections(); server.close(); });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

for (const endpoint of ENDPOINTS) {
  test(`G9 G25 ${endpoint}: adapter counts differently cased raw lines before fetch Headers can join them`, async (t) => {
    let calls = 0;
    const handler = createGateway({ models: { [model]: [route("aurora", "http://aurora.example/v1")] }, fetch: () => { calls++; return new Response("served"); } });
    const base = await listening(t, serve(handler, 0));
    for (const id of [model, "unknown+bits=0"]) {
      const data = JSON.stringify({ model: id });
      const origin = new URL(base);
      const result = await new Promise<{ status: number | undefined; raw: string[] }>((resolve, reject) => {
        const outgoing = request(`${base}/v1/${endpoint}`, { method: "POST", headers: ["Host", origin.host, "Content-Length", String(Buffer.byteLength(data)), "Route-Policy", "only=aurora", "rOuTe-PoLiCy", "basalt"], signal: AbortSignal.timeout(3000) }, (incoming) => {
          incoming.resume();
          incoming.on("error", reject);
          incoming.on("end", () => resolve({ status: incoming.statusCode, raw: incoming.rawHeaders }));
        });
        outgoing.on("error", reject);
        outgoing.end(data);
      });
      const policy = result.raw.flatMap((name, i) => {
        const header = name.toLowerCase();
        return i % 2 === 0 && ["route-applied", "route-refused", "route-evidence"].includes(header)
          ? [[header, result.raw[i + 1]]] : [];
      });
      assert.equal(result.status, id === model ? 400 : 404);
      assert.deepEqual(policy, id === model ? [["route-refused", "reason=unsupported"]] : []);
    }
    assert.equal(calls, 0);
  });

  test(`G16 G33 ${endpoint}: final headers are committed before the body finishes and an upstream stream error never retries`, async (t) => {
    const calls: string[] = [];
    let ready: (controller: ReadableStreamDefaultController<Uint8Array>) => void;
    const controllerReady = new Promise<ReadableStreamDefaultController<Uint8Array>>((resolve) => { ready = resolve; });
    const handler = createGateway({ models: { [model]: [route("aurora", "http://aurora.example/v1"), route("basalt", "http://basalt.example/v1")] }, fetch: (input: string) => {
      calls.push(new URL(input).hostname);
      return new Response(new ReadableStream<Uint8Array>({ start: (controller) => ready(controller) }), { headers: { "content-type": "text/event-stream" } });
    } });
    const base = await listening(t, serve(handler, 0));
    const pending = fetch(`${base}/v1/${endpoint}`, target(`${model}+zdr`, true));
    const controller = await controllerReady;
    const response = await pending.catch((error: unknown) => assert.fail(`expected final headers before producing body bytes: ${String(error)}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("route-applied"), "provider=aurora");
    const reader = response.body!.getReader();
    controller.enqueue(new TextEncoder().encode("data: first\n\n"));
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), "data: first\n\n");
    controller.error(new Error("upstream disconnected after first chunk"));
    await assert.rejects(reader.read());
    assert.deepEqual(calls, ["aurora.example"]);
  });
}

test("G33 G35 G37: after a failed route, relay the next provider's redirect without replaying content", async (t) => {
  const reached: string[] = [];
  const upstream = createServer((req, res) => {
    reached.push(req.url ?? "");
    if (req.url?.startsWith("/aurora/")) {
      res.writeHead(502).end("could not serve");
    } else if (req.url?.startsWith("/basalt/")) {
      res.writeHead(307, { location: "/unconfigured", "Route-Applied": "provider=aurora" }).end("provider redirect");
    } else res.end("should not receive content");
  }).listen(0, "127.0.0.1");
  const base = await listening(t, upstream);
  const handler = createGateway({ models: { [model]: [route("aurora", `${base}/aurora/v1`), route("basalt", `${base}/basalt/v1`)] } });
  const url = await listening(t, serve(handler, 0));
  const reply = await fetch(`${url}/v1/chat/completions`, { ...target(`${model}+zdr`), redirect: "manual" });
  assert.equal(reply.status, 307);
  assert.equal(reply.headers.get("route-applied"), "provider=basalt");
  assert.equal(reply.headers.get("location"), "/unconfigured");
  assert.equal(await reply.text(), "provider redirect");
  assert.deepEqual(reached, ["/aurora/v1/chat/completions", "/basalt/v1/chat/completions"]);
});

test("G14 G33: relay decoded gzip without the provider's content-encoding or length", async (t) => {
  const forwarded: { encoding: string | undefined; policy: string | string[] | undefined; body: string }[] = [];
  const payload = "served by basalt";
  const gzip = gzipSync(payload);
  const provider = createServer(async (incoming, outgoing) => {
    let body = "";
    incoming.setEncoding("utf8");
    for await (const chunk of incoming) body += chunk;
    forwarded.push({ encoding: incoming.headers["accept-encoding"], policy: incoming.headers["route-policy"], body });
    outgoing.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip", "content-length": gzip.length }).end(gzip);
  }).listen(0, "127.0.0.1");
  const base = await listening(t, provider);
  const handler = createGateway({ models: { [model]: [route("basalt", `${base}/v1`)] } });
  const url = await listening(t, serve(handler, 0));
  const init = target(`${model}+zdr`);
  const reply = await fetch(`${url}/v1/chat/completions`, { ...init, headers: { ...init.headers, "Route-Policy": "zdr", "accept-encoding": "br" } });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get("content-encoding"), null);
  assert.equal(reply.headers.get("content-length"), null);
  assert.equal(await reply.text(), payload);
  assert.deepEqual(forwarded, [{ encoding: "identity", policy: undefined, body: JSON.stringify({ model, stream: false }) }]);
});

test("G14 G17 G20 G23: demo advertises routes, forwards to real mock surfaces, and plain has no detection", async (t) => {
  const { server, base } = await startDemo(0);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const detection = await fetch(`${base}/v1/route-policy`, { headers: { "x-api-key": "demo-key-zdr" } });
  assert.equal(detection.status, 200);
  const detectionBody: unknown = await detection.json();
  assert.ok(detectionBody && typeof detectionBody === "object" && "route_policy" in detectionBody && "key_policy" in detectionBody);
  assert.equal(detectionBody.route_policy, "1");
  assert.equal(detectionBody.key_policy, "zdr");
  const anonymous = await fetch(`${base}/v1/route-policy`);
  assert.equal(anonymous.status, 200);
  assert.deepEqual(await anonymous.json(), Object.fromEntries(Object.entries(detectionBody).filter(([name]) => name !== "key_policy")));
  const listed = await fetch(`${base}/v1/models`);
  assert.deepEqual(await listed.json(), { object: "list", data: [{ id: model, routes: [
    { provider: "aurora", facts: "zdr+notrain+bits=8+region=us" }, { provider: "basalt", facts: "bits=16+region=us,de+attest=weights,prompt", evidence: "https://basalt.example/attestation" }, { provider: "cobalt", facts: "" },
  ] }] });
  for (const endpoint of ENDPOINTS) {
    for (const stream of [false, true]) {
      const init = target(`${model}+attest=weights`, stream);
      const response = await fetch(`${base}/v1/${endpoint}`, { ...init, headers: { ...init.headers, [endpoint === "messages" ? "x-api-key" : "authorization"]: endpoint === "messages" ? "demo-key" : "Bearer demo-key", "Route-Policy": "bits=16" } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("route-evidence"), "https://basalt.example/attestation");
      assert.equal(response.headers.get("route-applied"), "provider=basalt");
      const text = await response.text();
      assert.match(text, /served by basalt/);
      if (stream && endpoint === "chat/completions") assert.match(text, /"choices":\[\],"usage":\{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7\}\}\n\ndata: \[DONE\]\n\n$/);
      if (stream && endpoint === "responses") assert.match(text, /event: response.completed/);
      if (stream && endpoint === "messages") assert.match(text, /event: message_stop/);
    }
  }
  const unattested = await fetch(`${base}/v1/chat/completions`, {
    ...target(`${model}+only=basalt`),
    headers: { authorization: "Bearer demo-key", "content-type": "application/json" },
  });
  assert.equal(unattested.status, 200);
  assert.equal(unattested.headers.get("route-applied"), "provider=basalt");
  assert.equal(unattested.headers.get("route-evidence"), null);
  assert.match(await unattested.text(), /served by basalt/);
  assert.equal((await fetch(`${base}/plain/v1/route-policy`)).status, 404);
  assert.match(await (await fetch(`${base}/plain/v1/chat/completions`, target(model))).text(), /served by plain/);
  const log: unknown = await (await fetch(`${base}/__demo/requests`)).json();
  assert.ok(Array.isArray(log));
  assert.equal(log.length, 8);
  const reported: unknown[] = log;
  const actual = reported.map((row) => {
    assert.ok(typeof row === "object" && row !== null && "provider" in row && "path" in row && "body" in row && "headers" in row);
    assert.ok(typeof row.body === "object" && row.body !== null && "model" in row.body);
    assert.ok(typeof row.headers === "object" && row.headers !== null);
    for (const name of ["route-policy", "authorization", "x-api-key"]) assert.equal(Object.hasOwn(row.headers, name), false);
    return [row.provider, row.path, row.body.model];
  });
  assert.deepEqual(actual, [...ENDPOINTS.flatMap((ep) => [["basalt", `/v1/${ep}`, model], ["basalt", `/v1/${ep}`, model]]),
    ["basalt", "/v1/chat/completions", model], ["plain", "/v1/chat/completions", model]]);
  assert.equal((await fetch(`${base}/__demo/requests`, { method: "DELETE" })).status, 204);
  assert.deepEqual(await (await fetch(`${base}/__demo/requests`)).json(), []);
});
