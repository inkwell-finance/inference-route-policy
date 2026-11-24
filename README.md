# Inference Route Policy

One short string that lets a client tell an inference gateway which
endpoints may serve a request and how to choose among them.

```
example-model+zdr+sort=price                      # in any model picker
Route-Policy: zdr+notrain+bits=8+region=us,de     # or as a header
Route-Applied: provider=aurora                    # what served it
```

A gateway honors the policy whole or refuses the request. It never
drops a requirement it does not understand.

This repository is vendor-neutral. Nothing in the specification or the
core is specific to one gateway or one harness. The plugins and the
dialect translation name their targets.

## Why

### The problem

One model id is served by many endpoints. They differ in price, speed,
how far the weights were quantized, whether prompts are kept, whether
they are used for training, which country they run in, and whether any
of that can be proven. For a coding agent that reads private source,
these differences matter more than the model's name does.

A client that cares cannot say so in a way that travels:

- The request has one field for the choice, `model`, and it names a
  model, not an endpoint.
- Every gateway has its own way to say more: a body object, an SDK
  option, a model suffix, a header, a setting in a web console. A
  harness that wanted to offer the choice would need one adapter per
  gateway, so harnesses offer none, and users set it in a browser.
- A setting made in a console is invisible to the client. The client
  cannot show it, check it, or tell whether a given response honored
  it.
- A gateway ignores options it does not understand. A retention
  requirement that is silently dropped is worse than an error, because
  the user believes it held.

The result is that the party with the requirement, the user at the
harness, is the one party that cannot state it or see what happened to
it.

### What this does about it

The client states the policy in the request. The gateway honors all of
it or refuses the request. The response names what served it. Each of
the choices below follows from wanting those three things to work
across gateways and harnesses that have never heard of each other.

**A string, not an object.** A policy is short text such as
`zdr+bits=8+sort=price`. Text fits in the two places every harness
already passes through untouched: the model name and a header. An
object in the request body would need every harness and SDK to add a
field, and every gateway to agree on which body it belongs in.

**Two carriers.** As a suffix on the model name, a policy works today
in any harness with a model picker, with no change to the harness. As a
`Route-Policy` header, it applies to any model without editing names.
A gateway can also bind a policy to an API key, for an organization
that wants a floor its users cannot remove. All three combine, and
combining only ever narrows: nothing a request carries can weaken what
its key requires.

**Whole or refused.** A gateway that cannot meet a policy, or does not
understand one key in it, refuses the request and says why. This is the
rule the rest depends on. It is what makes a requirement worth writing,
and it is what lets the protocol grow: a client can send a key from a
later revision to an older gateway and get a refusal, never a silent
downgrade.

**Requirements and preferences are different things.** `zdr`,
`notrain`, `bits`, `region`, `attest`, `only`, and `ignore` decide which
endpoints may serve the request. `sort` and `order` only choose among
those. A preference can never make a request fail, and can never admit
an endpoint a requirement excluded.

**No vendor terms.** The keys say what the client needs, not how a
gateway is built. There is no key for one gateway's tiers or one
provider's features, because a harness could not offer such a key
across gateways, and that is the problem being solved.

**The response says what happened.** `Route-Applied` names the provider
that served the request. `Route-Refused` gives a reason and the key at
fault. With the facts a gateway publishes for each route, a client can
check that the provider named does meet the policy it sent, and tell
the user when it does not.

**A client can find out first.** A gateway answers at
`{base}/route-policy` with what it accepts. A client that holds a
requirement and gets no valid answer does not send the request. The
plugins here apply that strictly: a prompt with a retention
requirement does not leave the machine for a gateway that has not said
it will honor one.

### What it does not do

- **It does not make a gateway honest.** `zdr`, `notrain`, `bits`, and
  `region` are what the gateway says about a route. The protocol makes
  the claim explicit, per request, and checkable for consistency. Only
  `attest` asks for evidence, and only a client that verifies that
  evidence itself has more than the gateway's word.
- **It does not choose a model.** "The best model that meets this
  policy" is a different protocol.
- **It does not replace a gateway's own routing.** It says which
  endpoints are allowed and what to favor. How a gateway balances load
  or handles failure within that is its own business.

The specification lists the questions still open, among them how to
state the basis of a claim (a web page, a contract, an attested
environment) and how a client-chosen nonce reaches a provider.

### Why there is so much besides the specification

A routing dialect is easy to write and hard to get adopted, and the
usual failure is a document that no two implementations read the same
way. So the repository carries what is needed to find out whether the
document holds:

- Every testable sentence in the specification has a number in
  `REQUIREMENTS.md`, and every test names the numbers it checks.
