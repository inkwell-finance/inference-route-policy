# Requirements

Every testable rule in [SPEC.md](SPEC.md), numbered so that code, tests,
and reviews can point at one. SPEC.md is authoritative: a row here says
nothing the spec does not say and is no stronger than the spec. If this
file and the spec disagree, that is a defect in this file.

Each gateway rule has a kind, which says how it can be checked:

- **BB**: from outside, over HTTP, against any gateway, from what its
  responses carry. The conformance suite checks these.
- **WB**: only with control of the gateway's configuration or of the
  providers behind it, to see what was bound, what reached a provider,
  or what a provider returned. The reference gateway's own tests check
  these.
- **Op**: a rule about how a gateway is deployed or what its operator
  asserts. No test of its code can establish it.

## Syntax (S)

Rules about strings. Every implementation that reads or writes one is
bound by them.

| Id  | Rule | Spec section |
| --- | ---- | ------------ |
| S1  | A policy matches the grammar exactly: pairs joined by `+`, each `key` or `key=list`, items joined by `,`, no whitespace, no empty pair, no empty list. | Syntax |
| S2  | A key is `[a-z][a-z0-9]{0,15}`. An item is `[a-z0-9][a-z0-9_.-]{0,31}`. | Syntax |
| S3  | A key appears at most once in a policy and an item at most once in a list. | Syntax |
| S4  | Limits: 512 bytes, 16 pairs, 16 items per list. They are the same at every gateway. | Limits |
| S5  | `zdr` and `notrain` are flags. | Keys |
| S6  | `bits` takes exactly one integer 1 to 64 with no leading zero. | Keys |
| S7  | `region` takes a list of officially assigned ISO 3166-1 alpha-2 codes in lowercase. An unassigned two-letter code is not valid. | Keys |
| S8  | `attest` takes a list drawn from `weights` and `prompt`, each also listed in detection. | Keys, Detection |
| S9  | `only`, `ignore`, `order` take a list of provider ids; any item is valid. | Keys |
| S10 | `sort` takes exactly one of `price`, `latency`, `throughput`, also listed in detection. | Keys, Detection |
| S11 | A `model` field containing `+` splits at its first `+` into an id and a policy. | Carriers |
| S12 | Published facts use only `zdr`, `notrain`, `bits`, `region`, and `attest`, with valid values (for `attest`, any of `weights` and `prompt`), or are the empty string. Which facts are published does not depend on which keys or values the gateway accepts in requests. | Facts |
| S13 | A reader ignores a well-formed fact key it does not know and an `attest` item it does not know. Facts are invalid when they do not fit the grammar or limits, when `zdr`, `notrain`, `bits`, or `region` has an invalid value, when `attest` is a flag, or when they contain `only`, `ignore`, `sort`, or `order`. A route with invalid facts meets no policy that has a requirement. | Facts |
| S14 | `Route-Applied` is `provider=<item>` and nothing else. | Result |
| S15 | `Route-Refused` is `reason=<unsupported\|unsatisfiable\|unavailable>`, optionally followed by `+key=<key>`, and nothing else. `key` appears only with `unsupported`. | Refusal |
| S16 | Order of checks: the whole string first (over 512 bytes or over 16 pairs, no key named); then each pair in the order written. The first pair that fails, for any reason, is the offending pair, and its key is named when the key fits the `key` grammar. | Order of checks |
| S17 | Every provider id a gateway publishes or reports is an `item`. | Keys |
| S18 | An evidence URI (`evidence`, and the `Route-Evidence` value) fits the `evidence` grammar: `https://`, a lowercase host name, an optional port, an optional path of `[A-Za-z0-9._~/?=&-]`, at most 512 bytes. Two are the same only when they are the same string. | Facts |

## Gateway (G)

Every row about refusing a policy applies to a request that passes the
own-error checks of G25.

