// Translation into OpenRouter's provider field (C9, C8): which policies map, to exactly what, and which base URL is
// OpenRouter's. Each row is an input and the whole result, written out.

import { combinePolicies, parsePolicy } from "../../../core/src/index.ts";
import { isOpenRouter, OPENROUTER_BASE, OPENROUTER_PROVIDER_APIS, translateToOpenRouter } from "../src/openrouter.ts";
import { sameList, table } from "./table.ts";

sameList("", "OPENROUTER_PROVIDER_APIS", OPENROUTER_PROVIDER_APIS, ["openai-completions", "openai-responses", "anthropic-messages"]);
sameList("", "OPENROUTER_BASE", OPENROUTER_BASE, "https://openrouter.ai/api/v1");

/** A policy as a row writes it: its text, or a header and a suffix the gateway would combine. */
function translated(row: string | { header: string; suffix: string }): unknown {
  const read = (text: string) => {
    const parsed = parsePolicy(text);
    if (!parsed.ok) throw new Error(`the row's policy "${text}" is not valid: ${parsed.detail}`);
    return parsed.value;
  };
  return translateToOpenRouter(typeof row === "string" ? read(row) : combinePolicies({ header: read(row.header), suffix: read(row.suffix) }));
}

table("C9", "translateToOpenRouter", translated, [
  ["only=aurora,basalt", { ok: true, provider: { only: ["aurora", "basalt"] } }],
  ["ignore=cobalt", { ok: true, provider: { ignore: ["cobalt"] } }],
  ["ignore=cobalt,basalt", { ok: true, provider: { ignore: ["cobalt", "basalt"] } }],
  ["only=aurora,cobalt+ignore=basalt,dante", { ok: true, provider: { only: ["aurora", "cobalt"], ignore: ["basalt", "dante"] } }],
  ["only=aurora+ignore=cobalt+sort=price", { ok: true, provider: { only: ["aurora"], ignore: ["cobalt"], sort: "price" } }],
  ["sort=latency", { ok: true, provider: { sort: "latency" } }],
  ["sort=throughput+order=basalt,aurora", { ok: true, provider: { sort: "throughput", order: ["basalt", "aurora"] } }],
  ["zdr", { ok: false, why: "cannot be translated for OpenRouter: zdr has no hard filter there (its zdr field still admits Safety Retention endpoints)" }],
  ["zdr+only=aurora", { ok: false, why: "cannot be translated for OpenRouter: zdr has no hard filter there (its zdr field still admits Safety Retention endpoints)" }],
  ["zdr+sort=price", { ok: false, why: "cannot be translated for OpenRouter: zdr has no hard filter there (its zdr field still admits Safety Retention endpoints)" }],
  ["notrain", { ok: false, why: "cannot be translated for OpenRouter: notrain has no hard filter there (data_collection covers the model providers, not OpenRouter itself)" }],
  ["notrain+only=aurora", { ok: false, why: "cannot be translated for OpenRouter: notrain has no hard filter there (data_collection covers the model providers, not OpenRouter itself)" }],
  ["notrain+sort=price", { ok: false, why: "cannot be translated for OpenRouter: notrain has no hard filter there (data_collection covers the model providers, not OpenRouter itself)" }],
  ["bits=8", { ok: false, why: "cannot be translated for OpenRouter: bits has no hard filter there (quantizations names levels, not a floor on every weight)" }],
  ["bits=8+only=aurora", { ok: false, why: "cannot be translated for OpenRouter: bits has no hard filter there (quantizations names levels, not a floor on every weight)" }],
  ["bits=8+sort=price", { ok: false, why: "cannot be translated for OpenRouter: bits has no hard filter there (quantizations names levels, not a floor on every weight)" }],
  ["region=us", { ok: false, why: "cannot be translated for OpenRouter: region has no request field there" }],
  ["region=us+only=aurora", { ok: false, why: "cannot be translated for OpenRouter: region has no request field there" }],
  ["region=us+sort=price", { ok: false, why: "cannot be translated for OpenRouter: region has no request field there" }],
  ["attest=weights", { ok: false, why: "cannot be translated for OpenRouter: attest has no counterpart there" }],
  ["attest=weights+only=aurora", { ok: false, why: "cannot be translated for OpenRouter: attest has no counterpart there" }],
  ["attest=weights+sort=price", { ok: false, why: "cannot be translated for OpenRouter: attest has no counterpart there" }],
  [{ header: "only=aurora", suffix: "only=basalt" }, { ok: false, why: "cannot be translated for OpenRouter: only combines to an empty list, which no route can meet" }],
  [{ header: "only=aurora,basalt", suffix: "only=basalt" }, { ok: true, provider: { only: ["basalt"] } }],
  ["order=cobalt", { ok: true, provider: { order: ["cobalt"] } }],
]);

table("", "isOpenRouter", isOpenRouter, [
  ["https://openrouter.ai/api/v1", true],
  ["https://openrouter.ai/api/v1/", true],
  ["https://openrouter.ai/api/v1//", true],
  ["http://openrouter.ai/api/v1", false],
  ["https://eu.openrouter.ai/api/v1", false],
  ["https://openrouter.ai/api/v1?", false],
  ["https://openrouter.ai/api/v1?tenant=east", false],
  ["https://openrouter.ai/api/v2", false],
  ["https://openrouter.ai:8443/api/v1", false],
  ["https://OPENROUTER.ai/api/v1", false],
]);
