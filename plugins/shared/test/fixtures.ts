// Shared test fixtures: parsed values made the only way the core allows, a model list like the demo stack's,
// and a small gateway on real HTTP whose replies each test sets.

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { formatDetection, baselineSupport, parseDetection, parsePolicy, type Detection, type Policy } from "../../../core/src/index.ts";
import { OPENROUTER_BASE } from "../src/openrouter.ts";

export function policy(text: string): Policy {
  const parsed = parsePolicy(text);
  assert.ok(parsed.ok, `"${text}" should parse`);
  return parsed.value;
}

/** A detection reply as the client reads it, from a body the test writes. */
export function detection(body: unknown = formatDetection(baselineSupport()), credentialed = true): Detection {
  const read = parseDetection({ status: 200, body, credentialed });
  assert.ok(read.ok, `detection body should be valid: ${read.ok ? "" : read.detail}`);
  return read.value;
}

export const EVIDENCE = "https://basalt.example/attestation";

/** The demo stack's model: aurora meets zdr, basalt attests with evidence, cobalt publishes nothing. */
export const MODEL_LIST = {
  data: [
    {
      id: "demo-model",
      routes: [
        { provider: "aurora", facts: "zdr+notrain+bits=8+region=us" },
        { provider: "basalt", facts: "bits=16+region=us,de+attest=weights,prompt", evidence: EVIDENCE },
        { provider: "cobalt", facts: "" },
      ],
    },
  ],
};

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Reply {
  status: number;
  headers?: Record<string, string | string[]>;
  body?: unknown;
  /** Milliseconds to wait before answering. */
  delayMs?: number;
}

/** What the fake gateway answers; a test changes these between requests. */
export interface FakeGatewayReplies {
  detection: Reply;
  models: Reply;
  inference: Reply;
}

export interface FakeGateway {
  base: string;
  requests: Recorded[];
  replies: FakeGatewayReplies;
  /** Requests that reached the inference endpoint, which is where content goes. */
  inference(): Recorded[];
  close(): Promise<void>;
}

export async function fakeGateway(): Promise<FakeGateway> {
  const requests: Recorded[] = [];
  const replies: FakeGatewayReplies = {
    detection: { status: 200, body: formatDetection(baselineSupport()) },
    models: { status: 200, body: MODEL_LIST },
    inference: { status: 200, headers: { "route-applied": "provider=aurora" }, body: { choices: [] } },
  };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const path = request.url ?? "";
    requests.push({ method: request.method ?? "", path, headers: request.headers, body });
    const reply = path.endsWith("/route-policy") ? replies.detection : path.endsWith("/models") ? replies.models : replies.inference;
    if (reply.delayMs !== undefined) await new Promise((wake) => setTimeout(wake, reply.delayMs));
    response.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
    response.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "a TCP server has an address");
  return {
    base: `http://127.0.0.1:${address.port}/v1`,
    requests,
    replies,
    inference: () => requests.filter((r) => r.method === "POST"),
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

/**
 * Sends every request for OpenRouter's base URL to `local()` instead, so no test reaches the network. Call it
 * before any plugin is registered: the plugin's observer wraps whatever `fetch` is in place at that moment.
 */
export function routeOpenRouterTo(local: () => string): void {
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return real(url.startsWith(OPENROUTER_BASE) ? `${local()}${url.slice(OPENROUTER_BASE.length)}` : input, init);
  };
}
