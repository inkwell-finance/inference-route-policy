# Requirements

Every testable rule in [SPEC.md](SPEC.md), numbered so that code, tests,
and reviews can point at one. SPEC.md is authoritative; if this file and
the spec disagree, that is a defect in this file.

"BB" marks a rule the conformance suite can check from outside, over
HTTP, against any gateway. The others need control of the providers
behind the gateway and are checked in the reference gateway's own tests.

## Syntax (S)

| Id  | Rule | Spec section |
| --- | ---- | ------------ |
| S1  | A policy matches the grammar exactly: pairs joined by `+`, `key` or `key=list`, items joined by `,`, no whitespace, no empty pair, no empty list. | Syntax |
| S2  | A key is `name` or `name.name`, each name `[a-z][a-z0-9]{0,15}`. An item is `[a-z0-9][a-z0-9_.-]{0,31}`. | Syntax |
| S3  | A repeated key, or a repeated item within one list, is malformed. | Syntax |
| S4  | Limits: 512 bytes, 16 pairs, 16 items per list. Over a limit is malformed. | Limits |
| S5  | `zdr` and `notrain` are flags. With a value they are not accepted. | Keys |
| S6  | `bits` takes exactly one integer 1 to 64 with no leading zero. | Keys |
| S7  | `region` takes a list of two lowercase letters each. | Keys |
| S8  | `attest` takes a list drawn from the values the gateway accepts (baseline `weights`, `prompt`). | Keys |
| S9  | `only`, `ignore`, `order` take a list of items. As flags they are not accepted. | Keys |
| S10 | `sort` takes exactly one of the values the gateway accepts (baseline `price`, `latency`, `throughput`). | Keys |
| S11 | The `model` field splits at its first `+`: id before, policy after. No `+` means no suffix policy. An empty id or an empty policy is malformed. | Carriers |
| S12 | Facts use the policy grammar restricted to `zdr`, `notrain`, `bits`, `region`, `attest`, and vendor keys, and may be the empty string. | Facts |
| S13 | `Route-Applied` is `provider=<id>`, then `+` and the route's facts when they are not empty. | Result |
| S14 | `Route-Refused` is `reason=<unsupported\|unsatisfiable\|unavailable>`, then `+key=<key>` when a key is named. | Refusal |

## Gateway (G)

| Id  | Rule | BB | Spec section |
| --- | ---- | -- | ------------ |
| G1  | A policy that is malformed, over a limit, or has a key or value the gateway does not accept is refused: 400, `Route-Refused: reason=unsupported`. | BB | Syntax, Refusal |
| G2  | `key` in an `unsupported` refusal names the first offending key when that pair's key is well formed, and is absent otherwise. | BB | Refusal |
| G3  | A policy no route of the model meets is refused: 400, `reason=unsatisfiable`. | BB | Refusal |
| G4  | No content reaches any provider for an `unsupported` or `unsatisfiable` request. |  | Refusal |
| G5  | When routes meet the policy but none can serve: 503, `reason=unavailable`. No route that fails the policy receives the request. |  | Refusal |
| G6  | A request is served only by a route that meets the combined policy, under the matching rules of the Facts section. | BB | Keys, Facts |
| G7  | Among qualifying routes, `order` providers are tried first in the order given, then the rest by `sort`; without `sort`, the gateway's default order. Preferences never change which routes qualify. | BB | Keys |
| G8  | The model-suffix carrier works: the id resolves as it would without the suffix, and the suffix is applied as a policy. | BB | Carriers |
| G9  | The `Route-Policy` header carrier works on every inference endpoint. More than one such header is refused as `unsupported`. | BB | Carriers |
| G10 | A key-default policy applies to every request made with that key. | BB | Carriers |
| G11 | Carriers combine by the Combining table. Each carrier's policy is checked on its own first. | BB | Combining |
| G12 | An empty `region` or `only` intersection is `unsatisfiable`. | BB | Combining |
| G13 | No request removes or weakens a requirement of its key's policy. | BB | Combining |
| G14 | The provider receives the model id without the suffix and no `Route-Policy` header. |  | Carriers |
| G15 | Every response a route produced for a request a policy reached carries `Route-Applied` naming that route's provider and facts. | BB | Result |
| G16 | `Route-Applied` is final before the first body byte; the gateway does not switch routes after that. It may fall back to another qualifying route before it. |  | Result |
| G17 | When `attest` was required, the response carries `Route-Evidence` with a URI. | BB | Result |
| G18 | `Route-Applied`, `Route-Refused`, and `Route-Evidence` headers received from a provider are not passed to the client as the gateway's own. |  | Result, Security |
| G19 | A refused response carries no `Route-Applied`. | BB | Refusal |
| G20 | `GET {base}/route-policy` returns 200 and a JSON object with `route_policy: 1`, without credentials. | BB | Detection |
| G21 | `keys`, `attest`, `sort` in the detection reply, when present, are exactly what the gateway accepts; anything unlisted is refused as `unsupported`. | BB | Detection |
| G22 | `key_policy` appears only for credentials whose key has a policy, and equals it. | BB | Detection |
| G23 | Each model in `GET {base}/models` carries `routes`, each with `provider` and `facts`, and those facts are the ones routing uses. | BB | Facts |
| G24 | An unknown provider id is not an error: in `only` it matches nothing; in `ignore` and `order` it has no effect. | BB | Keys |
| G25 | A vendor key the gateway does not define is refused as `unsupported`, naming the key. | BB | Keys |
| G26 | A request with no policy from any carrier behaves as it would on a gateway without this protocol, and carries no `Route-Applied`. | BB | Result |

## Client (C)

| Id  | Rule | Spec section |
| --- | ---- | ------------ |
| C1  | A policy containing a requirement is not sent to a base URL without a valid detection reply from it that lists every key and value the policy uses. No content leaves the client in that case. | Detection |
| C2  | A policy containing only preferences may be sent without detection. | Detection |
| C3  | A response to a request that carried requirements, with no `Route-Applied`, is reported to the user as not honored. | Result |
| C4  | The client checks that the reported provider and facts meet the requirements it sent, and reports a mismatch as not honored. | Result |
| C5  | `Route-Refused` is reported to the user with its reason and key. | Refusal |
| C6  | Unknown members of the detection reply and unknown fact keys are ignored. | Detection, Facts |
| C7  | An unverified fact is never presented as verified. | Security |
| C8  | A translated policy is shown as unconfirmed. | Adoption |
| C9  | A requirement the target dialect cannot express as a hard filter is not sent; the request is blocked and no content leaves the client. | Adoption |
| C10 | A policy the client holds is combined with one the user typed as a model suffix so that requirements only accumulate, as in the Combining table. | Combining |
