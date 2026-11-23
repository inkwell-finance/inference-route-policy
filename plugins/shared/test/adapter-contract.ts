// Behavior both adapters must show, run by each adapter's own test file against its own registration: the
// fail-closed boundary around every hook, and translation for OpenRouter.

import assert from "node:assert/strict";
import { test } from "node:test";
import { OPENROUTER_BASE } from "../src/openrouter.ts";
import type { FakeHarness } from "./fake-harness.ts";
import { PATH_QUERY_CASES, WHOLE_URL_CASES } from "./url-cases.ts";
import type { FakeGateway } from "./fixtures.ts";

const notices = (harness: FakeHarness): string[] => harness.shown.filter((s) => s.method === "notify").map((s) => s.text);

/** `ctx` with one accessor replaced by a getter that throws. */
function hostile(ctx: unknown, broken: string): object {
  assert.ok(typeof ctx === "object" && ctx !== null);
  return Object.defineProperty({ ...ctx }, broken, {
    get() {
      throw new Error(`${broken} unavailable`);
    },
  });
}

export function adapterContract(name: string, make: (policy?: string) => Promise<FakeHarness>, gateway: () => FakeGateway): void {
  test(`C1, C14: ${name}: a request that leaves with another key than the one its detection was read for is stopped at fetch`, async () => {
    const harness = await make("zdr");
    harness.wireKey = "demo-key-zdr";
    const result = await harness.request();
    assert.equal(result.sent, false);
    assert.match(result.error ?? "", /^Blocked by the route policy plugin, nothing was sent: this request to .* is not one the plugin released: its URL, headers/);
    assert.equal(gateway().inference().length, 0);
    assert.match(notices(harness).at(-1) ?? "", /^request blocked by the route policy plugin, nothing was sent: this request to .* is not one the plugin released/, "the user is told");
    assert.deepEqual(
      [...new Set(gateway().requests.filter((r) => r.method === "GET").map((r) => r.headers.authorization))],
      ["Bearer demo-key"],
      "detection was read only for the key the registry reported",
    );
  });

  test(`C14: ${name}: a configured Authorization header is the key the plugin reads detection for, and the request with it goes`, async () => {
    const harness = await make("zdr");
    harness.model.headers = { Authorization: "Bearer demo-key-zdr" };
    harness.wireKey = "demo-key-zdr";
    assert.ok((await harness.request()).sent);
    assert.deepEqual([...new Set(gateway().requests.filter((r) => r.method === "GET").map((r) => r.headers.authorization))], ["Bearer demo-key-zdr"]);
    assert.equal(gateway().inference().length, 1);
  });

  test(`C1, C14: ${name}: every header the request carries is in the metadata reads, a cookie and a second key included, and must leave as read`, async () => {
    const harness = await make("zdr");
    harness.model.headers = { "x-api-key": "demo-key-zdr", Cookie: "session=east" };
    assert.ok((await harness.request()).sent, "bearer, x-api-key and cookie all leave as they were read");
    const gets = gateway().requests.filter((r) => r.method === "GET");
    assert.ok(gets.length > 0 && gets.every((r) => r.headers.authorization === "Bearer demo-key" && r.headers["x-api-key"] === "demo-key-zdr" && r.headers.cookie === "session=east"));
    // A transport that adds a cookie the metadata was not read with is stopped.
    harness.model.headers = {};
    harness.extraWireHeaders = { cookie: "session=west" };
    const result = await harness.request();
    assert.match(result.error ?? "", /is not one the plugin released: .*it carries authorization, cookie besides the usual ones/);
    assert.equal(gateway().inference().length, 1);
  });

  test(`C1, C6: ${name}: a request with no key and only a trace header is not credentialed, so a key_policy in the reply blocks it; an api-key header alone is a credential`, async () => {
    gateway().replies.detection = { status: 200, body: { route_policy: "1", key_policy: "zdr" } };
    const traced = await make("zdr");
    traced.resolveAuth = async () => ({ ok: true });
    traced.wireKey = null;
    traced.model.headers = { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" };
    assert.match((await traced.request()).error ?? "", /key_policy is present in a reply to a request without credentials/);
    assert.equal(gateway().inference().length, 0);
    const keyed = await make("zdr");
    keyed.resolveAuth = async () => ({ ok: true });
    keyed.wireKey = null;
    keyed.model.headers = { "api-key": "demo-key" };
    assert.ok((await keyed.request()).sent, "an api-key header is a credential, read and released as context");
    const gets = gateway().requests.filter((r) => r.method === "GET" && r.headers["api-key"] === "demo-key");
    assert.deepEqual(gets.map((r) => r.path.slice(r.path.lastIndexOf("/"))), ["/route-policy", "/models"], "detection and the model list read with the api-key");
    assert.equal(gateway().inference().length, 1);
  });

  test(`C10: ${name}: a request whose payload has no model, to an API that names its model in the body, is blocked: the typed suffix would be lost`, async () => {
    const harness = await make("zdr");
    // The held policy is also in the typed suffix, so the model as decided is the model as selected: nothing to rewrite.
    harness.model = { ...harness.model, id: "demo-model+zdr+only=aurora", api: "openai-responses" };
    const result = await harness.request({ input: "fixture" });
    assert.match(result.error ?? "", /has no model in its body, which the openai-responses API needs/);
    assert.equal(gateway().inference().length, 0);
  });

  test(`C10: ${name}: an API that names its model in the URL cannot carry a typed suffix in a body, so a request with one is blocked`, async () => {
    const harness = await make(undefined);
    harness.model = { ...harness.model, id: "demo-model+zdr", api: "google-generative-ai" };
    harness.wireKey = "demo-key";
    const result = await harness.request({ contents: [] });
    assert.match(result.error ?? "", /does not carry every policy that was decided for it|no model field to carry the policy/);
    assert.equal(gateway().inference().length, 0);
  });

  test(`C10: ${name}: a payload whose model is null, a number, an empty string, or another model is blocked, never sent without its carrier`, async () => {
    for (const model of [null, 7, "", "other-model"]) {
      const harness = await make("zdr");
      const result = await harness.request({ model, messages: [] });
      assert.equal(result.sent, false, `model ${JSON.stringify(model)}`);
      assert.match(result.error ?? "", /^Blocked by the route policy plugin, nothing was sent: /);
    }
    assert.equal(gateway().inference().length, 0);
  });

  test(`C1, C14: ${name}: a base URL with an empty query is read with its "?", and a request that drops it is stopped`, async () => {
    const harness = await make("zdr");
    const base = harness.model.baseUrl;
    harness.model.baseUrl = `${base}?`;
    harness.wireUrl = `${base}/chat/completions?`;
    assert.ok((await harness.request()).sent, "sent with the ? it was read with");
    const path = new URL(base).pathname;
    assert.deepEqual(gateway().requests.map((r) => `${r.method} ${r.path}`), [`GET ${path}/route-policy?`, `GET ${path}/models?`, `POST ${path}/chat/completions?`]);
    harness.wireUrl = `${base}/chat/completions`;
    assert.match((await harness.request()).error ?? "", /is not one the plugin released/);
    assert.equal(gateway().inference().length, 1);
  });

  test(`C14: ${name}: a base URL the parser would send otherwise than written reaches nothing, metadata included, and says what would be sent; written as sent, it is read and sent byte for byte`, async () => {
    const origin = new URL(gateway().base).origin;
    for (const { name: kind, path, query, sentPath, sentQuery, difference } of PATH_QUERY_CASES) {
      const harness = await make("zdr");
      harness.model.baseUrl = `${origin}${path}${query}`;
      harness.wireUrl = `${origin}${sentPath}/chat/completions${sentQuery}`;
      const before = gateway().requests.length;
      const result = await harness.request();
      const received = gateway().requests.slice(before).map((r) => `${r.method} ${r.path}`);
      if (difference === null) {
        assert.ok(result.sent, `${kind}: ${result.error ?? ""}`);
        assert.deepEqual(received, [`GET ${sentPath}/route-policy${sentQuery}`, `GET ${sentPath}/models${sentQuery}`, `POST ${sentPath}/chat/completions${sentQuery}`], kind);
      } else {
        assert.ok(result.error?.includes(`cannot be used exactly as written: ${difference}`), `${kind}: ${result.error ?? "sent"}`);
        assert.deepEqual(received, [], `${kind}: nothing reaches the gateway`);
      }
    }
  });

  test(`C14: ${name}: a host the parser would spell otherwise than written reaches nothing; a scheme and host differing only in case are used`, async () => {
    const port = new URL(gateway().base).port;
    for (const { name: kind, written, difference } of WHOLE_URL_CASES) {
      if (!written.includes("{port}")) continue;
      const harness = await make("zdr");
      harness.model.baseUrl = written.replace("{port}", port).replace("GATEWAY.TEST", "127.0.0.1");
      harness.wireUrl = `http://127.0.0.1:${port}/v1/chat/completions`;
      const before = gateway().requests.length;
      const result = await harness.request();
      const received = gateway().requests.slice(before).length;
      if (difference === null) {
        assert.ok(result.sent, `${kind}: ${result.error ?? ""}`);
        assert.equal(received, 3, kind);
      } else {
        assert.ok(result.error?.includes(`cannot be used exactly as written: ${difference}`), `${kind}: ${result.error ?? "sent"}`);
        assert.equal(received, 0, `${kind}: nothing reaches the gateway`);
      }
    }
  });

  test(`C14: ${name}: /route for a base URL that cannot be used as written, or that fetch cannot send to, reads nothing and shows no detection, as the request guard does`, async () => {
    const harness = await make("zdr");
    const origin = new URL(gateway().base).origin;
    const before = gateway().requests.length;
    harness.model.baseUrl = `${origin}/v1?tag=O'Brien`;
    await harness.command("route", "");
    const inexact = notices(harness).at(-1) ?? "";
    assert.match(inexact, /: no detection \(the base URL ".*\?tag=O'Brien" cannot be used exactly as written: its query "\?tag=O'Brien" would be sent as "\?tag=O%27Brien"/);
    assert.doesNotMatch(inexact, /detection valid|Key policy/);
    assert.match((await harness.request()).error ?? "", /cannot be used exactly as written/);
    harness.model.baseUrl = origin.replace("http://", "http://user:secret@") + "/v1";
    await harness.command("route", "");
    assert.match(notices(harness).at(-1) ?? "", /^Gateway: unknown, nothing was read \(the base URL ".*" is not an absolute URL fetch can send to \(one with credentials in it is not\)\)$/m);
    assert.equal(gateway().requests.length, before, "neither /route nor the request read anything");
  });

  test(`C3, C5: ${name}: the status line and every notice about a response name the request they are about, each its own`, async () => {
    const harness = await make("zdr");
    const escaped = gateway().base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const about = new RegExp(`\\(request for demo-model(\\+zdr)? to ${escaped}\\)$`);
    await harness.request();
    const status = harness.shown.filter((line) => line.method === "setStatus").at(-1)?.text ?? "";
    assert.match(status, /^route policy honored: served by aurora/);
    assert.match(status, about);
    // The second request goes to another place, so the notice must name this one, not the first.
    gateway().replies.inference = { status: 400, headers: { "route-refused": "reason=unsatisfiable" }, body: {} };
    harness.model.baseUrl = `${gateway().base}?t=2`;
    harness.wireUrl = `${gateway().base}/chat/completions?t=2`;
    await harness.request();
    assert.match(notices(harness).at(-1) ?? "", /^route policy refused by the gateway: unsatisfiable \(request for /);
    assert.match(notices(harness).at(-1) ?? "", new RegExp(`\\(request for demo-model(\\+zdr)? to ${escaped}\\?t=2\\)$`));
  });

  test(`C2, C14: ${name}: a policy of preferences alone is not sent to a base URL that cannot be used as written either`, async () => {
    const harness = await make("sort=price");
    harness.model.baseUrl = `${new URL(gateway().base).origin}/v1?tag=a b`;
    const before = gateway().requests.length;
    const result = await harness.request();
    assert.match(result.error ?? "", /^Blocked by the route policy plugin, nothing was sent: the base URL ".*" cannot be used exactly as written: its query "\?tag=a b" would be sent as "\?tag=a%20b"; a policy is not sent anywhere else$/);
    assert.equal(gateway().requests.length, before);
  });

  test(`C3, C15: ${name}: a response to a request the previous session sent is not shown in the next one, though what it says of the gateway still counts`, async () => {
    const harness = await make("zdr");
    gateway().replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {}, delayMs: 200 };
    const pending = harness.request();
    for (let i = 0; i < 400 && gateway().inference().length === 0; i++) await new Promise((wake) => setTimeout(wake, 5));
    await harness.emit("session_start", { type: "session_start", reason: "new" });
    const shownAtStart = harness.shown.length;
    assert.ok((await pending).sent);
    assert.deepEqual(harness.shown.slice(shownAtStart), [], "nothing about it is shown in the new session");
    const reads = gateway().requests.filter((r) => r.path.endsWith("/route-policy")).length;
    await harness.command("route", "");
    const text = notices(harness).at(-1) ?? "";
    assert.match(text, /^Last result: none yet in this session$/m);
    // Not honored, it discarded the detection reply: /route reads it again.
    assert.equal(gateway().requests.filter((r) => r.path.endsWith("/route-policy")).length, reads + 1);
  });

  test(`C3, C15: ${name}: a session started again after a result has heard of none: /route says so, and the status line is cleared`, async () => {
    const harness = await make("zdr");
    await harness.request();
    await harness.command("route", "");
    assert.match(notices(harness).at(-1) ?? "", /^Last result \(request for .*\): route policy honored/m);
    await harness.emit("session_start", { type: "session_start", reason: "resume" });
    assert.equal(harness.shown.filter((line) => line.method === "setStatus").at(-1)?.text, undefined, "the status line is cleared");
    await harness.command("route", "");
    assert.match(notices(harness).at(-1) ?? "", /^Last result: none yet in this session$/m);
  });

  test(`C1, C14: ${name}: a configured header that is not a string is not read as context, so a transport that sends it anyway is stopped`, async () => {
    const harness = await make("zdr");
    Object.assign(harness.model, { headers: { "x-tenant": 7 } });
    assert.match((await harness.request()).error ?? "", /is not one the plugin released: .*it carries authorization, x-tenant besides the usual ones/);
    assert.ok(gateway().requests.filter((r) => r.method === "GET").every((r) => r.headers["x-tenant"] === undefined), "the metadata reads did not carry it");
    assert.equal(gateway().inference().length, 0);
  });

  test(`C5, C14: ${name}: with two sessions in one process and requests in flight together, each response goes to the session that sent the request`, async () => {
    const first = await make("zdr");
    const second = await make("notrain");
    // The first session's request leaves first and comes back last, not honored; the second's is refused at once.
    gateway().replies.inference = (request) =>
      (request.headers["route-policy"] ?? request.body).includes("notrain")
        ? { status: 400, headers: { "route-refused": "reason=unsatisfiable" }, body: {}, delayMs: 20 }
        : { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {}, delayMs: 200 };
    const firstSent = first.request();
    for (let i = 0; i < 400 && gateway().inference().length === 0; i++) await new Promise((wake) => setTimeout(wake, 5));
    assert.equal(gateway().inference().length, 1, "the first request reached the gateway before the second left");
    await Promise.all([firstSent, second.request()]);
    const results = (harness: FakeHarness): string[] => notices(harness).filter((text) => /refused|honored/i.test(text));
    assert.deepEqual(results(first).map((text) => text.replace(/:.*/, "")), ["route policy NOT honored"], "the first session hears only its own not-honored result");
    assert.deepEqual(results(second).map((text) => text.replace(/ \(request for .*\)$/, "")), ["route policy refused by the gateway: unsatisfiable"], "the second session hears only its own refusal");
  });

  test(`C10: ${name}: a payload whose own toJSON names another model, or none, is blocked: what is checked is what would be sent`, async () => {
    const other = await make("zdr");
    const named = await other.request({ model: "demo-model", messages: [], toJSON: () => ({ model: "other-model", messages: [] }) });
    assert.match(named.error ?? "", /the request's model, as serialized, is not the one the policy was decided for/);
    const none = await (await make("zdr")).request({ model: "demo-model", messages: [], toJSON: () => ({ messages: [] }) });
    assert.match(none.error ?? "", /^Blocked by the route policy plugin, nothing was sent: .*(has no model in its body|does not carry every policy)/);
    assert.equal(gateway().inference().length, 0);
  });

  test(`C9: ${name}: a payload whose own toJSON drops OpenRouter's fields is blocked, not released without them`, async () => {
    gateway().replies.detection = { status: 404 };
    const harness = await make("only=aurora");
    harness.model = { id: "vendor/model", baseUrl: OPENROUTER_BASE, api: "openai-completions" };
    const payload = { model: "vendor/model", messages: [], toJSON: () => ({ model: "vendor/model", messages: [] }) };
    const result = await harness.request(payload);
    assert.match(result.error ?? "", /does not carry OpenRouter's provider\.only as translated/);
    assert.equal(gateway().inference().length, 0);
  });

  for (const broken of ["ui", "model", "modelRegistry"]) {
    test(`C1: ${name}: a context whose ${broken} accessor throws gets a blocking payload, never a rejection`, async () => {
      const harness = await make("zdr");
      const healthy = harness.ctx.bind(harness);
      harness.ctx = () => hostile(healthy(), broken);
      const result = await harness.request();
      assert.equal(result.sent, false);
      assert.match(result.error ?? "", new RegExp(`^Blocked by the route policy plugin, nothing was sent: .*(${broken} unavailable|could not prepare the headers of a request in flight)`));
      assert.deepEqual(harness.handlerErrors, [], "no handler threw or rejected");
      assert.equal(gateway().inference().length, 0);
    });
  }

  test(`C1: ${name}: an event whose payload accessor throws gets a blocking payload`, async () => {
    const harness = await make("zdr");
    const [guard] = harness.handlers.get("before_provider_request") ?? [];
    assert.ok(guard !== undefined);
    const event = Object.defineProperty({ type: "before_provider_request" }, "payload", {
      get() {
        throw new Error("payload unavailable");
      },
    });
    const returned = await guard(event, harness.ctx());
    assert.throws(() => JSON.stringify(returned), /^Error: Blocked by the route policy plugin, nothing was sent: the plugin failed: payload unavailable$/);
  });

  test(`C8, C9: ${name}: for OpenRouter the policy is translated into its provider field, the suffix removed, and the result unconfirmed`, async () => {
    gateway().replies.detection = { status: 404 };
    const harness = await make("only=aurora");
    harness.model = { id: "vendor/model+sort=price", baseUrl: OPENROUTER_BASE, api: "openai-completions" };
    assert.ok((await harness.request({ model: harness.model.id, messages: [] })).sent);
    const [request] = gateway().inference();
    assert.deepEqual(JSON.parse(request?.body ?? "{}"), { model: "vendor/model", messages: [], provider: { only: ["aurora"], sort: "price" } });
    assert.equal(request?.headers["route-policy"], undefined);
    assert.match(notices(harness).at(-1) ?? "", /unconfirmed, not applied/);
  });

  test(`C9: ${name}: a policy OpenRouter has no hard filter for is not sent there`, async () => {
    gateway().replies.detection = { status: 404 };
    const harness = await make("notrain");
    harness.model = { id: "vendor/model", baseUrl: OPENROUTER_BASE, api: "openai-completions" };
    const result = await harness.request({ model: "vendor/model", messages: [] });
    assert.match(result.error ?? "", /notrain has no hard filter there/);
    assert.equal(gateway().inference().length, 0);
  });

  test(`C9: ${name}: an API whose OpenRouter endpoint does not document the provider field is not translated`, async () => {
    gateway().replies.detection = { status: 404 };
    const harness = await make("only=aurora");
    harness.model = { id: "vendor/model", baseUrl: OPENROUTER_BASE, api: "google-generative-ai" };
    const result = await harness.request({ model: "vendor/model", contents: [] });
    assert.match(result.error ?? "", /OpenRouter documents its provider field for openai-completions, openai-responses, anthropic-messages requests, not google-generative-ai/);
    assert.equal(gateway().inference().length, 0);
    // The Chat Completions, Responses, and Messages APIs are the ones.
    harness.model = { id: "vendor/model", baseUrl: OPENROUTER_BASE, api: "anthropic-messages" };
    assert.ok((await harness.request({ model: "vendor/model", messages: [], max_tokens: 1 })).sent);
    harness.model = { id: "vendor/model", baseUrl: OPENROUTER_BASE, api: "openai-responses" };
    assert.ok((await harness.request({ model: "vendor/model", input: [] })).sent);
  });
}
