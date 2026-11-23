import {
  baselineSupport, combinePolicies, formatRefused, isEvidenceUri, isProviderId, keysOf, meets, parseDetection,
  parsePolicy, parsePublishedFacts, parseRefused, publishedRoutes, REFUSAL_STATUS, someRouteMeets, splitModel,
  type Detection, type Policy, type PublishedRoute, type RefusalReason, type Support,
} from "../../core/src/index.ts";
import { request, sent, type Credential, type Observation, type Probe } from "./http.ts";
import { applied, auditResults, noResult, type AuditId, type Exchange, type ResultContext } from "./outcomes.ts";

export const INFERENCE_ENDPOINTS = ["chat/completions", "responses", "messages"] as const;
export type Endpoint = (typeof INFERENCE_ENDPOINTS)[number];
export interface Options {
  base: string;
  key?: string;
  policyKey?: string;
  endpoints?: readonly Endpoint[];
  timeoutMs?: number;
}
export interface Check {
  id: string;
  endpoint?: Endpoint;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string;
}
export interface Report {
  checks: Check[];
  passed: number;
  failed: number;
  skipped: number;
}

interface Model {
  id: string;
  routes: ReadonlyMap<string, PublishedRoute | null>;
  unknown: string;
  policies: { text: string; policy: Policy }[];
}

interface Scope {
  credential?: Credential;
  detectionReply?: Observation;
  detection?: Detection;
  models: Model[];
  catalogAvailable?: boolean;
}

const authHeaderFor = (endpoint: Endpoint): Credential["header"] => endpoint === "messages" ? "x-api-key" : "authorization";
const BASELINE = baselineSupport();
const INVALID_POLICY = "bits=0";
const member = (value: unknown, name: string): unknown => typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, name) ? Reflect.get(value, name) : undefined;
const list = (value: unknown): unknown[] | undefined => Array.isArray(value) ? value : undefined;

