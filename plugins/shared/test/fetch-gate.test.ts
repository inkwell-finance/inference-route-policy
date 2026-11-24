// The fetch gate on its own (C1, C3, C5, C14): releases and watchers added directly, every fetch through the
// gated global fetch, every arrival recorded at loopback origins, every owner and watcher callback logged.

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { addRelease, addWatcher, withdrawReleases, type Release } from "../src/fetch-gate.ts";
import { NOT_CONTEXT } from "../src/request.ts";
import { describe } from "./fake-harness.ts";
import { deadline, Log, log, Origins, recording, settle, summarize, type Expected, type Rule } from "./wire.ts";

/** A record, an array of lines, or { $headers: lines } for a Headers object made of them. */
type HeadersSpec = Readonly<Record<string, string>> | readonly (readonly [string, string])[] | { readonly $headers: readonly (readonly [string, string])[] };

type Step =
  /** A release by `owner`, for `base` (with {origin} filled in), and the bytes it must leave with. `throws`: its owner's callbacks throw after they are logged. */
  | { do: "release"; as: string; owner: string; base: string; query?: string; context?: readonly (readonly [string, string])[]; header?: string | null; body: string; throws?: boolean }
  /** What the named release's decision relied on is discarded. */
  | { do: "stale"; as: string }
  | { do: "withdraw"; as: string }
  | { do: "withdraw-owner"; owner: string }
  /** A watcher answering `answer` for POSTs under `base`, null for others; "throws" to throw. `throws`: its stopped callback throws after it is logged. */
  | { do: "watch"; as: string; answer: string | null | "throws"; base?: string; throws?: boolean }
  | { do: "unwatch"; as: string }
  | { do: "fetch"; id?: string; method?: string; url: string; headers?: HeadersSpec; body?: string; request?: boolean }
  | { do: "finish"; id: string }
  | { do: "await-held"; gate: string }
  | { do: "release-gate"; gate: string }
  | { do: "tick"; ms: number }
  /** Calls the global fetch's own preconnect member, a runtime's member the gate must keep. */
  | { do: "preconnect"; url: string };

interface Scenario {
  key: string;
  ids: readonly string[];
  origins?: readonly string[];
  rules?: readonly Rule[];
  /** Mock Date, so `tick` steps age releases. */
  clock?: boolean;
  steps: readonly Step[];
}

type Lines = readonly (readonly [string, string])[];
const isLines = (spec: HeadersSpec): spec is Lines => Array.isArray(spec);

/** Headers as fetch takes them: a Headers object, an array of lines, or a record, as the step writes them. */
function headersOf(spec: HeadersSpec): NonNullable<RequestInit["headers"]> {
  const lines = (pairs: Lines): [string, string][] => pairs.map(([name, value]) => [name, value]);
  if (isLines(spec)) return lines(spec);
  const instance: unknown = spec["$headers"];
  if (Array.isArray(instance)) return new Headers(lines(instance));
  // Not lines and not a Headers object: the record form.
  return { ...(spec as Readonly<Record<string, string>>) };
}

