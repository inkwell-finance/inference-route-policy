/**
 * The plugin's state for one harness session: the held policy, what it has fetched from each gateway, and the
 * requests it let through, so it can read their results. Detection replies and model lists live only in this
 * object, keyed by base URL and credential together (C14), and are never written anywhere (C15).
 */

import { hasRequirements, parsePolicy, type Detection } from "../../../core/src/index.ts";
import { anyPolicy, anyRequirement, decide, readLayers, type Carriers, type Decision } from "./decide.ts";
import { fetchDetection, fetchModelList, normalizeBase, type DetectionResult, type Fetch, type Target } from "./gateway-client.ts";
import { describeHeld, heldFromEnv, holdPolicy, type Held } from "./held.ts";
import { isOpenRouter } from "./openrouter.ts";
import { describeReport, interpret, type Report, type Sent } from "./outcome.ts";
import type { Exchange } from "./observe.ts";

export interface RouteClientOptions {
  carriers: Carriers;
  env: Readonly<Record<string, string | undefined>>;
  /** Defaults to the global `fetch`, read at each call. */
  fetch?: Fetch;
  /**
   * Budget for each read of a gateway. A harness may give up on a slow handler and send the request as it was
   * (omp does after 30 seconds), so the two reads before a request must finish well inside that.
   */
  timeoutMs?: number;
  /** Called with the report for each response this client sent, and for each request it blocked. */
  onReport: (report: Report) => void;
}

/** A request this client let through, exactly as it went on the wire, and what to read its response against. */
interface Pending {
  base: string;
  credential: string | null;
  cacheKey: string;
  /** The serialized body, which ties a response to this request and no other. */
  body: string;
  header: string | null;
  sent: Sent;
  requirement: boolean;
}

/** The most pending requests remembered; one whose response never comes is forgotten after this many more. */
const PENDING_LIMIT = 32;

export class RouteClient {
  held: Held;
  lastReport: Report | null = null;
  readonly #options: RouteClientOptions;
  // In-flight and settled reads, by base URL and credential. A settled failure is not kept.
  readonly #detections = new Map<string, Promise<DetectionResult>>();
  readonly #lists = new Map<string, Promise<unknown>>();
  // What is held now, for a request that may use what is held but would not fetch anything itself.
  readonly #heldDetections = new Map<string, Detection>();
  readonly #heldLists = new Map<string, unknown>();
  readonly #pending: Pending[] = [];

  constructor(options: RouteClientOptions) {
    this.#options = options;
    this.held = heldFromEnv(options.env);
  }

  /** Sets the held policy from what the user typed; returns the new state, which may be invalid. */
  set(text: string): Held {
    this.held = holdPolicy(text, "session");
    return this.held;
  }

  #fetch: Fetch = (input, init) => (this.#options.fetch ?? globalThis.fetch)(input, init);

  #key = (target: Target): string => `${normalizeBase(target.base)}\n${target.credential ?? ""}`;

