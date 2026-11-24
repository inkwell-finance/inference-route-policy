// The plugin's constants and its blocking payload: the lists the rows of other tables span, and what a harness gets
// when it serializes a blocked payload.

import { blockedPayload, ENTRY_TYPE, MODEL_IN_URL_APIS, STATUS_KEY } from "../src/plugin.ts";
import { sameList, table } from "./table.ts";

sameList("", "MODEL_IN_URL_APIS", MODEL_IN_URL_APIS, ["google-generative-ai", "google-vertex", "google-gemini-cli", "bedrock-converse-stream"]);
sameList("", "ENTRY_TYPE", ENTRY_TYPE, "inference-route-policy");
sameList("", "STATUS_KEY", STATUS_KEY, "route-policy");

table("", "JSON.stringify of blockedPayload", (reason: string) => {
  const payload = blockedPayload(reason);
  try {
    return JSON.stringify(payload);
  } catch (error) {
    return { throws: String(error), frozen: Object.isFrozen(payload), keys: Object.keys(payload) };
  }
}, [
  ["no valid detection reply", { throws: "Error: Blocked by the route policy plugin, nothing was sent: no valid detection reply", frozen: true, keys: ["toJSON"] }],
  ["", { throws: "Error: Blocked by the route policy plugin, nothing was sent: ", frozen: true, keys: ["toJSON"] }],
]);
