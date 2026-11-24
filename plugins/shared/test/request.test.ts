// The request helpers (C14, C1, C6): where a base URL is on the wire, what a request is as it leaves, and which
// headers identify the caller. Each row is an input and the whole output, written out.

import { completionOf, contextKey, contextOf, credentialed, credentialNames, CREDENTIAL_HEADERS, modelIn, NOT_CONTEXT, outgoingOf, placeOf } from "../src/request.ts";
import { sameList, table } from "./table.ts";

sameList("C14", "NOT_CONTEXT", NOT_CONTEXT, ["accept", "accept-encoding", "accept-language", "content-length", "content-type", "user-agent", "route-policy", "x-stainless-arch", "x-stainless-lang", "x-stainless-os", "x-stainless-package-version", "x-stainless-retry-count", "x-stainless-runtime", "x-stainless-runtime-version", "x-stainless-timeout"]);
sameList("C6", "CREDENTIAL_HEADERS", CREDENTIAL_HEADERS, ["authorization", "x-api-key", "x-goog-api-key", "api-key", "cookie", "proxy-authorization"]);

table("C14", "placeOf", placeOf, [
  ["http://gateway.test/v1?tag=O'Brien", { place: { base: "http://gateway.test/v1", query: "?tag=O%27Brien" }, unexact: "the base URL \"http://gateway.test/v1?tag=O'Brien\" cannot be used exactly as written: its query \"?tag=O'Brien\" would be sent as \"?tag=O%27Brien\"; a policy is not sent anywhere else" }],
  ["http://gateway.test/v1?tag=O%27Brien", { place: { base: "http://gateway.test/v1", query: "?tag=O%27Brien" }, unexact: null }],
  ["http://gateway.test/v1?tag=a b", { place: { base: "http://gateway.test/v1", query: "?tag=a%20b" }, unexact: "the base URL \"http://gateway.test/v1?tag=a b\" cannot be used exactly as written: its query \"?tag=a b\" would be sent as \"?tag=a%20b\"; a policy is not sent anywhere else" }],
  ["http://gateway.test/v1?tag=a%20b", { place: { base: "http://gateway.test/v1", query: "?tag=a%20b" }, unexact: null }],
  ["http://gateway.test/v1?tag=a\"b", { place: { base: "http://gateway.test/v1", query: "?tag=a%22b" }, unexact: "the base URL \"http://gateway.test/v1?tag=a\\\"b\" cannot be used exactly as written: its query \"?tag=a\\\"b\" would be sent as \"?tag=a%22b\"; a policy is not sent anywhere else" }],
  ["http://gateway.test/v1?tag=a%22b", { place: { base: "http://gateway.test/v1", query: "?tag=a%22b" }, unexact: null }],
  ["http://gateway.test/v1?tag=<a>", { place: { base: "http://gateway.test/v1", query: "?tag=%3Ca%3E" }, unexact: "the base URL \"http://gateway.test/v1?tag=<a>\" cannot be used exactly as written: its query \"?tag=<a>\" would be sent as \"?tag=%3Ca%3E\"; a policy is not sent anywhere else" }],
  ["http://gateway.test/v1?tag=%3Ca%3E", { place: { base: "http://gateway.test/v1", query: "?tag=%3Ca%3E" }, unexact: null }],
  ["http://gateway.test/v1?tag=é", { place: { base: "http://gateway.test/v1", query: "?tag=%C3%A9" }, unexact: "the base URL \"http://gateway.test/v1?tag=é\" cannot be used exactly as written: its query \"?tag=é\" would be sent as \"?tag=%C3%A9\"; a policy is not sent anywhere else" }],
  ["http://gateway.test/v1?tag=%C3%A9", { place: { base: "http://gateway.test/v1", query: "?tag=%C3%A9" }, unexact: null }],
  ["http://gateway.test/v1?tag=a\rb", { place: { base: "http://gateway.test/v1", query: "?tag=ab" }, unexact: "the base URL \"http://gateway.test/v1?tag=a\\rb\" cannot be used exactly as written: its query \"?tag=a\\rb\" would be sent as \"?tag=ab\"; a policy is not sent anywhere else" }],
  ["http://gateway.test/v1?tag=a%0Db", { place: { base: "http://gateway.test/v1", query: "?tag=a%0Db" }, unexact: null }],
  ["http://gateway.test/v1?tag=a\tb", { place: { base: "http://gateway.test/v1", query: "?tag=ab" }, unexact: "the base URL \"http://gateway.test/v1?tag=a\\tb\" cannot be used exactly as written: its query \"?tag=a\\tb\" would be sent as \"?tag=ab\"; a policy is not sent anywhere else" }],
  ["http://gateway.test/v1?tag=a%09b", { place: { base: "http://gateway.test/v1", query: "?tag=a%09b" }, unexact: null }],
  ["http://gateway.test/v1?tag=a\nb", { place: { base: "http://gateway.test/v1", query: "?tag=ab" }, unexact: "the base URL \"http://gateway.test/v1?tag=a\\nb\" cannot be used exactly as written: its query \"?tag=a\\nb\" would be sent as \"?tag=ab\"; a policy is not sent anywhere else" }],
  ["http://gateway.test/v1?tag=a%0Ab", { place: { base: "http://gateway.test/v1", query: "?tag=a%0Ab" }, unexact: null }],
  ["http://gateway.test/v1?tag=a#b", { place: { base: "http://gateway.test/v1", query: "?tag=a" }, unexact: "the base URL \"http://gateway.test/v1?tag=a#b\" cannot be used exactly as written: its fragment \"#b\" is never sent; a policy is not sent anywhere else" }],
  ["http://gateway.test/v1?tag=a%23b", { place: { base: "http://gateway.test/v1", query: "?tag=a%23b" }, unexact: null }],
  ["http://gateway.test/v 1", { place: { base: "http://gateway.test/v%201", query: "" }, unexact: "the base URL \"http://gateway.test/v 1\" cannot be used exactly as written: its path \"/v 1\" would be sent as \"/v%201\"; a policy is not sent anywhere else" }],
  ["http://gateway.test/v\t1", { place: { base: "http://gateway.test/v1", query: "" }, unexact: "the base URL \"http://gateway.test/v\\t1\" cannot be used exactly as written: its path \"/v\\t1\" would be sent as \"/v1\"; a policy is not sent anywhere else" }],
  ["http://gateway.test/v%091", { place: { base: "http://gateway.test/v%091", query: "" }, unexact: null }],
  ["http://gateway.test/v<1>", { place: { base: "http://gateway.test/v%3C1%3E", query: "" }, unexact: "the base URL \"http://gateway.test/v<1>\" cannot be used exactly as written: its path \"/v<1>\" would be sent as \"/v%3C1%3E\"; a policy is not sent anywhere else" }],
  ["http://gateway.test/v%3C1%3E", { place: { base: "http://gateway.test/v%3C1%3E", query: "" }, unexact: null }],
  ["http://gateway.test/v%201", { place: { base: "http://gateway.test/v%201", query: "" }, unexact: null }],
  ["http://gateway.test/v\"1", { place: { base: "http://gateway.test/v%221", query: "" }, unexact: "the base URL \"http://gateway.test/v\\\"1\" cannot be used exactly as written: its path \"/v\\\"1\" would be sent as \"/v%221\"; a policy is not sent anywhere else" }],
  ["http://gateway.test/v%221", { place: { base: "http://gateway.test/v%221", query: "" }, unexact: null }],
  ["http://gateway.test/v 1?tag=a b", { place: { base: "http://gateway.test/v%201", query: "?tag=a%20b" }, unexact: "the base URL \"http://gateway.test/v 1?tag=a b\" cannot be used exactly as written: its path \"/v 1\" would be sent as \"/v%201\", and its query \"?tag=a b\" would be sent as \"?tag=a%20b\"; a policy is not sent anywhere else" }],
  ["http://gateway.test/v`1", { place: { base: "http://gateway.test/v%601", query: "" }, unexact: "the base URL \"http://gateway.test/v`1\" cannot be used exactly as written: its path \"/v`1\" would be sent as \"/v%601\"; a policy is not sent anywhere else" }],
  ["http://gateway.test/v%601", { place: { base: "http://gateway.test/v%601", query: "" }, unexact: null }],
  ["http://gateway.test/v{1}", { place: { base: "http://gateway.test/v%7B1%7D", query: "" }, unexact: "the base URL \"http://gateway.test/v{1}\" cannot be used exactly as written: its path \"/v{1}\" would be sent as \"/v%7B1%7D\"; a policy is not sent anywhere else" }],
  ["http://gateway.test/v%7B1%7D", { place: { base: "http://gateway.test/v%7B1%7D", query: "" }, unexact: null }],
  ["http://gateway.test/v1\\x", { place: { base: "http://gateway.test/v1/x", query: "" }, unexact: "the base URL \"http://gateway.test/v1\\\\x\" cannot be used exactly as written: its path \"/v1\\\\x\" would be sent as \"/v1/x\"; a policy is not sent anywhere else" }],
  ["http://gateway.test/v1%5Cx", { place: { base: "http://gateway.test/v1%5Cx", query: "" }, unexact: null }],
  ["http://gateway.test/vé", { place: { base: "http://gateway.test/v%C3%A9", query: "" }, unexact: "the base URL \"http://gateway.test/vé\" cannot be used exactly as written: its path \"/vé\" would be sent as \"/v%C3%A9\"; a policy is not sent anywhere else" }],
  ["http://gateway.test/v%C3%A9", { place: { base: "http://gateway.test/v%C3%A9", query: "" }, unexact: null }],
  ["http://gateway.test/x/%2e%2e/v1", { place: { base: "http://gateway.test/v1", query: "" }, unexact: "the base URL \"http://gateway.test/x/%2e%2e/v1\" cannot be used exactly as written: its path \"/x/%2e%2e/v1\" would be sent as \"/v1\"; a policy is not sent anywhere else" }],
  ["http://gateway.test/x/%2e%2ex/v1", { place: { base: "http://gateway.test/x/%2e%2ex/v1", query: "" }, unexact: null }],
  ["http://gateway.test/v1?tag=a`b", { place: { base: "http://gateway.test/v1", query: "?tag=a`b" }, unexact: null }],
  ["http://gateway.test/v'1", { place: { base: "http://gateway.test/v'1", query: "" }, unexact: null }],
  ["http://gateway.test/v^1", { place: { base: "http://gateway.test/v%5E1", query: "" }, unexact: "the base URL \"http://gateway.test/v^1\" cannot be used exactly as written: its path \"/v^1\" would be sent as \"/v%5E1\"; a policy is not sent anywhere else" }],
  ["http://gateway.test/v%5E1", { place: { base: "http://gateway.test/v%5E1", query: "" }, unexact: null }],
  ["http://gateway.test/v|1", { place: { base: "http://gateway.test/v|1", query: "" }, unexact: null }],
  ["http://gateway.test/v1?tag=a^b", { place: { base: "http://gateway.test/v1", query: "?tag=a^b" }, unexact: null }],
  ["http://gateway.test/v1?tag=%zz", { place: { base: "http://gateway.test/v1", query: "?tag=%zz" }, unexact: null }],
  ["http://gateway.test/v1?tag=a+b", { place: { base: "http://gateway.test/v1", query: "?tag=a+b" }, unexact: null }],
  ["http://gateway.test/x/../v1", { place: { base: "http://gateway.test/v1", query: "" }, unexact: null }],
  ["http://gateway.test/v1?", { place: { base: "http://gateway.test/v1", query: "?" }, unexact: null }],
  ["http://gateway.test/v1/", { place: { base: "http://gateway.test/v1", query: "" }, unexact: null }],
  ["http://gateway.test/v1//", { place: { base: "http://gateway.test/v1", query: "" }, unexact: null }],
  ["HTTP://GATEWAY.TEST:8080/v1", { place: { base: "http://gateway.test:8080/v1", query: "" }, unexact: null }],
  ["http://LOCALHOST:8080/v1", { place: { base: "http://localhost:8080/v1", query: "" }, unexact: null }],
  ["http://gateway.test:80/v1", { place: { base: "http://gateway.test/v1", query: "" }, unexact: null }],
  ["https://gateway.test:443/v1", { place: { base: "https://gateway.test/v1", query: "" }, unexact: null }],
  ["http://g%61teway.test/v1", { place: { base: "http://gateway.test/v1", query: "" }, unexact: "the base URL \"http://g%61teway.test/v1\" cannot be used exactly as written: its host \"g%61teway.test\" would be sent as \"gateway.test\"; a policy is not sent anywhere else" }],
  ["http://gateway.test/v1 ", { place: { base: "http://gateway.test/v1", query: "" }, unexact: "the base URL \"http://gateway.test/v1 \" cannot be used exactly as written: its path \"/v1 \" would be sent as \"/v1\"; a policy is not sent anywhere else" }],
  ["http://gateway.test:/v1", { place: { base: "http://gateway.test/v1", query: "" }, unexact: null }],
  ["http://gateway.test./v1", { place: { base: "http://gateway.test./v1", query: "" }, unexact: null }],
  ["http://bücher.test/v1", { place: { base: "http://xn--bcher-kva.test/v1", query: "" }, unexact: "the base URL \"http://bücher.test/v1\" cannot be used exactly as written: its host \"bücher.test\" would be sent as \"xn--bcher-kva.test\"; a policy is not sent anywhere else" }],
  ["http://BÜCHER.test/v1", { place: { base: "http://xn--bcher-kva.test/v1", query: "" }, unexact: "the base URL \"http://BÜCHER.test/v1\" cannot be used exactly as written: its host \"BÜCHER.test\" would be sent as \"xn--bcher-kva.test\"; a policy is not sent anywhere else" }],
  ["http://127.1:8080/v1", { place: { base: "http://127.0.0.1:8080/v1", query: "" }, unexact: "the base URL \"http://127.1:8080/v1\" cannot be used exactly as written: its host \"127.1\" would be sent as \"127.0.0.1\"; a policy is not sent anywhere else" }],
  ["http://127.0.0.1.:8080/v1", { place: { base: "http://127.0.0.1:8080/v1", query: "" }, unexact: "the base URL \"http://127.0.0.1.:8080/v1\" cannot be used exactly as written: its host \"127.0.0.1.\" would be sent as \"127.0.0.1\"; a policy is not sent anywhere else" }],
  ["http://[0:0:0:0:0:0:0:1]:8080/v1", { place: { base: "http://[::1]:8080/v1", query: "" }, unexact: "the base URL \"http://[0:0:0:0:0:0:0:1]:8080/v1\" cannot be used exactly as written: its host \"[0:0:0:0:0:0:0:1]\" would be sent as \"[::1]\"; a policy is not sent anywhere else" }],
  [" http://gateway.test/v1", { place: { base: "http://gateway.test/v1", query: "" }, unexact: "the base URL \" http://gateway.test/v1\" cannot be used exactly as written: it is not written as scheme://host/path?query; a policy is not sent anywhere else" }],
  ["http://gateway.test/v1\n", { place: { base: "http://gateway.test/v1", query: "" }, unexact: "the base URL \"http://gateway.test/v1\\n\" cannot be used exactly as written: its path \"/v1\\n\" would be sent as \"/v1\"; a policy is not sent anywhere else" }],
  ["http://gateway.test/v1#part", { place: { base: "http://gateway.test/v1", query: "" }, unexact: "the base URL \"http://gateway.test/v1#part\" cannot be used exactly as written: its fragment \"#part\" is never sent; a policy is not sent anywhere else" }],
  ["HTTP://GATEWAY.TEST:80/v1/", { place: { base: "http://gateway.test/v1", query: "" }, unexact: null }],
  ["http://gateway.test:8080/v1", { place: { base: "http://gateway.test:8080/v1", query: "" }, unexact: null }],
  ["https://gateway.test:80/v1", { place: { base: "https://gateway.test:80/v1", query: "" }, unexact: null }],
  ["http://user:secret@gateway.test/v1", null],
  ["http://user@gateway.test/v1", null],
  ["http://:secret@gateway.test/v1", null],
  ["http://:p%40ss@gateway.test/v1", null],
  ["not a url", null],
  ["", null],
  ["http://gateway.test/v1/.", { place: { base: "http://gateway.test/v1", query: "" }, unexact: null }],
  ["http://gateway.test/v1/x/..", { place: { base: "http://gateway.test/v1", query: "" }, unexact: null }],
]);

