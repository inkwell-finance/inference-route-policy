import { startDemo } from "../../gateway/src/demo.ts";
import { runConformance } from "./suite.ts";

/**
 * Runs the conformance suite against the reference gateway's demo stack, over real HTTP on a free port, and exits
 * nonzero on any failed or skipped check: the demo stack has every precondition, so a skip there is a defect.
 */
if (import.meta.main) {
  const { server, base } = await startDemo(0);
  try {
    const report = await runConformance({ base: `${base}/v1`, key: "demo-key", policyKey: "demo-key-zdr", endpoints: ["chat/completions", "responses", "messages"] });
    for (const check of report.checks) console.log(`${check.status} ${check.id}${check.endpoint === undefined ? "" : ` [${check.endpoint}]`}: ${check.detail}`);
    console.log(`${report.passed} PASS, ${report.failed} FAIL, ${report.skipped} SKIP`);
    if (report.failed !== 0 || report.skipped !== 0) process.exitCode = 1;
  } finally {
    server.close();
    server.closeAllConnections();
  }
}
