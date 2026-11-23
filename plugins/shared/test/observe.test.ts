import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { interpret } from "../src/outcome.ts";
import { observeExchanges, type Exchange } from "../src/observe.ts";
import { fakeGateway, policy, type FakeGateway } from "./fixtures.ts";

let gateway: FakeGateway;
before(async () => {
  gateway = await fakeGateway();
});
after(async () => {
  await gateway.close();
});

/** What a harness transport does: POST a JSON body with headers through the global fetch. */
async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${gateway.base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer demo-key", ...headers }, body: JSON.stringify(body) });
}

test("C5: the result headers of a 400 refusal are read, though both harnesses' response hooks skip non-2xx responses", async () => {
  const seen: Exchange[] = [];
  const stop = observeExchanges((exchange) => seen.push(exchange));
  gateway.replies.inference = { status: 400, headers: { "route-refused": "reason=unsatisfiable" }, body: { error: { message: "unsatisfiable" } } };
  const response = await post({ model: "demo-model+only=nosuch", messages: [] }, { "Route-Policy": "zdr" });
  stop();
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { message: "unsatisfiable" } }, "the response reaches the caller untouched");
  assert.equal(seen.length, 1);
  const [exchange] = seen;
  assert.deepEqual(
    { method: exchange?.method, body: exchange?.body, credential: exchange?.credential, routePolicy: exchange?.routePolicy, status: exchange?.status, result: exchange?.result },
    {
      method: "POST",
      body: JSON.stringify({ model: "demo-model+only=nosuch", messages: [] }),
      credential: "demo-key",
      routePolicy: "zdr",
      status: 400,
      result: { applied: [], refused: ["reason=unsatisfiable"], evidence: [] },
    },
  );
});

test("C3: repeated Route-Applied lines reach the reader as one joined value, which is not honored", async () => {
  const seen: Exchange[] = [];
  const stop = observeExchanges((exchange) => seen.push(exchange));
  gateway.replies.inference = { status: 200, headers: { "route-applied": ["provider=aurora", "provider=basalt"] }, body: {} };
  await (await post({ model: "demo-model" })).text();
  stop();
  const [exchange] = seen;
  assert.ok(exchange !== undefined);
  assert.deepEqual(exchange.result.applied, ["provider=aurora, provider=basalt"]);
  assert.equal(interpret(exchange.result, { kind: "protocol", policy: policy("zdr"), routes: null }).kind, "not-honored");
});

test("C1: observing never changes or blocks a request, even when a listener throws, and stops when asked", async () => {
  const stopThrowing = observeExchanges(() => {
    throw new Error("listener failure");
  });
  const wrapped = globalThis.fetch;
  const seen: Exchange[] = [];
  const stop = observeExchanges((exchange) => seen.push(exchange));
  assert.equal(globalThis.fetch, wrapped, "a second listener does not wrap fetch again");
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=aurora" }, body: { ok: true } };
  gateway.requests.length = 0;
  const response = await post({ model: "demo-model", messages: [{ role: "user", content: "hi" }] }, { "x-test": "1" });
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(JSON.parse(gateway.requests[0]?.body ?? ""), { model: "demo-model", messages: [{ role: "user", content: "hi" }] });
  assert.equal(gateway.requests[0]?.headers["x-test"], "1");
  stop();
  stopThrowing();
  await (await post({ model: "demo-model" })).text();
  assert.equal(seen.length, 1, "a stopped listener hears nothing more");
});

test("C3: a request body that is not text is observed with no body, so no request the plugin sent can match it", async () => {
  const seen: Exchange[] = [];
  const stop = observeExchanges((exchange) => seen.push(exchange));
  await (await fetch(`${gateway.base}/chat/completions`, { method: "POST", headers: { "x-api-key": "anthropic-style" }, body: new TextEncoder().encode("{\"model\":\"demo-model\"}") })).text();
  stop();
  assert.deepEqual([seen[0]?.body, seen[0]?.credential], [null, "anthropic-style"]);
});