/** A request as a row describes it: a URL string, a URL object, or a Request, and the init fetch is called with. */
interface OutSpec {
  url: string;
  urlObject?: boolean;
  request?: { method?: string; headers?: Record<string, string>; body?: string };
  init?: { method?: string; headers?: Record<string, string> | [string, string][] | { $headers: [string, string][] }; body?: string | null | { $bytes: number[] } };
}
type Lines = [string, string][];
const isLines = (h: NonNullable<NonNullable<OutSpec["init"]>["headers"]>): h is Lines => Array.isArray(h);

/** Headers as fetch takes them: an array of lines, a Headers object, or a record, as the row writes them. */
function headersOf(h: NonNullable<NonNullable<OutSpec["init"]>["headers"]>): NonNullable<RequestInit["headers"]> {
  if (isLines(h)) return h;
  const instance: unknown = "$headers" in h ? h["$headers"] : undefined;
  return Array.isArray(instance) ? new Headers(instance as Lines) : (h as Record<string, string>);
}
function outgoing(spec: OutSpec): unknown {
  const input = spec.request === undefined ? (spec.urlObject === true ? new URL(spec.url) : spec.url) : new Request(spec.url, { method: spec.request.method ?? "POST", ...(spec.request.headers === undefined ? {} : { headers: spec.request.headers }), ...(spec.request.body === undefined ? {} : { body: spec.request.body }) });
  const init = spec.init;
  if (init === undefined) return outgoingOf(input, undefined);
  const body = init.body !== null && typeof init.body === "object" ? new Uint8Array(init.body.$bytes) : init.body;
  try {
    return outgoingOf(input, { ...(init.method === undefined ? {} : { method: init.method }), ...(init.headers === undefined ? {} : { headers: headersOf(init.headers) }), ...("body" in init ? { body } : {}) });
  } catch (error) {
    return { throws: String(error) };
  }
}

