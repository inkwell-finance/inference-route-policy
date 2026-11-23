import {
  baselineSupport, combinePolicies, formatRefused, isEvidenceUri, isProviderId, keysOf, meets, parseDetection,
  parsePolicy, parsePublishedFacts, parseRefused, publishedRoutes, REFUSAL_STATUS, someRouteMeets, splitModel,
  type Detection, type Policy, type PublishedRoute, type RefusalReason, type Support,
} from "../../core/src/index.ts";
import { request, sent, type Credential, type Observation, type Probe } from "./http.ts";
import { applied, auditResults, noResult, type Exchange, type ResultContext } from "./outcomes.ts";

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
  return reply.status === REFUSAL_STATUS[reason] && reply.refused.length === 1 && reply.refused[0] === (reason === "unsupported" ? formatRefused(reason, key) : formatRefused(reason));
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

// These statuses can vary between the probe and its control even with the same input.
const transientOwnError = (reply: Observation): boolean => noResult(reply) && (reply.status === 429 || reply.status === 503);

function resultContext(probe: Probe, scope: Scope | undefined): ResultContext {
  const model = member(jsonBody(probe), "model");
  const split = typeof model === "string" ? splitModel(model) : undefined;
  const routeMap = scope?.models.find(({ id }) => id === split?.id)?.routes;
  const keyPolicy = scope?.detection?.keyPolicy;
  const explicit = (probe.policies?.length ?? 0) > 0 || split?.policy != null;
  const carriesPolicy = explicit || keyPolicy != null ? true : keyPolicy === null ? false : undefined;
  const result: ResultContext = { carriesPolicy, ...(routeMap === undefined ? {} : { routes: routeMap }) };
  if (scope?.detection === undefined) return result;
  if ((probe.policies?.length ?? 0) > 1) return { ...result, requiresRefusal: true };
  const layers: { key?: Policy; header?: Policy; suffix?: Policy } = {};
  for (const [layer, text] of [["key", keyPolicy], ["header", probe.policies?.[0]], ["suffix", split?.policy]] as const) {
    if (text == null) continue;
    const parsed = parsePolicy(text, scope.detection.support);
    if (!parsed.ok) return { ...result, requiresRefusal: true };
    layers[layer] = parsed.value;
  }
  result.combined = combinePolicies(layers);
  if (carriesPolicy === true && routeMap !== undefined) result.requiresRefusal = !someRouteMeets(routeMap, result.combined);
  return result;
}

