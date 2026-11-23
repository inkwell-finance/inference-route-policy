/**
 * The policy the user holds for this client: set with `/route`, restored with the session, or taken from
 * `ROUTE_POLICY`. A policy the user meant to set but that does not parse is kept as invalid rather than dropped,
 * so every request is blocked until it is fixed: losing a requirement silently is the one thing a client must
 * never do.
 */

import { parsePolicy, type Policy } from "../../../core/src/index.ts";

export type Held =
  | { kind: "none" }
  | { kind: "policy"; text: string; policy: Policy; source: HeldSource }
  | { kind: "invalid"; text: string; detail: string; source: HeldSource };

export type HeldSource = "session" | "env";

/** Parses what the user set. The gateway's detection reply decides later whether it may be sent there. */
export function holdPolicy(text: string, source: HeldSource): Held {
  const parsed = parsePolicy(text);
  return parsed.ok ? { kind: "policy", text, policy: parsed.value, source } : { kind: "invalid", text, detail: parsed.detail, source };
}

/** The default when the session sets nothing: `ROUTE_POLICY`, unset or empty meaning no policy. */
export function heldFromEnv(env: Readonly<Record<string, string | undefined>>): Held {
  const text = env["ROUTE_POLICY"];
  return text === undefined || text === "" ? { kind: "none" } : holdPolicy(text, "env");
}

/** The session entry that records the user's choice; `policy: null` records a clear. */
export interface HeldEntry {
  policy: string | null;
}

/** Reads a stored entry, which is plugin-written data from a session file and so is checked like any input. */
export function heldFromEntry(data: unknown): Held | null {
  if (typeof data !== "object" || data === null || !("policy" in data)) return null;
  const { policy } = data;
  if (policy === null) return { kind: "none" };
  return typeof policy === "string" ? holdPolicy(policy, "session") : null;
}

export function describeHeld(held: Held): string {
  switch (held.kind) {
    case "none":
      return "none";
    case "policy":
      return `${held.text} (${held.source === "env" ? "from ROUTE_POLICY" : "set in this session"})`;
    case "invalid":
      return `"${held.text}" is not a valid policy (${held.detail}); every request is blocked until it is fixed or cleared`;
  }
}
