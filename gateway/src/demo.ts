import { once } from "node:events";
import { parseArgs } from "node:util";
import { createGateway, ENDPOINTS, type Endpoint, type RequestHandler, type Route } from "./gateway.ts";
import { serve } from "./serve.ts";

const MODEL = "demo-model";
const PROVIDERS = ["aurora", "basalt", "cobalt"] as const;
const CHAT_USAGE = { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 };
const RESPONSE_USAGE = { input_tokens: 4, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 7 };

interface RecordedRequest {
  provider: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type Event = { data: unknown; event?: string };
function sse(events: readonly Event[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const entry = events[i++];
      if (entry === undefined) { controller.close(); return; }
      controller.enqueue(encoder.encode(`${entry.event === undefined ? "" : `event: ${entry.event}\n`}data: ${entry.data === "[DONE]" ? entry.data : JSON.stringify(entry.data)}\n\n`));
    },
  }), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}

function mockReply(endpoint: Endpoint, provider: string, model: string, streaming: boolean): Response {
  const text = `served by ${provider}`;
  const created = Math.floor(Date.now() / 1000);
  if (endpoint === "chat/completions") {
    const chunk = { id: "chatcmpl-demo", object: "chat.completion.chunk", created, model };
    if (streaming) return sse([
      { data: { ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }], usage: null } },
      { data: { ...chunk, choices: [{ index: 0, delta: { content: text }, finish_reason: null }], usage: null } },
      { data: { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: null } },
      { data: { ...chunk, choices: [], usage: CHAT_USAGE } },
      { data: "[DONE]" },
    ]);
    return Response.json({ ...chunk, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: CHAT_USAGE });
  }
  if (endpoint === "responses") {
    const part = { type: "output_text", text, annotations: [], logprobs: [] };
    const item = { id: "msg_demo", type: "message", role: "assistant", status: "completed", content: [part] };
    const initial = { id: "resp_demo", object: "response", created_at: created, model, status: "in_progress", output: [], usage: null, error: null, incomplete_details: null };
    const response = { ...initial, status: "completed", output: [item], usage: RESPONSE_USAGE };
    if (!streaming) return Response.json(response);
    const index = { output_index: 0, content_index: 0, item_id: item.id };
    const events = [
      { type: "response.created", response: initial },
      { type: "response.in_progress", response: initial },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.content_part.added", ...index, part: { ...part, text: "" } },
      { type: "response.output_text.delta", ...index, delta: text, logprobs: [] },
      { type: "response.output_text.done", ...index, text, logprobs: [] },
      { type: "response.content_part.done", ...index, part },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ];
    return sse(events.map((data, sequence_number) => ({ event: data.type, data: { ...data, sequence_number } })));
  }
  const usage = { input_tokens: 4, output_tokens: 3 };
  const message = { id: "msg_demo", type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage };
  if (!streaming) return Response.json(message);
  const events = [
    { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
  return sse(events.map((data) => ({ event: data.type, data })));
}

export async function startDemo(port: number) {
  const requests: RecordedRequest[] = [];
  const withBase = (address: string) => {
    const route = (provider: string, facts: string, price: number, latencyMs: number, throughput: number, evidence?: string): Route => ({
      provider, facts, price, latencyMs, throughput, url: `${address}/providers/${provider}/v1`, ...(evidence === undefined ? {} : { evidence }),
    });
    return createGateway({
      models: { [MODEL]: [
        route("aurora", "zdr+notrain+bits=8+region=us", 3, 10, 20),
        route("basalt", "bits=16+region=us,de+attest=weights,prompt", 2, 30, 60, "https://basalt.example/attestation"),
        route("cobalt", "", 1, 20, 40),
      ] },
      keys: { "demo-key": {}, "demo-key-zdr": { policy: "zdr" } },
    });
  };
  const server = serve(async (request, transport) => {
    const path = new URL(request.url).pathname;
    if (path === "/__demo/requests") {
      if (request.method === "GET") return Response.json(requests);
      if (request.method === "DELETE") { requests.length = 0; return new Response(null, { status: 204 }); }
    }
    if (path.startsWith("/v1/")) return (await gateway).handler(request, transport);
    if (path === "/plain/v1/models" && request.method === "GET") return Response.json({ object: "list", data: [{ id: MODEL }] });
    const provider = path.startsWith("/plain/v1/") ? "plain" : PROVIDERS.find((id) => path.startsWith(`/providers/${id}/v1/`));
    if (provider !== undefined && request.method === "POST") {
      const upstreamPath = path.slice(path.indexOf("/v1/"));
      const endpoint = ENDPOINTS.find((name) => upstreamPath === `/v1/${name}`);
      if (endpoint !== undefined) {
        const body: unknown = await request.json().catch(() => null);
        requests.push({ provider, path: upstreamPath, headers: Object.fromEntries(request.headers), body });
        if (typeof body !== "object" || body === null || Array.isArray(body) || !("model" in body) || typeof body.model !== "string") {
          return Response.json({ error: { message: "Expected a string model" } }, { status: 400 });
        }
        return mockReply(endpoint, provider, body.model, "stream" in body && body.stream === true);
      }
    }
    return Response.json({ error: { message: "Not found" } }, { status: 404 });
  }, port);
  const gateway: Promise<{ base: string; handler: RequestHandler }> = once(server, "listening").then(() => {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a TCP server");
    const base = `http://127.0.0.1:${address.port}`;
    return { base, handler: withBase(base) };
  });
  return { server, base: (await gateway).base };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { port: { type: "string", default: "8787" } } });
  const { base } = await startDemo(Number(values.port));
  console.log(`Demo gateway: ${base}/v1\nPlain provider: ${base}/plain/v1`);
}