export async function runConformance(options: Options): Promise<Report> {
  const url = new URL(options.base);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.search || url.hash || url.username || url.password) throw new TypeError("base must be an HTTP(S) API base URL without a query, fragment, or credentials");
  const base = url.href.replace(/\/+$/, "");
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
    if (probe.raw !== undefined && reply.status >= 400 && noResult(reply)) {
      const plain = withoutExplicitPolicy(probe);
      const control = await observe(plain).catch(() => undefined);
      if (control !== undefined && control.reply.status === reply.status && noResult(control.reply)) {
        const context = resultContext(plain, scopeFor(plain));
        precondition ??= `gateway answered its own error ${reply.status} to the ${context.carriesPolicy === true ? "control without explicit policy (same bound key)" : "no-policy control"}`;
        return reply;
      }
      if (reply.status === REFUSAL_STATUS.unsupported && control !== undefined && (control.reply.status < 400 || applied(control.reply) !== null)
        && resultContext(probe, scopeFor(probe)).requiresRefusal) exchange.missingRefusal = true;
      if (transientOwnError(reply)) {
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
  await check("G20", "valid version-string detection with and without supplied credentials", async () => {
    let firstFailure: unknown;
    for (const current of detectionScopes) {
      const probe = metadata("route-policy", current);
      try {
        await expect(probe, 'HTTP 200 and a JSON detection object with route_policy: \"1\" and valid lists', (r) => {
          current.detectionReply = r;
          const parsed = parseDetection({ status: r.status, body: r.body, credentialed: current.credential !== undefined });
          if (parsed.ok) current.detection = parsed.value;
          // Keep G22 diagnostics separate from version and list errors.
          const lists = Object.fromEntries(["keys", "attest", "sort"].flatMap((k) => {
            const value = member(r.body, k);
            return value === undefined ? [] : [[k, value]];
          }));
          return parseDetection({ status: r.status, body: { route_policy: member(r.body, "route_policy"), ...lists }, credentialed: false }).ok;
        });
      } catch (error) { firstFailure ??= error; }
    }
    if (firstFailure !== undefined) throw firstFailure;
  });
  await check("G22", "only credentialed detection may report a policy, valid under its own lists", async () => {
    if (![...detectionScopes].some((current) => current.detectionReply !== undefined)) return "a detection response that can be inspected";
    for (const current of detectionScopes) {
      const reply = current.detectionReply;
      if (reply !== undefined && member(reply.body, "key_policy") !== undefined && current.detection === undefined) {
        throw mismatch(metadata("route-policy", current), reply.received, "key_policy absent for anonymous detection and valid under the advertised lists when present");
      }
    }
  });
  await check("G23", "unique model and provider ids with valid published facts and evidence for each credential", async () => {
    let firstFailure: unknown;
    let count = 0;
    for (const current of modelScopes) {
      const probe = metadata("models", current);
      try {
        const reply = await expect(probe, "a successful model list", () => true);
        if (noResult(reply) && (reply.status === 401 || reply.status === 403 || transientOwnError(reply))) continue;
        const problem = schemaProblem(reply.body);
        if (problem !== undefined || reply.status < 200 || reply.status >= 300) throw mismatch(probe, reply.received, problem ?? "a successful model list");
        current.models = discover(reply.body, current.detection?.support ?? BASELINE);
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
      if (sample.reply.status < 400 || !noResult(sample.reply)) throw mismatch(probe, sample.reply.received, "an ordinary error with no route headers");
      return sample;
    }
    async function compareOwn(before: Exchange, probe: Probe): Promise<void> {
      before.ordinaryControl = true;
      const { reply } = await ordinaryError(probe);
      if (reply.status === before.reply.status) return;
      if (transientOwnError(before.reply) || transientOwnError(reply)) {
        precondition ??= `a stable ordinary error; the two probes returned HTTP ${before.reply.status} and ${reply.status}`;
        return;
      }
      throw mismatch(probe, reply.received, `the same ordinary error status ${before.reply.status} as the no-policy control`);
    }
    await run("G1", "invalid policies are refused, not ignored", async () => {
      if (first === undefined) return needModel;
      for (const invalid of ["", "bits=0", "region=uk", "only=probe0,probe0", "zdr++notrain", "zdr=1"]) {
        await expect(inference(first.id, invalid), "400 unsupported for malformed policy", (r) => {
          const parsed = r.refused.length === 1 ? parseRefused(r.refused[0]!) : null;
          return r.status === REFUSAL_STATUS.unsupported && parsed?.ok === true && parsed.value.reason === "unsupported";
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
      await expect(inference(negative.model.id, negative.text), "400 unsatisfiable with no key", unsatisfiable);
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
      const chosen = cases.find(({ model, allowed }) => allowed.length > 0 && allowed.length < model.routes.size)
        ?? cases.find(({ allowed }) => allowed.length === 0) ?? cases[0];
      if (chosen === undefined) return "a published base model for the bound key";
      await expect(policyInference(chosen.model.id), `the key alone applies: ${chosen.allowed.length === 0 ? "unsatisfiable" : `only (${chosen.allowed.join(", ")}) or unavailable`}`, chosen.allowed.length === 0 ? unsatisfiable : allowedOrUnavailable(chosen.allowed));
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
      if (positive !== undefined) {
        const parsed = parsePolicy("bits=0", support);
        if (!parsed.ok) await expect(inference(positive.model.id, positive.text, "bits=0"), "a valid header does not bypass validation of the suffix", (r) => refusal(r, "unsupported", parsed.key));
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
      for (const [header, suffix] of cases) await expect(inference(first.id, header, suffix), "400 unsatisfiable for an empty intersection", unsatisfiable);
    });
    await run("G13", "a header, suffix or both cannot widen a key default", async () => {
      if (policyBound === undefined || policyDetection === undefined) return "a credential with an interpretable bound policy (supply --policy-key)";
      for (const model of policyScope.models) {
        const challenges = new Map<string, string[]>();
        const consider = (text: string, policy: Policy) => {
          const explicit = qualifying(model, policy);
          const combined = qualifying(model, combinePolicies({ key: policyBound, header: policy }));
          if (explicit.some((id) => !combined.includes(id))) challenges.set(text, combined);
        };
        for (const { text, policy } of model.policies) {
          consider(text, policy);
          if (challenges.size === 3) break;
        }
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
              if (parsed.ok) consider(text, parsed.value);
            }
          }
          if (challenges.size >= 5) break;
        }
        if (challenges.size === 0) continue;
        for (const [text, allowed] of challenges) {
          for (const [header, suffix] of [[text, undefined], [undefined, text], [text, text]] as const) {
            const requires = allowed.length === 0 ? "the key requirement excludes every explicitly matched route: unsatisfiable" : `the key requirement allows only (${allowed.join(", ")}) or unavailable`;
            await expect(policyInference(model.id, header, suffix), requires, allowed.length === 0 ? unsatisfiable : allowedOrUnavailable(allowed));
          }
        }
        return;
      }
      return "an accepted explicit policy that would widen the matching routes without the bound policy";
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
      if (first === undefined || support === undefined) return needModel;
      const detectionBody = primary.detectionReply?.body;
      const listed = (field: keyof Support) => new Set(list(member(detectionBody, field)) ?? BASELINE[field]);
      const keys = listed("keys");
      const samples: Record<string, string[]> = {
        zdr: ["zdr"], notrain: ["notrain"], bits: ["bits=1", "bits=32", "bits=64"], region: ["region=us", "region=jp,de"],
        only: [`only=${first.unknown}`, "only=0,a-b_c.d"], ignore: [`ignore=${first.unknown}`, "ignore=0,a-b_c.d"], order: [`order=${first.unknown}`, "order=0,a-b_c.d"],
        attest: ["attest=weights"], sort: ["sort=price"],
      };
      const unknown = unused(new Set([...keys].filter((value): value is string => typeof value === "string")), "probe");
      await expect(inference(first.id, unknown), `unlisted key ${unknown} is unsupported`, (r) => refusal(r, "unsupported", unknown));
      const accepted = (r: Observation) => (r.refused.length === 0 && applied(r) !== null) || unsatisfiable(r) || refusal(r, "unavailable");
      for (const [key, examples] of Object.entries(samples)) {
        if ((key === "attest" || key === "sort") && keys.has(key)) continue;
        for (const text of examples) {
          if (!keys.has(key)) await expect(inference(first.id, text), `unlisted key ${key} is unsupported`, (r) => refusal(r, "unsupported", key));
          else await expect(inference(first.id, text), `listed ${key} accepts valid form ${text}`, accepted);
        }
      }
      for (const key of ["attest", "sort"] as const) {
        if (!keys.has(key)) continue;
        const enumValues = listed(key);
        const unknownValue = unused(new Set([...enumValues].filter((value): value is string => typeof value === "string")), "probe");
        for (const value of [...BASELINE[key], unknownValue]) {
          const text = `${key}=${value}`;
          if (!enumValues.has(value)) await expect(inference(first.id, text), `unlisted value ${value} for ${key} is unsupported`, (r) => refusal(r, "unsupported", key));
          else await expect(inference(first.id, text), `listed value ${value} for ${key} is accepted`, accepted);
        }
      }
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
      }
      if (!ran) return "an accepted provider-selection key and a suitable published model";
    });
    await run("G25", "malformed bodies, unknown models, and rejected credentials take precedence", async () => {
      const samples: [Probe, Probe][] = [
        [bodyProbe("{"), { ...bodyProbe("{"), policies: [INVALID_POLICY, INVALID_POLICY] }],
        [bodyProbe('{"model":4}'), { ...bodyProbe('{"model":4}'), policies: [INVALID_POLICY] }],
        [inference(""), inference("", INVALID_POLICY, INVALID_POLICY)],
      ];
      for (const [plain, policy] of samples) {
        await compareOwn(await ordinaryError(plain), policy);
      }
      // Absence from /models alone doesn't prove that a model id won't resolve.
      const unknown = await observe(inference(unknownModel));
      if (unknown.reply.status === 404 && noResult(unknown.reply)) {
        await compareOwn(unknown, inference(unknownModel, INVALID_POLICY, INVALID_POLICY));
      }
      if (first !== undefined) {
        const wrongKey = `route-conformance-invalid-${crypto.randomUUID()}`;
        const beforeProbe = { ...inference(first.id), credential: { key: wrongKey, header: authHeaderFor(endpoint) } };
        const before = await observe(beforeProbe);
        if (before.reply.status === 401 || before.reply.status === 403) {
          if (!noResult(before.reply)) throw mismatch(beforeProbe, before.reply.received, "a credential error carries no result headers");
          await compareOwn(before, { ...beforeProbe, policies: [INVALID_POLICY] });
        }
      }
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
        if (sample !== undefined && sample.reply.status >= 400 && noResult(sample.reply)) sample.ordinaryControl = true;
      }
    }
    const audit = auditResults(exchanges.slice(firstExchange), (probe) => resultContext(probe, scopeFor(probe)));
    const audited = (id: "G6" | "G15" | "G17" | "G19" | "G26" | "G34", detail: string, missing?: string) => {
      const failure = audit.failures.get(id);
      const existing = checks.find((entry) => entry.id === id && entry.endpoint === endpoint);
      const verdict: Check = failure !== undefined ? { id, endpoint, status: "FAIL", detail: failure }
        : missing !== undefined ? { id, endpoint, status: "SKIP", detail: `missing precondition: ${missing}` }
        : { id, endpoint, status: "PASS", detail };
      if (existing === undefined) checks.push(verdict);
      else if (failure !== undefined || (existing.status === "PASS" && missing !== undefined)) Object.assign(existing, verdict);
    };
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