- The core library is the single reading of the grammar and the
  matching rules. The gateway, the conformance suite, and the plugins
  all use it, so they cannot drift apart.
- The reference gateway shows the rules can be implemented, and the
  conformance suite lets any other gateway be checked from outside,
  over HTTP, without access to its code.
- The plugins show that adoption does not have to wait for harness
  maintainers: both run in unmodified harnesses, and the end-to-end
  runs drive the real binaries.
- `RUBRIC.md` is how the whole is graded, by a reviewer who did not
  write it and is told to look for the rule being broken first.

### Status

This is a draft, published for comment. The specification has changed
with every review round and will change again. The core library and
the reference gateway have held up under independent review; the
plugins and the conformance suite are still being hardened, and the
repository has not yet passed its own rubric. Disagreement with the
design is as useful as bug reports: open an issue.

## Contents

| Path | What it is |
| ---- | ---------- |
| [SPEC.md](SPEC.md) | The specification. |
| [REQUIREMENTS.md](REQUIREMENTS.md) | Every testable rule in the specification, numbered. Tests name these ids. |
| [RUBRIC.md](RUBRIC.md) | How the repository is graded. |
| `core/` | The grammar, combining rules, matching rules, and client decisions as pure functions. No dependencies. |
| [gateway/](gateway/README.md) | A reference gateway, a server for it, and a demo stack with mock providers. |
| `conformance/` | A black-box suite that checks any gateway over HTTP, and deliberately broken gateways that show it catching each rule. |
| `plugins/shared/` | Client logic shared by the plugins: detection, the send decision, result reading, and translation to OpenRouter's dialect. |
| `plugins/omp/`, `plugins/pi/` | Plugins for the omp and pi coding harnesses. |

## Verify

Requires Node 24 or later, which runs the TypeScript sources directly.

```sh
npm install
npm run typecheck
npm test
npm run conformance:demo
```

`conformance:demo` starts the demo stack on a free port and runs the
conformance suite against it over HTTP. It fails on any failed or
skipped check.

The end-to-end runs drive the real harnesses and need them installed:
`omp` on `PATH` (or `IRP_OMP_BIN`), and the `pi` launcher on `PATH` (or
`IRP_PI_CLI=<cli.js>`). Each uses a temporary home and never touches
your harness configuration.

```sh
npm run e2e:omp
npm run e2e:pi
```

Each asserts, from outside the harness: a request that is honored; one
the gateway refuses; one the plugin holds back because no published
route meets it; one blocked for lack of detection; one blocked by a
failure inside the plugin; one stopped because the key on the wire is
not the key detection was read for; and a harness retry that is stopped
instead of resent. Each run writes what it ran and observed to
`plugins/<harness>/e2e/transcript.txt`.

## Try it

```sh
npm run demo                      # gateway at http://127.0.0.1:8787/v1, keys demo-key and demo-key-zdr
npm run conformance -- --base http://127.0.0.1:8787/v1 --key demo-key --policy-key demo-key-zdr
```

Load a plugin from this checkout:

```sh
omp -e plugins/omp/src/index.ts
pi -e plugins/pi/src/index.ts
```

`ROUTE_POLICY=<policy>` sets the policy the plugin holds. In a session,
`/route` shows it with the gateway's detection state and the last
result, `/route <policy>` sets it, and `/route clear` removes it.

## Known limits of the plugins

- A request is decided in the harness's `before_provider_request` hook
  and checked again where it leaves, in the process's `fetch`: a POST
  to a base URL the plugin has decided for goes out only if its URL,
  headers, `Route-Policy` header, and body are exactly those of a
  request the plugin released, once, and without following redirects.
  A released request is also stopped if it is sent anywhere but the
  base URL it was released for, and so is any POST that carries a
  `Route-Policy` header to a base URL the plugin has not decided for.
- A harness feature that sends other content to some other base URL
  without the hook is not covered, and neither is a transport that does
  not use `fetch`.
- A release is used once. A harness's automatic retry of the same
  request is stopped, so a retryable error ends the turn and the user
  sends again.
- A POST whose body the plugin cannot read at `fetch`, such as a
  compressed one, is stopped whenever a policy is held or carried and
  it goes to a base URL the plugin has decided for. Sent elsewhere, it
  cannot be compared with what was released.
- A base URL that the process's URL handling would send other than as
  written, for example by percent-encoding a character, gets no policy:
  a request with one is blocked.
- A request to an API that names its model in the URL can carry a
  policy only as a header. omp gives a plugin no way to set request
  headers, so there the held policy travels as a model suffix, and
  such a request is blocked whenever a policy is held.

## License

Code: MIT. Specification text (`SPEC.md`, `REQUIREMENTS.md`): CC BY 4.0.
See [LICENSE](LICENSE).
