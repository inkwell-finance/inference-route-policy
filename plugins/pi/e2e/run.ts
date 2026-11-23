/**
 * Runs the real pi against the demo stack with this plugin loaded, in an isolated home and agent directory,
 * offline and without telemetry, and asserts the honored, refused, and blocked cases from outside: from pi's
 * RPC events and from the requests the demo's mock providers received. Writes `transcript.txt` beside this file;
 * exits nonzero on any failure.
 *
 *   node plugins/pi/e2e/run.ts
 *
 * `IRP_PI_CLI` names pi's `cli.js` when it should not be found through the `pi` launcher on PATH.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { REPO, runRealHarness } from "../../shared/e2e/harness.ts";

/**
 * pi's CLI script. `pi` on PATH is a launcher that runs the CLI of the installed release in a second process;
 * running that CLI directly keeps pi a direct child of this script, so it stops when its stdin closes.
 */
function piCli(): string {
  const configured = process.env["IRP_PI_CLI"];
  if (configured !== undefined) return configured;
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!existsSync(join(dir, "pi-launcher.js"))) continue;
    const install = join(dir, "..", "install");
    const release = join(install, "releases", readFileSync(join(install, "current-version"), "utf8").trim(), "node_modules", "@earendil-works", "pi-coding-agent");
    const manifest: unknown = JSON.parse(readFileSync(join(release, "package.json"), "utf8"));
    const bin = typeof manifest === "object" && manifest !== null && "bin" in manifest ? manifest.bin : undefined;
    const script = typeof bin === "string" ? bin : typeof bin === "object" && bin !== null && "pi" in bin ? bin.pi : undefined;
    if (typeof script === "string") return join(release, script);
  }
  throw new Error("pi was not found: put its launcher on PATH or set IRP_PI_CLI to its cli.js");
}

const cli = piCli();

await runRealHarness(
  {
    name: "pi",
    env: { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
    realConfig: [".pi/agent/settings.json", ".pi/agent/models.json", ".pi/agent/auth.json"],
    writeProviders: (agentDir, providers) => {
      const path = join(agentDir, "models.json");
      const entries = Object.entries(providers).map(([name, { baseUrl, apiKey }]) => [
        name,
        { baseUrl, api: "openai-completions", apiKey, models: [{ id: "demo-model", contextWindow: 32000, maxTokens: 1000 }] },
      ]);
      writeFileSync(path, `${JSON.stringify({ providers: Object.fromEntries(entries) }, null, 2)}\n`);
      return path;
    },
    launch: (provider, plugin) => ({
      command: process.execPath,
      args: [
        cli,
        "--mode", "rpc",
        "--model", `${provider}/demo-model`,
        // Only this plugin: no discovered extensions, skills, templates, or context files, no tools, no project trust.
        "--no-extensions", "-e", join(REPO, plugin === "shipped" ? "plugins/pi/src/index.ts" : "plugins/pi/e2e/faulty-plugin.ts"),
        "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-tools", "--no-approve", "--no-session",
      ],
    }),
  },
  join(REPO, "plugins/pi/e2e/transcript.txt"),
);