| Id  | Rule | Kind | Spec section |
| --- | ---- | ---- | ------------ |
| G1  | A policy that fails the order of checks is refused: 400, `Route-Refused: reason=unsupported`. | BB | Syntax, Refusal |
| G2  | `key` in an `unsupported` refusal is present exactly when S16 names one, and names that key. | BB | Order of checks, Refusal |
| G3  | A combined policy no route of the model meets is refused: 400, `reason=unsatisfiable`, no `key`. | BB | Refusal |
| G4  | No content reaches any provider for an `unsupported` or `unsatisfiable` request. | WB | Refusal |
| G5  | When routes meet the combined policy and every one tried failed: 503, `reason=unavailable`, no `key`. No route that fails the policy receives the request. | WB | Refusal, Result |
| G6  | A relayed response to a request a policy reached names, in `Route-Applied`, a route whose published facts and provider id meet the combined policy under the matching rules of the Facts section. | BB | Facts |
| G7  | Preferences never change which routes qualify: a request with `sort` or `order` is served by a route that meets its requirements, and a preference that names a provider that does not qualify causes no refusal. | BB | Keys |
| G8  | The model-suffix carrier works: the id resolves as it would without the suffix, and the suffix is applied as a policy. | BB | Carriers |
| G9  | The `Route-Policy` header carrier works on every inference endpoint. More than one `Route-Policy` field line is refused as `unsupported` with no key. | BB | Carriers |
| G10 | A key-default policy applies to every request made with that key. | BB | Carriers |
| G11 | Carriers combine by the Combining table. The header is checked first and the suffix second, each on its own; the first that fails decides the refusal. | BB | Carriers, Combining |
| G12 | An empty `region` or `only` intersection is `unsatisfiable`. | BB | Combining |
| G13 | No request removes or weakens a requirement of its key's policy. | BB | Combining |
| G14 | The provider receives the model id without the suffix and no `Route-Policy` header. | WB | Carriers |
| G15 | Every relayed response to a request a policy reached carries `Route-Applied`, naming a provider id published for the model. | BB | Result |
| G16 | A gateway may try another qualifying route when one fails before it has committed the status and headers of its final response, and does not move a request to another route after that. A 1xx response is not the final response. | WB | Result |
| G17 | A relayed response to a request a policy reached carries `Route-Evidence` exactly when the combined policy has `attest`, and its value is the same string as the `evidence` published for the applied route. | BB | Result, Facts |
| G18 | `Route-Applied`, `Route-Refused`, and `Route-Evidence` headers received from a provider are never passed to the client. | WB | Result |
| G19 | A refusal carries `Route-Refused` and neither `Route-Applied` nor `Route-Evidence`. A relayed response carries no `Route-Refused`. A response carries at most one field line of each of the three. | BB | Result |
| G20 | `GET {base}/route-policy` returns 200 and a valid detection reply with `route_policy: "1"`, with credentials or without. | BB | Detection |
| G21 | The gateway refuses, as `unsupported`, any key it did not list and any `attest` or `sort` value it did not list. For `bits`, `region`, `only`, `ignore`, `order` it accepts every valid value of a listed key. | BB | Detection |
| G22 | `key_policy` is present exactly when the request carries credentials whose key has a policy bound, equals that policy, and passes the order of checks under the reply's own lists. | BB | Detection |
| G23 | Each model in `GET {base}/models` carries `routes`, each with `provider` (S17) and `facts` (S12), and with `evidence` (S18) when the facts include `attest`. A provider id appears at most once among a model's routes. | BB | Facts |
| G24 | An unknown provider id is not an error: in `only` it matches nothing; in `ignore` and `order` it has no effect. | BB | Keys |
| G25 | An own error (bad credentials, an unreadable body, an unknown model id, a rate limit) is answered as without this protocol, before any policy check, with none of `Route-Applied`, `Route-Refused`, `Route-Evidence`. | BB | Result |
| G26 | A request no policy reached is answered with the status it would have without this protocol and carries neither `Route-Refused` nor `Route-Evidence`. | BB | Result |
| G27 | `Route-Evidence` and the `evidence` URI point at the provider's own evidence, which covers the response relayed. The gateway puts no verdict or summary of its own in the header or at the URI. | Op | Result |
| G28 | Each published fact holds for every party its key constrains, as the Keys section defines: everyone who receives the content for `zdr`, `notrain`, `region`; the model server for `bits`, `attest`. | Op | Keys, Facts |
| G29 | A request refusable for more than one reason is refused for the first of `unsupported`, `unsatisfiable`, `unavailable`. | BB | Refusal |
| G30 | The gateway is deployed so that it sees `Route-Policy` field lines as they were received, not joined by a component in front of it. | Op | Carriers |
| G31 | No content reaches any provider for a request answered with an own error. | WB | Result |
| G32 | The published facts are the facts routing uses. | WB | Facts |
| G33 | A relayed response has the status and the body of the route's response. A refusal never carries a provider's body. | WB | Result |
| G34 | A refusal's body is an error in the shape the gateway uses for its own errors on that endpoint. | BB | Refusal |
| G35 | A gateway that tries qualifying routes tries them in order: `order` providers first as listed, then the rest by `sort`, or in the gateway's default order without it. If it tries another after one fails, it is the next in that order. | WB | Keys, Result |
| G36 | A gateway does not bind to a key a policy that fails the order of checks. | WB | Carriers |
| G37 | The provider `Route-Applied` names is the one whose response is relayed. | WB | Result |

