/**
 * Inference Route Policy for omp (oh-my-pi). Load it in place: `omp -e plugins/omp/src/index.ts`.
 *
 * omp's `before_provider_request` can replace the payload, but no omp handler can set a request header, so the
 * plugin carries its own policy in the model suffix, combined with any suffix the user typed (SPEC.md, Clients).
 */

import { registerRoutePlugin, type ExtensionAPI } from "../../shared/src/plugin.ts";

export default function routePolicy(pi: ExtensionAPI): void {
  registerRoutePlugin(pi, {
    headerHook: false,
    // omp rebuilds a session's entries on each of these.
    restoreEvents: ["session_start", "session_switch", "session_branch", "session_tree"],
    env: process.env,
  });
}
