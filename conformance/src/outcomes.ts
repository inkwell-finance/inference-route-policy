import { isEvidenceUri, meets, parseApplied, parseRefused, providerAllowed, REFUSAL_STATUS, type Policy, type PublishedRoute, type RefusalReason } from "../../core/src/index.ts";
import { sent, type Observation, type Probe } from "./http.ts";

export interface Exchange {
  probe: Probe;
  reply: Observation;
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

export type AuditId = "G1" | "G2" | "G3" | "G6" | "G7" | "G10" | "G13" | "G15" | "G17" | "G19" | "G21" | "G24" | "G26" | "G29";
export interface ResultAudit {
  failures: Map<AuditId, string>;
  catalogRelays: Exchange[];
  attestedRelays: Exchange[];
  results: Exchange[];
}

const precedence: Readonly<Record<RefusalReason, number>> = { unsupported: 0, unsatisfiable: 1, unavailable: 2 };

export const noResult = (reply: Observation): boolean => reply.applied.length === 0 && reply.refused.length === 0 && reply.evidence.length === 0;

export function applied(reply: Observation): string | null {
  if (reply.applied.length !== 1) return null;
  const parsed = parseApplied(reply.applied[0]!);
  return parsed.ok ? parsed.value : null;
}

export function auditResults(exchanges: readonly Exchange[], contextFor: (probe: Probe) => ResultContext): ResultAudit {
  const audit: ResultAudit = {
    failures: new Map(), catalogRelays: [], attestedRelays: [], results: [],
  };
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
