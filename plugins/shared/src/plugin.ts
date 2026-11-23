/**
 * The plugin as both harnesses load it: a `/route` command, a guard on every outgoing provider request, and a
 * report of every response. omp and pi expose the same extension API names for all of this; they differ in
 * whether a handler may set request headers, which `headerHook` says.
 *
 * Blocking happens in two places. Both harnesses catch an error thrown from `before_provider_request`, or a
 * rejected handler, and send the request with the payload it had, so neither blocks; what does is the payload:
 * the handler returns one whose JSON serialization throws, which stops the transport before it opens a
 * connection. Every handler that shapes a request runs whole inside a boundary whose failure path returns that
 * payload. Then, at `fetch`, the gate lets a request out only as the plugin released it (see fetch-gate.ts).
 */

import { splitModel } from "../../../core/src/index.ts";
import type { Decision } from "./decide.ts";
import { addWatcher, withdrawReleases } from "./fetch-gate.ts";
import type { Target } from "./gateway-client.ts";
import { heldFromEntry, heldFromEnv, holdPolicy, type Held, type HeldEntry } from "./held.ts";
import { OPENROUTER_PROVIDER_APIS } from "./openrouter.ts";
import { describeReport, isQuiet, type Report } from "./outcome.ts";
import { contextKey, contextOf, placeOf } from "./request.ts";
import { RouteClient, type Prepared } from "./route-client.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** The part of omp's and pi's `ExtensionAPI` this plugin uses. Events and contexts are read as untrusted shapes. */
export interface ExtensionAPI {
  on(event: string, handler: Handler): void;
  registerCommand(name: string, options: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }): void;
  appendEntry(customType: string, data: HeldEntry): void;
}

interface UI {
  notify(message: string, type: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
}

/** The session entry type that records the held policy, so a resumed session keeps it. */
export const ENTRY_TYPE = "inference-route-policy";
export const STATUS_KEY = "route-policy";

// Everything a harness hands a handler is read field by field, each field checked before use.
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const member = (value: unknown, name: string): unknown => (isObject(value) ? value[name] : undefined);

/** An error's message, without trusting the error object either. */
function reasonOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "an error that could not be described";
  }
}

function uiOf(ctx: unknown): UI | null {
  const ui = member(ctx, "ui");
  if (!isObject(ui)) return null;
  const { notify, setStatus } = ui;
  if (typeof notify !== "function" || typeof setStatus !== "function") return null;
  return { notify: (message, type) => notify.call(ui, message, type), setStatus: (key, text) => setStatus.call(ui, key, text) };
}

/** A header record as `Headers`, skipping values that are not strings (pi deletes a header set to null). */
function headersFrom(...records: unknown[]): Headers {
  const headers = new Headers();
  for (const record of records) {
    if (!isObject(record)) continue;
    for (const [name, value] of Object.entries(record)) if (typeof value === "string") headers.set(name, value);
  }
  return headers;
}

/** The request a hook's context is about: where it goes, with which key, for which model, over which API. */
interface RequestOf {
  /** The base URL and the key the request will carry, as far as the harness says; the fetch gate checks the key. */
  target: Target;
  modelId: string;
  /** The harness's name for the request API (`openai-completions`, ...); null when it gives none. */
  api: string | null;
  /** A `Route-Policy` the provider configuration adds on its own. */
  configured: string | null;
}

/** Where each request API's transport puts the registry's key, and in what form. */
function keyHeader(api: string | null, key: string): [string, string] {
  if (api === "anthropic-messages") return ["x-api-key", key];
  if (api === "google-generative-ai") return ["x-goog-api-key", key];
  return ["authorization", `Bearer ${key}`];
}

/**
 * Reads the model and the authentication context its request will carry from a handler context; null when the
 * context has no usable model. The context is every credential header the configuration adds, plus the
 * registry's key where the API's transport puts it unless a configured header already fills that place.
 * `wire`, when the hook sees the request's own headers, is read last. This is a prediction: the fetch gate
 * compares it with the headers that actually leave, and stops the request when they differ.
 */