async function run(scenario: Scenario): Promise<string[]> {
  const out = new Log();
  const origins = await Origins.start(out, ["gw", ...(scenario.origins ?? [])], scenario.rules ?? []);
  const owners = new Map<string, object>();
  const current = new Map<string, boolean>();
  const withdrawals = new Map<string, () => void>();
  const unwatch = new Map<string, () => void>();
  const started = new Map<string, Promise<void>>();
  const owner = (name: string): object => {
    let found = owners.get(name);
    if (found === undefined) {
      found = { name };
      owners.set(name, found);
    }
    return found;
  };
  const send = async (step: Extract<Step, { do: "fetch" }>): Promise<void> => {
    const url = origins.fill(step.url);
    const method = step.method ?? "POST";
    const init: RequestInit = { method, ...(step.headers === undefined ? {} : { headers: headersOf(step.headers) }), ...(step.body === undefined ? {} : { body: step.body }) };
    let response: Response;
    try {
      response = step.request === true ? await fetch(new Request(url, init)) : await fetch(url, init);
    } catch (error) {
      log(`${method} ${url} threw ${String(error)}`);
      return;
    }
    const text = await response.text();
    const shown = [...response.headers].filter(([name]) => name !== "connection" && name !== "keep-alive").map(([name, value]) => `${name}: ${value}`);
    log(`${method} ${url} -> ${response.status} | ${shown.join(" | ")} | body ${JSON.stringify(text)}`);
  };
  if (scenario.clock === true) mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    await recording(out, null, () =>
      deadline(
        (async () => {
          for (const step of scenario.steps) {
            out.push(`== ${describe(step, 400)}`);
            switch (step.do) {
              case "release": {
                current.set(step.as, true);
                const as = step.as;
                const release: Release = {
                  owner: owner(step.owner),
                  base: origins.fill(step.base),
                  query: step.query ?? "",
                  context: step.context ?? [],
                  header: step.header ?? null,
                  body: step.body,
                  current: () => current.get(as) === true,
                  stopped: (reason) => {
                    log(`${step.owner} told ${as} stopped: ${reason}`);
                    if (step.throws === true) throw new Error("owner callback is gone");
                  },
                  complete: (completion) => {
                    log(`${step.owner} told ${as} complete: ${JSON.stringify(completion)}`);
                    if (step.throws === true) throw new Error("owner callback is gone");
                  },
                };
                withdrawals.set(step.as, addRelease(release));
                break;
              }
              case "stale":
                current.set(step.as, false);
                break;
              case "withdraw":
                withdrawals.get(step.as)?.();
                break;
              case "withdraw-owner":
                withdrawReleases(owner(step.owner));
                break;
              case "watch": {
                const { as, answer } = step;
                const base = step.base === undefined ? null : origins.fill(step.base);
                unwatch.set(
                  as,
                  addWatcher({
                    check: (outgoing) => {
                      log(`watcher ${as} asked about ${JSON.stringify(outgoing)}`);
                      if (answer === "throws") throw new Error("broken watcher");
                      return base === null || outgoing.path.startsWith(`${base}/`) ? answer : null;
                    },
                    stopped: (reason) => {
                      log(`watcher ${as} told stopped: ${reason}`);
                      if (step.throws === true) throw new Error("watcher callback is gone");
                    },
                  }),
                );
                break;
              }
              case "unwatch":
                unwatch.get(step.as)?.();
                break;
              case "fetch":
                if (step.id === undefined) await send(step);
                else started.set(step.id, send(step));
                break;
              case "finish":
                await deadline(started.get(step.id) ?? Promise.reject(new Error(`no fetch ${step.id}`)), 3000, `fetch ${step.id} to finish`);
                break;
              case "await-held":
                await origins.held(step.gate);
                break;
              case "release-gate":
                origins.release(step.gate);
                break;
              case "preconnect": {
                const member: unknown = Reflect.get(globalThis.fetch, "preconnect");
                if (typeof member === "function") member(origins.fill(step.url));
                else log("the global fetch has no preconnect");
                break;
              }
              case "tick":
                mock.timers.tick(step.ms);
                break;
            }
            await settle();
          }
        })(),
        10_000,
        `scenario ${scenario.key} to finish`,
      ),
    );
  } finally {
    if (scenario.clock === true) mock.timers.reset();
    for (const withdraw of withdrawals.values()) withdraw();
    for (const stop of unwatch.values()) stop();
    await origins.close();
  }
  return out.lines;
}

function scenarios(list: readonly Scenario[], expected: Expected): void {
  for (const scenario of list) {
    const want = expected[scenario.key]?.["gate"];
    const steps = scenario.steps.map((step) => describe(step, 40)).join("; ");
    const rules = (scenario.rules ?? []).map((rule) => `rule ${describe({ ...rule })}; `).join("");
    test(`${scenario.key}${scenario.ids.length === 0 ? "" : ` ${scenario.ids.join(", ")}`}: gate: ${rules}steps: ${steps} => ${want === undefined ? "(no expected record)" : summarize(want)}`, async () => {
      const [key, variant, actual] = [scenario.key, "gate", await run(scenario)];
      assert.ok(want !== undefined, `no expected record for ${key} in ${variant}`);
      assert.deepEqual(actual, want);
    });
  }
}

const GW = "http://{gw}/v1";
const POST = "http://{gw}/v1/chat/completions";
const BODY = '{"model":"demo-model","messages":[]}';
const AUTH = [["authorization", "Bearer k"]] as const;
const NOT_RELEASED = { do: "watch", as: "W", answer: "not released", base: GW } as const;
const released = (as: string, extra: Partial<Extract<Step, { do: "release" }>> = {}): Step => ({ do: "release", as, owner: "o1", base: GW, context: AUTH, header: "zdr", body: BODY, ...extra });
const posted = (extra: Partial<Extract<Step, { do: "fetch" }>> = {}): Step => ({ do: "fetch", url: POST, headers: { authorization: "Bearer k", "route-policy": "zdr" }, body: BODY, ...extra });

