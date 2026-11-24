// The observation side of every scenario: one ordered log of everything a run makes observable, written as one
// line per event. Loopback servers record each request as it arrives on the wire (raw request target, every header
// line in order, body text); a wrapper under the plugin's fetch gate records each transport call that fails before
// a server answers it, and sends OpenRouter's base URL to a loopback server instead of the network. Tests compare
// the whole log with a literal; titles are generated from the scenario's inputs and from that literal.

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** Timers as they were when the tests loaded, so scenario deadlines run even while a test mocks the global ones. */
export const realSetTimeout = globalThis.setTimeout;
export const realClearTimeout = globalThis.clearTimeout;
export const realSetImmediate = globalThis.setImmediate;

export const OPENROUTER_ORIGIN = "https://openrouter.ai";

/** One run's log. Each loopback port is written as the name of its origin, so a log reads the same on every run. */
export class Log {
  readonly lines: string[] = [];
  readonly #aliases: [string, string][] = [];

  alias(raw: string, name: string): void {
    this.#aliases.push([raw, name]);
  }

  push(line: string): void {
    let text = line;
    for (const [raw, name] of this.#aliases) text = text.split(raw).join(name);
    this.lines.push(text);
  }
}

/** The log of the scenario running now; the fetch wrapper and the servers write to it. */
let current: Log | null = null;
/** Where OpenRouter's base URL goes while a scenario runs: a loopback origin, or nowhere (a failed fetch). */
let openRouterTarget: string | null = null;

export const log = (line: string): void => {
  current?.push(line);
};

const reasonOf = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = error.cause;
  const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : null;
  return `${error.name}: ${error.message}${code === null ? "" : ` (${code})`}`;
};

// Installed once, when this module loads, before any plugin installs its gate on top of it: every call the gate
// lets through, and every metadata read the plugin makes, passes here.
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const routed = !(input instanceof Request) && url.startsWith(`${OPENROUTER_ORIGIN}/`) ? `${openRouterTarget ?? "http://127.0.0.1:1"}${url.slice(OPENROUTER_ORIGIN.length)}` : null;
  try {
    return await realFetch(routed ?? input, init);
  } catch (error) {
    log(`fetch failed: ${method} ${url}: ${reasonOf(error)}`);
    throw error;
  }
  // A member of its own, as a runtime's fetch may have (Bun's preconnect): a gate on top must keep it.
}, realFetch, { preconnect: (url: string): void => log(`fetch.preconnect ${url}`) });

// ---- How a caller passes a request to fetch.

/**
 * The ways a caller can hand `fetch` one request: "init" a URL string and init; "url" a URL object and init;
 * "request" a `Request` built from them and no init; and a `Request` built from them with a second argument that
 * keeps its body ("request+headers" its headers again, "request+null" body null, "request+undefined" body
 * undefined, "request+PUT", "+PATCH", "+DELETE" another method) or replaces it ("request+string": the `Request`
 * is built with other text, and init's body is the request's own).
 */
export const SHAPES = ["init", "url", "request", "request+headers", "request+null", "request+undefined", "request+PUT", "request+PATCH", "request+DELETE", "request+string"] as const;
export type Shape = (typeof SHAPES)[number];

/** The two arguments a caller of the given shape passes to `fetch` for the request `url` and `init` describe. */
export function callArgs(shape: Shape, url: string, init: RequestInit): [Parameters<typeof fetch>[0], RequestInit | undefined] {
  switch (shape) {
    case "init":
      return [url, init];
    case "url":
      return [new URL(url), init];
    case "request":
      return [new Request(url, init), undefined];
    case "request+headers":
      return [new Request(url, init), { headers: init.headers ?? {} }];
    case "request+null":
      return [new Request(url, init), { body: null }];
    case "request+undefined":
      // JavaScript callers pass this; the strict compiler option for optional members does not admit it as written.
      return [new Request(url, init), { body: undefined } as unknown as RequestInit];
    case "request+PUT":
    case "request+PATCH":
    case "request+DELETE":
      return [new Request(url, init), { method: shape.slice("request+".length) }];
    case "request+string":
      return [new Request(url, { ...init, body: "a request body the init replaces" }), { body: init.body ?? null }];
  }
}

/** The process's fetch gate table, as every copy of the plugin shares it under its global symbol; null before one. */
function gateTable(): { releases: { release: unknown }[]; sweeper?: unknown } | null {
  const registry: unknown = Reflect.get(globalThis, Symbol.for("inference-route-policy.fetch-gate"));
  return typeof registry === "object" && registry !== null && "releases" in registry && Array.isArray(registry.releases) ? (registry as never) : null;
}

