// Behavior both adapters must show, run by each adapter's own test file against its own registration: the
// fail-closed boundary around every hook, and translation for OpenRouter.

import assert from "node:assert/strict";
import { test } from "node:test";
import { OPENROUTER_BASE } from "../src/openrouter.ts";
import type { FakeHarness } from "./fake-harness.ts";
import type { FakeGateway } from "./fixtures.ts";

const notices = (harness: FakeHarness): string[] => harness.shown.filter((s) => s.method === "notify").map((s) => s.text);

/** `ctx` with one accessor replaced by a getter that throws. */
function hostile(ctx: unknown, broken: string): object {
  assert.ok(typeof ctx === "object" && ctx !== null);
  return Object.defineProperty({ ...ctx }, broken, {
    get() {
      throw new Error(`${broken} unavailable`);
    },
  });
}

export function adapterContract(name: string, make: (policy?: string) => Promise<FakeHarness>, gateway: () => FakeGateway): void {
  test(`C1, C14: ${name}: a request that leaves with another key than the one its detection was read for is stopped at fetch`, async () => {
    const harness = await make("zdr");
    harness.wireKey = "demo-key-zdr";
    const result = await harness.request();
    assert.equal(result.sent, false);
    assert.match(result.error ?? "", /^Blocked by the route policy plugin, nothing was sent: this request to .* is not one the plugin checked: its key, model, or Route-Policy header differs/);
    assert.equal(gateway().inference().length, 0);
    assert.match(notices(harness).at(-1) ?? "", /^request blocked by the route policy plugin, nothing was sent: this request to .* is not one the plugin checked/, "the user is told");
    assert.deepEqual(
      [...new Set(gateway().requests.filter((r) => r.method === "GET").map((r) => r.headers.authorization))],
      ["Bearer demo-key"],
      "detection was read only for the key the registry reported",
    );
  });

  test(`C14: ${name}: a configured Authorization header is the key the plugin reads detection for, and the request with it goes`, async () => {
    const harness = await make("zdr");
    harness.model.headers = { Authorization: "Bearer demo-key-zdr" };
    harness.wireKey = "demo-key-zdr";
    assert.ok((await harness.request()).sent);
    assert.deepEqual([...new Set(gateway().requests.filter((r) => r.method === "GET").map((r) => r.headers.authorization))], ["Bearer demo-key-zdr"]);
    assert.equal(gateway().inference().length, 1);
  });

  for (const broken of ["ui", "model", "modelRegistry"]) {
    test(`C1: ${name}: a context whose ${broken} accessor throws gets a blocking payload, never a rejection`, async () => {
      const harness = await make("zdr");
      const healthy = harness.ctx.bind(harness);
      harness.ctx = () => hostile(healthy(), broken);
      const result = await harness.request();
      assert.equal(result.sent, false);
      assert.match(result.error ?? "", new RegExp(`^Blocked by the route policy plugin, nothing was sent: .*(${broken} unavailable|could not prepare the headers of a request in flight)`));
      assert.deepEqual(harness.handlerErrors, [], "no handler threw or rejected");
      assert.equal(gateway().inference().length, 0);
    });
  }

  test(`C1: ${name}: an event whose payload accessor throws gets a blocking payload`, async () => {
    const harness = await make("zdr");
    const [guard] = harness.handlers.get("before_provider_request") ?? [];
    assert.ok(guard !== undefined);
    const event = Object.defineProperty({ type: "before_provider_request" }, "payload", {
      get() {
        throw new Error("payload unavailable");
      },
    });
    const returned = await guard(event, harness.ctx());
    assert.throws(() => JSON.stringify(returned), /^Error: Blocked by the route policy plugin, nothing was sent: the plugin failed: payload unavailable$/);
  });

  test(`C8, C9: ${name}: for OpenRouter the policy is translated into its provider field, the suffix removed, and the result unconfirmed`, async () => {
    gateway().replies.detection = { status: 404 };
    const harness = await make("only=aurora");
    harness.model = { id: "vendor/model+sort=price", baseUrl: OPENROUTER_BASE, api: "openai-completions" };
    assert.ok((await harness.request({ model: harness.model.id, messages: [] })).sent);
    const [request] = gateway().inference();
    assert.deepEqual(JSON.parse(request?.body ?? "{}"), { model: "vendor/model", messages: [], provider: { only: ["aurora"], sort: "price" } });
    assert.equal(request?.headers["route-policy"], undefined);
    assert.match(notices(harness).at(-1) ?? "", /unconfirmed, not applied/);
  });

  test(`C9: ${name}: a policy OpenRouter has no hard filter for is not sent there`, async () => {
    gateway().replies.detection = { status: 404 };
    const harness = await make("notrain");
    harness.model = { id: "vendor/model", baseUrl: OPENROUTER_BASE, api: "openai-completions" };
    const result = await harness.request({ model: "vendor/model", messages: [] });
    assert.match(result.error ?? "", /notrain has no hard filter there/);
    assert.equal(gateway().inference().length, 0);
  });

  test(`C9: ${name}: an API whose OpenRouter endpoint does not document the provider field is not translated`, async () => {
    gateway().replies.detection = { status: 404 };
    const harness = await make("only=aurora");
    harness.model = { id: "vendor/model", baseUrl: OPENROUTER_BASE, api: "google-generative-ai" };
    const result = await harness.request({ model: "vendor/model", contents: [] });
    assert.match(result.error ?? "", /OpenRouter documents its provider field for openai-completions, openai-responses, anthropic-messages requests, not google-generative-ai/);
    assert.equal(gateway().inference().length, 0);
    // The Messages API is one of them.
    harness.model = { id: "vendor/model", baseUrl: OPENROUTER_BASE, api: "anthropic-messages" };
    assert.ok((await harness.request({ model: "vendor/model", messages: [], max_tokens: 1 })).sent);
  });
}
