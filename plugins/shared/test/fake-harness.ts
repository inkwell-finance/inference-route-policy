// A stand-in for omp's and pi's extension runtime, faithful where the plugin's safety depends on it: a handler's
// error is caught and the request goes on with the payload it had (both harnesses do that), `null` deletes a
// header (pi), and the transport serializes the payload before it sends anything, through the global fetch.
// Everything the plugin does through it is written to the scenario's log, in order: each hook's result, each UI
// call, each key lookup, each entry, each request the transport attempts and the response the caller gets.

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { ExtensionAPI } from "../src/plugin.ts";
import { brief, deadline, Log, log, Origins, recording, settle, summarize, type Expected, type Rule } from "./wire.ts";

export interface Adapter {
  name: string;
  register: (api: ExtensionAPI) => void;
  /** Whether the harness has `before_provider_headers` (pi) or not (omp). */
  headerHook: boolean;
}

/** What `modelRegistry.getApiKeyAndHeaders` does: resolves to `result`, throws, or never settles. */
export type Auth = { result: unknown } | { throws: string } | "never";
export type Channel = "works" | "throws" | "absent";

export interface SessionConfig {
  /** Merged over the session's model, which starts as demo-model at http://{gw}/v1 over openai-completions. */
  model?: Readonly<Record<string, unknown>>;
  /** One lookup's behavior, or one per lookup in order, the last repeating. Default: ok with key demo-key. */
  auth?: Auth | readonly Auth[];
  /** Each UI callback works, throws, or is absent; null when the context has no `ui` at all. */
  ui?: { notify?: Channel; setStatus?: Channel } | null;
  /** A member of the context whose accessor throws; null for none again. */
  throws?: "model" | "ui" | "modelRegistry" | "sessionManager" | null;
  wire?: Wire;
}

/** What the transport sends beyond what the plugin decided: the key, other headers, another URL. */
export interface Wire {
  /** The key the transport sends where the API puts it; "demo-key" by default, none when null. */
  key?: string | null;
  /** Headers the transport adds on its own, before the configured ones. */
  extra?: Readonly<Record<string, string>>;
  /** The URL it posts to instead of {baseUrl}/chat/completions. */
  url?: string;
  /** Changes made last, as a transport the plugin cannot see into might. */
  rewrite?: readonly (readonly ["set" | "append", string, string] | readonly ["delete", string])[];
}

/** A payload: a plain object; with `$toJSON`, one whose own toJSON returns that value; or one whose accessor throws. */
export type Payload = Readonly<Record<string, unknown>>;

export type Step =
  | { do: "request"; s?: number; payload?: Payload }
  | { do: "start"; id: string; s?: number; payload?: Payload }
  | { do: "finish"; id: string }
  | { do: "prepare"; id: string; s?: number; payload?: Payload }
  | { do: "send"; id: string }
  | { do: "headers"; s?: number; as?: string; headers?: Readonly<Record<string, unknown>> | "none" }
  | { do: "payload"; s?: number; as?: string; payload?: Payload | "throws" }
  | { do: "post"; s?: number; headers?: string; body?: string }
  | { do: "route"; s?: number; args: string }
  | { do: "emit"; s?: number; event: string }
  | ({ do: "set"; s?: number } & SessionConfig)
  | { do: "open"; s: number; copy?: number; branch?: readonly unknown[] }
  | { do: "await-held"; gate: string }
  | { do: "release"; gate: string }
  | { do: "tick"; ms: number }
  /** Replaces the session's branch, as moving within the session tree does. */
  | { do: "branch"; s?: number; entries: readonly unknown[] };

export interface Scenario {
  /** A short handle, used to find the scenario's expected record. */
  key: string;
  /** The requirements this scenario is a case of. */
  ids: readonly string[];
  env?: { ROUTE_POLICY?: string };
  /** Loopback origins besides "gw", which always runs. */
  origins?: readonly string[];
  rules?: readonly Rule[];
  /** Session 1's configuration, opened before the first step. */
  session?: SessionConfig;
  /** Mock setTimeout for the whole scenario, so `tick` steps move the plugin's deadlines. */
  timers?: boolean;
  steps: readonly Step[];
}

type Handler = (event: unknown, ctx: unknown) => unknown;