/**
 * Forgets every release in the process's fetch gate, revoked ones included, as their expiry would, and its sweeper
 * timer with them. The gate keeps a revoked release for 30 seconds of a process that runs many scenarios, and a
 * scenario's mocked timers end with it; each scenario ends with this, so the next starts with nothing held.
 */
export function forgetReleases(): void {
  const table = gateTable();
  if (table === null) return;
  table.releases.length = 0;
  clearTimeout(table.sweeper as NodeJS.Timeout | undefined);
  table.sweeper = null;
}

/** What the gate's table holds: its entries, and how many of them still reach a body (through their release). */
export function gateHolds(): { entries: number; bodies: number } {
  const entries = gateTable()?.releases ?? [];
  return { entries: entries.length, bodies: entries.filter((e) => e.release !== null).length };
}

// ---- Loopback origins.

export interface Reply {
  status: number;
  headers?: Readonly<Record<string, string | readonly string[]>>;
  /** Sent as JSON; omitted, the body is empty. */
  body?: unknown;
  /** Sent as the body instead of `body`, for one that is not JSON. */
  raw?: string;
  /** The name of a gate the reply waits at until a step releases it. */
  hold?: string;
  /** Close the connection instead of answering, so the client's fetch fails. */
  destroy?: boolean;
}

/** Which requests a reply is for. The first rule that matches a request answers it; a rule that answers none fails its scenario. */
export interface Rule {
  /** The origin; "gw" when omitted. */
  at?: string;
  /** detection: a GET to {base}/route-policy; models: a GET to {base}/models; inference: a POST. */
  on: "detection" | "models" | "inference";
  /** The raw query, "?" included, the request target must end with ("" for none). */
  query?: string;
  /** The raw path, without the query, the request target must have. */
  path?: string;
  /** A header line the request must carry, by lowercase name. */
  header?: readonly [string, string];
  /** Only the nth request this rule's other conditions match, counted from 1. */
  nth?: number;
  reply: Reply;
}

export const DEFAULT_DETECTION: Reply = { status: 200, body: { route_policy: "1" } };
export const EVIDENCE = "https://basalt.example/attestation";
/** aurora meets zdr and notrain; basalt attests with evidence; cobalt publishes nothing. other-model: cobalt with notrain. */
export const DEFAULT_MODELS: Reply = {
  status: 200,
  body: {
    data: [
      {
        id: "demo-model",
        routes: [
          { provider: "aurora", facts: "zdr+notrain+bits=8+region=us" },
          { provider: "basalt", facts: "bits=16+region=us,de+attest=weights,prompt", evidence: EVIDENCE },
          { provider: "cobalt", facts: "" },
        ],
      },
      { id: "other-model", routes: [{ provider: "cobalt", facts: "notrain" }] },
    ],
  },
};
export const DEFAULT_INFERENCE: Reply = { status: 200, headers: { "route-applied": "provider=aurora" }, body: { choices: [] } };
const NOT_FOUND: Reply = { status: 404, body: { error: "not found" } };

const kindOf = (method: string, path: string): Rule["on"] | null =>
  method === "POST" ? "inference" : method === "GET" && path.endsWith("/route-policy") ? "detection" : method === "GET" && path.endsWith("/models") ? "models" : null;

interface Gate {
  open: boolean;
  held: number;
  opened: Promise<void>;
  release: () => void;
  onHeld: (() => void)[];
}

/** The loopback origins of one scenario, each named; their requests and gates. */
export class Origins {
  readonly #servers = new Map<string, { server: Server; port: number }>();
  readonly #rules: readonly Rule[];
  readonly #matched = new Map<Rule, number>();
  /** The configured rules that answered at least one request. */
  readonly #answered = new Set<Rule>();
  readonly #gates = new Map<string, Gate>();
  readonly #log: Log;

  private constructor(log: Log, rules: readonly Rule[]) {
    this.#log = log;
    this.#rules = rules;
  }

