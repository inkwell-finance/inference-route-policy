import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { addGate, type Verdict } from "../src/fetch-gate.ts";
import type { Completion, Outgoing } from "../src/request.ts";
import { fakeGateway, type FakeGateway } from "./fixtures.ts";

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

test("C1: a request a gate stops fails in fetch before anything reaches the gateway", async () => {
  gateway.requests.length = 0;
  const remove = addGate(() => ({ kind: "stop", reason: "not released" }));
  await assert.rejects(post({ model: "demo-model", messages: [{ role: "user", content: "secret" }] }), /^Error: Blocked by the route policy plugin, nothing was sent: not released$/);
  remove();
  assert.equal(gateway.requests.length, 0);
});

test("C1: a gate that throws stops the request rather than letting it pass", async () => {
  gateway.requests.length = 0;
  const remove = addGate(() => {
    throw new Error("broken gate");
  });
  await assert.rejects(post({ model: "demo-model" }), /the plugin failed while checking the request: broken gate/);
  remove();
  assert.equal(gateway.requests.length, 0);
});

test("C1: a request one gate released goes, even when another gate watching the same base URL would stop it", async () => {
  gateway.requests.length = 0;
  gateway.replies.inference = { status: 200, headers: { "route-applied": "provider=aurora" }, body: { ok: true } };
  const removeStop = addGate(() => ({ kind: "stop", reason: "not mine" }));
  const removeRelease = addGate(() => ({ kind: "released", complete: () => {} }));
  const response = await post({ model: "demo-model" });
  assert.deepEqual(await response.json(), { ok: true });
  removeStop();
  removeRelease();
  assert.equal(gateway.requests.length, 1);
});

test("C5: the releasing gate reads the result headers of its own call, a 400 refusal included, and the response is returned untouched", async () => {
  const seen: { outgoing: Outgoing; completion: Completion }[] = [];
  const remove = addGate((outgoing): Verdict => ({ kind: "released", complete: (completion) => seen.push({ outgoing, completion }) }));
  gateway.replies.inference = { status: 400, headers: { "route-refused": "reason=unsatisfiable" }, body: { error: { message: "unsatisfiable" } } };
  const response = await post({ model: "demo-model+only=nosuch", messages: [] }, { "Route-Policy": "zdr" });
  remove();
  assert.deepEqual(await response.json(), { error: { message: "unsatisfiable" } });
  assert.deepEqual(seen, [
    {
      outgoing: { url: `${gateway.base}/chat/completions`, method: "POST", credential: "demo-key", model: "demo-model+only=nosuch", header: "zdr" },
      completion: { status: 400, result: { applied: [], refused: ["reason=unsatisfiable"], evidence: [] } },
    },
  ]);
});

test("C3: repeated Route-Applied lines reach the reader as one joined value", async () => {
  const seen: Completion[] = [];
  const remove = addGate(() => ({ kind: "released", complete: (completion) => seen.push(completion) }));
  gateway.replies.inference = { status: 200, headers: { "route-applied": ["provider=aurora", "provider=basalt"] }, body: {} };
  await (await post({ model: "demo-model" })).text();
  remove();
  assert.deepEqual(seen[0]?.result.applied, ["provider=aurora, provider=basalt"]);
});

test("C1, C14: the gate reads the key from x-api-key too, and a body it cannot read has an unknown model", async () => {
  const seen: Outgoing[] = [];
  const remove = addGate((outgoing) => {
    seen.push(outgoing);
    return { kind: "pass" };
  });
  await (await fetch(`${gateway.base}/messages`, { method: "POST", headers: { "x-api-key": "anthropic-style" }, body: new TextEncoder().encode("{\"model\":\"demo-model\"}") })).text();
  await (await fetch(`${gateway.base}/chat/completions`, { method: "POST", body: JSON.stringify({ messages: [] }) })).text();
  await (await fetch(`${gateway.base}/models`)).text();
  remove();
  assert.deepEqual(
    seen.map((o) => [o.method, o.credential, o.model]),
    [
      ["POST", "anthropic-style", undefined],
      ["POST", null, null],
    ],
    "GETs are not asked about",
  );
});
