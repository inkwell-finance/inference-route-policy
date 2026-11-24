// Table tests for pure functions: each row an input literal and the complete expected output literal, the title
// generated from both, so it says no more than the row pins. What is compared, and printed, is the output as plain
// data (`plain` below), and the title says so.

import assert from "node:assert/strict";
import { test } from "node:test";
import { brief } from "./wire.ts";

/** A value as plain data: a Map as its entries, a Set as its members, in order; nothing else changes. */
export function plain(value: unknown): unknown {
  if (value instanceof Map) return [...value].map(([key, v]) => [plain(key), plain(v)]);
  if (value instanceof Set) return [...value].map(plain);
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, plain(v)]));
  return value;
}

/** A value in a table title, in full: strings quoted, so no two different values print alike. */
const literal = (value: unknown): string => (typeof value === "string" ? JSON.stringify(value) : brief(value, Infinity));

/** One test per row: `run(input)`, as plain data, must equal the row's expected value. */
export function table<I>(ids: string, fn: string, run: (input: I) => unknown, rows: readonly (readonly [I, unknown])[]): void {
  for (const [input, want] of rows) {
    test(`${ids === "" ? "" : `${ids}: `}${fn}(${literal(input)}) as plain data => ${literal(want)}`, async () => {
      assert.deepEqual(plain(await run(input)), want);
    });
  }
}

/** A source list must be exactly the members a table spans, so removing one fails here, not silently there. */
export function sameList(ids: string, name: string, actual: unknown, want: unknown): void {
  test(`${ids === "" ? "" : `${ids}: `}${name} as plain data is ${literal(want)}`, () => {
    assert.deepEqual(plain(actual), want);
  });
}

/** An expected policy, written as the fields that differ from a policy with nothing in it. */
export function P(fields: { zdr?: boolean; notrain?: boolean; bits?: number | null; region?: string[] | null; attest?: string[]; only?: string[] | null; ignore?: string[]; sort?: string | null; order?: string[] | null }): Record<string, unknown> {
  return { zdr: false, notrain: false, bits: null, region: null, attest: [], only: null, ignore: [], sort: null, order: null, ...fields };
}

/** Expected published facts, written as the fields that differ from facts that claim nothing. */
export function F(fields: { zdr?: boolean; notrain?: boolean; bits?: number | null; region?: string[] | null; attest?: string[] }): Record<string, unknown> {
  return { zdr: false, notrain: false, bits: null, region: null, attest: [], ...fields };
}

