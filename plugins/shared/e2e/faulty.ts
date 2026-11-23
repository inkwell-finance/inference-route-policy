/**
 * For the real-harness runs only: an extension API whose request hooks get a context that is wrong in one way,
 * as a broken or misleading harness would hand it over. The runs load the plugin through it to show, in the real
 * harness, that such a request is blocked. Nothing here ships with the plugin.
 *
 * - `model`: reading the context's model throws, so the plugin fails inside its guard.
 * - `key`: the registry reports another key than the one the harness then puts on the wire, so the plugin checks
 *   detection for a key the request does not carry, and only the fetch gate can notice.
 */

import type { ExtensionAPI } from "../src/plugin.ts";

const HOOKS = new Set(["before_provider_headers", "before_provider_request"]);

export type Fault = "model" | "key";

/** The key the `key` fault reports instead of the configured one. */
export const MISREPORTED_KEY = "demo-key";

function faulty(ctx: unknown, fault: Fault): unknown {
  if (typeof ctx !== "object" || ctx === null) return ctx;
  return new Proxy(ctx, {
    get(target, property) {
      if (fault === "model" && property === "model") throw new Error("model unavailable (injected by the e2e runner)");
      const value: unknown = Reflect.get(target, property);
      if (fault !== "key" || property !== "modelRegistry" || typeof value !== "object" || value === null) return value;
      return {
        getApiKeyAndHeaders: async (model: unknown): Promise<unknown> => {
          const resolve: unknown = Reflect.get(value, "getApiKeyAndHeaders");
          const auth: unknown = typeof resolve === "function" ? await resolve.call(value, model) : undefined;
          return typeof auth === "object" && auth !== null ? { ...auth, apiKey: MISREPORTED_KEY } : auth;
        },
      };
    },
  });
}

export function withFault(api: ExtensionAPI, fault: Fault): ExtensionAPI {
  return {
    on: (event, handler) => api.on(event, HOOKS.has(event) ? (payload, ctx) => handler(payload, faulty(ctx, fault)) : handler),
    registerCommand: (name, options) => api.registerCommand(name, options),
    appendEntry: (customType, data) => api.appendEntry(customType, data),
  };
}
