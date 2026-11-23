# Inference Route Policy

One short string that lets a client tell an inference gateway which
endpoints may serve a request and how to choose among them.

```
example-model+zdr+sort=price                      # in any model picker
Route-Policy: zdr+notrain+bits=8+region=us,de     # or as a header
Route-Applied: provider=aurora+zdr+notrain+bits=8+region=us   # what served it
```

A gateway honors the policy whole or refuses the request. It never
drops a requirement it does not understand.

This repository is vendor-neutral. Nothing in the specification or the
code is specific to one gateway or one harness, except the plugins and
dialect translations, which name their target.

## Contents

| Path | What it is |
| ---- | ---------- |
| [SPEC.md](SPEC.md) | The specification. |
| [REQUIREMENTS.md](REQUIREMENTS.md) | Every testable rule in the specification, numbered. Tests name these ids. |
| [RUBRIC.md](RUBRIC.md) | How the repository is graded. |
| `core/` | The grammar, combining rules, and matching rules as pure functions. No dependencies. |

## Verify

Requires Node 24 or later, which runs the TypeScript sources directly.

```sh
npm install
npm run typecheck
npm test
```

## License

Code: MIT. Specification text (`SPEC.md`, `REQUIREMENTS.md`): CC BY 4.0.
See [LICENSE](LICENSE).
