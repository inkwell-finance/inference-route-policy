// Reading a response against what was sent (C3, C4, C5, C7, C8, C11), and the words each result is shown in.
// Each row is an input and the whole result, written out.

import { combinePolicies, parsePolicy, publishedRoutes, type Policy } from "../../../core/src/index.ts";
import { describeReport, interpret, isQuiet, type Report, type Sent } from "../src/outcome.ts";
import { table } from "./table.ts";

/** The model list the rows name as MODEL_LIST: aurora meets zdr, basalt attests with evidence, cobalt publishes nothing. */
const MODEL_LIST = { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr+notrain+bits=8+region=us" }, { provider: "basalt", facts: "bits=16+region=us,de+attest=weights,prompt", evidence: "https://basalt.example/attestation" }, { provider: "cobalt", facts: "" }] }, { id: "other-model", routes: [{ provider: "cobalt", facts: "notrain" }] }] };

interface OutcomeRow {
  applied?: string[];
  refused?: string[];
  evidence?: string[];
  /** "translated", or the policy sent in this protocol, the model list held when it was sent, and the model. */
  sent: "translated" | { policy: string | null | { header: string; suffix: string }; list?: unknown; model?: string };
}

/** A policy sent: its text, or a header and a suffix combined as a gateway combines them. */
function policyOf(sent: string | { header: string; suffix: string }): Policy {
  const parse = (text: string): Policy => {
    const parsed = parsePolicy(text);
    if (!parsed.ok) throw new Error(`the row's policy "${text}" is not valid: ${parsed.detail}`);
    return parsed.value;
  };
  return typeof sent === "string" ? parse(sent) : combinePolicies({ header: parse(sent.header), suffix: parse(sent.suffix) });
}

function read(row: OutcomeRow): unknown {
  const headers = { applied: row.applied ?? [], refused: row.refused ?? [], evidence: row.evidence ?? [] };
  if (row.sent === "translated") return interpret(headers, { kind: "translated" });
  const list = row.sent.list === "MODEL_LIST" ? MODEL_LIST : row.sent.list;
  const sent: Sent = { kind: "protocol", policy: row.sent.policy === null ? null : policyOf(row.sent.policy), routes: row.sent.list === undefined ? null : publishedRoutes(list, row.sent.model ?? "demo-model") };
  return interpret(headers, sent);
}

table("", "interpret", read, [
  [{ applied: ["provider=aurora"], sent: { policy: "zdr" } }, { kind: "honored", provider: "aurora", checked: false, evidence: null }],
  [{ applied: [], sent: { policy: "zdr" } }, { kind: "not-honored", why: "no Route-Applied" }],
  [{ applied: ["aurora"], sent: { policy: "zdr" } }, { kind: "not-honored", why: "Route-Applied is not valid: does not begin with the provider" }],
  [{ applied: ["provider="], sent: { policy: "zdr" } }, { kind: "not-honored", why: "Route-Applied is not valid: is not exactly one provider id" }],
  [{ applied: ["provider=Aurora!"], sent: { policy: "zdr" } }, { kind: "not-honored", why: "Route-Applied is not valid: is not exactly one provider id" }],
  [{ applied: ["provider=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], sent: { policy: "zdr" } }, { kind: "not-honored", why: "Route-Applied is not valid: is not exactly one provider id" }],
  [{ applied: ["provider=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], sent: { policy: "zdr" } }, { kind: "honored", provider: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", checked: false, evidence: null }],
  [{ applied: ["provider=aurora", "provider=basalt"], sent: { policy: "zdr" } }, { kind: "not-honored", why: "more than one Route-Applied" }],
  [{ applied: ["provider=aurora, provider=basalt"], sent: { policy: "zdr" } }, { kind: "not-honored", why: "Route-Applied is not valid: is not exactly one provider id" }],
  [{ applied: ["providers=aurora"], sent: { policy: "zdr" } }, { kind: "not-honored", why: "Route-Applied is not valid: does not begin with the provider" }],
  [{ applied: ["provider=aurora"], sent: { policy: "ignore=aurora" } }, { kind: "not-honored", why: "provider \"aurora\" is excluded by the policy sent" }],
  [{ applied: ["provider=basalt"], sent: { policy: "only=aurora" } }, { kind: "not-honored", why: "provider \"basalt\" is excluded by the policy sent" }],
  [{ applied: ["provider=aurora"], sent: { policy: "region=us+only=aurora" } }, { kind: "honored", provider: "aurora", checked: false, evidence: null }],
  [{ applied: ["provider=basalt"], evidence: ["https://basalt.example/attestation"], sent: { policy: "attest=weights" } }, { kind: "honored", provider: "basalt", checked: false, evidence: "https://basalt.example/attestation" }],
  [{ applied: ["provider=basalt"], evidence: [], sent: { policy: "attest=weights" } }, { kind: "not-honored", why: "attest was required and there is not exactly one valid Route-Evidence" }],
  [{ applied: ["provider=basalt"], evidence: ["https://basalt.example/attestation", "https://basalt.example/attestation"], sent: { policy: "attest=weights" } }, { kind: "not-honored", why: "attest was required and there is not exactly one valid Route-Evidence" }],
  [{ applied: ["provider=basalt"], evidence: ["http://basalt.example/attestation"], sent: { policy: "attest=weights" } }, { kind: "not-honored", why: "attest was required and there is not exactly one valid Route-Evidence" }],
  [{ applied: ["provider=basalt"], evidence: ["https://Basalt.example/attestation"], sent: { policy: "attest=weights" } }, { kind: "not-honored", why: "attest was required and there is not exactly one valid Route-Evidence" }],
  [{ applied: ["provider=basalt"], evidence: ["https://basalt.example:65536/a"], sent: { policy: "attest=weights" } }, { kind: "not-honored", why: "attest was required and there is not exactly one valid Route-Evidence" }],
  [{ applied: ["provider=basalt"], evidence: ["https://basalt.example:65535/a"], sent: { policy: "attest=weights" } }, { kind: "honored", provider: "basalt", checked: false, evidence: "https://basalt.example:65535/a" }],
  [{ applied: ["provider=basalt"], evidence: ["https://basalt.123/a"], sent: { policy: "attest=weights" } }, { kind: "not-honored", why: "attest was required and there is not exactly one valid Route-Evidence" }],
  [{ applied: ["provider=basalt"], evidence: ["https://basalt.example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], sent: { policy: "attest=weights" } }, { kind: "honored", provider: "basalt", checked: false, evidence: "https://basalt.example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
  [{ applied: ["provider=basalt"], evidence: ["https://basalt.example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], sent: { policy: "attest=weights" } }, { kind: "not-honored", why: "attest was required and there is not exactly one valid Route-Evidence" }],
  [{ applied: ["provider=aurora"], sent: { policy: { header: "region=us", suffix: "region=de" } } }, { kind: "not-honored", why: "the policies sent combine to one no route can meet" }],
  [{ applied: ["provider=basalt"], evidence: ["https://basalt.example/attestation"], sent: { policy: { header: "region=us+attest=weights", suffix: "region=de" } } }, { kind: "not-honored", why: "the policies sent combine to one no route can meet" }],
  [{ applied: ["provider=aurora"], sent: { policy: { header: "only=aurora", suffix: "only=basalt" } } }, { kind: "not-honored", why: "provider \"aurora\" is excluded by the policy sent" }],
  [{ applied: ["provider=aurora"], sent: { policy: { header: "only=aurora", suffix: "only=basalt" }, list: "MODEL_LIST" } }, { kind: "not-honored", why: "route \"aurora\" does not meet the policy sent" }],
  [{ applied: ["provider=aurora"], sent: { policy: "zdr", list: "MODEL_LIST" } }, { kind: "honored", provider: "aurora", checked: true, evidence: null }],
  [{ applied: ["provider=cobalt"], sent: { policy: "zdr", list: "MODEL_LIST" } }, { kind: "not-honored", why: "route \"cobalt\" does not meet the policy sent" }],
  [{ applied: ["provider=nosuch"], sent: { policy: "zdr", list: "MODEL_LIST" } }, { kind: "not-honored", why: "provider \"nosuch\" is not among the model's published routes" }],
  [{ applied: ["provider=aurora"], sent: { policy: "bits=16", list: "MODEL_LIST" } }, { kind: "not-honored", why: "route \"aurora\" does not meet the policy sent" }],
  [{ applied: ["provider=aurora"], sent: { policy: "zdr", list: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr" }, { provider: "aurora", facts: "zdr" }] }] } } }, { kind: "not-honored", why: "provider \"aurora\" is published more than once or with invalid facts" }],
  [{ applied: ["provider=aurora"], sent: { policy: "zdr", list: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr" }] }, { id: "demo-model", routes: [{ provider: "aurora", facts: "zdr" }] }] } } }, { kind: "not-honored", why: "provider \"aurora\" is not among the model's published routes" }],
  [{ applied: ["provider=aurora"], sent: { policy: "zdr", list: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr=yes" }] }] } } }, { kind: "not-honored", why: "provider \"aurora\" is published more than once or with invalid facts" }],
  [{ applied: ["provider=aurora"], sent: { policy: "zdr", list: {  } } }, { kind: "not-honored", why: "provider \"aurora\" is not among the model's published routes" }],
  [{ applied: ["provider=aurora"], evidence: ["https://aurora.example/attestation"], sent: { policy: "attest=weights", list: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr+attest=weights", evidence: "https://aurora.example/attestation" }, { provider: "basalt", facts: "attest=weights", evidence: "https://basalt.example/attestation" }] }] } } }, { kind: "honored", provider: "aurora", checked: true, evidence: "https://aurora.example/attestation" }],
  [{ applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: { policy: "attest=weights", list: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr+attest=weights", evidence: "https://aurora.example/attestation" }, { provider: "basalt", facts: "attest=weights", evidence: "https://basalt.example/attestation" }] }] } } }, { kind: "not-honored", why: "Route-Evidence is not the evidence published for \"aurora\"" }],
  [{ applied: ["provider=basalt"], evidence: ["https://aurora.example/attestation"], sent: { policy: "attest=weights", list: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr+attest=weights", evidence: "https://aurora.example/attestation" }, { provider: "basalt", facts: "attest=weights", evidence: "https://basalt.example/attestation" }] }] } } }, { kind: "not-honored", why: "Route-Evidence is not the evidence published for \"basalt\"" }],
  [{ applied: ["provider=basalt"], evidence: ["https://basalt.example/attestation/"], sent: { policy: "attest=weights", list: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr+attest=weights", evidence: "https://aurora.example/attestation" }, { provider: "basalt", facts: "attest=weights", evidence: "https://basalt.example/attestation" }] }] } } }, { kind: "not-honored", why: "Route-Evidence is not the evidence published for \"basalt\"" }],
  [{ applied: ["provider=basalt"], evidence: ["https://basalt.example/ATTESTATION"], sent: { policy: "attest=weights", list: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr+attest=weights", evidence: "https://aurora.example/attestation" }, { provider: "basalt", facts: "attest=weights", evidence: "https://basalt.example/attestation" }] }] } } }, { kind: "not-honored", why: "Route-Evidence is not the evidence published for \"basalt\"" }],
  [{ applied: ["provider=cobalt"], sent: { policy: "only=aurora", list: "MODEL_LIST" } }, { kind: "not-honored", why: "route \"cobalt\" does not meet the policy sent" }],
  [{ applied: ["provider=cobalt"], sent: { policy: "notrain", list: { data: [{ id: "other-model", routes: [{ provider: "cobalt", facts: "notrain" }] }] }, model: "other-model+notrain" } }, { kind: "honored", provider: "cobalt", checked: true, evidence: null }],
  [{ applied: ["provider=aurora"], sent: { policy: null } }, { kind: "served", provider: "aurora" }],
  [{ applied: ["aurora"], sent: { policy: null } }, { kind: "served", provider: null }],
  [{ applied: [], sent: { policy: null } }, { kind: "served", provider: null }],
  [{ applied: ["provider=aurora", "provider=basalt"], sent: { policy: null } }, { kind: "served", provider: null }],
  [{ applied: ["provider=aurora, provider=basalt"], sent: { policy: null } }, { kind: "served", provider: null }],
  [{ applied: ["provider=cobalt"], sent: { policy: null, list: "MODEL_LIST" } }, { kind: "served", provider: "cobalt" }],
  [{ refused: ["reason=unsupported+key=bits"], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: { policy: "zdr+attest=weights" } }, { kind: "refused", reason: "unsupported", key: "bits" }],
  [{ refused: ["reason=unsupported+key=bits"], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: "translated" }, { kind: "refused", reason: "unsupported", key: "bits" }],
  [{ refused: ["reason=unsupported+key=bits"], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: { policy: null } }, { kind: "refused", reason: "unsupported", key: "bits" }],
  [{ refused: ["reason=unavailable"], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: { policy: "zdr+attest=weights" } }, { kind: "refused", reason: "unavailable", key: null }],
  [{ refused: ["reason=unavailable"], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: "translated" }, { kind: "refused", reason: "unavailable", key: null }],
  [{ refused: ["reason=unavailable"], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: { policy: null } }, { kind: "refused", reason: "unavailable", key: null }],
  [{ refused: ["reason=maybe"], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: { policy: "zdr+attest=weights" } }, { kind: "refused", reason: null, key: null }],
  [{ refused: ["reason=maybe"], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: "translated" }, { kind: "refused", reason: null, key: null }],
  [{ refused: ["reason=maybe"], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: { policy: null } }, { kind: "refused", reason: null, key: null }],
  [{ refused: [""], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: { policy: "zdr+attest=weights" } }, { kind: "refused", reason: null, key: null }],
  [{ refused: [""], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: "translated" }, { kind: "refused", reason: null, key: null }],
  [{ refused: [""], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: { policy: null } }, { kind: "refused", reason: null, key: null }],
  [{ refused: ["reason=unavailable", "reason=unavailable"], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: { policy: "zdr+attest=weights" } }, { kind: "refused", reason: null, key: null }],
  [{ refused: ["reason=unavailable", "reason=unavailable"], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: "translated" }, { kind: "refused", reason: null, key: null }],
  [{ refused: ["reason=unavailable", "reason=unavailable"], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: { policy: null } }, { kind: "refused", reason: null, key: null }],
  [{ refused: ["reason=unavailable", "reason=unsatisfiable"], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: { policy: "zdr+attest=weights" } }, { kind: "refused", reason: null, key: null }],
  [{ refused: ["reason=unavailable", "reason=unsatisfiable"], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: "translated" }, { kind: "refused", reason: null, key: null }],
  [{ refused: ["reason=unavailable", "reason=unsatisfiable"], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: { policy: null } }, { kind: "refused", reason: null, key: null }],
  [{ refused: ["reason=unavailable, reason=unavailable"], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: { policy: "zdr+attest=weights" } }, { kind: "refused", reason: null, key: null }],
  [{ refused: ["reason=unavailable, reason=unavailable"], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: "translated" }, { kind: "refused", reason: null, key: null }],
  [{ refused: ["reason=unavailable, reason=unavailable"], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: { policy: null } }, { kind: "refused", reason: null, key: null }],
  [{ refused: ["reason=unsatisfiable+key=zdr"], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: { policy: "zdr+attest=weights" } }, { kind: "refused", reason: null, key: null }],
  [{ refused: ["reason=unsatisfiable+key=zdr"], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: "translated" }, { kind: "refused", reason: null, key: null }],
  [{ refused: ["reason=unsatisfiable+key=zdr"], applied: ["provider=aurora"], evidence: ["https://basalt.example/attestation"], sent: { policy: null } }, { kind: "refused", reason: null, key: null }],
  [{ sent: "translated" }, { kind: "unconfirmed" }],
  [{ applied: ["provider=aurora"], sent: "translated" }, { kind: "unconfirmed" }],
  [{ applied: ["aurora"], sent: "translated" }, { kind: "unconfirmed" }],
  [{ evidence: ["https://basalt.example/attestation"], sent: "translated" }, { kind: "unconfirmed" }],
  [{ applied: ["provider=aurora", "provider=basalt"], sent: "translated" }, { kind: "unconfirmed" }],
]);

// Honored results, compared or not, with evidence or without: the words never present a fact or evidence as verified.
table("C7", "describeReport", (report: Report) => describeReport(report), [
  [{ kind: "honored", provider: "aurora", checked: false, evidence: null }, "route policy honored: served by aurora; its published facts were not compared: no model list was held"],
  [{ kind: "honored", provider: "aurora", checked: true, evidence: null }, "route policy honored: served by aurora; its published facts meet the policy (they are the gateway's claims, not verified by this client)"],
  [{ kind: "honored", provider: "basalt", checked: false, evidence: "https://basalt.example/attestation" }, "route policy honored: served by basalt; its published facts were not compared: no model list was held; evidence at https://basalt.example/attestation, not verified by this client"],
  [{ kind: "honored", provider: "basalt", checked: true, evidence: "https://basalt.example/attestation" }, "route policy honored: served by basalt; its published facts meet the policy (they are the gateway's claims, not verified by this client); evidence at https://basalt.example/attestation, not verified by this client"],
]);

table("", "describeReport", (report: Report) => describeReport(report), [
  [{ kind: "served", provider: null }, "no route policy sent with this request"],
  [{ kind: "served", provider: "cobalt" }, "no route policy sent with this request; the gateway names cobalt as its route"],
  [{ kind: "refused", reason: "unsatisfiable", key: null }, "route policy refused by the gateway: unsatisfiable"],
  [{ kind: "refused", reason: "unsupported", key: "bits" }, "route policy refused by the gateway: unsupported (key bits)"],
  [{ kind: "refused", reason: null, key: null }, "route policy refused by the gateway (its Route-Refused value could not be read)"],
  [{ kind: "not-honored", why: "no Route-Applied" }, "route policy NOT honored: no Route-Applied"],
  [{ kind: "not-honored", why: "attest was required and there is not exactly one valid Route-Evidence" }, "route policy NOT honored: attest was required and there is not exactly one valid Route-Evidence"],
  [{ kind: "not-honored", why: 'Route-Evidence is not the evidence published for "basalt"' }, 'route policy NOT honored: Route-Evidence is not the evidence published for "basalt"'],
  [{ kind: "not-honored", why: "the policies sent combine to one no route can meet" }, "route policy NOT honored: the policies sent combine to one no route can meet"],
  [{ kind: "unconfirmed" }, "route policy translated into the gateway's own fields; the result is unconfirmed, not applied"],
  [{ kind: "unconfirmed", note: "the gateway answered with a redirect (status 307), which the plugin does not follow with content" }, "route policy translated into the gateway's own fields; the result is unconfirmed, not applied (the gateway answered with a redirect (status 307), which the plugin does not follow with content)"],
  [{ kind: "blocked", reason: "no valid detection reply" }, "request blocked by the route policy plugin, nothing was sent: no valid detection reply"],
]);

table("", "isQuiet", (report: Report) => isQuiet(report), [
  [{ kind: "honored", provider: "aurora", checked: false, evidence: null }, true],
  [{ kind: "honored", provider: "aurora", checked: true, evidence: null }, true],
  [{ kind: "honored", provider: "basalt", checked: false, evidence: "https://basalt.example/attestation" }, true],
  [{ kind: "honored", provider: "basalt", checked: true, evidence: "https://basalt.example/attestation" }, true],
  [{ kind: "served", provider: null }, true],
  [{ kind: "served", provider: "cobalt" }, true],
  [{ kind: "refused", reason: "unsatisfiable", key: null }, false],
  [{ kind: "refused", reason: "unsupported", key: "bits" }, false],
  [{ kind: "refused", reason: null, key: null }, false],
  [{ kind: "not-honored", why: "no Route-Applied" }, false],
  [{ kind: "unconfirmed" }, false],
  [{ kind: "unconfirmed", note: "the gateway answered with a redirect (status 307), which the plugin does not follow with content" }, false],
  [{ kind: "blocked", reason: "no valid detection reply" }, false],
]);
