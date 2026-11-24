// Behavior both adapters must show, run by each adapter's own test file against its own registration. Each test
// is one request (or command) in one situation and one thing observed of it, compared whole.

import assert from "node:assert/strict";
import { test } from "node:test";
import { OPENROUTER_BASE } from "../src/openrouter.ts";
import { MODEL_IN_URL_APIS } from "../src/plugin.ts";
import { FakeHarness, type Shown } from "./fake-harness.ts";
import type { FakeGateway, Reply } from "./fixtures.ts";
import { PATH_QUERY_CASES, WHOLE_URL_CASES } from "./url-cases.ts";

const notices = (harness: FakeHarness): string[] => harness.shown.filter((s) => s.method === "notify").map((s) => s.text ?? "");
const BLOCKED = "Blocked by the route policy plugin, nothing was sent: ";
const NOT_RELEASED = (base: string, names: string): string =>
  `${BLOCKED}this request to ${base} is not one the plugin released: its URL, headers (it carries ${names} besides the usual ones), body, or Route-Policy header differs from what was checked, or it was already sent once`;

/** `ctx` with one accessor replaced by a getter that throws. */
function hostile(ctx: unknown, broken: string): object {
  assert.ok(typeof ctx === "object" && ctx !== null);
  return Object.defineProperty({ ...ctx }, broken, {
    get() {
      throw new Error(`${broken} unavailable`);
    },
  });
}

/** What `run` shows: the UI entries it adds, in order. */
async function shownBy(harness: FakeHarness, run: () => Promise<unknown>): Promise<Shown[]> {
  const from = harness.shown.length;
  await run();
  return harness.shown.slice(from);
}

/** Waits until `done` holds, for at most two seconds: a condition on the real gateway, not a guessed delay. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((wake) => setTimeout(wake, 5));
  assert.ok(done(), "timed out waiting");
}

/** Lets a read started without being awaited land, so a test can see that none was. */
const settle = (): Promise<void> => new Promise((wake) => setTimeout(wake, 100));

/**
 * The URL of every fetch attempted while `run` runs and just after, wherever it was going: the plugin reads
 * through the global fetch at the time of each call, so a read to a host no fixture serves is seen too.
 */
async function fetchesDuring(run: () => Promise<unknown>): Promise<string[]> {
  const current = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    urls.push(input instanceof Request ? input.url : String(input));
    return current(input, init);
  }, current);
  try {
    await run();
    await settle();
  } finally {
    globalThis.fetch = current;
  }
  return urls;
}

