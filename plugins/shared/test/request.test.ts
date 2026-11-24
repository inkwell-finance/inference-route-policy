// One test for each base URL in url-cases.ts: what place it names, and whether it can be used as written.
import assert from "node:assert/strict";
import { test } from "node:test";
import { placeOf } from "../src/request.ts";
import { PATH_QUERY_CASES, WHOLE_URL_CASES } from "./url-cases.ts";

const notAsWritten = (written: string, difference: string): string => `the base URL ${JSON.stringify(written)} cannot be used exactly as written: ${difference}; a policy is not sent anywhere else`;

for (const { path, query, sentPath, sentQuery, difference } of PATH_QUERY_CASES) {
  const written = `http://gateway.test${path}${query}`;
  const place = { base: `http://gateway.test${sentPath}`, query: sentQuery };
  if (difference === null) {
    test(`C14: ${JSON.stringify(written)} is used as written, as base ${place.base} and query ${JSON.stringify(sentQuery)}`, () => {
      assert.deepEqual(placeOf(written), { place, unexact: null });
    });
  } else {
    test(`C14: ${JSON.stringify(written)} is not used as written, because ${difference}`, () => {
      assert.deepEqual(placeOf(written), { place, unexact: notAsWritten(written, difference) });
    });
  }
}

for (const { written: template, difference } of WHOLE_URL_CASES) {
  const written = template.replace("{port}", "8080");
  if (difference === null) {
    test(`C14: ${JSON.stringify(written)} is used as written`, () => {
      assert.equal(placeOf(written)?.unexact, null);
    });
  } else {
    test(`C14: ${JSON.stringify(written)} is not used as written, because ${difference}`, () => {
      assert.equal(placeOf(written)?.unexact, notAsWritten(written, difference));
    });
  }
}

test("C14: HTTP://GATEWAY.TEST:80/v1/ is used as written, as base http://gateway.test/v1 and no query", () => {
  assert.deepEqual(placeOf("HTTP://GATEWAY.TEST:80/v1/"), { place: { base: "http://gateway.test/v1", query: "" }, unexact: null });
});

test("C14: http://gateway.test./v1 is used as written, as base http://gateway.test./v1 and no query", () => {
  assert.deepEqual(placeOf("http://gateway.test./v1"), { place: { base: "http://gateway.test./v1", query: "" }, unexact: null });
});

for (const written of ["http://user:secret@gateway.test/v1", "http://user@gateway.test/v1", "http://:secret@gateway.test/v1", "http://:p%40ss@gateway.test/v1", "not a url"]) {
  test(`C14: ${JSON.stringify(written)} is not a place fetch can send to`, () => {
    assert.equal(placeOf(written), null);
  });
}
