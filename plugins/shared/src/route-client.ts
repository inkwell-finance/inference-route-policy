/**
 * The plugin's state for one harness session: the held policy, what it has fetched from each gateway, and the
 * requests it released. Detection replies and model lists live only in this object, keyed by base URL and
 * credential together (C14), and are never written anywhere (C15). A released request goes only through the
 * fetch gate, which asks `gate`, and its response is read from that same call.
 */

import { hasRequirements, parsePolicy, type Detection } from "../../../core/src/index.ts";
import { anyPolicy, anyRequirement, decide, readLayers, type Carriers, type Decision } from "./decide.ts";
import type { Verdict } from "./fetch-gate.ts";
import { fetchDetection, fetchModelList, normalizeBase, type DetectionResult, type Fetch, type Target } from "./gateway-client.ts";
import { describeHeld, heldFromEnv, holdPolicy, type Held } from "./held.ts";
import { isOpenRouter } from "./openrouter.ts";
import { describeReport, interpret, type Report, type Sent } from "./outcome.ts";
import { identityKey, type Completion, type Outgoing, type RequestIdentity } from "./request.ts";

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
  /** Called with the report for each response to a released request, and for each request blocked. */
  onReport: (report: Report) => void;
}

/** A decision, the target it was made for, and the detection generation it relied on. */
export interface Prepared {
  decision: Decision;
  target: Target;
  generation: number;
}

/** What a released request is read against, and what must still hold when it leaves. */
interface Ticket {
  cacheKey: string;
  generation: number;
  sent: Sent;
  requirement: boolean;
}

/** Releases remembered for resends. Past this the oldest is forgotten, which can only stop a resend of it. */
const TICKET_LIMIT = 1024;

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
  readonly #generations = new Map<string, number>();
  /** Released requests by identity. */
  readonly #tickets = new Map<string, Ticket>();
  /** Base URLs whose POSTs this client checks at the gate. */
  readonly #bases = new Set<string>();

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

  /** How many times the detection reply for a base URL and credential has been discarded. */
  #generation = (cacheKey: string): number => this.#generations.get(cacheKey) ?? 0;

  /** C14: the detection reply for this base URL and credential can no longer be trusted, nor anything decided on it. */
  #discardDetection(cacheKey: string): void {
    this.#detections.delete(cacheKey);
    this.#heldDetections.delete(cacheKey);
    this.#generations.set(cacheKey, this.#generation(cacheKey) + 1);
  }

  /**
   * Decides one request. `model` is its `model` field and `configured` a `Route-Policy` value the harness sends
   * on its own. Reads the gateway first when the decision needs it: detection whenever a policy reaches the
   * request, the model list when a requirement does, the key's own included. A request no policy reaches fetches
   * nothing, but is still judged against what is already held for its base URL and credential (C16).
   */
  async decide(target: Target, model: string, configured: string | null): Promise<Prepared> {
    const key = this.#key(target);
    // Taken before any read: a discard while this decision waits makes it stale.
    const generation = this.#generation(key);
    const prepared = (decision: Decision): Prepared => ({ decision, target: { ...target, base: normalizeBase(target.base) }, generation });
    const layers = readLayers(this.held, model, configured);
    if (!layers.ok) return prepared({ action: "block", reason: layers.reason });
    const base = normalizeBase(target.base);
    this.#bases.add(base);
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
    return prepared(decide(layers.value, this.#options.carriers, { base, detection, noDetection, modelList }));
  }

  /** Whether nothing a decision relied on has been discarded since it was made (C14). */
  isCurrent(prepared: Prepared): boolean {
    return prepared.generation === this.#generation(this.#key(prepared.target));
  }

  /**
   * Releases a decided request with the identity it will have on the wire. Only a request with a released
   * identity passes the fetch gate, and only while its decision is current.
   */
  release(prepared: Prepared & { decision: Exclude<Decision, { action: "block" }> }, identity: RequestIdentity): void {
    const { decision } = prepared;
    const ticket: Ticket = {
      cacheKey: this.#key(prepared.target),
      generation: prepared.generation,
      sent: decision.action === "translate" ? { kind: "translated" } : { kind: "protocol", policy: decision.sent, routes: decision.routes },
      requirement: decision.sent !== null && hasRequirements(decision.sent),
    };
    const key = identityKey(identity);
    this.#bases.add(identity.base);
    this.#tickets.delete(key);
    this.#tickets.set(key, ticket);
    // Forgetting the oldest release can only stop a late resend of it, never let anything through.
    for (const oldest of this.#tickets.keys()) {
      if (this.#tickets.size <= TICKET_LIMIT) break;
      this.#tickets.delete(oldest);
    }
  }

  /** Reports a request the caller blocked: nothing of it was sent. */
  blocked(reason: string): void {
    this.#report({ kind: "blocked", reason });
  }

  /**
   * The fetch gate's question for this client. A POST to a base URL it watches goes only as a request it
   * released, matched on base URL, credential, model and policy header, and only while the decision behind it is
   * current. Anything else to that base URL is stopped if a policy could be at stake: one is held, or the request
   * carries one, or its model cannot be read.
   */
  gate(outgoing: Outgoing): Verdict {
    const base = [...this.#bases].filter((b) => outgoing.url.startsWith(`${b}/`)).sort((a, b) => b.length - a.length)[0];
    if (base === undefined) return { kind: "pass" };
    const ticket = outgoing.model === undefined ? undefined : this.#tickets.get(identityKey({ base, credential: outgoing.credential, model: outgoing.model, header: outgoing.header }));
    if (ticket !== undefined) {
      if (ticket.requirement && ticket.generation !== this.#generation(ticket.cacheKey)) {
        return this.#stop("the detection reply this request was checked against was discarded before it left, so it is not sent; send it again");
      }
      return { kind: "released", complete: (completion) => this.#complete(ticket, completion) };
    }
    const policyAtStake = this.held.kind !== "none" || outgoing.header !== null || outgoing.model === undefined || (outgoing.model ?? "").includes("+");
    if (!policyAtStake) return { kind: "pass" };
    return this.#stop(`this request to ${base} is not one the plugin checked: its key, model, or Route-Policy header differs from what was released`);
  }

  #stop = (reason: string): Verdict => ({ kind: "stop", reason, stopped: () => this.blocked(reason) });

  /** Reads the response to one released request (C3, C4, C5). */
  #complete(ticket: Ticket, completion: Completion): void {
    const report = interpret(completion.result, ticket.sent);
    // C14: a requirement that came back not honored means the detection reply can no longer be trusted there.
    if (report.kind === "not-honored" && ticket.requirement) this.#discardDetection(ticket.cacheKey);
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
