import {
  baselineSupport, combinePolicies, formatRefused, isEvidenceUri, isProviderId, keysOf, meets, parseApplied, parseDetection,
  parsePolicy, parsePublishedFacts, parseRefused, publishedRoutes, REFUSAL_STATUS, splitModel,
  type Detection, type Policy, type PublishedRoute, type RefusalReason, type Support,
} from "../../core/src/index.ts";
import { request, sent, type Observation, type Probe } from "./http.ts";

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

const BASELINE = baselineSupport();
const INVALID_KEY = "routeprobeinvalid";
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
    if (typeof id !== "string" || splitModel(id).id === "" || ids.has(id) || routes === undefined) return `invalid or repeated model entry: ${JSON.stringify(entry)}`;
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
    const split = splitModel(id);
    if (split.policy !== null && (!ids.has(split.id) || split.policy === "")) return `alias ${id} lacks a base model or suffix`;
  }
}

function discover(body: unknown, support: Support): Model[] {
  const models: Model[] = [];
  for (const entry of list(member(body, "data")) ?? []) {
    const id = member(entry, "id");
    if (typeof id !== "string" || id === "" || splitModel(id).policy !== null) continue;
    const routes = publishedRoutes(body, id);
    const unknown = unused(new Set(routes.keys()), "routeprobe");
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

function applied(reply: Observation): string | null {
  if (reply.applied.length !== 1) return null;
  const parsed = parseApplied(reply.applied[0]!);
  return parsed.ok ? parsed.value : null;
}

function refusal(reply: Observation, reason: RefusalReason, key?: string | null): boolean {
  return reply.status === REFUSAL_STATUS[reason] && reply.refused.length === 1 && reply.refused[0] === (reason === "unsupported" ? formatRefused(reason, key) : formatRefused(reason));
}

const noResult = (reply: Observation): boolean => reply.applied.length === 0 && reply.refused.length === 0 && reply.evidence.length === 0;
const couldRelay = (reply: Observation, allowed: readonly string[]): boolean => refusal(reply, "unavailable") || allowed.some((id) => id === applied(reply));
const bodyFor = (endpoint: Endpoint, model: string, stream = false): string => JSON.stringify(endpoint === "responses"
  ? { model, input: "Reply with one word.", max_output_tokens: 16, stream }
  : { model, messages: [{ role: "user", content: "Reply with one word." }], max_tokens: 16, stream });

function shapeOf(body: unknown): string {
  if (body === null) return "null";
  if (Array.isArray(body)) return "array";
  if (typeof body !== "object") return typeof body;
  const error = member(body, "error");
  if (error !== undefined) {
    return `object:error(${typeof error},${typeof member(error, "message")},${typeof member(error, "type")}),type(${typeof member(body, "type")})`;
  }
  return `object:${Object.keys(body).sort().map((key) => `${key}:${typeof member(body, key)}`).join(",")}`;
}

export async function runConformance(options: Options): Promise<Report> {
  const url = new URL(options.base);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.search || url.hash || url.username || url.password) throw new TypeError("base must be an HTTP(S) API base URL without a query, fragment, or credentials");
  const base = url.href.replace(/\/+$/, "");
  const endpoints = options.endpoints ?? INFERENCE_ENDPOINTS;
  if (endpoints.length === 0 || endpoints.some((endpoint) => !INFERENCE_ENDPOINTS.includes(endpoint))) throw new TypeError("provide at least one recognized inference endpoint");
  const checks: Check[] = [];
  const primaryKey = options.key ?? options.policyKey;
  const credential = (probe: Probe) => probe.omitKey ? undefined : probe.key ?? primaryKey;
  const send = (probe: Probe) => request(base, probe, credential(probe), options.timeoutMs ?? 10_000);
  const mismatch = (probe: Probe, cameBack: string, requirement: string): Error => new Error(`sent ${sent(probe, credential(probe))}; received ${cameBack}; required: ${requirement}`);
  async function expect(probe: Probe, requirement: string, matches: (reply: Observation) => boolean): Promise<Observation> {
    let reply: Observation;
    try { reply = await send(probe); }
    catch (error) { throw mismatch(probe, String(error), requirement); }
    if (!matches(reply)) throw mismatch(probe, reply.received, requirement);
    return reply;
  }
  async function check(id: string, detail: string, run: () => Promise<void | string>, endpoint?: Endpoint): Promise<void> {
    const tag = endpoint === undefined ? { id } : { id, endpoint };
    try {
      const missing = await run();
      checks.push(missing === undefined ? { ...tag, status: "PASS", detail } : { ...tag, status: "SKIP", detail: `missing precondition: ${missing}` });
    } catch (error) {
      checks.push({ ...tag, status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
    }
  }

  const detectionProbe: Probe = { path: "route-policy", omitKey: true };
  const authProbe: Probe = { path: "route-policy" };
  const policyProbe: Probe | undefined = options.policyKey === undefined || options.policyKey === primaryKey ? undefined : { path: "route-policy", key: options.policyKey };
  const detectionProbes = [detectionProbe, ...(primaryKey === undefined ? [] : [authProbe]), ...(policyProbe === undefined ? [] : [policyProbe])];
  const detections = new Map<Probe, Observation>();
  const parsedDetections = new Map<Probe, Detection>();
  await check("G20", "valid version-string detection with and without supplied credentials", async () => {
    let firstFailure: unknown;
    for (const probe of detectionProbes) {
      try {
        const reply = await expect(probe, 'HTTP 200 and a JSON detection object with route_policy: "1" and valid lists', (r) => {
          detections.set(probe, r);
          const parsed = parseDetection({ status: r.status, body: r.body, credentialed: credential(probe) !== undefined });
          if (parsed.ok) parsedDetections.set(probe, parsed.value);
          // G22 checks key_policy itself; keep those diagnostics separate.
          return parseDetection({ status: r.status, body: { route_policy: member(r.body, "route_policy"), ...Object.fromEntries(["keys", "attest", "sort"].filter((k) => member(r.body, k) !== undefined).map((k) => [k, member(r.body, k)])) }, credentialed: false }).ok;
        });
        detections.set(probe, reply);
      } catch (error) { firstFailure ??= error; }
    }
    if (firstFailure !== undefined) throw firstFailure;
  });
  await check("G22", "only credentialed detection may report a policy, valid under its own lists", async () => {
    if (detections.size === 0) return "a detection response that can be inspected";
    for (const [probe, reply] of detections) {
      if (member(reply.body, "key_policy") !== undefined && !parsedDetections.has(probe)) throw mismatch(probe, reply.received, "key_policy absent for anonymous detection and valid under the advertised lists when present");
    }
  });
  const modelsProbe: Probe = { path: "models" };
  let modelsBody: unknown;
  await check("G23", "unique model and provider ids with valid published facts and evidence", async () => {
    const reply = await expect(modelsProbe, "a model list, or an authentication challenge when no credential was supplied", () => true);
    if (primaryKey === undefined && (reply.status === 401 || reply.status === 403)) return "credentials accepted by /models";
    const problem = schemaProblem(reply.body);
    if (problem !== undefined || reply.status < 200 || reply.status >= 300) throw mismatch(modelsProbe, reply.received, problem ?? "a successful model list");
    modelsBody = reply.body;
  });

  const primaryProbe = primaryKey === undefined ? detectionProbe : authProbe;
  const primary = parsedDetections.get(primaryProbe);
  const support = primary?.support;
  const boundText = primary?.keyPolicy;
  const boundParsed = typeof boundText === "string" && support !== undefined ? parsePolicy(boundText, support) : undefined;
  const bound = boundParsed?.ok ? boundParsed.value : undefined;
  const boundCredential = options.policyKey ?? options.key;
  const policyDetection = policyProbe === undefined ? primary : parsedDetections.get(policyProbe);
  const policyBoundResult = policyDetection?.keyPolicy ? parsePolicy(policyDetection.keyPolicy, policyDetection.support) : undefined;
  const policyBound = policyBoundResult?.ok ? policyBoundResult.value : undefined;
  const models = support === undefined ? [] : discover(modelsBody, support);
  const first = models[0];
  const knownIds = new Set(models.map(({ id }) => id));
  const unknownModel = unused(knownIds, "route-conformance-unknown-");
  const withKey = (policy?: Policy) => combinePolicies({ ...(bound === undefined ? {} : { key: bound }), ...(policy === undefined ? {} : { header: policy }) });
  const needModel = "valid detection for the inference credential and a published base model";
  const knowBound = boundText === null || boundParsed?.ok === true;
  const candidates = models.flatMap((model) => model.policies.map(({ text, policy }) => ({ model, text, policy, allowed: qualifying(model, withKey(policy)) })));
  const positives = candidates.filter(({ allowed }) => allowed.length > 0);
  const negatives = candidates.filter(({ allowed }) => allowed.length === 0);
  const positive = positives.find((entry) => entry.allowed.length < entry.model.routes.size) ?? positives[0];
  const negative = negatives.find(({ model, text }) => model.routes.size > 0 && !text.startsWith("only=")) ?? negatives[0];
  const on = (ep: Endpoint, defaults?: { key?: string; omitKey?: boolean }) => (id: string, header?: string, suffix?: string, stream?: boolean): Probe => ({
    path: ep, raw: bodyFor(ep, suffix === undefined ? id : `${id}+${suffix}`, stream), ...(header === undefined ? {} : { policies: [header] }), ...defaults,
  });
  const allowedOrUnavailable = (allowed: readonly string[]) => (r: Observation) => couldRelay(r, allowed);
  const unsatisfiable = (r: Observation) => refusal(r, "unsatisfiable");
  const rejected = (r: Observation) => refusal(r, "unsupported");

  for (const endpoint of new Set(endpoints)) {
    const inference = on(endpoint);
    let missingCredential = false;
    if (primaryKey === undefined && first !== undefined) {
      const control = await send(inference(first.id)).catch(() => undefined);
      missingCredential = control !== undefined && (control.status === 401 || control.status === 403) && noResult(control);
    }
    const run = (id: string, detail: string, fn: () => Promise<void | string>) => check(id, detail, missingCredential && id !== "G25"
      ? async () => "credentials accepted by this endpoint"
      : fn, endpoint);
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
        const key = entry.text.split("=", 1)[0]!;
        const prior = byKey.get(key);
        if (prior === undefined || (prior.allowed.length === prior.model.routes.size && entry.allowed.length < entry.model.routes.size)) byKey.set(key, entry);
      }
      let relays = 0;
      for (const { model, text, allowed } of byKey.values()) {
        const response = await expect(inference(model.id, text), `a qualifying provider (${allowed.join(", ")}) or 503 unavailable`, allowedOrUnavailable(allowed));
        if (!refusal(response, "unavailable")) relays++;
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
    });
    await run("G10", "a bound key policy applies with no explicit carrier", async () => {
      if (boundCredential === undefined || policyBound === undefined || policyDetection === undefined) return "a usable credential with a detected, interpretable policy (supply --policy-key)";
      const models = discover(modelsBody, policyDetection.support);
      const cases = models.map((model) => ({ model, allowed: qualifying(model, policyBound) }));
      const chosen = cases.find(({ model, allowed }) => allowed.length > 0 && allowed.length < model.routes.size) ?? cases[0];
      if (chosen === undefined) return "a published base model for the bound key";
      await expect(on(endpoint, { key: boundCredential })(chosen.model.id), `the key alone applies: ${chosen.allowed.length === 0 ? "unsatisfiable" : `only (${chosen.allowed.join(", ")}) or unavailable`}`, chosen.allowed.length === 0 ? unsatisfiable : allowedOrUnavailable(chosen.allowed));
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
      if (boundCredential === undefined || policyBound === undefined || policyDetection === undefined) return "a credential with an interpretable bound policy (supply --policy-key)";
      const probe = on(endpoint, { key: boundCredential });
      for (const model of discover(modelsBody, policyDetection.support)) {
        const candidate = model.policies.find(({ policy }) => qualifying(model, policy).length > 0 && qualifying(model, combinePolicies({ key: policyBound, header: policy })).length === 0);
        if (candidate === undefined) continue;
        const challenges = new Set([candidate.text]);
        // An overlapping key can be implemented incorrectly even when omitting that key
        // from both explicit carriers preserves it. Try a weaker explicit value as well.
        for (const [id, route] of model.routes) {
          if (route === null || meets({ provider: id, facts: route.facts }, policyBound)) continue;
          const wanted = `only=${id}`;
          const relaxations = [
            policyBound.bits !== null && route.facts.bits !== null && route.facts.bits < policyBound.bits ? `bits=${route.facts.bits}` : null,
            policyBound.region !== null && route.facts.region !== null ? `region=${[...new Set([...policyBound.region, ...route.facts.region])].join(",")}` : null,
            policyBound.ignore.includes(id) ? `ignore=${model.unknown}` : null,
            policyBound.only !== null && !policyBound.only.includes(id) ? `only=${id}` : null,
            policyBound.attest.length > 0 ? route.facts.attest.filter((item) => !policyBound.attest.includes(item)).map((item) => `attest=${item}`)[0] ?? null : null,
          ];
          for (const relaxed of relaxations) {
            if (relaxed === null) continue;
            const text = relaxed === wanted ? wanted : `${wanted}+${relaxed}`;
            const parsed = parsePolicy(text, policyDetection.support);
            if (parsed.ok && qualifying(model, parsed.value).length > 0 && qualifying(model, combinePolicies({ key: policyBound, header: parsed.value })).length === 0) challenges.add(text);
          }
          if (challenges.size >= 5) break;
        }
        for (const text of challenges) {
          for (const [header, suffix] of [[text, undefined], [undefined, text], [text, text]] as const) {
            await expect(probe(model.id, header, suffix), "the key requirement still excludes every explicitly matched route", unsatisfiable);
          }
        }
        return;
      }
      return "an accepted explicit policy that matches only routes excluded by the bound policy";
    });
    await run("G15", "every observed policy relay carries a single published provider id", async () => {
      if (positive === undefined || !knowBound) return "a satisfiable advertised policy";
      let relays = 0;
      for (const stream of [false, true]) {
        const reply = await expect(inference(positive.model.id, positive.text, undefined, stream), "relay reports one published Route-Applied; an unavailable refusal is not a relay", (r) => refusal(r, "unavailable") || positive.model.routes.has(applied(r) ?? ""));
        if (!refusal(reply, "unavailable")) relays++;
      }
      if (relays === 0) return "a relay for the satisfiable policy (both probes returned unavailable)";
    });
    await run("G17", "relayed evidence appears exactly for attest and equals the route's published URI", async () => {
      if (!knowBound || positive === undefined) return "a satisfiable advertised policy";
      const attested = positives.find(({ policy }) => policy.attest.length > 0);
      const unattested = positives.find(({ model, policy, allowed }) => withKey(policy).attest.length === 0 && allowed.every((id) => model.routes.get(id)?.evidence != null)) ?? positives.find(({ policy }) => withKey(policy).attest.length === 0);
      let attestRelay = false;
      for (const candidate of [attested, unattested]) {
        if (candidate === undefined) continue;
        const { model, text, policy } = candidate;
        const attest = withKey(policy).attest.length > 0;
        const reply = await expect(inference(model.id, text), attest ? "relayed Route-Evidence equals the published evidence of the applied provider exactly" : "a non-attest relay carries no Route-Evidence", (r) => {
          if (refusal(r, "unavailable")) return true;
          if (!attest) return r.evidence.length === 0;
          const uri = model.routes.get(applied(r) ?? "")?.evidence;
          return r.evidence.length === 1 && isEvidenceUri(uri) && r.evidence[0] === uri;
        });
        if (attest && !refusal(reply, "unavailable")) attestRelay = true;
      }
      if (!attestRelay) return "an attestation policy accepted by the gateway and a matching route that relays";
    });
    await run("G19", "refusals and relays have exclusive result headers, with at most one line of each", async () => {
      if (first === undefined) return needModel;
      const exclusive = (r: Observation) => r.applied.length <= 1 && r.refused.length <= 1 && r.evidence.length <= 1 && (r.refused.length === 0 || (r.applied.length === 0 && r.evidence.length === 0));
      await expect(inference(first.id, "bits=0"), "one refusal, no applied or evidence", (r) => r.refused.length === 1 && exclusive(r));
      if (primary?.keyPolicy === null) await expect(inference(first.id), "at most one line per result header without a policy", exclusive);
      if (negative !== undefined && knowBound) await expect(inference(negative.model.id, negative.text), "one refusal, no applied or evidence", (r) => r.refused.length === 1 && exclusive(r));
      const evidencePolicy = positives.find(({ policy }) => withKey(policy).attest.length > 0);
      for (const item of new Set([positive, evidencePolicy])) {
        if (item !== undefined && knowBound) await expect(inference(item.model.id, item.text), "at most one line per result header and no refusal on a relay", (r) => exclusive(r) && (r.refused.length === 0 || refusal(r, "unavailable")));
      }
    });
    await run("G21", "unlisted keys and enum values refuse; listed fixed-domain keys accept their valid values", async () => {
      if (first === undefined || support === undefined) return needModel;
      const detectionBody = detections.get(primaryProbe)?.body;
      const listed = (field: keyof Support) => new Set(list(member(detectionBody, field)) ?? BASELINE[field]);
      const keys = listed("keys");
      const samples: Record<string, string[]> = {
        zdr: ["zdr"], notrain: ["notrain"], bits: ["bits=1", "bits=32", "bits=64"], region: ["region=us", "region=jp,de"],
        only: [`only=${first.unknown}`, "only=0,a-b_c.d"], ignore: [`ignore=${first.unknown}`, "ignore=0,a-b_c.d"], order: [`order=${first.unknown}`, "order=0,a-b_c.d"],
        attest: ["attest=weights"], sort: ["sort=price"],
      };
      const unknown = unused(new Set([...keys].filter((value): value is string => typeof value === "string")), "probe");
      await expect(inference(first.id, unknown), `unlisted key ${unknown} is unsupported`, (r) => refusal(r, "unsupported", unknown));
      for (const [key, examples] of Object.entries(samples)) {
        if ((key === "attest" || key === "sort") && keys.has(key)) continue;
        for (const text of examples) {
          if (!keys.has(key)) await expect(inference(first.id, text), `unlisted key ${key} is unsupported`, (r) => refusal(r, "unsupported", key));
          else await expect(inference(first.id, text), `listed ${key} accepts valid form ${text}`, (r) => r.applied.length > 0 || unsatisfiable(r) || refusal(r, "unavailable"));
        }
      }
      for (const key of ["attest", "sort"] as const) {
        if (!keys.has(key)) continue;
        const enumValues = listed(key);
        const unknownValue = unused(new Set([...enumValues].filter((value): value is string => typeof value === "string")), "probe");
        for (const value of [...BASELINE[key], unknownValue]) {
          const text = `${key}=${value}`;
          if (!enumValues.has(value)) await expect(inference(first.id, text), `unlisted value ${value} for ${key} is unsupported`, (r) => refusal(r, "unsupported", key));
          else await expect(inference(first.id, text), `listed value ${value} for ${key} is accepted`, (r) => r.applied.length > 0 || unsatisfiable(r) || refusal(r, "unavailable"));
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
        [{ path: endpoint, raw: "{" }, { path: endpoint, raw: "{", policies: [INVALID_KEY, INVALID_KEY] }],
        [{ path: endpoint, raw: '{"model":4}' }, { path: endpoint, raw: '{"model":4}', policies: [INVALID_KEY] }],
        [inference(unknownModel), inference(unknownModel, INVALID_KEY, "bits=0")],
        [inference(""), inference("", INVALID_KEY, "bits=0")],
      ];
      for (const [plain, policy] of samples) {
        const before = await expect(plain, "ordinary error with no route headers", (r) => r.status >= 400 && noResult(r));
        await expect(policy, `ordinary error status ${before.status} wins over invalid policy, with no route headers`, (r) => r.status === before.status && noResult(r));
      }
      if (first !== undefined) {
        const wrongKey = `route-conformance-invalid-${crypto.randomUUID()}`;
        const beforeProbe = { ...inference(first.id), key: wrongKey };
        const before = await expect(beforeProbe, "a response to a syntactically valid request with an unrecognized credential", () => true);
        if (before.status === 401 || before.status === 403) {
          if (!noResult(before)) throw mismatch(beforeProbe, before.received, "a credential error carries no result headers");
          await expect({ ...beforeProbe, policies: [INVALID_KEY] }, "bad credentials win over malformed policy, with no route headers", (r) => r.status === before.status && noResult(r));
        }
      }
    });
    await run("G26", "ordinary traffic without a policy carries neither refusal nor evidence", async () => {
      if (primary?.keyPolicy !== null || first === undefined) return "a known unbound ordinary credential and a published base model";
      await expect(inference(first.id), "without any policy, neither Route-Refused nor Route-Evidence", (r) => r.refused.length === 0 && r.evidence.length === 0);
    });
    await run("G29", "unsupported takes precedence over an otherwise unsatisfiable policy", async () => {
      if (negative === undefined || !knowBound) return "a supported policy no published route meets";
      await expect(inference(negative.model.id, "bits=0", negative.text), "invalid header takes precedence over unsatisfiable suffix", (r) => refusal(r, "unsupported", "bits"));
      await expect(inference(negative.model.id, negative.text, "bits=0"), "invalid suffix takes precedence over unsatisfiable header", (r) => refusal(r, "unsupported", "bits"));
    });
    await run("G34", "refusals use the same error body shape as ordinary errors on this endpoint", async () => {
      if (first === undefined) return needModel;
      const own = await expect({ path: endpoint, raw: "{" }, "a readable ordinary error from this endpoint", (r) => r.status >= 400 && noResult(r));
      const shape = shapeOf(own.body);
      for (const probe of [inference(first.id, "bits=0"), ...(negative === undefined ? [] : [inference(negative.model.id, negative.text)])]) {
        await expect(probe, `same error body shape (${shape}) as an ordinary error: ${own.received}`, (r) => r.refused.length === 1 && shapeOf(r.body) === shape);
      }
    });
  }

  return { checks, passed: checks.filter((c) => c.status === "PASS").length, failed: checks.filter((c) => c.status === "FAIL").length, skipped: checks.filter((c) => c.status === "SKIP").length };
}
