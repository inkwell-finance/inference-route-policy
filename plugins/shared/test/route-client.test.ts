// The route client on its own (C6, C14, C15, C16, C12, C13), for what the adapters cannot reach: a read budget other
// than the default, a fetch of its own, the release limit, two clients in one process, and /route's text for
// places and credentials of every kind. Every call and its whole result is logged with the wire's arrivals.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fetch } from "../src/gateway-client.ts";
import { plain } from "./table.ts";
import { RouteClient, type Located, type Prepared } from "../src/route-client.ts";
import type { Outgoing } from "../src/request.ts";
import { describe } from "./fake-harness.ts";
import { deadline, Log, log, Origins, recording, settle, summarize, type Expected, type Rule } from "./wire.ts";

interface Place {
  base: string;
  query?: string;
  context?: readonly (readonly [string, string])[];
  unexact?: string;
}

type Step =
  /** `reportThrows`: its onReport throws after it is logged. */
  | { do: "client"; as: string; held?: string; timeoutMs?: number; ownFetch?: boolean; reportThrows?: boolean }
  | { do: "hold"; c: string; policy: string | null }
  /** `atLeastMs` logs whether the decision took at least that long: a read budget cannot be shorter than written. */
  | { do: "decide"; c: string; id?: string; place: Place; model: string; configured?: string; atLeastMs?: number }
  | { do: "release"; c: string; from: string; header: string | null; bodies: number }
  | { do: "post"; body: string; headers: Readonly<Record<string, string>> }
  | { do: "describe"; c: string; place: Place | { why: string } }
  | { do: "check"; c: string; outgoing: Outgoing }
  | { do: "blocked"; c: string; reason: string };

interface Scenario {
  key: string;
  ids: readonly string[];
  rules?: readonly Rule[];
  steps: readonly Step[];
}

