# Inference Route Policy

Draft 18.

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
Route-Applied: provider=aurora
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

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are used as
described in RFC 2119 and RFC 8174, and only when they appear in
capitals.

A **gateway** accepts inference requests and forwards each to one of
several endpoints. A **provider** is whoever operates an endpoint, and
has a **provider id** at the gateway. A **route** is one provider
serving one model. A **client** sends requests: a harness, an SDK, a
plugin, or a script. **Content** is the request and response bodies:
prompts, tool definitions, outputs. Token counts, timings, digests, and
a policy carried in the `model` field are not content.

Wherever a JSON object defined here repeats a member name, the last
occurrence is the member. The same holds for the `model` member of an
inference request's body: a gateway that accepts a body repeating it
reads the last.

## Syntax

```
policy := pair ("+" pair)*
pair   := key | key "=" list
key    := [a-z][a-z0-9]{0,15}
list   := item ("," item)*
item   := [a-z0-9][a-z0-9_.-]{0,31}
```

- The alphabet is `a-z`, `0-9`, and `+ = , . _ -`. None of these needs
  escaping inside a JSON, YAML, or TOML string, in an HTTP field value,
  in a URL path segment, or as one word in a POSIX shell. A policy is
  still a string to its container: it is quoted wherever that container
  quotes strings. In a URL query, `+` is percent-encoded.
- There is no whitespace anywhere in a policy.
- A key with no `=` is a flag. A flag states a requirement by being
  present. There is no way to write its absence; leave it out.
- A key appears at most once in a policy, and an item at most once in
  a list.
