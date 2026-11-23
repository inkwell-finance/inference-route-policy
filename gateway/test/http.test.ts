import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import { test, type TestContext } from "node:test";
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
      const policy = result.raw.flatMap((name, i) => i % 2 === 0 && name.toLowerCase() === "route-refused" ? [result.raw[i + 1]] : []);
      assert.equal(result.status, id === model ? 400 : 404);
      assert.deepEqual(policy, id === model ? ["reason=unsupported"] : []);
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
    const response = await pending;
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

test("G16 G33 G35: upstream informational headers do not commit routing, but upstream redirects are relayed without a replay", async (t) => {
  const reached: string[] = [];
  const upstream = createServer((req, res) => {
    reached.push(req.url ?? "");
    if (req.url?.startsWith("/aurora/")) {
      res.writeEarlyHints({ link: "</resource>; rel=preload; as=fetch" });
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

test("G14 G17 G20 G23: demo advertises routes, forwards to real mock surfaces, and plain has no detection", async (t) => {
  const { server, base } = await startDemo(0);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const detection = await fetch(`${base}/v1/route-policy`, { headers: { "x-api-key": "demo-key-zdr" } });
  assert.equal(detection.status, 200);
  const detectionBody: unknown = await detection.json();
  assert.ok(detectionBody && typeof detectionBody === "object" && "route_policy" in detectionBody && "key_policy" in detectionBody);
  assert.equal(detectionBody.route_policy, "1");
  assert.equal(detectionBody.key_policy, "zdr");
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
  assert.equal((await fetch(`${base}/plain/v1/route-policy`)).status, 404);
  assert.match(await (await fetch(`${base}/plain/v1/chat/completions`, target(model))).text(), /served by plain/);
  const log: unknown = await (await fetch(`${base}/__demo/requests`)).json();
  assert.ok(Array.isArray(log));
  assert.equal(log.length, 7);
  const reported: unknown[] = log;
  const actual = reported.map((row) => {
    assert.ok(typeof row === "object" && row !== null && "provider" in row && "path" in row && "body" in row && "headers" in row);
    assert.ok(typeof row.body === "object" && row.body !== null && "model" in row.body);
    assert.ok(typeof row.headers === "object" && row.headers !== null);
    for (const name of ["route-policy", "authorization", "x-api-key"]) assert.equal(Object.hasOwn(row.headers, name), false);
    return [row.provider, row.path, row.body.model];
  });
  assert.deepEqual(actual, [...ENDPOINTS.flatMap((ep) => [["basalt", `/v1/${ep}`, model], ["basalt", `/v1/${ep}`, model]]), ["plain", "/v1/chat/completions", model]]);
  assert.equal((await fetch(`${base}/__demo/requests`, { method: "DELETE" })).status, 204);
  assert.deepEqual(await (await fetch(`${base}/__demo/requests`)).json(), []);
});
