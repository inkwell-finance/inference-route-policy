// Base URLs as written, beside what the URL parser (and so `fetch`) sends for them: one case per character class
// the parser rewrites, each with its percent-encoded control, and the classes it keeps as written. Shared by the
// unit test of `placeOf` and the adapter tests that record the request targets a gateway receives.

export interface PathQueryCase {
  name: string;
  /** The base URL's path and query as written, after the origin. */
  path: string;
  query: string;
  /** What the parser sends for them. */
  sentPath: string;
  sentQuery: string;
  /** The difference the plugin names, or null when the base URL is used as written. */
  difference: string | null;
}

const quoted = (text: string): string => JSON.stringify(text);
const queryRewritten = (name: string, query: string, sentQuery: string): PathQueryCase => ({
  name,
  path: "/v1",
  query,
  sentPath: "/v1",
  sentQuery,
  difference: `its query ${quoted(query)} would be sent as ${quoted(sentQuery)}`,
});
const pathRewritten = (name: string, path: string, sentPath: string): PathQueryCase => ({
  name,
  path,
  query: "",
  sentPath,
  sentQuery: "",
  difference: `its path ${quoted(path)} would be sent as ${quoted(sentPath)}`,
});
const asWritten = (name: string, path: string, query: string): PathQueryCase => ({ name, path, query, sentPath: path, sentQuery: query, difference: null });

export const PATH_QUERY_CASES: readonly PathQueryCase[] = [
  queryRewritten("an apostrophe in the query", "?tag=O'Brien", "?tag=O%27Brien"),
  asWritten("an apostrophe in the query, encoded", "/v1", "?tag=O%27Brien"),
  queryRewritten("a space in the query", "?tag=a b", "?tag=a%20b"),
  asWritten("a space in the query, encoded", "/v1", "?tag=a%20b"),
  queryRewritten("a double quote in the query", '?tag=a"b', "?tag=a%22b"),
  asWritten("a double quote in the query, encoded", "/v1", "?tag=a%22b"),
  queryRewritten("angle brackets in the query", "?tag=<a>", "?tag=%3Ca%3E"),
  asWritten("angle brackets in the query, encoded", "/v1", "?tag=%3Ca%3E"),
  queryRewritten("a non-ASCII character in the query", "?tag=é", "?tag=%C3%A9"),
  asWritten("a non-ASCII character in the query, encoded", "/v1", "?tag=%C3%A9"),
  queryRewritten("a tab in the query", "?tag=a\tb", "?tag=ab"),
  asWritten("a tab in the query, encoded", "/v1", "?tag=a%09b"),
  queryRewritten("a newline in the query", "?tag=a\nb", "?tag=ab"),
  asWritten("a newline in the query, encoded", "/v1", "?tag=a%0Ab"),
  { name: "a # in the query", path: "/v1", query: "?tag=a#b", sentPath: "/v1", sentQuery: "?tag=a", difference: `its fragment ${quoted("#b")} is never sent` },
  asWritten("a # in the query, encoded", "/v1", "?tag=a%23b"),
  pathRewritten("a space in the path", "/v 1", "/v%201"),
  asWritten("a space in the path, encoded", "/v%201", ""),
  pathRewritten("a backtick in the path", "/v`1", "/v%601"),
  asWritten("a backtick in the path, encoded", "/v%601", ""),
  pathRewritten("braces in the path", "/v{1}", "/v%7B1%7D"),
  asWritten("braces in the path, encoded", "/v%7B1%7D", ""),
  pathRewritten("a backslash in the path", "/v1\\x", "/v1/x"),
  asWritten("a backslash in the path, encoded", "/v1%5Cx", ""),
  pathRewritten("a non-ASCII character in the path", "/vé", "/v%C3%A9"),
  asWritten("a non-ASCII character in the path, encoded", "/v%C3%A9", ""),
  pathRewritten("percent-encoded dot segments in the path", "/x/%2e%2e/v1", "/v1"),
  asWritten("percent-encoded dots that are no segment", "/x/%2e%2ex/v1", ""),
  asWritten("a backtick in the query, kept", "/v1", "?tag=a`b"),
  asWritten("an apostrophe in the path, kept", "/v'1", ""),
  pathRewritten("a caret in the path", "/v^1", "/v%5E1"),
  asWritten("a caret in the path, encoded", "/v%5E1", ""),
  asWritten("a pipe in the path, kept", "/v|1", ""),
  asWritten("a caret in the query, kept", "/v1", "?tag=a^b"),
  asWritten("a % not followed by two hex digits, kept", "/v1", "?tag=%zz"),
  asWritten("+ in the query, kept", "/v1", "?tag=a+b"),
  // RFC 3986, 6.2.2.3: dot segments name the same resource once removed.
  { name: "dot segments, removed", path: "/x/../v1", query: "", sentPath: "/v1", sentQuery: "", difference: null },
];

export interface WholeUrlCase {
  name: string;
  /** The base URL as written; `{port}` stands for a port of the test's own. */
  written: string;
  /** The difference the plugin names, or null when the base URL is used as written. */
  difference: string | null;
}

export const WHOLE_URL_CASES: readonly WholeUrlCase[] = [
  { name: "an uppercase scheme and host (RFC 3986, 6.2.2.1)", written: "HTTP://GATEWAY.TEST:{port}/v1", difference: null },
  { name: "a default port (RFC 3986, 6.2.3)", written: "http://gateway.test:80/v1", difference: null },
  { name: "an empty port (RFC 3986, 6.2.3)", written: "http://gateway.test:/v1", difference: null },
  { name: "a trailing dot on a domain name, kept", written: "http://gateway.test./v1", difference: null },
  { name: "a non-ASCII host", written: "http://bücher.test/v1", difference: `its host ${quoted("bücher.test")} would be sent as ${quoted("xn--bcher-kva.test")}` },
  { name: "a short IPv4 address", written: "http://127.1:{port}/v1", difference: `its host ${quoted("127.1")} would be sent as ${quoted("127.0.0.1")}` },
  { name: "a trailing dot on an IPv4 address", written: "http://127.0.0.1.:{port}/v1", difference: `its host ${quoted("127.0.0.1.")} would be sent as ${quoted("127.0.0.1")}` },
  { name: "an uncompressed IPv6 address", written: "http://[0:0:0:0:0:0:0:1]:{port}/v1", difference: `its host ${quoted("[0:0:0:0:0:0:0:1]")} would be sent as ${quoted("[::1]")}` },
  { name: "a leading space", written: " http://gateway.test/v1", difference: "it is not written as scheme://host/path?query" },
  { name: "a trailing newline", written: "http://gateway.test/v1\n", difference: `its path ${quoted("/v1\n")} would be sent as ${quoted("/v1")}` },
  { name: "a fragment", written: "http://gateway.test/v1#part", difference: `its fragment ${quoted("#part")} is never sent` },
];