async function requestOf(ctx: unknown, wire?: Record<string, unknown>): Promise<RequestOf | null> {
  const model = member(ctx, "model");
  const id = member(model, "id");
  const baseUrl = member(model, "baseUrl");
  const api = member(model, "api");
  if (typeof id !== "string" || typeof baseUrl !== "string") return null;
  const registry = member(ctx, "modelRegistry");
  const resolve = member(registry, "getApiKeyAndHeaders");
  // The harness resolves the key, and any base URL or headers its credentials carry, as it does for the request.
  const auth: unknown = typeof resolve === "function" ? await resolve.call(registry, model) : undefined;
  const ok = member(auth, "ok") === true;
  const apiKey = ok ? member(auth, "apiKey") : undefined;
  const authBase = ok ? member(auth, "baseUrl") : undefined;
  const configured = headersFrom(ok ? member(auth, "headers") : undefined, member(model, "headers"), wire);
  const requestApi = typeof api === "string" ? api : null;
  if (typeof apiKey === "string" && apiKey !== "") {
    const [name, value] = keyHeader(requestApi, apiKey);
    if (!configured.has(name)) configured.set(name, value);
  }
  const place = placeOf(typeof authBase === "string" ? authBase : baseUrl);
  if (place === null) return null;
  return {
    target: { ...place, context: contextOf(configured) },
    modelId: id,
    api: requestApi,
    configured: configured.get("route-policy"),
  };
}

/**
 * A payload whose serialization throws `reason`. Returned in place of the request's payload, it stops the
 * transport before anything is sent: both harnesses serialize the payload before opening a connection.
 */
export function blockedPayload(reason: string): object {
  return Object.freeze({
    toJSON(): never {
      throw new Error(`Blocked by the route policy plugin, nothing was sent: ${reason}`);
    },
  });
}

/** What a decision puts on the wire, for telling whether two decisions for one request would send the same thing. */
function wireOf(decision: Decision): string {
  switch (decision.action) {
    case "block":
      return JSON.stringify([decision.action, decision.reason]);
    case "send":
      return JSON.stringify([decision.action, decision.model, decision.header]);
    case "translate":
      return JSON.stringify([decision.action, decision.model, decision.provider]);
  }
}

/** Shows a report: in the status line when nothing needs attention, as a notification as well otherwise. */
function show(ui: UI | null, report: Report): void {
  if (ui === null) return;
  const text = describeReport(report);
  try {
    ui.setStatus(STATUS_KEY, text);
    if (!isQuiet(report)) ui.notify(text, report.kind === "refused" || report.kind === "blocked" ? "error" : "warning");
  } catch {
    // Reporting runs inside the request guard; a UI that throws must not turn a block into a send.
  }
}

/**
 * omp gives up on a handler after 30 seconds and sends the request as it was; pi would wait forever. Every
 * hook that shapes a request answers well inside that, with what `late` says when its own work has not finished.
 */
const GUARD_DEADLINE_MS = 20_000;

/** `work`'s result, or `fallback`'s when it fails or is not done within the deadline. */
function withDeadline<T>(work: () => Promise<T>, fallback: (why: string) => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  // The tsconfig's ES2023 library has no Promise.withResolvers, so the executor form it is.
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback(`it could not decide within ${GUARD_DEADLINE_MS / 1000} seconds`)), GUARD_DEADLINE_MS);
  });
  const done = (async () => {
    try {
      return await work();
    } catch (error) {
      return fallback(reasonOf(error));
    }
  })();
  return Promise.race([done, late]).finally(() => clearTimeout(timer));
}

/** A prepared decision and the request it was made for; a block needs no request. */
interface Guarded {
  request: RequestOf | null;
  prepared: Prepared;
}

const blockWith = (reason: string): Guarded => ({ request: null, prepared: { decision: { action: "block", reason }, target: { base: "", query: "", context: [] }, generation: 0 } });

export interface PluginOptions {
  /** True where `before_provider_headers` lets the plugin set request headers (pi); false where it cannot (omp). */
  headerHook: boolean;
  /** The events after which the session's entries may differ, so the held policy is read from them again. */
  restoreEvents: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
}

