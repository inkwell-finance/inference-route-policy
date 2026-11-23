import assert from "node:assert/strict";
import { test } from "node:test";
import { describeHeld, heldFromEntry, heldFromEnv, holdPolicy } from "../src/held.ts";

test("C10: ROUTE_POLICY is the default held policy, and an invalid one is kept as invalid, never dropped", () => {
  assert.deepEqual(heldFromEnv({}), { kind: "none" });
  assert.deepEqual(heldFromEnv({ ROUTE_POLICY: "" }), { kind: "none" });
  const valid = heldFromEnv({ ROUTE_POLICY: "zdr+sort=price" });
  assert.equal(valid.kind, "policy");
  assert.equal(valid.kind === "policy" && valid.policy.zdr, true);
  const invalid = heldFromEnv({ ROUTE_POLICY: "zdr+zdr" });
  assert.equal(invalid.kind, "invalid");
  assert.match(describeHeld(invalid), /every request is blocked until it is fixed or cleared/);
});

test("C10: a stored entry restores the held policy, a cleared one restores none, and anything else is not an entry", () => {
  const restored = heldFromEntry({ policy: "notrain" });
  assert.deepEqual(restored?.kind === "policy" ? [restored.text, restored.source] : null, ["notrain", "session"]);
  assert.deepEqual(heldFromEntry({ policy: null }), { kind: "none" });
  assert.equal(heldFromEntry({ policy: "bits=0" })?.kind, "invalid");
  assert.equal(heldFromEntry({ policy: 3 }), null);
  assert.equal(heldFromEntry("notrain"), null);
  assert.equal(heldFromEntry(null), null);
});

test("C10: a policy the user sets is parsed by the grammar of this revision, whatever a gateway accepts", () => {
  assert.equal(holdPolicy("zdr+region=us,de", "session").kind, "policy");
  assert.equal(holdPolicy("region=eu", "session").kind, "invalid");
  assert.equal(holdPolicy("residency=eu", "session").kind, "invalid");
});
