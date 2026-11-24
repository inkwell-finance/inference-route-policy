// The send decision (C1, C2, C9, C10, C12, C16): each row is the layers of policy, the carriers, and what is
// held about the gateway, and the whole decision, written out.

import { parseDetection } from "../../../core/src/index.ts";
import { anyPolicy, anyRequirement, carriedPolicy, decide, readLayers, type Carriers } from "../src/decide.ts";
import { holdPolicy, type Held } from "../src/held.ts";
import { F, P, sameList, table } from "./table.ts";
import { baselineSupport } from "../../../core/src/index.ts";

/** The model list the rows name as MODEL_LIST: aurora meets zdr, basalt attests with evidence, cobalt publishes nothing. */
const MODEL_LIST = { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "zdr+notrain+bits=8+region=us" }, { provider: "basalt", facts: "bits=16+region=us,de+attest=weights,prompt", evidence: "https://basalt.example/attestation" }, { provider: "cobalt", facts: "" }] }, { id: "other-model", routes: [{ provider: "cobalt", facts: "notrain" }] }] };

// The keys, attest values, and sort values the C1 rows below span, one row each: the source lists are these.
sameList("C1", "baselineSupport().keys", baselineSupport().keys, ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "sort", "order"]);
sameList("C1", "baselineSupport().attest", baselineSupport().attest, ["weights", "prompt"]);
sameList("C1", "baselineSupport().sort", baselineSupport().sort, ["price", "latency", "throughput"]);

interface DecideRow {
  held: string | null;
  model: string;
  configured?: string;
  carriers: Carriers;
  /** The gateway's base URL with its query; http://gw.test/v1 when omitted. */
  base?: string;
  /** A detection reply's body, read as one to a request with credentials; none held when omitted. */
  detection?: unknown;
  noDetection?: string;
  /** The model list held, or "MODEL_LIST"; none held when omitted. */
  list?: unknown;
}

function decided(row: DecideRow): unknown {
  const held: Held = row.held === null ? { kind: "none" } : holdPolicy(row.held, "session");
  const layers = readLayers(held, row.model, row.configured ?? null);
  if (!layers.ok) return layers;
  let detection = null;
  if (row.detection !== undefined) {
    const read = parseDetection({ status: 200, body: row.detection, credentialed: true });
    if (!read.ok) throw new Error(`the row's detection reply is not valid: ${read.detail}`);
    detection = read.value;
  }
  const list = row.list === "MODEL_LIST" ? MODEL_LIST : row.list;
  return decide(layers.value, row.carriers, { base: row.base ?? "http://gw.test/v1", detection, noDetection: row.noDetection ?? "not fetched", modelList: row.list === undefined ? null : { list } });
}

