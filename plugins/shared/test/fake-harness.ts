// A small stand-in for omp's and pi's extension runtime, faithful where the plugin's safety depends on it: handler
// errors are caught and the request goes on with the payload it had (both harnesses do that), `null` deletes a
// header (pi), and the transport serializes the payload before it sends anything, through the global fetch.

import type { ExtensionAPI } from "../src/plugin.ts";
import type { HeldEntry } from "../src/held.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

export interface Shown {
  method: "notify" | "setStatus";
  text: string;
}

export interface Sent {
  /** False when the transport could not serialize the payload, so nothing left the process. */
  sent: boolean;
  error: string | null;
  status: number | null;
}

export class FakeHarness {
  readonly handlers = new Map<string, Handler[]>();
  readonly commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  readonly entries: { type: "custom"; customType: string; data: HeldEntry }[] = [];
  readonly shown: Shown[] = [];
  /** Errors the runtime caught from handlers, as it would report them. */
  readonly handlerErrors: string[] = [];
  model: { id: string; baseUrl: string; headers?: Record<string, string> };
  /** What `modelRegistry.getApiKeyAndHeaders` does; tests replace it to make the plugin fail. */
  resolveAuth: () => Promise<unknown> = async () => ({ ok: true, apiKey: "demo-key" });
  uiThrows = false;
  /** Replaces `ctx.model`, to hand the plugin a model the harness would never describe that way. */
  contextModel: unknown = undefined;
  readonly headerHook: boolean;

  readonly api: ExtensionAPI = {
    on: (event, handler) => this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]),
    registerCommand: (name, options) => this.commands.set(name, options.handler),
    appendEntry: (customType, data) => this.entries.push({ type: "custom", customType, data }),
  };

  constructor(baseUrl: string, options: { headerHook: boolean }) {
    this.model = { id: "demo-model", baseUrl };
    this.headerHook = options.headerHook;
  }

  ctx(): unknown {
    const show = (method: Shown["method"], text: string): void => {
      if (this.uiThrows) throw new Error("UI is gone");
      this.shown.push({ method, text });
    };
    return {
      ui: { notify: (message: string) => show("notify", message), setStatus: (_key: string, text: string) => show("setStatus", text) },
      model: this.contextModel ?? this.model,
      modelRegistry: { getApiKeyAndHeaders: () => this.resolveAuth() },
      sessionManager: { getBranch: () => this.entries },
    };
  }

  /** Runs every handler for `event` in turn, as the runtime does: a throwing handler is reported and skipped. */
  async emit(event: string, payload: Record<string, unknown>, chain?: string): Promise<unknown> {
    let value = chain === undefined ? undefined : payload[chain];
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        const result = await handler(chain === undefined ? payload : { ...payload, [chain]: value }, this.ctx());
        if (chain !== undefined && result !== undefined) value = result;
      } catch (error) {
        this.handlerErrors.push(String(error));
      }
    }
    return value;
  }

  async command(name: string, args: string): Promise<void> {
    const handler = this.commands.get(name);
    if (handler === undefined) throw new Error(`no command /${name}`);
    await handler(args, this.ctx());
  }

  /** One provider request the way the harness makes it: hooks, then serialization, then the HTTP call. */
  async request(payload: Record<string, unknown> = { model: this.model.id, messages: [{ role: "user", content: "secret prompt" }], stream: false }): Promise<Sent> {
    const headers: Record<string, string | null> = { ...this.model.headers };
    if (this.headerHook) await this.emit("before_provider_headers", { type: "before_provider_headers", headers });
    const final = await this.emit("before_provider_request", { type: "before_provider_request", payload }, "payload");
    let body: string;
    try {
      body = JSON.stringify(final);
    } catch (error) {
      return { sent: false, error: error instanceof Error ? error.message : String(error), status: null };
    }
    const wire: Record<string, string> = { "content-type": "application/json", authorization: "Bearer demo-key" };
    for (const [name, value] of Object.entries(headers)) if (value !== null) wire[name] = value;
    const response = await fetch(`${this.model.baseUrl}/chat/completions`, { method: "POST", headers: wire, body });
    await response.text();
    return { sent: true, error: null, status: response.status };
  }
}
