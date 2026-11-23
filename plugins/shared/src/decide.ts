/**
 * The send decision for one outgoing request (SPEC.md, Clients): send it with these carriers, translate it into a
 * gateway's own fields, or block it so that no content leaves. Pure: the caller fetches detection and the model
 * list first and passes in what it holds.
 */

import {
  clearedToSend,
  combinePolicies,
  formatPolicy,
  hasRequirements,
  keysOf,
  parsePolicy,
  publishedRoutes,
  someRouteMeets,
  splitModel,
  type Detection,
  type Policy,
  type PublishedRoute,
  type Support,
} from "../../../core/src/index.ts";
import type { Held } from "./held.ts";
import { isOpenRouter, translateToOpenRouter } from "./openrouter.ts";

/** What the plugin can write on a request: both carriers, or only the model suffix. */
export type Carriers = "header" | "suffix";

/** The policies that reach a request before the plugin touches it, plus the one the user holds. */
export interface Layers {
  /** The `model` field as the harness would send it, possibly with a suffix the user typed. */
  model: string;
  typed: Policy | null;
  /** A `Route-Policy` value the harness sends on its own, from its provider configuration. */
  configured: { text: string; policy: Policy } | null;
  held: Policy | null;
}

export type Read<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Reads the policies that reach a request. A typed suffix or configured header that does not parse is a policy
 * the client cannot judge, so the request is blocked rather than sent with it.
 */
export function readLayers(held: Held, model: string, configured: string | null): Read<Layers> {
  if (held.kind === "invalid") return { ok: false, reason: `the held policy "${held.text}" is not valid: ${held.detail}` };
  const suffix = splitModel(model).policy;
  const typed = suffix === null ? null : parsePolicy(suffix);
  if (typed !== null && !typed.ok) return { ok: false, reason: `the model id "${model}" carries a suffix that is not a valid policy: ${typed.detail}` };
  const header = configured === null ? null : parsePolicy(configured);
  if (header !== null && !header.ok) return { ok: false, reason: `the configured Route-Policy header "${configured}" is not a valid policy: ${header.detail}` };
  return {
    ok: true,
    value: {
      model,
      typed: typed?.value ?? null,
      configured: configured === null || header === null ? null : { text: configured, policy: header.value },
      held: held.kind === "policy" ? held.policy : null,
    },
  };
}

const present = (layers: Layers): Policy[] => [layers.configured?.policy ?? null, layers.held, layers.typed].filter((p) => p !== null);

/** Whether any policy reaches the request, which is when detection matters. */
export const anyPolicy = (layers: Layers): boolean => present(layers).length > 0;

/** Whether any policy that reaches the request has a requirement, which is when the model list matters. */
export const anyRequirement = (layers: Layers): boolean => present(layers).some(hasRequirements);

/** What the client holds about the gateway at the request's base URL, for the request's credential. */
export interface GatewayState {
  base: string;
  detection: Detection | null;
  /** Why there is no detection, for the message when a request is blocked for it. */
  noDetection: string;
  /** The model list held for this base URL and credential, or null when none is held. */
  modelList: { list: unknown } | null;
}

export type Decision =
  | {
      action: "send";
      model: string;
      header: string | null;
      /** The policies the request carries, combined; null when it carries none. */
      sent: Policy | null;
      /** The routes the held model list publishes for the model, for reading the result (C4); null when none is held. */
      routes: Map<string, PublishedRoute | null> | null;
    }
  | { action: "translate"; model: string; provider: Record<string, unknown>; sent: Policy }
  | { action: "block"; reason: string };

const block = (reason: string): Decision => ({ action: "block", reason });

/** Combines layers given least specific first, skipping absent ones (SPEC.md, Combining). */
function layered(leastSpecific: Policy | null, middle: Policy | null, mostSpecific: Policy | null): Policy {
  return combinePolicies({
    ...(leastSpecific === null ? {} : { key: leastSpecific }),
    ...(middle === null ? {} : { header: middle }),
    ...(mostSpecific === null ? {} : { suffix: mostSpecific }),
  });
}

