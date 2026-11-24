import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePolicy, type Policy } from "../../../core/src/index.ts";
import { describeHeld, heldFromEntry, heldFromEnv, holdPolicy } from "../src/held.ts";

const parsed = (text: string): Policy => {
  const result = parsePolicy(text);
  assert.ok(result.ok, text);
  return result.value;
};

test("C10: with ROUTE_POLICY unset, heldFromEnv holds no policy", () => {
  assert.deepEqual(heldFromEnv({}), { kind: "none" });
});

test("C10: with ROUTE_POLICY empty, heldFromEnv holds no policy", () => {
  assert.deepEqual(heldFromEnv({ ROUTE_POLICY: "" }), { kind: "none" });
});

test("C10: with ROUTE_POLICY=zdr+sort=price, heldFromEnv holds zdr+sort=price from the environment", () => {
  assert.deepEqual(heldFromEnv({ ROUTE_POLICY: "zdr+sort=price" }), { kind: "policy", text: "zdr+sort=price", policy: parsed("zdr+sort=price"), source: "env" });
});

test("C10: with ROUTE_POLICY=zdr+zdr, heldFromEnv holds zdr+zdr as invalid from the environment", () => {
  const held = heldFromEnv({ ROUTE_POLICY: "zdr+zdr" });
  assert.deepEqual(held.kind === "invalid" ? [held.kind, held.text, held.source] : held, ["invalid", "zdr+zdr", "env"]);
});

test('C10: an invalid held zdr+zdr is described as "every request is blocked until it is fixed or cleared"', () => {
  const held = heldFromEnv({ ROUTE_POLICY: "zdr+zdr" });
  assert.ok(held.kind === "invalid");
  assert.equal(describeHeld(held), `"zdr+zdr" is not a valid policy (${held.detail}); every request is blocked until it is fixed or cleared`);
});

for (const text of ["notrain", "zdr+sort=price"]) {
  test(`C10: the stored entry {policy: "${text}"} restores ${text} as set in the session`, () => {
    assert.deepEqual(heldFromEntry({ policy: text }), { kind: "policy", text, policy: parsed(text), source: "session" });
  });
}

test("C10: the stored entry {policy: null} restores no policy", () => {
  assert.deepEqual(heldFromEntry({ policy: null }), { kind: "none" });
});

test('C10: the stored entry {policy: "bits=0"} restores bits=0 as invalid', () => {
  const held = heldFromEntry({ policy: "bits=0" });
  assert.deepEqual(held?.kind === "invalid" ? [held.kind, held.text, held.source] : held, ["invalid", "bits=0", "session"]);
});

for (const [name, value] of [
  ["{policy: 3}", { policy: 3 }],
  ["{policy: true}", { policy: true }],
  ['{policy: ["notrain"]}', { policy: ["notrain"] }],
  ["{policy: {}}", { policy: {} }],
  ["{}", {}],
  ["[]", []],
  ['"notrain"', "notrain"],
  ["7", 7],
  ["null", null],
  ["undefined", undefined],
] as const) {
  test(`C10: the stored value ${name} is not an entry`, () => {
    assert.equal(heldFromEntry(value), null);
  });
}

test("C10: holdPolicy holds zdr+region=us,de with both regions", () => {
  assert.deepEqual(holdPolicy("zdr+region=us,de", "session"), { kind: "policy", text: "zdr+region=us,de", policy: parsed("zdr+region=us,de"), source: "session" });
  assert.deepEqual(parsed("zdr+region=us,de").region, ["us", "de"]);
});

for (const text of ["region=eu", "residency=eu", "zdr+zdr"]) {
  test(`C10: holdPolicy holds ${text} as invalid`, () => {
    const held = holdPolicy(text, "session");
    assert.deepEqual(held.kind === "invalid" ? [held.kind, held.text, held.source] : held, ["invalid", text, "session"]);
  });
}
