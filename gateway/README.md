# Reference gateway

`node gateway/src/serve.ts --config <file.json> --port 8787` binds to
`127.0.0.1` and serves `/v1/route-policy`, `/v1/models`, and the three
inference surfaces. The JSON configuration uses this shape:

```json
{
  "models": {
    "demo-model": [
      {
        "provider": "aurora",
        "facts": "",
        "url": "http://127.0.0.1:9876/v1",
        "price": 1,
        "latencyMs": 25,
        "throughput": 60
      }
    ]
  },
  "keys": { "demo-key": {} }
}
```

A route can also set `model` for its upstream model id, `apiKey` for
its upstream credential, and `evidence` for its published evidence
URI. `keys` may be omitted to allow unauthenticated inference; a key
entry can have a `policy` string. Inference accepts a Bearer token or
`x-api-key`; if both are supplied, they must agree. `accept` takes
optional arrays `keys`, `attest`, and `sort`; an omitted array uses that baseline
list. Without preferences, the route array is tried in order. The
reference gateway retries connection failures, HTTP 429, and HTTP
5xx, but never a route excluded by the policy and never after final
response status and headers. Redirects are relayed, not followed.

The web-standard `createGateway` handler accepts optional transport
metadata `{ repeatedRoutePolicy: true }`. A Fetch `Request` alone
cannot distinguish two field lines from one comma-containing value.
The `node:http` adapter supplies this flag from its raw field lines.

## Operator obligations

- **G27:** Use an `evidence` URI that points to the provider's own
  evidence covering the particular response relayed. Neither the URI
  nor the response header can point to a gateway verdict or summary.
  This implementation forwards the configured URI unchanged; it does
  not generate, fetch, or verify evidence.
- **G28:** Verify published facts for everyone they constrain,
  including parties behind the gateway and provider. If any route
  publishes `zdr`, `notrain`, or `region`, the gateway and its delegates
  must meet that fact for every request they receive, including those
  refused. Verify `bits` and `attest` on the model server; `bits` is the
  lowest precision among its weights as served, rounded down.
- **G30:** Preserve repeated `Route-Policy` field lines through all
  intermediaries. Do not deploy behind a component that joins them.
  A custom transport must tell the handler when a line was repeated.

The reference handler temporarily holds each inference body in memory
for routing and forwarding. It does not persist, log, or train on any
content, and streams provider output. The operator remains responsible
for its environment, infrastructure, and upstreams.

## Local demo

`node gateway/src/demo.ts --port 8787` runs the gateway plus mock
providers in one process. Use `demo-model` with `demo-key` or
`demo-key-zdr`. The `/plain/v1` base has no Route Policy detection.
The demo is **not** a production service: the mock providers record
request bodies in memory at `/__demo/requests` (GET to inspect, DELETE
to clear), and the demo's facts and attestation URI are illustrative.