  /** The detection result for a target, fetching it when none is held or in flight. */
  #detection(target: Target): Promise<DetectionResult> {
    const key = this.#key(target);
    let pending = this.#detections.get(key);
    if (pending === undefined) {
      const read = fetchDetection(this.#fetch, target, this.#options.timeoutMs ?? 5000);
      pending = read;
      this.#detections.set(key, read);
      void read.then((result) => {
        // A discard while the read was in flight wins: the result is dropped with it.
        if (this.#detections.get(key) !== read) return;
        if (result.ok) this.#heldDetections.set(key, result.detection);
        else this.#detections.delete(key);
      });
    }
    return pending;
  }

  #modelList(target: Target): Promise<unknown> {
    const key = this.#key(target);
    let pending = this.#lists.get(key);
    if (pending === undefined) {
      const read = fetchModelList(this.#fetch, target, this.#options.timeoutMs ?? 5000);
      pending = read;
      this.#lists.set(key, read);
      void read.then((list) => {
        if (this.#lists.get(key) !== read) return;
        if (list === null) this.#lists.delete(key);
        else this.#heldLists.set(key, list);
      });
    }
    return pending;
  }

  /** C14: the detection reply for this base URL and credential can no longer be trusted. */
  #discardDetection(cacheKey: string): void {
    this.#detections.delete(cacheKey);
    this.#heldDetections.delete(cacheKey);
  }

  /**
   * Decides one request. `model` is its `model` field and `configured` a `Route-Policy` value the harness sends
   * on its own. Reads the gateway first when the decision needs it: detection whenever a policy reaches the
   * request, the model list when a requirement does, the key's own included. A request no policy reaches fetches
   * nothing, but is still judged against what is already held for its base URL and credential (C16).
   */
  async decide(target: Target, model: string, configured: string | null): Promise<Decision> {
    const layers = readLayers(this.held, model, configured);
    if (!layers.ok) return { action: "block", reason: layers.reason };
    const base = normalizeBase(target.base);
    const key = this.#key(target);
    let detection: Detection | null = this.#heldDetections.get(key) ?? null;
    let noDetection = "not fetched";
    let modelList: { list: unknown } | null = this.#heldLists.has(key) ? { list: this.#heldLists.get(key) } : null;
    if (anyPolicy(layers.value)) {
      const result = await this.#detection(target);
      detection = result.ok ? result.detection : null;
      if (!result.ok) noDetection = result.why;
      const bound = detection?.keyPolicy == null ? null : parsePolicy(detection.keyPolicy, detection.support);
      const requirement = anyRequirement(layers.value) || (bound?.ok === true && hasRequirements(bound.value));
      if (detection !== null && requirement && !isOpenRouter(base)) {
        const list = await this.#modelList(target);
        modelList = list === null ? null : { list };
      }
    }
    return decide(layers.value, this.#options.carriers, { base, detection, noDetection, modelList });
  }

  /** Records a request the caller is about to let through, with the exact body it will send. */
  sending(target: Target, decision: Exclude<Decision, { action: "block" }>, body: string): void {
    this.#pending.push({
      base: normalizeBase(target.base),
      credential: target.credential,
      cacheKey: this.#key(target),
      body,
      header: decision.action === "send" ? decision.header : null,
      sent: decision.action === "translate" ? { kind: "translated" } : { kind: "protocol", policy: decision.sent, routes: decision.routes },
      requirement: decision.sent !== null && hasRequirements(decision.sent),
    });
    if (this.#pending.length > PENDING_LIMIT) this.#pending.shift();
  }

  /** Reports a request the caller blocked: nothing of it was sent. */
  blocked(reason: string): void {
    this.#report({ kind: "blocked", reason });
  }

  /**
   * Reads a response if it answers a request this client let through: same base URL, same credential, same
   * body, same `Route-Policy`. A response to this base URL and credential that matches none while a request with
   * a requirement is outstanding there cannot be tied to its request: nothing about it is confirmed, and the
   * detection reply it might have answered is no longer trusted.
   */
  observe(exchange: Exchange): void {
    if (exchange.method !== "POST") return;
    const here = this.#pending.filter((p) => exchange.url.startsWith(`${p.base}/`) && exchange.credential === p.credential);
    if (here.length === 0) return;
    const index = this.#pending.findIndex((p) => here.includes(p) && exchange.body === p.body && exchange.routePolicy === p.header);
    if (index < 0) {
      const outstanding = here.filter((p) => p.requirement);
      if (outstanding.length === 0) return;
      for (const p of outstanding) this.#discardDetection(p.cacheKey);
      this.#report({ kind: "untied", base: outstanding[0]!.base });
      return;
    }
    const [pending] = this.#pending.splice(index, 1);
    const report = interpret(exchange.result, pending!.sent);
    // C14: a requirement that came back not honored means the detection reply can no longer be trusted there.
    if (report.kind === "not-honored" && pending!.requirement) this.#discardDetection(pending!.cacheKey);
    this.#report(report);
  }

  #report(report: Report): void {
    this.lastReport = report;
    this.#options.onReport(report);
  }

  /** What `/route` shows: the held policy, the gateway's detection state and the key's own policy, and the last result. */
  async describe(target: Target | null): Promise<string> {
    const lines = [`Route policy: ${describeHeld(this.held)}`];
    if (target === null) {
      lines.push("Gateway: the current model has no base URL to check");
    } else {
      const base = normalizeBase(target.base);
      const result = await this.#detection(target);
      if (!result.ok) {
        lines.push(`Gateway ${base}: no detection (${result.why})${isOpenRouter(base) ? "; policies are translated into OpenRouter's own fields where it has a filter for them" : ""}`);
      } else {
        const { support, keyPolicy } = result.detection;
        lines.push(`Gateway ${base}: detection valid; accepts ${[...support.keys].join(", ")}`);
        if (keyPolicy === null) lines.push("Key policy: none");
        else if (parsePolicy(keyPolicy, support).ok) lines.push(`Key policy (locked, applied by the gateway to every request with this key): ${keyPolicy}`);
        // C12, C13: shown as text, relied on for nothing.
        else lines.push(`Key policy (locked): "${keyPolicy}", which this client cannot interpret; shown as text and relied on for nothing`);
      }
    }
    lines.push(`Last result: ${this.lastReport === null ? "none yet" : describeReport(this.lastReport)}`);
    return lines.join("\n");
  }
}
