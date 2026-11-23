/**
 * What both real-harness runs share: the demo stack, a proxy that withholds the model list, an isolated config
 * directory, an RPC session with the harness, and the transcript. Each run's own script says how to launch its
 * harness and what to write into its config.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Collects what the run did and saw, and writes it out even when an assertion fails. */
class Transcript {
  readonly #lines: string[] = [];
  readonly #path: string;
  constructor(path: string) {
    this.#path = path;
  }
  log(line: string): void {
    this.#lines.push(line);
    console.log(line);
  }
  save(): void {
    writeFileSync(this.#path, `${this.#lines.join("\n")}\n`);
  }
}

interface ProviderRequest {
  provider: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

interface DemoStack {
  /** The reference gateway, `{origin}/v1`. */
  gateway: string;
  /** The plain provider with no gateway in front, `{origin}/plain/v1`. */
  plain: string;
  /** The gateway behind a proxy that answers `GET /models` with 404 and passes everything else through. */
  withheld: string;
  /** Every request each mock provider received. */
  requests(): Promise<ProviderRequest[]>;
  clearRequests(): Promise<void>;
  stop(): Promise<void>;
}

/** Starts `node gateway/src/demo.ts` on a free port, and the list-withholding proxy in front of its gateway. */
async function startDemoStack(transcript: Transcript): Promise<DemoStack> {
  transcript.log("$ node gateway/src/demo.ts --port 0");
  const demo = spawn(process.execPath, [join(REPO, "gateway/src/demo.ts"), "--port", "0"], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  demo.stderr.on("data", (chunk: Buffer) => transcript.log(`demo stderr: ${chunk.toString().trimEnd()}`));
  let output = "";
  const origin = await new Promise<string>((resolveOrigin, reject) => {
    demo.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /Demo gateway: (http:\/\/127\.0\.0\.1:\d+)\/v1/.exec(output);
      if (match?.[1] !== undefined) resolveOrigin(match[1]);
    });
    demo.once("exit", (code) => reject(new Error(`the demo stack exited with ${code}: ${output}`)));
  });

  const upstream = new URL(origin);
  const proxy = createServer((incoming, outgoing) => {
    if (incoming.method === "GET" && incoming.url?.endsWith("/models")) {
      outgoing.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "model list withheld" } }));
      return;
    }
    const forward = httpRequest({ host: upstream.hostname, port: upstream.port, method: incoming.method, path: incoming.url, headers: incoming.headers }, (reply) => {
      outgoing.writeHead(reply.statusCode ?? 502, reply.rawHeaders);
      reply.pipe(outgoing);
    });
    forward.on("error", () => outgoing.destroy());
    incoming.pipe(forward);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  assert.ok(address !== null && typeof address === "object", "a TCP server has an address");
  const stack = {
    gateway: `${origin}/v1`,
    plain: `${origin}/plain/v1`,
    withheld: `http://127.0.0.1:${address.port}/v1`,
  };
  transcript.log(`demo stack: gateway ${stack.gateway}; plain provider ${stack.plain}; gateway with its model list withheld ${stack.withheld}`);

  return {
    ...stack,
    requests: async () => {
      const log: unknown = await (await fetch(`${origin}/__demo/requests`)).json();
      assert.ok(Array.isArray(log), "the demo request log is a JSON array");
      return log;
    },
    clearRequests: async () => {
      await fetch(`${origin}/__demo/requests`, { method: "DELETE" });
    },
    stop: async () => {
      proxy.closeAllConnections();
      proxy.close();
      const exited = once(demo, "exit");
      demo.kill();
      await exited;
    },
  };
}

/** A fresh home, agent directory, and working directory under the system temp directory. */
interface Sandbox {
  root: string;
  home: string;
  agentDir: string;
  cwd: string;
  /** This process's environment minus every harness and session variable, with home and agent dir in the sandbox. */
  env: Record<string, string>;
  remove(): void;
}

// Variables through which a harness finds its user configuration or a parent session; none may reach the run.
const SCRUBBED = /^(PI_|OMP_|TERN_|CLAUDE)/i;

