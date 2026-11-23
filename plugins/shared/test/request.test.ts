import assert from "node:assert/strict";
import { test } from "node:test";
import { placeOf } from "../src/request.ts";
import { PATH_QUERY_CASES, WHOLE_URL_CASES } from "./url-cases.ts";

const unexactOf = (written: string): string | null => {
  const read = placeOf(written);
  assert.ok(read !== null, written);
  return read.unexact;
};

test("C14: a base URL whose path or query the parser would send otherwise than written is not used as written, each character class named with what would be sent; its encoded control is", () => {
  for (const { name, path, query, sentPath, sentQuery, difference } of PATH_QUERY_CASES) {
    const written = `http://gateway.test${path}${query}`;
    const read = placeOf(written);
    assert.ok(read !== null, name);
    assert.deepEqual(read.place, { base: `http://gateway.test${sentPath}`, query: sentQuery }, name);
    if (difference === null) assert.equal(read.unexact, null, name);
    else assert.equal(read.unexact, `the base URL ${JSON.stringify(written)} cannot be used exactly as written: ${difference}; a policy is not sent anywhere else`, name);
  }
});

test("C14: scheme and host case, a default or empty port are the same base URL (RFC 3986, 6.2.2.1 and 6.2.3); another spelling of a host, surrounding whitespace, or a fragment is not", () => {
  for (const { name, written, difference } of WHOLE_URL_CASES) {
    const unexact = unexactOf(written.replace("{port}", "8080"));
    if (difference === null) assert.equal(unexact, null, name);
    else assert.match(unexact ?? "", new RegExp(`cannot be used exactly as written: ${difference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; `), name);
  }
  assert.deepEqual(placeOf("HTTP://GATEWAY.TEST:80/v1/")?.place, { base: "http://gateway.test/v1", query: "" });
  assert.deepEqual(placeOf("http://gateway.test./v1")?.place, { base: "http://gateway.test./v1", query: "" }, "a domain's trailing dot is kept, as it is sent");
});

test("C14: a base URL with credentials in it is not a place fetch can send to", () => {
  assert.equal(placeOf("http://user:secret@gateway.test/v1"), null);
  assert.equal(placeOf("http://user@gateway.test/v1"), null);
  assert.equal(placeOf("not a url"), null);
});
