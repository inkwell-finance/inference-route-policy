# Grading rubric

How this repository is graded. The grader is independent of the authors:
it reads the repository as it is on disk, runs it, and scores it against
this file. It does not read the authors' reports and does not take a
claim on trust. A score is only as good as the evidence cited for it.

## Procedure

1. Read `SPEC.md` and `REQUIREMENTS.md` first. They define correct.
2. From a clean state, run the commands in `README.md` under "Verify".
   Record each command and its result. If a command fails or hangs, the
   affected criteria are scored from what could be observed, and gate
   X3 fails.
3. For every criterion, look for the rule being broken before looking
   for it being kept. Write your own probes: start the reference
   gateway, send it requests the tests do not send, load the plugins'
   modules and call them with inputs the tests do not use.
4. Every deduction cites a file and line, or a command and its output,
   and names the requirement id it concerns when there is one.
5. Do not edit any file in the repository. Scratch files go outside it.
6. When unsure whether something is a defect, it is: score the lower
   anchor and say what evidence would raise it.

## Gates

A gate that fails caps the total at 60, whatever the criteria add up
to. Each is pass or fail, with evidence.

| Id | Gate |
| -- | ---- |
| X1 | **The gateway never fails open.** No probe makes the reference gateway send content to a route that does not meet the combined policy, or to any route for an `unsupported` or `unsatisfiable` request (G4, G5, G6, G13). |
| X2 | **The plugins never fail open.** No probe makes either plugin let a request carrying content leave when its policy has a requirement and there is neither a valid detection reply nor a hard-filter translation (C1, C9). The blocking mechanism is shown to work in the real harness, not only against a stand-in for its API. |
| X3 | **It verifies as documented.** Every command under "Verify" in `README.md` exits zero on this machine, from a clean state, without edits. |
| X4 | **Nothing is faked.** No stub, placeholder, `TODO`, skipped test, or test that passes without exercising what its name says. No shipped code path that pretends to do something it does not. |

## Criteria

Each criterion is scored at one of five anchors and multiplied by its
weight. There are no scores between anchors.

| Anchor | Meaning |
| ------ | ------- |
| 100% | Every listed requirement holds under the grader's own probes. No defect found. |
| 75%  | Only minor defects: none breaks a MUST, none loses or misroutes content, each is a one-place fix. |
| 50%  | One MUST broken, or a listed requirement with no working implementation, or several minor defects that together make the part unreliable. |
| 25%  | Several MUSTs broken, or the part works only on the paths its own tests take. |
| 0%   | Absent, does not run, or does not do what it claims. |

| Id | Weight | Criterion | What is checked |
| -- | ------ | --------- | --------------- |
| A | 15 | **Core library** | S1 to S14 and the Combining and Facts rules, as pure functions with no runtime dependency. Parser accepts everything the grammar allows and refuses everything it does not, including boundary lengths. Round trip: formatting a parsed policy and parsing it again gives the same policy. Refusals name the right key. |
| B | 20 | **Reference gateway** | G1 to G26 on all three inference endpoints (`/chat/completions`, `/responses`, `/messages`), streaming and not. Fallback only among qualifying routes and only before the first body byte. Suffix and header are stripped. Provider-supplied `Route-*` headers are dropped. |
| C | 15 | **Conformance suite** | Runs against any base URL with no knowledge of the gateway's internals. Every requirement marked BB has at least one check that names its id. Each check fails against a gateway that breaks that requirement: the repository includes deliberately broken gateway variants and shows the suite catching each one. Output says which requirement failed and why. |
| D | 15 | **omp plugin** | C1 to C10 in omp. The user can set, see, and clear a policy; detection runs before a requirement is sent; the result of each request (`Route-Applied`, `Route-Refused`, or neither) is shown. A failure inside the plugin never takes the session down and never turns into sending without the policy. |
| E | 10 | **pi plugin** | The same, in pi, using pi's own extension API. |
| F | 5 | **Dialect translation** | For each supported target dialect: every mapping cites the target's documentation and is a hard filter there; anything else is refused (C9); the result is shown as unconfirmed (C8). The translated request body is exactly what the target documents. |
| G | 10 | **Specification** | `SPEC.md` is internally consistent, unambiguous enough that two implementers would agree on every case in `REQUIREMENTS.md`, and contains no gateway-specific or vendor-specific term in normative text. `REQUIREMENTS.md` covers every MUST and MUST NOT in the spec and nothing the spec does not say. The implementation and the spec agree; where they differ, both lose. |
| H | 5 | **Code quality** | Small, direct, and readable. No dead code, no duplicated logic across packages that the core should own, no needless abstraction, strict types with no `any` or unchecked cast at a trust boundary. Errors are handled where they occur. |
| I | 5 | **Evidence** | The repository shows the system working end to end in the real harnesses: a recorded or scripted run of omp, and of pi, against the reference gateway, covering one honored request, one refused request, and one blocked request. A reader can reproduce it from `README.md`. |

Total: 100. Passing is above 80 with every gate passing.

## Report format

The grader's report is exactly this, and nothing before it:

```
GATES
X1 pass|fail  <evidence>
X2 pass|fail  <evidence>
X3 pass|fail  <evidence>
X4 pass|fail  <evidence>

SCORES
A  <anchor>%  <points>/15
B  <anchor>%  <points>/20
C  <anchor>%  <points>/15
D  <anchor>%  <points>/15
E  <anchor>%  <points>/10
F  <anchor>%  <points>/5
G  <anchor>%  <points>/10
H  <anchor>%  <points>/5
I  <anchor>%  <points>/5
SUM    <points>/100
TOTAL  <points after the gate cap>/100

FINDINGS
<one per defect, most severe first>
[severity: critical|major|minor] [criterion] [requirement id or -]
  where: <file:line, or command>
  what: <what is wrong, with the observed output>
  fix: <what would have to be true for this to pass>

COMMANDS RUN
<each command and its exit status>
```
