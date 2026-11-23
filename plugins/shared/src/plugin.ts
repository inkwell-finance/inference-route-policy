/**
 * The plugin as both harnesses load it: a `/route` command, a guard on every outgoing provider request, and a
 * report of every response. omp and pi expose the same extension API names for all of this; they differ in
 * whether a handler may set request headers, which `headerHook` says.
 *
 * Blocking: both harnesses catch an error thrown from `before_provider_request` and send the request anyway, so
 * throwing does not block. What does is the payload: the handler returns one whose JSON serialization throws,
 * which stops the transport before it opens a connection and surfaces the reason as the turn's error.
 */

import type { Decision } from "./decide.ts";
import { normalizeBase, type Target } from "./gateway-client.ts";
import { heldFromEntry, heldFromEnv, holdPolicy, type HeldEntry } from "./held.ts";
import { observeExchanges } from "./observe.ts";
import { describeReport, isQuiet, type Report } from "./outcome.ts";
import { RouteClient } from "./route-client.ts";

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

function uiOf(ctx: unknown): UI | null {
  const ui = member(ctx, "ui");
  if (!isObject(ui)) return null;
  const { notify, setStatus } = ui;
  if (typeof notify !== "function" || typeof setStatus !== "function") return null;
  return { notify: (message, type) => notify.call(ui, message, type), setStatus: (key, text) => setStatus.call(ui, key, text) };
}

/** A `Route-Policy` value in a header record, whatever its case; null when there is none. */
function routePolicyIn(headers: unknown): string | null {
  if (!isObject(headers)) return null;
  for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() === "route-policy" && typeof value === "string") return value;
  return null;
}

/** The request a hook's context is about: where it goes, with which key, for which model. */
interface RequestOf {
  target: Target;
  modelId: string;
  /** A `Route-Policy` the provider configuration adds on its own. */
  configured: string | null;
}