function unused(known: ReadonlySet<string>, prefix: string): string {
  let n = 0;
  while (known.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

function schemaProblem(body: unknown): string | undefined {
  const entries = list(member(body, "data"));
  if (entries === undefined) return "models response must be an object with a data array";
  const ids = new Set<string>();
  for (const entry of entries) {
    const id = member(entry, "id");
    const routes = list(member(entry, "routes"));
    if (typeof id !== "string" || splitModel(id).id === "" || splitModel(id).policy === "" || ids.has(id) || routes === undefined) return `invalid or repeated model entry: ${JSON.stringify(entry)}`;
    ids.add(id);
    const providers = new Set<string>();
    for (const route of routes) {
      const provider = member(route, "provider");
      const facts = member(route, "facts");
      const evidence = member(route, "evidence");
      if (!isProviderId(provider) || providers.has(provider)) return `invalid or repeated provider on ${id}: ${JSON.stringify(route)}`;
      if (typeof facts !== "string") return `facts must be a string for ${id}/${provider}`;
      const parsed = parsePublishedFacts(facts);
      if (!parsed.ok) return `invalid facts for ${id}/${provider}: ${parsed.detail}`;
      if ((parsed.value.attest.length > 0 || evidence !== undefined) && !isEvidenceUri(evidence)) return `invalid or missing evidence URI for ${id}/${provider}`;
      providers.add(provider);
    }
  }
  for (const id of ids) {
    const base = splitModel(id);
    if (base.policy !== null && !ids.has(base.id)) return `display alias ${JSON.stringify(id)} has no base model ${JSON.stringify(base.id)}`;
  }
}

function discover(body: unknown, support: Support): Model[] {
  const catalogs = new Map<string, Model["routes"]>();
  const providers = new Set<string>();
  for (const entry of list(member(body, "data")) ?? []) {
    const id = member(entry, "id");
    if (typeof id !== "string") continue;
    for (const route of list(member(entry, "routes")) ?? []) {
      const provider = member(route, "provider");
      if (isProviderId(provider)) providers.add(provider);
    }
    if (splitModel(id).policy === null) catalogs.set(id, publishedRoutes(body, id));
  }
  const unknown = unused(providers, "routeprobe");
  const models: Model[] = [];
  for (const [id, routes] of catalogs) {
    const texts = new Set(["zdr", "notrain", "bits=1", "bits=64", "region=us", "region=de", "attest=weights", "attest=prompt", "attest=weights,prompt", `only=${unknown}`, `ignore=${unknown}`, `order=${unknown}`]);
    for (const sort of support.sort) texts.add(`sort=${sort}`);
    for (const [provider, route] of routes) {
      texts.add(`only=${provider}`);
      texts.add(`ignore=${provider}`);
      if (route === null) continue;
      if (route.facts.bits !== null) {
        texts.add(`bits=${route.facts.bits}`);
        texts.add(`bits=${route.facts.bits + 1}`);
      }
      if (route.facts.region !== null) {
        texts.add(`region=${route.facts.region.join(",")}`);
        for (const country of route.facts.region) texts.add(`region=${country}`);
      }
    }
    const providers = [...routes.keys()].slice(0, 3);
    if (providers.length === 3) {
      texts.add(`only=${providers[0]},${providers[1]}`);
      texts.add(`only=${providers[1]},${providers[2]}`);
    }
    const policies = [];
    for (const text of texts) {
      const parsed = parsePolicy(text, support);
      if (parsed.ok) policies.push({ text, policy: parsed.value });
    }
    models.push({ id, routes, unknown, policies });
  }
  return models;
}

function qualifying(model: Model, policy: Policy): string[] {
  const providers = [];
  for (const [provider, route] of model.routes) {
    if (route !== null && (policy.attest.length === 0 || route.evidence !== null) && meets({ provider, facts: route.facts }, policy)) providers.push(provider);
  }
  return providers;
}

function refusal(reply: Observation, reason: RefusalReason, key?: string | null): boolean {
  return reply.status === REFUSAL_STATUS[reason] && reply.applied.length === 0 && reply.evidence.length === 0
    && reply.refused.length === 1 && reply.refused[0] === (reason === "unsupported" ? formatRefused(reason, key) : formatRefused(reason));
}

const couldRelay = (reply: Observation, allowed: readonly string[]): boolean => refusal(reply, "unavailable") || (reply.refused.length === 0 && allowed.some((id) => id === applied(reply)));
const bodyFor = (endpoint: Endpoint, model: string, stream = false): string => JSON.stringify(endpoint === "responses"
  ? { model, input: "Reply with one word.", max_output_tokens: 16, stream }
  : { model, messages: [{ role: "user", content: "Reply with one word." }], max_tokens: 16, stream });

function jsonBody(probe: Probe): unknown {
  if (probe.raw === undefined) return undefined;
  try { return JSON.parse(probe.raw); } catch { return undefined; }
}

function withoutExplicitPolicy(probe: Probe): Probe {
  const body = jsonBody(probe);
  const model = member(body, "model");
  const split = typeof model === "string" ? splitModel(model) : undefined;
  const raw = split?.policy != null && typeof body === "object" && body !== null ? JSON.stringify({ ...body, model: split.id }) : probe.raw;
  return { path: probe.path, ...(raw === undefined ? {} : { raw }), ...(probe.credential === undefined ? {} : { credential: probe.credential }) };
}

const isHttpError = (status: number): boolean => status >= 400 && status < 600;
// A policy-free provider relay can also be a headerless HTTP error.
const isBareError = (reply: Observation): boolean => isHttpError(reply.status) && noResult(reply);
// Bare rate-limit and service-unavailable responses can be transient. A 503
// with Route-Refused is a separate, protocol-defined outcome.
const transientBareError = (reply: Observation): boolean => noResult(reply) && (reply.status === 429 || reply.status === 503);

function resultContext(probe: Probe, scope: Scope | undefined): ResultContext {
  const model = member(jsonBody(probe), "model");
  const split = typeof model === "string" ? splitModel(model) : undefined;
  const routeMap = scope?.models.find(({ id }) => id === split?.id)?.routes;
  const keyPolicy = scope?.detection?.keyPolicy;
  const explicit = (probe.policies?.length ?? 0) > 0 || split?.policy != null;
  const carriesPolicy = explicit || keyPolicy != null ? true : keyPolicy === null ? false : undefined;
  const result: ResultContext = { carriesPolicy, ...(routeMap === undefined ? {} : { routes: routeMap }) };
  if (scope?.detection === undefined) return result;
  if ((probe.policies?.length ?? 0) > 1) return { ...result, expectedRefusal: { reason: "unsupported", key: null } };
  const layers: { key?: Policy; header?: Policy; suffix?: Policy } = {};
  for (const [layer, text] of [["header", probe.policies?.[0]], ["suffix", split?.policy], ["key", keyPolicy]] as const) {
    if (text == null) continue;
    const parsed = parsePolicy(text, scope.detection.support);
    if (!parsed.ok) {
      // A valid later-revision key default need not be interpretable by this suite.
      return layer === "key" ? result : { ...result, expectedRefusal: { reason: "unsupported", key: parsed.key } };
    }
    layers[layer] = parsed.value;
  }
  if (layers.key !== undefined) result.bound = layers.key;
  result.explicit = explicit;
  const combined = combinePolicies(layers);
  result.combined = combined;
  if (carriesPolicy === true && routeMap !== undefined) {
    result.qualifies = someRouteMeets(routeMap, combined);
    if (!result.qualifies) result.expectedRefusal = { reason: "unsatisfiable" };
    result.unknownProvider = [combined.only ?? [], combined.ignore, combined.order ?? []].some((ids) =>
      ids.some((id) => !scope.models.some((entry) => entry.routes.has(id))));
  }
  return result;
}

export async function runConformance(options: Options): Promise<Report> {
  const base = new URL(options.base);
  if ((base.protocol !== "http:" && base.protocol !== "https:") || base.href.includes("#") || base.username || base.password) {
    throw new TypeError("base must be an HTTP(S) API base URL without a fragment or credentials");
  }
  const endpoints = options.endpoints ?? INFERENCE_ENDPOINTS;
  if (endpoints.length === 0 || endpoints.some((endpoint) => !INFERENCE_ENDPOINTS.includes(endpoint))) throw new TypeError("provide at least one recognized inference endpoint");
  const checks: Check[] = [];
  const primaryKey = options.key ?? options.policyKey;
  const boundKey = options.policyKey ?? options.key;
  const exchanges: Exchange[] = [];
  let precondition: string | undefined;
  async function observe(probe: Probe): Promise<Exchange> {
    const exchange = { probe, reply: await request(base, probe, options.timeoutMs ?? 10_000) };
    exchanges.push(exchange);
    return exchange;
  }
  const mismatch = (probe: Probe, cameBack: string, requirement: string): Error => new Error(`sent ${sent(probe)}; received ${cameBack}; required: ${requirement}`);
  async function expect(probe: Probe, requirement: string, matches: (reply: Observation) => boolean): Promise<Observation> {
    const exchange = await observe(probe).catch((error: unknown) => { throw mismatch(probe, String(error), requirement); });
    const { reply } = exchange;
    if (matches(reply)) return reply;
    if (probe.raw !== undefined && isBareError(reply)) {
      const plain = withoutExplicitPolicy(probe);
      const control = await observe(plain).catch(() => undefined);
      if (control !== undefined && isBareError(control.reply) && control.reply.status === reply.status) {
        const context = resultContext(plain, scopeFor(plain));
        precondition ??= `probe and ${context.carriesPolicy === true ? "control without explicit policy (same bound key)" : "no-policy control"} both returned headerless HTTP ${reply.status}; cannot distinguish an own error from a relay`;
        return reply;
      }
      if (reply.status === REFUSAL_STATUS.unsupported && control !== undefined && (control.reply.status < 400 || applied(control.reply) !== null)
        && resultContext(probe, scopeFor(probe)).expectedRefusal !== undefined) exchange.missingRefusal = true;
      if (transientBareError(reply)) {
        precondition ??= `gateway answered a transient headerless HTTP ${reply.status}; the no-policy control did not establish that routing was reached`;
        return reply;
      }
    }
    throw mismatch(probe, reply.received, requirement);
  }
  async function check(id: string, detail: string, run: () => Promise<void | string>, endpoint?: Endpoint): Promise<void> {
    const tag = endpoint === undefined ? { id } : { id, endpoint };
    try {
      precondition = undefined;
      const missing = await run();
      const absent = precondition ?? missing;
      checks.push(absent === undefined ? { ...tag, status: "PASS", detail } : { ...tag, status: "SKIP", detail: `missing precondition: ${absent}` });
    } catch (error) {
      checks.push({ ...tag, status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
    }
  }

  const anonymous: Scope = { models: [] };
  const scoped = new Map<Credential["header"], Map<string, Scope>>();
  function scope(key: string | undefined, header: Credential["header"]): Scope {
    if (key === undefined) return anonymous;
    let byKey = scoped.get(header);
    if (byKey === undefined) {
      byKey = new Map();
      scoped.set(header, byKey);
    }
    let existing = byKey.get(key);
    if (existing === undefined) {
      existing = { credential: { key, header }, models: [] };
      byKey.set(key, existing);
    }
    return existing;
  }
  function scopeFor(probe: Probe): Scope | undefined {
    return probe.credential === undefined ? anonymous : scoped.get(probe.credential.header)?.get(probe.credential.key);
  }
  const selections = [...new Set(endpoints)].map((endpoint) => ({
    endpoint, primary: scope(primaryKey, authHeaderFor(endpoint)), bound: scope(boundKey, authHeaderFor(endpoint)),
  }));
  const modelScopes = new Set(selections.flatMap(({ primary, bound }) => [primary, bound]));
  const detectionScopes = new Set([anonymous, ...modelScopes]);
  const metadata = (path: string, current: Scope): Probe => ({ path, ...(current.credential === undefined ? {} : { credential: current.credential }) });
  await check("G20", "complete detection reply is valid with and without supplied credentials", async () => {
    let firstFailure: unknown;
    for (const current of detectionScopes) {
      const probe = metadata("route-policy", current);
      try {
        const r = await expect(probe, "a response to detection", () => true);
        current.detectionReply = r;
        const parsed = parseDetection({ status: r.status, body: r.body, credentialed: current.credential !== undefined });
        if (!parsed.ok) throw mismatch(probe, r.received, `a complete valid detection reply: ${parsed.detail}`);
        current.detection = parsed.value;
      } catch (error) { firstFailure ??= error; }
    }
    if (firstFailure !== undefined) throw firstFailure;
  });
  await check("G22", "only credentialed detection may report a policy, valid under its own lists", async () => {
    let inspected = 0;
    for (const current of detectionScopes) {
      const reply = current.detectionReply;
      if (reply === undefined) continue;
      inspected++;
      if (member(reply.body, "key_policy") === undefined) continue;
      if (current.credential === undefined) {
        throw mismatch(metadata("route-policy", current), reply.received, "key_policy absent for anonymous detection");
      }
      // Status and version belong to G20, not to the validity of this policy.
      const body = { route_policy: "1", ...Object.fromEntries(["keys", "attest", "sort", "key_policy"]
        .flatMap((name) => {
          const value = member(reply.body, name);
          return value === undefined ? [] : [[name, value]];
        })) };
      const parsed = parseDetection({ status: 200, body, credentialed: true });
      if (!parsed.ok && parsed.key === "key_policy") {
        throw mismatch(metadata("route-policy", current), reply.received, `key_policy valid under the advertised lists: ${parsed.detail}`);
      }
    }
    if (inspected !== detectionScopes.size) return "an inspectable detection reply under each supplied credential and anonymously";
  });
  await check("G23", "unique model and provider ids with valid published facts and evidence for each credential", async () => {
    let firstFailure: unknown;
    let count = 0;
    for (const current of modelScopes) {
      const probe = metadata("models", current);
      try {
        const reply = await expect(probe, "a successful model list", () => true);
        if (isBareError(reply)) continue;
        const problem = schemaProblem(reply.body);
        if (problem !== undefined || reply.status < 200 || reply.status >= 300) throw mismatch(probe, reply.received, problem ?? "a successful model list");
        current.models = discover(reply.body, current.detection?.support ?? BASELINE);
        current.catalogAvailable = true;
        count++;
      } catch (error) { firstFailure ??= error; }
    }
    if (firstFailure !== undefined) throw firstFailure;
    if (count !== modelScopes.size) return "an accessible /models response for each supplied credential";
  });

  const on = (ep: Endpoint, credential?: Credential) => (id: string, header?: string, suffix?: string, stream?: boolean): Probe => ({
    path: ep, raw: bodyFor(ep, suffix === undefined ? id : `${id}+${suffix}`, stream),
    ...(header === undefined ? {} : { policies: [header] }), ...(credential === undefined ? {} : { credential }),
  });
  const allowedOrUnavailable = (allowed: readonly string[]) => (r: Observation) => couldRelay(r, allowed);
  const unsatisfiable = (r: Observation) => refusal(r, "unsatisfiable");
  const rejected = (r: Observation) => refusal(r, "unsupported");
  for (const { endpoint, primary, bound: policyScope } of selections) {
    const firstExchange = exchanges.length;
    const { detection, models } = primary;
    const support = detection?.support;
    const boundText = detection?.keyPolicy;
    const boundParsed = typeof boundText === "string" && support !== undefined ? parsePolicy(boundText, support) : undefined;
    const bound = boundParsed?.ok ? boundParsed.value : undefined;
    const policyDetection = policyScope.detection;
    const policyBoundResult = policyDetection?.keyPolicy ? parsePolicy(policyDetection.keyPolicy, policyDetection.support) : undefined;
    const policyBound = policyBoundResult?.ok ? policyBoundResult.value : undefined;
    const needModel = "a published base model for this endpoint's credential";
    const knowBound = boundText === null || boundParsed?.ok === true;
    const withKey = (policy?: Policy) => combinePolicies({ ...(bound === undefined ? {} : { key: bound }), ...(policy === undefined ? {} : { header: policy }) });
    const candidates = models.flatMap((model) => model.policies.map(({ text, policy }) => ({ model, text, policy, allowed: qualifying(model, withKey(policy)) })));
    const positives = candidates.filter(({ allowed }) => allowed.length > 0);
    const negatives = candidates.filter(({ allowed }) => allowed.length === 0);
    const positive = positives.find((entry) => entry.allowed.length < entry.model.routes.size) ?? positives[0];
    const negative = negatives.find(({ model, text }) => model.routes.size > 0 && !text.startsWith("only=")) ?? negatives[0];
    const first = models[0];
    const unknownModel = unused(new Set(models.map(({ id }) => id)), "route-conformance-unknown-");
    const inference = on(endpoint, primary.credential);
    const policyInference = on(endpoint, policyScope.credential);
    const bodyProbe = (raw: string): Probe => ({ ...metadata(endpoint, primary), raw });
    const run = (id: string, detail: string, fn: () => Promise<void | string>) => check(id, detail, fn, endpoint);
    // Ordinary-error samples serve both G25 and the final error-shape audit.
    async function ordinaryError(probe: Probe): Promise<Exchange> {
      const sample = await observe(probe).catch((error: unknown) => { throw mismatch(probe, String(error), "an ordinary error response"); });
      if (!isBareError(sample.reply)) throw mismatch(probe, sample.reply.received, "an ordinary error with no route headers");
      return sample;
    }
    async function compareOwn(before: Exchange, probe: Probe): Promise<void> {
      before.ordinaryControl = true;
      const requirement = `the same ordinary error status ${before.reply.status} as the no-policy control, with no result headers`;
      const { reply } = await observe(probe).catch((error: unknown) => { throw mismatch(probe, String(error), requirement); });
      if (!noResult(reply)) throw mismatch(probe, reply.received, requirement);
      if (reply.status === before.reply.status) return;
      const repeated = await observe(before.probe).catch(() => undefined);
      if (repeated === undefined || !isBareError(repeated.reply) || repeated.reply.status !== before.reply.status) {
        const last = repeated === undefined ? "no response" : `HTTP ${repeated.reply.status}`;
        precondition ??= `a stable ordinary error; the two no-policy controls returned HTTP ${before.reply.status} and ${last}`;
        return;
      }
      throw mismatch(probe, reply.received, requirement);
    }
    await run("G1", "invalid policies are refused, not ignored", async () => {
      if (first === undefined) return needModel;
      for (const invalid of ["", "bits=0", "region=uk", "only=probe0,probe0", "zdr++notrain", "zdr=1"]) {
        await expect(inference(first.id, invalid), "400 unsupported for malformed policy", (r) => {
          const parsed = r.refused.length === 1 ? parseRefused(r.refused[0]!) : null;
          return r.status === REFUSAL_STATUS.unsupported && r.applied.length === 0 && r.evidence.length === 0
            && parsed?.ok === true && parsed.value.reason === "unsupported";
        });
      }
    });
    await run("G2", "first bad pair is named, but whole-string and malformed-key failures name no key", async () => {
      if (first === undefined) return needModel;
      const cases = [["bits=0+only=a,a", "bits"], ["only=a,a+bits=0", "only"], ["Bad+bits=0", null], [`bits=0+${Array.from({ length: 16 }, () => "later").join("+")}`, null], [`bits=0+ignore=${"a".repeat(512)}`, null]] as const;
      for (const [text, key] of cases) await expect(inference(first.id, text), `400 ${formatRefused("unsupported", key)}`, (r) => refusal(r, "unsupported", key));
    });
    await run("G3", "policies meeting no published route are unsatisfiable and name no key", async () => {
      if (!knowBound || negative === undefined) return "an interpretable ordinary key default and a supported policy no published route meets";
      const witnesses = new Map<string, typeof negative>();
      for (const candidate of [negative, ...negatives]) {
        const key = keysOf(candidate.policy)[0]!;
        if (!witnesses.has(key)) witnesses.set(key, candidate);
      }
      for (const { model, text } of witnesses.values()) {
        await expect(inference(model.id, text), "400 unsatisfiable with no key or other result headers", unsatisfiable);
      }
    });
    await run("G6", "relayed providers meet the policy by their published facts and id", async () => {
      if (!knowBound || positive === undefined) return "an interpretable ordinary key default and a satisfiable advertised policy";
      const byKey = new Map<string, typeof positive>();
      for (const entry of positives) {
        const key = keysOf(entry.policy)[0]!;
        const prior = byKey.get(key);
        if (prior === undefined || (prior.allowed.length === prior.model.routes.size && entry.allowed.length < entry.model.routes.size)) byKey.set(key, entry);
      }
      let relays = 0;
      for (const { model, text, allowed } of byKey.values()) {
        const alternate = text.startsWith("only=") ? positives.find((entry) => entry.model === model && entry.policy.only !== null && !entry.allowed.some((id) => allowed.includes(id))) : undefined;
        if (alternate !== undefined) {
          const reply = await expect(inference(model.id, alternate.text), `a different qualifying provider (${alternate.allowed.join(", ")}) or 503 unavailable`, allowedOrUnavailable(alternate.allowed));
          if (applied(reply) !== null) relays++;
        }
        const response = await expect(inference(model.id, text), `a qualifying provider (${allowed.join(", ")}) or 503 unavailable`, allowedOrUnavailable(allowed));
        if (applied(response) !== null) relays++;
      }
      if (relays === 0) return "a relay for a satisfiable policy (all probes returned unavailable)";
    });
    await run("G7", "preferences cannot disqualify matching routes or admit excluded ones", async () => {
      if (!knowBound || positive === undefined || support === undefined) return "a satisfiable advertised policy with an interpretable ordinary key default";
      const { model, text, policy, allowed } = positive;
      const excluded = [...model.routes.keys()].find((id) => !allowed.includes(id));
      const preferences = [...(support.keys.has("order") ? [`order=${excluded ?? model.unknown}`] : []), ...(support.keys.has("sort") ? [...support.sort].map((value) => `sort=${value}`) : [])];
      let ran = false;
      for (const pref of preferences) {
        if (pref.startsWith("sort=") && policy.sort !== null || pref.startsWith("order=") && policy.order !== null) continue;
        const combined = `${text}+${pref}`;
        if (!parsePolicy(combined, support).ok) continue;
        ran = true;
        await expect(inference(model.id, combined), `preference must leave the same candidates (${allowed.join(", ")}), even if it points elsewhere`, allowedOrUnavailable(allowed));
        await expect(inference(model.id, text, pref), `the same preference in a suffix leaves the same candidates (${allowed.join(", ")})`, allowedOrUnavailable(allowed));
      }
      if (!ran) return "an accepted preference that can accompany the matching policy";
    });
    await run("G8", "the suffix resolves its base model and applies its policy", async () => {
      if (first === undefined) return needModel;
      await expect(inference(first.id, undefined, ""), "empty suffix for an existing model resolves that model and returns 400 unsupported, no key", rejected);
      if (!knowBound) return "a plain key default this suite can interpret";
      if (positive !== undefined) await expect(inference(positive.model.id, undefined, positive.text), "suffixed request resolves to a qualifying route or unavailable", allowedOrUnavailable(positive.allowed));
      if (negative !== undefined) await expect(inference(negative.model.id, undefined, negative.text), "unsatisfiable suffix returns 400 unsatisfiable", unsatisfiable);
    });
    await run("G9", "the HTTP header applies and two differently cased field lines refuse without a key", async () => {
      if (first === undefined) return needModel;
      const dupe = { ...inference(first.id), policies: support?.keys.has("only") ? [`only=${first.unknown}`, "probe1"] : ["bits=1", "bits=2"] };
      await expect(dupe, "two raw Route-Policy lines return 400 unsupported without a key", rejected);
      if (!knowBound) return "a plain key default this suite can interpret";
      if (positive !== undefined) await expect(inference(positive.model.id, positive.text), "header routes only among matching providers or returns unavailable", allowedOrUnavailable(positive.allowed));
      if (negative !== undefined) await expect({ ...inference(negative.model.id, negative.text), mixedCasePolicy: true }, "a mixed-case Route-Policy header applies even when unsatisfiable", unsatisfiable);
    });
    await run("G10", "a bound key policy applies with no explicit carrier", async () => {
      if (policyBound === undefined) return "a usable credential with a detected, interpretable policy (supply --policy-key)";
      const cases = policyScope.models.map((model) => ({ model, allowed: qualifying(model, policyBound) }));
      if (cases.length === 0) return "a published base model for the bound key";
      for (const { model, allowed } of cases) {
        await expect(policyInference(model.id), `the key alone applies: ${allowed.length === 0 ? "unsatisfiable" : `only (${allowed.join(", ")}) or unavailable`}`, allowed.length === 0 ? unsatisfiable : allowedOrUnavailable(allowed));
      }
    });
    await run("G11", "header then suffix are validated separately; valid carriers constrain each other", async () => {
      if (first === undefined) return needModel;
      await expect(inference(first.id, "bits=0", "only=x,x"), "first failing carrier is the header, whose key is bits", (r) => refusal(r, "unsupported", "bits"));
      await expect(inference(first.id, "only=x,x", "bits=0"), "swapping malformed carriers reports only, the header's first failure", (r) => refusal(r, "unsupported", "only"));
      if (!knowBound) return "a plain key default this suite can interpret";
      for (const left of positives) {
        const right = positives.find((candidate) => candidate.model === left.model && keysOf(candidate.policy)[0] !== keysOf(left.policy)[0] && !candidate.allowed.some((id) => left.allowed.includes(id)));
        if (right === undefined) continue;
        for (const [header, suffix] of [[left.text, right.text], [right.text, left.text]] as const) {
          await expect(inference(left.model.id, header, suffix), "individually satisfiable carriers with no common matching route combine to unsatisfiable", unsatisfiable);
        }
        break;
      }
      for (const model of models) {
        const zdr = positives.find((candidate) => candidate.model === model && candidate.text === "zdr");
        const notrain = positives.find((candidate) => candidate.model === model && candidate.text === "notrain");
        if (zdr === undefined || notrain === undefined) continue;
        const allowed = qualifying(model, combinePolicies({ ...(bound === undefined ? {} : { key: bound }), header: zdr.policy, suffix: notrain.policy }));
        if (allowed.length === zdr.allowed.length && allowed.length === notrain.allowed.length) continue;
        for (const [header, suffix] of [["zdr", "notrain"], ["notrain", "zdr"]]) {
          await expect(inference(model.id, header, suffix), "both retention and training requirements survive combination",
            allowed.length ? allowedOrUnavailable(allowed) : unsatisfiable);
        }
        break;
      }
      if (positive !== undefined) {
        const parsed = parsePolicy("bits=0", support);
        if (!parsed.ok) await expect(inference(positive.model.id, positive.text, "bits=0"), "a valid header does not bypass validation of the suffix", (r) => refusal(r, "unsupported", parsed.key));
        const { model, text, allowed } = positive;
        await expect(inference(model.id, text, text), "a valid policy repeated across carriers is not a duplicate within one carrier", allowedOrUnavailable(allowed));
      }
      // Prefer probes that can distinguish losing either input, not just one.
      const best = new Map<string, { left: (typeof positives)[number]; right: (typeof positives)[number]; allowed: string[]; score: number }>();
      const groups = new Map<Model, Map<string, (typeof positives)[number][]>>();
      for (const entry of positives) {
        const key = keysOf(entry.policy)[0]!;
        if (!["bits", "region", "only", "attest", "ignore"].includes(key)) continue;
        let byKey = groups.get(entry.model);
        if (byKey === undefined) groups.set(entry.model, byKey = new Map());
        let group = byKey.get(key);
        if (group === undefined) byKey.set(key, group = []);
        group.push(entry);
      }
      for (const [model, byKey] of groups) for (const [key, group] of byKey) {
        if (best.get(key)?.score === 3) continue;
        pairs: for (const [i, left] of group.entries()) for (let j = i + 1; j < group.length; j++) {
          const right = group[j]!;
          const combined = combinePolicies({ ...(bound === undefined ? {} : { key: bound }), header: left.policy, suffix: right.policy });
          const allowed = qualifying(model, combined);
          const narrowed = Number(allowed.length < left.allowed.length) + Number(allowed.length < right.allowed.length);
          const score = narrowed === 2 && allowed.length > 0 ? 3 : narrowed;
          if (score <= (best.get(key)?.score ?? 0)) continue;
          best.set(key, { left, right, allowed, score });
          if (score === 3) break pairs;
        }
      }
      for (const { left, right, allowed } of best.values()) {
        for (const [header, suffix] of [[left, right], [right, left]] as const) {
          await expect(inference(left.model.id, header.text, suffix.text), "matching routes reflect combined same-key requirements in either carrier order",
            allowed.length ? allowedOrUnavailable(allowed) : unsatisfiable);
        }
      }
    });
    await run("G12", "disjoint only and region carriers each form an empty intersection", async () => {
      if (first === undefined || support === undefined) return needModel;
      const cases: [string, string][] = [];
      if (support.keys.has("only")) {
        const ids = [...first.routes.keys()];
        cases.push([`only=${ids[0] ?? first.unknown}`, `only=${ids[1] ?? unused(new Set([...ids, first.unknown]), "routeprobe")}`]);
      }
      if (support.keys.has("region")) cases.push(["region=us", "region=de"]);
      if (cases.length === 0) return "at least one of only and region accepted";
      for (const [a, b] of cases) for (const [header, suffix] of [[a, b], [b, a]] as const) {
        await expect(inference(first.id, header, suffix), "400 unsatisfiable for an empty intersection in either carrier order", unsatisfiable);
      }
    });
    await run("G13", "a header, suffix or both cannot widen a key default", async () => {
      if (policyBound === undefined || policyDetection === undefined) return "a credential with an interpretable bound policy (supply --policy-key)";
      let ran = false;
      for (const model of policyScope.models) {
        const witnesses = new Map<string, { text: string; allowed: string[] }>();
        const consider = (text: string, policy: Policy, combineValue = false) => {
          const explicit = qualifying(model, policy);
          const allowed = qualifying(model, combinePolicies({ key: policyBound, header: policy }));
          if (!explicit.some((id) => !allowed.includes(id))) return;
          const signature = `${combineValue ? "overlap:" : ""}${keysOf(policy).join("+")}`;
          const prior = witnesses.get(signature);
          if (prior === undefined || (prior.allowed.length > 0 && allowed.length === 0)) witnesses.set(signature, { text, allowed });
        };
        for (const { text, policy } of model.policies) consider(text, policy);
        // An overlapping key can be implemented incorrectly even when omitting that key
        // from both explicit carriers preserves it. Try a weaker explicit value as well.
        for (const [id, route] of model.routes) {
          if (route === null || meets({ provider: id, facts: route.facts }, policyBound)) continue;
          const extraAttest = route.facts.attest.find((item) => !policyBound.attest.includes(item));
          const relaxations = [
            policyBound.bits !== null && route.facts.bits !== null && route.facts.bits < policyBound.bits ? `bits=${route.facts.bits}` : null,
            policyBound.region !== null && route.facts.region !== null ? `region=${[...new Set([...policyBound.region, ...route.facts.region])].join(",")}` : null,
            policyBound.ignore.includes(id) ? `ignore=${model.unknown}` : null,
            policyBound.only !== null && !policyBound.only.includes(id) ? `only=${[...policyBound.only, id].join(",")}` : null,
            policyBound.attest.length > 0 && extraAttest !== undefined ? `attest=${extraAttest}` : null,
          ];
          for (const relaxed of relaxations) {
            if (relaxed === null) continue;
            for (const text of [relaxed, `only=${id}+${relaxed}`]) {
              const parsed = parsePolicy(text, policyDetection.support);
              if (parsed.ok) consider(text, parsed.value, true);
            }
          }
        }
        if (witnesses.size === 0) continue;
        for (const { text, allowed } of witnesses.values()) {
          for (const [header, suffix] of [[text, undefined], [undefined, text], [text, text]] as const) {
            const requires = allowed.length === 0 ? "the key requirement excludes every explicitly matched route: unsatisfiable" : `the key requirement allows only (${allowed.join(", ")}) or unavailable`;
            await expect(policyInference(model.id, header, suffix), requires, allowed.length === 0 ? unsatisfiable : allowedOrUnavailable(allowed));
          }
        }
        ran = true;
      }
      if (!ran) return "an accepted explicit policy that would widen the matching routes without the bound policy";
    });
    // Supply one streaming probe and controls for both sides of the attest rule.
    // The final audit checks these and every other response observed below.
    await run("G15", "observed policy relays named a published provider", async () => {
      if (positive === undefined || !knowBound) return "a satisfiable advertised policy";
      await expect(inference(positive.model.id, positive.text, undefined, true), "streaming relay or unavailable", (r) => refusal(r, "unavailable") || r.applied.length > 0);
    });
    await run("G17", "observed relays gave evidence exactly when required", async () => {
      const attested = knowBound ? positives.find(({ policy }) => withKey(policy).attest.length > 0) : undefined;
      const unattested = knowBound ? positives.find(({ model, policy, allowed }) => withKey(policy).attest.length === 0 && allowed.every((id) => model.routes.get(id)?.evidence != null))
        ?? positives.find(({ policy }) => withKey(policy).attest.length === 0) : undefined;
      for (const candidate of [attested, unattested]) {
        if (candidate !== undefined) await expect(inference(candidate.model.id, candidate.text), "an inference response for the evidence probe", () => true);
      }
      if (policyBound !== undefined && policyBound.attest.length > 0) {
        const model = policyScope.models.find((entry) => qualifying(entry, policyBound).length > 0);
        if (model !== undefined) await expect(policyInference(model.id), "an inference response for the bound evidence probe", () => true);
      }
    });
    await run("G21", "unlisted keys and enum values refuse; listed fixed-domain keys accept their valid values", async () => {
      let missing: string | undefined;
      for (const current of new Set([primary, policyScope])) {
        const model = current.models[0];
        if (model === undefined || current.detection === undefined) {
          missing = "a valid detection reply and a published base model for each supplied credential";
          continue;
        }
        const sendFor = on(endpoint, current.credential);
        const modelId = model.id;
        const listed = (field: keyof Support) => new Set([...list(member(current.detectionReply?.body, field)) ?? BASELINE[field]]
          .filter((value): value is string => typeof value === "string"));
        const keys = listed("keys");
        const samples: Record<string, string[]> = {
          zdr: ["zdr"], notrain: ["notrain"], bits: ["bits=1", "bits=32", "bits=64"], region: ["region=us", "region=jp,de"],
          only: [`only=${model.unknown}`, "only=0,a-b_c.d"], ignore: [`ignore=${model.unknown}`, "ignore=0,a-b_c.d"], order: [`order=${model.unknown}`, "order=0,a-b_c.d"],
          attest: ["attest=weights"], sort: ["sort=price"],
        };
        const unknown = unused(keys, "probe");
        await expect(sendFor(model.id, unknown), `unlisted key ${unknown} is unsupported`, (r) => refusal(r, "unsupported", unknown));
        const accepted = (r: Observation) => (r.refused.length === 0 && applied(r) !== null) || unsatisfiable(r) || refusal(r, "unavailable");
        async function checkForm(name: string, text: string, isListed: boolean): Promise<void> {
          await expect(sendFor(modelId, text), isListed ? `advertised ${name} accepts ${text}` : `unlisted ${name} refuses ${text}`,
            isListed ? accepted : (r) => refusal(r, "unsupported", name));
        }
        for (const [name, examples] of Object.entries(samples)) {
          if ((name === "attest" || name === "sort") && keys.has(name)) continue;
          for (const text of examples) await checkForm(name, text, keys.has(name));
        }
        for (const name of ["attest", "sort"] as const) {
          if (!keys.has(name)) continue;
          const values = listed(name);
          const unknownValue = unused(values, "probe");
          for (const value of [...BASELINE[name], unknownValue]) await checkForm(name, `${name}=${value}`, values.has(value));
          if (name === "attest") {
            await checkForm(name, "attest=weights,prompt", values.has("weights") && values.has("prompt"));
            const known = [...BASELINE.attest].find((value) => values.has(value));
            if (known !== undefined) await checkForm(name, `attest=${known},${unknownValue}`, false);
          }
        }
      }
      return missing;
    });
    await run("G24", "unknown providers match nothing in only and have no effect in ignore and order", async () => {
      if (support === undefined || !knowBound) return needModel;
      let ran = false;
      if (first !== undefined && support.keys.has("only")) {
        ran = true;
        await expect(inference(first.id, `only=${first.unknown}`), "valid unknown provider in only matches nothing, not unsupported", unsatisfiable);
      }
      const model = models.find((m) => qualifying(m, withKey()).length > 0);
      if (model !== undefined) for (const key of ["ignore", "order"]) {
        if (!support.keys.has(key)) continue;
        ran = true;
        const allowed = qualifying(model, withKey());
        await expect(inference(model.id, `${key}=${model.unknown}`), `unknown provider in ${key} leaves qualifying providers unchanged`, allowedOrUnavailable(allowed));
        if (key === "order") {
          const known = allowed[0]!;
          await expect(inference(model.id, `order=${model.unknown},${known}`), "an unknown provider beside a known provider does not invalidate order", allowedOrUnavailable(allowed));
        } else {
          const excluded = allowed[0]!;
          const remaining = allowed.filter((id) => id !== excluded);
          await expect(inference(model.id, `ignore=${model.unknown},${excluded}`), "an unknown provider beside a known provider does not change ignore",
            remaining.length === 0 ? unsatisfiable : allowedOrUnavailable(remaining));
        }
      }
      if (model !== undefined && support.keys.has("only")) {
        const [known] = qualifying(model, withKey());
        if (known !== undefined) await expect(inference(model.id, `only=${model.unknown},${known}`), "an unknown provider in only does not reject or widen the known provider", allowedOrUnavailable([known]));
      }
      if (!ran) return "an accepted provider-selection key and a suitable published model";
    });
    await run("G25", "malformed bodies, unknown models, and rejected credentials take precedence", async () => {
      const malformed = bodyProbe("{");
      const malformedControl = await ordinaryError(malformed);
      await compareOwn(malformedControl, { ...malformed, policies: [INVALID_POLICY, INVALID_POLICY] });
      await compareOwn(await ordinaryError(bodyProbe('{"model":4}')), { ...bodyProbe('{"model":4}'), policies: [INVALID_POLICY] });
      await compareOwn(await ordinaryError(inference("")), inference("", INVALID_POLICY, INVALID_POLICY));
      const missing: string[] = [];
      const observeControl = (probe: Probe) => observe(probe).catch(() => undefined);
      const unknown = await observeControl(inference(unknownModel));
      if (unknown === undefined || !isBareError(unknown.reply)) {
        missing.push(`unknown-model subcase: no-policy control did not establish an ordinary error (${unknown === undefined ? "no response" : `HTTP ${unknown.reply.status}`})`);
      } else if (!primary.catalogAvailable) {
        missing.push("unknown-model subcase: no accessible published catalog to corroborate rejection of the model");
      } else {
        // A catalog can omit a model that is nevertheless routable. Check for
        // a protocol routing result before treating the missing id as unknown.
        const witness = positive?.text ?? candidates[0]?.text;
        const resolution = witness === undefined ? undefined : (await observeControl(inference(unknownModel, witness)))?.reply;
        if (resolution === undefined) missing.push("unknown-model subcase: no accepted-policy control to test whether the unpublished model resolves");
        else if (applied(resolution) !== null || resolution.status < 400
          || refusal(resolution, "unavailable") || unsatisfiable(resolution)) {
          missing.push(`unknown-model subcase: accepted-policy control reached routing for the unpublished model (HTTP ${resolution.status})`);
        } else {
          await compareOwn(unknown, inference(unknownModel, INVALID_POLICY, INVALID_POLICY));
        }
      }

      if (first === undefined) missing.push("bad-credentials subcase: no published base model");
      else {
        const credential: Credential = { key: `route-conformance-invalid-${crypto.randomUUID()}`, header: authHeaderFor(endpoint) };
        const plain = { ...inference(first.id), credential };
        const candidate = await observeControl(plain);
        if (candidate === undefined || !isBareError(candidate.reply)) {
          missing.push("bad-credentials subcase: no-policy control did not establish rejection of the credential");
        } else {
          // An unreadable body cannot produce a provider relay. Changing only
          // the credential should reproduce the candidate's error there and
          // distinguish it from the ordinary malformed-body error.
          const challenge = await observeControl({ ...malformed, credential });
          if (challenge !== undefined && isBareError(challenge.reply) && challenge.reply.status === candidate.reply.status
            && challenge.reply.status !== malformedControl.reply.status) {
            await compareOwn(candidate, { ...plain, policies: [INVALID_POLICY] });
          } else {
            missing.push(`bad-credentials subcase: headerless HTTP ${candidate.reply.status} did not distinguish credential rejection from a provider relay`);
          }
        }
      }
      const throttleModel = policyBound === undefined ? undefined : policyScope.models.find((model) => qualifying(model, policyBound).length > 0);
      if (throttleModel !== undefined) {
        const plain = policyInference(throttleModel.id);
        const before = await observeControl(plain);
        if (before !== undefined && before.reply.status === 429 && isBareError(before.reply)) {
          // The bound policy means even a relayed 429 requires Route-Applied.
          // Bracket the challenge; a throttle that has cleared proves nothing.
          const probe = policyInference(throttleModel.id, INVALID_POLICY);
          const challenged = await observeControl(probe);
          if (challenged === undefined || challenged.reply.status !== 429 || !noResult(challenged.reply)) {
            const after = await observeControl(plain);
            if (after?.reply.status === 429 && isBareError(after.reply)) {
              throw mismatch(probe, challenged?.reply.received ?? "no response", "ordinary HTTP 429 with no route headers while both bound-key controls are throttled");
            }
            missing.push("rate-limit subcase: the bound-key control was no longer throttled after the probe");
          }
        }
      }
      if (missing.length > 0) return missing.join("; ");
    });
    await run("G26", "ordinary traffic without a policy carries neither refusal nor evidence", async () => {
      if (detection?.keyPolicy !== null || first === undefined) return "a known unbound ordinary credential and a published base model";
      await expect(inference(first.id), "without any policy, neither Route-Refused nor Route-Evidence", (r) => r.refused.length === 0 && r.evidence.length === 0);
    });
    await run("G29", "unsupported takes precedence over an otherwise unsatisfiable policy", async () => {
      if (negative === undefined || !knowBound) return "a supported policy no published route meets";
      await expect(inference(negative.model.id, "bits=0", negative.text), "invalid header takes precedence over unsatisfiable suffix", (r) => refusal(r, "unsupported", "bits"));
      await expect(inference(negative.model.id, negative.text, "bits=0"), "invalid suffix takes precedence over unsatisfiable header", (r) => refusal(r, "unsupported", "bits"));
    });
    const endpointExchanges = exchanges.slice(firstExchange);
    // A refusal with a different credential may use a different endpoint envelope.
    const unmatched = new Set(endpointExchanges.filter(({ probe, reply }) => reply.refused.length > 0
      && !endpointExchanges.some(({ probe: sample, ordinaryControl, reply: ordinary }) => sample.credential === probe.credential && ordinaryControl && ordinary.hasBody))
      .map(({ probe }) => probe.credential));
    for (const credential of unmatched) {
      for (const raw of ["{", '{"model":4}']) {
        const sample = await observe({ path: endpoint, raw, ...(credential === undefined ? {} : { credential }) }).catch(() => undefined);
        if (sample !== undefined && isBareError(sample.reply)) sample.ordinaryControl = true;
      }
    }
    const audit = auditResults(exchanges.slice(firstExchange), (probe) => resultContext(probe, scopeFor(probe)));
    const audited = (id: AuditId, detail: string, missing?: string) => {
      const failure = audit.failures.get(id);
      const existing = checks.find((entry) => entry.id === id && entry.endpoint === endpoint);
      const verdict: Check = failure !== undefined ? { id, endpoint, status: "FAIL", detail: failure }
        : missing !== undefined ? { id, endpoint, status: "SKIP", detail: `missing precondition: ${missing}` }
        : { id, endpoint, status: "PASS", detail };
      if (existing === undefined) checks.push(verdict);
      else if (failure !== undefined || (existing.status === "PASS" && missing !== undefined)) Object.assign(existing, verdict);
    };
    for (const [id] of audit.failures) audited(id, "");
    audited("G6", "observed relays met the combined policy");
    audited("G15", "observed policy relays named a published provider", audit.sawPolicyRelay ? undefined : "a relay for a request with a policy");
    audited("G17", "observed relays gave evidence exactly when required", audit.sawAttestationRelay ? undefined : "a relay for a policy with attest");
    audited("G19", "observed refusals and relays used exclusive single result headers", audit.sawPolicyResult ? undefined : "an observed policy refusal or relay");
    audited("G26", "observed policy-free traffic carried neither refusal nor evidence");
    audited("G34", "every observed refusal matched an endpoint error shape", audit.sawRefusal && audit.comparedErrorShape && !audit.unpairedErrorShape
      ? undefined : audit.sawRefusal ? "an ordinary error body under the same credential for each observed refusal" : "an observed refusal");
  }

  return { checks, passed: checks.filter((c) => c.status === "PASS").length, failed: checks.filter((c) => c.status === "FAIL").length, skipped: checks.filter((c) => c.status === "SKIP").length };
}
