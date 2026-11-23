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

Each asserts, from outside the harness, one honored request, one
refused request, and one blocked request, and writes what it ran and
observed to `plugins/<harness>/e2e/transcript.txt`.

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

- A request is guarded when it passes through the harness's
  `before_provider_request` hook. A harness feature that sends content
  without that hook is not covered.
- Results are read from the process's `fetch`. A transport that does not
  use it gets no result report; it is never reported as honored.
- omp gives a plugin no way to set request headers, so there the held
  policy travels as a model suffix.

## License

Code: MIT. Specification text (`SPEC.md`, `REQUIREMENTS.md`): CC BY 4.0.
See [LICENSE](LICENSE).
