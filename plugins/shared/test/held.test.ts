import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePolicy, type Policy } from "../../../core/src/index.ts";
import { describeHeld, heldFromEntry, heldFromEnv, holdPolicy } from "../src/held.ts";

const parsed = (text: string): Policy => {
  const result = parsePolicy(text);
  assert.ok(result.ok, text);
  return result.value;
};

test("C10: ROUTE_POLICY is the default held policy, and an invalid one is kept as invalid, never dropped", () => {
  assert.deepEqual(heldFromEnv({}), { kind: "none" });
  assert.deepEqual(heldFromEnv({ ROUTE_POLICY: "" }), { kind: "none" });
  // The whole policy is held, its preferences as well as its requirements, as text and as parsed.
  assert.deepEqual(heldFromEnv({ ROUTE_POLICY: "zdr+sort=price" }), { kind: "policy", text: "zdr+sort=price", policy: parsed("zdr+sort=price"), source: "env" });
  const invalid = heldFromEnv({ ROUTE_POLICY: "zdr+zdr" });
  assert.deepEqual(invalid.kind === "invalid" ? [invalid.text, invalid.source] : invalid, ["zdr+zdr", "env"]);
  assert.match(describeHeld(invalid), /every request is blocked until it is fixed or cleared/);
});

test("C10: a stored entry restores the held policy, a cleared one restores none, and anything else is not an entry", () => {
  // Restored as the policy it names, not only as text.
  assert.deepEqual(heldFromEntry({ policy: "notrain" }), { kind: "policy", text: "notrain", policy: parsed("notrain"), source: "session" });
  assert.deepEqual(heldFromEntry({ policy: "zdr+bits=8" }), { kind: "policy", text: "zdr+bits=8", policy: parsed("zdr+bits=8"), source: "session" });
  assert.deepEqual(heldFromEntry({ policy: null }), { kind: "none" });
  assert.equal(heldFromEntry({ policy: "bits=0" })?.kind, "invalid");
  for (const other of [{ policy: 3 }, { policy: true }, { policy: ["notrain"] }, { policy: {} }, {}, [], "notrain", 7, null, undefined]) {
    assert.equal(heldFromEntry(other), null, JSON.stringify(other) ?? "undefined");
  }
});

test("C10: a policy the user sets is parsed by the grammar of this revision, whatever a gateway accepts", () => {
  const held = holdPolicy("zdr+region=us,de", "session");
  assert.ok(held.kind === "policy");
  assert.deepEqual([held.policy.zdr, held.policy.region], [true, ["us", "de"]], "both regions, as set");
  assert.deepEqual(held.policy, parsed("zdr+region=us,de"));
  assert.equal(holdPolicy("region=eu", "session").kind, "invalid");
  assert.equal(holdPolicy("residency=eu", "session").kind, "invalid");
});
