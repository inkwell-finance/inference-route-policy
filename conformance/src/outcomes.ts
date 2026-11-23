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
  sawPolicyRelay: boolean;
  sawAttestationRelay: boolean;
  sawPolicyResult: boolean;
  sawRefusal: boolean;
  comparedErrorShape: boolean;
  unpairedErrorShape: boolean;
}

const precedence: Readonly<Record<RefusalReason, number>> = { unsupported: 0, unsatisfiable: 1, unavailable: 2 };

export const noResult = (reply: Observation): boolean => reply.applied.length === 0 && reply.refused.length === 0 && reply.evidence.length === 0;

export function applied(reply: Observation): string | null {
  if (reply.applied.length !== 1) return null;
  const parsed = parseApplied(reply.applied[0]!);
  return parsed.ok ? parsed.value : null;
}

function sameJsonShape(left: unknown, right: unknown): boolean {
  if (left === null || right === null) return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    const a: unknown[] = left;
    const b: unknown[] = right;
    // Lists can differ in length and order, but cannot introduce a new element shape.
    return a.length === 0 || b.length === 0 || (
      a.every((x) => b.some((y) => sameJsonShape(x, y))) && b.every((y) => a.some((x) => sameJsonShape(x, y)))
    );
  }
  if (typeof left !== "object" || typeof right !== "object") return typeof left === typeof right;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => {
    if (!Object.hasOwn(right, key)) return false;
    const a: unknown = Reflect.get(left, key);
    const b: unknown = Reflect.get(right, key);
    return sameJsonShape(a, b);
  });
}

function mediaType(reply: Observation): string | undefined {
  return reply.contentType?.split(";", 1)[0]?.trim().toLowerCase();
}

function sameErrorShape(ordinary: Observation, refusal: Observation): boolean {
  if (ordinary.body !== undefined || refusal.body !== undefined) {
    return ordinary.body !== undefined && refusal.body !== undefined && sameJsonShape(ordinary.body, refusal.body);
  }
  const media = mediaType(ordinary);
  // Non-JSON endpoints need not use an envelope; compare the observable representation.
  return ordinary.hasBody && refusal.hasBody && media === mediaType(refusal) && media !== "application/json" && !media?.endsWith("+json");
}

function sameCredential(a: Probe, b: Probe): boolean {
  return a.credential?.header === b.credential?.header && a.credential?.key === b.credential?.key;
}

export function auditResults(exchanges: readonly Exchange[], contextFor: (probe: Probe) => ResultContext): ResultAudit {
  const audit: ResultAudit = {
    failures: new Map(), sawPolicyRelay: false, sawAttestationRelay: false, sawPolicyResult: false,
    sawRefusal: false, comparedErrorShape: false, unpairedErrorShape: false,
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
      const sameStatus = references.filter((entry) => entry.reply.status === reply.status);
      const examples = sameStatus.length === 0 ? references : sameStatus;
      if (examples.length === 0) audit.unpairedErrorShape = true;
      else {
        audit.comparedErrorShape = true;
        if (!examples.some((entry) => sameErrorShape(entry.reply, reply))) {
          fail("G34", `the same error body structure as an ordinary error on this endpoint: ${examples.map((entry) => entry.reply.received).join("; ")}`);
        }
      }
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
    audit.sawPolicyRelay = true;
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
        audit.sawAttestationRelay = true;
        if (reply.evidence.length !== 1 || (routes !== undefined && reply.evidence[0] !== route?.evidence)) {
          fail("G17", "one Route-Evidence exactly matching the applied route's published URI when attest is required");
        }
      }
    }
  }
  return audit;
}