const DEFAULT_MESSAGES = [{ role: "user", content: "secret prompt" }];

/** A step, a rule, or a configuration as one compact line: its fields in order, values in short JSON. */
export function describe(value: object, max = 80): string {
  return Object.entries(value)
    .map(([key, v]) => (key === "do" ? String(v) : `${key}=${brief(v, max)}`))
    .join(" ");
}

/** A scenario's inputs as a title's left-hand side. */
export function describeScenario(scenario: Scenario): string {
  const parts: string[] = [];
  if (scenario.env?.ROUTE_POLICY !== undefined) parts.push(`ROUTE_POLICY=${scenario.env.ROUTE_POLICY}`);
  if (scenario.origins !== undefined) parts.push(`origins ${scenario.origins.join(",")}`);
  for (const rule of scenario.rules ?? []) parts.push(`rule ${describe({ ...rule })}`);
  if (scenario.session !== undefined) parts.push(`session ${describe({ ...scenario.session })}`);
  if (scenario.timers === true) parts.push("mocked timers");
  parts.push(`steps: ${scenario.steps.map((step) => describe(step, 50)).join("; ")}`);
  return parts.join("; ");
}

class Session {
  readonly n: number;
  readonly handlers = new Map<string, Handler[]>();
  readonly commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  readonly entries: unknown[] = [];
  readonly config: { model: Record<string, unknown>; auth: Auth | readonly Auth[]; ui: SessionConfig["ui"]; throws: SessionConfig["throws"]; wire: Wire };
  readonly saved = new Map<string, unknown>();
  #lookups = 0;
  readonly #origins: Origins;
  readonly #adapter: Adapter;

  constructor(n: number, adapter: Adapter, origins: Origins, config: SessionConfig) {
    this.n = n;
    this.#adapter = adapter;
    this.#origins = origins;
    this.config = { model: { id: "demo-model", baseUrl: "http://{gw}/v1", api: "openai-completions" }, auth: { result: { ok: true, apiKey: "demo-key" } }, ui: {}, throws: undefined, wire: {} };
    this.apply(config);
  }

  apply(config: SessionConfig): void {
    if (config.model !== undefined) this.config.model = { ...this.config.model, ...config.model };
    if (config.auth !== undefined) {
      this.config.auth = config.auth;
      this.#lookups = 0;
    }
    if (config.ui !== undefined) this.config.ui = config.ui;
    if (config.throws !== undefined) this.config.throws = config.throws;
    if (config.wire !== undefined) this.config.wire = config.wire;
  }

