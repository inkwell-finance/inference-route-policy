// Behavior both adapters must show, run by each adapter's own test file against its own registration: the
// fail-closed boundary around every hook, and translation for OpenRouter.

import assert from "node:assert/strict";
import { test } from "node:test";
import { OPENROUTER_BASE } from "../src/openrouter.ts";
import type { FakeHarness } from "./fake-harness.ts";
import { PATH_QUERY_CASES, WHOLE_URL_CASES } from "./url-cases.ts";
import type { FakeGateway, Reply } from "./fixtures.ts";

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
    const carried = { authorization: "Bearer demo-key", "x-api-key": "demo-key-zdr", cookie: "session=east", "x-tenant-token": "t1" };
    harness.model.headers = { "x-api-key": "demo-key-zdr", Cookie: "session=east", "x-tenant-token": "t1" };
    assert.ok((await harness.request()).sent, "every one of them leaves as it was read");
    const seen = (r: { method: string; path: string; headers: Record<string, unknown> }): unknown[] => [r.method, r.path.replace(/^.*\/v1/, ""), ...Object.keys(carried).map((h) => r.headers[h])];
    assert.deepEqual(gateway().requests.map(seen), [
      ["GET", "/route-policy", ...Object.values(carried)],
      ["GET", "/models", ...Object.values(carried)],
      ["POST", "/chat/completions", ...Object.values(carried)],
    ]);
    // Each of them changed, removed, or one added on the wire after it was read: stopped, every time.
    const changes: [string, (wire: Headers) => void][] = [];
    for (const header of Object.keys(carried)) {
      changes.push([`${header} changed`, (wire) => wire.set(header, "other")]);
      changes.push([`${header} removed`, (wire) => wire.delete(header)]);
    }
    changes.push(["a cookie added", (wire) => wire.append("cookie", "who=west")]);
    changes.push(["a proxy credential added", (wire) => wire.set("proxy-authorization", "Basic eA==")]);
    for (const [change, rewrite] of changes) {
      harness.rewriteWire = rewrite;
      assert.match((await harness.request()).error ?? "", /is not one the plugin released/, change);
    }
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
    for (const api of ["google-generative-ai", "google-vertex", "google-gemini-cli", "bedrock-converse-stream"]) {
      const harness = await make(undefined);
      harness.model = { ...harness.model, id: "demo-model+zdr", api };
      const result = await harness.request({ contents: [] });
      assert.match(result.error ?? "", /does not carry every policy that was decided for it|no model field to carry the policy/, api);
    }
    assert.equal(gateway().inference().length, 0);
  });

  test(`C10: ${name}: a payload whose model is null, a number, or an empty string is blocked, never sent without its carrier`, async () => {
    for (const model of [null, 7, ""]) {
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
    // Every case that names a port of its own reaches this gateway when it may; the others are stopped before any
    // read, so they need no gateway behind them.
    for (const { name: kind, written, difference } of WHOLE_URL_CASES) {
      if (!written.includes("{port}") && difference === null) continue;
      const harness = await make("zdr");
      harness.model.baseUrl = written.replace("{port}", port).replace("GATEWAY.TEST", "LOCALHOST");
      harness.wireUrl = difference === null ? `${new URL(harness.model.baseUrl).origin}/v1/chat/completions` : `http://127.0.0.1:${port}/v1/chat/completions`;
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
    // A place used before, read and sent to: nothing about it is a stand-in for the places below.
    assert.ok((await harness.request()).sent);
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
    // omp says why; pi, whose header hook found no place, says its headers could not be prepared.
    assert.match((await harness.request()).error ?? "", /is not an absolute URL fetch can send to|could not prepare the headers of a request in flight/);
    // A read started and not awaited would still land: give one the time to.
    await new Promise((wake) => setTimeout(wake, 100));
    assert.equal(gateway().requests.length, before, "neither /route nor the request read anything, at either place or the one used before");
  });

  test(`C3, C5: ${name}: the status line and every notice about a response name the request they are about, each its own`, async () => {
    const harness = await make("zdr");
    const base = gateway().base;
    // Three requests, each to a place of its own and answered differently: everything shown for each, status
    // line and notices alike, is exactly its report followed by its own request.
    const cases: { query: string; reply: Reply; report: string; notify: boolean }[] = [
      { query: "", reply: { status: 200, headers: { "route-applied": "provider=aurora" }, body: {} }, report: "route policy honored: served by aurora; its published facts meet the policy (they are the gateway's claims, not verified by this client)", notify: false },
      { query: "?t=2", reply: { status: 400, headers: { "route-refused": "reason=unsupported+key=zdr" }, body: {} }, report: "route policy refused by the gateway: unsupported (key zdr)", notify: true },
      { query: "?t=3", reply: { status: 200, headers: { "route-applied": "provider=basalt" }, body: {} }, report: 'route policy NOT honored: provider "basalt" is not among the model\'s published routes', notify: true },
    ];
    for (const { query, reply, report, notify } of cases) {
      gateway().replies.inference = reply;
      harness.model.baseUrl = `${base}${query}`;
      harness.wireUrl = `${base}/chat/completions${query}`;
      const from = harness.shown.length;
      const sentBefore = gateway().inference().length;
      assert.ok((await harness.request()).sent, query);
      const model = (JSON.parse(gateway().inference()[sentBefore]?.body ?? "{}") as { model?: string }).model;
      const text = `${report} (request for ${model} to ${base}${query})`;
      const expected = [{ method: "setStatus", text }, ...(notify ? [{ method: "notify", text }] : [])];
      assert.deepEqual(harness.shown.slice(from), expected, query || "no query");
    }
  });

  test(`C11: ${name}: each UI channel is used on its own: a status line that throws silences no notice, a notice that throws leaves the status line set, and with both gone the request and /route are unaffected`, async () => {
    const harness = await make("zdr");
    gateway().replies.inference = { status: 400, headers: { "route-refused": "reason=unsupported+key=zdr" }, body: {} };
    const text = (model: string): string => `route policy refused by the gateway: unsupported (key zdr) (request for ${model} to ${gateway().base})`;
    const modelSent = (): string => (JSON.parse(gateway().inference().at(-1)?.body ?? "{}") as { model?: string }).model ?? "";
    harness.statusThrows = true;
    let from = harness.shown.length;
    assert.equal((await harness.request()).status, 400);
    assert.deepEqual(harness.shown.slice(from), [{ method: "notify", text: text(modelSent()) }], "the notice shows the reason and key");
    harness.statusThrows = false;
    harness.notifyThrows = true;
    from = harness.shown.length;
    assert.equal((await harness.request()).status, 400);
    assert.deepEqual(harness.shown.slice(from), [{ method: "setStatus", text: text(modelSent()) }], "the status line is set");
    harness.statusThrows = true;
    from = harness.shown.length;
    const result = await harness.request();
    assert.deepEqual([result.sent, result.status, harness.shown.slice(from), harness.handlerErrors], [true, 400, [], []]);
    harness.statusThrows = false;
    harness.notifyThrows = false;
    await harness.command("route", "");
    assert.match(notices(harness).at(-1) ?? "", new RegExp(`^Last result \\(request for .*\\): route policy refused by the gateway: unsupported \\(key zdr\\)$`, "m"));
  });

  test(`C2, C14: ${name}: a policy of preferences alone is not sent to a base URL that cannot be used as written either`, async () => {
    const harness = await make("sort=price");
    harness.model.baseUrl = `${new URL(gateway().base).origin}/v1?tag=a b`;
    const before = gateway().requests.length;
    const result = await harness.request();
    assert.match(result.error ?? "", /^Blocked by the route policy plugin, nothing was sent: the base URL ".*" cannot be used exactly as written: its query "\?tag=a b" would be sent as "\?tag=a%20b"; a policy is not sent anywhere else$/);
    // A read started and not awaited would still land: give one the time to.
    await new Promise((wake) => setTimeout(wake, 100));
    assert.equal(gateway().requests.length, before, "nothing reaches the gateway, a metadata read included");
  });

  test(`C3, C15: ${name}: a response to a request the previous session sent is not shown in the next one, though what it says of the gateway still counts`, async () => {
    const harness = await make("zdr");
    // Another place, read before: what the late response says is about its own place, not this one.
    assert.ok((await harness.request()).sent);
    const reading = (query: string): number => gateway().requests.filter((r) => r.path.endsWith(`/route-policy${query}`)).length;
    harness.model.baseUrl = `${gateway().base}?t=9`;
    harness.wireUrl = `${gateway().base}/chat/completions?t=9`;
    gateway().replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt" }, body: {}, delayMs: 200 };
    const posted = gateway().inference().length;
    const pending = harness.request();
    for (let i = 0; i < 400 && gateway().inference().length === posted; i++) await new Promise((wake) => setTimeout(wake, 5));
    await harness.emit("session_start", { type: "session_start", reason: "new" });
    const shownAtStart = harness.shown.length;
    assert.ok((await pending).sent);
    assert.deepEqual(harness.shown.slice(shownAtStart), [], "nothing about it is shown in the new session");
    const reads = [reading(""), reading("?t=9")];
    await harness.command("route", "");
    const text = notices(harness).at(-1) ?? "";
    assert.match(text, /^Last result: none yet in this session$/m);
    // Not honored, it discarded its place's detection reply: /route reads it again there, and only there.
    harness.model.baseUrl = gateway().base;
    await harness.command("route", "");
    assert.deepEqual([reading(""), reading("?t=9")], [reads[0], (reads[1] ?? 0) + 1]);
  });

  test(`C3, C15: ${name}: a session started again after a result has heard of none: /route says so, and the status line is cleared`, async () => {
    const harness = await make("zdr");
    await harness.request();
    await harness.command("route", "");
    assert.match(notices(harness).at(-1) ?? "", /^Last result \(request for .*\): route policy honored/m);
    const from = harness.shown.length;
    await harness.emit("session_start", { type: "session_start", reason: "resume" });
    assert.deepEqual(harness.shown.slice(from), [{ method: "setStatus", text: undefined }], "the status line is cleared, and nothing else shown");
    await harness.command("route", "");
    assert.match(notices(harness).at(-1) ?? "", /^Last result: none yet in this session$/m);
  });

  test(`C1, C14: ${name}: a configured header that is not a string is not read as context, so a transport that sends it anyway is stopped`, async () => {
    const harness = await make("zdr");
    Object.assign(harness.model, { headers: { "x-tenant": 7 } });
    assert.match((await harness.request()).error ?? "", /is not one the plugin released: .*it carries authorization, x-tenant besides the usual ones/);
    assert.deepEqual(
      gateway().requests.map((r) => [r.method, r.path.slice(r.path.lastIndexOf("/")), r.headers.authorization, r.headers["x-tenant"]]),
      [["GET", "/route-policy", "Bearer demo-key", undefined], ["GET", "/models", "Bearer demo-key", undefined]],
      "both metadata reads were made, without it",
    );
    assert.equal(gateway().inference().length, 0);
  });

  test(`C5, C14: ${name}: with two sessions in one process and requests in flight together, each response goes to the session that sent the request`, async () => {
    const first = await make("zdr");
    const second = await make("notrain");
    // The first session's request leaves first and comes back last, not honored; the second's is refused at once.
    gateway().replies.inference = (request) =>
      (request.headers["route-policy"] ?? request.body).includes("notrain")
        ? { status: 400, headers: { "route-refused": "reason=unsatisfiable" }, body: {}, delayMs: 20 }
        : { status: 200, headers: { "route-applied": "provider=basalt" }, body: {}, delayMs: 200 };
    const firstSent = first.request();
    for (let i = 0; i < 400 && gateway().inference().length === 0; i++) await new Promise((wake) => setTimeout(wake, 5));
    assert.equal(gateway().inference().length, 1, "the first request reached the gateway before the second left");
    const firstFrom = first.shown.length;
    const secondFrom = second.shown.length;
    const refusal = `route policy refused by the gateway: unsatisfiable (request for ${name === "omp" ? "demo-model+notrain" : "demo-model"} to ${gateway().base})`;
    // The second's refusal is back while the first is still out: it shows in the second session alone, status
    // line and /route included, before anything of the first's could cover a leak.
    await second.request();
    assert.deepEqual(first.shown.slice(firstFrom), [], "nothing of the second's shows in the first");
    assert.deepEqual(second.shown.slice(secondFrom), [{ method: "setStatus", text: refusal }, { method: "notify", text: refusal }]);
    await first.command("route", "");
    assert.match(notices(first).at(-1) ?? "", /^Last result: none yet in this session$/m);
    await firstSent;
    const notHonored = `route policy NOT honored: provider "basalt" is not among the model's published routes (request for ${name === "omp" ? "demo-model+zdr" : "demo-model"} to ${gateway().base})`;
    assert.deepEqual(first.shown.slice(firstFrom + 1), [{ method: "setStatus", text: notHonored }, { method: "notify", text: notHonored }], "the first's own result, in the first session");
    assert.deepEqual(second.shown.slice(secondFrom + 2), [], "and nothing of it in the second");
    await second.command("route", "");
    assert.match(notices(second).at(-1) ?? "", new RegExp(`^Last result \\(.*\\): route policy refused by the gateway: unsatisfiable$`, "m"));
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
    // Each translated field dropped on its own, the others kept as translated.
    for (const field of ["only", "ignore", "sort", "order"]) {
      const harness = await make("only=aurora,cobalt+ignore=basalt+sort=price+order=cobalt");
      harness.model = { id: "vendor/model", baseUrl: OPENROUTER_BASE, api: "openai-completions" };
      const payload = {
        model: "vendor/model",
        messages: [],
        toJSON(this: Record<string, unknown>): unknown {
          const { toJSON: _own, provider, ...rest } = this;
          const kept = typeof provider === "object" && provider !== null ? Object.fromEntries(Object.entries(provider).filter(([key]) => key !== field)) : {};
          return { ...rest, provider: kept };
        },
      };
      const result = await harness.request(payload);
      assert.match(result.error ?? "", new RegExp(`does not carry OpenRouter's provider\\.${field} as translated`), field);
    }
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
    // A response that names a route and evidence as if it had applied a policy: still unconfirmed, and only that.
    gateway().replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt", "route-evidence": "https://basalt.example/attestation" }, body: {} };
    const from = harness.shown.length;
    assert.ok((await harness.request({ model: harness.model.id, messages: [] })).sent);
    const [request] = gateway().inference();
    assert.deepEqual(JSON.parse(request?.body ?? "{}"), { model: "vendor/model", messages: [], provider: { only: ["aurora"], sort: "price" } });
    assert.equal(request?.headers["route-policy"], undefined);
    const text = `route policy translated into the gateway's own fields; the result is unconfirmed, not applied (request for vendor/model to ${OPENROUTER_BASE})`;
    assert.deepEqual(harness.shown.slice(from), [{ method: "setStatus", text }, { method: "notify", text }]);
  });

  test(`C9: ${name}: a policy OpenRouter has no hard filter for is not sent there`, async () => {
    gateway().replies.detection = { status: 404 };
    // Each requirement OpenRouter has no hard filter for, each for its own reason.
    for (const [policy, why] of [["zdr", /zdr has no hard filter there/], ["notrain", /notrain has no hard filter there/], ["bits=8", /bits has no hard filter there/], ["region=us", /region has no request field there/], ["attest=weights", /attest has no counterpart there/]] as const) {
      const harness = await make(policy);
      harness.model = { id: "vendor/model", baseUrl: OPENROUTER_BASE, api: "openai-completions" };
      const result = await harness.request({ model: "vendor/model", messages: [] });
      assert.match(result.error ?? "", why, policy);
    }
    assert.equal(gateway().inference().length, 0);
  });

  test(`C9: ${name}: an API whose OpenRouter endpoint does not document the provider field is not translated`, async () => {
    gateway().replies.detection = { status: 404 };
    const harness = await make("only=aurora");
    harness.model = { id: "vendor/model", baseUrl: OPENROUTER_BASE, api: "google-generative-ai" };
    const result = await harness.request({ model: "vendor/model", contents: [] });
    assert.match(result.error ?? "", /OpenRouter documents its provider field for openai-completions, openai-responses, anthropic-messages requests, not google-generative-ai/);
    // Every other API too, an unnamed one included.
    for (const api of ["google-vertex", "bedrock-converse-stream", "mistral-conversations", "azure-openai-responses"]) {
      harness.model = { id: "vendor/model", baseUrl: OPENROUTER_BASE, api };
      assert.match((await harness.request({ model: "vendor/model", messages: [] })).error ?? "", new RegExp(`requests, not ${api}$`), api);
    }
    harness.contextModel = { id: "vendor/model", baseUrl: OPENROUTER_BASE };
    assert.match((await harness.request({ model: "vendor/model", messages: [] })).error ?? "", /requests, not an unnamed API$/);
    harness.contextModel = undefined;
    assert.equal(gateway().inference().length, 0);
    // The Chat Completions, Responses, and Messages APIs are the ones.
    harness.model = { id: "vendor/model", baseUrl: OPENROUTER_BASE, api: "anthropic-messages" };
    assert.ok((await harness.request({ model: "vendor/model", messages: [], max_tokens: 1 })).sent);
    harness.model = { id: "vendor/model", baseUrl: OPENROUTER_BASE, api: "openai-responses" };
    assert.ok((await harness.request({ model: "vendor/model", input: [] })).sent);
  });
}