function createSandbox(name: string, extra: Record<string, string>): Sandbox {
  const root = mkdtempSync(join(tmpdir(), `irp-e2e-${name}-`));
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  for (const dir of [home, agentDir, cwd]) mkdirSync(dir, { recursive: true });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !SCRUBBED.test(key)) env[key] = value;
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    PI_CODING_AGENT_DIR: agentDir,
    ...extra,
  });
  return { root, home, agentDir, cwd, env, remove: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Size and modification time of the user's real harness config files, by path under the real home directory.
 * Taken before and after a run to show the run changed none of them; their contents are never read.
 */
function realConfigStat(files: readonly string[]): Map<string, string> {
  const stats = new Map<string, string>();
  for (const path of files.map((file) => join(homedir(), file))) {
    let stat: string;
    try {
      const { size, mtimeMs } = statSync(path);
      stat = `${size} bytes, modified ${mtimeMs}`;
    } catch {
      stat = "absent";
    }
    stats.set(path, stat);
  }
  return stats;
}

/** One line a harness printed in RPC mode, parsed. */
type RpcLine = Record<string, unknown>;

const isRpcLine = (value: unknown): value is RpcLine => typeof value === "object" && value !== null && !Array.isArray(value);

/** A harness running in RPC mode: JSON commands on stdin, JSON events on stdout. */
class RpcSession {
  readonly lines: RpcLine[] = [];
  readonly #child;
  readonly #waiters = new Set<() => void>();
  readonly #transcript: Transcript;

  constructor(command: string, args: readonly string[], sandbox: Sandbox, transcript: Transcript) {
    this.#transcript = transcript;
    transcript.log(`$ ${[command, ...args].join(" ")}   (cwd ${sandbox.cwd}; HOME, USERPROFILE, APPDATA, LOCALAPPDATA, PI_CODING_AGENT_DIR in ${sandbox.root})`);
    this.#child = spawn(command, args, { cwd: sandbox.cwd, env: sandbox.env, stdio: ["pipe", "pipe", "pipe"] });
    let buffered = "";
    this.#child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      let end: number;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const text = buffered.slice(0, end).trim();
        buffered = buffered.slice(end + 1);
        if (text === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          transcript.log(`  harness stdout: ${text}`);
          continue;
        }
        if (!isRpcLine(parsed)) continue;
        this.lines.push(parsed);
        for (const waiter of this.#waiters) waiter();
      }
    });
    this.#child.stderr.on("data", (chunk: Buffer) => {
      for (const text of chunk.toString().split("\n")) if (text.trim() !== "") transcript.log(`  harness stderr: ${text.trim()}`);
    });
  }

  send(command: Record<string, unknown>): void {
    this.#transcript.log(`  -> ${JSON.stringify(command)}`);
    this.#child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  /** Resolves with the first line, from index `from` on, that `match` accepts. */
  async waitFor(match: (line: RpcLine) => boolean, from: number, timeoutMs: number, what: string): Promise<RpcLine> {
    return new Promise((resolveLine, reject) => {
      const check = (): void => {
        const found = this.lines.slice(from).find(match);
        if (found === undefined) return;
        this.#waiters.delete(check);
        clearTimeout(timer);
        resolveLine(found);
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(check);
        reject(new Error(`timed out after ${timeoutMs} ms waiting for ${what}`));
      }, timeoutMs);
      this.#waiters.add(check);
      check();
    });
  }

  async close(): Promise<void> {
    const exited = once(this.#child, "exit");
    this.#child.stdin.end();
    const timer = setTimeout(() => this.#child.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }
}

/** How to run one harness: its config format and its command line. */
export interface HarnessSpec {
  name: string;
  /** Environment beyond the sandbox's, keeping the harness offline and quiet. */
  env: Record<string, string>;
  /** The user config files of this harness, relative to the home directory, whose stat the run compares. */
  realConfig: readonly string[];
  /** Writes one provider per entry, each serving `demo-model`; returns the path written. */
  writeProviders(agentDir: string, providers: Readonly<Record<string, { baseUrl: string; apiKey: string }>>): string;
  /** The command that starts the harness in RPC mode on `<provider>/demo-model` with the plugin loaded. */
  launch(provider: string): { command: string; args: string[] };
}

const ui = (line: RpcLine, method: string): boolean => line["type"] === "extension_ui_request" && line["method"] === method;
const text = (line: RpcLine): string => String(line["message"] ?? line["statusText"] ?? "");

/** One prompt's run: what the plugin showed, and what the provider mocks received. */
interface Observed {
  shown: RpcLine[];
  requests: ProviderRequest[];
}

interface Case {
  name: string;
  provider: string;
  policy: string;
  /** Checks what was observed; returns the failures. */
  check(observed: Observed): string[];
}

function expectShown(observed: Observed, method: string, pattern: RegExp): string[] {
  return observed.shown.some((line) => ui(line, method) && pattern.test(text(line))) ? [] : [`expected a ${method} matching ${pattern}`];
}

function expectNoProviderContent(observed: Observed): string[] {
  return observed.requests.length === 0 ? [] : [`expected no request at any provider, got ${observed.requests.length}`];
}

const CASES: readonly Case[] = [
  {
    name: "(a) honored: zdr through the gateway, checked against the model list",
    provider: "gateway",
    policy: "zdr",
    check: (observed) => {
      const failures = expectShown(observed, "setStatus", /^route policy honored: served by aurora; its published facts meet the policy/);
      if (observed.shown.some((line) => ui(line, "notify") && /route policy (NOT honored|refused)|blocked/.test(text(line)))) failures.push("expected no warning");
      const [only] = observed.requests;
      if (observed.requests.length !== 1 || only === undefined) return [...failures, `expected exactly one provider request, got ${observed.requests.length}`];
      if (only.provider !== "aurora") failures.push(`expected aurora to serve, got ${only.provider}`);
      const model = typeof only.body === "object" && only.body !== null && "model" in only.body ? only.body.model : undefined;
      if (model !== "demo-model") failures.push(`expected the provider to see model "demo-model" with no suffix, got ${JSON.stringify(model)}`);
      if (Object.keys(only.headers).some((name) => name.toLowerCase() === "route-policy")) failures.push("expected no Route-Policy header at the provider");
      return failures;
    },
  },
  {
    name: "(b) refused before sending: only=nosuch with the model list held (C16)",
    provider: "gateway",
    policy: "only=nosuch",
    check: (observed) => [
      ...expectShown(observed, "notify", /^request blocked by the route policy plugin, nothing was sent: no route the model list publishes for demo-model meets the policy/),
      ...expectNoProviderContent(observed),
    ],
  },
  {
    name: "(b) refused by the gateway: only=nosuch with the model list withheld",
    provider: "withheld",
    policy: "only=nosuch",
    check: (observed) => [...expectShown(observed, "notify", /^route policy refused by the gateway: unsatisfiable$/), ...expectNoProviderContent(observed)],
  },
  {
    name: "(c) blocked: zdr against a base URL with no detection (the plain provider)",
    provider: "plain",
    policy: "zdr",
    check: (observed) => [
      ...expectShown(observed, "notify", /^request blocked by the route policy plugin, nothing was sent: .*\/plain\/v1 has no valid detection reply/),
      ...expectNoProviderContent(observed),
    ],
  },
];

async function runCase(spec: HarnessSpec, sandbox: Sandbox, stack: DemoStack, transcript: Transcript, test: Case): Promise<string[]> {
  transcript.log(`\n== ${test.name}`);
  const { command, args } = spec.launch(test.provider);
  const session = new RpcSession(command, args, sandbox, transcript);
  const shownFrom = (from: number): RpcLine[] => session.lines.slice(from).filter((line) => ui(line, "notify") || ui(line, "setStatus"));
  const log = (lines: RpcLine[]): void => {
    for (const line of lines) transcript.log(`  <- ${line["method"]}: ${text(line).replaceAll("\n", "\n     ")}`);
  };
  try {
    let from = 0;
    session.send({ id: "set", type: "prompt", message: `/route ${test.policy}` });
    await session.waitFor((line) => ui(line, "notify") && text(line) === `Route policy set: ${test.policy}`, from, 60_000, "the /route confirmation");
    session.send({ id: "show", type: "prompt", message: "/route" });
    await session.waitFor((line) => ui(line, "notify") && text(line).startsWith("Route policy:"), from, 30_000, "the /route status");
    log(shownFrom(from));

    await stack.clearRequests();
    from = session.lines.length;
    session.send({ id: "ask", type: "prompt", message: "Say hello." });
    const end = await session.waitFor((line) => line["type"] === "agent_end", from, 60_000, "the end of the turn");
    // A result shown from the response can trail the end of the turn by a moment.
    await new Promise((settle) => setTimeout(settle, 1000));
    const messages = Array.isArray(end["messages"]) ? end["messages"] : [];
    const last: unknown = messages.at(-1);
    if (typeof last === "object" && last !== null) {
      const reply = "errorMessage" in last && typeof last.errorMessage === "string" && last.errorMessage !== "" ? `error: ${last.errorMessage}` : JSON.stringify("content" in last ? last.content : null);
      transcript.log(`  turn ended; last assistant message: ${reply}`);
    }
    const observed: Observed = { shown: shownFrom(from), requests: await stack.requests() };
    log(observed.shown);
    transcript.log(`  GET /__demo/requests: ${JSON.stringify(observed.requests.map((r) => ({ provider: r.provider, path: r.path, model: typeof r.body === "object" && r.body !== null && "model" in r.body ? r.body.model : null })))}`);
    const failures = test.check(observed);
    transcript.log(failures.length === 0 ? "  PASS" : failures.map((failure) => `  FAIL: ${failure}`).join("\n"));
    return failures;
  } catch (error) {
    transcript.log(`  FAIL: ${error instanceof Error ? error.message : String(error)}`);
    log(session.lines.filter((line) => ui(line, "notify") || ui(line, "setStatus")));
    return [String(error)];
  } finally {
    await session.close();
  }
}

/**
 * Runs the three cases against the real harness and writes the transcript next to the calling script. Sets the
 * exit code: nonzero when any assertion failed.
 */
export async function runRealHarness(spec: HarnessSpec, transcriptPath: string): Promise<void> {
  const transcript = new Transcript(transcriptPath);
  transcript.log(`Inference Route Policy: real ${spec.name} against the demo stack (${new Date().toISOString()})`);
  const before = realConfigStat(spec.realConfig);
  const stack = await startDemoStack(transcript);
  const sandbox = createSandbox(spec.name, spec.env);
  let failures = 0;
  try {
    const written = spec.writeProviders(sandbox.agentDir, {
      gateway: { baseUrl: stack.gateway, apiKey: "demo-key-zdr" },
      withheld: { baseUrl: stack.withheld, apiKey: "demo-key-zdr" },
      plain: { baseUrl: stack.plain, apiKey: "demo-key" },
    });
    transcript.log(`isolated config: ${written} (providers gateway, withheld, plain; key demo-key-zdr carries the key policy zdr)`);
    for (const test of CASES) failures += (await runCase(spec, sandbox, stack, transcript, test)).length;
    transcript.log(`\nfiles the harness wrote in its sandbox agent directory: ${readdirSync(sandbox.agentDir).join(", ")}`);
  } finally {
    await stack.stop();
    sandbox.remove();
  }
  const after = realConfigStat(spec.realConfig);
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path));
  transcript.log(`real ${spec.name} config files compared by size and mtime: ${before.size}; changed: ${changed.length === 0 ? "none" : changed.join(", ")}`);
  failures += changed.length;
  transcript.log(failures === 0 ? "\nRESULT: all cases passed" : `\nRESULT: ${failures} failed assertion(s)`);
  transcript.save();
  process.exitCode = failures === 0 ? 0 : 1;
}
