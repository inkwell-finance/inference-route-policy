# Inference Route Policy

Draft 1.

One short string that lets a client tell an inference gateway which
endpoints may serve a request and how to choose among them: no data
retention, no training, minimum weight precision, where it runs, what
it can prove, and whether to favor price, latency, or throughput.

The string says what the client needs. It does not say how a gateway
routes, and it contains no gateway-specific terms.

```
# In a model picker, with no change to the harness:
example-model+zdr+sort=price

# As a header, for any model:
Route-Policy: zdr+notrain+bits=8+region=us,de+sort=latency

# What came back:
Route-Applied: provider=aurora+zdr+notrain+bits=8+region=us
```

## Motivation

One model id is served by many endpoints that differ in price, speed,
weight precision, retention terms, location, and whether they can prove
any of it. A client that cares has to say so, and today it cannot:

- The request has one field for this, `model`, and it names a model,
  not an endpoint.
- Each gateway has its own way to say more: a body object, an SDK
  option, a model suffix, a header, an account setting in a web
  console. A harness that wanted to offer the choice would need one
  adapter per gateway, so harnesses offer none and users set it in a
  browser.
- A setting made in a web console is invisible to the client. It cannot
  show it, check it, or tell whether a given response honored it.
- Options a gateway does not understand are ignored. A retention
  requirement that is silently dropped is worse than an error.

With this protocol the client states the policy in the request, the
gateway honors it whole or refuses, and the response says what served
it.

## Conventions

The key words MUST, MUST NOT, SHOULD, and MAY are used as described in
RFC 2119 and RFC 8174, and only when they appear in capitals.

A **gateway** accepts inference requests and forwards each to one of
several endpoints. A **provider** is whoever operates an endpoint. A
**route** is one provider serving one model. A **client** sends
requests: a harness, an SDK, a plugin, or a script. **Content** is the
request and response bodies: prompts, tool definitions, outputs. Token
counts, timings, and digests are not content.

## Syntax

```
policy := pair ("+" pair)*
pair   := key | key "=" list
key    := name | name "." name
name   := [a-z][a-z0-9]{0,15}
list   := item ("," item)*
item   := [a-z0-9][a-z0-9_.-]{0,31}
```

- Every character is safe unquoted in JSON, YAML, TOML, HTTP header
  values, URL path segments, and the common shells. Nothing needs
  escaping, in any carrier. There is no whitespace anywhere in a
  policy.
- A key with no `=` is a flag. A flag states a requirement by being
  present. There is no way to write its absence; leave it out.
- A key with a dot is a vendor extension, such as `acme.tier=2`. The
  part before the dot names the vendor. Keys without a dot are defined
  only by this document.
- A key appears at most once in a policy, and an item at most once in
  a list.
