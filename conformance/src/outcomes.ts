import { isEvidenceUri, meets, parseApplied, parseRefused, REFUSAL_STATUS, type Policy, type PublishedRoute, type RefusalReason } from "../../core/src/index.ts";
import { sent, type Observation, type Probe } from "./http.ts";

export interface Exchange {
  probe: Probe;
  reply: Observation;
  ordinaryControl?: boolean;
  missingRefusal?: boolean;
}

export interface ResultContext {
  carriesPolicy: boolean | undefined;
  combined?: Policy;
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
  sawCatalogRelay: boolean;
  sawAttestationRelay: boolean;
  sawPolicyResult: boolean;
  sawRefusal: boolean;
  shapeControlsNeeded: Map<Probe["credential"], string>;
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
}

function jsonType(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function compareJsonShape(value: unknown, controls: readonly unknown[], path: string): Shape {
  if (controls.length === 0) return { unseen: path };
  const type = jsonType(value);
  const similar = controls.filter((sample) => jsonType(sample) === type);
  if (similar.length === 0) return { contradiction: `${path} has type ${type}, which no control shows` };
  let unseen: string | undefined;
  if (Array.isArray(value)) {
    const items: unknown[] = similar.flatMap((sample) => Array.isArray(sample) ? sample : []);
    for (const item of value) {
      const result = compareJsonShape(item, items, `${path}[]`);
      if (result.contradiction !== undefined) return result;
      unseen ??= result.unseen;
    }
  } else if (value !== null && typeof value === "object") {
    const objects = similar.filter((sample) => sample !== null && typeof sample === "object");
    for (const key of Object.keys(objects[0]!)) {
      if (!Object.hasOwn(value, key) && objects.every((sample) => Object.hasOwn(sample, key))) {
        return { contradiction: `${path}.${key} is missing but present in every control at ${path}` };
      }
    }
    const fields: [string, unknown][] = Object.entries(value);
    for (const [key, field] of fields) {
      const members: unknown[] = objects.filter((sample) => Object.hasOwn(sample, key)).map((sample) => Reflect.get(sample, key));
      const result = compareJsonShape(field, members, `${path}.${key}`);
      if (result.contradiction !== undefined) return result;
      unseen ??= result.unseen;
    }
  }
  return unseen === undefined ? {} : { unseen };
}

function mediaType(reply: Observation): string | undefined {
  return reply.contentType?.split(";", 1)[0]?.trim().toLowerCase();
}

function compareErrorShape(reply: Observation, controls: readonly Observation[]): Shape {
  if (controls.length === 0) return { unseen: "an ordinary error body under the same credential" };
  const media = mediaType(reply);
  const sameMedia = controls.filter((sample) => mediaType(sample) === media);
  if (sameMedia.length === 0) return { contradiction: `media type ${media ?? "(none)"} was not used by any ordinary error control` };
  const json = sameMedia.flatMap((sample) => sample.body === undefined ? [] : [sample.body]);
  if (reply.body !== undefined) {
    return json.length === 0 ? { contradiction: "JSON was not used by any ordinary error control with the same media type" }
      : compareJsonShape(reply.body, json, "$");
  }
  if (media === "application/json" || media?.endsWith("+json") || json.length === sameMedia.length) {
    return { contradiction: "expected a JSON error body" };
  }
  return {};
}

function sameCredential(a: Probe, b: Probe): boolean {
  return a.credential?.header === b.credential?.header && a.credential?.key === b.credential?.key;
}

export function auditResults(exchanges: readonly Exchange[], contextFor: (probe: Probe) => ResultContext): ResultAudit {
  const audit: ResultAudit = {
    failures: new Map(), sawCatalogRelay: false, sawAttestationRelay: false, sawPolicyResult: false,
    sawRefusal: false, shapeControlsNeeded: new Map(),
  };
  const ordinary = exchanges.filter(({ ordinaryControl, reply }) => ordinaryControl && reply.hasBody && noResult(reply));
  for (const { probe, reply, missingRefusal } of exchanges) {
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
    const { carriesPolicy, combined, bound, explicit, routes, qualifies, unknownProvider, expectedRefusal } = contextFor(probe);
    const hasPreference = combined !== undefined && (combined.sort !== null || combined.order !== null);
    if (carriesPolicy === false && (reply.refused.length > 0 || reply.evidence.length > 0)) fail("G26", "no Route-Refused or Route-Evidence without a policy");

    if (reply.refused.length > 0) {
      audit.sawRefusal = true;
      audit.sawPolicyResult = true;
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
      if (carriesPolicy === true && parsed.ok && parsed.value.reason === "unsupported" && combined !== undefined) {
        fail("G21", "advertised support accepts every key and value sent; unsupported is not justified");
        if (parsed.value.key !== null) fail("G2", "no accepted key can be named as a failing key");
        if (unknownProvider) fail("G24", "a syntactically valid unknown provider id is not an unsupported value");
      }
      if (parsed.ok && parsed.value.reason === "unsatisfiable" && qualifies === true) {
        fail("G3", "unsatisfiable requires that no published route meet the combined policy");
        if (hasPreference) fail("G7", "an accepted preference cannot disqualify the matching published routes");
        if (unknownProvider) fail("G24", "an unknown provider id does not remove the remaining matching routes");
      }
      if (!reply.hasBody) fail("G34", "a refusal has a nonempty error body");
      const references = ordinary.filter((entry) => sameCredential(entry.probe, probe));
      const shape = compareErrorShape(reply, references.map(({ reply }) => reply));
      if (shape.contradiction !== undefined && reply.hasBody) {
        audit.shapeControlsNeeded.set(probe.credential, shape.contradiction);
        fail("G34", `the same error body structure as an ordinary error on this endpoint: ${shape.contradiction}`);
      }
      if (shape.unseen !== undefined && reply.hasBody) audit.shapeControlsNeeded.set(probe.credential,
        shape.unseen.startsWith("$") ? `an ordinary error control showing refusal member ${shape.unseen}` : shape.unseen);
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
    if (routes !== undefined) audit.sawCatalogRelay = true;
    audit.sawPolicyResult = true;
    if (provider === null || (routes !== undefined && !routes.has(provider))) fail("G15", "one valid Route-Applied naming a published provider for this model");
    const route = provider === null ? undefined : routes?.get(provider);
    if (provider !== null && route != null && bound !== undefined && !meets({ provider, facts: route.facts }, bound)) {
      fail("G10", "the relayed route must meet the detected key default even in the presence of explicit carriers");
      if (explicit) fail("G13", "neither explicit carrier can weaken the detected key default");
    }
    if (combined !== undefined) {
      if (routes !== undefined && (provider === null || route == null || !meets({ provider, facts: route.facts }, combined))) {
        fail("G6", "a named published route with valid facts meets the combined policy");
        if (hasPreference) fail("G7", "a preference cannot admit a route that fails the combined requirements");
      }
      if (combined.attest.length === 0) {
        if (reply.evidence.length !== 0) fail("G17", "no Route-Evidence when the combined policy does not require attest");
      } else {
        if (route != null) audit.sawAttestationRelay = true;
        if (reply.evidence.length !== 1 || (routes !== undefined && reply.evidence[0] !== route?.evidence)) {
          fail("G17", "one Route-Evidence exactly matching the applied route's published URI when attest is required");
        }
      }
    }
  }
  return audit;
}
