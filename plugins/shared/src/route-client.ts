/**
 * The plugin's state for one harness session: the held policy, what it has fetched from each gateway, and the
 * requests it released. Detection replies and model lists live only in this object, keyed by base URL and
 * credential together (C14), and are never written anywhere (C15). A released request goes only through the
 * fetch gate, which asks `gate`, and its response is read from that same call.
 */

import { hasRequirements, parsePolicy, type Detection } from "../../../core/src/index.ts";
import { anyPolicy, anyRequirement, decide, readLayers, type Carriers, type Decision } from "./decide.ts";
import { addRelease } from "./fetch-gate.ts";
import { fetchDetection, fetchModelList, normalizeBase, type DetectionResult, type Fetch, type Target } from "./gateway-client.ts";
import { describeHeld, heldFromEnv, holdPolicy, type Held } from "./held.ts";
import { isOpenRouter } from "./openrouter.ts";
import { describeReport, interpret, type Report, type Sent } from "./outcome.ts";
import { contextKey, credentialNames, modelIn, type Completion, type Outgoing } from "./request.ts";

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
  /**
   * Called with the report for each response to a released request, and for each request blocked. `subject`
   * names the request the report is about (its model and base URL), null when the report carries its own.
   */
  onReport: (report: Report, subject: string | null) => void;
}

/** A decision, the place it was made for, and the detection generation it relied on. */
export interface Prepared extends Located {
  decision: Decision;
  target: Target;
  unexact: string | null;
  generation: number;
}

/**
 * Where a request goes, as resolved from the harness: its target, and why its base URL cannot be used exactly as
 * written (null when it can). Every read of a gateway's metadata takes one, so none reads a place not as written.
 */
export interface Located {
  target: Target;
  unexact: string | null;
}

/** Unused releases a session keeps. Past this the oldest is withdrawn, which can only stop it. */
const RELEASE_LIMIT = 256;

export class RouteClient {
  held: Held;
  /** The last report, with the request it is about. */
  lastReport: { report: Report; subject: string | null } | null = null;
  readonly #options: RouteClientOptions;
  // In-flight and settled reads, by base URL and credential. A settled failure is not kept.
  readonly #detections = new Map<string, Promise<DetectionResult>>();
  readonly #lists = new Map<string, Promise<{ list: unknown } | null>>();
  // What is held now, for a request that may use what is held but would not fetch anything itself.
  readonly #heldDetections = new Map<string, Detection>();
  readonly #heldLists = new Map<string, { list: unknown }>();
  readonly #generations = new Map<string, number>();
  /** Withdrawals of this client's releases, oldest first; a used release is already gone and withdraws nothing. */
  readonly #withdrawals: (() => void)[] = [];
  /** Base URLs this client sends to: a POST there that no release matches is its business. */
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

