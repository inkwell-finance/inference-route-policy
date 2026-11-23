/**
 * Translation of a policy into OpenRouter's own `provider` request field, for the gateway at
 * https://openrouter.ai/api/v1, which has not adopted this protocol (SPEC.md, Clients, Translation).
 *
 * Every mapping below cites the section of https://openrouter.ai/docs/features/provider-routing that documents
 * the field it uses. A requirement maps only where that page documents a filter that excludes every endpoint not
 * meeting it; anything else makes the whole request unsendable (C9), and the result is never reported as applied
 * (C8).
 */

import type { Policy } from "../../../core/src/index.ts";
import { normalizeBase } from "./gateway-client.ts";

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export const isOpenRouter = (base: string): boolean => normalizeBase(base) === OPENROUTER_BASE;

/**
 * Bits each documented quantization level stores its weights at ("Quantization" > "Quantization Levels").
 * `unknown` is left out: a route whose precision is not published does not qualify (SPEC.md, Keys).
 */
const QUANTIZATION_BITS: Readonly<Record<string, number>> = {
  int4: 4,
  int8: 8,
  fp4: 4,
  mxfp4: 4,
  nvfp4: 4,
  fp6: 6,
  fp8: 8,
  mxfp8: 8,
  fp16: 16,
  bf16: 16,
  fp32: 32,
};

export type Translation = { ok: true; provider: Record<string, unknown> } | { ok: false; why: string };

/** The `provider` object for a policy, or why it cannot be sent to OpenRouter at all. */
export function translateToOpenRouter(policy: Policy): Translation {
  const refuse = (why: string): Translation => ({ ok: false, why: `cannot be translated for OpenRouter: ${why}` });
  // "Zero Data Retention Enforcement": with `zdr: true`, Safety Retention endpoints, which may keep prompts for
  // abuse review, stay eligible unless an account setting the client cannot see excludes them. This protocol's
  // `zdr` counts that as retention, so the field is not a filter for it.
  if (policy.zdr) return refuse("zdr has no hard filter there (its zdr field still admits Safety Retention endpoints)");
  // The page's only regional control is the hostname on Business and Enterprise plans ("Regional data residency"
  // note); there is no request field.
  if (policy.region !== null) return refuse("region has no request field there");
  if (policy.attest.length > 0) return refuse("attest has no counterpart there");
  // An empty list in `only` might read as no list at all, so an empty intersection never reaches the wire.
  if (policy.only?.length === 0) return refuse("only combines to an empty list, which no route can meet");

  const provider: Record<string, unknown> = {};
  // "Requiring Providers to Comply with Data Policies": `deny` uses only providers which do not collect user data.
  if (policy.notrain) provider["data_collection"] = "deny";
  if (policy.bits !== null) {
    const floor = policy.bits;
    // "Quantization": `quantizations` filters providers to the listed levels.
    const levels = Object.keys(QUANTIZATION_BITS).filter((level) => QUANTIZATION_BITS[level]! >= floor);
    if (levels.length === 0) return refuse(`no documented quantization level has ${floor} bits or more`);
    provider["quantizations"] = levels;
  }
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
