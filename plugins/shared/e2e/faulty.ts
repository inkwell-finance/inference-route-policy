/**
 * For the real-harness runs only: an extension API whose request hooks get a context that fails when the plugin
 * reads its model, as a broken harness context would. The runs load the plugin through it to show, in the real
 * harness, that a failure inside the plugin's guard blocks the request. Nothing here ships with the plugin.
 */

import type { ExtensionAPI } from "../src/plugin.ts";

const HOOKS = new Set(["before_provider_headers", "before_provider_request"]);

function failingModel(ctx: unknown): unknown {
  if (typeof ctx !== "object" || ctx === null) return ctx;
  return new Proxy(ctx, {
    get(target, property) {
      if (property === "model") throw new Error("model unavailable (injected by the e2e runner)");
      return Reflect.get(target, property);
    },
  });
}

export function withFailingModel(api: ExtensionAPI): ExtensionAPI {
  return {
    on: (event, handler) => api.on(event, HOOKS.has(event) ? (payload, ctx) => handler(payload, failingModel(ctx)) : handler),
    registerCommand: (name, options) => api.registerCommand(name, options),
    appendEntry: (customType, data) => api.appendEntry(customType, data),
  };
}