table("C14", "outgoingOf", outgoing, [
  [{ url: "http://gw.test/v1/chat/completions", init: { method: "POST", headers: { Authorization: "Bearer k", "Content-Type": "application/json", "Route-Policy": "zdr" }, body: "{\"model\":\"m\"}" } }, { path: "http://gw.test/v1/chat/completions", query: "", method: "POST", context: [["authorization", "Bearer k"]], header: "zdr", body: "{\"model\":\"m\"}" }],
  [{ url: "http://gw.test/v1/chat/completions?", init: { method: "post", headers: [["x-tenant", "a"], ["X-Tenant", "b"], ["authorization", "  Bearer k  "]], body: "" } }, { path: "http://gw.test/v1/chat/completions", query: "?", method: "POST", context: [["authorization", "Bearer k"], ["x-tenant", "a, b"]], header: null, body: "" }],
  [{ url: "http://gw.test/v1/chat/completions?q=1#frag", urlObject: true, init: { method: "POST", headers: { $headers: [["cookie", "a=1"], ["user-agent", "x"], ["accept", "*/*"]] } } }, { path: "http://gw.test/v1/chat/completions", query: "?q=1", method: "POST", context: [["cookie", "a=1"]], header: null, body: "" }],
  [{ url: "http://GW.test:80/v1/x/../chat/completions", init: { method: "POST", body: { $bytes: [123, 125] } } }, { path: "http://gw.test/v1/chat/completions", query: "", method: "POST", context: [], header: null, body: null }],
  [{ url: "http://gw.test/v1/chat/completions", init: { method: "POST", body: null } }, { path: "http://gw.test/v1/chat/completions", query: "", method: "POST", context: [], header: null, body: "" }],
  [{ url: "http://gw.test/v1/chat/completions" }, { path: "http://gw.test/v1/chat/completions", query: "", method: "GET", context: [], header: null, body: "" }],
  [{ url: "http://gw.test/v1/chat/completions", request: { headers: { authorization: "Bearer r", "route-policy": "notrain" }, body: "{\"model\":\"r\"}" } }, { path: "http://gw.test/v1/chat/completions", query: "", method: "POST", context: [["authorization", "Bearer r"]], header: "notrain", body: null }],
  [{ url: "http://gw.test/v1/chat/completions", request: { headers: { authorization: "Bearer r" }, body: "{\"model\":\"r\"}" }, init: { headers: { authorization: "Bearer i" }, body: "{\"model\":\"i\"}" } }, { path: "http://gw.test/v1/chat/completions", query: "", method: "POST", context: [["authorization", "Bearer i"]], header: null, body: "{\"model\":\"i\"}" }],
  [{ url: "http://gw.test/v1/chat/completions", request: { method: "PUT", headers: { "x-api-key": "k" } } }, { path: "http://gw.test/v1/chat/completions", query: "", method: "PUT", context: [["x-api-key", "k"]], header: null, body: "" }],
  [{ url: "http://gw.test/v1/chat/completions", init: { method: "POST", headers: [["route-policy", "zdr"], ["Route-Policy", "zdr"]], body: "{}" } }, { path: "http://gw.test/v1/chat/completions", query: "", method: "POST", context: [], header: "zdr, zdr", body: "{}" }],
  [{ url: "http://user:pw@gw.test/v1/chat/completions", init: { method: "POST", body: "{}" } }, { throws: "TypeError: a URL with credentials in it is not sent" }],
  [{ url: "http://gw.test/v1/chat/completions", init: { method: "POST", headers: { accept: "v", "accept-encoding": "v", "accept-language": "v", "content-type": "v", "user-agent": "v", "route-policy": "v", "x-stainless-arch": "v", "x-stainless-lang": "v", "x-stainless-os": "v", "x-stainless-package-version": "v", "x-stainless-retry-count": "v", "x-stainless-runtime": "v", "x-stainless-runtime-version": "v", "x-stainless-timeout": "v" }, body: "{}" } }, { path: "http://gw.test/v1/chat/completions", query: "", method: "POST", context: [], header: "v", body: "{}" }],
]);

