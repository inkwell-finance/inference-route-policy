import { isEvidenceUri, meets, parseApplied, parseRefused, providerAllowed, REFUSAL_STATUS, type Policy, type PublishedRoute, type RefusalReason } from "../../core/src/index.ts";
import { sent, type Observation, type Probe } from "./http.ts";

// G34 — compare only observations from the same endpoint and credential:
// Input                                               | Verdict and claim
// No refusal, or JSON refusal with no own-error body   | SKIP: no comparable observation.
// Empty refusal, media mismatch, invalid declared JSON | FAIL: a positive contradiction.
// A JSON member has no observed type at its known path | FAIL: a positive contradiction.
// Non-JSON refusal without a media contradiction      | SKIP: structure not compared.
// Body with an uninspectable content coding             | SKIP if its shape is needed.
// JSON shape equals one complete own-error sample     | PASS: that shape was observed.
// JSON shape differs only by fields or their grouping  | SKIP: name the unverified difference.
// Array shapes ignore order and repetitions, not element structure. Only a
// single body can establish a match; pooled controls can diagnose differences.

export interface Exchange {
  probe: Probe;
  reply: Observation;
  unverifiedOrdinaryControl?: string;
  ordinaryControl?: string;
  missingRefusal?: boolean;
}

export interface ResultContext {
  carriesPolicy: boolean | undefined;
  known?: Policy;
  complete?: boolean;
  impossible?: boolean;
  acceptedExplicit?: boolean;
  bound?: Policy;
  explicit?: boolean;
  routes?: ReadonlyMap<string, PublishedRoute | null>;
  qualifies?: boolean;
  unknownProvider?: boolean;
  expectedRefusal?: { reason: "unsupported"; key: string | null } | { reason: "unsatisfiable" };
}

export type AuditId = "G1" | "G2" | "G3" | "G6" | "G7" | "G10" | "G13" | "G15" | "G17" | "G19" | "G21" | "G24" | "G26" | "G29" | "G34";
export interface ResultAudit {
  failures: Map<AuditId, string>;
  catalogRelays: Exchange[];
  attestedRelays: Exchange[];
  results: Exchange[];
  refusals: Exchange[];
  shapeControlsNeeded: Set<Probe["credential"]>;
  shapeUnverified?: string;
}

const precedence: Readonly<Record<RefusalReason, number>> = { unsupported: 0, unsatisfiable: 1, unavailable: 2 };

export const noResult = (reply: Observation): boolean => reply.applied.length === 0 && reply.refused.length === 0 && reply.evidence.length === 0;

export function applied(reply: Observation): string | null {
  if (reply.applied.length !== 1) return null;
  const parsed = parseApplied(reply.applied[0]!);
  return parsed.ok ? parsed.value : null;
}

interface Shape {
  contradiction?: string;
  unseen?: string;
  missing?: string[];
  unparsed?: string;
}