const LIST: readonly Scenario[] = [
  {
    key: "g01",
    ids: ["C1", "C3", "C5"],
    rules: [
      { on: "inference", nth: 1, reply: { status: 200, headers: { "route-applied": ["provider=aurora", "provider=basalt"] }, body: { choices: [] } } },
      { on: "inference", nth: 2, reply: { status: 400, headers: { "route-refused": "reason=unsatisfiable" }, raw: '{"error":  "unsatisfiable"}' } },
    ],
    steps: [NOT_RELEASED, released("A"), posted(), released("B"), posted(), posted()],
  },
  {
    key: "g02",
    ids: ["C1", "C14"],
    steps: [
      released("A"),
      posted({ headers: { $headers: [["authorization", "Bearer k"], ["route-policy", "zdr"]] } }),
      released("B"),
      posted({ headers: [["authorization", "Bearer k"], ["route-policy", "zdr"]] }),
      released("C"),
      posted({ headers: [["Authorization", "Bearer k"], ["Route-Policy", "zdr"]] }),
      released("D"),
      posted({ headers: { Authorization: "Bearer k", "route-POLICY": "zdr" } }),
      released("E"),
      posted({ headers: { AUTHORIZATION: "Bearer k", "ROUTE-POLICY": "zdr" } }),
      released("F"),
      posted({ headers: { authorization: "Bearer k", "route-policy": "zdr", ...Object.fromEntries(NOT_CONTEXT.filter((name) => name !== "route-policy" && name !== "content-length").map((name) => [name, "x"])) } }),
    ],
  },
  {
    key: "g03",
    ids: ["C1", "C14"],
    steps: [
      NOT_RELEASED,
      released("A"),
      posted({ body: `${BODY} ` }),
      posted({ headers: { authorization: "Bearer k", "route-policy": "zdr", "api-key": "k" } }),
      posted({ headers: { authorization: "Bearer k", "route-policy": "zdr", cookie: "a=1" } }),
      posted({ body: '{"model":"demo-model","messages":[],"provider":{"only":["x"]}}' }),
      posted({ headers: { authorization: "Bearer k", "route-policy": "zdr", "proxy-authorization": "Basic x" } }),
      posted({ headers: { authorization: "Bearer k", "route-policy": "zdr", "x-api-key": "k" } }),
      posted({ headers: { authorization: "Bearer k", "route-policy": "zdr", "x-goog-api-key": "k" } }),
      posted({ headers: { authorization: "Bearer k", "route-policy": "zdr", "x-tenant-token": "t" } }),
      posted({ headers: { authorization: "Bearer other", "route-policy": "zdr" } }),
      posted({ headers: { authorization: "Bearer k" } }),
      posted({ headers: { authorization: "Bearer k", "route-policy": "zdr+notrain" } }),
      posted({ url: "http://{gw}/v1/other/../../other/chat/completions" }),
      posted({ url: `${POST}?key=1` }),
      posted({ headers: [["authorization", "Bearer k"], ["route-policy", "zdr"], ["route-policy", "zdr"]] }),
      posted({ request: true }),
      posted(),
    ],
  },
  {
    key: "g04",
    ids: ["C1", "C14"],
    steps: [
      NOT_RELEASED,
      released("A", { header: null }),
      posted(),
      posted({ headers: { authorization: "Bearer k" } }),
    ],
  },
  {
    key: "g05",
    ids: ["C1", "C14"],
    steps: [
      NOT_RELEASED,
      released("A", { context: [["authorization", "Bearer k"], ["x-tenant", "a, b"]] }),
      posted({ headers: [["authorization", "  Bearer other  "], ["x-tenant", "a"], ["x-tenant", "b"], ["route-policy", "zdr"]] }),
      posted({ headers: [["x-tenant", "a"], ["x-tenant", "b"], ["route-policy", "zdr"]] }),
      posted({ headers: [["authorization", "Bearer k"], ["route-policy", "zdr"]] }),
      posted({ headers: [["authorization", "Bearer k"], ["x-tenant", "a,b"], ["route-policy", "zdr"]] }),
      posted({ headers: [["authorization", "Bearer k"], ["x-tenant", "a"], ["route-policy", "zdr"]] }),
      posted({ headers: [["authorization", "Bearer k"], ["x-tenant", "b"], ["x-tenant", "a"], ["route-policy", "zdr"]] }),
      posted({ headers: [["authorization", "  Bearer k  "], ["x-tenant", "a"], ["X-Tenant", "b"], ["route-policy", "zdr"]] }),
    ],
  },
  {
    key: "g06",
    ids: ["C1", "C14"],
    steps: [
      NOT_RELEASED,
      released("A", { query: "" }),
      posted({ url: `${POST}?` }),
      posted({ url: `${POST}?t=1` }),
      { do: "withdraw", as: "A" },
      released("B", { query: "?" }),
      posted(),
      posted({ url: `${POST}?t=1` }),
      { do: "withdraw", as: "B" },
      released("C", { query: "?t=1" }),
      posted(),
      posted({ url: `${POST}?` }),
      { do: "withdraw", as: "C" },
      released("D", { query: "" }),
      posted(),
      released("E", { query: "?" }),
      posted({ url: `${POST}?` }),
      released("F", { query: "?t=1" }),
      posted({ url: `${POST}?t=1` }),
    ],
  },
  {
    key: "g07",
    ids: ["C1", "C14"],
    origins: ["other"],
    steps: [
      { do: "watch", as: "W", answer: "not released" },
      released("A"),
      posted({ url: "http://{other}/v1/chat/completions" }),
      posted({ url: "http://{gw}/v123/chat/completions" }),
      posted({ url: "http://{gw}/v%31/chat/completions" }),
      posted({ url: "http://{gw}/v1//chat/completions" }),
      posted({ url: "http://{gw}/v1/x/../chat/completions" }),
      released("B"),
      posted({ url: "HTTP://{gw}/v1/chat/completions" }),
      released("C"),
      posted({ url: "http://127.0.0.1.:{gw.port}/v1/chat/completions" }),
      released("D"),
      posted({ url: `${POST}#part` }),
      released("E", { query: "?" }),
      posted({ url: `${POST}?#part` }),
      released("F", { query: "?q=a+b" }),
      posted({ url: `${POST}?q=a%20b` }),
      posted({ url: `${POST}?q=a+b` }),
      released("G", { query: "?q=%2b" }),
      posted({ url: `${POST}?q=%2B` }),
      released("H", { base: "http://{gw}/v1/" }),
      posted(),
      released("I"),
      posted({ url: "http://{gw}/v1/" }),
    ],
  },
  {
    key: "g08",
    ids: ["C1"],
    origins: ["other"],
    steps: [
      released("A", { body: '{"model":"other"}' }),
      NOT_RELEASED,
      posted(),
      { do: "fetch", method: "GET", url: "http://{gw}/v1/models", headers: { authorization: "Bearer k", "route-policy": "zdr" } },
      posted({ url: "http://{other}/v1/chat/completions" }),
      posted({ body: '{"model":"other"}' }),
      { do: "unwatch", as: "W" },
      { do: "watch", as: "N", answer: null },
      { do: "watch", as: "T", answer: "throws" },
      posted(),
      { do: "unwatch", as: "T" },
      posted(),
      { do: "watch", as: "W2", answer: "second says no", base: GW },
      posted(),
      { do: "watch", as: "W3", answer: "third says no", base: GW },
      posted(),
    ],
  },
  {
    key: "g09",
    ids: ["C1", "C14"],
    steps: [
      NOT_RELEASED,
      released("A"),
      { do: "stale", as: "A" },
      posted(),
      posted(),
      released("B"),
      released("C", { owner: "o2" }),
      posted(),
      posted(),
      { do: "withdraw-owner", owner: "o1" },
      posted(),
      { do: "withdraw", as: "C" },
      posted(),
    ],
  },
  {
    key: "g10",
    ids: ["C1", "C3", "C14"],
    origins: ["other"],
    rules: [301, 302, 303, 307, 308].map((status, i): Rule => ({ on: "inference", nth: i + 1, reply: { status, headers: { location: "http://{other}/v1/chat/completions", "route-applied": "provider=aurora" }, body: {} } })),
    steps: [released("A"), posted(), released("B"), posted(), released("C"), posted(), released("D"), posted(), released("E"), posted()],
  },
  {
    key: "g11",
    ids: ["C5"],
    rules: [
      { on: "inference", query: "?a", reply: { status: 200, headers: { "route-applied": "provider=aurora" }, body: { choices: [] }, hold: "ga" } },
      { on: "inference", query: "?b", reply: { status: 400, headers: { "route-refused": "reason=unsatisfiable" }, body: {}, hold: "gb" } },
    ],
    steps: [
      released("A", { query: "?a" }),
      released("B", { owner: "o2", query: "?b" }),
      posted({ id: "a", url: `${POST}?a` }),
      { do: "await-held", gate: "ga" },
      posted({ id: "b", url: `${POST}?b` }),
      { do: "await-held", gate: "gb" },
      { do: "release-gate", gate: "gb" },
      { do: "finish", id: "b" },
      { do: "release-gate", gate: "ga" },
      { do: "finish", id: "a" },
    ],
  },
  {
    key: "g12",
    ids: ["C1"],
    clock: true,
    steps: [NOT_RELEASED, released("A"), { do: "tick", ms: 29_999 }, posted(), released("B"), { do: "tick", ms: 30_000 }, posted()],
  },
  {
    key: "g13",
    ids: ["C1"],
    steps: [
      { do: "watch", as: "W", answer: "not released", base: GW, throws: true },
      released("A", { throws: true }),
      posted(),
      released("B", { throws: true, body: '{"model":"b"}' }),
      { do: "stale", as: "B" },
      posted({ body: '{"model":"b"}' }),
      posted({ body: '{"model":"c"}' }),
    ],
  },
  {
    key: "g14",
    ids: [],
    origins: ["other"],
    rules: [{ on: "inference", reply: { status: 307, headers: { location: "http://{other}/v1/chat/completions" }, body: {} } }],
    steps: [{ do: "watch", as: "N", answer: null }, released("A", { body: '{"model":"unrelated"}' }), posted({ headers: { authorization: "Bearer k" } })],
  },
  {
    key: "g15",
    ids: [],
    steps: [NOT_RELEASED, { do: "preconnect", url: "http://{gw}/v1" }],
  },
  {
    key: "g16",
    ids: ["C1", "C14"],
    origins: ["other"],
    steps: [
      { do: "watch", as: "N", answer: null },
      released("A"),
      released("B", { owner: "o2", body: '{"model":"stale"}' }),
      { do: "stale", as: "B" },
      posted({ url: "http://{gw}/v123/chat/completions" }),
      posted({ url: "http://{other}/v1/chat/completions" }),
      posted({ url: `${POST}?q=x` }),
      posted({ url: "http://{other}/v1/chat/completions", body: '{"model":"different"}' }),
      posted({ url: "http://{other}/v1/chat/completions", headers: { authorization: "Bearer k" }, body: '{"model":"unrelated"}' }),
      posted({ url: "http://{other}/v1/chat/completions", headers: { authorization: "Bearer k" }, body: '{"model":"stale"}' }),
      posted(),
    ],
  },
];

