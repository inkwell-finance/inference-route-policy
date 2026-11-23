import {
  baselineSupport, combinePolicies, formatApplied, formatDetection, formatRefused, isEvidenceUri, isProviderId,
  meets, orderRoutes, parsePolicy, parsePublishedFacts, REFUSAL_STATUS, splitModel,
  type Facts, type Policy, type RefusalReason, type Support,
} from "../../core/src/index.ts";

export interface Route {
  provider: string;
  facts: string;
  url: string;
  apiKey?: string;
  model?: string;
  price: number;
  latencyMs: number;
  throughput: number;
  evidence?: string;
}

export interface GatewayConfig {
  models: Readonly<Record<string, readonly Route[]>>;
  keys?: Readonly<Record<string, { policy?: string }>>;
  accept?: { keys?: readonly string[]; attest?: readonly string[]; sort?: readonly string[] };
  fetch?: typeof fetch;
}

export type RequestHandler = (request: Request, transport?: { repeatedRoutePolicy?: boolean }) => Promise<Response>;
export const ENDPOINTS = Object.freeze(["chat/completions", "responses", "messages"] as const);
export type Endpoint = (typeof ENDPOINTS)[number];

interface LoadedRoute {
  provider: string;
  facts: Facts;
  url: string;
  apiKey: string | undefined;
  model: string;
  price: number;
  latencyMs: number;
  throughput: number;
  evidence: string | undefined;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function metric(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${field} must be a finite nonnegative number`);
  return value;
}

function isCredential(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[^!-~]|,/.test(value);
}

function baseURL(value: unknown): string {
  if (typeof value !== "string" || !/^https?:\/\//.test(value) || !value.endsWith("/v1") || /[\s\\?#]/.test(value)) {
    throw new TypeError("provider url must be an HTTP(S) base URL ending in /v1");
  }
  const url = new URL(value);
  if (url.username || url.password || !url.pathname.endsWith("/v1")) throw new TypeError("invalid provider base URL");
  return url.href;
}

function accepted(value: unknown, baseline: ReadonlySet<string>, field: string): ReadonlySet<string> {
  if (value === undefined) return baseline;
  if (!Array.isArray(value)) throw new TypeError(`accept.${field} must be a list`);
  const entries: unknown[] = Array.from(value);
  const result = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "string" || !baseline.has(entry) || result.has(entry)) throw new TypeError(`invalid accept.${field} entry`);
    result.add(entry);
  }
  return result;
}

function credential(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  const bearer = authorization?.match(/^Bearer +([^ ,]+)$/i)?.[1];
  const apiKey = headers.get("x-api-key");
  // Do not silently select the weaker policy when the request names two different keys.
  if (authorization !== null && apiKey !== null && bearer !== apiKey) return null;
  return bearer ?? apiKey;
}

function endOfString(text: string, start: number): number {
  let i = start + 1;
  for (; text[i] !== '"'; i++) if (text[i] === "\\") i++;
  return i + 1;
}

// The full text has already passed JSON.parse. Edit only the outer object so nested
// members (including duplicates), large numbers, and their original spelling survive.
function requestBody(text: string): (model: string) => string {
  const members: string[] = [];
  let i = text.indexOf("{") + 1;
  for (;;) {
    const start = i;
    while (text[i] !== '"' && text[i] !== "}") i++;
    if (text[i] === "}") break;
    const endKey = endOfString(text, i);
    const key: unknown = JSON.parse(text.slice(i, endKey));
    let depth = 0;
    for (i = endKey; ; i++) {
      const ch = text[i];
      if (ch === '"') i = endOfString(text, i) - 1;
      else if (ch === "{" || ch === "[") depth++;
      else if (depth === 0 && (ch === "," || ch === "}")) break;
      else if (ch === "}" || ch === "]") depth--;
    }
    if (key !== "model") members.push(text.slice(start, i));
    if (text[i++] === "}") break;
  }
  const rest = members.length === 0 ? "" : `,${members.join(",")}`;
  return (model) => `{"model":${JSON.stringify(model)}${rest}}`;
}

function forwardedHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of headers.get("connection")?.split(",") ?? []) {
    const token = name.trim();
    if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(token)) headers.delete(token);
  }
  for (const name of ["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length"]) headers.delete(name);
  return headers;
}

function error(endpoint: Endpoint, status: number, message: string, headers?: ResponseInit["headers"]): Response {
  const type = status === 401 ? "authentication_error" : status === 404 ? "not_found_error" : status === 503 ? "overloaded_error" : "invalid_request_error";
  return Response.json(endpoint === "messages" ? { type: "error", error: { type, message } } : { error: { type, message } }, { status, ...(headers === undefined ? {} : { headers }) });
}

function refused(endpoint: Endpoint, reason: RefusalReason, key?: string | null): Response {
  const value = reason === "unsupported" ? formatRefused(reason, key) : formatRefused(reason);
  return error(endpoint, REFUSAL_STATUS[reason], `Route policy ${reason}`, { "Route-Refused": value });
}

function rank(route: LoadedRoute, sort: string): number {
  return sort === "price" ? route.price : sort === "latency" ? route.latencyMs : -route.throughput;
}

export function createGateway(config: unknown): RequestHandler {
  const source = record(config, "config");
  const baseline = baselineSupport();
  const accept = source.accept === undefined ? {} : record(source.accept, "accept");
  const support: Support = {
    keys: accepted(accept.keys, baseline.keys, "keys"),
    attest: accepted(accept.attest, baseline.attest, "attest"),
    sort: accepted(accept.sort, baseline.sort, "sort"),
  };
  const detection = formatDetection(support);
  const keys = source.keys === undefined ? null : new Map<string, { policy?: Policy; text?: string }>();
  if (keys !== null) {
    for (const [id, value] of Object.entries(record(source.keys, "keys"))) {
      if (!isCredential(id)) throw new TypeError("invalid gateway key");
      const { policy } = record(value, "key configuration");
      if (policy === undefined) keys.set(id, {});
      else {
        if (typeof policy !== "string") throw new TypeError("key policy must be a string");
        const parsed = parsePolicy(policy, support);
        if (!parsed.ok) throw new TypeError(`invalid key policy: ${parsed.detail}`);
        keys.set(id, { policy: parsed.value, text: policy });
      }
    }
  }
  const models = new Map<string, LoadedRoute[]>();
  const data = [];
  for (const [id, rawRoutes] of Object.entries(record(source.models, "models"))) {
    if (id === "" || splitModel(id).policy !== null || !Array.isArray(rawRoutes)) throw new TypeError("invalid model entry");
    const routes: LoadedRoute[] = [];
    const published = [];
    const providers = new Set<string>();
    for (const value of rawRoutes) {
      const { provider, facts, url, apiKey, model, price, latencyMs, throughput, evidence } = record(value, "route");
      if (!isProviderId(provider) || providers.has(provider)) throw new TypeError(`invalid or repeated provider for model ${id}`);
      if (typeof facts !== "string") throw new TypeError("route facts must be a string");
      const parsed = parsePublishedFacts(facts);
      if (!parsed.ok) throw new TypeError(`invalid route facts: ${parsed.detail}`);
      if ((evidence !== undefined || parsed.value.attest.length > 0) && !isEvidenceUri(evidence)) throw new TypeError("invalid or missing evidence URI");
      if (apiKey !== undefined && !isCredential(apiKey)) throw new TypeError("invalid provider apiKey");
      if (model !== undefined && (typeof model !== "string" || model === "")) throw new TypeError("invalid provider model id");
      providers.add(provider);
      // Narrow the optional URI independently of whether attestation is required.
      const uri = typeof evidence === "string" ? evidence : undefined;
      routes.push({ provider, facts: parsed.value, url: baseURL(url), apiKey, model: model ?? id, price: metric(price, "price"), latencyMs: metric(latencyMs, "latencyMs"), throughput: metric(throughput, "throughput"), evidence: uri });
      published.push({ provider, facts, ...(uri === undefined ? {} : { evidence: uri }) });
    }
    models.set(id, routes);
    data.push({ id, routes: published });
  }
  const modelList = { object: "list", data };
  if (source.fetch !== undefined && typeof source.fetch !== "function") throw new TypeError("fetch must be a function");
  // A configured callback has the Fetch contract; its result is checked before it is used.
  const injected = source.fetch;
  const send = async (url: string, init: RequestInit): Promise<Response> => {
    if (injected === undefined) return fetch(url, init);
    const result: unknown = await injected(url, init);
    if (!(result instanceof Response)) throw new TypeError("fetch must return a Response");
    return result;
  };

  return async (request, transport) => {
    const path = new URL(request.url).pathname;
    const token = credential(request.headers);
    const bound = token === null ? undefined : keys?.get(token);
    if (request.method === "GET" && path === "/v1/route-policy") {
      return Response.json(bound?.text === undefined ? detection : { ...detection, key_policy: bound.text });
    }
    if (request.method === "GET" && path === "/v1/models") return Response.json(modelList);
    const endpoint = ENDPOINTS.find((name) => path === `/v1/${name}`);
    if (request.method !== "POST" || endpoint === undefined) return error(endpoint ?? "chat/completions", 404, "Unknown endpoint");
    if (keys !== null && bound === undefined) return error(endpoint, 401, "Invalid API key");

    let text: string;
    let body: unknown;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(await request.arrayBuffer());
      body = JSON.parse(text);
    } catch {
      return error(endpoint, 400, "Expected a JSON body");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body) || !("model" in body) || !Object.hasOwn(body, "model") || typeof body.model !== "string") {
      return error(endpoint, 400, "Expected a string model");
    }
    const model = splitModel(body.model);
    const routes = models.get(model.id);
    if (routes === undefined) return error(endpoint, 404, "Unknown model");

    if (transport?.repeatedRoutePolicy) return refused(endpoint, "unsupported");
    const layers: { key?: Policy; header?: Policy; suffix?: Policy } = {};
    const header = request.headers.get("route-policy");
    if (header !== null) {
      const parsed = parsePolicy(header, support);
      if (!parsed.ok) return refused(endpoint, "unsupported", parsed.key);
      layers.header = parsed.value;
    }
    if (model.policy !== null) {
      const parsed = parsePolicy(model.policy, support);
      if (!parsed.ok) return refused(endpoint, "unsupported", parsed.key);
      layers.suffix = parsed.value;
    }
    if (bound?.policy !== undefined) layers.key = bound.policy;
    const policy = layers.header === undefined && layers.suffix === undefined && layers.key === undefined ? null : combinePolicies(layers);
    const qualifying = policy === null ? routes : routes.filter((route) => meets(route, policy));
    if (policy !== null && qualifying.length === 0) return refused(endpoint, "unsatisfiable");
    const ordered = policy === null ? qualifying : orderRoutes(qualifying, policy, rank);

    const bodyFor = requestBody(text);
    const headers = forwardedHeaders(request.headers);
    for (const name of ["route-policy", "authorization", "x-api-key", "host", "expect", "content-encoding"]) headers.delete(name);
    headers.set("content-type", "application/json");
    headers.set("accept-encoding", "identity");
    for (const route of ordered) {
      if (request.signal.aborted) break;
      const upstreamHeaders = new Headers(headers);
      if (route.apiKey !== undefined) upstreamHeaders.set(endpoint === "messages" ? "x-api-key" : "authorization", endpoint === "messages" ? route.apiKey : `Bearer ${route.apiKey}`);
      let upstream: Response;
      try {
        // A redirect must not silently replay content to an unconfigured endpoint.
        upstream = await send(`${route.url}/${endpoint}`, { method: "POST", headers: upstreamHeaders, body: bodyFor(route.model), redirect: "manual", signal: request.signal });
      } catch {
        continue;
      }
      if (upstream.status === 429 || upstream.status >= 500 || upstream.status < 200) {
        // Cancellation is best effort and must not delay trying the next route.
        void upstream.body?.cancel().catch(() => {});
        continue;
      }
      const reply = forwardedHeaders(upstream.headers);
      for (const name of ["route-applied", "route-refused", "route-evidence"]) reply.delete(name);
      // Fetch decodes a supported Content-Encoding before exposing the body.
      const encoding = upstream.headers.get("content-encoding");
      if (encoding !== null && encoding.split(",").every((value) => ["gzip", "x-gzip", "deflate", "br", "zstd"].includes(value.trim().toLowerCase()))) reply.delete("content-encoding");
      if (policy !== null) {
        reply.set("Route-Applied", formatApplied(route.provider));
        if (policy.attest.length > 0 && route.evidence !== undefined) reply.set("Route-Evidence", route.evidence);
      }
      // The body belongs to this response from now on. No later stream error can
      // reenter the routing loop or cause another provider to receive the request.
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: reply });
    }
    return policy === null ? error(endpoint, 503, "No provider response available") : refused(endpoint, "unavailable");
  };
}
