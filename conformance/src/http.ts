import { request as http } from "node:http";
import { request as https } from "node:https";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

export interface Probe {
  path: string;
  key?: string;
  omitKey?: boolean;
  raw?: string;
  policies?: readonly string[];
}

export interface Observation {
  status: number;
  body: unknown;
  contentType: string | undefined;
  applied: string[];
  refused: string[];
  evidence: string[];
  received: string;
}

export async function request(base: string, probe: Probe, key: string | undefined, timeoutMs: number): Promise<Observation> {
  const target = new URL(`${base}/${probe.path}`);
  const headers = ["host", target.host, "accept-encoding", "identity"];
  if (key !== undefined) {
    if (probe.path === "messages") headers.push("x-api-key", key, "anthropic-version", "2023-06-01");
    else headers.push("authorization", `Bearer ${key}`);
  } else if (probe.path === "messages") headers.push("anthropic-version", "2023-06-01");
  const post = probe.raw !== undefined;
  if (post) headers.push("content-type", "application/json", "content-length", String(Buffer.byteLength(probe.raw!)));
  for (const [i, value] of (probe.policies ?? []).entries()) headers.push(i % 2 === 0 ? "Route-Policy" : "rOuTe-PoLiCy", value);

  return new Promise((resolve, reject) => {
    const req = (target.protocol === "https:" ? https : http)(target, {
      method: post ? "POST" : "GET", headers, signal: AbortSignal.timeout(timeoutMs),
    }, (reply) => {
      const buckets = new Map<string, string[]>();
      for (let i = 0; i < reply.rawHeaders.length; i += 2) {
        const name = reply.rawHeaders[i]!.toLowerCase();
        const lines = buckets.get(name) ?? [];
        lines.push(reply.rawHeaders[i + 1]!);
        buckets.set(name, lines);
      }
      const contentType = buckets.get("content-type")?.[0];
      const result = {
        status: reply.statusCode ?? 0, contentType,
        applied: buckets.get("route-applied") ?? [], refused: buckets.get("route-refused") ?? [], evidence: buckets.get("route-evidence") ?? [],
      };
      if (contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream") {
        // No conformance check requires the contents of a streaming relay.
        reply.on("error", () => {});
        reply.destroy();
        resolve({ ...result, body: undefined, received: JSON.stringify({ ...result, body: "<event stream>" }) });
        return;
      }
      const chunks: Buffer[] = [];
      reply.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      reply.on("error", reject);
      reply.on("end", () => {
        try {
          let bytes = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
          for (const encoding of (buckets.get("content-encoding") ?? []).join(",").split(",").reverse()) {
            switch (encoding.trim().toLowerCase()) {
              case "br": bytes = brotliDecompressSync(bytes); break;
              case "gzip": bytes = gunzipSync(bytes); break;
              case "deflate": bytes = inflateSync(bytes); break;
            }
          }
          const text = bytes.toString("utf8");
          let body: unknown;
          try { body = JSON.parse(text); } catch { body = undefined; }
          resolve({ ...result, body, received: JSON.stringify({ ...result, body: text.length <= 512 ? text : `${text.slice(0, 512)}…` }) });
        } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.end(probe.raw);
  });
}

export function sent(probe: Probe, key: string | undefined): string {
  const fields = probe.policies?.map((value) => value.length <= 560 ? value : `${value.slice(0, 560)}…`);
  return JSON.stringify({ method: probe.raw === undefined ? "GET" : "POST", path: `/${probe.path}`, credentialed: key !== undefined, routePolicyLines: fields, body: probe.raw });
}