/** Registers the plugin on a harness's extension API. */
export function registerRoutePlugin(api: ExtensionAPI, options: PluginOptions): RouteClient {
  let ui: UI | null = null;
  const remember = (ctx: unknown): void => {
    ui = uiOf(ctx) ?? ui;
  };
  const client = new RouteClient({ carriers: options.headerHook ? "header" : "suffix", env: options.env, onReport: (report) => show(ui, report) });
  const stopWatching = addWatcher({ check: (outgoing) => client.check(outgoing), stopped: (reason) => client.blocked(reason) });

  /** Blocks with `reason`, telling the user if that can be done; never throws. */
  const refuse = (reason: string): object => {
    try {
      client.blocked(reason);
    } catch {
      // The block stands whether or not the user could be told.
    }
    return blockedPayload(reason);
  };

  /**
   * The payload to hand back to the harness for a decision, and a blocked one for anything that cannot be sent.
   * What is returned is a plain parse of the payload's serialization, checked to still carry what the decision
   * relies on (the model as decided, OpenRouter's fields), and released by exactly those bytes: the fetch gate
   * lets out that body with that header and authentication context, and nothing else.
   */
  const apply = ({ request, prepared }: Guarded, payload: unknown): unknown => {
    try {
      const { decision } = prepared;
      if (decision.action === "block") return refuse(decision.reason);
      if (request === null) return refuse("the plugin does not know where the request goes");
      if (!client.isCurrent(prepared)) return refuse("the detection reply this request was checked against was discarded since; it is not sent");
      if (!isObject(payload)) return refuse("the request's payload is not a JSON object the plugin can read");
      let next: Record<string, unknown> = { ...payload };
      if (decision.action === "translate") {
        if (request.api === null || !OPENROUTER_PROVIDER_APIS.includes(request.api)) {
          return refuse(`OpenRouter documents its provider field for ${OPENROUTER_PROVIDER_APIS.join(", ")} requests, not ${request.api ?? "an unnamed API"}`);
        }
        const existing = payload["provider"];
        next = { ...next, model: decision.model, provider: { ...(isObject(existing) ? existing : {}), ...decision.provider } };
      } else if (decision.model !== (typeof payload["model"] === "string" ? payload["model"] : request.modelId)) {
        if (typeof payload["model"] !== "string") return refuse("the request has no model field to carry the policy");
        next = { ...next, model: decision.model };
      }
      // Judged as serialized: a payload's own `toJSON`, or a getter, could drop or change what was set above.
      const copy: unknown = JSON.parse(JSON.stringify(next));
      const carried = member(copy, "model");
      const expected = decision.action === "translate" || typeof payload["model"] === "string" ? decision.model : undefined;
      if (carried !== expected) return refuse("the request's model, as serialized, is not the one the policy was decided for");
      if (decision.action === "translate") {
        const provider = member(copy, "provider");
        for (const [field, value] of Object.entries(decision.provider)) {
          if (JSON.stringify(member(provider, field)) !== JSON.stringify(value)) return refuse(`the request, as serialized, does not carry OpenRouter's provider.${field} as translated`);
        }
      }
      client.release({ ...prepared, decision }, decision.action === "send" ? decision.header : null, JSON.stringify(copy));
      return copy;
    } catch (error) {
      return refuse(`the plugin failed: ${reasonOf(error)}`);
    }
  };

  const restore = (_event: unknown, ctx: unknown): void => {
    let held: Held;
    try {
      remember(ctx);
      const manager = member(ctx, "sessionManager");
      const getBranch = member(manager, "getBranch");
      const branch: unknown = typeof getBranch === "function" ? getBranch.call(manager) : [];
      held = heldFromEnv(options.env);
      if (Array.isArray(branch)) {
        for (const entry of branch) {
          if (member(entry, "type") === "custom" && member(entry, "customType") === ENTRY_TYPE) held = heldFromEntry(member(entry, "data")) ?? held;
        }
      }
    } catch (error) {
      // A policy the session may hold but that cannot be read is not the same as none: block until it is set again.
      held = { kind: "invalid", text: "(stored in the session)", detail: `it could not be read: ${reasonOf(error)}`, source: "session" };
    }
    client.held = held;
  };
  for (const event of options.restoreEvents) api.on(event, restore);
  api.on("session_shutdown", () => {
    try {
      stopWatching();
      withdrawReleases(client);
    } catch {
      // Nothing to send here; a session that ended sends nothing more.
    }
  });

  api.registerCommand("route", {
    description: "Show the route policy (no argument), set one (/route <policy>), or remove it (/route clear)",
    handler: async (args, ctx) => {
      const tell = (message: string, type: "info" | "error"): void => {
        try {
          ui?.notify(message, type);
        } catch {
          // The command's effect stands; only its message is lost.
        }
      };
      try {
        remember(ctx);
        const text = args.trim();
        if (text === "") {
          const request = await requestOf(ctx);
          tell(await client.describe(request?.target ?? null), "info");
        } else if (text === "clear") {
          api.appendEntry(ENTRY_TYPE, { policy: null });
          client.held = { kind: "none" };
          tell("Route policy cleared", "info");
        } else {
          const held = holdPolicy(text, "session");
          if (held.kind === "invalid") return tell(`Not a valid policy, nothing changed: ${held.detail}`, "error");
          api.appendEntry(ENTRY_TYPE, { policy: text });
          client.held = held;
          tell(`Route policy set: ${text}`, "info");
        }
      } catch (error) {
        tell(`/route failed: ${reasonOf(error)}`, "error");
      }
    },
  });

  // pi: decisions the header hook made, waiting for the same request's payload hook, by base URL and model; each
  // carries the key it was made for, read from the request's own headers. `unprepared` counts header hooks that
  // ended without a decision; while it is nonzero, which header a payload got is unknowable, so the next payload
  // is blocked and every waiting decision is dropped.
  const waiting = new Map<string, Prepared[]>();
  let unprepared = 0;
  const waitingKey = (request: RequestOf): string => `${request.target.base}\n${request.modelId}`;

  if (options.headerHook) {
    api.on("before_provider_headers", async (event, ctx) => {
      try {
        remember(ctx);
        const headers = member(event, "headers");
        if (!isObject(headers)) throw new Error("the request's headers are not a record the plugin can change");
        // The work decides and changes nothing; the headers change only if it finished in time.
        const work = async (): Promise<Guarded> => {
          const request = await requestOf(ctx, headers);
          if (request === null) return blockWith("the harness did not say which model and base URL the request is for");
          return { request, prepared: await client.decide(request.target, request.modelId, request.configured) };
        };
        const { request, prepared } = await withDeadline(work, (why) => blockWith(`preparing the request's headers failed: ${why}`));
        if (request === null) throw new Error(prepared.decision.action === "block" ? prepared.decision.reason : "no request");
        const { decision } = prepared;
        // pi deletes a header set to null. Every line the configuration added goes, so only the plugin's remains.
        for (const name of Object.keys(headers)) if (name.toLowerCase() === "route-policy") headers[name] = null;
        if (decision.action === "send" && decision.header !== null) headers["Route-Policy"] = decision.header;
        const key = waitingKey(request);
        waiting.set(key, [...(waiting.get(key) ?? []), prepared]);
      } catch {
        unprepared += 1;
      }
    });
  }

  /** The header hook's decision for this request. Blocks when there is none, or when it cannot be told apart. */
  const takePrepared = (request: RequestOf, payload: unknown): Guarded => {
    const key = waitingKey(request);
    const queue = waiting.get(key) ?? [];
    const [first] = queue;
    if (first === undefined) return blockWith("the plugin did not see this request's headers, so it cannot tell which policy they carry");
    const same = (p: Prepared): boolean => wireOf(p.decision) === wireOf(first.decision) && contextKey(p.target.context) === contextKey(first.target.context);
    if (!queue.every(same)) {
      waiting.delete(key);
      return blockWith("requests for this model were prepared with different policies or keys at once; resend it");
    }
    queue.shift();
    if (queue.length === 0) waiting.delete(key);
    // Some APIs name the model in the URL, not the body; a body that names one must name the prepared one.
    const model = member(payload, "model");
    if (model !== undefined && model !== request.modelId) return blockWith("the request's model is not the one its headers were prepared for");
    // `apply` checks the decision is still current: one prepared before a detection discard is not released.
    return { request, prepared: first };
  };

  api.on("before_provider_request", async (event, ctx) => {
    try {
      remember(ctx);
      const payload = member(event, "payload");
      const work = async (): Promise<Guarded> => {
        // A header hook that ended without a decision: this payload, whatever it is, cannot be matched to headers.
        if (options.headerHook && unprepared > 0) {
          unprepared -= 1;
          waiting.clear();
          return blockWith("the plugin could not prepare the headers of a request in flight, so which policy this one carries is unknowable");
        }
        const request = await requestOf(ctx);
        if (request === null) return blockWith("the harness did not say which model and base URL the request is for");
        if (options.headerHook) return takePrepared(request, payload);
        const model = member(payload, "model");
        // A suffix the user typed into the selected model is a policy; a payload that names the model without it
        // (or with another) would drop it, so the two must agree on it before either is trusted.
        if (typeof model === "string" && splitModel(model).policy !== splitModel(request.modelId).policy) {
          return blockWith(`the request names the model "${model}" while "${request.modelId}" is selected; the policy typed into one is not in the other`);
        }
        return { request, prepared: await client.decide(request.target, typeof model === "string" ? model : request.modelId, request.configured) };
      };
      return apply(await withDeadline(work, (why) => blockWith(`the plugin failed: ${why}`)), payload);
    } catch (error) {
      // Whatever failed, the context and the payload included, the request does not go out without its policy.
      return blockedPayload(`the plugin failed: ${reasonOf(error)}`);
    }
  });

  return client;
}