function jsonType(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

// Intern a flat description of each node using its children's IDs. Unlike
// recursive shape strings, descriptors don't grow with subtree depth.
function shapeIndex() {
  const ids = new Map<string, number>();
  const nodes = new WeakMap<object, number>();
  function intern(description: string): number {
    let id = ids.get(description);
    if (id === undefined) ids.set(description, id = ids.size);
    return id;
  }
  return function shapeId(value: unknown): number {
    if (value === null || typeof value !== "object") return intern(jsonType(value));
    const cached = nodes.get(value);
    if (cached !== undefined) return cached;
    const description = Array.isArray(value)
      ? `a${JSON.stringify([...new Set(value.map(shapeId))].sort((a, b) => a - b))}`
      : `o${JSON.stringify(Object.keys(value).sort().map((key) => [key, shapeId(Reflect.get(value, key))]))}`;
    const id = intern(description);
    nodes.set(value, id);
    return id;
  };
}

// Only called once we know the IDs differ; it locates a difference for SKIP.
function shapeDifference(value: unknown, sample: unknown, shapeId: (value: unknown) => number, path: string): string {
  if (jsonType(value) !== jsonType(sample)) return path;
  if (Array.isArray(value)) return `${path}[]`;
  if (value !== null && typeof value === "object" && sample !== null && typeof sample === "object") {
    const fields: [string, unknown][] = Object.entries(value);
    for (const [key, field] of fields) {
      const member = `${path}.${key}`;
      if (!Object.hasOwn(sample, key)) return member;
      const counterpart: unknown = Reflect.get(sample, key);
      if (shapeId(field) !== shapeId(counterpart)) return shapeDifference(field, counterpart, shapeId, member);
    }
    const extra = Object.keys(sample).find((key) => !Object.hasOwn(value, key));
    if (extra !== undefined) return `${path}.${extra}`;
  }
  return path;
}

function compareJsonShape(value: unknown, controls: readonly unknown[], path: string): Shape {
  if (controls.length === 0) return { unseen: path };
  const type = jsonType(value);
  const similar = controls.filter((sample) => jsonType(sample) === type);
  if (similar.length === 0) return { contradiction: `${path} has type ${type}, which no control shows` };
  let unseen: string | undefined;
  const missing: string[] = [];
  if (Array.isArray(value)) {
    const items: unknown[] = similar.flatMap((sample) => Array.isArray(sample) ? sample : []);
    for (const item of value) {
      const result = compareJsonShape(item, items, `${path}[]`);
      if (result.contradiction !== undefined) return result;
      if (result.missing !== undefined) missing.push(...result.missing);
      unseen ??= result.unseen;
    }
  } else if (value !== null && typeof value === "object") {
    const objects = similar.filter((sample) => sample !== null && typeof sample === "object");
    for (const key of Object.keys(objects[0]!)) {
      if (!Object.hasOwn(value, key) && objects.every((sample) => Object.hasOwn(sample, key))) {
        missing.push(`${path}.${key}`);
      }
    }
    const fields: [string, unknown][] = Object.entries(value);
    for (const [key, field] of fields) {
      const members: unknown[] = objects.filter((sample) => Object.hasOwn(sample, key)).map((sample) => Reflect.get(sample, key));
      const result = compareJsonShape(field, members, `${path}.${key}`);
      if (result.contradiction !== undefined) return result;
      unseen ??= result.unseen;
      if (result.missing !== undefined) missing.push(...result.missing);
    }
  }
  return { ...(missing.length === 0 ? {} : { missing }), ...(unseen === undefined ? {} : { unseen }) };
}

function mediaType(reply: Observation): string | undefined {
  return reply.contentType?.split(";", 1)[0]?.trim().toLowerCase();
}

function compareErrorShape(reply: Observation, controls: readonly Observation[], shapeId: (value: unknown) => number): Shape {
  if (reply.bodyUnavailable !== undefined) return { unparsed: `inspectable refusal body (${reply.bodyUnavailable})` };
  const media = mediaType(reply);
  const sameMedia = controls.filter((sample) => mediaType(sample) === media);
  if (controls.length > 0 && sameMedia.length === 0) {
    return { contradiction: `media type ${media ?? "(none)"} was not used by any ordinary error control` };
  }
  if (media !== "application/json" && !media?.endsWith("+json")) {
    return { unparsed: `refusal body is ${media ?? "of unspecified media type"}; structure not compared` };
  }
  if (reply.body === undefined) return { contradiction: "expected a JSON error body" };
  const json = sameMedia.flatMap((sample) => sample.body === undefined ? [] : [sample.body]);
  const refusalId = shapeId(reply.body);
  if (json.some((sample) => shapeId(sample) === refusalId)) return {};
  const unreadable = sameMedia.find((sample) => sample.bodyUnavailable !== undefined)?.bodyUnavailable;
  if (unreadable !== undefined) return { unseen: `inspectable ordinary error control (${unreadable})` };
  if (json.length === 0) return { unseen: "an ordinary JSON error body under the same credential" };
  const shape = compareJsonShape(reply.body, json, "$");
  return shape.contradiction !== undefined || shape.unseen !== undefined || shape.missing !== undefined
    ? shape : { unseen: `one ordinary error control with the same whole refusal shape (difference at ${shapeDifference(reply.body, json[0], shapeId, "$")})` };
}

function sameCredential(a: Probe, b: Probe): boolean {
  return a.credential?.header === b.credential?.header && a.credential?.key === b.credential?.key;
}

export function auditResults(exchanges: readonly Exchange[], contextFor: (probe: Probe) => ResultContext): ResultAudit {
  const audit: ResultAudit = {
    failures: new Map(), catalogRelays: [], attestedRelays: [], results: [], refusals: [], shapeControlsNeeded: new Set(),
  };
  const ordinary = exchanges.filter(({ ordinaryControl, reply }) => ordinaryControl && reply.hasBody && noResult(reply));
  const unverified = exchanges.filter(({ unverifiedOrdinaryControl, reply }) => unverifiedOrdinaryControl && reply.hasBody && noResult(reply));
  const shapeId = shapeIndex();
  for (const exchange of exchanges) {
    const { probe, reply, missingRefusal } = exchange;
    const fail = (id: AuditId, required: string) => {
      if (!audit.failures.has(id)) audit.failures.set(id, `sent ${sent(probe)}; received ${reply.received}; required: ${required}`);
    };
    if (reply.applied.length > 1 || reply.refused.length > 1 || reply.evidence.length > 1) {
      fail("G19", "at most one field line of each result header");
    }
    if (missingRefusal) fail("G19", "a policy refusal has a Route-Refused header; the no-policy control reached routing");
    const provider = applied(reply);
    if (reply.applied.length !== 0 && provider === null) fail("G15", "S14: a Route-Applied value is exactly provider=<provider id>");
    if (reply.evidence.some((uri) => !isEvidenceUri(uri))) fail("G17", "S18: every Route-Evidence value is an evidence URI");
    const { carriesPolicy, known, complete, impossible, acceptedExplicit, bound, explicit, routes, qualifies, unknownProvider, expectedRefusal } = contextFor(probe);
    const hasPreference = known !== undefined && (known.sort !== null || known.order !== null);
    if (carriesPolicy === false && (reply.refused.length > 0 || reply.evidence.length > 0)) fail("G26", "no Route-Refused or Route-Evidence without a policy");

    if (reply.refused.length > 0) {
      audit.refusals.push(exchange);
      audit.results.push(exchange);
      const parsed = parseRefused(reply.refused[0]!);
      if (!parsed.ok || reply.status !== REFUSAL_STATUS[parsed.value.reason]) fail("G19", "S15: one valid Route-Refused value with its corresponding HTTP status");
      if (reply.applied.length !== 0 || reply.evidence.length !== 0) fail("G19", "a refusal has neither Route-Applied nor Route-Evidence");
      if (expectedRefusal !== undefined) {
        const { reason } = expectedRefusal;
        if (!parsed.ok || parsed.value.reason !== reason || reply.status !== REFUSAL_STATUS[reason]
          || reply.refused.length !== 1 || reply.applied.length !== 0 || reply.evidence.length !== 0) {
          fail(reason === "unsupported" ? "G1" : "G3", `HTTP ${REFUSAL_STATUS[reason]} with only a valid ${reason} refusal`);
        }
        if (reason === "unsupported" && parsed.ok && parsed.value.reason === reason && parsed.value.key !== expectedRefusal.key) {
          fail("G2", `the first failure names ${expectedRefusal.key ?? "no key"}`);
        }
        if (parsed.ok && precedence[parsed.value.reason] > precedence[reason]) fail("G29", `${reason} takes precedence over ${parsed.value.reason}`);
        if (reason === "unsatisfiable" && parsed.ok && parsed.value.reason !== reason && unknownProvider) {
          fail("G24", "a valid selector containing an unknown provider is not unsupported and cannot make a nonexistent route available");
        }
      }
      if (carriesPolicy === true && parsed.ok && parsed.value.reason === "unsupported" && acceptedExplicit) {
        fail("G21", "advertised support accepts every key and value sent; unsupported is not justified");
        if (parsed.value.key !== null) fail("G2", "no accepted key can be named as a failing key");
        if (unknownProvider) fail("G24", "a syntactically valid unknown provider id is not an unsupported value");
      }
      if (parsed.ok && parsed.value.reason === "unsatisfiable" && qualifies === true) {
        fail("G3", "unsatisfiable requires that no published route meet the combined policy");
        if (hasPreference) fail("G7", "an accepted preference cannot disqualify the matching published routes");
        if (unknownProvider) fail("G24", "an unknown provider id does not remove the remaining matching routes");
      }
      if (parsed.ok && parsed.value.reason === "unavailable" && impossible && expectedRefusal === undefined) {
        fail("G3", "unavailable presupposes a qualifying route, but none meets even the known requirements");
        fail("G29", "unavailable must not mask a refusal before routing");
      }
      const references = ordinary.filter((entry) => entry.probe.path === probe.path && sameCredential(entry.probe, probe));
      const sampled = () => {
        const kinds = new Set(references.map(({ ordinaryControl, reply: sample }) =>
          `${ordinaryControl}, HTTP ${sample.status} ${mediaType(sample) ?? "(no media type)"}`));
        return `${references.length} sampled ordinary errors${kinds.size === 0 ? "" : ` (${[...kinds].join("; ")})`}`;
      };
      if (!reply.hasBody) {
        fail("G34", `a refusal has a nonempty error body; the refusal was empty (compared with ${sampled()})`);
        continue;
      }
      let shape = compareErrorShape(reply, references.map(({ reply }) => reply), shapeId);
      if ((shape.contradiction !== undefined || shape.unseen !== undefined || shape.missing !== undefined) && reply.body !== undefined) {
        const possible = unverified.find((entry) => entry.probe.path === probe.path && sameCredential(entry.probe, probe)
          && mediaType(entry.reply) === mediaType(reply) && entry.reply.body !== undefined && shapeId(entry.reply.body) === shapeId(reply.body));
        if (possible !== undefined) shape = { unseen: `an ordinary error with this refusal shape; ${possible.unverifiedOrdinaryControl}` };
      }
      if (shape.contradiction !== undefined) {
        audit.shapeControlsNeeded.add(probe.credential);
        fail("G34", `the refusal uses this endpoint's ordinary error format; ${shape.contradiction} (based on ${sampled()})`);
      }
      if (shape.unseen !== undefined || shape.missing !== undefined) {
        audit.shapeControlsNeeded.add(probe.credential);
        const missing = shape.missing === undefined ? undefined
          : `requiredness of missing refusal members ${[...new Set(shape.missing)].join(", ")} cannot be established from sampled ordinary errors`;
        const unseen = shape.unseen?.startsWith("$") ? `an ordinary error control showing refusal member ${shape.unseen}` : shape.unseen;
        const issue = missing !== undefined && unseen !== undefined ? `${missing}; also need ${unseen}` : missing ?? unseen;
        if (issue !== undefined) audit.shapeUnverified ??= issue;
      }
      if (shape.unparsed !== undefined) audit.shapeUnverified ??= shape.unparsed;
      continue;
    }

    // A bare 4xx/5xx may be an own error, not a relay. A route result or a
    // non-error response to policy traffic establishes an observable relay.
    const relay = reply.applied.length > 0 || reply.evidence.length > 0 || reply.status < 400;
    if (expectedRefusal !== undefined && (relay || missingRefusal)) {
      fail(expectedRefusal.reason === "unsupported" ? "G1" : "G3", `the policy must be refused as ${expectedRefusal.reason}`);
      if (unknownProvider && expectedRefusal.reason === "unsatisfiable") fail("G24", "an unknown provider id does not make an excluded route qualify");
    }
    if (!relay || carriesPolicy !== true) continue;
    if (impossible) fail("G3", "no route can meet even the known requirements, regardless of any unknown key requirements");
    if (routes !== undefined) audit.catalogRelays.push(exchange);
    audit.results.push(exchange);
    if (provider === null || (routes !== undefined && !routes.has(provider))) fail("G15", "one valid Route-Applied naming a published provider for this model");
    const route = provider === null ? undefined : routes?.get(provider);
    if (provider !== null && bound !== undefined && (!providerAllowed(provider, bound)
      || (route != null && !meets({ provider, facts: route.facts }, bound)))) {
      fail("G10", "the relayed route must meet the detected key default even in the presence of explicit carriers");
      if (explicit) fail("G13", "neither explicit carrier can weaken the detected key default");
    }
    if (known !== undefined) {
      if (provider === null || !providerAllowed(provider, known) || impossible
        || (routes !== undefined && (route == null || !meets({ provider, facts: route.facts }, known)))) {
        fail("G6", "the named published route must meet at least the known requirements; an unknown key default cannot admit an excluded route");
      }
      if (known.attest.length === 0) {
        if (complete && reply.evidence.length !== 0) fail("G17", "no Route-Evidence when the combined policy does not require attest");
      } else if (reply.evidence.length !== 1) {
        fail("G17", "one Route-Evidence is required by the known attest requirement");
      }
      if (route != null && reply.evidence.length > 0 && reply.evidence[0] !== route.evidence) {
        fail("G17", "Route-Evidence exactly matches the applied route's published URI");
      }
      if (known.attest.length > 0 && route != null) audit.attestedRelays.push(exchange);
    }
  }
  return audit;
}
