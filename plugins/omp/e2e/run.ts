/**
 * Runs the real omp against the demo stack with this plugin loaded, in an isolated home and agent directory,
 * and asserts the honored, refused, and blocked cases from outside: from omp's RPC events and from the requests
 * the demo's mock providers received. Writes `transcript.txt` beside this file; exits nonzero on any failure.
 *
 *   node plugins/omp/e2e/run.ts
 *
 * `IRP_OMP_BIN` names the omp executable when `omp` is not on PATH.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, runRealHarness } from "../../shared/e2e/harness.ts";

const omp = process.env["IRP_OMP_BIN"] ?? "omp";

await runRealHarness(
  {
    name: "omp",
    env: {},
    realConfig: [".omp/agent/config.yml", ".omp/agent/models.yml", ".omp/agent/settings.json"],
    writeProviders: (agentDir, providers) => {
      const path = join(agentDir, "models.yml");
      const entries = Object.entries(providers).map(
        ([name, { baseUrl, apiKey }]) =>
          `  ${name}:\n    baseUrl: ${baseUrl}\n    apiKey: ${apiKey}\n    api: openai-completions\n    models:\n` +
          `      - id: demo-model\n        name: Demo\n        reasoning: false\n        input: [text]\n        contextWindow: 32000\n        maxTokens: 1000\n` +
          `        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }\n`,
      );
      writeFileSync(path, `providers:\n${entries.join("")}`);
      return path;
    },
    launch: (provider, plugin) => ({
      command: omp,
      args: [
        "--mode", "rpc",
        "--model", `${provider}/demo-model`,
        // Only this plugin: no discovered extensions, skills, rules, or context files, no tools, no title request.
        "--no-extensions", "-e", join(REPO, plugin === "shipped" ? "plugins/omp/src/index.ts" : "plugins/omp/e2e/faulty-plugin.ts"),
        "--no-skills", "--no-rules", "--no-context-files", "--no-tools", "--no-title", "--no-session",
      ],
    }),
  },
  join(REPO, "plugins/omp/e2e/transcript.txt"),
);
