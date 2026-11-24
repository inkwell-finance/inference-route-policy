// Table tests for the core's pure functions. Each test is one row: a function, its inputs, and the complete
// expected output, written out as a literal. The title is generated from the row alone, as
// `[tags] fn(inputs) => expected`, so it states exactly what the row compares and nothing more. An input that only
// the library can make (a parsed policy, parsed facts, published routes) is built when the test runs, by the code
// the title shows for it; no expected value is ever built by calling the library.

import assert from "node:assert/strict";
import { test } from "node:test";
import { COUNTRIES } from "../src/countries.ts";
import * as core from "../src/index.ts";

/** An input made by running code when the test runs, shown in the title as that code. */
export class Code {
  readonly code: string;
  readonly build: () => unknown;
  constructor(code: string, build: () => unknown) {
    this.code = code;
    this.build = build;
  }
}

/** An input that could not be built: the row then failed before calling its function. */
export class InputError extends Error {
  override readonly name = "InputError";
}

/** The expected result of a call that throws: the error's exact name and message. */
export class Throws {
  readonly name: string;
  readonly message: string;
  constructor(name: string, message: string) {
    this.name = name;
    this.message = message;
  }
}

export const throws = (name: string, message: string): Throws => new Throws(name, message);

/** Values shown by the name they are exported under, rather than by their contents. */
const names = new Map<unknown, string>([
  ...Object.entries(core).map(([name, value]): [unknown, string] => [value, name]),
  [COUNTRIES, "COUNTRIES"],
  [Object.keys, "Object.keys"],
  [Object.entries, "Object.entries"],
  [Object.isFrozen, "Object.isFrozen"],
]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const showKey = (key: string): string => (IDENTIFIER.test(key) && key !== "__proto__" ? key : `[${JSON.stringify(key)}]`);

/** An object's own enumerable members as the inside of an object literal. */
export const showMembers = (value: object): string => Object.entries(value).map(([key, member]) => `${showKey(key)}: ${show(member)}`).join(", ");

/** A value written in full as the code that makes it: no truncation, and no two different values written alike. */
export function show(value: unknown): string {
  if (value instanceof Code) return value.code;
  if (names.has(value)) return names.get(value)!;
  if (value instanceof Throws) return `throws ${value.name} ${JSON.stringify(value.message)}`;
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Object.is(value, -0) ? "-0" : String(value);
    case "undefined":
    case "boolean":
    case "bigint":
      return String(value);
    case "symbol":
      return value.toString();
    case "function": {
      const source = `(${String(value).replace(/\s+/g, " ")})`;
      return Object.keys(value).length === 0 ? source : `Object.assign(${source}, {${showMembers(value)}})`;
    }
  }
  if (value === null) return "null";
  if (value instanceof Map) return `new Map(${show([...value])})`;
  if (value instanceof Set) return `new Set(${show([...value])})`;
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) items.push(i in value ? show(value[i]) : "");
    return `[${items.join(", ")}${value.length > 0 && !(value.length - 1 in value) ? "," : ""}]`;
  }
  const object = value as object;
  const proto: unknown = Object.getPrototypeOf(object);
  const members = `{${showMembers(object)}}`;
  if (proto === Object.prototype) return members;
  const made = `Object.create(${proto === null ? "null" : show(proto)})`;
  return Object.keys(object).length === 0 ? made : `Object.assign(${made}, ${members})`;
}

/** A value as plain data: a Map as its entries, a Set as its members, in order; nothing else changes. */
export function plain(value: unknown): unknown {
  if (value instanceof Map) return [...value].map(([key, member]) => [plain(key), plain(member)]);
  if (value instanceof Set) return [...value].map(plain);
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, plain(member)]));
  }
  return value;
}

/** Builds every `Code` inside an input, leaving everything else, holes and prototypes included, as it is. */
function build(value: unknown): unknown {
  if (value instanceof Code) {
    try {
      return value.build();
    } catch (error) {
      throw new InputError(`the input ${value.code} could not be built`, { cause: error });
    }
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item: unknown) => {
      const made = build(item);
      changed ||= made !== item;
      return made;
    });
    return changed ? out : value;
  }
  if (value instanceof Map) {
    const entries = [...value].map(([key, member]): [unknown, unknown] => [build(key), build(member)]);
    return entries.some(([key, member], i) => key !== [...value.keys()][i] || member !== [...value.values()][i]) ? new Map(entries) : value;
  }
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value).map(([key, member]): [string, unknown] => [key, build(member)]);
    return entries.some(([key, member]) => member !== (value as Record<string, unknown>)[key]) ? Object.fromEntries(entries) : value;
  }
  return value;
}

/** One row: requirement ids proven by mutation (space-separated, or ""), the inputs, and the expected result. */
export type Row = readonly [tags: string, inputs: readonly unknown[], expected: unknown];

const titles = new Set<string>();

/**
 * One test per row: `fn(...inputs)` must equal the row's expected value, or throw exactly the error it names. With
 * `asPlainData`, the result is compared as plain data (`plain` above), and the title says so.
 */
// Any function fits `never[]` parameters. A row's inputs are not checked against them: a row may pass what a typed
// caller could not, as an untyped caller can, and the call below is the one place that relies on that.
export function table(fn: (...inputs: never[]) => unknown, rows: readonly Row[], { asPlainData = false } = {}): void {
  const call = fn as unknown as (...inputs: unknown[]) => unknown;
  for (const [tags, inputs, expected] of rows) {
    const ids = tags.split(" ").filter((id) => id !== "");
    const shown = `${show(fn)}(${inputs.map(show).join(", ")})`;
    const title = `${ids.length > 0 ? `[${ids.join(", ")}] ` : ""}${shown}${asPlainData && !(expected instanceof Throws) ? " as plain data" : ""} => ${show(expected)}`;
    if (titles.has(title)) throw new Error(`two rows have the title ${title}`);
    titles.add(title);
    test(title, () => {
      const args = inputs.map(build);
      if (expected instanceof Throws) {
        assert.throws(() => call(...args), { name: expected.name, message: expected.message });
        return;
      }
      const result = call(...args);
      assert.deepEqual(asPlainData ? plain(result) : result, expected);
    });
  }
}
