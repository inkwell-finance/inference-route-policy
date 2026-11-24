import { failure, skip, type Overrides } from "./report.ts";

const model = "other/example-model.v2";
export const get = (path: string, credentialHeader: string | null = "authorization") => ({ method: "GET", path, credentialHeader });
const post = (body: string, routePolicyLines?: readonly string[][]) => ({ method: "POST", path: "/chat/completions", credentialHeader: "authorization", routePolicyLines, body });
export const inference = (model: string, lines?: readonly string[][], stream = false) => post(JSON.stringify({
  model, messages: [{ role: "user", content: "Reply with one word." }], max_tokens: 16, stream,
}), lines);
export const received = (status: number, body: string, applied: string[] = [], refused: string[] = [], evidence: string[] = [], contentType: string | null = "application/json") =>
  ({ status, contentType: contentType ?? undefined, applied, refused, evidence, body });
export const error = (message: string, type: string, typeFirst = false) => JSON.stringify({ error: typeFirst ? { type, message } : { message, type } });

export const discovery = (n: 3 | 5): Overrides => ({
  G20: ["PASS", `valid detection objects returned for all ${n} requested credential scopes, including anonymous; observed ${n} × HTTP 200`],
});
export const catalogs = (n: 2 | 4): Overrides => ({
  G23: ["PASS", `validated model and route entries in all ${n} requested catalog scopes; observed ${n} × HTTP 200`],
});