table("", "modelIn", modelIn, [
  [null, undefined],
  ["", null],
  ["{\"model\":\"m+zdr\"}", "m+zdr"],
  ["{\"x\":1}", null],
  ["[1]", null],
  ["\"text\"", null],
  ["{\"model\":7}", undefined],
  ["{\"model\":null}", undefined],
  ["not json", undefined],
  ["{\"model\":\"a\",\"model\":\"b\"}", "b"],
]);

table("C14", "contextOf", (pairs: [string, string][]) => contextOf(new Headers(pairs)), [
  [[["Authorization", "Bearer k"], ["Content-Type", "application/json"], ["X-Tenant", "a"], ["x-tenant", "b"], ["Route-Policy", "zdr"], ["Accept", "*/*"], ["Cookie", "c=1"]], [["authorization", "Bearer k"], ["cookie", "c=1"], ["x-tenant", "a, b"]]],
  [[["user-agent", "x"], ["x-stainless-os", "Linux"]], []],
  [[], []],
]);

table("C6", "credentialNames", credentialNames, [
  [[["authorization", "Bearer k"], ["cookie", "a=1"], ["x-tenant-token", "t"]], ["authorization", "cookie"]],
  [[["authorization", "  "], ["x-api-key", ""], ["traceparent", "00"]], []],
  [[["x-goog-api-key", "g"], ["api-key", "a"], ["proxy-authorization", "Basic x"]], ["x-goog-api-key", "api-key", "proxy-authorization"]],
  [[], []],
]);

