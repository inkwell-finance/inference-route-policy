/**
 * What one response says about the policy its request carried, in words a user can act on. Facts the gateway
 * publishes are its claims; this client verifies no evidence, so nothing here is called verified (C7).
 */

import { parseApplied, parseRefused, readOutcome, type Policy, type PublishedRoute, type RefusalReason, type ResultHeaders } from "../../../core/src/index.ts";

/** What the client sent, as the send decision recorded it. */
export type Sent =
  | { kind: "protocol"; policy: Policy | null; routes: ReadonlyMap<string, PublishedRoute | null> | null }
  | { kind: "translated" };

export type Report =
  | { kind: "honored"; provider: string; checked: boolean; evidence: string | null }
  /** No policy left the client with the request, so there is nothing to check; `provider` is what it says served it. */
  | { kind: "served"; provider: string | null }
  | { kind: "refused"; reason: RefusalReason | null; key: string | null }
  | { kind: "not-honored"; why: string }
  | { kind: "unconfirmed" }
  | { kind: "blocked"; reason: string };

/** Reads a response's result headers against what was sent (C3, C4, C5, C8). */
export function interpret(headers: ResultHeaders, sent: Sent): Report {
  if (sent.kind === "protocol" && sent.policy !== null) {
    const outcome = readOutcome(headers, sent.policy, sent.routes);
    switch (outcome.outcome) {
      case "refused":
        return { kind: "refused", reason: outcome.reason, key: outcome.key };
      case "not-honored":
        return { kind: "not-honored", why: outcome.why };
      case "honored":
        return { kind: "honored", provider: outcome.provider, checked: outcome.checked, evidence: outcome.evidence };
    }
  }
  // C5 holds for every response, whatever was sent: a key's own policy can be refused too.
  if (headers.refused.length > 0) {
    const parsed = headers.refused.length === 1 ? parseRefused(headers.refused[0]!) : null;
    return parsed?.ok ? { kind: "refused", ...parsed.value } : { kind: "refused", reason: null, key: null };
  }
  if (sent.kind === "translated") return { kind: "unconfirmed" };
  const applied = headers.applied.length === 1 ? parseApplied(headers.applied[0]!) : null;
  return { kind: "served", provider: applied?.ok ? applied.value : null };
}

/** Honored and plain responses are quiet; everything else is something the user needs to see. */
export const isQuiet = (report: Report): boolean => report.kind === "honored" || report.kind === "served";

export function describeReport(report: Report): string {
  switch (report.kind) {
    case "honored": {
      const facts = report.checked
        ? "its published facts meet the policy (they are the gateway's claims, not verified by this client)"
        : "its published facts were not compared: no model list was held";
      const evidence = report.evidence === null ? "" : `; evidence at ${report.evidence}, not verified by this client`;
      return `route policy honored: served by ${report.provider}; ${facts}${evidence}`;
    }
    case "served":
      return report.provider === null ? "no route policy on this request" : `no route policy on this request; served by ${report.provider}`;
    case "refused":
      return report.reason === null
        ? "route policy refused by the gateway (its Route-Refused value could not be read)"
        : `route policy refused by the gateway: ${report.reason}${report.key === null ? "" : ` (key ${report.key})`}`;
    case "not-honored":
      return `route policy NOT honored: ${report.why}`;
    case "unconfirmed":
      return "route policy translated into the gateway's own fields; the result is unconfirmed, not applied";
    case "blocked":
      return `request blocked by the route policy plugin, nothing was sent: ${report.reason}`;
  }
}
