import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Check, Endpoint, Report } from "../src/suite.ts";

const globalChecks = ["G20", "G22", "G23"] as const;
const inferenceChecks = [
  "G1", "G2", "G3", "G6", "G7", "G8", "G9", "G10", "G11", "G12", "G13", "G15", "G17", "G19", "G21", "G24", "G25", "G26", "G29",
] as const;

type CheckName = (typeof globalChecks)[number] | `${(typeof inferenceChecks)[number]} [${Endpoint}]`;
type Status = Check["status"];
type Override = Status | readonly [Status, string];
export type Overrides = Readonly<Partial<Record<CheckName, Override>>>;

function entries(endpoints: readonly Endpoint[]) {
  const global = globalChecks.map((id) => ({ id }));
  const inference = endpoints.flatMap((endpoint) => inferenceChecks.map((id) => ({ id, endpoint })));
  return [...global, ...inference];
}

const nameOf = ({ id, endpoint }: Pick<Check, "id" | "endpoint">) => endpoint === undefined ? id : `${id} [${endpoint}]`;
const statusOf = (entry: Override | undefined) => typeof entry === "string" ? entry : entry?.[0] ?? "PASS";

export function baselineWith(overrides: Overrides, endpoints: readonly Endpoint[] = ["chat/completions"]) {
  const expected = entries(endpoints).map((check) => {
    const override = overrides[nameOf(check) as CheckName];
    return { ...check, status: statusOf(override), ...(typeof override === "object" ? { detail: override[1] } : {}) };
  });
  for (const key of Object.keys(overrides)) assert.ok(expected.some((check) => nameOf(check) === key), `invalid expectation: ${key}`);
  return expected;
}

export function expectReport(report: Report, expected: ReturnType<typeof baselineWith>) {
  const details = new Set(expected.filter((check) => check.detail !== undefined).map(nameOf));
  const actual = report.checks.map(({ detail, ...check }) => details.has(nameOf(check)) ? { ...check, detail } : check);
  const ordered = (a: Pick<Check, "id" | "endpoint">, b: Pick<Check, "id" | "endpoint">) => nameOf(a).localeCompare(nameOf(b));
  assert.deepEqual(actual.sort(ordered), expected.sort(ordered));
}

export function reportTest(description: string, overrides: Overrides, run: (t: TestContext, expected: ReturnType<typeof baselineWith>) => Promise<void>, endpoints?: readonly Endpoint[]) {
  const expected = baselineWith(overrides, endpoints);
  const rule = description.slice(0, description.indexOf(":"));
  const named = expected.filter(({ id }) => id === rule);
  assert.ok(named.length > 0 && named.every(({ detail }) => detail !== undefined), `missing exact detail for named rule: ${description}`);
  const verdicts = named.map((check) => `${nameOf(check)} ${check.status}`).join(", ");
  test(`${description} → ${verdicts}`, (t) => run(t, expected));
}

export function expectationsFor(cases: Readonly<Record<string, Overrides>>, key: string): Overrides {
  const selected = cases[key];
  assert.ok(selected !== undefined, `no literal report for ${key}`);
  return selected;
}

export function skip(missing: string): readonly ["SKIP", string] {
  return ["SKIP", `missing precondition: ${missing}`];
}

export function failure(sent: object, received: object | string, required: string): readonly ["FAIL", string] {
  return ["FAIL", `sent ${JSON.stringify(sent)}; received ${typeof received === "string" ? received : JSON.stringify(received)}; required: ${required}`];
}
