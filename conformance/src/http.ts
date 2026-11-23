import { request as http } from "node:http";
import { request as https } from "node:https";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

export interface Credential {
  key: string;
  header: "authorization" | "x-api-key";
}

export interface Probe {
  path: string;
  credential?: Credential;
  raw?: string;
  policies?: readonly string[];
  mixedCasePolicy?: boolean;
}

export interface Observation {
  status: number;
  body: unknown;
  hasBody: boolean;
  contentType: string | undefined;
  applied: string[];
  refused: string[];
  evidence: string[];
  received: string;
}

const policyHeader = (index: number, mixedFirst = false): string => (index % 2 === 0) !== mixedFirst ? "Route-Policy" : "rOuTe-PoLiCy";

export async function request(base: URL, probe: Probe, timeoutMs: number): Promise<Observation> {
  const target = new URL(base);
  target.pathname = `${base.pathname.replace(/\/+$/, "")}/${probe.path}`;
  const headers = ["host", target.host, "accept-encoding", "identity"];
  if (probe.credential !== undefined) {
    const { key, header } = probe.credential;
    headers.push(header, header === "authorization" ? `Bearer ${key}` : key);
  }
  if (probe.path === "messages") headers.push("anthropic-version", "2023-06-01");
  const post = probe.raw !== undefined;
  if (post) headers.push("content-type", "application/json", "content-length", String(Buffer.byteLength(probe.raw!)));
  for (const [i, value] of (probe.policies ?? []).entries()) headers.push(policyHeader(i, probe.mixedCasePolicy), value);

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
      const relay = probe.raw !== undefined && result.refused.length === 0 && (result.status < 400 || result.applied.length > 0);
      if (relay && contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream") {
        // No conformance check requires the contents of a streaming relay.
        reply.on("error", () => {});
        reply.destroy();
        resolve({ ...result, body: undefined, hasBody: false, received: JSON.stringify({ ...result, body: "<event stream>" }) });
        return;
      }
      const chunks: Buffer[] = [];
      reply.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      reply.on("error", (error) => {
        if (!relay) reject(error);
        else resolve({ ...result, body: undefined, hasBody: false, received: JSON.stringify({ ...result, body: `<incomplete relay: ${error.message}>` }) });
      });
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
          resolve({ ...result, body, hasBody: text.trim().length !== 0, received: JSON.stringify({ ...result, body: text.length <= 512 ? text : `${text.slice(0, 512)}…` }) });
        } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.end(probe.raw);
  });
}

export function sent(probe: Probe): string {
  const fields = probe.policies?.map((value, i) => [policyHeader(i, probe.mixedCasePolicy), value.length <= 560 ? value : `${value.slice(0, 560)}…`]);
  return JSON.stringify({ method: probe.raw === undefined ? "GET" : "POST", path: `/${probe.path}`, credentialHeader: probe.credential?.header ?? null, routePolicyLines: fields, body: probe.raw });
}