// Literal per-fixture exceptions to the all-PASS inventory. The diagnostic
// constructors format the expected on-wire examples; none calls the checker.
export const expectedByCase = {
  fault: {
    "G1": {
      "G1 [chat/completions]": failure(inference(model, [["Route-Policy","zdr++notrain"]]), received(200, JSON.stringify({"text":"served by aurora.example"}), ["provider=aurora"]), "the policy must be refused as unsupported"),
    },
    "G2": {
      "G2 [chat/completions]": failure(inference(model, [["Route-Policy","bits=0+only=a,a"]]), received(400, error("Route policy unsupported", "invalid_request_error", true), [], ["reason=unsupported+key=only"]), "the first failure names bits"),
    },
    "G3": {
      "G3 [chat/completions]": failure(inference(model, [["Route-Policy","bits=64"]]), received(503, error("Route policy unsatisfiable", "invalid_request_error", true), [], ["reason=unavailable"]), "HTTP 400 with only a valid unsatisfiable refusal"),
      "G9 [chat/completions]": "FAIL", "G29 [chat/completions]": "FAIL",
    },
    "G6": {
      "G6 [chat/completions]": failure(inference(model, [["Route-Policy","bits=1"]]), received(200, JSON.stringify({"text":"served by aurora.example"}), ["provider=cobalt"]), "the named published route must meet at least the known requirements; an unknown key default cannot admit an excluded route"),
      "G10 [chat/completions]": "FAIL", "G11 [chat/completions]": "FAIL", "G13 [chat/completions]": "FAIL",
    },
    "G7": {
      "G7 [chat/completions]": failure(inference(model, [["Route-Policy","zdr+order=basalt"]]), received(400, error("Route policy unsatisfiable", "invalid_request_error", true), [], ["reason=unsatisfiable"]), "an accepted preference cannot disqualify the matching published routes"),
      "G3 [chat/completions]": "FAIL",
    },
    "G8": {
      "G8 [chat/completions]": failure(inference(model + "+bits=64"), received(200, JSON.stringify({"text":"served by aurora.example"})), "no published route meets even the known suffix requirements"),
      "G3 [chat/completions]": "FAIL", "G6 [chat/completions]": "FAIL", "G15 [chat/completions]": "FAIL",
    },
    "G9": {
      "G9 [chat/completions]": failure(inference(model, [["Route-Policy","only=routeprobe0"],["rOuTe-PoLiCy","probe1"]]), received(400, error("Route policy unsupported", "invalid_request_error", true), [], ["reason=unsupported+key=only"]), "two raw Route-Policy lines return 400 unsupported without a key"),
      "G2 [chat/completions]": "FAIL",
    },
    "G10": {
      "G10 [chat/completions]": failure(inference(model), received(200, JSON.stringify({"text":"served by basalt.example"}), ["provider=basalt"]), "the relayed route must meet the detected key default even in the presence of explicit carriers"),
      "G6 [chat/completions]": "FAIL",
    },
    "G11": {
      "G11 [chat/completions]": failure(inference(model + "+bits=0", [["Route-Policy","only=x,x"]]), received(400, error("Route policy unsupported", "invalid_request_error", true), [], ["reason=unsupported+key=bits"]), "swapping malformed carriers reports only, the header's first failure"),
      "G2 [chat/completions]": "FAIL",
    },
    "G12": {
      "G12 [chat/completions]": failure(inference(model + "+region=de", [["Route-Policy","region=us"]]), received(200, JSON.stringify({"text":"served by aurora.example"}), ["provider=aurora"]), "400 unsatisfiable for an empty intersection in either carrier order"),
      "G3 [chat/completions]": "FAIL", "G6 [chat/completions]": "FAIL",
    },
    "G13": {
      "G13 [chat/completions]": failure(inference(model + "+bits=9", [["Route-Policy","bits=9"]]), received(200, JSON.stringify({"text":"served by basalt.example"}), ["provider=basalt"]), "neither explicit carrier can weaken the detected key default"),
      "G3 [chat/completions]": "FAIL", "G6 [chat/completions]": "FAIL", "G10 [chat/completions]": "FAIL",
    },
    "G15": {
      "G15 [chat/completions]": failure(inference(model, [["Route-Policy","zdr"]], true), received(200, JSON.stringify({"text":"served by aurora.example"})), "one valid Route-Applied naming a published provider for this model"),
      "G6 [chat/completions]": "FAIL",
    },
    "G17": {
      "G17 [chat/completions]": failure(inference(model, [["Route-Policy","attest=weights"]]), received(200, JSON.stringify({"text":"served by basalt.example"}), ["provider=basalt"], [], ["https://basalt.example/attestation/"]), "Route-Evidence exactly matches the applied route's published URI"),
      "G3 [chat/completions]": "FAIL", "G11 [chat/completions]": "FAIL", "G13 [chat/completions]": "FAIL",
      "G21 [chat/completions]": "FAIL", "G19 [chat/completions]": "FAIL",
    },
    "G19": {
      "G19 [chat/completions]": failure(inference(model, [["Route-Policy","bits=64"]]), received(400, error("Route policy unsatisfiable", "invalid_request_error", true), ["provider=aurora"], ["reason=unsatisfiable"]), "a refusal has neither Route-Applied nor Route-Evidence"),
      "G1 [chat/completions]": "FAIL", "G3 [chat/completions]": "FAIL", "G9 [chat/completions]": "FAIL",
      "G11 [chat/completions]": "FAIL", "G21 [chat/completions]": "FAIL", "G29 [chat/completions]": "FAIL",
    },
    "G20": {
      "G20": failure(get("/route-policy", null), received(200, JSON.stringify({"route_policy":1})), "a complete valid detection reply: is not the string \"1\""),
    },
    "G21": {
      "G21 [chat/completions]": failure(inference(model, [["Route-Policy","sort=throughput"]]), received(200, JSON.stringify({"text":"served by cobalt.example"}), ["provider=cobalt"]), "unlisted sort refuses sort=throughput"),
      "G1 [chat/completions]": "FAIL",
    },
    "G22": {
      "G22": failure(get("/route-policy", null), received(200, JSON.stringify({"route_policy":"1","key_policy":"zdr"})), "key_policy absent for anonymous detection"),
      "G20": "FAIL",
    },
    "G23": {
      "G23": failure(get("/models"), received(200, JSON.stringify({"data":[{"id":"other/example-model.v2","routes":[{"provider":"aurora","facts":"zdr+notrain+bits=8+region=us"},{"provider":"basalt","facts":"bits=16+region=us,de+attest=weights,prompt","evidence":"https://basalt.example/attestation"},{"provider":"cobalt","facts":""},{"provider":"aurora","facts":"zdr+notrain+bits=8+region=us"}]}]})), "invalid or repeated provider on other/example-model.v2: {\"provider\":\"aurora\",\"facts\":\"zdr+notrain+bits=8+region=us\"}"),
      "G1 [chat/completions]": "SKIP", "G2 [chat/completions]": "SKIP", "G3 [chat/completions]": "SKIP",
      "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G8 [chat/completions]": "SKIP",
      "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP",
      "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP",
      "G17 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
      "G19 [chat/completions]": "SKIP",
    },
    "G24": {
      "G24 [chat/completions]": failure(inference(model, [["Route-Policy","order=routeprobe0"]]), received(400, error("Route policy unsatisfiable", "invalid_request_error", true), [], ["reason=unsatisfiable"]), "an unknown provider id does not remove the remaining matching routes"),
      "G3 [chat/completions]": "FAIL", "G6 [chat/completions]": "FAIL", "G7 [chat/completions]": "FAIL",
      "G13 [chat/completions]": "FAIL",
    },
    "G25": {
      "G25 [chat/completions]": failure(post("{\"model\":4}", [["Route-Policy","bits=0"]]), received(400, error("fixture refusal", "invalid_request_error"), [], ["reason=unsupported+key=bits"]), "the same ordinary error status 400 as the no-policy control, with no result headers"),
    },
    "G26": {
      "G26 [chat/completions]": failure(inference(model), received(200, JSON.stringify({"text":"served by aurora.example"}), [], [], ["https://aurora.example/"]), "no Route-Refused or Route-Evidence without a policy"),
    },
    "G29": {
      "G29 [chat/completions]": failure(inference(model + "+bits=0", [["Route-Policy","bits=64"]]), received(400, error("Route policy unsatisfiable", "invalid_request_error", true), [], ["reason=unsatisfiable"]), "unsupported takes precedence over unsatisfiable"),
      "G1 [chat/completions]": "FAIL",
    },
  } satisfies Readonly<Record<string, Overrides>>,
  coding: {
    "route-policy": {
      "G20": skip("inspectable /route-policy reply (unsupported Content-Encoding x-reversed-octets)"),
      "G22": skip("inspectable detection object (unsupported Content-Encoding x-reversed-octets)"),
      "G3 [chat/completions]": "SKIP", "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP",
      "G8 [chat/completions]": "SKIP", "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP",
      "G11 [chat/completions]": "SKIP", "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP",
      "G15 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
    },
    "models": {
      "G22": ["PASS","the anonymous reply omitted key_policy; every observed credentialed key_policy was valid under its own lists; observed 3 × HTTP 200"],
      "G23": skip("inspectable /models reply (unsupported Content-Encoding x-reversed-octets)"),
      "G1 [chat/completions]": "SKIP", "G2 [chat/completions]": "SKIP", "G3 [chat/completions]": "SKIP",
      "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G8 [chat/completions]": "SKIP",
      "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP",
      "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP",
      "G17 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
      "G19 [chat/completions]": "SKIP",
    },
  } satisfies Readonly<Record<string, Overrides>>,
  defaultModel: {
    "relay": {
      "G25 [chat/completions]": skip("missing model field subcase: accepted-policy control reached routing (HTTP 422)"),
    },
    "uncertain origin": {
      "G25 [chat/completions]": skip("missing model field subcase: accepted-policy control did not establish error origin (no-policy HTTP 422; HTTP 409)"),
    },
  } satisfies Readonly<Record<string, Overrides>>,
  syntheticError: {
    "400": {
      "G25 [chat/completions]": skip("bad-credentials subcase: accepted-policy control reached routing (HTTP 400)"),
      "G10 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP",
    },
    "422": {
      "G25 [chat/completions]": skip("bad-credentials subcase: accepted-policy control reached routing (HTTP 422)"),
      "G10 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP",
    },
  } satisfies Readonly<Record<string, Overrides>>,
  stableError: {
    "unknown model:bare": {
      "G25 [chat/completions]": ["PASS","corroborated ordinary errors retained their status and no route headers when challenged with a policy; observed 9 × HTTP 400, 3 × HTTP 404, 3 × HTTP 422, 4 × HTTP 401, 2 × HTTP 200, 1 × HTTP 200 provider=aurora"],
    },
    "unknown model:refused": {
      "G25 [chat/completions]": failure(inference("route-conformance-unknown-0+bits=0", [["Route-Policy","bits=0"]]), received(400, error("bad policy", "invalid_request_error", true), [], ["reason=unsupported+key=bits"]), "the same ordinary error status 422 as the no-policy control, with no result headers"),
    },
    "unrecognized credential:bare": {
      "G25 [chat/completions]": ["PASS","corroborated ordinary errors retained their status and no route headers when challenged with a policy; observed 9 × HTTP 400, 6 × HTTP 404, 4 × HTTP 418, 2 × HTTP 200, 1 × HTTP 200 provider=aurora"],
    },
    "unrecognized credential:refused": {
      "G25 [chat/completions]": failure(inference(model, [["Route-Policy","bits=0"]]), received(400, error("bad policy", "invalid_request_error", true), [], ["reason=unsupported+key=bits"]), "the same ordinary error status 418 as the no-policy control, with no result headers"),
    },
  } satisfies Readonly<Record<string, Overrides>>,
  capabilities: {
    "detection lists zdr, attest=prompt and sort=latency": {
      "G12 [chat/completions]": skip("at least one of only and region accepted"),
      "G3 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
    },
    "detection lists an empty keys array": {
      "G3 [chat/completions]": skip("an accepted policy no published route meets, even before unknown key requirements"),
      "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G8 [chat/completions]": "SKIP",
      "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP",
      "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP",
      "G17 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP", "G25 [chat/completions]": "SKIP",
      "G29 [chat/completions]": "SKIP",
    },
    "the catalog contains a single Aurora route": {
      "G13 [chat/completions]": skip("an accepted explicit policy whose routes are all excluded by the bound requirement"),
      "G10 [chat/completions]": "SKIP", "G17 [chat/completions]": "SKIP",
    },
    "the catalog contains Aurora and Cobalt without attest": {
      "G17 [chat/completions]": skip("a relay with a known attest requirement and published evidence"),
    },
    "both credentials are unbound": {
      "G10 [chat/completions]": skip("a usable credential with a detected, interpretable policy (supply --policy-key)"),
      "G13 [chat/completions]": "SKIP",
    },
    "/models returns an empty data array": {
      "G1 [chat/completions]": skip("a published base model for this endpoint's credential"),
      "G2 [chat/completions]": "SKIP", "G3 [chat/completions]": "SKIP", "G6 [chat/completions]": "SKIP",
      "G7 [chat/completions]": "SKIP", "G8 [chat/completions]": "SKIP", "G9 [chat/completions]": "SKIP",
      "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP", "G12 [chat/completions]": "SKIP",
      "G13 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP", "G17 [chat/completions]": "SKIP",
      "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP", "G25 [chat/completions]": "SKIP",
      "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP", "G19 [chat/completions]": "SKIP",
    },
  } satisfies Readonly<Record<string, Overrides>>,
  clause: {
    "bits=0 with HTTP 422 unsupported fails": {
      "G1 [chat/completions]": failure(inference(model, [["Route-Policy","bits=0"]]), received(422, error("Route policy unsupported", "invalid_request_error", true), [], ["reason=unsupported+key=bits"]), "HTTP 400 with only a valid unsupported refusal"),
      "G25 [chat/completions]": "FAIL", "G19 [chat/completions]": "FAIL",
    },
    "bits=0 with HTTP 400 unsatisfiable fails": {
      "G1 [chat/completions]": failure(inference(model, [["Route-Policy","bits=0"]]), received(400, error("Route policy unsupported", "invalid_request_error", true), [], ["reason=unsatisfiable"]), "HTTP 400 with only a valid unsupported refusal"),
      "G25 [chat/completions]": "FAIL", "G29 [chat/completions]": "FAIL",
    },
    "bits=0+only=a,a fails if unsupported omits the key": {
      "G2 [chat/completions]": failure(inference(model, [["Route-Policy","bits=0+only=a,a"]]), received(400, error("Route policy unsupported", "invalid_request_error", true), [], ["reason=unsupported"]), "the first failure names bits"),
    },
    "Bad+bits=0 fails if unsupported names bits": {
      "G2 [chat/completions]": failure(inference(model, [["Route-Policy","Bad+bits=0"]]), received(400, error("Route policy unsupported", "invalid_request_error", true), [], ["reason=unsupported+key=bits"]), "the first failure names no key"),
    },
    "bits=64 with HTTP 422 unsatisfiable fails": {
      "G3 [chat/completions]": failure(inference(model, [["Route-Policy","bits=64"]]), received(422, error("Route policy unsatisfiable", "invalid_request_error", true), [], ["reason=unsatisfiable"]), "HTTP 400 with only a valid unsatisfiable refusal"),
      "G9 [chat/completions]": "FAIL", "G21 [chat/completions]": "FAIL", "G19 [chat/completions]": "FAIL",
    },
    "bits=64 with an unsatisfiable key=bits fails": {
      "G3 [chat/completions]": failure(inference(model, [["Route-Policy","bits=64"]]), received(400, error("Route policy unsatisfiable", "invalid_request_error", true), [], ["reason=unsatisfiable+key=bits"]), "HTTP 400 with only a valid unsatisfiable refusal"),
      "G9 [chat/completions]": "FAIL", "G21 [chat/completions]": "FAIL", "G19 [chat/completions]": "FAIL",
    },
    "bits=64 fails if the gateway relays the bits=1 response": {
      "G3 [chat/completions]": failure(inference(model, [["Route-Policy","bits=64"]]), received(200, JSON.stringify({"text":"served by aurora.example"}), ["provider=aurora"]), "the policy must be refused as unsatisfiable"),
      "G6 [chat/completions]": "FAIL", "G9 [chat/completions]": "FAIL",
    },
    "missing retention fact": {
      "G6 [chat/completions]": failure(inference(model, [["Route-Policy","zdr"]]), received(200, JSON.stringify({"text":"served by aurora.example"}), ["provider=cobalt"]), "the named published route must meet at least the known requirements; an unknown key default cannot admit an excluded route"),
      "G9 [chat/completions]": "FAIL", "G10 [chat/completions]": "FAIL", "G13 [chat/completions]": "FAIL",
      "G25 [chat/completions]": "SKIP",
    },
    "missing training fact": {
      "G6 [chat/completions]": failure(inference(model, [["Route-Policy","notrain"]]), received(200, JSON.stringify({"text":"served by aurora.example"}), ["provider=cobalt"]), "the named published route must meet at least the known requirements; an unknown key default cannot admit an excluded route"),
      "G10 [chat/completions]": "FAIL", "G13 [chat/completions]": "FAIL",
    },
    "bit precision below the floor": {
      "G6 [chat/completions]": failure(inference(model, [["Route-Policy","bits=9"]]), received(200, JSON.stringify({"text":"served by basalt.example"}), ["provider=aurora"]), "the named published route must meet at least the known requirements; an unknown key default cannot admit an excluded route"),
      "G3 [chat/completions]": "FAIL", "G13 [chat/completions]": "FAIL", "G19 [chat/completions]": "FAIL",
    },
    "route countries exceed allowed region": {
      "G6 [chat/completions]": failure(inference(model, [["Route-Policy","region=us"]]), received(200, JSON.stringify({"text":"served by aurora.example"}), ["provider=basalt"]), "the named published route must meet at least the known requirements; an unknown key default cannot admit an excluded route"),
      "G10 [chat/completions]": "FAIL", "G13 [chat/completions]": "FAIL",
    },
    "missing attestation item": {
      "G6 [chat/completions]": failure(inference(model, [["Route-Policy","attest=weights"]]), received(200, JSON.stringify({"text":"served by basalt.example"}), ["provider=aurora"], [], ["https://basalt.example/attestation"]), "the named published route must meet at least the known requirements; an unknown key default cannot admit an excluded route"),
      "G3 [chat/completions]": "FAIL", "G13 [chat/completions]": "FAIL", "G17 [chat/completions]": "FAIL",
      "G21 [chat/completions]": "FAIL", "G19 [chat/completions]": "FAIL",
    },
    "provider absent from only": {
      "G6 [chat/completions]": failure(inference(model, [["Route-Policy","only=basalt"]]), received(200, JSON.stringify({"text":"served by basalt.example"}), ["provider=aurora"]), "the named published route must meet at least the known requirements; an unknown key default cannot admit an excluded route"),
      "G3 [chat/completions]": "FAIL", "G13 [chat/completions]": "FAIL", "G19 [chat/completions]": "FAIL",
    },
    "provider named in ignore": {
      "G6 [chat/completions]": failure(inference(model, [["Route-Policy","ignore=aurora"]]), received(200, JSON.stringify({"text":"served by basalt.example"}), ["provider=aurora"]), "the named published route must meet at least the known requirements; an unknown key default cannot admit an excluded route"),
      "G3 [chat/completions]": "FAIL", "G13 [chat/completions]": "FAIL", "G19 [chat/completions]": "FAIL",
    },
    "zdr+order=basalt fails if Basalt is named": {
      "G7 [chat/completions]": failure(inference(model, [["Route-Policy","zdr+order=basalt"]]), received(200, JSON.stringify({"text":"served by aurora.example"}), ["provider=basalt"]), "preference must leave the same candidates (aurora), even if it points elsewhere"),
      "G6 [chat/completions]": "FAIL",
    },
    "sort=throughput with unsatisfiable fails": {
      "G7 [chat/completions]": failure(inference(model, [["Route-Policy","sort=throughput"]]), received(400, error("fixture refusal", "invalid_request_error"), [], ["reason=unsatisfiable"]), "an accepted preference cannot disqualify the matching published routes"),
      "G3 [chat/completions]": "FAIL",
    },
    "a 404 from the +zdr alias fails when its base model resolves": {
      "G8 [chat/completions]": failure(inference(model + "+zdr"), received(404, error("fixture refusal", "invalid_request_error")), "suffixed request resolves to a qualifying route or unavailable"),
    },
    "two Route-Policy lines fail if the gateway produces the zdr relay": {
      "G9 [chat/completions]": failure(inference(model, [["Route-Policy","only=routeprobe0"],["rOuTe-PoLiCy","probe1"]]), received(200, JSON.stringify({"text":"served by aurora.example"}), ["provider=aurora"]), "two raw Route-Policy lines return 400 unsupported without a key"),
      "G1 [chat/completions]": "FAIL",
    },
    "two Route-Policy lines with unsupported+key=only fail": {
      "G9 [chat/completions]": failure(inference(model, [["Route-Policy","only=routeprobe0"],["rOuTe-PoLiCy","probe1"]]), received(400, error("Route policy unsupported", "invalid_request_error", true), [], ["reason=unsupported+key=only"]), "two raw Route-Policy lines return 400 unsupported without a key"),
      "G2 [chat/completions]": "FAIL", "G25 [chat/completions]": "FAIL",
    },
    "the zdr-bound key fails if header only=basalt relays Basalt": {
      "G10 [chat/completions]": failure(inference(model, [["Route-Policy","only=basalt"]]), received(200, JSON.stringify({"text":"served by basalt.example"}), ["provider=basalt"]), "the relayed route must meet the detected key default even in the presence of explicit carriers"),
      "G3 [chat/completions]": "FAIL", "G6 [chat/completions]": "FAIL", "G13 [chat/completions]": "FAIL",
    },
    "header zdr fails if suffix bits=0 is bypassed": {
      "G11 [chat/completions]": failure(inference(model + "+bits=0", [["Route-Policy","zdr"]]), received(200, JSON.stringify({"text":"served by aurora.example"}), ["provider=aurora"]), "a valid header does not bypass validation of the suffix"),
      "G1 [chat/completions]": "FAIL",
    },
    "routing to the zdr-only route fails when the suffix also requires notrain": {
      "G11 [chat/completions]": failure(inference(model + "+notrain", [["Route-Policy","zdr"]]), received(200, JSON.stringify({"output":"served"}), ["provider=aurora"]), "both valid carriers constrain the request"),
      "G3 [chat/completions]": "FAIL", "G6 [chat/completions]": "FAIL",
    },
    "routing to the 8-bit route fails when the suffix requires bits=9": {
      "G11 [chat/completions]": failure(inference(model + "+bits=9", [["Route-Policy","bits=1"]]), received(200, JSON.stringify({"text":"served by aurora.example"}), ["provider=aurora"]), "both valid carriers constrain the request"),
      "G6 [chat/completions]": "FAIL",
    },
    "the us,de-only route fails when the suffix also requires region=de,jp": {
      "G11 [chat/completions]": failure(inference(model + "+region=de,jp", [["Route-Policy","region=us,de"]]), received(200, JSON.stringify({"output":"served"}), ["provider=aurora"]), "both valid carriers constrain the request"),
      "G6 [chat/completions]": "FAIL",
    },
    "Aurora fails when only=aurora,basalt intersects only=basalt,cobalt": {
      "G11 [chat/completions]": failure(inference(model + "+only=basalt,cobalt", [["Route-Policy","only=aurora,basalt"]]), received(200, JSON.stringify({"text":"served by aurora.example"}), ["provider=aurora"]), "both valid carriers constrain the request"),
      "G6 [chat/completions]": "FAIL",
    },
    "the weights-only route fails when the suffix also requires prompt": {
      "G11 [chat/completions]": failure(inference(model + "+attest=prompt", [["Route-Policy","attest=weights"]]), received(200, JSON.stringify({"output":"served"}), ["provider=aurora"], [], ["https://aurora.example/evidence"]), "both valid carriers constrain the request"),
      "G6 [chat/completions]": "FAIL",
    },
    "Basalt fails when the suffix adds ignore=basalt to ignore=aurora": {
      "G11 [chat/completions]": failure(inference(model + "+ignore=basalt", [["Route-Policy","ignore=aurora"]]), received(200, JSON.stringify({"text":"served by basalt.example"}), ["provider=basalt"]), "both valid carriers constrain the request"),
      "G6 [chat/completions]": "FAIL",
    },
    "header only=aurora and suffix only=basalt fail if the gateway relays": {
      "G12 [chat/completions]": failure(inference(model + "+only=basalt", [["Route-Policy","only=aurora"]]), received(200, JSON.stringify({"text":"served by aurora.example"}), ["provider=aurora"]), "400 unsatisfiable for an empty intersection in either carrier order"),
      "G3 [chat/completions]": "FAIL", "G6 [chat/completions]": "FAIL",
    },
    "header only=basalt fails when it overrides the bound zdr": {
      "G13 [chat/completions]": failure(inference(model, [["Route-Policy","only=basalt"]]), received(200, JSON.stringify({"text":"served by basalt.example"}), ["provider=basalt"]), "neither explicit carrier can weaken the detected key default"),
      "G3 [chat/completions]": "FAIL", "G6 [chat/completions]": "FAIL", "G10 [chat/completions]": "FAIL",
    },
    "suffix only=basalt fails when it overrides the bound zdr": {
      "G13 [chat/completions]": failure(inference(model + "+only=basalt"), received(200, JSON.stringify({"text":"served by basalt.example"}), ["provider=basalt"]), "neither explicit carrier can weaken the detected key default"),
      "G3 [chat/completions]": "FAIL", "G6 [chat/completions]": "FAIL", "G10 [chat/completions]": "FAIL",
    },
    "header bits=8 fails if it drops the bound bits=16 floor": {
      "G13 [chat/completions]": failure(inference(model, [["Route-Policy","bits=8"]]), received(200, JSON.stringify({"output":"served"}), ["provider=aurora"]), "neither explicit carrier can weaken the detected key default"),
      "G6 [chat/completions]": "FAIL", "G10 [chat/completions]": "FAIL",
    },
    "the zdr relay fails when Route-Applied names unpublished": {
      "G15 [chat/completions]": failure(inference(model, [["Route-Policy","zdr"]]), received(200, JSON.stringify({"text":"served by aurora.example"}), ["provider=unpublished"]), "one valid Route-Applied naming a published provider for this model"),
      "G6 [chat/completions]": "FAIL", "G9 [chat/completions]": "FAIL", "G25 [chat/completions]": "SKIP",
    },
    "attest=weights fails when the applied provider supplies no evidence": {
      "G17 [chat/completions]": failure(inference(model, [["Route-Policy","attest=weights"]]), received(200, JSON.stringify({"text":"served by basalt.example"}), ["provider=basalt"]), "one Route-Evidence is required by the known attest requirement"),
    },
    "only=basalt fails when it returns Basalt’s attestation URI without attest": {
      "G17 [chat/completions]": failure(inference(model, [["Route-Policy","only=basalt"]]), received(200, JSON.stringify({"text":"served by basalt.example"}), ["provider=basalt"], [], ["https://basalt.example/attestation"]), "no Route-Evidence when the combined policy does not require attest"),
      "G3 [chat/completions]": "FAIL", "G13 [chat/completions]": "FAIL", "G19 [chat/completions]": "FAIL",
    },
    "bits=64 unsatisfiable with provider=aurora fails the result check": {
      "G19 [chat/completions]": failure(inference(model, [["Route-Policy","bits=64"]]), received(400, error("Route policy unsatisfiable", "invalid_request_error", true), ["provider=aurora"], ["reason=unsatisfiable"]), "a refusal has neither Route-Applied nor Route-Evidence"),
      "G3 [chat/completions]": "FAIL", "G9 [chat/completions]": "FAIL", "G21 [chat/completions]": "FAIL",
    },
    "bits=64 unsatisfiable with a Route-Evidence URI fails the result check": {
      "G19 [chat/completions]": failure(inference(model, [["Route-Policy","bits=64"]]), received(400, error("Route policy unsatisfiable", "invalid_request_error", true), [], ["reason=unsatisfiable"], ["https://aurora.example/evidence"]), "a refusal has neither Route-Applied nor Route-Evidence"),
      "G3 [chat/completions]": "FAIL", "G9 [chat/completions]": "FAIL", "G21 [chat/completions]": "FAIL",
    },
    "anonymous detection HTTP 401 fails": {
      "G20": failure(get("/route-policy", null), received(401, JSON.stringify({"route_policy":"1"})), "a complete valid detection reply: status is 401, not 200"),
    },
    "credentialed detection HTTP 201 fails": {
      "G20": failure(get("/route-policy"), received(201, JSON.stringify({"route_policy":"1"})), "a complete valid detection reply: status is 201, not 200"),
      "G3 [chat/completions]": "SKIP", "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP",
      "G8 [chat/completions]": "SKIP", "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP",
      "G11 [chat/completions]": "SKIP", "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP",
      "G15 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
    },
    "an array as the detection body fails": {
      "G20": failure(get("/route-policy", null), received(200, JSON.stringify([])), "a complete valid detection reply: not a JSON object"),
      "G22": "SKIP",
    },
    "detection keys containing Not-A-Key fails": {
      "G20": failure(get("/route-policy", null), received(200, JSON.stringify({"route_policy":"1","keys":["Not-A-Key"]})), "a complete valid detection reply: is not a list of keys"),
    },
    "detection attest containing a,b as one item fails": {
      "G20": failure(get("/route-policy", null), received(200, JSON.stringify({"route_policy":"1","attest":["a,b"]})), "a complete valid detection reply: is not a list of items"),
    },
    "detection sort set to the string price fails": {
      "G20": failure(get("/route-policy", null), received(200, JSON.stringify({"route_policy":"1","sort":"price"})), "a complete valid detection reply: is not a list of items"),
    },
    "a relay instead of unsupported for probe0 fails": {
      "G21 [chat/completions]": failure(inference(model, [["Route-Policy","probe0"]]), received(200, JSON.stringify({"text":"served by aurora.example"}), ["provider=aurora"]), "unlisted key probe0 is unsupported"),
      "G1 [chat/completions]": "FAIL",
    },
    "accepting attest=probe0 as attest=weights fails": {
      "G21 [chat/completions]": failure(inference(model, [["Route-Policy","attest=probe0"]]), received(200, JSON.stringify({"text":"served by basalt.example"}), ["provider=basalt"], [], ["https://basalt.example/attestation"]), "unlisted attest refuses attest=probe0"),
      "G1 [chat/completions]": "FAIL",
    },
    "unsupported for advertised bits=32 fails": {
      "G21 [chat/completions]": failure(inference(model, [["Route-Policy","bits=32"]]), received(400, error("fixture refusal", "invalid_request_error"), [], ["reason=unsupported+key=bits"]), "advertised support accepts every key and value sent; unsupported is not justified"),
      "G2 [chat/completions]": "FAIL", "G3 [chat/completions]": "FAIL",
    },
    "unsupported for advertised region=jp,de fails": {
      "G21 [chat/completions]": failure(inference(model, [["Route-Policy","region=jp,de"]]), received(400, error("fixture refusal", "invalid_request_error"), [], ["reason=unsupported+key=region"]), "advertised support accepts every key and value sent; unsupported is not justified"),
      "G2 [chat/completions]": "FAIL", "G3 [chat/completions]": "FAIL",
    },
    "unsupported for advertised only=0,a-b_c.d fails": {
      "G21 [chat/completions]": failure(inference(model, [["Route-Policy","only=0,a-b_c.d"]]), received(400, error("fixture refusal", "invalid_request_error"), [], ["reason=unsupported+key=only"]), "advertised support accepts every key and value sent; unsupported is not justified"),
      "G2 [chat/completions]": "FAIL", "G3 [chat/completions]": "FAIL", "G24 [chat/completions]": "FAIL",
    },
    "unsupported for advertised ignore=0,a-b_c.d fails": {
      "G21 [chat/completions]": failure(inference(model, [["Route-Policy","ignore=0,a-b_c.d"]]), received(400, error("fixture refusal", "invalid_request_error"), [], ["reason=unsupported+key=ignore"]), "advertised support accepts every key and value sent; unsupported is not justified"),
      "G2 [chat/completions]": "FAIL", "G24 [chat/completions]": "FAIL",
    },
    "unsupported for advertised order=0,a-b_c.d fails": {
      "G21 [chat/completions]": failure(inference(model, [["Route-Policy","order=0,a-b_c.d"]]), received(400, error("fixture refusal", "invalid_request_error"), [], ["reason=unsupported+key=order"]), "advertised support accepts every key and value sent; unsupported is not justified"),
      "G2 [chat/completions]": "FAIL", "G24 [chat/completions]": "FAIL",
    },
    "the numeric key_policy 1 fails": {
      "G22": failure(get("/route-policy"), received(200, JSON.stringify({"route_policy":"1","key_policy":1})), "key_policy is a string"),
      "G20": "FAIL", "G3 [chat/completions]": "SKIP", "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP",
      "G8 [chat/completions]": "SKIP", "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP",
      "G11 [chat/completions]": "SKIP", "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP",
      "G15 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
    },
    "key_policy=zdr+zdr fails": {
      "G22": failure(get("/route-policy"), received(200, JSON.stringify({"route_policy":"1","key_policy":"zdr+zdr"})), "key_policy fits the policy grammar: repeated key"),
      "G20": "FAIL", "G3 [chat/completions]": "SKIP", "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP",
      "G8 [chat/completions]": "SKIP", "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP",
      "G11 [chat/completions]": "SKIP", "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP",
      "G15 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
    },
    "key_policy=notrain fails with only zdr advertised": {
      "G22": failure(get("/route-policy"), received(200, JSON.stringify({"route_policy":"1","keys":["zdr"],"key_policy":"notrain"})), "key_policy valid under the advertised lists: fails the order of checks under the reply's lists: key not listed"),
      "G20": "FAIL", "G3 [chat/completions]": "SKIP", "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP",
      "G8 [chat/completions]": "SKIP", "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP",
      "G11 [chat/completions]": "SKIP", "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP",
      "G15 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
    },
    "a /models top-level array fails": {
      "G23": failure(get("/models"), received(200, JSON.stringify([])), "models response must be an object with a data array"),
      "G1 [chat/completions]": "SKIP", "G2 [chat/completions]": "SKIP", "G3 [chat/completions]": "SKIP",
      "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G8 [chat/completions]": "SKIP",
      "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP",
      "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP",
      "G17 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
      "G19 [chat/completions]": "SKIP",
    },
    "a /models data object fails": {
      "G23": failure(get("/models"), received(200, JSON.stringify({"data":{"id":"other/example-model.v2","routes":[{"provider":"aurora","facts":"zdr+notrain+bits=8+region=us"},{"provider":"basalt","facts":"bits=16+region=us,de+attest=weights,prompt","evidence":"https://basalt.example/attestation"},{"provider":"cobalt","facts":""}]}})), "models response must be an object with a data array"),
      "G1 [chat/completions]": "SKIP", "G2 [chat/completions]": "SKIP", "G3 [chat/completions]": "SKIP",
      "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G8 [chat/completions]": "SKIP",
      "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP",
      "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP",
      "G17 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
      "G19 [chat/completions]": "SKIP",
    },
    "a null catalog entry fails": {
      "G23": failure(get("/models"), received(200, JSON.stringify({"data":[null]})), "invalid or repeated model entry: null"),
      "G1 [chat/completions]": "SKIP", "G2 [chat/completions]": "SKIP", "G3 [chat/completions]": "SKIP",
      "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G8 [chat/completions]": "SKIP",
      "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP",
      "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP",
      "G17 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
      "G19 [chat/completions]": "SKIP",
    },
    "duplicate other/example-model.v2 entries fail": {
      "G23": failure(get("/models"), received(200, JSON.stringify({"data":[{"id":"other/example-model.v2","routes":[]},{"id":"other/example-model.v2","routes":[]}]})), "invalid or repeated model entry: {\"id\":\"other/example-model.v2\",\"routes\":[]}"),
      "G1 [chat/completions]": "SKIP", "G2 [chat/completions]": "SKIP", "G3 [chat/completions]": "SKIP",
      "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G8 [chat/completions]": "SKIP",
      "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP",
      "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP",
      "G17 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
      "G19 [chat/completions]": "SKIP",
    },
    "other/example-model.v2 without routes fails": {
      "G23": failure(get("/models"), received(200, JSON.stringify({"data":[{"id":"other/example-model.v2"}]})), "invalid or repeated model entry: {\"id\":\"other/example-model.v2\"}"),
      "G1 [chat/completions]": "SKIP", "G2 [chat/completions]": "SKIP", "G3 [chat/completions]": "SKIP",
      "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G8 [chat/completions]": "SKIP",
      "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP",
      "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP",
      "G17 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
      "G19 [chat/completions]": "SKIP",
    },
    "provider Aurora with uppercase A fails the catalog check": {
      "G23": failure(get("/models"), received(200, JSON.stringify({"data":[{"id":"other/example-model.v2","routes":[{"provider":"Aurora","facts":""}]}]})), "invalid or repeated provider on other/example-model.v2: {\"provider\":\"Aurora\",\"facts\":\"\"}"),
      "G1 [chat/completions]": "SKIP", "G2 [chat/completions]": "SKIP", "G3 [chat/completions]": "SKIP",
      "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G8 [chat/completions]": "SKIP",
      "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP",
      "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP",
      "G17 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
      "G19 [chat/completions]": "SKIP",
    },
    "Aurora without facts fails the catalog check": {
      "G23": failure(get("/models"), received(200, JSON.stringify({"data":[{"id":"other/example-model.v2","routes":[{"provider":"aurora"}]}]})), "facts must be a string for other/example-model.v2/aurora"),
      "G1 [chat/completions]": "SKIP", "G2 [chat/completions]": "SKIP", "G3 [chat/completions]": "SKIP",
      "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G8 [chat/completions]": "SKIP",
      "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP",
      "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP",
      "G17 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
      "G19 [chat/completions]": "SKIP",
    },
    "Aurora facts zdr+zdr fail the catalog check": {
      "G23": failure(get("/models"), received(200, JSON.stringify({"data":[{"id":"other/example-model.v2","routes":[{"provider":"aurora","facts":"zdr+zdr"}]}]})), "invalid facts for other/example-model.v2/aurora: repeated key"),
      "G1 [chat/completions]": "SKIP", "G2 [chat/completions]": "SKIP", "G3 [chat/completions]": "SKIP",
      "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G8 [chat/completions]": "SKIP",
      "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP",
      "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP",
      "G17 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
      "G19 [chat/completions]": "SKIP",
    },
    "Basalt facts attest=weights without evidence fail the catalog check": {
      "G23": failure(get("/models"), received(200, JSON.stringify({"data":[{"id":"other/example-model.v2","routes":[{"provider":"basalt","facts":"attest=weights"}]}]})), "invalid or missing evidence URI for other/example-model.v2/basalt"),
      "G1 [chat/completions]": "SKIP", "G2 [chat/completions]": "SKIP", "G3 [chat/completions]": "SKIP",
      "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G8 [chat/completions]": "SKIP",
      "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP",
      "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP",
      "G17 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
      "G19 [chat/completions]": "SKIP",
    },
    "Basalt evidence beginning with http:// fails the catalog check": {
      "G23": failure(get("/models"), received(200, JSON.stringify({"data":[{"id":"other/example-model.v2","routes":[{"provider":"basalt","facts":"attest=weights","evidence":"http://basalt.example/"}]}]})), "invalid or missing evidence URI for other/example-model.v2/basalt"),
      "G1 [chat/completions]": "SKIP", "G2 [chat/completions]": "SKIP", "G3 [chat/completions]": "SKIP",
      "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G8 [chat/completions]": "SKIP",
      "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP",
      "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP",
      "G17 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
      "G19 [chat/completions]": "SKIP",
    },
    "only=routeprobe0 fails if the gateway relays as zdr": {
      "G24 [chat/completions]": failure(inference(model, [["Route-Policy","only=routeprobe0"]]), received(200, JSON.stringify({"text":"served by aurora.example"}), ["provider=aurora"]), "an unknown provider id does not make an excluded route qualify"),
      "G3 [chat/completions]": "FAIL", "G6 [chat/completions]": "FAIL",
    },
    "only=routeprobe0,aurora fails if the gateway drops aurora": {
      "G24 [chat/completions]": failure(inference(model, [["Route-Policy","only=routeprobe0,aurora"]]), received(400, error("Route policy unsatisfiable", "invalid_request_error", true), [], ["reason=unsatisfiable"]), "an unknown provider id does not remove the remaining matching routes"),
      "G3 [chat/completions]": "FAIL",
    },
    "ignore=routeprobe0 fails if the gateway answers unsatisfiable": {
      "G24 [chat/completions]": failure(inference(model, [["Route-Policy","ignore=routeprobe0"]]), received(400, error("Route policy unsatisfiable", "invalid_request_error", true), [], ["reason=unsatisfiable"]), "an unknown provider id does not remove the remaining matching routes"),
      "G3 [chat/completions]": "FAIL",
    },
    "ignore=routeprobe0,aurora fails if the gateway relays Aurora": {
      "G24 [chat/completions]": failure(inference(model, [["Route-Policy","ignore=routeprobe0,aurora"]]), received(200, JSON.stringify({"text":"served by aurora.example"}), ["provider=aurora"]), "an unknown provider beside a known provider does not change ignore"),
      "G6 [chat/completions]": "FAIL",
    },
    "order=routeprobe0,aurora fails when the gateway reports unsupported": {
      "G24 [chat/completions]": failure(inference(model, [["Route-Policy","order=routeprobe0,aurora"]]), received(400, error("fixture refusal", "invalid_request_error"), [], ["reason=unsupported+key=order"]), "a syntactically valid unknown provider id is not an unsupported value"),
      "G2 [chat/completions]": "FAIL", "G21 [chat/completions]": "FAIL",
    },
    "model=4 with header bits=0 fails if it returns unsupported instead of the model error": {
      "G25 [chat/completions]": failure(post("{\"model\":4}", [["Route-Policy","bits=0"]]), received(400, error("fixture refusal", "invalid_request_error"), [], ["reason=unsupported+key=bits"]), "the same ordinary error status 400 as the no-policy control, with no result headers"),
    },
    "malformed JSON with repeated Route-Policy lines fails if route-applied is present": {
      "G25 [chat/completions]": failure(post("{", [["Route-Policy","bits=0"],["rOuTe-PoLiCy","bits=0"]]), received(400, error("Expected a JSON body", "invalid_request_error", true), ["provider=aurora"]), "the same ordinary error status 400 as the no-policy control, with no result headers"),
      "G1 [chat/completions]": "FAIL",
    },
    "malformed JSON with repeated Route-Policy lines fails if route-refused is present": {
      "G25 [chat/completions]": failure(post("{", [["Route-Policy","bits=0"],["rOuTe-PoLiCy","bits=0"]]), received(400, error("Expected a JSON body", "invalid_request_error", true), [], ["reason=unsupported+key=bits"]), "the same ordinary error status 400 as the no-policy control, with no result headers"),
      "G2 [chat/completions]": "FAIL",
    },
    "malformed JSON with repeated Route-Policy lines fails if route-evidence is present": {
      "G25 [chat/completions]": failure(post("{", [["Route-Policy","bits=0"],["rOuTe-PoLiCy","bits=0"]]), received(400, error("Expected a JSON body", "invalid_request_error", true), [], [], ["https://aurora.example/evidence"]), "the same ordinary error status 400 as the no-policy control, with no result headers"),
      "G1 [chat/completions]": "FAIL", "G15 [chat/completions]": "FAIL",
    },
    "an ordinary credential with no explicit policy fails if it gets unavailable": {
      "G26 [chat/completions]": failure(inference(model), received(503, error("fixture refusal", "invalid_request_error"), [], ["reason=unavailable"]), "no Route-Refused or Route-Evidence without a policy"),
    },
    "bits=64 fails the precedence check when it returns unavailable": {
      "G29 [chat/completions]": failure(inference(model, [["Route-Policy","bits=64"]]), received(503, error("fixture refusal", "invalid_request_error"), [], ["reason=unavailable"]), "unsatisfiable takes precedence over unavailable"),
      "G3 [chat/completions]": "FAIL", "G9 [chat/completions]": "FAIL",
    },
    "header zdr with suffix bits=0 fails the precedence check when it returns unavailable": {
      "G29 [chat/completions]": failure(inference(model + "+bits=0", [["Route-Policy","zdr"]]), received(503, error("fixture refusal", "invalid_request_error"), [], ["reason=unavailable"]), "unsupported takes precedence over unavailable"),
      "G1 [chat/completions]": "FAIL", "G11 [chat/completions]": "FAIL",
    },
  } satisfies Readonly<Record<string, Overrides>>,
  duplicate: {
    "route-applied": {
      "G19 [chat/completions]": failure(inference(model, [["Route-Policy","zdr"]]), received(200, JSON.stringify({"text":"served by aurora.example"}), ["provider=aurora","provider=aurora"]), "at most one field line of each result header"),
      "G6 [chat/completions]": "FAIL", "G7 [chat/completions]": "FAIL", "G8 [chat/completions]": "FAIL",
      "G9 [chat/completions]": "FAIL", "G10 [chat/completions]": "FAIL", "G11 [chat/completions]": "FAIL",
      "G13 [chat/completions]": "FAIL", "G15 [chat/completions]": "FAIL", "G17 [chat/completions]": "SKIP",
      "G21 [chat/completions]": "FAIL", "G24 [chat/completions]": "FAIL",
    },
    "route-refused": {
      "G19 [chat/completions]": failure(inference(model, [["Route-Policy",""]]), received(400, error("Route policy unsupported", "invalid_request_error", true), [], ["reason=unsupported","reason=unsupported"]), "at most one field line of each result header"),
      "G1 [chat/completions]": "FAIL", "G2 [chat/completions]": "FAIL", "G3 [chat/completions]": "FAIL",
      "G8 [chat/completions]": "FAIL", "G9 [chat/completions]": "FAIL", "G11 [chat/completions]": "FAIL",
      "G12 [chat/completions]": "FAIL", "G13 [chat/completions]": "FAIL", "G21 [chat/completions]": "FAIL",
      "G24 [chat/completions]": "FAIL", "G29 [chat/completions]": "FAIL",
    },
    "route-evidence": {
      "G19 [chat/completions]": failure(inference(model, [["Route-Policy","attest=weights"]]), received(200, JSON.stringify({"text":"served by basalt.example"}), ["provider=basalt"], [], ["https://basalt.example/attestation","https://basalt.example/attestation"]), "at most one field line of each result header"),
      "G17 [chat/completions]": "FAIL",
    },
  } satisfies Readonly<Record<string, Overrides>>,
  boundThrottle: {
    "bare": {
      "G25 [chat/completions]": ["PASS","corroborated ordinary errors retained their status and no route headers when challenged with a policy; observed 9 × HTTP 400, 6 × HTTP 404, 4 × HTTP 401, 2 × HTTP 200, 3 × HTTP 429"],
      "G10 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP",
    },
    "refused": {
      "G25 [chat/completions]": failure(inference(model, [["Route-Policy","bits=0"]]), received(400, error("fixture refusal", "invalid_request_error"), [], ["reason=unsupported+key=bits"]), "ordinary HTTP 429 with no route headers while both bound-key controls are throttled"),
      "G10 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP",
    },
  } satisfies Readonly<Record<string, Overrides>>,
  boundDiscovery: {
    "key_policy=17 fails even when keys is the string zdr": {
      "G22": failure(get("/route-policy"), received(200, JSON.stringify({"route_policy":"1","keys":"zdr","key_policy":17})), "key_policy is a string"),
      "G20": "FAIL", "G3 [chat/completions]": "SKIP", "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP",
      "G8 [chat/completions]": "SKIP", "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP",
      "G11 [chat/completions]": "SKIP", "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP",
      "G15 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
    },
    "key_policy=null fails even when sort is null": {
      "G22": failure(get("/route-policy"), received(200, JSON.stringify({"route_policy":"1","sort":null,"key_policy":null})), "key_policy is a string"),
      "G20": "FAIL", "G3 [chat/completions]": "SKIP", "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP",
      "G8 [chat/completions]": "SKIP", "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP",
      "G11 [chat/completions]": "SKIP", "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP",
      "G15 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
    },
    "key_policy=zdr++notrain fails even when attest contains bad value": {
      "G22": failure(get("/route-policy"), received(200, JSON.stringify({"route_policy":"1","attest":["bad value"],"key_policy":"zdr++notrain"})), "key_policy fits the policy grammar: malformed key in \"\""),
      "G20": "FAIL", "G3 [chat/completions]": "SKIP", "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP",
      "G8 [chat/completions]": "SKIP", "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP",
      "G11 [chat/completions]": "SKIP", "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP",
      "G15 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
    },
    "key_policy=later=valid skips when keys is the string zdr": {
      "G22": skip("valid advertised lists to check key_policy: keys is not a list of keys"),
      "G20": "FAIL", "G3 [chat/completions]": "SKIP", "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP",
      "G8 [chat/completions]": "SKIP", "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP",
      "G11 [chat/completions]": "SKIP", "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP",
      "G15 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
    },
    "key_policy=later=valid passes when keys advertises later": {
      "G22": ["PASS","the anonymous reply omitted key_policy; every observed credentialed key_policy was valid under its own lists; observed 3 × HTTP 200"],
      "G1 [chat/completions]": "FAIL", "G2 [chat/completions]": "FAIL", "G3 [chat/completions]": "SKIP",
      "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G8 [chat/completions]": "SKIP",
      "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP",
      "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP",
      "G17 [chat/completions]": "SKIP", "G21 [chat/completions]": "FAIL", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
    },
  } satisfies Readonly<Record<string, Overrides>>,
  carrierFlags: {
    "none": {
      "G11 [chat/completions]": ["PASS","malformed carriers attributed the first failure to the header; valid pairs matched both omission witnesses; observed 2 × HTTP 400 reason=unsupported+key=bits, 1 × HTTP 400 reason=unsupported+key=only, 2 × HTTP 400 reason=unsatisfiable, 1 × HTTP 200 provider=aurora"],
      "G7 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP", "G12 [chat/completions]": "SKIP",
      "G13 [chat/completions]": "SKIP", "G17 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP",
    },
    "header": {
      "G11 [chat/completions]": failure(inference(model + "+zdr", [["Route-Policy","notrain"]]), received(200, JSON.stringify({"output":"served"}), ["provider=aurora"]), "both valid carriers constrain the request"),
      "G3 [chat/completions]": "FAIL", "G6 [chat/completions]": "FAIL", "G7 [chat/completions]": "SKIP",
      "G10 [chat/completions]": "SKIP", "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP",
      "G17 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP", "G25 [chat/completions]": "SKIP",
    },
    "suffix": {
      "G11 [chat/completions]": failure(inference(model + "+notrain", [["Route-Policy","zdr"]]), received(200, JSON.stringify({"output":"served"}), ["provider=aurora"]), "both valid carriers constrain the request"),
      "G3 [chat/completions]": "FAIL", "G6 [chat/completions]": "FAIL", "G7 [chat/completions]": "SKIP",
      "G10 [chat/completions]": "SKIP", "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP",
      "G17 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP", "G25 [chat/completions]": "SKIP",
    },
  } satisfies Readonly<Record<string, Overrides>>,
  carrierFloor: {
    "0": {
      "G11 [chat/completions]": ["PASS","malformed carriers attributed the first failure to the header; valid pairs matched both omission witnesses; observed 2 × HTTP 400 reason=unsupported+key=bits, 1 × HTTP 400 reason=unsupported+key=only, 3 × HTTP 200 provider=basalt, 2 × HTTP 200 provider=aurora"],
      "G3 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP",
      "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G17 [chat/completions]": "SKIP",
      "G24 [chat/completions]": "SKIP", "G25 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
    },
    "1": {
      "G11 [chat/completions]": skip("a combined-policy witness distinguishing omission of the header and suffix"),
      "G3 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP",
      "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP", "G17 [chat/completions]": "SKIP",
      "G24 [chat/completions]": "SKIP", "G25 [chat/completions]": "SKIP", "G29 [chat/completions]": "SKIP",
    },
  } satisfies Readonly<Record<string, Overrides>>,
  carrierPairs: {
    "bits=64": {
      "G11 [chat/completions]": ["PASS","malformed carriers attributed the first failure to the header; valid pairs matched both omission witnesses; observed 2 × HTTP 400 reason=unsupported+key=bits, 1 × HTTP 400 reason=unsupported+key=only, 2 × HTTP 400 reason=unsatisfiable, 1 × HTTP 200 provider=aurora"],
      "G7 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP", "G12 [chat/completions]": "SKIP",
      "G13 [chat/completions]": "SKIP", "G17 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP",
    },
    "bits=1": {
      "G11 [chat/completions]": ["PASS","malformed carriers attributed the first failure to the header; valid pairs matched both omission witnesses; observed 2 × HTTP 400 reason=unsupported+key=bits, 1 × HTTP 400 reason=unsupported+key=only, 2 × HTTP 400 reason=unsatisfiable, 1 × HTTP 200 provider=aurora"],
      "G10 [chat/completions]": "SKIP", "G12 [chat/completions]": "SKIP", "G13 [chat/completions]": "SKIP",
      "G17 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP", "G25 [chat/completions]": "SKIP",
    },
  } satisfies Readonly<Record<string, Overrides>>,
  opaqueBound: {
    "refused": {
      "G3 [chat/completions]": ["PASS","probes with no match even under the known requirements returned unsatisfiable without a key; observed 1 × HTTP 400 reason=unsatisfiable"],
      "G6 [chat/completions]": skip("an interpretable ordinary key default and a satisfiable advertised policy"),
      "G7 [chat/completions]": "SKIP", "G8 [chat/completions]": "SKIP", "G9 [chat/completions]": "SKIP",
      "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP", "G12 [chat/completions]": "SKIP",
      "G13 [chat/completions]": "SKIP", "G17 [chat/completions]": "SKIP", "G24 [chat/completions]": "SKIP",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP",
    },
    "relay": {
      "G3 [chat/completions]": failure(inference(model, [["Route-Policy","only=0,a-b_c.d"]]), received(200, JSON.stringify({"output":"served"}), ["provider=local"]), "the policy must be refused as unsatisfiable"),
      "G6 [chat/completions]": failure(inference(model, [["Route-Policy","only=0,a-b_c.d"]]), received(200, JSON.stringify({"output":"served"}), ["provider=local"]), "the named published route must meet at least the known requirements; an unknown key default cannot admit an excluded route"),
      "G7 [chat/completions]": "SKIP", "G8 [chat/completions]": "SKIP", "G9 [chat/completions]": "SKIP",
      "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP", "G12 [chat/completions]": "SKIP",
      "G13 [chat/completions]": "SKIP", "G17 [chat/completions]": "SKIP", "G24 [chat/completions]": "FAIL",
      "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP",
    },
  } satisfies Readonly<Record<string, Overrides>>,
  undetected: {
    "unsupported": {
      "G20": failure(get("/route-policy", null), received(404, "", [], [], [], null), "a complete valid detection reply: status is 404, not 200"),
      "G3 [chat/completions]": skip("an accepted policy no published route meets, even before unknown key requirements"),
      "G12 [chat/completions]": skip("a valid detection reply to establish acceptance of the intersection policies"),
      "G29 [chat/completions]": skip("a supported policy no published route meets, even before unknown key requirements"),
      "G22": "SKIP", "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G8 [chat/completions]": "SKIP",
      "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP",
      "G13 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP",
      "G24 [chat/completions]": "SKIP", "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP",
    },
    "unavailable": {
      "G20": failure(get("/route-policy", null), received(404, "", [], [], [], null), "a complete valid detection reply: status is 404, not 200"),
      "G3 [chat/completions]": failure(inference(model + "+only=basalt", [["Route-Policy","only=aurora"]]), received(503, error("fixture refusal", "invalid_request_error"), [], ["reason=unavailable"]), "unavailable presupposes a qualifying route, but none meets even the known requirements"),
      "G12 [chat/completions]": skip("a valid detection reply to establish acceptance of the intersection policies"),
      "G29 [chat/completions]": failure(inference(model + "+only=basalt", [["Route-Policy","only=aurora"]]), received(503, error("fixture refusal", "invalid_request_error"), [], ["reason=unavailable"]), "unavailable must not mask a refusal before routing"),
      "G22": "SKIP", "G6 [chat/completions]": "SKIP", "G7 [chat/completions]": "SKIP", "G8 [chat/completions]": "SKIP",
      "G9 [chat/completions]": "SKIP", "G10 [chat/completions]": "SKIP", "G11 [chat/completions]": "SKIP",
      "G13 [chat/completions]": "SKIP", "G15 [chat/completions]": "SKIP", "G21 [chat/completions]": "SKIP",
      "G24 [chat/completions]": "SKIP", "G25 [chat/completions]": "SKIP", "G26 [chat/completions]": "SKIP",
    },
  } satisfies Readonly<Record<string, Overrides>>,
};