async function run(scenario: Scenario): Promise<string[]> {
  const out = new Log();
  const origins = await Origins.start(out, ["gw"], scenario.rules ?? []);
  const clients = new Map<string, RouteClient>();
  const decided = new Map<string, Prepared>();
  const client = (name: string): RouteClient => {
    const found = clients.get(name);
    assert.ok(found !== undefined, `no client ${name}`);
    return found;
  };
  const located = (place: Place): Located => ({
    target: { base: origins.fill(place.base), query: place.query ?? "", context: place.context ?? [] },
    unexact: place.unexact ?? null,
  });
  const decide = async (step: Extract<Step, { do: "decide" }>): Promise<void> => {
    const began = performance.now();
    const prepared = await client(step.c).decide(located(step.place), step.model, step.configured ?? null);
    const took = performance.now() - began;
    decided.set(step.id ?? "last", prepared);
    log(`${step.c} decide -> ${JSON.stringify(plain(prepared))}`);
    if (step.atLeastMs !== undefined) log(`${step.c} decide took at least ${step.atLeastMs} ms: ${took >= step.atLeastMs}`);
  };
  try {
    await recording(out, null, () =>
      deadline(
        (async () => {
          for (const step of scenario.steps) {
            out.push(`== ${describe(step, 400)}`);
            switch (step.do) {
              case "client": {
                const as = step.as;
                const own: Fetch = (input, init) => {
                  log(`${as} own fetch ${init?.method ?? "GET"} ${input}`);
                  return fetch(input, init);
                };
                clients.set(
                  as,
                  new RouteClient({
                    carriers: "header",
                    env: step.held === undefined ? {} : { ROUTE_POLICY: step.held },
                    ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
                    ...(step.ownFetch === true ? { fetch: own } : {}),
                    onReport: (report, subject) => {
                      log(`${as} report ${JSON.stringify(report)} subject ${JSON.stringify(subject)}`);
                      if (step.reportThrows === true) throw new Error("onReport is gone");
                    },
                  }),
                );
                break;
              }
              case "hold":
                if (step.policy === null) client(step.c).held = { kind: "none" };
                else client(step.c).set(step.policy);
                break;
              case "decide":
                await decide(step);
                break;
              case "release": {
                const prepared = decided.get(step.from);
                assert.ok(prepared !== undefined && prepared.decision.action !== "block", `decision ${step.from} is not one to release`);
                const { decision } = prepared;
                for (let i = 0; i < step.bodies; i++) client(step.c).release({ ...prepared, decision }, step.header, `b${i}`);
                break;
              }
              case "post": {
                const url = `${origins.url("gw")}/v1/chat/completions`;
                try {
                  const response = await fetch(url, { method: "POST", headers: step.headers, body: step.body });
                  log(`POST ${url} -> ${response.status} body ${JSON.stringify(await response.text())}`);
                } catch (error) {
                  log(`POST ${url} threw ${String(error)}`);
                }
                break;
              }
              case "describe": {
                const place = "why" in step.place ? step.place : located(step.place);
                log(`${step.c} describe -> ${JSON.stringify(await client(step.c).describe(place))}`);
                break;
              }
              case "check":
                log(`${step.c} check -> ${JSON.stringify(client(step.c).check({ ...step.outgoing, path: origins.fill(step.outgoing.path) }))}`);
                break;
              case "blocked":
                try {
                  client(step.c).blocked(step.reason);
                } catch (error) {
                  log(`${step.c} blocked threw ${String(error)}`);
                }
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
    await origins.close();
  }
  return out.lines;
}

function scenarios(list: readonly Scenario[], expected: Expected): void {
  for (const scenario of list) {
    const want = expected[scenario.key]?.["client"];
    const rules = (scenario.rules ?? []).map((rule) => `rule ${describe({ ...rule })}; `).join("");
    const steps = scenario.steps.map((step) => describe(step, 50)).join("; ");
    test(`${scenario.key}${scenario.ids.length === 0 ? "" : ` ${scenario.ids.join(", ")}`}: client: ${rules}steps: ${steps} => ${want === undefined ? "(no expected record)" : summarize(want)}`, async () => {
      const [key, variant, actual] = [scenario.key, "client", await run(scenario)];
      assert.ok(want !== undefined, `no expected record for ${key} in ${variant}`);
      assert.deepEqual(actual, want);
    });
  }
}

const GW = { base: "http://{gw}/v1", context: [["authorization", "Bearer k"]] } as const;
const key = (k: string): Place => ({ base: "http://{gw}/v1", context: [["authorization", `Bearer ${k}`]] });

const LIST: readonly Scenario[] = [
  {
    key: "r01",
    ids: ["C1", "C6"],
    rules: [{ on: "detection", reply: { status: 200, body: { route_policy: "1" }, hold: "gd" } }],
    steps: [
      { do: "client", as: "A", held: "zdr", timeoutMs: 200 },
      { do: "decide", c: "A", place: GW, model: "demo-model", atLeastMs: 190 },
    ],
  },
  {
    key: "r02",
    ids: ["C1", "C14"],
    steps: [
      { do: "client", as: "A", held: "zdr" },
      { do: "decide", c: "A", id: "d1", place: GW, model: "demo-model" },
      { do: "release", c: "A", from: "d1", header: "zdr", bodies: 257 },
      { do: "post", body: "b0", headers: { authorization: "Bearer k", "route-policy": "zdr" } },
      { do: "post", body: "b1", headers: { authorization: "Bearer k", "route-policy": "zdr" } },
      { do: "post", body: "b256", headers: { authorization: "Bearer k", "route-policy": "zdr" } },
    ],
  },
  {
    key: "r03",
    ids: ["C1", "C6", "C12", "C13", "C14"],
    rules: [
      { on: "detection", header: ["authorization", "Bearer kp"], reply: { status: 200, body: { route_policy: "1", key_policy: "only=aurora" } } },
      { on: "detection", header: ["authorization", "Bearer ku"], reply: { status: 200, body: { route_policy: "1", keys: ["zdr", "future"], key_policy: "zdr+future" } } },
      { on: "detection", header: ["authorization", "Bearer k404"], reply: { status: 404, body: {} } },
      { on: "detection", header: ["authorization", "Bearer ktext"], reply: { status: 200, raw: "{" } },
    ],
    steps: [
      { do: "client", as: "A" },
      { do: "describe", c: "A", place: { base: "http://{gw}/v1" } },
      { do: "describe", c: "A", place: { base: "http://{gw}/v1", context: [["traceparent", "00-1"]] } },
      { do: "describe", c: "A", place: { base: "http://{gw}/v1", context: [["authorization", "  "]] } },
      { do: "describe", c: "A", place: key("k") },
      { do: "describe", c: "A", place: { base: "http://{gw}/v1/", query: "?t=1", context: [["authorization", "Bearer k"], ["cookie", "a=1"], ["x-api-key", "x"]] } },
      { do: "describe", c: "A", place: key("kp") },
      { do: "describe", c: "A", place: key("ku") },
      { do: "describe", c: "A", place: key("k404") },
      { do: "describe", c: "A", place: key("ktext") },
      { do: "describe", c: "A", place: { base: "http://127.0.0.1:1/v1", context: [["authorization", "Bearer k"]] } },
      { do: "describe", c: "A", place: { base: "http://{gw}/v1", query: "?tag=O%27Brien", context: [["authorization", "Bearer k"]], unexact: "its query would be sent otherwise" } },
      { do: "describe", c: "A", place: { why: "the harness did not say which model and base URL the request is for" } },
      { do: "blocked", c: "A", reason: "no valid detection reply" },
      { do: "describe", c: "A", place: key("k") },
      { do: "describe", c: "A", place: key("k") },
    ],
  },
  {
    key: "r04",
    ids: ["C14", "C15", "C16"],
    rules: [{ on: "detection", nth: 1, reply: { status: 200, body: { route_policy: "1", key_policy: "only=nosuch" } } }, { on: "detection", nth: 2, reply: { status: 200, body: { route_policy: "1", key_policy: "only=aurora" } } }],
    steps: [
      { do: "client", as: "A", held: "zdr" },
      { do: "decide", c: "A", place: GW, model: "demo-model" },
      { do: "hold", c: "A", policy: null },
      { do: "decide", c: "A", place: GW, model: "demo-model" },
      { do: "client", as: "B" },
      { do: "decide", c: "B", place: GW, model: "demo-model" },
      { do: "hold", c: "B", policy: "zdr" },
      { do: "decide", c: "B", place: GW, model: "demo-model" },
      { do: "hold", c: "B", policy: null },
      { do: "decide", c: "B", place: GW, model: "demo-model" },
      { do: "decide", c: "A", place: GW, model: "demo-model" },
    ],
  },
  {
    key: "r05",
    ids: ["C14"],
    steps: [
      { do: "client", as: "A", held: "zdr", ownFetch: true },
      { do: "decide", c: "A", place: GW, model: "demo-model" },
      { do: "describe", c: "A", place: { base: "http://{gw}/v1", query: "?t=2", context: [["authorization", "Bearer k"]] } },
    ],
  },
  {
    key: "r06",
    ids: ["C1", "C14"],
    steps: [
      { do: "client", as: "A" },
      { do: "check", c: "A", outgoing: { path: "http://{gw}/v1/chat/completions", query: "", method: "POST", context: [], header: "zdr", body: "{}" } },
      { do: "decide", c: "A", place: GW, model: "demo-model" },
      { do: "check", c: "A", outgoing: { path: "http://{gw}/v1/chat/completions", query: "", method: "POST", context: [["authorization", "Bearer k"]], header: null, body: '{"model":"demo-model"}' } },
      { do: "check", c: "A", outgoing: { path: "http://{gw}/v1/chat/completions", query: "", method: "POST", context: [["authorization", "Bearer k"]], header: null, body: '{"model":"demo-model+zdr"}' } },
      { do: "check", c: "A", outgoing: { path: "http://{gw}/v1/chat/completions", query: "", method: "POST", context: [["authorization", "Bearer k"], ["cookie", "c"]], header: "zdr", body: '{"model":"demo-model"}' } },
      { do: "check", c: "A", outgoing: { path: "http://{gw}/v1/chat/completions", query: "", method: "POST", context: [], header: null, body: null } },
      { do: "check", c: "A", outgoing: { path: "http://{gw}/v1/chat/completions", query: "", method: "POST", context: [], header: null, body: '{"model":7}' } },
      { do: "check", c: "A", outgoing: { path: "http://{gw}/v1/chat/completions", query: "", method: "POST", context: [], header: null, body: "" } },
      { do: "check", c: "A", outgoing: { path: "http://{gw}/v12/chat/completions", query: "", method: "POST", context: [], header: "zdr", body: "{}" } },
      { do: "hold", c: "A", policy: "sort=price" },
      { do: "check", c: "A", outgoing: { path: "http://{gw}/v1/chat/completions", query: "", method: "POST", context: [], header: null, body: '{"model":"demo-model"}' } },
      { do: "hold", c: "A", policy: "zdr+zdr" },
      { do: "check", c: "A", outgoing: { path: "http://{gw}/v1/chat/completions", query: "", method: "POST", context: [], header: null, body: '{"model":"demo-model"}' } },
    ],
  },
  {
    key: "r07",
    ids: [],
    steps: [
      { do: "client", as: "A", reportThrows: true },
      { do: "blocked", c: "A", reason: "no valid detection reply" },
      { do: "describe", c: "A", place: { why: "the harness did not say which model and base URL the request is for" } },
    ],
  },
];

const EXPECTED: Expected = {
  r01: {
    client: [
      "== client as=A held=zdr timeoutMs=200",
      "== decide c=A place={\"base\":\"http://{gw}/v1\",\"context\":[[\"authorization\",\"Bearer k\"]]} model=demo-model atLeastMs=190",
      "gw <- GET /v1/route-policy | host: {gw} | connection: keep-alive | authorization: Bearer k | accept: application/json | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | body \"\"",
      "fetch failed: GET http://{gw}/v1/route-policy: TimeoutError: The operation was aborted due to timeout",
      "A decide -> {\"decision\":{\"action\":\"block\",\"reason\":\"http://{gw}/v1 has no valid detection reply (detection could not be fetched: The operation was aborted due to timeout), so no requirement may be sent there\"},\"target\":{\"base\":\"http://{gw}/v1\",\"query\":\"\",\"context\":[[\"authorization\",\"Bearer k\"]]},\"unexact\":null,\"generation\":0}",
      "A decide took at least 190 ms: true",
    ],
  },
  r02: {
    client: [
      "== client as=A held=zdr",
      "== decide c=A id=d1 place={\"base\":\"http://{gw}/v1\",\"context\":[[\"authorization\",\"Bearer k\"]]} model=demo-model",
      "gw <- GET /v1/route-policy | host: {gw} | connection: keep-alive | authorization: Bearer k | accept: application/json | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | body \"\"",
      "gw <- GET /v1/models | host: {gw} | connection: keep-alive | authorization: Bearer k | accept: application/json | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | body \"\"",
      "A decide -> {\"decision\":{\"action\":\"send\",\"model\":\"demo-model\",\"header\":\"zdr\",\"sent\":{\"zdr\":true,\"notrain\":false,\"bits\":null,\"region\":null,\"attest\":[],\"only\":null,\"ignore\":[],\"sort\":null,\"order\":null},\"routes\":[[\"aurora\",{\"facts\":{\"zdr\":true,\"notrain\":true,\"bits\":8,\"region\":[\"us\"],\"attest\":[]},\"evidence\":null}],[\"basalt\",{\"facts\":{\"zdr\":false,\"notrain\":false,\"bits\":16,\"region\":[\"us\",\"de\"],\"attest\":[\"weights\",\"prompt\"]},\"evidence\":\"https://basalt.example/attestation\"}],[\"cobalt\",{\"facts\":{\"zdr\":false,\"notrain\":false,\"bits\":null,\"region\":null,\"attest\":[]},\"evidence\":null}]]},\"target\":{\"base\":\"http://{gw}/v1\",\"query\":\"\",\"context\":[[\"authorization\",\"Bearer k\"]]},\"unexact\":null,\"generation\":0}",
      "== release c=A from=d1 header=zdr bodies=257",
      "== post body=b0 headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"}",
      "POST http://{gw}/v1/chat/completions threw Error: Blocked by the route policy plugin, nothing was sent: this request to http://{gw}/v1/chat/completions carries a Route-Policy header, and no session checked http://{gw}/v1/chat/completions for it",
      "== post body=b1 headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 2 | body \"b1\"",
      "A report {\"kind\":\"honored\",\"provider\":\"aurora\",\"checked\":true,\"evidence\":null} subject \"request for demo-model to http://{gw}/v1\"",
      "POST http://{gw}/v1/chat/completions -> 200 body \"{\\\"choices\\\":[]}\"",
      "== post body=b256 headers={\"authorization\":\"Bearer k\",\"route-policy\":\"zdr\"}",
      "gw <- POST /v1/chat/completions | host: {gw} | connection: keep-alive | authorization: Bearer k | route-policy: zdr | content-type: text/plain;charset=UTF-8 | accept: */* | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | content-length: 4 | body \"b256\"",
      "A report {\"kind\":\"honored\",\"provider\":\"aurora\",\"checked\":true,\"evidence\":null} subject \"request for demo-model to http://{gw}/v1\"",
      "POST http://{gw}/v1/chat/completions -> 200 body \"{\\\"choices\\\":[]}\"",
    ],
  },
  r03: {
    client: [
      "== client as=A",
      "== describe c=A place={\"base\":\"http://{gw}/v1\"}",
      "gw <- GET /v1/route-policy | host: {gw} | connection: keep-alive | accept: application/json | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | body \"\"",
      "A describe -> \"Route policy: none\\nGateway http://{gw}/v1, read without a credential: detection valid; accepts zdr, notrain, bits, region, attest, only, ignore, sort, order\\nKey policy: unknown, the request carries no credential\\nLast result: none yet in this session\"",
      "== describe c=A place={\"base\":\"http://{gw}/v1\",\"context\":[[\"traceparent\",\"00-1\"]]}",
      "gw <- GET /v1/route-policy | host: {gw} | connection: keep-alive | traceparent: 00-1 | accept: application/json | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | body \"\"",
      "A describe -> \"Route policy: none\\nGateway http://{gw}/v1, read without a credential: detection valid; accepts zdr, notrain, bits, region, attest, only, ignore, sort, order\\nKey policy: unknown, the request carries no credential\\nLast result: none yet in this session\"",
      "== describe c=A place={\"base\":\"http://{gw}/v1\",\"context\":[[\"authorization\",\"  \"]]}",
      "gw <- GET /v1/route-policy | host: {gw} | connection: keep-alive | authorization:  | accept: application/json | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | body \"\"",
      "A describe -> \"Route policy: none\\nGateway http://{gw}/v1, read without a credential: detection valid; accepts zdr, notrain, bits, region, attest, only, ignore, sort, order\\nKey policy: unknown, the request carries no credential\\nLast result: none yet in this session\"",
      "== describe c=A place={\"base\":\"http://{gw}/v1\",\"context\":[[\"authorization\",\"Bearer k\"]]}",
      "gw <- GET /v1/route-policy | host: {gw} | connection: keep-alive | authorization: Bearer k | accept: application/json | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | body \"\"",
      "A describe -> \"Route policy: none\\nGateway http://{gw}/v1, read with the credential in authorization: detection valid; accepts zdr, notrain, bits, region, attest, only, ignore, sort, order\\nKey policy: none\\nLast result: none yet in this session\"",
      "== describe c=A place={\"base\":\"http://{gw}/v1/\",\"query\":\"?t=1\",\"context\":[[\"authorization\",\"Bearer k\"],[\"cookie\",\"a=1\"],[\"x-api-key\",\"x\"]]}",
      "gw <- GET /v1/route-policy?t=1 | host: {gw} | connection: keep-alive | authorization: Bearer k | cookie: a=1 | x-api-key: x | accept: application/json | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | body \"\"",
      "A describe -> \"Route policy: none\\nGateway http://{gw}/v1?t=1, read with the credential in authorization, cookie, x-api-key: detection valid; accepts zdr, notrain, bits, region, attest, only, ignore, sort, order\\nKey policy: none\\nLast result: none yet in this session\"",
      "== describe c=A place={\"base\":\"http://{gw}/v1\",\"context\":[[\"authorization\",\"Bearer kp\"]]}",
      "gw <- GET /v1/route-policy | host: {gw} | connection: keep-alive | authorization: Bearer kp | accept: application/json | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | body \"\"",
      "A describe -> \"Route policy: none\\nGateway http://{gw}/v1, read with the credential in authorization: detection valid; accepts zdr, notrain, bits, region, attest, only, ignore, sort, order\\nKey policy (locked, applied by the gateway to every request with this key): only=aurora\\nLast result: none yet in this session\"",
      "== describe c=A place={\"base\":\"http://{gw}/v1\",\"context\":[[\"authorization\",\"Bearer ku\"]]}",
      "gw <- GET /v1/route-policy | host: {gw} | connection: keep-alive | authorization: Bearer ku | accept: application/json | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | body \"\"",
      "A describe -> \"Route policy: none\\nGateway http://{gw}/v1, read with the credential in authorization: detection valid; accepts zdr\\nKey policy (locked): \\\"zdr+future\\\", which this client cannot interpret; shown as text and relied on for nothing\\nLast result: none yet in this session\"",
      "== describe c=A place={\"base\":\"http://{gw}/v1\",\"context\":[[\"authorization\",\"Bearer k404\"]]}",
      "gw <- GET /v1/route-policy | host: {gw} | connection: keep-alive | authorization: Bearer k404 | accept: application/json | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | body \"\"",
      "A describe -> \"Route policy: none\\nGateway http://{gw}/v1, read with the credential in authorization: no detection (detection reply is not valid: status is 404, not 200)\\nLast result: none yet in this session\"",
      "== describe c=A place={\"base\":\"http://{gw}/v1\",\"context\":[[\"authorization\",\"Bearer ktext\"]]}",
      "gw <- GET /v1/route-policy | host: {gw} | connection: keep-alive | authorization: Bearer ktext | accept: application/json | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | body \"\"",
      "A describe -> \"Route policy: none\\nGateway http://{gw}/v1, read with the credential in authorization: no detection (detection reply is not valid: not a JSON object)\\nLast result: none yet in this session\"",
      "== describe c=A place={\"base\":\"http://127.0.0.1:1/v1\",\"context\":[[\"authorization\",\"Bearer k\"]]}",
      "fetch failed: GET http://127.0.0.1:1/v1/route-policy: TypeError: fetch failed",
      "A describe -> \"Route policy: none\\nGateway http://127.0.0.1:1/v1, read with the credential in authorization: no detection (detection could not be fetched: fetch failed)\\nLast result: none yet in this session\"",
      "== describe c=A place={\"base\":\"http://{gw}/v1\",\"query\":\"?tag=O%27Brien\",\"context\":[[\"authorization\",\"Bearer k\"]],\"unexact\":\"its query would be sent otherwise\"}",
      "A describe -> \"Route policy: none\\nGateway http://{gw}/v1?tag=O%27Brien, read with the credential in authorization: no detection (its query would be sent otherwise)\\nLast result: none yet in this session\"",
      "== describe c=A place={\"why\":\"the harness did not say which model and base URL the request is for\"}",
      "A describe -> \"Route policy: none\\nGateway: unknown, nothing was read (the harness did not say which model and base URL the request is for)\\nLast result: none yet in this session\"",
      "== blocked c=A reason=no valid detection reply",
      "A report {\"kind\":\"blocked\",\"reason\":\"no valid detection reply\"} subject null",
      "== describe c=A place={\"base\":\"http://{gw}/v1\",\"context\":[[\"authorization\",\"Bearer k\"]]}",
      "A describe -> \"Route policy: none\\nGateway http://{gw}/v1, read with the credential in authorization: detection valid; accepts zdr, notrain, bits, region, attest, only, ignore, sort, order\\nKey policy: none\\nLast result: request blocked by the route policy plugin, nothing was sent: no valid detection reply\"",
      "== describe c=A place={\"base\":\"http://{gw}/v1\",\"context\":[[\"authorization\",\"Bearer k\"]]}",
      "A describe -> \"Route policy: none\\nGateway http://{gw}/v1, read with the credential in authorization: detection valid; accepts zdr, notrain, bits, region, attest, only, ignore, sort, order\\nKey policy: none\\nLast result: request blocked by the route policy plugin, nothing was sent: no valid detection reply\"",
    ],
  },
  r04: {
    client: [
      "== client as=A held=zdr",
      "== decide c=A place={\"base\":\"http://{gw}/v1\",\"context\":[[\"authorization\",\"Bearer k\"]]} model=demo-model",
      "gw <- GET /v1/route-policy | host: {gw} | connection: keep-alive | authorization: Bearer k | accept: application/json | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | body \"\"",
      "gw <- GET /v1/models | host: {gw} | connection: keep-alive | authorization: Bearer k | accept: application/json | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | body \"\"",
      "A decide -> {\"decision\":{\"action\":\"block\",\"reason\":\"no route the model list publishes for demo-model meets the policy combined with the key's own, so the gateway would refuse it only after receiving the content\"},\"target\":{\"base\":\"http://{gw}/v1\",\"query\":\"\",\"context\":[[\"authorization\",\"Bearer k\"]]},\"unexact\":null,\"generation\":0}",
      "== hold c=A policy=null",
      "== decide c=A place={\"base\":\"http://{gw}/v1\",\"context\":[[\"authorization\",\"Bearer k\"]]} model=demo-model",
      "A decide -> {\"decision\":{\"action\":\"block\",\"reason\":\"no route the model list publishes for demo-model meets the key's own policy, so the gateway would refuse it only after receiving the content\"},\"target\":{\"base\":\"http://{gw}/v1\",\"query\":\"\",\"context\":[[\"authorization\",\"Bearer k\"]]},\"unexact\":null,\"generation\":0}",
      "== client as=B",
      "== decide c=B place={\"base\":\"http://{gw}/v1\",\"context\":[[\"authorization\",\"Bearer k\"]]} model=demo-model",
      "B decide -> {\"decision\":{\"action\":\"send\",\"model\":\"demo-model\",\"header\":null,\"sent\":null,\"routes\":null},\"target\":{\"base\":\"http://{gw}/v1\",\"query\":\"\",\"context\":[[\"authorization\",\"Bearer k\"]]},\"unexact\":null,\"generation\":0}",
      "== hold c=B policy=zdr",
      "== decide c=B place={\"base\":\"http://{gw}/v1\",\"context\":[[\"authorization\",\"Bearer k\"]]} model=demo-model",
      "gw <- GET /v1/route-policy | host: {gw} | connection: keep-alive | authorization: Bearer k | accept: application/json | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | body \"\"",
      "gw <- GET /v1/models | host: {gw} | connection: keep-alive | authorization: Bearer k | accept: application/json | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | body \"\"",
      "B decide -> {\"decision\":{\"action\":\"send\",\"model\":\"demo-model\",\"header\":\"zdr\",\"sent\":{\"zdr\":true,\"notrain\":false,\"bits\":null,\"region\":null,\"attest\":[],\"only\":null,\"ignore\":[],\"sort\":null,\"order\":null},\"routes\":[[\"aurora\",{\"facts\":{\"zdr\":true,\"notrain\":true,\"bits\":8,\"region\":[\"us\"],\"attest\":[]},\"evidence\":null}],[\"basalt\",{\"facts\":{\"zdr\":false,\"notrain\":false,\"bits\":16,\"region\":[\"us\",\"de\"],\"attest\":[\"weights\",\"prompt\"]},\"evidence\":\"https://basalt.example/attestation\"}],[\"cobalt\",{\"facts\":{\"zdr\":false,\"notrain\":false,\"bits\":null,\"region\":null,\"attest\":[]},\"evidence\":null}]]},\"target\":{\"base\":\"http://{gw}/v1\",\"query\":\"\",\"context\":[[\"authorization\",\"Bearer k\"]]},\"unexact\":null,\"generation\":0}",
      "== hold c=B policy=null",
      "== decide c=B place={\"base\":\"http://{gw}/v1\",\"context\":[[\"authorization\",\"Bearer k\"]]} model=demo-model",
      "B decide -> {\"decision\":{\"action\":\"send\",\"model\":\"demo-model\",\"header\":null,\"sent\":null,\"routes\":[[\"aurora\",{\"facts\":{\"zdr\":true,\"notrain\":true,\"bits\":8,\"region\":[\"us\"],\"attest\":[]},\"evidence\":null}],[\"basalt\",{\"facts\":{\"zdr\":false,\"notrain\":false,\"bits\":16,\"region\":[\"us\",\"de\"],\"attest\":[\"weights\",\"prompt\"]},\"evidence\":\"https://basalt.example/attestation\"}],[\"cobalt\",{\"facts\":{\"zdr\":false,\"notrain\":false,\"bits\":null,\"region\":null,\"attest\":[]},\"evidence\":null}]]},\"target\":{\"base\":\"http://{gw}/v1\",\"query\":\"\",\"context\":[[\"authorization\",\"Bearer k\"]]},\"unexact\":null,\"generation\":0}",
      "== decide c=A place={\"base\":\"http://{gw}/v1\",\"context\":[[\"authorization\",\"Bearer k\"]]} model=demo-model",
      "A decide -> {\"decision\":{\"action\":\"block\",\"reason\":\"no route the model list publishes for demo-model meets the key's own policy, so the gateway would refuse it only after receiving the content\"},\"target\":{\"base\":\"http://{gw}/v1\",\"query\":\"\",\"context\":[[\"authorization\",\"Bearer k\"]]},\"unexact\":null,\"generation\":0}",
    ],
  },
  r05: {
    client: [
      "== client as=A held=zdr ownFetch=true",
      "== decide c=A place={\"base\":\"http://{gw}/v1\",\"context\":[[\"authorization\",\"Bearer k\"]]} model=demo-model",
      "A own fetch GET http://{gw}/v1/route-policy",
      "gw <- GET /v1/route-policy | host: {gw} | connection: keep-alive | authorization: Bearer k | accept: application/json | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | body \"\"",
      "A own fetch GET http://{gw}/v1/models",
      "gw <- GET /v1/models | host: {gw} | connection: keep-alive | authorization: Bearer k | accept: application/json | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | body \"\"",
      "A decide -> {\"decision\":{\"action\":\"send\",\"model\":\"demo-model\",\"header\":\"zdr\",\"sent\":{\"zdr\":true,\"notrain\":false,\"bits\":null,\"region\":null,\"attest\":[],\"only\":null,\"ignore\":[],\"sort\":null,\"order\":null},\"routes\":[[\"aurora\",{\"facts\":{\"zdr\":true,\"notrain\":true,\"bits\":8,\"region\":[\"us\"],\"attest\":[]},\"evidence\":null}],[\"basalt\",{\"facts\":{\"zdr\":false,\"notrain\":false,\"bits\":16,\"region\":[\"us\",\"de\"],\"attest\":[\"weights\",\"prompt\"]},\"evidence\":\"https://basalt.example/attestation\"}],[\"cobalt\",{\"facts\":{\"zdr\":false,\"notrain\":false,\"bits\":null,\"region\":null,\"attest\":[]},\"evidence\":null}]]},\"target\":{\"base\":\"http://{gw}/v1\",\"query\":\"\",\"context\":[[\"authorization\",\"Bearer k\"]]},\"unexact\":null,\"generation\":0}",
      "== describe c=A place={\"base\":\"http://{gw}/v1\",\"query\":\"?t=2\",\"context\":[[\"authorization\",\"Bearer k\"]]}",
      "A own fetch GET http://{gw}/v1/route-policy?t=2",
      "gw <- GET /v1/route-policy?t=2 | host: {gw} | connection: keep-alive | authorization: Bearer k | accept: application/json | accept-language: * | sec-fetch-mode: cors | user-agent: node | accept-encoding: gzip, deflate | body \"\"",
      "A describe -> \"Route policy: zdr (from ROUTE_POLICY)\\nGateway http://{gw}/v1?t=2, read with the credential in authorization: detection valid; accepts zdr, notrain, bits, region, attest, only, ignore, sort, order\\nKey policy: none\\nLast result: none yet in this session\"",
    ],
  },
  r06: {
    client: [
      "== client as=A",
      "== check c=A outgoing={\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[],\"header\":\"zdr\",\"body\":\"{}\"}",
      "A check -> null",
      "== decide c=A place={\"base\":\"http://{gw}/v1\",\"context\":[[\"authorization\",\"Bearer k\"]]} model=demo-model",
      "A decide -> {\"decision\":{\"action\":\"send\",\"model\":\"demo-model\",\"header\":null,\"sent\":null,\"routes\":null},\"target\":{\"base\":\"http://{gw}/v1\",\"query\":\"\",\"context\":[[\"authorization\",\"Bearer k\"]]},\"unexact\":null,\"generation\":0}",
      "== check c=A outgoing={\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":null,\"body\":\"{\\\"model\\\":\\\"demo-model\\\"}\"}",
      "A check -> null",
      "== check c=A outgoing={\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"]],\"header\":null,\"body\":\"{\\\"model\\\":\\\"demo-model+zdr\\\"}\"}",
      "A check -> \"this request to http://{gw}/v1 is not one the plugin released: its URL, headers (it carries authorization besides the usual ones), body, or Route-Policy header differs from what was checked, or it was already sent once\"",
      "== check c=A outgoing={\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[[\"authorization\",\"Bearer k\"],[\"cookie\",\"c\"]],\"header\":\"zdr\",\"body\":\"{\\\"model\\\":\\\"demo-model\\\"}\"}",
      "A check -> \"this request to http://{gw}/v1 is not one the plugin released: its URL, headers (it carries authorization, cookie besides the usual ones), body, or Route-Policy header differs from what was checked, or it was already sent once\"",
      "== check c=A outgoing={\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[],\"header\":null,\"body\":null}",
      "A check -> \"this request to http://{gw}/v1 is not one the plugin released: its URL, headers (it carries none besides the usual ones), body, or Route-Policy header differs from what was checked, or it was already sent once\"",
      "== check c=A outgoing={\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[],\"header\":null,\"body\":\"{\\\"model\\\":7}\"}",
      "A check -> \"this request to http://{gw}/v1 is not one the plugin released: its URL, headers (it carries none besides the usual ones), body, or Route-Policy header differs from what was checked, or it was already sent once\"",
      "== check c=A outgoing={\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[],\"header\":null,\"body\":\"\"}",
      "A check -> null",
      "== check c=A outgoing={\"path\":\"http://{gw}/v12/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[],\"header\":\"zdr\",\"body\":\"{}\"}",
      "A check -> null",
      "== hold c=A policy=sort=price",
      "== check c=A outgoing={\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[],\"header\":null,\"body\":\"{\\\"model\\\":\\\"demo-model\\\"}\"}",
      "A check -> \"this request to http://{gw}/v1 is not one the plugin released: its URL, headers (it carries none besides the usual ones), body, or Route-Policy header differs from what was checked, or it was already sent once\"",
      "== hold c=A policy=zdr+zdr",
      "== check c=A outgoing={\"path\":\"http://{gw}/v1/chat/completions\",\"query\":\"\",\"method\":\"POST\",\"context\":[],\"header\":null,\"body\":\"{\\\"model\\\":\\\"demo-model\\\"}\"}",
      "A check -> \"this request to http://{gw}/v1 is not one the plugin released: its URL, headers (it carries none besides the usual ones), body, or Route-Policy header differs from what was checked, or it was already sent once\"",
    ],
  },
  r07: {
    client: [
      "== client as=A reportThrows=true",
      "== blocked c=A reason=no valid detection reply",
      "A report {\"kind\":\"blocked\",\"reason\":\"no valid detection reply\"} subject null",
      "A blocked threw Error: onReport is gone",
      "== describe c=A place={\"why\":\"the harness did not say which model and base URL the request is for\"}",
      "A describe -> \"Route policy: none\\nGateway: unknown, nothing was read (the harness did not say which model and base URL the request is for)\\nLast result: request blocked by the route policy plugin, nothing was sent: no valid detection reply\"",
    ],
  },
};

scenarios(LIST, EXPECTED);
