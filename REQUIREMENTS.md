# Requirements

Every testable rule in [SPEC.md](SPEC.md), numbered so that code, tests,
and reviews can point at one. SPEC.md is authoritative: a row here says
nothing the spec does not say and is no stronger than the spec. If this
file and the spec disagree, that is a defect in this file.

"BB" marks a rule the conformance suite can check from outside, over
HTTP, against any gateway. The others need control of the providers
behind the gateway and are checked in the reference gateway's own tests.

## Syntax (S)

Rules about strings. Every implementation that reads or writes one is
bound by them.

| Id  | Rule | Spec section |
| --- | ---- | ------------ |
| S1  | A policy matches the grammar exactly: pairs joined by `+`, each `key` or `key=list`, items joined by `,`, no whitespace, no empty pair, no empty list. | Syntax |
| S2  | A key is `name` or `name.name`, each name `[a-z][a-z0-9]{0,15}`. An item is `[a-z0-9][a-z0-9_.-]{0,31}`. | Syntax |
| S3  | A key appears at most once in a policy and an item at most once in a list. | Syntax |
| S4  | Limits: 512 bytes, 16 pairs, 16 items per list. They are the same at every gateway. | Limits |
| S5  | `zdr` and `notrain` are flags. | Keys |
| S6  | `bits` takes exactly one integer 1 to 64 with no leading zero. | Keys |
| S7  | `region` takes a list of officially assigned ISO 3166-1 alpha-2 codes in lowercase. An unassigned two-letter code is not valid. | Keys |
| S8  | `attest` takes a list drawn from `weights` and `prompt`, each also listed in detection. | Keys, Detection |
| S9  | `only`, `ignore`, `order` take a list of provider ids; any item is valid. | Keys |
| S10 | `sort` takes exactly one of `price`, `latency`, `throughput`, also listed in detection. | Keys, Detection |
| S11 | A `model` field containing `+` splits at its first `+` into a non-empty id and a policy. An empty id is malformed and names no key. | Carriers |
| S12 | Published facts use only `zdr`, `notrain`, `bits`, `region`, `attest`, and vendor keys the gateway defines, with valid values, or are the empty string. | Facts |
| S13 | A reader treats facts that are malformed or contain `only`, `ignore`, `sort`, or `order` as a route meeting nothing, and ignores other well-formed keys it does not know. | Facts |
| S14 | `Route-Applied` is `provider=<item>`, then `+` and the route's facts when they are not empty. The limits apply to the facts, not to the whole value. | Result, Limits |
| S15 | `Route-Refused` is `reason=<unsupported\|unsatisfiable\|unavailable>`, optionally followed by `+key=<key>`, and nothing else. `key` appears only with `unsupported`. | Refusal |
| S16 | Order of checks: the whole string first (over 512 bytes or over 16 pairs, no key named); then each pair in the order written (grammar, repeated key, key accepted, value accepted). The first failing pair is named when its key is well formed. | Order of checks |
| S17 | Every provider id a gateway publishes or reports is an `item`. | Keys |

## Gateway (G)