- **A policy is honored whole or refused whole.** A gateway that meets
  a key it does not accept, a value it does not accept, a repeated key
  or item, a string over a [limit](#limits), or anything outside this
  grammar MUST refuse the request (see [Refusal](#refusal)). A
  requirement added in a later revision therefore never turns into "no
  requirement" on an older gateway.

## Carriers

The same string travels three ways.

**Model suffix.** The policy follows the model id, joined by `+`:

```
model := id "+" policy
```

The gateway splits the `model` field at its first `+`, resolves the id
as it would have without the suffix, and applies the rest as a policy.
A `model` field with a `+` and nothing valid after it is refused like
any other malformed policy. This carrier works in any harness that lets
the user type a model id, which is why it exists. A gateway SHOULD list
the suffixed ids it expects to be popular in its model list, so they
appear in pickers with their metadata.

**Header.** `Route-Policy: <policy>` on the inference request. It is
independent of the API surface and of the request body schema. A
request with more than one `Route-Policy` header is refused as
malformed.

**Key default.** A gateway MAY bind a policy to an API key, which is
what an account setting in a web console is. [Detection](#detection)
reports it to the holder of the key.

When more than one reaches a request, all of them apply; see
[Combining](#combining).

A gateway MUST remove the suffix and the header before forwarding the
request to a provider. The provider receives the model id the gateway
would have sent without a policy, and no `Route-Policy` header.

## Keys

Requirements decide which routes qualify. A route qualifies when every
requirement holds for **every party that receives the content**,
including the gateway itself and any further gateway behind it.

| Key       | Value | A route qualifies when |
| --------- | ----- | ---------------------- |
| `zdr`     | flag | No party keeps any content after the response ends. Retention for abuse review counts as retention. |
| `notrain` | flag | No party uses the content to train or tune a model. |
| `bits`    | one integer, `1` to `64`, no leading zero | The weights are served at this many bits per parameter or more. A route that does not publish its precision does not qualify. |
| `region`  | list of ISO 3166-1 alpha-2 codes, lowercase | Content is processed only in listed countries. A route that does not publish where it processes content does not qualify. |
| `attest`  | list of `weights`, `prompt` | The route can produce, for this request, evidence rooted in hardware that the client can verify without trusting the gateway. `weights`: a digest of the weights that served it. `prompt`: digests of the request as the model server received it and of the response as it produced it, bound to the same environment. |
| `only`    | list of provider ids | Its provider is listed. |
| `ignore`  | list of provider ids | Its provider is not listed. |

Preferences order the routes that qualify. They never make a route
qualify or disqualify it.

| Key     | Value | Meaning |
| ------- | ----- | ------- |
| `sort`  | one of `price`, `latency`, `throughput` | `price`: lowest expected charge for this request. `latency`: shortest time to the first output token. `throughput`: most output tokens per second. How a gateway measures these is its own business. Absent means the gateway's default order. |
| `order` | list of provider ids | Try these first, in this order, then the rest by `sort`. |

A value of the wrong shape for its key (a list where a flag is defined,
a flag where a value is defined, two values where one is defined, an
integer out of range) is a value the gateway does not accept.

Provider ids are the gateway's own and are published in its model list.
They are not portable between gateways. An id the gateway does not know
is not an error: in `only` it matches no route, and in `ignore` and
`order` it has no effect.

A vendor key is accepted only by a gateway that defines it. Every other
gateway refuses it.

Choosing between models is out of scope. A policy picks among routes of
the model the request names.

## Facts

A gateway that supports this protocol publishes, for each route in its
model list, the requirements that route meets, in the same grammar:

```json
{ "id": "example-model",
  "routes": [
    { "provider": "aurora", "facts": "zdr+notrain+bits=8+region=us" },
    { "provider": "basalt", "facts": "bits=16+region=us,de+attest=weights,prompt" },
    { "provider": "cobalt", "facts": "" }
  ] }
```

`routes` is a member of each model object in the response to
`GET {base}/models`. `facts` uses the policy grammar, restricted to
`zdr`, `notrain`, `bits`, `region`, `attest`, and vendor keys, and it
MAY be the empty string for a route that meets nothing.

A route meets a policy when all of these hold:

- each flag in the policy is in its facts;
- if the policy has `bits`, the route has `bits` and it is at least the
  policy's;
- if the policy has `region`, the route has `region` and every country
  in it is in the policy's;
- every item in the policy's `attest` is in the route's;
- its provider is in the policy's `only`, if there is one, and not in
  its `ignore`.

A fact that is absent is not met. A client MUST ignore fact keys it
does not know: a fact it does not know cannot be one it required.

Facts let a client show which choices exist before sending anything.
Prices and measured speed are not facts and are not defined here.

## Result

A gateway that supports this protocol MUST add `Route-Applied` to every
response that a route produced for a request a policy reached, by any
carrier:

```
Route-Applied: provider=aurora+zdr+notrain+bits=8+region=us
```

It is `provider=<id>` followed by that route's facts, joined by `+`
when the facts are not empty. It MUST be final before the first byte of
the body. A gateway MAY try another qualifying route when one fails
before that point, and MUST NOT move a request to another route after
it.

When `attest` was required, the gateway MUST also send
`Route-Evidence: <URI>`, where the evidence for this response can be
fetched. The document's format and how to verify it are defined by the
provider's attestation scheme, not here. The gateway passes evidence
through and MUST NOT summarize it as a verdict.

A gateway MUST NOT pass a `Route-Applied`, `Route-Refused`, or
`Route-Evidence` header it received from a provider through to the
client as its own, except as [Chains](#security) allows.

A client that sent requirements and receives a response with no
`Route-Applied` MUST treat the policy as not honored. A client SHOULD
check that the reported provider and facts meet the requirements it
sent, and treat a mismatch the same way.

## Refusal

A gateway MUST NOT serve a request outside its policy. It refuses with:

```
Route-Refused: reason=unsupported+key=bits
```

| `reason`        | Status | Meaning |
| --------------- | ------ | ------- |
| `unsupported`   | 400 | The policy is malformed, over a [limit](#limits), or has a key or value the gateway does not accept. `key` names the first such key when the offending pair has a well-formed one, and is absent otherwise. |
| `unsatisfiable` | 400 | No route of this model meets the policy. Retrying does not help. |
| `unavailable`   | 503 | Routes meet the policy, but none can serve right now. The gateway MUST NOT fall back to one that does not. |

An `unsupported` or `unsatisfiable` request is refused before any
content is sent to any provider. An `unavailable` request has sent
content only to routes that meet the policy.

The response body is whatever error shape the API surface normally
uses. A refused response has no `Route-Applied`.

## Detection

```
GET {base}/route-policy
```

```json
{ "route_policy": 1,
  "keys": ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "sort", "order"],
  "attest": ["weights", "prompt"],
  "sort": ["price", "latency", "throughput"],
  "key_policy": "zdr+region=us" }
```

`{base}` is the API base URL the client already has, the one it
appends `/models` to. The reply is `200` with a JSON object in which
`route_policy` is the integer `1`.

- `keys` lists the keys the gateway accepts, vendor keys included. A
  reply without `keys` means exactly the nine above.
- `attest` and `sort` list the values the gateway accepts for those
  keys. A reply without them means exactly the lists above.
- Those three default lists are fixed and do not grow in later
  revisions, so a client that wants something newer checks for it and
  falls back.
- `key_policy` appears only when the request carries credentials whose
  key has a policy bound to it, and is that policy.
- Clients MUST ignore members they do not understand.

Detection does not require credentials. A gateway MUST refuse, as
`unsupported`, any key or value it did not list.

A gateway that does not implement this protocol ignores the header and
may resolve a suffixed model id in ways this document cannot predict.
So:

- A client MUST NOT send a policy that contains a requirement to a base
  URL unless it has received a valid detection reply from that base URL
  listing every key and value the policy uses.
- A client MAY send a policy that contains only preferences without
  detection.

## Combining

When a key default, a header, and a model suffix all reach a request,
requirements accumulate and can only narrow:

| Key | Combined as |
| --- | ----------- |
| `zdr`, `notrain` | Present if present in any. |
| `bits` | The highest. |
| `region`, `only` | The intersection of those present. An empty intersection is `unsatisfiable`. |
| `attest`, `ignore` | The union. |
| `sort`, `order` | The most specific wins: suffix, then header, then key default. |
| vendor keys | As the vendor defines. Without a defined rule, the same vendor key arriving by two carriers with different values is `unsupported`. |

No request can remove a requirement its key carries. Each carrier's
policy is parsed and checked on its own first; if any is refused, the
request is refused.

## Security

- **Facts are claims.** `zdr`, `notrain`, `bits`, and `region` are what
  the gateway says about a route, on whatever basis it has. Only
  `attest` items can be checked without trusting the gateway, and only
  by a client that verifies the evidence itself. A client SHOULD NOT
  present an unverified fact as verified.
- **Never fail open.** Refusal is the only permitted response to a
  policy that cannot be met. This is why unknown keys refuse rather
  than being ignored.
- **Do not leak the policy.** The header and suffix are removed before
  the request leaves the gateway, so a provider cannot treat requests
  with requirements differently from the rest.
- **Chains.** A gateway that forwards to another gateway either passes
  the requirements on in this protocol and checks the `Route-Applied`
  it gets back, or treats that route as meeting none of them.
- **Result headers come from the gateway.** A provider that returns
  `Route-Applied` must not be able to speak for the gateway.
- `Route-Applied` and `Route-Refused` carry provider ids and keys from
  this document, nothing from the content and nothing secret.

## Limits

| Item | Limit |
| ---- | ----- |
| Whole policy string | 512 bytes |
| Pairs | 16 |
| Items in one list | 16 |
| Key | 16 bytes, or 33 with a vendor prefix |
| Item | 32 bytes |

A policy over a limit is refused as `unsupported`. Gateways MAY choose
lower limits.

## Adoption

Each step is useful alone.

1. **No harness change.** The user picks or types a suffixed model id.
2. **Static header.** The harness sends `Route-Policy` from its
   provider configuration.
3. **Policy picker.** The harness reads detection and facts, offers the
   choices that exist for the selected model, shows the key's own
   policy as locked, and displays `Route-Applied`.
4. **Verification.** The harness fetches `Route-Evidence` and verifies
   it.

Steps 2 to 4 do not need the harness's maintainers. A plugin can do
them wherever the harness lets one rewrite the outgoing request and
read response headers.

A plugin can also serve gateways that have not adopted this protocol,
by translating the policy into that gateway's own request fields. A
translated policy has no `Route-Applied`, so the plugin MUST show it as
unconfirmed, and MUST refuse to send a requirement the target dialect
cannot express as a hard filter. Translation is the one case in which a
client sends requirements without a detection reply: the plugin stands
in for it with its own knowledge of the target dialect.

## Relationship to existing dialects

| Existing | Here |
| -------- | ---- |
| [OpenRouter](https://openrouter.ai/docs/features/provider-routing) `provider.only`, `ignore`, `order`, `zdr`, `sort` | `only`, `ignore`, `order`, `zdr`, `sort` |
| OpenRouter `provider.data_collection: "deny"` | `notrain`, and `zdr` where retention is meant |
| OpenRouter `provider.quantizations` | `bits`, as a floor instead of a vocabulary |
| OpenRouter `provider.allow_fallbacks: false` with `order` | `only` with `order` |
| OpenRouter `:nitro`, `:floor` | `+sort=throughput`, `+sort=price` |
| OpenRouter regional hostnames | `region` |
| [Vercel AI Gateway](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options) `providerOptions.gateway.only`, `order`, `sort: cost \| ttft \| tps` | `only`, `order`, `sort=price \| latency \| throughput` |
| Body fields in general | Tied to one API surface's schema and unreachable from a harness that does not know them. A gateway MAY keep its own and map them here. |
| HTTP `Prefer` (RFC 7240) | A server may ignore `Prefer`. That is right for `sort` and wrong for requirements. |

## Open questions

1. **Basis of a fact.** `zdr` from a provider's web page, from a signed
   contract with the gateway, and from an attested environment are not
   the same. A value (`zdr=contract`, `zdr=attested`) would let a
   client require a floor. The whole-or-refused rule makes adding it
   later safe.
2. **Evidence freshness.** Attestation that proves anything needs a
   nonce the client chose before the request. `Route-Evidence` as
   drafted is only a pointer after the fact.
3. **Price ceilings.** A cap needs an agreed unit across input, cached
   input, and output.
4. **`+` in harness parsers.** No model id in OpenRouter's public list
   uses `+`, but harnesses that split model strings have not been
   surveyed.
5. **Choosing a model.** "The best model that meets this policy" is a
   different protocol.
