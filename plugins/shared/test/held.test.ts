// The held policy (C10): what /route sets, what ROUTE_POLICY sets, what a stored entry restores, and how each is
// described. Each row is an input and the whole result, written out.

import { describeHeld, heldFromEntry, heldFromEnv, holdPolicy } from "../src/held.ts";
import { P, table } from "./table.ts";

table("", "holdPolicy", ([text, source]: [string, "session" | "env"]) => holdPolicy(text, source), [
  [["zdr+region=us,de", "session"], { kind: "policy", text: "zdr+region=us,de", policy: P({ zdr: true, region: ["us", "de"] }), source: "session" }],
  [["zdr+zdr", "session"], { kind: "invalid", text: "zdr+zdr", detail: "repeated key", source: "session" }],
  [["region=eu", "session"], { kind: "invalid", text: "region=eu", detail: "takes a list of assigned ISO 3166-1 alpha-2 codes", source: "session" }],
  [["residency=eu", "session"], { kind: "invalid", text: "residency=eu", detail: "key not accepted", source: "session" }],
  [["zdr+sort=price", "env"], { kind: "policy", text: "zdr+sort=price", policy: P({ zdr: true, sort: "price" }), source: "env" }],
  [["", "session"], { kind: "invalid", text: "", detail: "malformed key in \"\"", source: "session" }],
]);

table("", "heldFromEnv", (env: Record<string, string>) => heldFromEnv(env), [
  [{  }, { kind: "none" }],
  [{ ROUTE_POLICY: "" }, { kind: "none" }],
  [{ ROUTE_POLICY: "zdr+sort=price" }, { kind: "policy", text: "zdr+sort=price", policy: P({ zdr: true, sort: "price" }), source: "env" }],
  [{ ROUTE_POLICY: "zdr+zdr" }, { kind: "invalid", text: "zdr+zdr", detail: "repeated key", source: "env" }],
  [{ OTHER: "zdr" }, { kind: "none" }],
]);

table("", "heldFromEntry", heldFromEntry, [
  [{ policy: "notrain" }, { kind: "policy", text: "notrain", policy: P({ notrain: true }), source: "session" }],
  [{ policy: "zdr+sort=price" }, { kind: "policy", text: "zdr+sort=price", policy: P({ zdr: true, sort: "price" }), source: "session" }],
  [{ policy: null }, { kind: "none" }],
  [{ policy: "bits=0" }, { kind: "invalid", text: "bits=0", detail: "takes one integer from 1 to 64", source: "session" }],
  ["notrain", null],
  [7, null],
  [[], null],
  [null, null],
  [undefined, null],
  [{ policy: 3 }, null],
  [{ policy: ["notrain"] }, null],
  [{ policy: true }, null],
  [{ policy: {  } }, null],
  [{  }, null],
]);

/** A held policy as a row writes it: none, or the text and source it was held from. */
type HeldRow = { kind: "none" } | { text: string; source: "session" | "env" };
table("", "describeHeld", (row: HeldRow) => describeHeld("text" in row ? holdPolicy(row.text, row.source) : row), [
  [{ kind: "none" }, "none"],
  [{ text: "zdr", source: "session" }, "zdr (set in this session)"],
  [{ text: "zdr+sort=price", source: "env" }, "zdr+sort=price (from ROUTE_POLICY)"],
  [{ text: "zdr+zdr", source: "session" }, "\"zdr+zdr\" is not a valid policy (repeated key); every request is blocked until it is fixed or cleared"],
  [{ text: "bits=0", source: "env" }, "\"bits=0\" is not a valid policy (takes one integer from 1 to 64); every request is blocked until it is fixed or cleared"],
]);