  static async start(log: Log, names: readonly string[], rules: readonly Rule[]): Promise<Origins> {
    const origins = new Origins(log, rules);
    for (const name of names) await origins.#listen(name);
    // Longest first: "127.0.0.1:PORT" is named before a bare PORT is.
    for (const [name, { port }] of origins.#servers) log.alias(`127.0.0.1:${port}`, `{${name}}`);
    for (const [name, { port }] of origins.#servers) log.alias(String(port), `{${name}.port}`);
    return origins;
  }

  /** "http://127.0.0.1:PORT" for an origin. */
  url(name: string): string {
    const server = this.#servers.get(name);
    assert.ok(server !== undefined, `no origin ${name}`);
    return `http://127.0.0.1:${server.port}`;
  }

  /** Replaces {name} and {name.port} in a scenario's text with the origin's address. */
  fill(text: string): string {
    let out = text;
    for (const [name, { port }] of this.#servers) out = out.split(`{${name}}`).join(`127.0.0.1:${port}`).split(`{${name}.port}`).join(String(port));
    return out;
  }

  gate(name: string): Gate {
    let gate = this.#gates.get(name);
    if (gate === undefined) {
      let release = (): void => {};
      const opened = new Promise<void>((resolve) => {
        release = resolve;
      });
      gate = { open: false, held: 0, opened, release, onHeld: [] };
      this.#gates.set(name, gate);
    }
    return gate;
  }

  async #listen(name: string): Promise<void> {
    const server = createServer((request, response) => {
      void this.#answer(name, request, response);
    });
    // Its Keep-Alive header reaches every recorded response, so its timeout is set here, not left to the
    // runtime's default (5 seconds in Node 26, 65 in later versions).
    server.keepAliveTimeout = 5000;
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address !== null && typeof address === "object", "a TCP server has an address");
    this.#servers.set(name, { server, port: address.port });
  }

  /** The reply to a request, and the 1-based number of the configured rule that answered it (null for a default reply). */
  #reply(name: string, method: string, target: string, request: IncomingMessage): { reply: Reply; rule: number | null } {
    const path = target.split("?")[0] ?? "";
    const query = target.includes("?") ? target.slice(target.indexOf("?")) : "";
    const kind = kindOf(method, path);
    // Every rule whose conditions hold counts the request, whichever rule answers it.
    const counted = this.#rules.filter((rule) => {
      if ((rule.at ?? "gw") !== name || rule.on !== kind) return false;
      if (rule.query !== undefined && rule.query !== query) return false;
      if (rule.path !== undefined && rule.path !== path) return false;
      if (rule.header !== undefined && request.headers[rule.header[0]] !== rule.header[1]) return false;
      this.#matched.set(rule, (this.#matched.get(rule) ?? 0) + 1);
      return true;
    });
    const rule = counted.find((r) => r.nth === undefined || r.nth === this.#matched.get(r));
    if (rule === undefined) return { reply: kind === "detection" ? DEFAULT_DETECTION : kind === "models" ? DEFAULT_MODELS : kind === "inference" ? DEFAULT_INFERENCE : NOT_FOUND, rule: null };
    this.#answered.add(rule);
    return { reply: rule.reply, rule: this.#rules.indexOf(rule) + 1 };
  }

  /** The configured rules that answered no request: a fixture the scenario configured and never exercised. */
  unanswered(): Rule[] {
    return this.#rules.filter((rule) => !this.#answered.has(rule));
  }

  /** Fails, naming them, when a configured rule answered no request: a title prints every rule as an input the run used. */
  assertEveryRuleAnswered(): void {
    const dead = this.unanswered().map((rule) => JSON.stringify(rule));
    assert.deepEqual(dead, [], `configured reply rules that answered no request: ${dead.join("; ")}`);
  }

  async #answer(name: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const method = request.method ?? "";
    const target = request.url ?? "";
    const lines: string[] = [];
    for (let i = 0; i + 1 < request.rawHeaders.length; i += 2) lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
    // Chosen before the arrival is written, so the line says which configured rule, if any, answered it.
    const { reply, rule } = this.#reply(name, method, target, request);
    this.#log.push(`${name} <- ${method} ${target} | ${lines.join(" | ")} | body ${JSON.stringify(body)}${rule === null ? "" : ` | answered by rule ${rule}`}`);
    if (reply.destroy === true) {
      request.socket.destroy();
      return;
    }
    if (reply.hold !== undefined) {
      const gate = this.gate(reply.hold);
      gate.held += 1;
      for (const wake of gate.onHeld.splice(0)) wake();
      await gate.opened;
    }
    const text = reply.raw ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
    response.sendDate = false;
    const headers: Record<string, string | string[]> = { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) };
    // Header values may name an origin ({other}), as a redirect's location does.
    for (const [header, value] of Object.entries(reply.headers ?? {})) headers[header] = typeof value === "string" ? this.fill(value) : value.map((v) => this.fill(v));
    try {
      response.writeHead(reply.status, headers);
      response.end(text);
    } catch {
      // The scenario ended and closed the connection first.
    }
  }

  /** Waits until a request is held at `name`. */
  async held(name: string): Promise<void> {
    const gate = this.gate(name);
    if (gate.held > 0) return;
    await deadline(new Promise<void>((wake) => gate.onHeld.push(wake)), 3000, `a request to arrive and be held at gate ${name}`);
  }

  release(name: string): void {
    const gate = this.gate(name);
    gate.open = true;
    gate.release();
  }

  async close(): Promise<void> {
    for (const gate of this.#gates.values()) gate.release();
    for (const { server } of this.#servers.values()) {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  }
}

/** Runs a scenario's log: sets it as the one the wrapper and servers write to, and where OpenRouter goes. */
export async function recording<T>(log: Log, openRouter: string | null, run: () => Promise<T>): Promise<T> {
  current = log;
  openRouterTarget = openRouter;
  try {
    return await run();
  } finally {
    current = null;
    openRouterTarget = null;
  }
}

/** `work`, or an assertion failure naming `what` once `ms` pass: a hang is a failed test, never a slow pass. */
export async function deadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = realSetTimeout(() => reject(new assert.AssertionError({ message: `timed out after ${ms} ms waiting for ${what}` })), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    realClearTimeout(timer);
  }
}

/** Lets every pending callback and I/O completion run, under real or mocked timers alike. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((wake) => realSetImmediate(wake));
}

// ---- Titles, generated from inputs and from the expected record, never written by hand.

/** A value in a title: compact JSON, cut at `max` characters. */
export function brief(value: unknown, max = 60): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value, (_key, v: unknown) => (typeof v === "function" ? "fn" : v instanceof Map ? [...v] : v instanceof Set ? [...v] : v)) ?? "undefined");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One record line, shortened for a title: arrivals by method and target, UI by channel and text. Step markers ("== ...") echo inputs, not outcomes, so they never reach it. */
function headline(line: string): string | null {
  if (line.startsWith("== ")) return null;
  const arrival = /^(\w+) <- (\S+) (\S*) \|/.exec(line);
  if (arrival !== null) {
    const policy = /\| route-policy: ([^|]*?) \|/i.exec(line)?.[1];
    const model = /body ".*?\\"model\\":\\"((?:[^\\"]|\\\\.)*)\\"/.exec(line)?.[1];
    const sent = `${policy === undefined ? "" : ` route-policy=${policy}`}${model === undefined ? "" : ` model=${model}`}`;
    return `${arrival[1] === "gw" ? "" : `${arrival[1]} `}${arrival[2]} ${arrival[3]}${sent}`;
  }
  const ui = /^\[(\d)\] (notify|setStatus) (?:\S+ )?(.*?)( \(threw\))?$/.exec(line);
  if (ui !== null) return `[${ui[1]}] ${ui[2]}${ui[4] === undefined ? "" : " (threw)"} ${brief(ui[3] ?? "", 70)}`;
  const response = /^\[(\d)\] POST (\S+)(?: \[\S+\])? -> (\d+)/.exec(line);
  if (response !== null) return `[${response[1]}] response ${response[3]}`;
  const stopped = /^\[(\d)\] POST \S+( \[\S+\])? stopped: Blocked by the route policy plugin, nothing was sent: (.*)$/.exec(line);
  if (stopped !== null) return `[${stopped[1]}] POST${stopped[2] ?? ""} stopped: ${brief(stopped[3] ?? "", 70)}`;
  const blocked = /^\[(\d)\] before_provider_request -> throws Error: Blocked by the route policy plugin, nothing was sent: (.*)$/.exec(line);
  if (blocked !== null) return `[${blocked[1]}] payload blocked: ${brief(blocked[2] ?? "", 70)}`;
  if (/^\[\d\] handler error/.test(line)) return brief(line, 60);
  if (/^fetch failed/.test(line)) return brief(line, 60);
  if (/^fetch\.preconnect |^preconnect returned |^the gate holds |^a process holding only a release |^an expired release, /.test(line)) return brief(line, 100);
  // The gate tests' own lines: a fetch that threw, the response a fetch got, and what an owner was told.
  const threw = /^([A-Z]+) \S+ threw (.*)$/.exec(line);
  if (threw !== null) return `${threw[1]} threw ${brief(threw[2] ?? "", 80)}`;
  const got = /^([A-Z]+) \S+ -> (\d+ [^|]*?) \|/.exec(line);
  if (got !== null) return `${got[1]} response ${got[2]}`;
  const told = /^(\S+ told \S+ (?:stopped|complete)): (.*)$/.exec(line);
  if (told !== null) return `${told[1]} ${brief(told[2] ?? "", 70)}`;
  const reported = /^report (.*)$/.exec(line);
  if (reported !== null) return `report ${brief(reported[1] ?? "", 70)}`;
  const outcome = /^(?:\S+ )?(decide|describe|check|stopped|complete|isCurrent|interpret)\b(.*)$/.exec(line);
  if (outcome !== null) return brief(line, 90);
  return null;
}

/** What a record pins, shortened: the title's right-hand side. */
export function summarize(lines: readonly string[], max = 420): string {
  const parts = lines.map(headline).filter((part) => part !== null);
  const text = parts.length === 0 ? "(no summarized events)" : parts.join("; ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Expected records, written out in each test file: by scenario key, then by variant (adapter, or "client", "gate"). */
export type Expected = Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
