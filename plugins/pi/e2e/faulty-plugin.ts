// The pi plugin as the e2e run loads it for its fault cases: the shipped entry, registered through an API whose
// request hooks get a context wrong in the way IRP_E2E_FAULT names. Used only by plugins/pi/e2e/run.ts, which
// sets that variable; nothing in the shipped plugin reads it.

import { withFault } from "../../shared/e2e/faulty.ts";
import type { ExtensionAPI } from "../../shared/src/plugin.ts";
import routePolicy from "../src/index.ts";

export default function faultyRoutePolicy(api: ExtensionAPI): void {
  routePolicy(withFault(api, process.env["IRP_E2E_FAULT"] === "key" ? "key" : "model"));
}