const EXPECTED: Expected = {
  g01: {
    gate: [
      "== watch as=W answer=not released base=http://{gw}/v1",
      "== release as=A owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told A complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora, provider=basalt\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora, provider=basalt | body \"{\\\"choices\\\":[]}\"",
      "== release as=B owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told B complete: {\"status\":400,\"result\":{\"applied\":[],\"refused\":[\"reason=unsatisfiable\"],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions -> 400 | content-length: 27 | content-type: application/json | route-refused: reason=unsatisfiable | body \"{\\\"error\\\":  \\\"unsatisfiable\\\"}\"",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
    ],
  },
  g02: {
    gate: [
      "== release as=A owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"$headers\":[[\"authorization\",\"Bearer k\"],[\"route-policy\",\"zdr\"]]} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told A complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
      "== release as=B owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=http://{gw}/v1/chat/completions headers=[[\"authorization\",\"Bearer k\"],[\"route-policy\",\"zdr\"]] body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told B complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
      "== release as=C owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=http://{gw}/v1/chat/completions headers=[[\"Authorization\",\"Bearer k\"],[\"Route-Policy\",\"zdr\"]] body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | Authorization: Bearer k | Route-Policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told C complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
      "== release as=D owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"Authorization\":\"Bearer k\",\"route-POLICY\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | Authorization: Bearer k | route-POLICY: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told D complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
      "== release as=E owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"AUTHORIZATION\":\"Bearer k\",\"ROUTE-POLICY\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | AUTHORIZATION: Bearer k | ROUTE-POLICY: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told E complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
      "== release as=F owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\",\"accept\":\"x\",\"accept-encoding\":\"x\",\"accept-language\":\"x\",\"content-type\":\"x\",\"user-agent\":\"x\",\"x-stainless-arch\":\"x\",\"x-stainless-lang\":\"x\",\"x-stainless-os\":\"x\",\"x-stainless-package-version\":\"x\",\"x-stainless-retry-count\":\"x\",\"x-stainless-runtime\":\"x\",\"x-stainless-runtime-version\":\"x\",\"x-stainless-timeout\":\"x\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | accept: x | accept-encoding: x | accept-language: x | content-type: x | user-agent: x | x-stainless-arch: x | x-stainless-lang: x | x-stainless-os: x | x-stainless-package-version: x | x-stainless-retry-count: x | x-stainless-runtime: x | x-stainless-runtime-version: x | x-stainless-timeout: x | sec-fetch-mode: cors | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told F complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
    ],
  },
  g03: {
    gate: [
      "== watch as=W answer=not released base=http://{gw}/v1",
      "== release as=A owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]} ",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]} \"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\",\"api-key\":\"k\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"api-key\",\"k\"],[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\",\"cookie\":\"a=1\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"],[\"cookie\",\"a=1\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[],\"provider\":{\"only\":[\"x\"]}}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[],\\\"provider\\\":{\\\"only\\\":[\\\"x\\\"]}}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\",\"proxy-authorization\":\"Basic x\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"],[\"proxy-authorization\",\"Basic x\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\",\"x-api-key\":\"k\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"],[\"x-api-key\",\"k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\",\"x-goog-api-key\":\"k\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"],[\"x-goog-api-key\",\"k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\",\"x-tenant-token\":\"t\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"],[\"x-tenant-token\",\"t\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer other\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer other\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":null,\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr+notrain\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr+notrain\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/other/../../other/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/other/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "o1 told A stopped: this request to http://{gw}/other/chat/completions is one released for http://{gw}/v1, and a release is sent only where it was released for",
      "POST http://{gw}/v1/other/../../other/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: this request to http://{gw}/other/chat/completions is one released for http://{gw}/v1, and a release is sent only where it was released for",
      "== fetch url=http://{gw}/v1/chat/completions?key=1 headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"?key=1\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions?key=1 threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions headers=[[\"authorization\",\"Bearer k\"],[\"route-policy\",\"zdr\"],[\"route-policy\",\"zdr\"]] body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr, zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]} request=true",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":null}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told A complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
    ],
  },
  g04: {
    gate: [
      "== watch as=W answer=not released base=http://{gw}/v1",
      "== release as=A owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=null body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told A complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
    ],
  },
  g05: {
    gate: [
      "== watch as=W answer=not released base=http://{gw}/v1",
      "== release as=A owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"],[\"x-tenant\",\"a, b\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=http://{gw}/v1/chat/completions headers=[[\"authorization\",\"  Bearer other  \"],[\"x-tenant\",\"a\"],[\"x-tenant\",\"b\"],[\"route-policy\",\"zdr\"]] body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer other\"],[\"x-tenant\",\"a, b\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions headers=[[\"x-tenant\",\"a\"],[\"x-tenant\",\"b\"],[\"route-policy\",\"zdr\"]] body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"x-tenant\",\"a, b\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions headers=[[\"authorization\",\"Bearer k\"],[\"route-policy\",\"zdr\"]] body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions headers=[[\"authorization\",\"Bearer k\"],[\"x-tenant\",\"a,b\"],[\"route-policy\",\"zdr\"]] body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"],[\"x-tenant\",\"a,b\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions headers=[[\"authorization\",\"Bearer k\"],[\"x-tenant\",\"a\"],[\"route-policy\",\"zdr\"]] body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"],[\"x-tenant\",\"a\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions headers=[[\"authorization\",\"Bearer k\"],[\"x-tenant\",\"b\"],[\"x-tenant\",\"a\"],[\"route-policy\",\"zdr\"]] body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"],[\"x-tenant\",\"b, a\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions headers=[[\"authorization\",\"  Bearer k  \"],[\"x-tenant\",\"a\"],[\"X-Tenant\",\"b\"],[\"route-policy\",\"zdr\"]] body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | x-tenant: a, b | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told A complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
    ],
  },
  g06: {
    gate: [
      "== watch as=W answer=not released base=http://{gw}/v1",
      "== release as=A owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]} query=",
      "== fetch url=http://{gw}/v1/chat/completions? headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"?\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions? threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions?t=1 headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"?t=1\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions?t=1 threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== withdraw as=A",
      "== release as=B owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]} query=?",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions?t=1 headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"?t=1\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions?t=1 threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== withdraw as=B",
      "== release as=C owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]} query=?t=1",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions? headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"?\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions? threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== withdraw as=C",
      "== release as=D owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]} query=",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told D complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
      "== release as=E owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]} query=?",
      "== fetch url=http://{gw}/v1/chat/completions? headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions? | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told E complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions? -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
      "== release as=F owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]} query=?t=1",
      "== fetch url=http://{gw}/v1/chat/completions?t=1 headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions?t=1 | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told F complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions?t=1 -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
    ],
  },
  g07: {
    gate: [
      "== watch as=W answer=not released",
      "== release as=A owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=http://{other}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{other}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{other}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v123/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v123/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v123/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v%31/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v%31/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v%31/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1//chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1//chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1//chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/x/../chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told A complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/x/../chat/completions -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
      "== release as=B owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=HTTP://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told B complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST HTTP://{gw}/v1/chat/completions -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
      "== release as=C owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=http://127.0.0.1.:{gw.port}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told C complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://127.0.0.1.:{gw.port}/v1/chat/completions -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
      "== release as=D owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=http://{gw}/v1/chat/completions#part headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told D complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions#part -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
      "== release as=E owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]} query=?",
      "== fetch url=http://{gw}/v1/chat/completions?#part headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions? | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told E complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions?#part -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
      "== release as=F owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]} query=?q=a+b",
      "== fetch url=http://{gw}/v1/chat/completions?q=a%20b headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"?q=a%20b\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions?q=a%20b threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch url=http://{gw}/v1/chat/completions?q=a+b headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions?q=a+b | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told F complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions?q=a+b -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
      "== release as=G owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]} query=?q=%2b",
      "== fetch url=http://{gw}/v1/chat/completions?q=%2B headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"?q=%2B\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions?q=%2B threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== release as=H owner=o1 base=http://{gw}/v1/ context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== release as=I owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=http://{gw}/v1/ headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/ threw Error: Blocked by the route policy plugin, nothing was sent: not released",
    ],
  },
  g08: {
    gate: [
      "== release as=A owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"other\"}",
      "== watch as=W answer=not released base=http://{gw}/v1",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== fetch method=GET url=http://{gw}/v1/models headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"}",
      "gw <- GET /v1/models | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | body \"\"",
      "GET http://{gw}/v1/models -> 200 | content-length: 330 | content-type: application/json | body \"{\\\"data\\\":[{\\\"id\\\":\\\"demo-model\\\",\\\"routes\\\":[{\\\"provider\\\":\\\"aurora\\\",\\\"facts\\\":\\\"zdr+notrain+bits=8+region=us\\\"},{\\\"provider\\\":\\\"basalt\\\",\\\"facts\\\":\\\"bits=16+region=us,de+attest=weights,prompt\\\",\\\"evidence\\\":\\\"https://basalt.example/attestation\\\"},{\\\"provider\\\":\\\"cobalt\\\",\\\"facts\\\":\\\"\\\"}]},{\\\"id\\\":\\\"other-model\\\",\\\"routes\\\":[{\\\"provider\\\":\\\"cobalt\\\",\\\"facts\\\":\\\"notrain\\\"}]}]}\"",
      "== fetch url=http://{other}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{other}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "POST http://{other}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: this request to http://{other}/v1/chat/completions carries a Route-Policy header, and no session checked http://{other}/v1/chat/completions for it",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"other\"}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 17 | body \"{\\\"model\\\":\\\"other\\\"}\"",
      "o1 told A complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
      "== unwatch as=W",
      "== watch as=N answer=null",
      "== watch as=T answer=throws",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher N asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher T asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: the plugin failed while checking the request: broken watcher",
      "== unwatch as=T",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher N asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: this request to http://{gw}/v1/chat/completions carries a Route-Policy header, and no session checked http://{gw}/v1/chat/completions for it",
      "== watch as=W2 answer=second says no base=http://{gw}/v1",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher N asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W2 asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W2 told stopped: second says no",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: second says no",
      "== watch as=W3 answer=third says no base=http://{gw}/v1",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher N asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W2 asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W2 told stopped: second says no",
      "watcher W3 asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W3 told stopped: third says no",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: second says no",
    ],
  },
  g09: {
    gate: [
      "== watch as=W answer=not released base=http://{gw}/v1",
      "== release as=A owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== stale as=A",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "o1 told A stopped: the detection reply this request was checked against was discarded before it left; send it again",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: the detection reply this request was checked against was discarded before it left; send it again",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
      "== release as=B owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== release as=C owner=o2 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "o1 told B stopped: two sessions released this same request, so whose it is cannot be told",
      "o2 told C stopped: two sessions released this same request, so whose it is cannot be told",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: two sessions released this same request, so whose it is cannot be told",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "o1 told B stopped: two sessions released this same request, so whose it is cannot be told",
      "o2 told C stopped: two sessions released this same request, so whose it is cannot be told",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: two sessions released this same request, so whose it is cannot be told",
      "== withdraw-owner owner=o1",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o2 told C complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
      "== withdraw as=C",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
    ],
  },
  g10: {
    gate: [
      "== release as=A owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told A complete: {\"status\":301,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions -> 301 | content-length: 2 | content-type: application/json | location: http://{other}/v1/chat/completions | route-applied: provider=aurora | body \"{}\"",
      "== release as=B owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told B complete: {\"status\":302,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions -> 302 | content-length: 2 | content-type: application/json | location: http://{other}/v1/chat/completions | route-applied: provider=aurora | body \"{}\"",
      "== release as=C owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told C complete: {\"status\":303,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions -> 303 | content-length: 2 | content-type: application/json | location: http://{other}/v1/chat/completions | route-applied: provider=aurora | body \"{}\"",
      "== release as=D owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told D complete: {\"status\":307,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions -> 307 | content-length: 2 | content-type: application/json | location: http://{other}/v1/chat/completions | route-applied: provider=aurora | body \"{}\"",
      "== release as=E owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told E complete: {\"status\":308,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions -> 308 | content-length: 2 | content-type: application/json | location: http://{other}/v1/chat/completions | route-applied: provider=aurora | body \"{}\"",
    ],
  },
  g11: {
    gate: [
      "== release as=A owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]} query=?a",
      "== release as=B owner=o2 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]} query=?b",
      "== fetch url=http://{gw}/v1/chat/completions?a headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]} id=a",
      "gw <- POST /v1/chat/completions?a | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "== await-held gate=ga",
      "== fetch url=http://{gw}/v1/chat/completions?b headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]} id=b",
      "gw <- POST /v1/chat/completions?b | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "== await-held gate=gb",
      "== release-gate gate=gb",
      "o2 told B complete: {\"status\":400,\"result\":{\"applied\":[],\"refused\":[\"reason=unsatisfiable\"],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions?b -> 400 | content-length: 2 | content-type: application/json | route-refused: reason=unsatisfiable | body \"{}\"",
      "== finish id=b",
      "== release-gate gate=ga",
      "o1 told A complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions?a -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
      "== finish id=a",
    ],
  },
  g12: {
    gate: [
      "== watch as=W answer=not released base=http://{gw}/v1",
      "== release as=A owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== tick ms=29999",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told A complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
      "== release as=B owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== tick ms=30000",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
    ],
  },
  g13: {
    gate: [
      "== watch as=W answer=not released base=http://{gw}/v1 throws=true",
      "== release as=A owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]} throws=true",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told A complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
      "== release as=B owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"b\"} throws=true",
      "== stale as=B",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"b\"}",
      "o1 told B stopped: the detection reply this request was checked against was discarded before it left; send it again",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: the detection reply this request was checked against was discarded before it left; send it again",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"c\"}",
      "watcher W asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"c\\\"}\"}",
      "watcher W told stopped: not released",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: not released",
    ],
  },
  g14: {
    gate: [
      "== watch as=N answer=null",
      "== release as=A owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"unrelated\"}",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher N asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":null,\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "other <- POST /v1/chat/completions | host: {other} | connection: keep-alive | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "POST http://{gw}/v1/chat/completions -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
    ],
  },
  g15: {
    gate: [
      "== watch as=W answer=not released base=http://{gw}/v1",
      "== preconnect url=http://{gw}/v1",
      "fetch.preconnect http://{gw}/v1",
    ],
  },
  g16: {
    gate: [
      "== watch as=N answer=null",
      "== release as=A owner=o1 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"demo-model\",\"messages\":[]}",
      "== release as=B owner=o2 base=http://{gw}/v1 context=[[\"authorization\",\"Bearer k\"]] header=zdr body={\"model\":\"stale\"}",
      "== stale as=B",
      "== fetch url=http://{gw}/v123/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher N asked about {\"path\":\"http://{gw}/v123/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "o1 told A stopped: this request to http://{gw}/v123/chat/completions is one released for http://{gw}/v1, and a release is sent only where it was released for",
      "POST http://{gw}/v123/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: this request to http://{gw}/v123/chat/completions is one released for http://{gw}/v1, and a release is sent only where it was released for",
      "== fetch url=http://{other}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher N asked about {\"path\":\"http://{other}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "o1 told A stopped: this request to http://{other}/v1/chat/completions is one released for http://{gw}/v1, and a release is sent only where it was released for",
      "POST http://{other}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: this request to http://{other}/v1/chat/completions is one released for http://{gw}/v1, and a release is sent only where it was released for",
      "== fetch url=http://{gw}/v1/chat/completions?q=x headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "watcher N asked about {\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"?q=x\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"}",
      "o1 told A stopped: this request to http://{gw}/v1/chat/completions?q=x is one released for http://{gw}/v1, and a release is sent only where it was released for",
      "POST http://{gw}/v1/chat/completions?q=x threw Error: Blocked by the route policy plugin, nothing was sent: this request to http://{gw}/v1/chat/completions?q=x is one released for http://{gw}/v1, and a release is sent only where it was released for",
      "== fetch url=http://{other}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"different\"}",
      "watcher N asked about {\"path\":\"http://{other}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"different\\\"}\"}",
      "POST http://{other}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: this request to http://{other}/v1/chat/completions carries a Route-Policy header, and no session checked http://{other}/v1/chat/completions for it",
      "== fetch url=http://{other}/v1/chat/completions headers={\"authorization\":\"Bearer k\"} body={\"model\":\"unrelated\"}",
      "watcher N asked about {\"path\":\"http://{other}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":null,\"body\":\"{\\\"model\\\":\\\"unrelated\\\"}\"}",
      "other <- POST /v1/chat/completions | host: {other} | connection: keep-alive | authorization: Bearer k | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 21 | body \"{\\\"model\\\":\\\"unrelated\\\"}\"",
      "POST http://{other}/v1/chat/completions -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
      "== fetch url=http://{other}/v1/chat/completions headers={\"authorization\":\"Bearer k\"} body={\"model\":\"stale\"}",
      "watcher N asked about {\"path\":\"http://{other}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":null,\"body\":\"{\\\"model\\\":\\\"stale\\\"}\"}",
      "other <- POST /v1/chat/completions | host: {other} | connection: keep-alive | authorization: Bearer k | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 17 | body \"{\\\"model\\\":\\\"stale\\\"}\"",
      "POST http://{other}/v1/chat/completions -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
      "== fetch url=http://{gw}/v1/chat/completions headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"} body={\"model\":\"demo-model\",\"messages\":[]}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 36 | body \"{\\\"model\\\":\\\"demo-model\\\",\\\"messages\\\":[]}\"",
      "o1 told A complete: {\"status\":200,\"result\":{\"applied\":[\"provider=aurora\"],\"refused\":[],\"evidence\":[]}}",
      "POST http://{gw}/v1/chat/completions -> 200 | content-length: 14 | content-type: application/json | route-applied: provider=aurora | body \"{\\\"choices\\\":[]}\"",
    ],
  },
};

scenarios(LIST, EXPECTED);