table("", "decide", decided, [
  [{ held: "zdr", model: "demo-model", carriers: "header", detection: { route_policy: "1", keys: ["notrain", "bits", "region", "attest", "only", "ignore", "sort", "order"] } }, { action: "block", reason: "http://gw.test/v1 does not list zdr in its detection reply" }],
  [{ held: "notrain", model: "demo-model", carriers: "header", detection: { route_policy: "1", keys: ["zdr", "bits", "region", "attest", "only", "ignore", "sort", "order"] } }, { action: "block", reason: "http://gw.test/v1 does not list notrain in its detection reply" }],
  [{ held: "bits=8", model: "demo-model", carriers: "header", detection: { route_policy: "1", keys: ["zdr", "notrain", "region", "attest", "only", "ignore", "sort", "order"] } }, { action: "block", reason: "http://gw.test/v1 does not list bits in its detection reply" }],
  [{ held: "region=us", model: "demo-model", carriers: "header", detection: { route_policy: "1", keys: ["zdr", "notrain", "bits", "attest", "only", "ignore", "sort", "order"] } }, { action: "block", reason: "http://gw.test/v1 does not list region in its detection reply" }],
  [{ held: "attest=weights", model: "demo-model", carriers: "header", detection: { route_policy: "1", keys: ["zdr", "notrain", "bits", "region", "only", "ignore", "sort", "order"] } }, { action: "block", reason: "http://gw.test/v1 does not list attest in its detection reply" }],
  [{ held: "only=aurora", model: "demo-model", carriers: "header", detection: { route_policy: "1", keys: ["zdr", "notrain", "bits", "region", "attest", "ignore", "sort", "order"] } }, { action: "block", reason: "http://gw.test/v1 does not list only in its detection reply" }],
  [{ held: "ignore=cobalt", model: "demo-model", carriers: "header", detection: { route_policy: "1", keys: ["zdr", "notrain", "bits", "region", "attest", "only", "sort", "order"] } }, { action: "block", reason: "http://gw.test/v1 does not list ignore in its detection reply" }],
  [{ held: "sort=price", model: "demo-model", carriers: "header", detection: { route_policy: "1", keys: ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "order"] } }, { action: "send", model: "demo-model", header: "sort=price", sent: P({ sort: "price" }), routes: null }],
  [{ held: "order=aurora", model: "demo-model", carriers: "header", detection: { route_policy: "1", keys: ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "sort"] } }, { action: "send", model: "demo-model", header: "order=aurora", sent: P({ order: ["aurora"] }), routes: null }],
  [{ held: null, model: "demo-model+zdr", carriers: "suffix", detection: { route_policy: "1", keys: ["notrain", "bits", "region", "attest", "only", "ignore", "sort", "order"] } }, { action: "block", reason: "http://gw.test/v1 does not list zdr in its detection reply" }],
  [{ held: null, model: "demo-model+notrain", carriers: "suffix", detection: { route_policy: "1", keys: ["zdr", "bits", "region", "attest", "only", "ignore", "sort", "order"] } }, { action: "block", reason: "http://gw.test/v1 does not list notrain in its detection reply" }],
  [{ held: null, model: "demo-model+bits=8", carriers: "suffix", detection: { route_policy: "1", keys: ["zdr", "notrain", "region", "attest", "only", "ignore", "sort", "order"] } }, { action: "block", reason: "http://gw.test/v1 does not list bits in its detection reply" }],
  [{ held: null, model: "demo-model+region=us", carriers: "suffix", detection: { route_policy: "1", keys: ["zdr", "notrain", "bits", "attest", "only", "ignore", "sort", "order"] } }, { action: "block", reason: "http://gw.test/v1 does not list region in its detection reply" }],
  [{ held: null, model: "demo-model+attest=weights", carriers: "suffix", detection: { route_policy: "1", keys: ["zdr", "notrain", "bits", "region", "only", "ignore", "sort", "order"] } }, { action: "block", reason: "http://gw.test/v1 does not list attest in its detection reply" }],
  [{ held: null, model: "demo-model+only=aurora", carriers: "suffix", detection: { route_policy: "1", keys: ["zdr", "notrain", "bits", "region", "attest", "ignore", "sort", "order"] } }, { action: "block", reason: "http://gw.test/v1 does not list only in its detection reply" }],
  [{ held: null, model: "demo-model+ignore=cobalt", carriers: "suffix", detection: { route_policy: "1", keys: ["zdr", "notrain", "bits", "region", "attest", "only", "sort", "order"] } }, { action: "block", reason: "http://gw.test/v1 does not list ignore in its detection reply" }],
  [{ held: null, model: "demo-model+sort=price", carriers: "suffix", detection: { route_policy: "1", keys: ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "order"] } }, { action: "send", model: "demo-model+sort=price", header: null, sent: P({ sort: "price" }), routes: null }],
  [{ held: null, model: "demo-model+order=aurora", carriers: "suffix", detection: { route_policy: "1", keys: ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "sort"] } }, { action: "send", model: "demo-model+order=aurora", header: null, sent: P({ order: ["aurora"] }), routes: null }],
  [{ held: "zdr+sort=price", model: "demo-model", carriers: "header", detection: { route_policy: "1", keys: ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "order"] } }, { action: "block", reason: "http://gw.test/v1 does not list sort in its detection reply" }],
  [{ held: null, model: "demo-model+zdr+sort=price", carriers: "suffix", detection: { route_policy: "1", keys: ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "order"] } }, { action: "block", reason: "http://gw.test/v1 does not list sort in its detection reply" }],
  [{ held: "zdr+order=aurora", model: "demo-model", carriers: "header", detection: { route_policy: "1", keys: ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "sort"] } }, { action: "block", reason: "http://gw.test/v1 does not list order in its detection reply" }],
  [{ held: null, model: "demo-model+zdr+order=aurora", carriers: "suffix", detection: { route_policy: "1", keys: ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "sort"] } }, { action: "block", reason: "http://gw.test/v1 does not list order in its detection reply" }],
  [{ held: "zdr+attest=weights", model: "demo-model", carriers: "header", detection: { route_policy: "1", attest: ["prompt"] } }, { action: "block", reason: "http://gw.test/v1 does not list attest=weights in its detection reply" }],
  [{ held: null, model: "demo-model+zdr+attest=weights", carriers: "suffix", detection: { route_policy: "1", attest: ["prompt"] } }, { action: "block", reason: "http://gw.test/v1 does not list attest=weights in its detection reply" }],
  [{ held: "zdr+attest=prompt", model: "demo-model", carriers: "header", detection: { route_policy: "1", attest: ["weights"] } }, { action: "block", reason: "http://gw.test/v1 does not list attest=prompt in its detection reply" }],
  [{ held: null, model: "demo-model+zdr+attest=prompt", carriers: "suffix", detection: { route_policy: "1", attest: ["weights"] } }, { action: "block", reason: "http://gw.test/v1 does not list attest=prompt in its detection reply" }],
  [{ held: "zdr+sort=price", model: "demo-model", carriers: "header", detection: { route_policy: "1", sort: ["latency", "throughput"] } }, { action: "block", reason: "http://gw.test/v1 does not list sort=price in its detection reply" }],
  [{ held: null, model: "demo-model+zdr+sort=price", carriers: "suffix", detection: { route_policy: "1", sort: ["latency", "throughput"] } }, { action: "block", reason: "http://gw.test/v1 does not list sort=price in its detection reply" }],
  [{ held: "zdr+sort=latency", model: "demo-model", carriers: "header", detection: { route_policy: "1", sort: ["price", "throughput"] } }, { action: "block", reason: "http://gw.test/v1 does not list sort=latency in its detection reply" }],
  [{ held: null, model: "demo-model+zdr+sort=latency", carriers: "suffix", detection: { route_policy: "1", sort: ["price", "throughput"] } }, { action: "block", reason: "http://gw.test/v1 does not list sort=latency in its detection reply" }],
  [{ held: "zdr+sort=throughput", model: "demo-model", carriers: "header", detection: { route_policy: "1", sort: ["price", "latency"] } }, { action: "block", reason: "http://gw.test/v1 does not list sort=throughput in its detection reply" }],
  [{ held: null, model: "demo-model+zdr+sort=throughput", carriers: "suffix", detection: { route_policy: "1", sort: ["price", "latency"] } }, { action: "block", reason: "http://gw.test/v1 does not list sort=throughput in its detection reply" }],
  [{ held: "zdr", model: "demo-model", carriers: "header", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "block", reason: "http://gw.test/v1 has no valid detection reply (detection reply is not valid: status is 404, not 200), so no requirement may be sent there" }],
  [{ held: null, model: "demo-model+notrain", carriers: "header", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "block", reason: "http://gw.test/v1 has no valid detection reply (detection reply is not valid: status is 404, not 200), so no requirement may be sent there" }],
  [{ held: "zdr", model: "demo-model+notrain", carriers: "header", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "block", reason: "http://gw.test/v1 has no valid detection reply (detection reply is not valid: status is 404, not 200), so no requirement may be sent there" }],
  [{ held: "sort=price", model: "demo-model+zdr", carriers: "header", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "block", reason: "http://gw.test/v1 has no valid detection reply (detection reply is not valid: status is 404, not 200), so no requirement may be sent there" }],
  [{ held: "zdr", model: "demo-model+sort=latency", carriers: "header", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "block", reason: "http://gw.test/v1 has no valid detection reply (detection reply is not valid: status is 404, not 200), so no requirement may be sent there" }],
  [{ held: null, model: "demo-model", configured: "bits=8", carriers: "header", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "block", reason: "http://gw.test/v1 has no valid detection reply (detection reply is not valid: status is 404, not 200), so no requirement may be sent there" }],
  [{ held: "sort=price+order=basalt", model: "demo-model+sort=latency", carriers: "header", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "send", model: "demo-model+sort=latency", header: "sort=price+order=basalt", sent: P({ sort: "latency", order: ["basalt"] }), routes: null }],
  [{ held: "zdr", model: "demo-model", carriers: "suffix", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "block", reason: "http://gw.test/v1 has no valid detection reply (detection reply is not valid: status is 404, not 200), so no requirement may be sent there" }],
  [{ held: null, model: "demo-model+notrain", carriers: "suffix", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "block", reason: "http://gw.test/v1 has no valid detection reply (detection reply is not valid: status is 404, not 200), so no requirement may be sent there" }],
  [{ held: "zdr", model: "demo-model+notrain", carriers: "suffix", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "block", reason: "http://gw.test/v1 has no valid detection reply (detection reply is not valid: status is 404, not 200), so no requirement may be sent there" }],
  [{ held: "sort=price", model: "demo-model+zdr", carriers: "suffix", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "block", reason: "http://gw.test/v1 has no valid detection reply (detection reply is not valid: status is 404, not 200), so no requirement may be sent there" }],
  [{ held: "zdr", model: "demo-model+sort=latency", carriers: "suffix", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "block", reason: "http://gw.test/v1 has no valid detection reply (detection reply is not valid: status is 404, not 200), so no requirement may be sent there" }],
  [{ held: null, model: "demo-model", configured: "bits=8", carriers: "suffix", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "block", reason: "http://gw.test/v1 has no valid detection reply (detection reply is not valid: status is 404, not 200), so no requirement may be sent there" }],
  [{ held: "sort=price+order=basalt", model: "demo-model+sort=latency", carriers: "suffix", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "send", model: "demo-model+sort=latency+order=basalt", header: null, sent: P({ sort: "latency", order: ["basalt"] }), routes: null }],
  [{ held: "attest=weights,prompt", model: "demo-model", carriers: "header", detection: { route_policy: "1", attest: ["prompt"] } }, { action: "block", reason: "http://gw.test/v1 does not list attest=weights in its detection reply" }],
  [{ held: "attest=weights,prompt", model: "demo-model", carriers: "header", detection: { route_policy: "1", attest: ["weights"] } }, { action: "block", reason: "http://gw.test/v1 does not list attest=prompt in its detection reply" }],
  [{ held: "attest=weights", model: "demo-model+attest=prompt", carriers: "header", detection: { route_policy: "1", attest: ["prompt"] } }, { action: "block", reason: "http://gw.test/v1 does not list attest=weights in its detection reply" }],
  [{ held: "attest=weights", model: "demo-model+attest=prompt", carriers: "header", detection: { route_policy: "1", attest: ["weights"] } }, { action: "block", reason: "http://gw.test/v1 does not list attest=prompt in its detection reply" }],
  [{ held: null, model: "demo-model+zdr+attest=weights,prompt", carriers: "suffix", detection: { route_policy: "1", attest: ["weights"] } }, { action: "block", reason: "http://gw.test/v1 does not list attest=prompt in its detection reply" }],
  [{ held: "zdr", model: "demo-model+bits=8", carriers: "header", detection: { route_policy: "1", keys: ["zdr", "notrain", "region", "attest", "only", "ignore", "sort", "order"] } }, { action: "block", reason: "http://gw.test/v1 does not list bits in its detection reply" }],
  [{ held: "bits=8", model: "demo-model+zdr", carriers: "header", detection: { route_policy: "1", keys: ["zdr", "notrain", "region", "attest", "only", "ignore", "sort", "order"] } }, { action: "block", reason: "http://gw.test/v1 does not list bits in its detection reply" }],
  [{ held: "zdr", model: "demo-model", configured: "bits=8", carriers: "header", detection: { route_policy: "1", keys: ["zdr", "notrain", "region", "attest", "only", "ignore", "sort", "order"] } }, { action: "block", reason: "http://gw.test/v1 does not list bits in its detection reply" }],
  [{ held: "zdr+sort=price", model: "demo-model+sort=latency", carriers: "header", detection: { route_policy: "1", sort: ["latency"] } }, { action: "block", reason: "http://gw.test/v1 does not list sort=price in its detection reply" }],
  [{ held: "zdr+attest=prompt+sort=latency+order=aurora", model: "demo-model+bits=8", carriers: "header", detection: { route_policy: "1" } }, { action: "send", model: "demo-model+bits=8", header: "zdr+attest=prompt+sort=latency+order=aurora", sent: P({ zdr: true, bits: 8, attest: ["prompt"], sort: "latency", order: ["aurora"] }), routes: null }],
  [{ held: "zdr", model: "demo-model+sort=latency+notrain", carriers: "header", detection: { route_policy: "1" } }, { action: "send", model: "demo-model+sort=latency+notrain", header: "zdr", sent: P({ zdr: true, notrain: true, sort: "latency" }), routes: null }],
  [{ held: "zdr+sort=price", model: "demo-model", configured: "bits=8+sort=latency", carriers: "header", detection: { route_policy: "1" } }, { action: "send", model: "demo-model", header: "zdr+bits=8+sort=price", sent: P({ zdr: true, bits: 8, sort: "price" }), routes: null }],
  [{ held: "region=us", model: "demo-model", configured: "region=de", carriers: "header", detection: { route_policy: "1" } }, { action: "block", reason: "the held policy and the configured Route-Policy header combine to one that cannot be written as a policy (malformed item \"\")" }],
  [{ held: "zdr+ignore=p1,p2,p3,p4,p5,p6,p7,p8,p9", model: "demo-model+ignore=q1,q2,q3,q4,q5,q6,q7,q8", carriers: "header", detection: { route_policy: "1" } }, { action: "send", model: "demo-model+ignore=q1,q2,q3,q4,q5,q6,q7,q8", header: "zdr+ignore=p1,p2,p3,p4,p5,p6,p7,p8,p9", sent: P({ zdr: true, ignore: ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"] }), routes: null }],
  [{ held: "zdr+ignore=p1,p2,p3,p4,p5,p6,p7,p8,p9", model: "demo-model+ignore=q1,q2,q3,q4,q5,q6,q7,q8", carriers: "suffix", detection: { route_policy: "1" } }, { action: "block", reason: "the held policy and the typed suffix combine to one that cannot be written as a policy (more than 16 items); no weaker one is sent in its place" }],
  [{ held: "zdr+region=us,de+sort=price", model: "demo-model+region=de,fr+sort=latency", carriers: "suffix", detection: { route_policy: "1" } }, { action: "send", model: "demo-model+zdr+region=de+sort=latency", header: null, sent: P({ zdr: true, region: ["de"], sort: "latency" }), routes: null }],
  [{ held: "region=us", model: "demo-model+region=de", carriers: "suffix", detection: { route_policy: "1" } }, { action: "block", reason: "the held policy and the typed suffix combine to one that cannot be written as a policy (malformed item \"\"); no weaker one is sent in its place" }],
  [{ held: "zdr", model: "demo-model", configured: "bits=8", carriers: "suffix", detection: { route_policy: "1" } }, { action: "send", model: "demo-model+zdr", header: "bits=8", sent: P({ zdr: true, bits: 8 }), routes: null }],
  [{ held: "zdr+sort=price", model: "demo-model+notrain+sort=latency", carriers: "header", detection: { route_policy: "1" } }, { action: "send", model: "demo-model+notrain+sort=latency", header: "zdr+sort=price", sent: P({ zdr: true, notrain: true, sort: "latency" }), routes: null }],
  [{ held: "zdr+sort=price", model: "demo-model+notrain+sort=latency", carriers: "suffix", detection: { route_policy: "1" } }, { action: "send", model: "demo-model+zdr+notrain+sort=latency", header: null, sent: P({ zdr: true, notrain: true, sort: "latency" }), routes: null }],
  [{ held: "only=aurora+ignore=cobalt", model: "vendor/model+sort=price", carriers: "header", base: "https://openrouter.ai/api/v1", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "translate", model: "vendor/model", provider: { only: ["aurora"], ignore: ["cobalt"], sort: "price" }, sent: P({ only: ["aurora"], ignore: ["cobalt"], sort: "price" }) }],
  [{ held: "only=aurora+ignore=cobalt", model: "vendor/model+sort=price", carriers: "suffix", base: "https://openrouter.ai/api/v1", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "translate", model: "vendor/model", provider: { only: ["aurora"], ignore: ["cobalt"], sort: "price" }, sent: P({ only: ["aurora"], ignore: ["cobalt"], sort: "price" }) }],
  [{ held: null, model: "vendor/model", configured: "only=aurora", carriers: "suffix", base: "https://openrouter.ai/api/v1", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "block", reason: "a Route-Policy header is configured for this provider, and this harness gives the plugin no way to remove it from a translated request" }],
  [{ held: null, model: "vendor/model", configured: "only=aurora", carriers: "header", base: "https://openrouter.ai/api/v1", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "translate", model: "vendor/model", provider: { only: ["aurora"] }, sent: P({ only: ["aurora"] }) }],
  [{ held: "sort=price", model: "vendor/model", configured: "only=aurora", carriers: "header", base: "https://openrouter.ai/api/v1", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "translate", model: "vendor/model", provider: { only: ["aurora"], sort: "price" }, sent: P({ only: ["aurora"], sort: "price" }) }],
  [{ held: "only=aurora", model: "vendor/model+only=basalt", carriers: "header", base: "https://openrouter.ai/api/v1", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "block", reason: "the policy cannot be translated for OpenRouter: only combines to an empty list, which no route can meet" }],
  [{ held: "zdr", model: "vendor/model", carriers: "header", base: "https://openrouter.ai/api/v1", detection: { route_policy: "1" } }, { action: "send", model: "vendor/model", header: "zdr", sent: P({ zdr: true }), routes: null }],
  [{ held: "zdr", model: "vendor/model", carriers: "suffix", base: "https://openrouter.ai/api/v1", detection: { route_policy: "1" } }, { action: "send", model: "vendor/model+zdr", header: null, sent: P({ zdr: true }), routes: null }],
  [{ held: "only=aurora", model: "vendor/model", carriers: "header", base: "https://openrouter.ai/api/v1?tenant=east", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "block", reason: "https://openrouter.ai/api/v1?tenant=east has no valid detection reply (detection reply is not valid: status is 404, not 200), so no requirement may be sent there" }],
  [{ held: null, model: "vendor/model", carriers: "header", base: "https://openrouter.ai/api/v1", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "send", model: "vendor/model", header: null, sent: null, routes: null }],
  [{ held: "only=aurora+sort=price", model: "vendor/model+sort=latency", carriers: "header", base: "https://openrouter.ai/api/v1", noDetection: "detection reply is not valid: status is 404, not 200" }, { action: "translate", model: "vendor/model", provider: { only: ["aurora"], sort: "latency" }, sent: P({ only: ["aurora"], sort: "latency" }) }],
  [{ held: "only=nosuch", model: "demo-model", carriers: "header", detection: { route_policy: "1" }, list: "MODEL_LIST" }, { action: "block", reason: "no route the model list publishes for demo-model meets the policy, so the gateway would refuse it only after receiving the content" }],
  [{ held: "only=nosuch", model: "demo-model", carriers: "header", detection: { route_policy: "1" } }, { action: "send", model: "demo-model", header: "only=nosuch", sent: P({ only: ["nosuch"] }), routes: null }],
  [{ held: "zdr", model: "demo-model+bits=16", carriers: "header", detection: { route_policy: "1" }, list: "MODEL_LIST" }, { action: "block", reason: "no route the model list publishes for demo-model meets the policy, so the gateway would refuse it only after receiving the content" }],
  [{ held: "zdr", model: "demo-model+bits=8", carriers: "suffix", detection: { route_policy: "1" }, list: "MODEL_LIST" }, { action: "send", model: "demo-model+zdr+bits=8", header: null, sent: P({ zdr: true, bits: 8 }), routes: [["aurora", { facts: F({ zdr: true, notrain: true, bits: 8, region: ["us"] }), evidence: null }], ["basalt", { facts: F({ bits: 16, region: ["us", "de"], attest: ["weights", "prompt"] }), evidence: "https://basalt.example/attestation" }], ["cobalt", { facts: F({}), evidence: null }]] }],
  [{ held: "zdr", model: "other-model", carriers: "header", detection: { route_policy: "1" }, list: "MODEL_LIST" }, { action: "block", reason: "no route the model list publishes for other-model meets the policy, so the gateway would refuse it only after receiving the content" }],
  [{ held: "notrain", model: "other-model", carriers: "suffix", detection: { route_policy: "1" }, list: "MODEL_LIST" }, { action: "send", model: "other-model+notrain", header: null, sent: P({ notrain: true }), routes: [["cobalt", { facts: F({ notrain: true }), evidence: null }]] }],
  [{ held: null, model: "demo-model", carriers: "header", detection: { route_policy: "1", key_policy: "only=nosuch" }, list: "MODEL_LIST" }, { action: "block", reason: "no route the model list publishes for demo-model meets the key's own policy, so the gateway would refuse it only after receiving the content" }],
  [{ held: null, model: "demo-model", carriers: "header", detection: { route_policy: "1", key_policy: "only=aurora" }, list: "MODEL_LIST" }, { action: "send", model: "demo-model", header: null, sent: null, routes: [["aurora", { facts: F({ zdr: true, notrain: true, bits: 8, region: ["us"] }), evidence: null }], ["basalt", { facts: F({ bits: 16, region: ["us", "de"], attest: ["weights", "prompt"] }), evidence: "https://basalt.example/attestation" }], ["cobalt", { facts: F({}), evidence: null }]] }],
  [{ held: null, model: "other-model", carriers: "suffix", detection: { route_policy: "1", key_policy: "only=aurora" }, list: "MODEL_LIST" }, { action: "block", reason: "no route the model list publishes for other-model meets the key's own policy, so the gateway would refuse it only after receiving the content" }],
  [{ held: "sort=price", model: "demo-model", carriers: "header", detection: { route_policy: "1", key_policy: "only=missing" }, list: "MODEL_LIST" }, { action: "block", reason: "no route the model list publishes for demo-model meets the policy combined with the key's own, so the gateway would refuse it only after receiving the content" }],
  [{ held: "notrain", model: "demo-model", carriers: "suffix", detection: { route_policy: "1", key_policy: "only=cobalt" }, list: "MODEL_LIST" }, { action: "block", reason: "no route the model list publishes for demo-model meets the policy combined with the key's own, so the gateway would refuse it only after receiving the content" }],
  [{ held: "notrain", model: "demo-model", carriers: "header", detection: { route_policy: "1", keys: ["notrain", "only", "future"], key_policy: "only=cobalt+future" }, list: "MODEL_LIST" }, { action: "send", model: "demo-model", header: "notrain", sent: P({ notrain: true }), routes: [["aurora", { facts: F({ zdr: true, notrain: true, bits: 8, region: ["us"] }), evidence: null }], ["basalt", { facts: F({ bits: 16, region: ["us", "de"], attest: ["weights", "prompt"] }), evidence: "https://basalt.example/attestation" }], ["cobalt", { facts: F({}), evidence: null }]] }],
  [{ held: "notrain", model: "demo-model", carriers: "header", detection: { route_policy: "1", keys: ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "sort", "order", "residency"], key_policy: "zdr+residency=eu" }, list: { data: [{ id: "demo-model", routes: [{ provider: "aurora", facts: "notrain" }] }] } }, { action: "send", model: "demo-model", header: "notrain", sent: P({ notrain: true }), routes: [["aurora", { facts: F({ notrain: true }), evidence: null }]] }],
  [{ held: null, model: "demo-model", carriers: "header", detection: { route_policy: "1", key_policy: "only=nosuch" } }, { action: "send", model: "demo-model", header: null, sent: null, routes: null }],
  [{ held: "sort=price", model: "demo-model", carriers: "header", detection: { route_policy: "1" }, list: { data: [] } }, { action: "send", model: "demo-model", header: "sort=price", sent: P({ sort: "price" }), routes: [] }],
  [{ held: null, model: "demo-model+order=aurora", carriers: "suffix", detection: { route_policy: "1" }, list: { data: [] } }, { action: "send", model: "demo-model+order=aurora", header: null, sent: P({ order: ["aurora"] }), routes: [] }],
  [{ held: "attest=weights", model: "demo-model", carriers: "header", detection: { route_policy: "1" }, list: { data: [{ id: "demo-model", routes: [{ provider: "basalt", facts: "attest=weights", evidence: "https://basalt.example/attestation" }] }] } }, { action: "send", model: "demo-model", header: "attest=weights", sent: P({ attest: ["weights"] }), routes: [["basalt", { facts: F({ attest: ["weights"] }), evidence: "https://basalt.example/attestation" }]] }],
  [{ held: "attest=weights", model: "demo-model", carriers: "header", detection: { route_policy: "1" }, list: { data: [{ id: "demo-model", routes: [{ provider: "basalt", facts: "attest=weights", evidence: "http://basalt.example/attestation" }] }] } }, { action: "block", reason: "no route the model list publishes for demo-model meets the policy, so the gateway would refuse it only after receiving the content" }],
  [{ held: "attest=weights", model: "demo-model", carriers: "header", detection: { route_policy: "1" }, list: { data: [{ id: "demo-model", routes: [{ provider: "basalt", facts: "attest=weights", evidence: null }] }] } }, { action: "block", reason: "no route the model list publishes for demo-model meets the policy, so the gateway would refuse it only after receiving the content" }],
  [{ held: "attest=weights", model: "demo-model", carriers: "header", detection: { route_policy: "1" }, list: { data: [{ id: "demo-model", routes: [{ provider: "basalt", facts: "attest=weights" }] }] } }, { action: "block", reason: "no route the model list publishes for demo-model meets the policy, so the gateway would refuse it only after receiving the content" }],
  [{ held: "attest=weights", model: "demo-model", carriers: "header", detection: { route_policy: "1" }, list: { data: [{ id: "demo-model", routes: [{ provider: "basalt", facts: "attest=weights", evidence: 7 }] }] } }, { action: "block", reason: "no route the model list publishes for demo-model meets the policy, so the gateway would refuse it only after receiving the content" }],
  [{ held: "attest=weights", model: "demo-model", carriers: "header", detection: { route_policy: "1" }, list: { data: [{ id: "demo-model", routes: [{ provider: "basalt", facts: "attest=weights", evidence: ["https://basalt.example/attestation"] }] }] } }, { action: "block", reason: "no route the model list publishes for demo-model meets the policy, so the gateway would refuse it only after receiving the content" }],
  [{ held: "attest=weights", model: "demo-model", carriers: "header", detection: { route_policy: "1" }, list: { data: [{ id: "demo-model", routes: [{ provider: "basalt", facts: "attest=weights", evidence: "https://basalt.example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] }] } }, { action: "block", reason: "no route the model list publishes for demo-model meets the policy, so the gateway would refuse it only after receiving the content" }],
]);

interface LayerRow {
  held: string | null;
  model: string;
  configured: string | null;
}
const layered = (row: LayerRow): ReturnType<typeof readLayers> => readLayers(row.held === null ? { kind: "none" } : holdPolicy(row.held, "session"), row.model, row.configured);

table("C10", "readLayers", layered, [
  [{ held: null, model: "demo-model", configured: null }, { ok: true, value: { model: "demo-model", typed: null, configured: null, held: null } }],
  [{ held: "zdr", model: "demo-model+notrain", configured: "bits=8" }, { ok: true, value: { model: "demo-model+notrain", typed: P({ notrain: true }), configured: { text: "bits=8", policy: P({ bits: 8 }) }, held: P({ zdr: true }) } }],
  [{ held: "zdr+zdr", model: "demo-model", configured: null }, { ok: false, reason: "the held policy \"zdr+zdr\" is not valid: repeated key" }],
  [{ held: "zdr", model: "demo-model+zdr=1", configured: null }, { ok: false, reason: "the model id \"demo-model+zdr=1\" carries a suffix that is not a valid policy: takes no value" }],
  [{ held: "zdr", model: "demo-model", configured: "bits=0" }, { ok: false, reason: "the configured Route-Policy header \"bits=0\" is not a valid policy: takes one integer from 1 to 64" }],
  [{ held: null, model: "demo-model+", configured: null }, { ok: false, reason: "the model id \"demo-model+\" carries a suffix that is not a valid policy: malformed key in \"\"" }],
]);

table("", "anyPolicy and anyRequirement", (row: LayerRow) => {
  const layers = layered(row);
  if (!layers.ok) throw new Error(layers.reason);
  return { anyPolicy: anyPolicy(layers.value), anyRequirement: anyRequirement(layers.value) };
}, [
  [{ held: null, model: "demo-model", configured: null }, { anyPolicy: false, anyRequirement: false }],
  [{ held: "sort=price", model: "demo-model", configured: null }, { anyPolicy: true, anyRequirement: false }],
  [{ held: null, model: "demo-model+zdr", configured: null }, { anyPolicy: true, anyRequirement: true }],
  [{ held: null, model: "demo-model", configured: "order=aurora" }, { anyPolicy: true, anyRequirement: false }],
  [{ held: null, model: "demo-model", configured: "only=aurora" }, { anyPolicy: true, anyRequirement: true }],
  [{ held: null, model: "demo-model+sort=latency", configured: null }, { anyPolicy: true, anyRequirement: false }],
]);

table("C10", "carriedPolicy", ([model, header]: [string | null, string | null]) => carriedPolicy(model, header), [
  [[null, null], { ok: true, value: null }],
  [["m+zdr", null], { ok: true, value: P({ zdr: true }) }],
  [[null, "notrain"], { ok: true, value: P({ notrain: true }) }],
  [["m+zdr+sort=latency", "notrain+sort=price"], { ok: true, value: P({ zdr: true, notrain: true, sort: "latency" }) }],
  [["m+zdr=1", null], { ok: false, reason: "the model suffix \"zdr=1\" is not a valid policy" }],
  [[null, "x y"], { ok: false, reason: "the Route-Policy header \"x y\" is not a valid policy" }],
  [["m", null], { ok: true, value: null }],
]);