export function adapterContract(name: string, make: (policy?: string) => Promise<FakeHarness>, gateway: () => FakeGateway): void {
  /** The model the plugin sends demo-model with under held zdr: omp puts the policy in the suffix, pi in a header. */
  const zdrModel = name === "omp" ? "demo-model+zdr" : "demo-model";

  // ---- C1, C14: the key and the context.
  test(`C1, C14: ${name}: a request with held zdr whose transport sends Bearer demo-key-zdr where the registry reported demo-key is stopped at fetch`, async () => {
    const harness = await make("zdr");
    harness.wireKey = "demo-key-zdr";
    const result = await harness.request();
    assert.deepEqual([result, gateway().inference()], [{ sent: false, error: NOT_RELEASED(gateway().base, "authorization"), status: null }, []]);
  });

  test(`C1, C14: ${name}: a request with held zdr whose transport sends Bearer demo-key-zdr where the registry reported demo-key is shown as blocked`, async () => {
    const harness = await make("zdr");
    harness.wireKey = "demo-key-zdr";
    const reason = NOT_RELEASED(gateway().base, "authorization").slice(BLOCKED.length);
    const text = `request blocked by the route policy plugin, nothing was sent: ${reason}`;
    assert.deepEqual(await shownBy(harness, () => harness.request()), [{ method: "setStatus", text }, { method: "notify", text }]);
  });

  test(`C14: ${name}: a request with held zdr whose transport sends Bearer demo-key-zdr where the registry reported demo-key makes the gateway requests [GET, GET], each with authorization "Bearer demo-key"`, async () => {
    const harness = await make("zdr");
    harness.wireKey = "demo-key-zdr";
    await harness.request();
    assert.deepEqual(gateway().requests.map((r) => [r.method, r.headers.authorization]), [["GET", "Bearer demo-key"], ["GET", "Bearer demo-key"]]);
  });

  test(`C14: ${name}: with a configured Authorization Bearer demo-key-zdr, a request with held zdr makes the gateway requests [GET, GET, POST], each with authorization "Bearer demo-key-zdr"`, async () => {
    const harness = await make("zdr");
    harness.model.headers = { Authorization: "Bearer demo-key-zdr" };
    harness.wireKey = "demo-key-zdr";
    assert.ok((await harness.request()).sent);
    assert.deepEqual(gateway().requests.map((r) => [r.method, r.headers.authorization]), [["GET", "Bearer demo-key-zdr"], ["GET", "Bearer demo-key-zdr"], ["POST", "Bearer demo-key-zdr"]]);
  });

  const CARRIED = { authorization: "Bearer demo-key", "x-api-key": "demo-key-zdr", cookie: "session=east", "x-tenant-token": "t1", "x-team-token": "tm" };
  const configureCarried = (harness: FakeHarness): void => {
    harness.model.headers = { "x-api-key": "demo-key-zdr", Cookie: "session=east", "x-tenant-token": "t1", "x-team-token": "tm" };
  };
  test(`C1, C14: ${name}: a request with held zdr and configured x-api-key, cookie, x-tenant-token and x-team-token makes the gateway requests [GET, GET, POST], each with the headers ${JSON.stringify(CARRIED)}`, async () => {
    const harness = await make("zdr");
    configureCarried(harness);
    assert.ok((await harness.request()).sent);
    const seen = gateway().requests.map((r) => [r.method, ...Object.keys(CARRIED).map((h) => r.headers[h])]);
    assert.deepEqual(seen, ["GET", "GET", "POST"].map((m) => [m, ...Object.values(CARRIED)]));
  });

  for (const [change, rewrite] of [
    ...Object.keys(CARRIED).flatMap((header): [string, (w: Headers) => void][] => [
      [`${header} changed to "other"`, (w) => w.set(header, "other")],
      [`${header} removed`, (w) => w.delete(header)],
    ]),
    ["a cookie who=west appended", (w: Headers) => w.append("cookie", "who=west")],
    ["proxy-authorization added", (w: Headers) => w.set("proxy-authorization", "Basic eA==")],
    ["x-goog-api-key added", (w: Headers) => w.set("x-goog-api-key", "demo-key")],
  ] as const) {
    test(`C1, C14: ${name}: a request read with configured x-api-key, cookie, x-tenant-token and x-team-token, leaving with ${change}, is stopped at fetch`, async () => {
      const harness = await make("zdr");
      configureCarried(harness);
      harness.rewriteWire = rewrite;
      const result = await harness.request();
      assert.deepEqual([result.sent, result.error?.startsWith(`${BLOCKED}this request to ${gateway().base} is not one the plugin released`), gateway().inference()], [false, true, []]);
    });
  }

  // ---- C1, C6: credentials.
  const KEYED = { status: 200, body: { route_policy: "1", key_policy: "zdr" } };
  test(`C1, C6: ${name}: a request with held zdr, no key, and only a traceparent header, whose detection reply carries key_policy zdr, is blocked: no credentials were sent`, async () => {
    gateway().replies.detection = KEYED;
    const harness = await make("zdr");
    harness.resolveAuth = async () => ({ ok: true });
    harness.wireKey = null;
    harness.model.headers = { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" };
    const result = await harness.request();
    assert.deepEqual([result.sent, result.error, gateway().inference()], [false, `${BLOCKED}${gateway().base} has no valid detection reply (detection reply is not valid: key_policy is present in a reply to a request without credentials), so no requirement may be sent there`, []]);
  });

  test(`C1, C6: ${name}: a request with held zdr, no key, and only an api-key header, whose detection reply carries key_policy zdr, makes the gateway requests [GET, GET, POST], each with api-key "demo-key"`, async () => {
    gateway().replies.detection = KEYED;
    const harness = await make("zdr");
    harness.resolveAuth = async () => ({ ok: true });
    harness.wireKey = null;
    harness.model.headers = { "api-key": "demo-key" };
    assert.ok((await harness.request()).sent);
    assert.deepEqual(gateway().requests.map((r) => [r.method, r.headers["api-key"]]), [["GET", "demo-key"], ["GET", "demo-key"], ["POST", "demo-key"]]);
  });

  // ---- C10: models and carriers.
  test(`C10: ${name}: a payload {input} with no model, to openai-responses, with held zdr and typed +zdr+only=aurora, is blocked: it has no model`, async () => {
    const harness = await make("zdr");
    harness.model = { ...harness.model, id: "demo-model+zdr+only=aurora", api: "openai-responses" };
    const result = await harness.request({ input: "fixture" });
    assert.deepEqual([result.error, gateway().inference()], [`${BLOCKED}the request has no model in its body, which the openai-responses API needs to carry the model and its suffix`, []]);
  });

  for (const [held, typed] of [[undefined, "+zdr"], ["sort=price", "+zdr"]] as const) {
    test(`C10: ${name}: for each of the ${MODEL_IN_URL_APIS.length} APIs in MODEL_IN_URL_APIS, a body {contents} for typed ${typed}${held === undefined ? "" : ` with held ${held}`} is blocked: the suffix has no carrier`, async () => {
      assert.ok(MODEL_IN_URL_APIS.length > 0);
      for (const api of MODEL_IN_URL_APIS) {
        const harness = await make(held);
        harness.model = { ...harness.model, id: `demo-model${typed}`, api };
        const result = await harness.request({ contents: [] });
        assert.equal(result.sent, false, api);
        assert.ok(result.error === `${BLOCKED}the request has no model field to carry the policy` || result.error === `${BLOCKED}the request, as serialized, does not carry every policy that was decided for it (a typed suffix can travel only in a body's model)`, `${api}: ${result.error}`);
      }
      assert.deepEqual(gateway().inference(), []);
    });
  }

  for (const [label, model] of [["null", null], ["7", 7], ['""', ""]] as const) {
    test(`C10: ${name}: a payload whose model is ${label}, with held zdr, is blocked`, async () => {
      const harness = await make("zdr");
      const result = await harness.request({ model, messages: [] });
      assert.deepEqual([result.sent, result.error?.startsWith(BLOCKED), gateway().inference()], [false, true, []]);
    });
  }

  test(`C10: ${name}: a payload whose toJSON names other-model, with held zdr, is blocked: as serialized its model is not the one decided`, async () => {
    const harness = await make("zdr");
    const result = await harness.request({ model: "demo-model", messages: [], toJSON: () => ({ model: "other-model", messages: [] }) });
    assert.deepEqual([result.error, gateway().inference()], [`${BLOCKED}the request's model, as serialized, is not the one the policy was decided for`, []]);
  });

  test(`C10: ${name}: a payload whose toJSON drops the model, with held zdr, is blocked`, async () => {
    const harness = await make("zdr");
    const result = await harness.request({ model: "demo-model", messages: [], toJSON: () => ({ messages: [] }) });
    assert.deepEqual([result.sent, result.error?.startsWith(BLOCKED), gateway().inference()], [false, true, []]);
  });

  // ---- C1, C14: where the request goes.
  test(`C1, C14: ${name}: a request with held zdr to the base URL with an empty query "?" makes the gateway requests ["GET /v1/route-policy?", "GET /v1/models?", "POST /v1/chat/completions?"]`, async () => {
    const harness = await make("zdr");
    const base = harness.model.baseUrl;
    harness.model.baseUrl = `${base}?`;
    harness.wireUrl = `${base}/chat/completions?`;
    assert.ok((await harness.request()).sent);
    assert.deepEqual(gateway().requests.map((r) => `${r.method} ${r.path}`), ["GET /v1/route-policy?", "GET /v1/models?", "POST /v1/chat/completions?"]);
  });

  test(`C1, C14: ${name}: a request with held zdr read for the base URL with "?" and sent without it is stopped at fetch`, async () => {
    const harness = await make("zdr");
    const base = harness.model.baseUrl;
    harness.model.baseUrl = `${base}?`;
    harness.wireUrl = `${base}/chat/completions`;
    const result = await harness.request();
    assert.deepEqual([result.sent, result.error?.includes("is not one the plugin released"), gateway().inference()], [false, true, []]);
  });

  for (const { path, query, sentPath, sentQuery, difference } of PATH_QUERY_CASES) {
    const written = `${path}${query}`;
    if (difference === null) {
      test(`C14: ${name}: a request with held zdr to base path ${JSON.stringify(written)} makes the gateway requests ${JSON.stringify([`GET ${sentPath}/route-policy${sentQuery}`, `GET ${sentPath}/models${sentQuery}`, `POST ${sentPath}/chat/completions${sentQuery}`])}`, async () => {
        const harness = await make("zdr");
        const origin = new URL(gateway().base).origin;
        harness.model.baseUrl = `${origin}${written}`;
        harness.wireUrl = `${origin}${sentPath}/chat/completions${sentQuery}`;
        assert.ok((await harness.request()).sent);
        assert.deepEqual(gateway().requests.map((r) => `${r.method} ${r.path}`), [`GET ${sentPath}/route-policy${sentQuery}`, `GET ${sentPath}/models${sentQuery}`, `POST ${sentPath}/chat/completions${sentQuery}`]);
      });
    } else {
      const atPath = async (): Promise<FakeHarness> => {
        const harness = await make("zdr");
        const origin = new URL(gateway().base).origin;
        harness.model.baseUrl = `${origin}${written}`;
        harness.wireUrl = `${origin}${sentPath}/chat/completions${sentQuery}`;
        return harness;
      };
      test(`C14: ${name}: a request with held zdr to base path ${JSON.stringify(written)} is blocked: ${difference}`, async () => {
        const harness = await atPath();
        const result = await harness.request();
        assert.deepEqual([result.error, gateway().inference()], [`${BLOCKED}the base URL ${JSON.stringify(harness.model.baseUrl)} cannot be used exactly as written: ${difference}; a policy is not sent anywhere else`, []]);
      });
      test(`C14: ${name}: a request with held zdr to base path ${JSON.stringify(written)} attempts no fetch`, async () => {
        const harness = await atPath();
        assert.deepEqual(await fetchesDuring(() => harness.request()), []);
      });
    }
  }

  for (const { written: template, difference } of WHOLE_URL_CASES) {
    if (difference === null && !template.includes("{port}")) continue;
    const atUrl = async (): Promise<FakeHarness> => {
      const harness = await make("zdr");
      harness.model.baseUrl = template.replace("{port}", new URL(gateway().base).port).replace("GATEWAY.TEST", "LOCALHOST");
      harness.wireUrl = difference === null ? `${new URL(harness.model.baseUrl).origin}/v1/chat/completions` : `${gateway().base}/chat/completions`;
      return harness;
    };
    if (difference === null) {
      test(`C14: ${name}: a request with held zdr to ${JSON.stringify(template)} makes the gateway requests ["GET /v1/route-policy", "GET /v1/models", "POST /v1/chat/completions"]`, async () => {
        await (await atUrl()).request();
        assert.deepEqual(gateway().requests.map((r) => `${r.method} ${r.path}`), ["GET /v1/route-policy", "GET /v1/models", "POST /v1/chat/completions"]);
      });
      continue;
    }
    test(`C14: ${name}: a request with held zdr to ${JSON.stringify(template)} is blocked: ${difference}`, async () => {
      const harness = await atUrl();
      const result = await harness.request();
      assert.deepEqual([result.error, gateway().inference()], [`${BLOCKED}the base URL ${JSON.stringify(harness.model.baseUrl)} cannot be used exactly as written: ${difference}; a policy is not sent anywhere else`, []]);
    });
    test(`C14: ${name}: a request with held zdr to ${JSON.stringify(template)} attempts no fetch`, async () => {
      const harness = await atUrl();
      assert.deepEqual(await fetchesDuring(() => harness.request()), []);
    });
  }

  for (const [label, written, what] of [
    ["a query space", "/v1?tag=a b", `its query ${JSON.stringify("?tag=a b")} would be sent as ${JSON.stringify("?tag=a%20b")}`],
    ["a path space", "/v 1", `its path ${JSON.stringify("/v 1")} would be sent as ${JSON.stringify("/v%201")}`],
  ] as const) {
    test(`C2, C14: ${name}: a request with held sort=price to a base with ${label} is blocked: ${what}`, async () => {
      const harness = await make("sort=price");
      harness.model.baseUrl = `${new URL(gateway().base).origin}${written}`;
      const result = await harness.request();
      assert.deepEqual([result.error, gateway().inference()], [`${BLOCKED}the base URL ${JSON.stringify(harness.model.baseUrl)} cannot be used exactly as written: ${what}; a policy is not sent anywhere else`, []]);
    });
    test(`C2, C14: ${name}: a request with held sort=price to a base with ${label} attempts no fetch`, async () => {
      const harness = await make("sort=price");
      harness.model.baseUrl = `${new URL(gateway().base).origin}${written}`;
      assert.deepEqual(await fetchesDuring(() => harness.request()), []);
    });
  }

  // ---- /route and places not usable as written.
  // Each line is written for the gateway's origin and the base URL as written, so a title can show it with placeholders.
  const INEXACT_ROUTE = [
    ["base /v1?tag=O'Brien", (origin: string): string => `${origin}/v1?tag=O'Brien`, (origin: string, written: string): string => `Gateway ${origin}/v1?tag=O%27Brien, read with the credential in authorization: no detection (the base URL ${written} cannot be used exactly as written: its query "?tag=O'Brien" would be sent as "?tag=O%27Brien"; a policy is not sent anywhere else)`],
    ["a base with credentials in it", (origin: string): string => origin.replace("http://", "http://user:secret@") + "/v1", (_origin: string, written: string): string => `Gateway: unknown, nothing was read (the base URL ${written} is not an absolute URL fetch can send to (one with credentials in it is not))`],
  ] as const;
  const origin = (): string => new URL(gateway().base).origin;
  for (const [label, baseUrl, line] of INEXACT_ROUTE) {
    test(`C14: ${name}: /route at ${label}, after a request to /v1 was sent, attempts no fetch`, async () => {
      const harness = await make("zdr");
      assert.ok((await harness.request()).sent);
      harness.model.baseUrl = baseUrl(origin());
      assert.deepEqual(await fetchesDuring(() => harness.command("route", "")), []);
    });
    test(`C14: ${name}: /route at ${label}, after a request to /v1 was sent, shows as its gateway line "${line("{origin}", '"{written}"')}"`, async () => {
      const harness = await make("zdr");
      assert.ok((await harness.request()).sent);
      harness.model.baseUrl = baseUrl(origin());
      await harness.command("route", "");
      assert.equal((notices(harness).at(-1) ?? "").split("\n")[1], line(origin(), JSON.stringify(harness.model.baseUrl)));
    });
  }

  const CREDENTIALED_BASE = (): string => gateway().base.replace("http://", "http://user:secret@");
  // pi's header hook finds no place first and leaves the request unprepared, so its payload is blocked for that.
  const noPlaceWhy = (written: string): string =>
    name === "pi" ? "the plugin could not prepare the headers of a request in flight, so which policy this one carries is unknowable" : `the base URL ${JSON.stringify(written)} is not an absolute URL fetch can send to (one with credentials in it is not)`;
  test(`C14: ${name}: a request with held zdr at a base with credentials in it, after a request to /v1 was sent, is blocked: "${noPlaceWhy("{base}")}"`, async () => {
    const harness = await make("zdr");
    assert.ok((await harness.request()).sent);
    const posts = gateway().inference().length;
    harness.model.baseUrl = CREDENTIALED_BASE();
    const result = await harness.request();
    assert.deepEqual([result.error, gateway().inference().length - posts], [`${BLOCKED}${noPlaceWhy(harness.model.baseUrl)}`, 0]);
  });
  test(`C14: ${name}: a request with held zdr at a base with credentials in it, after a request to /v1 was sent, attempts no fetch`, async () => {
    const harness = await make("zdr");
    assert.ok((await harness.request()).sent);
    harness.model.baseUrl = CREDENTIALED_BASE();
    assert.deepEqual(await fetchesDuring(() => harness.request()), []);
  });

  // ---- C3, C5: what is shown for a response.
  const MODEL_LIST = (): Reply => ({ status: 200, body: { data: ["demo-model", "other-model"].map((id) => ({ id, routes: [{ provider: "aurora", facts: "zdr+notrain+bits=8" }] })) } });
  for (const [label, path, model, reply, report, notify] of [
    ["an honored response for demo-model at /v1", "/v1", "demo-model", { status: 200, headers: { "route-applied": "provider=aurora" }, body: {} }, "route policy honored: served by aurora; its published facts meet the policy (they are the gateway's claims, not verified by this client)", false],
    ["a refusal for other-model at /v1?t=2", "/v1?t=2", "other-model", { status: 400, headers: { "route-refused": "reason=unsupported+key=zdr" }, body: {} }, "route policy refused by the gateway: unsupported (key zdr)", true],
    ["a not-honored response for demo-model at /v2", "/v2", "demo-model", { status: 200, headers: { "route-applied": "provider=basalt" }, body: {} }, 'route policy NOT honored: provider "basalt" is not among the model\'s published routes', true],
  ] as const) {
    test(`C3, C5: ${name}: ${label}, with held zdr, is shown ${notify ? "on the status line and as a notice" : "on the status line"}, naming that model and place`, async () => {
      gateway().replies.models = MODEL_LIST();
      const harness = await make("zdr");
      const origin = new URL(gateway().base).origin;
      const [basePath, query = ""] = path.split("?");
      const q = query === "" ? "" : `?${query}`;
      harness.model.id = model;
      harness.model.baseUrl = `${origin}${basePath}${q}`;
      harness.wireUrl = `${origin}${basePath}/chat/completions${q}`;
      gateway().replies.inference = reply as Reply;
      const shown = await shownBy(harness, () => harness.request({ model, messages: [] }));
      const sentModel = (JSON.parse(gateway().inference()[0]?.body ?? "{}") as { model?: string }).model;
      const text = `${report} (request for ${sentModel} to ${origin}${basePath}${q})`;
      assert.deepEqual(shown, [{ method: "setStatus", text }, ...(notify ? [{ method: "notify", text }] : [])]);
    });
  }

  // ---- C11: UI channels.
  const REFUSAL = { status: 400, headers: { "route-refused": "reason=unsupported+key=zdr" }, body: {} };
  const refusalText = (): string => `route policy refused by the gateway: unsupported (key zdr) (request for ${zdrModel} to ${gateway().base})`;
  test(`C11: ${name}: while setStatus throws, a refusal is shown as a notice`, async () => {
    const harness = await make("zdr");
    gateway().replies.inference = REFUSAL;
    harness.statusThrows = true;
    assert.deepEqual(await shownBy(harness, () => harness.request()), [{ method: "notify", text: refusalText() }]);
  });

  test(`C11: ${name}: while notify throws, a refusal is shown on the status line`, async () => {
    const harness = await make("zdr");
    gateway().replies.inference = REFUSAL;
    harness.notifyThrows = true;
    assert.deepEqual(await shownBy(harness, () => harness.request()), [{ method: "setStatus", text: refusalText() }]);
  });

  test(`C11: ${name}: while setStatus and notify both throw, a refused request is answered 400`, async () => {
    const harness = await make("zdr");
    gateway().replies.inference = REFUSAL;
    harness.statusThrows = true;
    harness.notifyThrows = true;
    assert.deepEqual(await harness.request(), { sent: true, error: null, status: 400 });
  });

  test(`C11: ${name}: while setStatus and notify both throw, a request for demo-model+zdr=1, blocked, leaves no handler error`, async () => {
    const harness = await make("zdr");
    harness.statusThrows = true;
    harness.notifyThrows = true;
    harness.model.id = "demo-model+zdr=1";
    await harness.request({ model: "demo-model+zdr=1", messages: [] });
    assert.deepEqual(harness.handlerErrors, []);
  });

  test(`C11: ${name}: while setStatus and notify both throw, /route at an unread ?t=7 makes the gateway requests ["GET /v1/route-policy?t=7"]`, async () => {
    const harness = await make("zdr");
    harness.statusThrows = true;
    harness.notifyThrows = true;
    harness.model.baseUrl = `${gateway().base}?t=7`;
    await assert.doesNotReject(harness.command("route", ""));
    assert.deepEqual(gateway().requests.map((r) => `${r.method} ${r.path}`), ["GET /v1/route-policy?t=7"]);
  });

  test(`C11: ${name}: a refusal received while setStatus and notify both throw, after an honored result, is the last result /route shows once they work`, async () => {
    const harness = await make("zdr");
    await harness.request();
    harness.statusThrows = true;
    harness.notifyThrows = true;
    gateway().replies.inference = REFUSAL;
    await harness.request();
    harness.statusThrows = false;
    harness.notifyThrows = false;
    await harness.command("route", "");
    assert.equal((notices(harness).at(-1) ?? "").split("\n").at(-1), `Last result (request for ${zdrModel} to ${gateway().base}): route policy refused by the gateway: unsupported (key zdr)`);
  });

  const SHAPES = [
    ["both callbacks", { notify: true, setStatus: true }],
    ["notify only", { notify: true, setStatus: false }],
    ["setStatus only", { notify: false, setStatus: true }],
  ] as const;
  const shaped = async (offers: { notify: boolean; setStatus: boolean }): Promise<FakeHarness> => {
    // Offered so from the session's first event on, as a harness would.
    FakeHarness.uiOffersFromStart = offers;
    try {
      return await make("zdr");
    } finally {
      FakeHarness.uiOffersFromStart = { notify: true, setStatus: true };
    }
  };
  const both = (offers: { notify: boolean; setStatus: boolean }, text: string): Shown[] => [
    ...(offers.setStatus ? [{ method: "setStatus" as const, text }] : []),
    ...(offers.notify ? [{ method: "notify" as const, text }] : []),
  ];
  for (const [label, offers] of SHAPES) {
    test(`C11: ${name}: with ${label} offered, a refused request is shown exactly through what is offered`, async () => {
      const harness = await shaped(offers);
      gateway().replies.inference = REFUSAL;
      assert.deepEqual(await shownBy(harness, () => harness.request()), both(offers, refusalText()));
    });
    test(`C11: ${name}: with ${label} offered, a request for demo-model+zdr=1 is shown as blocked exactly through what is offered`, async () => {
      const harness = await shaped(offers);
      harness.model.id = "demo-model+zdr=1";
      const text = 'request blocked by the route policy plugin, nothing was sent: the model id "demo-model+zdr=1" carries a suffix that is not a valid policy: takes no value';
      assert.deepEqual(await shownBy(harness, () => harness.request({ model: "demo-model+zdr=1", messages: [] })), both(offers, text));
    });
    test(`C11: ${name}: with ${label} offered, /route ${offers.notify ? "is shown as a notice" : "shows nothing"}`, async () => {
      const harness = await shaped(offers);
      const shown = await shownBy(harness, () => harness.command("route", ""));
      const text = [
        "Route policy: zdr (set in this session)",
        `Gateway ${gateway().base}, read with the credential in authorization: detection valid; accepts zdr, notrain, bits, region, attest, only, ignore, sort, order`,
        "Key policy: none",
        "Last result: none yet in this session",
      ].join("\n");
      assert.deepEqual(shown, offers.notify ? [{ method: "notify", text }] : []);
    });
  }

  // ---- C3, C15: sessions.
  for (const [label, reply, discards] of [
    ["honored", { status: 200, headers: { "route-applied": "provider=aurora" }, body: {}, delayMs: 200 }, false],
    ["refused", { status: 400, headers: { "route-refused": "reason=unsatisfiable" }, body: {}, delayMs: 200 }, false],
    ["not honored", { status: 200, headers: { "route-applied": "provider=basalt" }, body: {}, delayMs: 200 }, true],
  ] as const) {
    test(`C3, C15: ${name}: a ${label} response to a request sent before session_start is shown nowhere in the new session`, async () => {
      const harness = await make("zdr");
      gateway().replies.inference = reply as Reply;
      const pending = harness.request();
      await until(() => gateway().inference().length === 1);
      await harness.emit("session_start", { type: "session_start", reason: "new" });
      const from = harness.shown.length;
      await pending;
      await harness.command("route", "");
      const shown = harness.shown.slice(from);
      assert.deepEqual([shown.length, (shown[0]?.text ?? "").split("\n").at(-1)], [1, "Last result: none yet in this session"]);
    });
    if (discards) {
      test(`C3, C15: ${name}: a ${label} response at ?t=9 to a request sent before session_start discards ?t=9's detection reply and no other`, async () => {
        const harness = await make("zdr");
        assert.ok((await harness.request()).sent);
        harness.model.baseUrl = `${gateway().base}?t=9`;
        harness.wireUrl = `${gateway().base}/chat/completions?t=9`;
        gateway().replies.inference = reply as Reply;
        const posted = gateway().inference().length;
        const pending = harness.request();
        await until(() => gateway().inference().length === posted + 1);
        await harness.emit("session_start", { type: "session_start", reason: "new" });
        await pending;
        const reads = (q: string): number => gateway().requests.filter((r) => r.path.endsWith(`/route-policy${q}`)).length;
        const before = [reads(""), reads("?t=9")];
        await harness.command("route", "");
        harness.model.baseUrl = gateway().base;
        await harness.command("route", "");
        assert.deepEqual([reads(""), reads("?t=9")], [before[0], (before[1] ?? 0) + 1]);
      });
    }
  }

  for (const [label, reply] of [
    ["an honored", { status: 200, headers: { "route-applied": "provider=aurora" }, body: {} }],
    ["a refused", { status: 400, headers: { "route-refused": "reason=unsatisfiable" }, body: {} }],
    ["a not-honored", { status: 200, headers: { "route-applied": "provider=basalt" }, body: {} }],
  ] as const) {
    test(`C3, C15: ${name}: session_start after ${label} result makes one UI call, setStatus with no text`, async () => {
      const harness = await make("zdr");
      gateway().replies.inference = reply;
      await harness.request();
      assert.deepEqual(await shownBy(harness, () => harness.emit("session_start", { type: "session_start", reason: "resume" })), [{ method: "setStatus", text: undefined }]);
    });
    test(`C3, C15: ${name}: /route after session_start following ${label} result shows no last result`, async () => {
      const harness = await make("zdr");
      gateway().replies.inference = reply;
      await harness.request();
      await harness.emit("session_start", { type: "session_start", reason: "resume" });
      await harness.command("route", "");
      assert.equal((notices(harness).at(-1) ?? "").split("\n").at(-1), "Last result: none yet in this session");
    });
  }

  // ---- C1, C14: configured headers that are not strings.
  for (const [label, value, wireValue] of [
    ["the number 7", 7, "7"],
    ["true", true, "true"],
    ['["a", "b"]', ["a", "b"], "a,b"],
    ["{}", {}, "[object Object]"],
  ] as const) {
    test(`C1, C14: ${name}: with a configured x-tenant of ${label}, the gateway reads [GET, GET] carry no x-tenant`, async () => {
      const harness = await make("zdr");
      Object.assign(harness.model, { headers: { "x-tenant": value } });
      harness.rewriteWire = (w) => w.set("x-tenant", wireValue);
      await harness.request();
      assert.deepEqual(gateway().requests.map((r) => [r.method, r.headers["x-tenant"]]), [["GET", undefined], ["GET", undefined]]);
    });
    test(`C1, C14: ${name}: a request with a configured x-tenant of ${label}, sent anyway by the transport as "${wireValue}", is stopped at fetch`, async () => {
      const harness = await make("zdr");
      Object.assign(harness.model, { headers: { "x-tenant": value } });
      harness.rewriteWire = (w) => w.set("x-tenant", wireValue);
      const result = await harness.request();
      assert.deepEqual([result.error, gateway().inference()], [NOT_RELEASED(gateway().base, "authorization, x-tenant"), []]);
    });
  }

  // ---- C5, C14: two sessions.
  type Answer = { label: string; reply: Reply; report: string; quiet: boolean };
  const answer = (label: string, headers: Record<string, string>, status: number, delayMs: number, report: string, quiet: boolean): Answer => ({ label, reply: { status, headers, body: {}, delayMs }, report, quiet });
  const HONORED_TEXT = "route policy honored: served by aurora; its published facts meet the policy (they are the gateway's claims, not verified by this client)";
  for (const [first, second] of [
    [
      answer("not honored after 200 ms", { "route-applied": "provider=basalt" }, 200, 200, 'route policy NOT honored: provider "basalt" is not among the model\'s published routes', false),
      answer("refused after 20 ms", { "route-refused": "reason=unsatisfiable" }, 400, 20, "route policy refused by the gateway: unsatisfiable", false),
    ],
    [answer("honored by aurora after 200 ms", { "route-applied": "provider=aurora" }, 200, 200, HONORED_TEXT, true), answer("honored by aurora after 20 ms", { "route-applied": "provider=aurora" }, 200, 20, HONORED_TEXT, true)],
  ] as const) {
    /** Session one sends zdr, session two notrain; two's comes back while one's is still at the gateway. */
    const twoSessions = async (): Promise<{ firstWhileOut: Shown[]; firstRouteWhileOut: string | undefined; firstAfter: Shown[]; secondAfter: Shown[] }> => {
      const one = await make("zdr");
      const two = await make("notrain");
      two.model.baseUrl = `${gateway().base}?s=2`;
      two.wireUrl = `${gateway().base}/chat/completions?s=2`;
      gateway().replies.inference = (request) => ((request.headers["route-policy"] ?? request.body).includes("notrain") ? second.reply : first.reply);
      const oneFrom = one.shown.length;
      const twoFrom = two.shown.length;
      const oneSent = one.request();
      await until(() => gateway().inference().length === 1);
      await two.request();
      const firstWhileOut = one.shown.slice(oneFrom);
      await one.command("route", "");
      const firstRouteWhileOut = (notices(one).at(-1) ?? "").split("\n").at(-1);
      await oneSent;
      const firstAfter = one.shown.slice(oneFrom).filter((entry) => !(entry.text ?? "").startsWith("Route policy:"));
      return { firstWhileOut, firstRouteWhileOut, firstAfter, secondAfter: two.shown.slice(twoFrom) };
    };
    const entries = (answered: Answer, model: string, query = ""): Shown[] => {
      const text = `${answered.report} (request for ${model} to ${gateway().base}${query})`;
      return [{ method: "setStatus", text }, ...(answered.quiet ? [] : [{ method: "notify" as const, text }])];
    };
    const methods = (answered: Answer): string => (answered.quiet ? "[setStatus]" : "[setStatus, notify]");
    const situation = `session one's zdr request (${first.label}) and session two's notrain request at ?s=2 (${second.label}) in flight together`;
    test(`C5, C14: ${name}: with ${situation}, session one's UI shows nothing before its own response`, async () => {
      assert.deepEqual((await twoSessions()).firstWhileOut, []);
    });
    test(`C5, C14: ${name}: with ${situation}, /route in session one before its own response shows "Last result: none yet in this session"`, async () => {
      assert.equal((await twoSessions()).firstRouteWhileOut, "Last result: none yet in this session");
    });
    test(`C5, C14: ${name}: with ${situation}, session one's UI entries are ${methods(first)} for its zdr result`, async () => {
      assert.deepEqual((await twoSessions()).firstAfter, entries(first, zdrModel));
    });
    test(`C5, C14: ${name}: with ${situation}, session two's UI entries are ${methods(second)} for its notrain result at ?s=2`, async () => {
      assert.deepEqual((await twoSessions()).secondAfter, entries(second, name === "omp" ? "demo-model+notrain" : "demo-model", "?s=2"));
    });
  }

  // ---- C9: OpenRouter.
  for (const field of ["only", "ignore", "sort", "order"]) {
    test(`C9: ${name}: at OpenRouter with held only=aurora,cobalt+ignore=basalt+sort=price+order=cobalt, a payload whose toJSON drops provider.${field} is blocked`, async () => {
      gateway().replies.detection = { status: 404 };
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
      assert.deepEqual([result.error, gateway().inference()], [`${BLOCKED}the request, as serialized, does not carry OpenRouter's provider.${field} as translated`, []]);
    });
  }

  for (const [broken] of [["ui"], ["model"], ["modelRegistry"]] as const) {
    test(`C1: ${name}: a request with held zdr whose context's ${broken} accessor throws is blocked`, async () => {
      const harness = await make("zdr");
      const healthy = harness.ctx.bind(harness);
      harness.ctx = () => hostile(healthy(), broken);
      const result = await harness.request();
      assert.deepEqual([result.sent, result.error?.startsWith(BLOCKED), gateway().inference()], [false, true, []]);
    });
    test(`C1: ${name}: a request with held zdr whose context's ${broken} accessor throws leaves no handler error`, async () => {
      const harness = await make("zdr");
      const healthy = harness.ctx.bind(harness);
      harness.ctx = () => hostile(healthy(), broken);
      await harness.request();
      assert.deepEqual(harness.handlerErrors, []);
    });
  }

  test(`C1: ${name}: an event whose payload accessor throws payload unavailable gets a blocking payload`, async () => {
    const harness = await make("zdr");
    const [guard] = harness.handlers.get("before_provider_request") ?? [];
    assert.ok(guard !== undefined);
    const event = Object.defineProperty({ type: "before_provider_request" }, "payload", {
      get() {
        throw new Error("payload unavailable");
      },
    });
    const returned = await guard(event, harness.ctx());
    assert.throws(() => JSON.stringify(returned), (error: unknown) => error instanceof Error && error.message === `${BLOCKED}the plugin failed: payload unavailable`);
  });

  test(`C8, C9: ${name}: at OpenRouter with held only=aurora and typed vendor/model+sort=price, one POST is sent, with body {model: vendor/model, provider: {only, sort}} and no Route-Policy header`, async () => {
    gateway().replies.detection = { status: 404 };
    const harness = await make("only=aurora");
    harness.model = { id: "vendor/model+sort=price", baseUrl: OPENROUTER_BASE, api: "openai-completions" };
    assert.ok((await harness.request({ model: harness.model.id, messages: [] })).sent);
    assert.deepEqual(gateway().inference().map((r) => [JSON.parse(r.body), r.headers["route-policy"]]), [[{ model: "vendor/model", messages: [], provider: { only: ["aurora"], sort: "price" } }, undefined]]);
  });

  test(`C8, C9: ${name}: at OpenRouter, a translated request answered with Route-Applied provider=cobalt and an evidence URI is shown as unconfirmed`, async () => {
    gateway().replies.detection = { status: 404 };
    const harness = await make("only=aurora");
    harness.model = { id: "vendor/model", baseUrl: OPENROUTER_BASE, api: "openai-completions" };
    gateway().replies.inference = { status: 200, headers: { "route-applied": "provider=cobalt", "route-evidence": "https://basalt.example/attestation" }, body: {} };
    const text = `route policy translated into the gateway's own fields; the result is unconfirmed, not applied (request for vendor/model to ${OPENROUTER_BASE})`;
    assert.deepEqual(await shownBy(harness, () => harness.request({ model: "vendor/model", messages: [] })), [{ method: "setStatus", text }, { method: "notify", text }]);
  });

  for (const [policy, why] of [
    ["zdr", "zdr has no hard filter there (its zdr field still admits Safety Retention endpoints)"],
    ["notrain", "notrain has no hard filter there (data_collection covers the model providers, not OpenRouter itself)"],
    ["bits=8", "bits has no hard filter there (quantizations names levels, not a floor on every weight)"],
    ["region=us", "region has no request field there"],
    ["attest=weights", "attest has no counterpart there"],
  ] as const) {
    for (const beside of ["", "+only=aurora"]) {
      test(`C9: ${name}: at OpenRouter, held ${policy}${beside} is blocked: ${why}`, async () => {
        gateway().replies.detection = { status: 404 };
        const harness = await make(`${policy}${beside}`);
        harness.model = { id: "vendor/model", baseUrl: OPENROUTER_BASE, api: "openai-completions" };
        const result = await harness.request({ model: "vendor/model", messages: [] });
        assert.deepEqual([result.error, gateway().inference()], [`${BLOCKED}the policy cannot be translated for OpenRouter: ${why}`, []]);
      });
    }
  }

  for (const api of ["google-generative-ai", "google-vertex", "google-gemini-cli", "bedrock-converse-stream", "mistral-conversations", "azure-openai-responses"]) {
    test(`C9: ${name}: at OpenRouter, held only=aurora over the ${api} API is blocked: not translated`, async () => {
      gateway().replies.detection = { status: 404 };
      const harness = await make("only=aurora");
      harness.model = { id: "vendor/model", baseUrl: OPENROUTER_BASE, api };
      const result = await harness.request({ model: "vendor/model", messages: [] });
      assert.deepEqual([result.error, gateway().inference()], [`${BLOCKED}OpenRouter documents its provider field for openai-completions, openai-responses, anthropic-messages requests, not ${api}`, []]);
    });
  }

  test(`C9: ${name}: at OpenRouter, held only=aurora over an unnamed API is blocked: not translated`, async () => {
    gateway().replies.detection = { status: 404 };
    const harness = await make("only=aurora");
    harness.model = { id: "vendor/model", baseUrl: OPENROUTER_BASE, api: "openai-completions" };
    harness.contextModel = { id: "vendor/model", baseUrl: OPENROUTER_BASE };
    const result = await harness.request({ model: "vendor/model", messages: [] });
    assert.deepEqual([result.error, gateway().inference()], [`${BLOCKED}OpenRouter documents its provider field for openai-completions, openai-responses, anthropic-messages requests, not an unnamed API`, []]);
  });

  for (const [api, payload] of [
    ["anthropic-messages", { model: "vendor/model", messages: [], max_tokens: 1 }],
    ["openai-responses", { model: "vendor/model", input: [] }],
  ] as const) {
    test(`C9: ${name}: at OpenRouter, held only=aurora over the ${api} API is sent translated`, async () => {
      gateway().replies.detection = { status: 404 };
      const harness = await make("only=aurora");
      harness.model = { id: "vendor/model", baseUrl: OPENROUTER_BASE, api };
      assert.ok((await harness.request({ ...payload })).sent);
      assert.deepEqual(gateway().inference().map((r) => JSON.parse(r.body)), [{ ...payload, provider: { only: ["aurora"] } }]);
    });
  }
}
