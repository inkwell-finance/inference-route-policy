// The omp plugin as the e2e run loads it for its failure case: the shipped entry, registered through an API whose
// request hooks get a context that fails on `model`. Used only by plugins/omp/e2e/run.ts.

import { withFailingModel } from "../../shared/e2e/faulty.ts";
import type { ExtensionAPI } from "../../shared/src/plugin.ts";
import routePolicy from "../src/index.ts";

export default function faultyRoutePolicy(api: ExtensionAPI): void {
  routePolicy(withFailingModel(api));
}