  /**
   * A place's key in every cache and table of this client: its base URL, query, and context. Only a place usable
   * exactly as written has one. One that is not has no detection and no catalog, and cannot even be looked up, so
   * nothing read for the place it would be sent to instead is evidence about it (C14).
   */
  #key(located: Located): string | null {
    if (located.unexact !== null) return null;
    const { target } = located;
    return `${normalizeBase(target.base)}\n${target.query}\n${contextKey(target.context)}`;
  }

  /** The session whose requests are being shown; a request released in an earlier one is not shown in this one. */
  #session = 0;

  /** A new session starts: it has heard of no result, and results of requests released before are not shown. */
  newSession(): void {
    this.#session += 1;
    this.lastReport = null;
  }

  /**
   * The detection result for a place, fetching it when none is held or in flight. A base URL that cannot be used
   * as written has none, and nothing is fetched for it (SPEC.md, Detection).
   */
  #detection(located: Located): Promise<DetectionResult> {
    const key = this.#key(located);
    if (key === null) return Promise.resolve({ ok: false, why: located.unexact ?? "its base URL cannot be used as written" });
    const { target } = located;
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

  /** The model list for a place. Read only after a valid detection reply, which a place not as written never has. */
  #modelList(located: Located): Promise<{ list: unknown } | null> {
    const key = this.#key(located);
    if (key === null) return Promise.resolve(null);
    const { target } = located;
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
  #generation = (cacheKey: string | null): number => (cacheKey === null ? 0 : (this.#generations.get(cacheKey) ?? 0));

  /** C14: the detection reply for this base URL and credential can no longer be trusted, nor anything decided on it. */
  #discardDetection(cacheKey: string | null): void {
    if (cacheKey === null) return;
    this.#detections.delete(cacheKey);
    this.#heldDetections.delete(cacheKey);
    this.#generations.set(cacheKey, this.#generation(cacheKey) + 1);
  }

  /**
   * Decides one request. `model` is its `model` field and `configured` a `Route-Policy` value the harness sends
   * on its own. Reads the gateway first when the decision needs it: detection whenever a policy reaches the
   * request, the model list when a requirement does, the key's own included. A request no policy reaches fetches
   * nothing, but is still judged against what is already held for its base URL and credential (C16). A place
   * whose base URL cannot be used as written blocks a request a policy reaches, before any read.
   */
  async decide(located: Located, model: string, configured: string | null): Promise<Prepared> {
    const { target, unexact } = located;
    const key = this.#key(located);
    // Taken before any read: a discard while this decision waits makes it stale.
    const generation = this.#generation(key);
    const prepared = (decision: Decision): Prepared => ({ decision, target: { ...target, base: normalizeBase(target.base) }, unexact, generation });
    const layers = readLayers(this.held, model, configured);
    if (!layers.ok) return prepared({ action: "block", reason: layers.reason });
    // A base URL the parser would not send as written is somewhere else than written: nothing is read from it,
    // and no policy is sent to it. A request no policy reaches goes on as the harness sends it.
    if (unexact !== null && anyPolicy(layers.value)) return prepared({ action: "block", reason: unexact });
    const base = normalizeBase(target.base);
    this.#bases.add(base);
    // What is held for this place, and only this place: a place not as written has no key, so holds nothing.
    let detection: Detection | null = key === null ? null : (this.#heldDetections.get(key) ?? null);
    let noDetection = "not fetched";
    let modelList: { list: unknown } | null = key === null ? null : (this.#heldLists.get(key) ?? null);
    if (anyPolicy(layers.value)) {
      const result = await this.#detection(located);
      detection = result.ok ? result.detection : null;
      if (!result.ok) noDetection = result.why;
      const bound = detection?.keyPolicy == null ? null : parsePolicy(detection.keyPolicy, detection.support);
      const requirement = anyRequirement(layers.value) || (bound?.ok === true && hasRequirements(bound.value));
      if (detection !== null && requirement && !isOpenRouter(base)) {
        modelList = await this.#modelList(located);
      }
    }
    // The decision names the place with its query: a base URL that differs in its query is another base URL.
    return prepared(decide(layers.value, this.#options.carriers, { base: `${base}${target.query}`, detection, noDetection, modelList }));
  }

  /** Whether nothing a decision relied on has been discarded since it was made (C14). */
  isCurrent(prepared: Prepared): boolean {
    return prepared.generation === this.#generation(this.#key(prepared));
  }

  /**
   * Releases a decided request by the bytes it will leave with: its policy header and its serialized body, to
   * the target's base URL with the target's authentication context. The fetch gate lets exactly those bytes go,
   * once, while the decision is current, and hands this client the response to that call.
   */
  release(prepared: Prepared & { decision: Exclude<Decision, { action: "block" }> }, header: string | null, body: string): void {
    const { decision, target } = prepared;
    const cacheKey = this.#key(prepared);
    const session = this.#session;
    const sent: Sent = decision.action === "translate" ? { kind: "translated" } : { kind: "protocol", policy: decision.sent, routes: decision.routes };
    const requirement = decision.sent !== null && hasRequirements(decision.sent);
    const subject = `request for ${decision.model} to ${target.base}${target.query}`;
    this.#bases.add(target.base);
    this.#withdrawals.push(
      addRelease({
        owner: this,
        base: target.base,
        query: target.query,
        context: target.context,
        header,
        body,
        current: () => this.isCurrent(prepared),
        stopped: (reason) => {
          if (session === this.#session) this.blocked(reason);
        },
        complete: (completion) => this.#complete(cacheKey, sent, requirement, completion, subject, session),
      }),
    );
    // Withdrawing an old unused release can only stop it, never let anything through.
    while (this.#withdrawals.length > RELEASE_LIMIT) this.#withdrawals.shift()?.();
  }

  /** Reports a request the caller blocked: nothing of it was sent. */
  blocked(reason: string): void {
    this.#report({ kind: "blocked", reason }, null);
  }

  /**
   * The fetch gate's question about a POST no release matched. To a base URL this client sends to, it must not
   * leave if a policy could be at stake: one is held, or the request carries one, or its model cannot be read.
   */
  check(outgoing: Outgoing): string | null {
    const base = [...this.#bases].find((b) => outgoing.path.startsWith(`${b}/`));
    if (base === undefined) return null;
    const model = modelIn(outgoing.body);
    const atStake = this.held.kind !== "none" || outgoing.header !== null || model === undefined || (model ?? "").includes("+");
    if (!atStake) return null;
    // Names only: the values may be keys.
    const carried = outgoing.context.map(([name]) => name).join(", ") || "none";
    return `this request to ${base} is not one the plugin released: its URL, headers (it carries ${carried} besides the usual ones), body, or Route-Policy header differs from what was checked, or it was already sent once`;
  }

  /**
   * Reads the response to one released request (C3, C4, C5, C8), in the spec's order: a refusal is a refusal
   * whatever else holds; a translated request's result is unconfirmed whatever else holds; only then is a
   * redirect, which the plugin never follows, a policy not honored.
   */
  #complete(cacheKey: string | null, sent: Sent, requirement: boolean, completion: Completion, subject: string, session: number): void {
    const read = interpret(completion.result, sent);
    const redirected = completion.status >= 300 && completion.status < 400;
    const redirect = `the gateway answered with a redirect (status ${completion.status}), which the plugin does not follow with content`;
    let report: Report = read;
    if (redirected && read.kind === "unconfirmed") report = { kind: "unconfirmed", note: redirect };
    else if (redirected && read.kind !== "refused" && sent.kind === "protocol" && sent.policy !== null) report = { kind: "not-honored", why: redirect };
    // C14: a requirement that came back not honored means the detection reply can no longer be trusted there.
    if (report.kind === "not-honored" && requirement) this.#discardDetection(cacheKey);
    // What a late response says of the gateway counts above; it is shown only in the session that sent it.
    if (session === this.#session) this.#report(report, subject);
  }

  #report(report: Report, subject: string | null): void {
    this.lastReport = { report, subject };
    this.#options.onReport(report, subject);
  }

  /**
   * What `/route` shows: the held policy; for the current model's place, read the one way a request's guard reads
   * it, the gateway's detection state and the key's own policy; and the last result, with the request it was for.
   * `located` is the place, or why the current model has none.
   */
  async describe(located: Located | { why: string }): Promise<string> {
    const lines = [`Route policy: ${describeHeld(this.held)}`];
    if (!("target" in located)) {
      lines.push(`Gateway: unknown, nothing was read (${located.why})`);
    } else {
      const { target } = located;
      const base = `${normalizeBase(target.base)}${target.query}`;
      const credentials = credentialNames(target.context);
      // Which credential the reply is for, by header name only: the values are keys.
      const as = credentials.length === 0 ? "without a credential" : `with the credential in ${credentials.join(", ")}`;
      const result = await this.#detection(located);
      if (!result.ok) {
        lines.push(`Gateway ${base}, read ${as}: no detection (${result.why})${isOpenRouter(target.base) ? "; policies are translated into OpenRouter's own fields where it has a filter for them" : ""}`);
      } else {
        const { support, keyPolicy } = result.detection;
        lines.push(`Gateway ${base}, read ${as}: detection valid; accepts ${[...support.keys].join(", ")}`);
        // A reply to a request without a credential has no key_policy by definition (C6); it says nothing of a key.
        if (keyPolicy === null) lines.push(credentials.length === 0 ? "Key policy: unknown, the request carries no credential" : "Key policy: none");
        else if (parsePolicy(keyPolicy, support).ok) lines.push(`Key policy (locked, applied by the gateway to every request with this key): ${keyPolicy}`);
        // C12, C13: shown as text, relied on for nothing.
        else lines.push(`Key policy (locked): "${keyPolicy}", which this client cannot interpret; shown as text and relied on for nothing`);
      }
    }
    const last = this.lastReport;
    lines.push(last === null ? "Last result: none yet in this session" : `Last result${last.subject === null ? "" : ` (${last.subject})`}: ${describeReport(last.report)}`);
    return lines.join("\n");
  }
}