  #log(line: string): void {
    log(`[${this.n}] ${line}`);
  }

  /** The model as the context gives it: its text fields with {origin} filled in. */
  model(): Record<string, unknown> {
    const filled: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.config.model)) filled[key] = typeof value === "string" ? this.#origins.fill(value) : value;
    return filled;
  }

  readonly api: ExtensionAPI = {
    on: (event, handler) => this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]),
    registerCommand: (name, options) => {
      this.commands.set(name, options.handler);
      this.#log(`registerCommand ${name} ${JSON.stringify(options.description)}`);
    },
    appendEntry: (customType, data) => {
      this.entries.push({ type: "custom", customType, data });
      this.#log(`appendEntry ${customType} ${JSON.stringify(data)}`);
    },
  };

  register(): void {
    this.#adapter.register(this.api);
    this.#log(`handlers ${[...this.handlers].map(([event, list]) => `${event} x${list.length}`).join(", ")}`);
  }

  #lookup(model: unknown): Promise<unknown> {
    const plan = this.config.auth;
    const list: readonly Auth[] = Array.isArray(plan) ? plan : [plan as Auth];
    const auth = list[Math.min(this.#lookups, list.length - 1)];
    this.#lookups += 1;
    const id = typeof model === "object" && model !== null && "id" in model ? JSON.stringify(model.id) : "?";
    if (auth === undefined || auth === "never") {
      this.#log(`getApiKeyAndHeaders ${id} -> never settles`);
      return new Promise(() => {});
    }
    if ("throws" in auth) {
      this.#log(`getApiKeyAndHeaders ${id} -> throws ${auth.throws}`);
      return Promise.reject(new Error(auth.throws));
    }
    // Text in the result may name an origin, as a base URL the registry resolves does.
    const result: unknown = JSON.parse(this.#origins.fill(JSON.stringify(auth.result)));
    this.#log(`getApiKeyAndHeaders ${id} -> ${JSON.stringify(auth.result)}`);
    return Promise.resolve(result);
  }

  ctx(): unknown {
    const channel = (name: "notify" | "setStatus"): Channel => (this.config.ui === null ? "absent" : (this.config.ui?.[name] ?? "works"));
    const call = (name: "notify" | "setStatus", args: string): void => {
      if (channel(name) === "throws") {
        this.#log(`${name} ${args} (threw)`);
        throw new Error(`${name} is gone`);
      }
      this.#log(`${name} ${args}`);
    };
    const ui: Record<string, unknown> = {};
    if (channel("notify") !== "absent") ui["notify"] = (message: unknown, type: unknown) => call("notify", `${String(type)} ${JSON.stringify(message)}`);
    if (channel("setStatus") !== "absent") ui["setStatus"] = (key: unknown, text: unknown) => call("setStatus", `${String(key)} ${text === undefined ? "undefined" : JSON.stringify(text)}`);
    const ctx: Record<string, unknown> = {
      model: this.model(),
      modelRegistry: { getApiKeyAndHeaders: (model: unknown) => this.#lookup(model) },
      sessionManager: { getBranch: () => this.entries },
    };
    if (this.config.ui !== null) ctx["ui"] = ui;
    const throwing = this.config.throws;
    if (throwing !== undefined && throwing !== null) {
      Object.defineProperty(ctx, throwing, {
        enumerable: true,
        get: () => {
          throw new Error(`the ${throwing} accessor is gone`);
        },
      });
    }
    return ctx;
  }

  /** Runs every handler for `event` in turn, as the runtime does: a throwing handler is logged and skipped. */
  async emit(event: string, payload: Record<string, unknown>, chain?: string): Promise<unknown> {
    let value = chain === undefined ? undefined : payload[chain];
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        const result = await handler(chain === undefined ? payload : { ...payload, [chain]: value }, this.ctx());
        if (chain !== undefined && result !== undefined) value = result;
      } catch (error) {
        this.#log(`handler error on ${event}: ${String(error)}`);
      }
    }
    return value;
  }

  /** The payload a step names, or the default one for the session's model. */
  #payload(spec: Payload | undefined): unknown {
    if (spec === undefined) return { model: this.config.model["id"], messages: DEFAULT_MESSAGES, stream: false };
    // { $value: x } is the payload x itself, for one that is not an object.
    if ("$value" in spec) return spec["$value"];
    if (!("$toJSON" in spec)) return { ...spec };
    const { $toJSON, ...rest } = spec;
    const n = this.n;
    return {
      ...rest,
      toJSON(): unknown {
        log(`[${n}] payload toJSON called`);
        return $toJSON;
      },
    };
  }

  /** The header hook alone (pi), on the configured headers, the given ones, or none at all ("none"). */
  async headers(given?: Readonly<Record<string, unknown>> | "none"): Promise<Record<string, unknown> | undefined> {
    if (given === "none") {
      await this.emit("before_provider_headers", { type: "before_provider_headers" });
      this.#log("before_provider_headers (no headers) -> done");
      return undefined;
    }
    const configured = given ?? (this.config.model["headers"] as Readonly<Record<string, unknown>> | undefined);
    const headers: Record<string, unknown> = { ...configured };
    await this.emit("before_provider_headers", { type: "before_provider_headers", headers });
    this.#log(`before_provider_headers -> ${JSON.stringify(headers)}`);
    return headers;
  }

  /** The payload hook alone; returns the serialized payload it handed back, or null when that throws. */
  async payload(spec: Payload | "throws" | undefined): Promise<string | null> {
    const event: Record<string, unknown> = { type: "before_provider_request" };
    if (spec === "throws") {
      Object.defineProperty(event, "payload", {
        enumerable: true,
        get: () => {
          throw new Error("payload unavailable");
        },
      });
    } else {
      event["payload"] = this.#payload(spec);
    }
    let final: unknown;
    let body: string | null;
    try {
      final = await this.#emitPayload(event);
      body = JSON.stringify(final) ?? null;
      this.#log(`before_provider_request -> ${body ?? "undefined"}`);
    } catch (error) {
      body = null;
      this.#log(`before_provider_request -> throws ${String(error)}`);
    }
    return body;
  }

  async #emitPayload(event: Record<string, unknown>): Promise<unknown> {
    let value: unknown;
    try {
      value = event["payload"];
    } catch {
      value = undefined;
    }
    for (const handler of this.handlers.get("before_provider_request") ?? []) {
      try {
        const result = await handler(event, this.ctx());
        if (result !== undefined) {
          value = result;
          event = { type: "before_provider_request", payload: result };
        }
      } catch (error) {
        this.#log(`handler error on before_provider_request: ${String(error)}`);
      }
    }
    return value;
  }

  /** The transport: the key where the API puts it, its own headers, the configured ones, then any rewrite. */
  async post(headers: Readonly<Record<string, unknown>> | undefined, body: string): Promise<void> {
    const model = this.model();
    const wire = new Headers({ "content-type": "application/json" });
    const { key = "demo-key", extra = {}, url, rewrite = [] } = this.config.wire;
    if (key !== null) {
      if (model["api"] === "anthropic-messages") wire.set("x-api-key", key);
      else if (model["api"] === "google-generative-ai") wire.set("x-goog-api-key", key);
      else wire.set("authorization", `Bearer ${key}`);
    }
    for (const [name, value] of Object.entries(extra)) wire.set(name, value);
    for (const [name, value] of Object.entries(headers ?? {})) if (value !== null && value !== undefined) wire.set(name, String(value));
    for (const op of rewrite) {
      if (op[0] === "delete") wire.delete(op[1]);
      else if (op[0] === "set") wire.set(op[1], op[2]);
      else wire.append(op[1], op[2]);
    }
    // The endpoint path goes after the base URL's path and before its query, as the providers' SDKs build it.
    const base = String(model["baseUrl"]);
    const cut = base.search(/[?#]/);
    const target = url !== undefined ? this.#origins.fill(url) : cut === -1 ? `${base}/chat/completions` : `${base.slice(0, cut)}/chat/completions${base.slice(cut)}`;
    let response: Response;
    try {
      response = await fetch(target, { method: "POST", headers: wire, body });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#log(`POST ${target} ${message.startsWith("Blocked by the route policy plugin") ? "stopped" : "failed"}: ${message}`);
      return;
    }
    const text = await response.text();
    const shown = [...response.headers].filter(([name]) => name !== "connection" && name !== "keep-alive").map(([name, value]) => `${name}: ${value}`);
    this.#log(`POST ${target} -> ${response.status} | ${shown.join(" | ")} | body ${JSON.stringify(text)}`);
  }

  /** One provider request as the harness makes it: hooks, serialization, then the HTTP call. */
  async prepare(spec: Payload | undefined): Promise<{ headers: Readonly<Record<string, unknown>> | undefined; body: string | null }> {
    const headers = this.#adapter.headerHook ? await this.headers() : (this.config.model["headers"] as Readonly<Record<string, unknown>> | undefined);
    const body = await this.payload(spec);
    return { headers, body };
  }

  async request(spec: Payload | undefined): Promise<void> {
    const { headers, body } = await this.prepare(spec);
    if (body !== null) await this.post(headers, body);
  }
}

/** Runs one scenario with one adapter and returns its log. */
export async function run(scenario: Scenario, adapter: Adapter): Promise<string[]> {
  const out = new Log();
  const origins = await Origins.start(out, ["gw", ...(scenario.origins ?? [])], scenario.rules ?? []);
  const sessions = new Map<number, Session>();
  const started = new Map<string, Promise<void>>();
  const prepared = new Map<string, { s: Session; headers: Readonly<Record<string, unknown>> | undefined; body: string | null }>();
  const saved = scenario.env?.ROUTE_POLICY;
  const before = process.env["ROUTE_POLICY"];
  if (saved === undefined) delete process.env["ROUTE_POLICY"];
  else process.env["ROUTE_POLICY"] = saved;
  const session = (n: number | undefined): Session => {
    const found = sessions.get(n ?? 1);
    assert.ok(found !== undefined, `session ${n ?? 1} is not open`);
    return found;
  };
  const open = async (n: number, copy?: number, branch?: readonly unknown[]): Promise<void> => {
    const s = new Session(n, adapter, origins, scenario.session ?? {});
    if (copy !== undefined) s.entries.push(...session(copy).entries);
    s.entries.push(...(branch ?? []));
    sessions.set(n, s);
    s.register();
    await s.emit("session_start", { type: "session_start" });
  };
  /** Does one step; what it makes observable is logged by the session, the transport, and the origins. */
  const perform = async (step: Step): Promise<void> => {
    switch (step.do) {
      case "request":
        await session(step.s).request(step.payload);
        break;
      case "start":
        started.set(step.id, session(step.s).request(step.payload));
        break;
      case "finish":
        await deadline(started.get(step.id) ?? Promise.reject(new Error(`no request ${step.id}`)), 3000, `request ${step.id} to finish`);
        break;
      case "prepare": {
        const s = session(step.s);
        prepared.set(step.id, { s, ...(await s.prepare(step.payload)) });
        break;
      }
      case "send": {
        const p = prepared.get(step.id);
        assert.ok(p !== undefined && p.body !== null, `request ${step.id} was not prepared with a body`);
        await p.s.post(p.headers, p.body);
        break;
      }
      case "headers": {
        const s = session(step.s);
        s.saved.set(step.as ?? "headers", await s.headers(step.headers));
        break;
      }
      case "payload": {
        const s = session(step.s);
        s.saved.set(step.as ?? "body", await s.payload(step.payload));
        break;
      }
      case "post": {
        const s = session(step.s);
        const body = s.saved.get(step.body ?? "body");
        assert.ok(typeof body === "string", `no body ${step.body ?? "body"} saved`);
        await s.post(s.saved.get(step.headers ?? "headers") as Readonly<Record<string, unknown>> | undefined, body);
        break;
      }
      case "route": {
        const s = session(step.s);
        const handler = s.commands.get("route");
        assert.ok(handler !== undefined, "no /route command");
        await handler(step.args, s.ctx());
        break;
      }
      case "emit":
        await session(step.s).emit(step.event, { type: step.event });
        break;
      case "set": {
        const { do: _do, s: n, ...config } = step;
        session(n).apply(config);
        break;
      }
      case "open":
        await open(step.s, step.copy, step.branch);
        break;
      case "await-held":
        await origins.held(step.gate);
        break;
      case "release":
        origins.release(step.gate);
        break;
      case "branch": {
        const s = session(step.s);
        s.entries.splice(0, s.entries.length, ...step.entries);
        break;
      }
      case "tick":
        mock.timers.tick(step.ms);
        break;
    }
  };
  if (scenario.timers === true) mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await recording(out, scenario.origins?.includes("or") === true ? origins.url("or") : null, async () => {
      await deadline(
        (async () => {
          out.push("== open s=1");
          await open(1);
          await settle();
          for (const step of scenario.steps) {
            out.push(`== ${describe(step, 400)}`);
            // Each step has its own deadline: a step that hangs fails here, naming itself.
            await deadline(perform(step), 5000, `the step "${describe(step, 80)}" to finish`);
            await settle();
          }
        })(),
        10_000,
        `scenario ${scenario.key} to finish`,
      );
    });
  } finally {
    if (scenario.timers === true) mock.timers.reset();
    for (const s of sessions.values()) await s.emit("session_shutdown", { type: "session_shutdown" });
    await origins.close();
    if (before === undefined) delete process.env["ROUTE_POLICY"];
    else process.env["ROUTE_POLICY"] = before;
  }
  return out.lines;
}

/** Registers one test per scenario and adapter: the whole log must equal the literal written for it. */
export function scenarios(list: readonly Scenario[], adapters: readonly Adapter[], expected: Expected): void {
  for (const scenario of list) {
    for (const adapter of adapters) {
      const want = expected[scenario.key]?.[adapter.name];
      const title = `${scenario.key}${scenario.ids.length === 0 ? "" : ` ${scenario.ids.join(", ")}`}: ${adapter.name}: ${describeScenario(scenario)} => ${want === undefined ? "(no expected record)" : summarize(want)}`;
      test(title, async () => {
        const [key, variant, actual] = [scenario.key, adapter.name, await run(scenario, adapter)];
        assert.ok(want !== undefined, `no expected record for ${key} in ${variant}`);
        assert.deepEqual(actual, want);
      });
    }
  }
}