- Keys and their values are defined only by this document. There are
  no private keys. A later revision may add keys and values, and a
  gateway says which it accepts in [detection](#detection).

**A policy is honored whole or refused whole.** A gateway that is sent
a policy it cannot honor in full MUST refuse the request (see
[Refusal](#refusal)). A requirement added in a later revision therefore
never turns into "no requirement" on an older gateway.

### Order of checks

A gateway checks a policy in this order. The first failure decides the
refusal and whether it names a key:

1. **The whole string.** It is longer than 512 bytes, or has more than
   16 pairs (more than 15 `+`). No key is named.
2. **Each pair, in the order written.** A pair fails when it does not
   fit the grammar, its list has more than 16 items or a repeated item,
   its key repeats an earlier pair's, the gateway does not accept its
   key, or the gateway does not accept its value. The first pair that
   fails is the offending pair. Its key is named when the key itself
   fits the `key` grammar, and not otherwise.

## Carriers

The same string travels three ways.

**Model suffix.** The policy follows the model id, joined by `+`:

```
model := id "+" policy
id    := one or more characters, none of them "+"
```

A `model` field that contains `+` is always read this way: the gateway
splits it at its first `+`, resolves the id as it would have without
the suffix, and applies the rest as a policy. An empty id names no
model, and the gateway answers as it does for any unknown model id
(see [Result](#result)). This carrier works in any
harness that lets the user type a model id, which is why it exists. A
gateway SHOULD list the suffixed ids it expects to be popular in its
model list, so they appear in pickers with their metadata. Such an
entry is an alias for display: the model's own entry is the one whose
`id` has no suffix.

**Header.** `Route-Policy: <policy>` on the inference request. It is
independent of the API surface and of the request body schema. A
request with more than one `Route-Policy` field line is refused as
`unsupported`, with no key named. A gateway MUST be deployed so that
it sees these field lines as they were received: a component in front
of it that joins repeated lines into one value would hide the
repetition.

**Key default.** A gateway MAY bind a policy to an API key, which is
what an account setting in a web console is. It MUST NOT bind a policy
that fails the [order of checks](#order-of-checks). Whether any route
meets a bound policy is decided for each request, like any other
policy. [Detection](#detection) reports the bound policy to the holder
of the key.

When more than one reaches a request, all of them apply; see
[Combining](#combining). The gateway checks the header first and the
suffix second, each on its own; the first that fails decides the
refusal.

A gateway MUST remove the suffix and the header before forwarding the
request to a provider. The provider receives a body whose top-level
object has exactly one `model` member, holding the model id the gateway
would have sent without a policy, and no `Route-Policy` header. A
`model` member anywhere else in the body is the caller's data and is
forwarded as it came.

## Keys

A gateway accepts a pair when it lists the pair's key in
[detection](#detection) and the value is valid for that key as the
tables below say. Anything else is a key or a value it does not accept.

Requirements decide which routes qualify. There are three kinds, and
they differ in whom they constrain.

**On everyone who receives the content**: the gateway itself, the
route's provider, and any party behind either. The gateway receives
the content of every request, including one it then refuses, before it
knows which route would serve it. So a gateway that publishes one of
these facts for any route MUST itself meet it for every request it
receives, served or refused.

| Key       | Valid value | A route qualifies when |
| --------- | ----------- | ---------------------- |
| `zdr`     | flag | None of them keeps any content after the response ends. Retention for abuse review counts as retention. |
| `notrain` | flag | None of them uses the content to train or tune a model. |
| `region`  | list of officially assigned ISO 3166-1 alpha-2 codes, lowercase | All of them process the content only in listed countries. A route that does not publish where content is processed does not qualify. |

**On the model server**, the machine that runs the weights.

| Key      | Valid value | A route qualifies when |
| -------- | ----------- | ---------------------- |
| `bits`   | one integer, `1` to `64`, no leading zero | Every weight of the model is stored, as served, at this many bits or more. A route publishes the lowest precision among its weights, rounded down to an integer, so a model that mixes 4-bit and 12-bit weights publishes `bits=4`. A route that does not publish its precision does not qualify. |
| `attest` | list drawn from `weights`, `prompt`, each also listed in detection | The model server can produce, for this request, evidence rooted in hardware that the client can verify without trusting the gateway. `weights`: a digest of the weights that served it. `prompt`: digests of the request as the model server received it and of the response as it produced it, bound to the same environment. |

**On the route's provider id**, and on nothing else. These select
routes by name and say nothing about other parties.

| Key      | Valid value | A route qualifies when |
| -------- | ----------- | ---------------------- |
| `only`   | list of provider ids | Its provider id is listed. |
| `ignore` | list of provider ids | Its provider id is not listed. |

Preferences order the routes that qualify. They never make a route
qualify or disqualify it.

| Key     | Valid value | Meaning |
| ------- | ----------- | ------- |
| `sort`  | one of `price`, `latency`, `throughput`, also listed in detection | `price`: lowest expected charge for this request. `latency`: shortest time to the first output token. `throughput`: most output tokens per second. How a gateway measures these is its own business. Absent means the gateway's default order. |
| `order` | list of provider ids | Try these first, in this order, then the rest by `sort`. |

A value of the wrong shape for its key is not valid: a list where a
flag is defined, a flag where a list is defined, two items where one is
defined, an integer out of range, a two-letter code that ISO 3166-1 has
not officially assigned (`eu` and `uk` are not).

Every provider id a gateway publishes or reports is an `item`. Provider
ids are the gateway's own and are not portable between gateways. An id
the gateway does not know is valid and is not an error: in `only` it
matches no route, and in `ignore` and `order` it has no effect.

Choosing between models is out of scope. A policy picks among routes of
the model the request names.

## Facts

A gateway that supports this protocol publishes, for each route in its
model list, the requirements that route meets, in the same grammar:

```json
{ "id": "example-model",
  "routes": [
    { "provider": "aurora", "facts": "zdr+notrain+bits=8+region=us" },
    { "provider": "basalt", "facts": "bits=16+region=us,de+attest=weights,prompt",
      "evidence": "https://basalt.example/attestation" },
    { "provider": "cobalt", "facts": "" }
  ] }
```

The response to `GET {base}/models` is a JSON object whose `data`
member is the list of model objects. Each has an `id`, which appears at
most once in the list, and `routes`, among which a provider id appears
at most once.

A reader looks for the model by its id with no suffix, and only at the
entries of `data` that are objects with that `id`; whatever else the
list holds does not concern it. The list publishes no routes for the
model when `data` is not a list, when no entry or more than one has
that `id`, or when that entry's `routes` is not a list.

A gateway MUST publish facts that:

- use only `zdr`, `notrain`, `bits`, `region`, and `attest`, each with
  a value valid for that key (for `attest`, any of `weights` and
  `prompt`), or are the empty string for a route that publishes none of
  the five;
- hold for every party that key constrains, as [Keys](#keys) defines
  it, including every party behind the route where the key constrains
  them. A gateway behind a route is a provider like any other;
- are the facts its routing uses.

A fact is a property of the route. Which facts a gateway publishes does
not depend on which keys or values it accepts in requests.

A route whose facts include `attest` MUST also carry `evidence`: the URI
of the provider's own evidence for that route (see [Result](#result)).
An evidence URI has this form and is at most 512 bytes:

```
evidence := "https://" host (":" port)? ("/" rest)?
host     := label ("." label)*
label    := [a-z0-9] | [a-z0-9] [a-z0-9-]{0,61} [a-z0-9]
port     := an integer from 1 to 65535, no leading zero
rest     := [A-Za-z0-9._~/?=&-]*
```

The last label of the host is not all digits, which keeps
dotted-decimal addresses out. The grammar is lexical: it says which
strings are evidence URIs, not how any URL library would resolve one.
It is a narrow subset of `https` URIs, chosen so that a reader can
check one exactly and compare two as strings. Two evidence URIs are the
same only when they are the same string.

A route meets a policy when all of these hold:

- each of `zdr` and `notrain` that the policy has is in the route's
  facts;
- if the policy has `bits`, the route has `bits` and it is at least the
  policy's;
- if the policy has `region`, the route has `region` and every country
  in the route's is in the policy's;
- every item in the policy's `attest` is in the route's;
- its provider id is in the policy's `only`, if there is one, and not
  in its `ignore`.

A fact that is absent is not met.

A reader of facts, such as a client, reads them by the same grammar and
limits, with two allowances for a gateway on a later revision: it MUST
ignore a well-formed key it does not know, and an `attest` item it does
not know. Neither can be something it required. Facts are **invalid**
when they do not fit the grammar or limits, when `zdr`, `notrain`,
`bits`, or `region` has a value that is not valid for it, when `attest`
is a flag instead of a list, or when they contain `only`, `ignore`,
`sort`, or `order`. A reader MUST
treat a route with invalid facts as meeting no policy that has a
requirement, `only` and `ignore` included.

Facts let a client show which choices exist before sending anything,
and tell what the provider named in `Route-Applied` meets. Prices and
measured speed are not facts and are not defined here.

## Result

A gateway relays a route's response, or it answers itself. A route
**fails** when the gateway decides, before it has committed the status
and headers of its final response to the client, not to relay that
route's response: on a connection error, a timeout, or a status the
gateway treats as retryable. Which conditions count is the gateway's
choice. The final response is committed with its status line in
HTTP/1.1 and with its header block in HTTP/2 and HTTP/3; an
informational (1xx) response is not the final response. When a route
fails, the gateway MAY try another qualifying route; when it does, it
takes the next in the order the policy's preferences give. Once it has
committed its final response it MUST NOT move the request to another
route. How many qualifying routes a gateway tries, including none, is
its choice.

Every request ends in exactly one of these outcomes. They are listed in
the order a gateway decides them:

| Outcome | Status | `Route-Applied` | `Route-Refused` | `Route-Evidence` |
| ------- | ------ | --------------- | --------------- | ---------------- |
| **Own error.** The gateway answers with an error it would give the same request with no policy: bad credentials, an unreadable body, an unknown model id, a rate limit. | As without this protocol | MUST NOT | MUST NOT | MUST NOT |
| **No policy** reached the request, by any carrier. | As without this protocol | MAY | MUST NOT | MUST NOT |
| **Refused before routing.** A policy reached it and is `unsupported`, or no route meets it. | 400 | MUST NOT | MUST: `unsupported` or `unsatisfiable` | MUST NOT |
| **Unavailable.** A policy reached it, routes qualify, and the gateway relays none of their responses: every one it tried failed, or it tried none. | 503 | MUST NOT | MUST: `unavailable` | MUST NOT |
| **Relayed.** A policy reached it and a qualifying route's response is relayed. | The route's, with the route's body | MUST, naming that route | MUST NOT | MUST if the combined policy has `attest`, else MUST NOT |

An own error comes first: a gateway does not check a policy on a
request it would reject anyway, and no content is sent. Every rule in
this document about refusing a policy applies to requests that pass
those checks. A relayed response is never rewritten as a refusal, and a
refusal never carries a provider's body.

```
applied := "provider=" item
```

```
Route-Applied: provider=aurora
```

`Route-Applied` names the provider id of the route whose response is
relayed, and nothing else. What that route meets is in its published
[facts](#facts). The value holds no comma, so two field lines joined
into one value never read as one valid value.

`Route-Evidence: <URI>` is the `evidence` URI published for that route,
the same string: where the provider serves its own attestation evidence
covering this response. The document's format and how to verify it are
defined by the provider's attestation scheme, not here. The gateway
MUST NOT put a verdict or summary of its own at that URI or in the
header; it points at the provider's evidence and nothing else. Because
an evidence URI has no comma and no whitespace, two joined lines never
read as one.

A gateway MUST NOT pass a `Route-Applied`, `Route-Refused`, or
`Route-Evidence` header it received from a provider through to the
client. These headers are the gateway's own, always, and it sends at
most one field line of each.

## Refusal

A gateway MUST NOT serve a request outside its policy. It refuses with:

```
refused := "reason=" reason ("+key=" key)?
reason  := "unsupported" | "unsatisfiable" | "unavailable"
```

```
Route-Refused: reason=unsupported+key=bits
```

| `reason`        | Status | Meaning |
| --------------- | ------ | ------- |
| `unsupported`   | 400 | The request has more than one `Route-Policy` line, or a policy that reached it failed the [order of checks](#order-of-checks). `key` is present exactly when that order names one. |
| `unsatisfiable` | 400 | No route of this model meets the combined policy. Retrying does not help. `key` is never present. |
| `unavailable`   | 503 | Routes meet the combined policy, and the gateway relays none of their responses: every one it tried failed, or it tried none. The gateway MUST NOT fall back to one that does not meet it. `key` is never present. |

A request that could be refused for more than one reason is refused for
the first in the order above.

An `unsupported` or `unsatisfiable` request is refused before any
content is sent to any provider. An `unavailable` request has sent
content only to routes that meet the combined policy.

The response body is an error in the shape the gateway uses for its own
errors on that endpoint.

## Detection

```
GET {base}/route-policy
```

```json
{ "route_policy": "1",
  "keys": ["zdr", "notrain", "bits", "region", "attest", "only", "ignore", "sort", "order"],
  "attest": ["weights", "prompt"],
  "sort": ["price", "latency", "throughput"],
  "key_policy": "zdr+region=us" }
```

`{base}` is the API base URL the client already has, the one it
appends `/models` to. A path such as `/route-policy` or `/models` is
appended to the base URL's path, and a query the base URL has is kept
on every endpoint: under `https://gateway.example/v1?tenant=east`,
detection is `https://gateway.example/v1/route-policy?tenant=east`.
Trailing `/` characters are removed from the base URL's path before a
path is appended. The query is kept exactly as given, an empty one (a
bare `?`) included. Two base URLs that differ in their query are
different base URLs, and an empty query is not the same as none. Two
spellings that RFC 3986 defines as equivalent, differing only in the
case of the scheme or host, a default port, or dot segments, are one
base URL. A client whose URL handling would send a base URL's path or
query other than as written, for example by percent-encoding a
character, has no detection for the base URL as written, and so sends
no requirement to it.
Detection does not require credentials. The reply
has status `200` and a JSON object as its body:

- `route_policy` is the string `"1"`. It is a string so that no JSON
  decoder can round another number to it.
- `keys` lists every key the gateway accepts. Each entry fits the `key`
  grammar. Absent means exactly the nine above.
- `attest` and `sort` list the values the gateway accepts for those two
  keys. Each entry fits the `item` grammar. Absent means exactly the
  lists above.
- Those three default lists are fixed and do not grow in later
  revisions, so a client that wants something newer checks for it and
  falls back.
- `key_policy` is present exactly when the request carries credentials
  whose key has a policy bound to it, and is that policy. It passes the
  order of checks under the reply's own lists.

For `bits`, `region`, `only`, `ignore`, and `order`, listing the key
means accepting every value that is valid for it; there is no list of
values to check.

A gateway MUST refuse, as `unsupported`, any key it did not list and
any `attest` or `sort` value it did not list.

A reply is **valid** to a client when all of these hold, each of which
the client can see: its status is `200`; its body is a JSON object;
`route_policy` is the string `"1"`; `keys`, `attest`, and `sort`, where
present, are lists whose entries fit the grammar named above; and
`key_policy`, where present, answers a request that carried credentials
and passes the order of checks under the reply's lists exactly as
given. A client counts a request as carrying credentials when it has a
header the client knows to carry one, such as `Authorization`, an
API-key header, or `Cookie`; a header it cannot tell about counts as
none. Whether the reply tells the truth, for instance by omitting a
policy that is bound to the key, is the gateway's obligation and no
part of validity. A client MUST treat anything else, including a
reply it cannot fetch, as no detection. Within a valid reply a client
MUST ignore members it does not know, keys this revision does not
define, and `attest` and `sort` values this revision does not define.
A `key_policy` may therefore use a key or value from a later revision
that the reply lists. A client that cannot interpret it MUST NOT rely
on anything in it, and SHOULD still show it, as text.

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

No request can remove or weaken a requirement its key carries.

A gateway combines the policies it parsed. The combined policy is a
decision, not a string: it need not fit the [limits](#limits) or the
grammar, and a gateway never has to write it down.

## Clients

**Before sending.** A client MUST NOT send a request that carries a
requirement by a carrier of this protocol (the model suffix or the
header) to a base URL unless it holds a valid [detection](#detection)
reply from that base URL. The reply has to list every key, and every
`attest` and `sort` value, used by every policy the request carries,
on both carriers together, preferences included. Without such a reply
it does not send the request: no content leaves the client. A request
whose policies contain only preferences MAY be sent without detection.

Detection says what a gateway accepts, not what its routes meet. A
client that holds the model list SHOULD NOT send a request when no one
route that list publishes for the model meets all of its requirements:
the gateway would refuse it as `unsatisfiable`, having received the
content. The requirements here are those of the policies the request
carries, combined with the key's bound policy when detection reported
one the client can interpret; a bound policy it cannot interpret plays
no part. A route meets an `attest` requirement for this purpose only
when it also publishes a valid `evidence` URI, since without one the
client could not confirm the result.

A detection reply and a model list each belong to the base URL and
credentials they were fetched with. A client MAY reuse them for later
requests to that base URL with those credentials, and MUST NOT use
either for any other base URL or credentials. It MUST discard the
detection reply when a request it sent with a requirement comes back
not honored, and fetch a new one before it sends another requirement
there. It SHOULD NOT keep either from one run of the client to the
next.

**Holding a policy.** A client that holds a policy of its own, and
finds another typed into the model id as a suffix, applies both. Where
it can use both carriers, it sends its own by the header and leaves the
suffix as typed. Where it can use only one carrier, it combines the two
as [Combining](#combining) says, with the typed suffix as the more
specific, and sends the result; if that result cannot be written as a
valid policy, because an intersection is empty or a limit is exceeded,
it MUST NOT send the request and MUST NOT send a weaker policy in its
place.

**Reading the result.** A client MUST treat a response that carries
`Route-Refused` as a refusal, even when it cannot parse the value and
whatever else the response carries. It SHOULD tell its user the reason,
and the key when there is one.

For a request it sent with a requirement, a client MUST treat the
policy as **not honored** when the response has no `Route-Refused` and
any of these holds:

- the policies it sent combine to one that no route can meet, because
  a `region` or `only` intersection is empty;
- the provider `Route-Applied` names is not in the `only` it sent, or
  is in the `ignore` it sent. This needs no model list;
- it does not have exactly one `Route-Applied` value that fits the
  `applied` grammar. A joined repetition does not fit, so a client that
  sees only joined values applies the same test;
- the policy it sent has `attest`, and the response does not have
  exactly one `Route-Evidence` value that is an evidence URI as
  [Facts](#facts) defines one.

A client MUST NOT report a policy that was not honored as applied, to
its user or to code that asks.

A client SHOULD also check the provider named against the model list
it held when it sent the request, and treat the policy as not honored
when any of these holds:

- the provider is not among the routes that list publishes for the
  model, or appears there more than once;
- the facts published for that route are invalid, or with the provider
  id do not meet the requirements it sent;
- the policy it sent has `attest`, and `Route-Evidence` is not the same
  string as the `evidence` published for that route.

A client that held no model list cannot make this check; one that held
a list which publishes no routes for the model has made it, and the
provider is not among them.

Honored means the gateway named a route and, for `attest`, said where
its evidence is. It does not mean anyone verified that evidence, and
without the check above it does not mean the route's published facts
were compared with the policy.

**Claims.** A client SHOULD NOT present a fact as verified unless it
verified the evidence for it itself.

**Translation.** A client MAY serve a gateway that has not adopted this
protocol by translating a policy into that gateway's own request
fields. Translation uses no carrier of this protocol, so the rule
under "Before sending" does not apply to it; these two do instead. The
client MUST NOT send a translated request unless every requirement in
the policy maps to something the target documents as a hard filter;
otherwise it does not send the request at all. And it MUST treat the
result as **unconfirmed**: it MUST NOT report the policy as applied.

## Security

- **Facts are claims.** `zdr`, `notrain`, `bits`, and `region` are what
  the gateway says about a route, on whatever basis it has. Only
  `attest` items can be checked without trusting the gateway, and only
  by a client that verifies the evidence itself.
- **Never fail open.** Refusal is the only permitted response to a
  policy that cannot be met. This is why unknown keys refuse rather
  than being ignored.
- **Do not leak the policy.** The header and suffix are removed before
  the request leaves the gateway, so a provider cannot treat requests
  with requirements differently from the rest.
- **Chains.** A gateway behind a route is a provider like any other: it
  receives no policy from this request, and the facts published for
  that route already cover it and everything behind it. A gateway that
  wants a downstream gateway to apply a policy binds one to its key
  there.
- **Result headers come from the gateway.** A provider that returns
  `Route-Applied` cannot speak for the gateway, because the gateway
  drops it.
- `Route-Applied` carries a provider id. `Route-Refused` carries a
  reason and at most one key: up to 16 characters of `a-z` and `0-9`
  that the gateway found where a key belongs in a policy, which the
  client may have written in the header or in the `model` field. Neither
  header carries anything from the content.

## Limits

| Item | Limit |
| ---- | ----- |
| Whole policy string | 512 bytes |
| Pairs | 16 |
| Items in one list | 16 |
| Key | 16 bytes |
| Item | 32 bytes |

These apply to a policy on a carrier, to a key default, and to a facts
string. The limits are the same at every gateway.

## Adoption

Each step adds to the one before.

1. **No harness change.** The user picks or types a suffixed model id.
   A harness that knows nothing of this protocol sends the request as
   typed, without [detection](#detection). That is safe for a suffix
   holding only preferences. For a suffix holding a requirement it is
   safe only once someone has checked detection for that base URL and
   key: the user by hand, or a plugin. Otherwise a gateway that does
   not implement this protocol may already have the content by the time
   it answers.
2. **Static header.** The harness sends `Route-Policy` from its
   provider configuration, under the same condition.
3. **Policy picker.** The harness, or a plugin, runs detection before
   it sends a requirement, reads facts, offers the choices that exist
   for the selected model, shows the key's own policy as locked, and
   displays `Route-Applied`. From this step on the client rules are
   met.
4. **Verification.** The harness fetches `Route-Evidence` and verifies
   it.

Steps 3 and 4 do not need the harness's maintainers. A plugin can do
them wherever the harness lets one rewrite the outgoing request and
read response headers. A harness's response hook may skip error
responses, which is where refusals arrive; a plugin then reads
`Route-Refused` where the harness's HTTP client exposes it. A plugin
can also serve gateways that have not
adopted this protocol, by [translation](#clients).

## Relationship to existing dialects

| Existing | Here |
| -------- | ---- |
| [OpenRouter](https://openrouter.ai/docs/features/provider-routing) `provider.only`, `ignore`, `order`, `sort` | `only`, `ignore`, `order`, `sort` |
| OpenRouter `provider.zdr` | Not `zdr`: it admits endpoints that keep prompts for abuse review, which `zdr` counts as retention. |
| OpenRouter `provider.data_collection: "deny"` | Not `notrain` or `zdr`: it filters the model providers, and says nothing of what the gateway itself does with content. |
| OpenRouter `provider.quantizations` | Near `bits`, but a list of named levels, not a floor on every weight as served. |
| OpenRouter `provider.allow_fallbacks: false` with `order` | `only` with `order` |
| OpenRouter `:nitro`, `:floor` | In part `+sort=throughput`, `+sort=price`. Each shortcut also changes which service tiers are eligible, which no key here does. |
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
   nonce the client chose before the request. Publishing `evidence`
   with the route lets a client fetch it first, but this document does
   not yet say how a nonce reaches the provider.
3. **Price ceilings.** A cap needs an agreed unit across input, cached
   input, and output.
4. **`+` in harness parsers.** No model id in OpenRouter's public list
   uses `+`, but harnesses that split model strings have not been
   surveyed.
5. **Choosing a model.** "The best model that meets this policy" is a
   different protocol.
6. **Private requirements.** A gateway's own controls, such as a
   provider tier, have no key here. Letting a gateway define keys needs
   rules for how their values are checked, matched, and combined that
   every client and gateway would apply the same way.