/** Reads the model and its credentials from a handler context. Null when the context has no usable model. */
async function requestOf(ctx: unknown): Promise<RequestOf | null> {
  const model = member(ctx, "model");
  const id = member(model, "id");
  const baseUrl = member(model, "baseUrl");
  if (typeof id !== "string" || typeof baseUrl !== "string") return null;
  const registry = member(ctx, "modelRegistry");
  const resolve = member(registry, "getApiKeyAndHeaders");
  // The harness resolves the key, and any base URL or headers its credentials carry, as it does for the request.
  const auth: unknown = typeof resolve === "function" ? await resolve.call(registry, model) : undefined;
  const ok = member(auth, "ok") === true;
  const apiKey = ok ? member(auth, "apiKey") : undefined;
  const authBase = ok ? member(auth, "baseUrl") : undefined;
  return {
    target: { base: normalizeBase(typeof authBase === "string" ? authBase : baseUrl), credential: typeof apiKey === "string" && apiKey !== "" ? apiKey : null },
    modelId: id,
    configured: routePolicyIn(member(model, "headers")) ?? (ok ? routePolicyIn(member(auth, "headers")) : null),
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
 * omp gives up on a handler after 30 seconds and sends the request as it was. The guard answers well before
 * that, blocking if its own work has not finished.
 */
const GUARD_DEADLINE_MS = 20_000;

/** A decision and the target it was made for; a block needs none. */
interface Guarded {
  target: Target | null;
  decision: Decision;
}

const blockWith = (reason: string): Guarded => ({ target: null, decision: { action: "block", reason } });

function withDeadline(work: Promise<Guarded>): Promise<Guarded> {
  let timer: NodeJS.Timeout | undefined;
  // The tsconfig's ES2023 library has no Promise.withResolvers, so the executor form it is.
  const late = new Promise<Guarded>((resolve) => {
    timer = setTimeout(() => resolve(blockWith(`the plugin could not decide within ${GUARD_DEADLINE_MS / 1000} seconds`)), GUARD_DEADLINE_MS);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

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
  const stopObserving = observeExchanges((exchange) => client.observe(exchange));

  /**
   * The payload to hand back to the harness for a decision, and a blocked one for anything that cannot be sent.
   * It never throws: a harness that caught the error would send the original payload.
   */
  const apply = ({ target, decision }: Guarded, payload: unknown): unknown => {
    const refuse = (reason: string): unknown => {
      client.blocked(reason);
      return blockedPayload(reason);
    };
    try {
      if (decision.action === "block") return refuse(decision.reason);
      if (target === null) return refuse("the plugin does not know where the request goes");
      if (!isObject(payload)) return refuse("the request's payload is not a JSON object the plugin can read");
      let next = payload;
      if (decision.action === "translate") {
        // OpenRouter documents its `provider` field for Chat Completions and Responses requests only.
        if (!Array.isArray(payload["messages"]) && !("input" in payload)) return refuse("OpenRouter documents its provider field only for Chat Completions and Responses requests");
        const existing = payload["provider"];
        next = { ...payload, model: decision.model, provider: { ...(isObject(existing) ? existing : {}), ...decision.provider } };
      } else if (decision.model !== payload["model"]) {
        if (typeof payload["model"] !== "string") return refuse("the request has no model field to carry the policy");
        next = { ...payload, model: decision.model };
      }
      client.sending(target, decision);
      return next;
    } catch (error) {
      return blockedPayload(`the plugin failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const restore = (_event: unknown, ctx: unknown): void => {
    remember(ctx);
    const manager = member(ctx, "sessionManager");
    const getBranch = member(manager, "getBranch");
    const branch: unknown = typeof getBranch === "function" ? getBranch.call(manager) : [];
    let held = heldFromEnv(options.env);
    if (Array.isArray(branch)) {
      for (const entry of branch) {
        if (member(entry, "type") === "custom" && member(entry, "customType") === ENTRY_TYPE) held = heldFromEntry(member(entry, "data")) ?? held;
      }
    }
    client.held = held;
  };
  for (const event of options.restoreEvents) api.on(event, restore);
  api.on("session_shutdown", () => {
    stopObserving();
  });

  api.registerCommand("route", {
    description: "Show the route policy (no argument), set one (/route <policy>), or remove it (/route clear)",
    handler: async (args, ctx) => {
      remember(ctx);
      try {
        const text = args.trim();
        if (text === "") {
          const request = await requestOf(ctx);
          ui?.notify(await client.describe(request?.target ?? null), "info");
        } else if (text === "clear") {
          client.held = { kind: "none" };
          api.appendEntry(ENTRY_TYPE, { policy: null });
          ui?.notify("Route policy cleared", "info");
        } else {
          const held = holdPolicy(text, "session");
          if (held.kind === "invalid") {
            ui?.notify(`Not a valid policy, nothing changed: ${held.detail}`, "error");
            return;
          }
          client.held = held;
          api.appendEntry(ENTRY_TYPE, { policy: text });
          ui?.notify(`Route policy set: ${text}`, "info");
        }
      } catch (error) {
        ui?.notify(`/route failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  // Decisions the header hook made, waiting for the same request's payload hook, by base URL and model.
  const prepared = new Map<string, Decision[]>();
  const preparedKey = (request: RequestOf): string => `${request.target.base}\n${request.modelId}`;

  if (options.headerHook) {
    api.on("before_provider_headers", async (event, ctx) => {
      remember(ctx);
      const request = await requestOf(ctx).catch(() => null);
      // Without a request to key it by, nothing is prepared, and the payload hook blocks.
      if (request === null) return;
      const headers = member(event, "headers");
      let decision: Decision;
      try {
        decision = await client.decide(request.target, request.modelId, routePolicyIn(headers));
        if (!isObject(headers)) throw new Error("the request's headers are not a record the plugin can change");
        // pi deletes a header set to null. Every line the configuration added goes, so only the plugin's remains.
        for (const name of Object.keys(headers)) if (name.toLowerCase() === "route-policy") headers[name] = null;
        if (decision.action === "send" && decision.header !== null) headers["Route-Policy"] = decision.header;
      } catch (error) {
        decision = { action: "block", reason: `the plugin failed while preparing the request: ${error instanceof Error ? error.message : String(error)}` };
      }
      const key = preparedKey(request);
      prepared.set(key, [...(prepared.get(key) ?? []), decision]);
    });
  }

  /** The header hook's decision for this request. Blocks when there is none, or when waiting ones disagree. */
  const takePrepared = (request: RequestOf, payload: unknown): Decision => {
    const key = preparedKey(request);
    const queue = prepared.get(key) ?? [];
    const [first] = queue;
    if (first === undefined) return { action: "block", reason: "the plugin did not see this request's headers, so it cannot tell which policy they carry" };
    if (queue.some((decision) => wireOf(decision) !== wireOf(first))) {
      // Requests whose headers were prepared differently are in flight together; which header this one got is unknowable.
      prepared.delete(key);
      return { action: "block", reason: "requests for this model were prepared with different policies at once; resend it" };
    }
    queue.shift();
    if (queue.length === 0) prepared.delete(key);
    const model = member(payload, "model");
    if (model !== undefined && model !== request.modelId) return { action: "block", reason: "the request's model is not the one its headers were prepared for" };
    return first;
  };

  api.on("before_provider_request", async (event, ctx) => {
    remember(ctx);
    const payload = member(event, "payload");
    const work = async (): Promise<Guarded> => {
      const request = await requestOf(ctx);
      if (request === null) return blockWith("the harness did not say which model and base URL the request is for");
      if (options.headerHook) return { target: request.target, decision: takePrepared(request, payload) };
      const model = member(payload, "model");
      return { target: request.target, decision: await client.decide(request.target, typeof model === "string" ? model : request.modelId, request.configured) };
    };
    let guarded: Guarded;
    try {
      guarded = await withDeadline(work());
    } catch (error) {
      // Whatever failed, the request does not go out without its policy.
      guarded = blockWith(`the plugin failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return apply(guarded, payload);
  });

  return client;
}