| Id  | Rule | BB | Spec section |
| --- | ---- | -- | ------------ |
| G1  | A policy that fails the order of checks is refused: 400, `Route-Refused: reason=unsupported`. | BB | Syntax, Refusal |
| G2  | `key` in an `unsupported` refusal is present exactly when S16 names one, and names that key. | BB | Order of checks, Refusal |
| G3  | A combined policy no route of the model meets is refused: 400, `reason=unsatisfiable`, no `key`. | BB | Refusal |
| G4  | No content reaches any provider for an `unsupported` or `unsatisfiable` request. |  | Refusal |
| G5  | When routes meet the combined policy and every one tried failed: 503, `reason=unavailable`, no `key`. No route that fails the policy receives the request. |  | Refusal, Result |
| G6  | A request is served only by a route that meets the combined policy, under the matching rules of the Facts section. | BB | Facts |
| G7  | Among qualifying routes, `order` providers are tried first in the order given, then the rest by `sort`; without `sort`, the gateway's default order. Preferences never change which routes qualify. | BB | Keys |
| G8  | The model-suffix carrier works: the id resolves as it would without the suffix, and the suffix is applied as a policy. | BB | Carriers |
| G9  | The `Route-Policy` header carrier works on every inference endpoint. More than one `Route-Policy` field line is refused as `unsupported` with no key, judged on field lines as received. | BB | Carriers |
| G10 | A key-default policy applies to every request made with that key. A gateway does not bind a policy it would refuse. | BB | Carriers |
| G11 | Carriers combine by the Combining table. The header is checked first and the suffix second, each on its own; the first that fails decides the refusal. | BB | Carriers, Combining |
| G12 | An empty `region` or `only` intersection is `unsatisfiable`. | BB | Combining |
| G13 | No request removes or weakens a requirement of its key's policy. | BB | Combining |
| G14 | The provider receives the model id without the suffix and no `Route-Policy` header. |  | Carriers |
| G15 | Every relayed response to a request a policy reached carries `Route-Applied`, naming the provider id of the route whose response it is and that route's published facts. | BB | Result |
| G16 | `Route-Applied` is final before the first body byte. A gateway may try another qualifying route when one fails, and does not move a request after relaying any body byte. |  | Result |
| G17 | A relayed response carries `Route-Evidence` exactly when the combined policy has `attest`, and its value is the `evidence` URI published for the applied route. | BB | Result, Facts |
| G18 | `Route-Applied`, `Route-Refused`, and `Route-Evidence` headers received from a provider are never passed to the client. |  | Result |
| G19 | A refusal carries `Route-Refused` and neither `Route-Applied` nor `Route-Evidence`, and never a provider's body. A relayed response carries no `Route-Refused`. | BB | Result |
| G20 | `GET {base}/route-policy` returns 200 and a valid detection reply with `route_policy: 1`, without credentials. | BB | Detection |
| G21 | The gateway refuses, as `unsupported`, any key it did not list and any `attest` or `sort` value it did not list. For `bits`, `region`, `only`, `ignore`, `order` it accepts every valid value of a listed key. | BB | Detection |
| G22 | `key_policy` is present only for credentials whose key has a policy bound, equals it, and is valid under the reply's own lists. | BB | Detection |
| G23 | Each model in `GET {base}/models` carries `routes`, each with `provider` and `facts` per S12, and `evidence` when the facts include `attest`. Those facts are the ones routing uses. | BB | Facts |
| G24 | An unknown provider id is not an error: in `only` it matches nothing; in `ignore` and `order` it has no effect. | BB | Keys |
| G25 | A vendor key the gateway does not list is refused as `unsupported`, naming the key. | BB | Vendor keys |
| G26 | A request no policy reached is routed as it would be without this protocol and carries neither `Route-Refused` nor `Route-Evidence`. | BB | Result |
| G27 | `Route-Evidence` and the `evidence` URI point at the provider's own evidence. The gateway puts no verdict or summary of its own in the header or at the URI. |  | Result |
| G28 | A vendor key the gateway defines: values it does not accept are refused as `unsupported` naming the key; a route meets it only if its facts carry the key and the gateway's rule says so; without a combining rule, different values by two carriers are refused as `unsupported` naming the key. |  | Vendor keys |
| G29 | A request refusable for more than one reason is refused for the first of `unsupported`, `unsatisfiable`, `unavailable`. | BB | Refusal |

## Client (C)

"Strength" is the spec's own keyword for the rule.

| Id  | Strength | Rule | Spec section |
| --- | -------- | ---- | ------------ |
| C1  | MUST NOT | A policy containing a requirement is not sent by the model suffix or the header to a base URL without a valid detection reply from it that lists every key the policy uses and every `attest` and `sort` value it uses. Without one the request is not sent and no content leaves the client. | Clients |
| C2  | MAY | A policy containing only preferences may be sent without detection. | Clients |
| C3  | MUST | For a request sent with a requirement, a response with neither `Route-Applied` nor `Route-Refused` is treated as not honored: the policy is not reported as applied. | Clients |
| C4  | SHOULD | The client checks that the provider and facts in `Route-Applied` meet the requirements it sent, and treats a mismatch as not honored. | Clients |
| C5  | SHOULD | A response with `Route-Refused` is a refusal even when the value cannot be parsed; the client tells its user the reason and the key. | Clients |
| C6  | MUST | A detection reply that is not valid, or cannot be fetched, is no detection. In a valid one, unknown members, undefined dotless keys, and undefined `attest` and `sort` values are ignored. | Detection |
| C7  | SHOULD NOT | A fact is not presented as verified unless the client verified the evidence itself. | Clients |
| C8  | MUST | A translated request's result is unconfirmed: the policy is not reported as applied. | Clients |
| C9  | MUST NOT | A translated request is not sent unless every requirement maps to something the target documents as a hard filter. Otherwise the request is not sent at all. | Clients |
| C10 | MUST NOT | A client holding a policy applies it together with one typed as a model suffix: by both carriers where it can, otherwise combined with the suffix as the more specific. If the combination cannot be written as a valid policy the request is not sent, and no weaker policy is sent in its place. | Clients |
