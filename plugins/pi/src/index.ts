/**
 * Inference Route Policy for pi. Load it in place: `pi -e plugins/pi/src/index.ts`.
 *
 * pi's `before_provider_headers` lets a handler set request headers, so the plugin sends its own policy as the
 * `Route-Policy` header and leaves a suffix the user typed in the model id as typed (SPEC.md, Clients).
 */

import { registerRoutePlugin, type ExtensionAPI } from "../../shared/src/plugin.ts";

export default function routePolicy(pi: ExtensionAPI): void {
  registerRoutePlugin(pi, {
    headerHook: true,
    // pi starts a session (new, resumed, or forked) with `session_start`, and moves within one with `session_tree`.
    restoreEvents: ["session_start", "session_tree"],
    env: process.env,
  });
}
