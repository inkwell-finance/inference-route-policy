import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { createGateway, type RequestHandler } from "./gateway.ts";

export function serve(handler: RequestHandler, port: number, host = "127.0.0.1") {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError("invalid port");
  return createServer(async (incoming, outgoing) => {
    const abort = new AbortController();
    outgoing.once("close", () => { if (!outgoing.writableFinished) abort.abort(); });
    let request: Request;
    let policyLines = 0;
    try {
      if (!incoming.url?.startsWith("/")) throw new TypeError("expected an origin-form request target");
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        const name = incoming.rawHeaders[i]!;
        headers.append(name, incoming.rawHeaders[i + 1]!);
        if (name.toLowerCase() === "route-policy") policyLines++;
      }
      const method = incoming.method ?? "GET";
      request = new Request(`http://localhost${incoming.url}`, {
        method, headers, signal: abort.signal,
        ...(method === "GET" || method === "HEAD" ? {} : { body: Readable.toWeb(incoming), duplex: "half" }),
      });
    } catch {
      outgoing.writeHead(400).end();
      return;
    }
    try {
      const response = await handler(request, { repeatedRoutePolicy: policyLines > 1 });
      outgoing.statusCode = response.status;
      if (response.statusText) outgoing.statusMessage = response.statusText;
      for (const [name, value] of response.headers) if (name !== "set-cookie") outgoing.setHeader(name, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) outgoing.setHeader("set-cookie", cookies);
      outgoing.flushHeaders();
      if (response.body === null || request.method === "HEAD") {
        void response.body?.cancel().catch(() => {});
        outgoing.end();
      } else {
        await pipeline(Readable.fromWeb(response.body), outgoing);
      }
    } catch {
      if (outgoing.headersSent) outgoing.destroy();
      else {
        for (const name of outgoing.getHeaderNames()) outgoing.removeHeader(name);
        outgoing.writeHead(500).end();
      }
    }
  }).listen(port, host);
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { config: { type: "string" }, port: { type: "string", default: "8787" } } });
  if (!values.config) throw new Error("Usage: node gateway/src/serve.ts --config <file.json> --port <n>");
  const config: unknown = JSON.parse(await readFile(values.config, "utf8"));
  const server = serve(createGateway(config), Number(values.port));
  server.once("listening", () => { console.log(`Gateway listening on http://127.0.0.1:${values.port}/v1`); });
}