/** Keys and values the policies use that the reply does not list, for telling the user what is missing. */
function unlisted(support: Support, policies: readonly Policy[]): string[] {
  const missing = new Set<string>();
  for (const policy of policies) {
    for (const key of keysOf(policy)) if (!support.keys.has(key)) missing.add(key);
    for (const item of policy.attest) if (!support.attest.has(item)) missing.add(`attest=${item}`);
    if (policy.sort !== null && !support.sort.has(policy.sort)) missing.add(`sort=${policy.sort}`);
  }
  return [...missing];
}

function parsed(text: string): Policy {
  const result = parsePolicy(text);
  // Every string reaching here was parsed or written by the core already; failing here is a programming error.
  if (!result.ok) throw new Error(`"${text}" stopped parsing: ${result.detail}`);
  return result.value;
}

/** The decision for one request. `carriers` says whether the harness lets the plugin set a header. */
export function decide(layers: Layers, carriers: Carriers, gateway: GatewayState): Decision {
  const { model, typed, configured, held } = layers;
  if (!anyPolicy(layers)) return { action: "send", model, header: null, sent: null, routes: null };

  if (gateway.detection === null && isOpenRouter(gateway.base)) {
    // Translation sends no carrier of this protocol (SPEC.md, Clients, Translation): every layer combines into
    // the gateway's own fields, a typed suffix the most specific.
    if (configured !== null && carriers === "suffix") return block("a Route-Policy header is configured for this provider, and this harness gives the plugin no way to remove it from a translated request");
    const combined = layered(configured?.policy ?? null, held, typed);
    const translation = translateToOpenRouter(combined);
    if (!translation.ok) return block(`the policy ${translation.why}`);
    return { action: "translate", model: splitModel(model).id, provider: translation.provider, sent: combined };
  }

  // Where the plugin can set the header, its own policy goes there and a typed suffix stays as typed; where it
  // cannot, its own policy joins the typed one in the suffix, the typed one the more specific (C10).
  let header = configured?.text ?? null;
  let wireModel = model;
  if (held !== null && carriers === "header") {
    const written = formatPolicy(layered(null, configured?.policy ?? null, held));
    if (!written.ok) return block(`the held policy and the configured Route-Policy header combine to one that cannot be written as a policy (${written.detail})`);
    header = written.value;
  } else if (held !== null) {
    const written = formatPolicy(layered(null, held, typed));
    if (!written.ok) return block(`the held policy and the typed suffix combine to one that cannot be written as a policy (${written.detail}); no weaker one is sent in its place`);
    wireModel = `${splitModel(model).id}+${written.value}`;
  }

  // From here the request is judged as it will go on the wire.
  const onHeader = header === null ? null : parsed(header);
  const suffix = splitModel(wireModel).policy;
  const onSuffix = suffix === null ? null : parsed(suffix);
  const carried = [onHeader, onSuffix].filter((p) => p !== null);
  const support = gateway.detection?.support ?? null;
  if (!clearedToSend(support, carried)) {
    return block(
      support === null
        ? `${gateway.base} has no valid detection reply (${gateway.noDetection}), so no requirement may be sent there`
        : `${gateway.base} does not list ${unlisted(support, carried).join(", ")} in its detection reply`,
    );
  }

  const sent = layered(null, onHeader, onSuffix);
  const routes = gateway.modelList === null ? null : publishedRoutes(gateway.modelList.list, wireModel);
  if (routes !== null) {
    // C16. The key's bound policy counts only when this client can interpret it (C12).
    const keyPolicy = gateway.detection?.keyPolicy ?? null;
    const bound = keyPolicy === null || gateway.detection === null ? null : parsePolicy(keyPolicy, gateway.detection.support);
    const all = bound?.ok ? layered(bound.value, onHeader, onSuffix) : sent;
    if (hasRequirements(all) && !someRouteMeets(routes, all)) {
      return block(`no route the model list publishes for ${splitModel(wireModel).id} meets the policy${bound?.ok ? " combined with the key's own" : ""}, so the gateway would refuse it only after receiving the content`);
    }
  }
  return { action: "send", model: wireModel, header, sent, routes };
}