table("C6", "credentialed", credentialed, [
  [[["api-key", "a"]], true],
  [[["traceparent", "00"]], false],
  [[["cookie", " "]], false],
  [[], false],
]);

table("C14", "contextKey", contextKey, [
  [[["authorization", "Bearer k"], ["cookie", "a=1"]], "[[\"authorization\",\"Bearer k\"],[\"cookie\",\"a=1\"]]"],
  [[], "[]"],
]);

table("", "completionOf", (spec: { status: number; headers: [string, string][] }) => completionOf(new Response(null, { status: spec.status, headers: spec.headers })), [
  [{ status: 200, headers: [["route-applied", "provider=aurora"], ["route-applied", "provider=basalt"], ["route-evidence", "https://e.example/x"]] }, { status: 200, result: { applied: ["provider=aurora, provider=basalt"], refused: [], evidence: ["https://e.example/x"] } }],
  [{ status: 400, headers: [["route-refused", "reason=unsupported+key=bits"]] }, { status: 400, result: { applied: [], refused: ["reason=unsupported+key=bits"], evidence: [] } }],
  [{ status: 200, headers: [["route-applied", "provider=aurora"], ["route-applied", "provider=aurora"]] }, { status: 200, result: { applied: ["provider=aurora, provider=aurora"], refused: [], evidence: [] } }],
  [{ status: 204, headers: [] }, { status: 204, result: { applied: [], refused: [], evidence: [] } }],
]);
