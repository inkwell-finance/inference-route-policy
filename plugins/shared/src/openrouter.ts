/**
 * Translation of a policy into OpenRouter's own `provider` request field, for the gateway at
 * https://openrouter.ai/api/v1, which has not adopted this protocol (SPEC.md, Clients, Translation).
 *
 * A requirement maps only where OpenRouter documents a filter that gives the protocol's whole guarantee. Every
 * mapping below cites the section of https://openrouter.ai/docs/features/provider-routing that documents it;
 * anything else makes the whole request unsendable (C9), and the result is never reported as applied (C8).
 */

import type { Policy } from "../../../core/src/index.ts";
import { normalizeBase } from "./gateway-client.ts";

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export const isOpenRouter = (base: string): boolean => normalizeBase(base) === OPENROUTER_BASE;

/**
 * The harness request APIs whose OpenRouter endpoint documents `provider: ProviderPreferences` in its request
 * schema: Chat Completions (https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion),
 * Responses (https://openrouter.ai/docs/api_reference/responses/overview), and Messages
 * (https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message). The names are the `api`
 * the harness gives the model; any other API is not translated.
 */
export const OPENROUTER_PROVIDER_APIS: readonly string[] = ["openai-completions", "openai-responses", "anthropic-messages"];

export type Translation = { ok: true; provider: Record<string, unknown> } | { ok: false; why: string };

/** The `provider` object for a policy, or why it cannot be sent to OpenRouter at all. */
export function translateToOpenRouter(policy: Policy): Translation {
  const refuse = (why: string): Translation => ({ ok: false, why: `cannot be translated for OpenRouter: ${why}` });
  // "Zero Data Retention Enforcement": with `zdr: true`, Safety Retention endpoints, which may keep prompts for
  // abuse review, stay eligible. This protocol's `zdr` counts that as retention.
  if (policy.zdr) return refuse("zdr has no hard filter there (its zdr field still admits Safety Retention endpoints)");
  // "Requiring Providers to Comply with Data Policies": `data_collection` filters the model providers only, and
  // says nothing of what OpenRouter itself does with content; `notrain` constrains everyone who receives it.
  if (policy.notrain) return refuse("notrain has no hard filter there (data_collection covers the model providers, not OpenRouter itself)");
  // "Quantization": `quantizations` filters by named levels; nothing there bounds the lowest precision of every
  // weight as served, which is what `bits` requires.
  if (policy.bits !== null) return refuse("bits has no hard filter there (quantizations names levels, not a floor on every weight)");
  // The only regional control is the hostname on Business and Enterprise plans ("Regional data residency" note).
  if (policy.region !== null) return refuse("region has no request field there");
  if (policy.attest.length > 0) return refuse("attest has no counterpart there");
  // An empty list in `only` might read as no list at all, so an empty intersection never reaches the wire.
  if (policy.only?.length === 0) return refuse("only combines to an empty list, which no route can meet");

  const provider: Record<string, unknown> = {};
  // "Allowing Only Specific Providers": `only` is the list of provider slugs to allow for this request.
  if (policy.only !== null) provider["only"] = [...policy.only];
  // "Ignoring Providers": `ignore` is the list of provider slugs to skip for this request.
  if (policy.ignore.length > 0) provider["ignore"] = [...policy.ignore];
  // "Provider Sorting": `price`, `throughput`, and `latency` are the documented sort values. A preference only.
  if (policy.sort !== null) provider["sort"] = policy.sort;
  // "Ordering Specific Providers": providers to try first, falling back to the rest. A preference only.
  if (policy.order !== null) provider["order"] = [...policy.order];
  return { ok: true, provider };
}