## Client (C)

"Strength" is the spec's own keyword for the rule.

| Id  | Strength | Rule | Spec section |
| --- | -------- | ---- | ------------ |
| C1  | MUST NOT | A request carrying a requirement by the model suffix or the header is not sent to a base URL without a valid detection reply from it that lists every key, and every `attest` and `sort` value, used by every policy the request carries on both carriers together, preferences included. Without one the request is not sent and no content leaves the client. | Clients |
| C2  | MAY | A request whose policies contain only preferences may be sent without detection. | Clients |
| C3  | MUST | For a request sent with a requirement, a response with no `Route-Refused` is not honored unless it has exactly one `Route-Applied` value that fits the grammar and, when the policy sent has `attest`, exactly one `Route-Evidence` value that is an evidence URI (S18). A policy that was not honored is not reported as applied. | Clients |
| C4  | SHOULD | The client checks the provider named against the model list it held when it sent the request, and treats the policy as not honored when the provider is not among the routes that list publishes for the model or appears there more than once, when its published facts are invalid or with the provider id do not meet the requirements sent, or when the policy has `attest` and `Route-Evidence` is not the same string as the `evidence` published for that route. A list in which the model is absent, or its `routes` is not a list, publishes no routes for it. | Clients, Facts |
| C5  | MUST | A response that carries `Route-Refused` is treated as a refusal, even when the value cannot be parsed and whatever else the response carries. | Clients |
| C6  | MUST | A detection reply that is not valid, or cannot be fetched, is no detection. Where the reply's object repeats a member name, the last occurrence is the member. In a valid reply, unknown members, keys this revision does not define, and `attest` and `sort` values it does not define are ignored. | Detection |
| C7  | SHOULD NOT | A fact is not presented as verified unless the client verified the evidence itself. | Clients |
| C8  | MUST | A translated request's result is unconfirmed: the policy is not reported as applied. | Clients |
| C9  | MUST NOT | A translated request is not sent unless every requirement maps to something the target documents as a hard filter. Otherwise the request is not sent at all. | Clients |
| C10 | MUST NOT | A client holding a policy applies it together with one typed as a model suffix. With both carriers, its own goes by the header and the suffix stays as typed. With one carrier, it sends the two combined with the suffix as the more specific; if that combination cannot be written as a valid policy the request is not sent, and no weaker policy is sent in its place. | Clients |
| C11 | SHOULD | The client tells its user a refusal's reason, and the key when there is one. | Clients |
| C12 | MUST NOT | Nothing in a `key_policy` the client cannot interpret is relied on. | Detection |
| C13 | SHOULD | A `key_policy` the client cannot interpret is still shown, as text. | Detection |
| C14 | MUST | A detection reply is reused only for the same base URL and credentials. It is discarded when a request sent with a requirement comes back not honored, and a new one is fetched before another requirement is sent there. | Clients |
| C15 | SHOULD NOT | A detection reply is not kept from one run of the client to the next. | Clients |
