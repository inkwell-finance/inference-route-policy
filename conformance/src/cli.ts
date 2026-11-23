import { parseArgs } from "node:util";
import { INFERENCE_ENDPOINTS, runConformance, type Endpoint } from "./suite.ts";

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { base: { type: "string" }, key: { type: "string" }, "policy-key": { type: "string" }, endpoints: { type: "string" } } });
    if (values.base === undefined) throw new Error("Usage: node conformance/src/cli.ts --base <url> [--key <k>] [--policy-key <k>] [--endpoints chat/completions,responses,messages]");
    const endpoints: Endpoint[] = [];
    for (const name of values.endpoints?.split(",") ?? INFERENCE_ENDPOINTS) {
      const endpoint = INFERENCE_ENDPOINTS.find((candidate) => candidate === name.trim());
      if (endpoint === undefined) throw new Error(`Unknown inference endpoint: ${name}`);
      endpoints.push(endpoint);
    }
    const report = await runConformance({ base: values.base, endpoints, ...(values.key === undefined ? {} : { key: values.key }), ...(values["policy-key"] === undefined ? {} : { policyKey: values["policy-key"] }) });
    for (const check of report.checks) console.log(`${check.status} ${check.id}${check.endpoint === undefined ? "" : ` [${check.endpoint}]`}: ${check.detail}`);
    console.log(`${report.passed} PASS, ${report.failed} FAIL, ${report.skipped} SKIP`);
    if (report.failed !== 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
