# Codex CLI battle workflow

The maintained battle author uses the official Codex CLI with its opaque ChatGPT
login. The selected live profile is **GPT-6.1 Sol / low reasoning / Fast / retained
session context**. Install and sign in using the [official CLI instructions](https://developers.openai.com/codex/cli).
The launcher discovers an existing native executable on PATH;
`--codex-executable ABSOLUTE_PATH` selects another existing installation.
It never installs a CLI or changes a login.

The model receives complete current guidance, fresh facts and legal menus. It
chooses actual MCP research, authors its arguments, reads results, and returns
only `actions`, `planUpdate` and `reason`. The runner relays that work and enforces
identity, ownership, native legality and original deadlines. The manager reviews
completed sets and maintains guidance and tooling.

## Prepare and qualify

```powershell
npm ci
npm run build
node isolated/launch.mjs --qualify-only --model-tool-qualification cache/manager/saved-requests.json --output cache/manager/qualification-run
```

The manager prepares a private complete saved-request bundle for the exact team
and current guidance. It contains the maintained preview/material/retained
continuity cases, original native requests and hash-bound archive provenance.
The file has `kind: "saved-model-tool-qualification-requests"`, the packed-team
SHA-256, current skill SHA-256, and `requests`. Refresh guidance using the maintained
context builders while preserving original raw state, action, identity and
provenance. Keep these files under ignored `cache/` storage. The user does not
need to assemble this evidence manually.

A new installation can use public MCP analysis tools immediately. Live admission
needs genuine complete saved native evidence supplied by its manager. An old menu,
replay summary or successful report cannot substitute for that evidence.

Use a fresh output directory. Actual generation consumes subscription usage.
Each saved case retains its original 40-second model window. Main qualification
needs actual selected-provider generation, model-requested calculators, complete
paired simulation, range endpoint coverage and sequential retained context.
Shadow qualification needs actual frozen research, normal completion, immediate
fresh-request preemption and confirmed cleanup. Additional journal checks enforce
the combined three calculator invocations and one native trajectory per case.
Partial/refused work remains partial/refused. Technical qualification establishes
no tactical score guarantee.

Receipts stay attached to the same provider objects in memory. JSON reports are
private evidence and cannot admit another process. `--qualify-only` closes those
providers on exit; a later live launch must qualify afresh.

## Run one explicitly authorized BO3

In an interactive manager terminal:

```powershell
node isolated/launch.mjs --run --model-tool-qualification cache/manager/saved-requests.json --session cache/manager/session.json --scope cache/manager/scope.json --output cache/manager/live-run
```

The launcher completes main and shadow qualification, then waits for literal
`START_LIVE`. The manager may now start the authorized saved-login battle client
through the normal broker, with `--sets 1 --saved-login --manual-ready
--save-replays --battle-timer`. See [the session guide](../showdown/README.md) for
the public account/team command. The launcher performs no login itself.

The manager writes the actual identity and exact one-set authorization files.
The session file has version, sessionId, packed-team teamId, account and teamFile.
The scope matches that identity and contains the user's authorization, version,
`maxSets:1`, `allowSearch:true`, `allowGenerationProbe:true`, `manualReady:true`,
`allowPonder:true`, explicit replay preservation and manual-forfeit permission.
Normal control policy:

```json
{"enabled":true,"forfeitIfStuck":false,"emergencyDefaultChoice":true,"planningMs":45000,"previewPlanningMs":60000,"unknownClockMs":20000,"safetyMarginMs":5000}
```

Paths stay inside the workspace and cannot traverse links. Stored credentials
supply no additional battle allowance. The exact packed team is validated from
its export; no roster change is performed.

After `START_LIVE`, the owned runner checks account/team/client, observed
`autoReady:false`, allowance, loaded module hashes, current synchronized skill,
previous review checkpoint, policy and native preflight. It saves private
`startup-adoption.json` and waits for **`START_SEARCH`**. The manager verifies that
proof against qualified source before releasing this second gate. The launcher
reserves one search before dispatch and never retries it.

Watch links come from actual native room identities. Keep selected, sent,
accepted, executed, defaulted and inactive outcomes separate. Use one owner to
drain the interactive stream and supervise attention.

## Context and research

Each exact child game starts a fresh owned thread with the full verified matchup
skill folder, current facts/schema and compact prior-game observations. Later
turns use verified static references and complete fresh dynamic facts. The packet
cap is 8 MiB; insufficient smaller caps refuse rather than drop required content.
The CLI's reported token window and headroom guard remain independent.

The direct catalog exposes eight tools: get_pokemon, get_move, get_ability,
get_movepool, calculate_damage, calculate_damage_range, calculate_speed and
simulate_choices. Broader offline simulation tools are hidden from the direct
catalog when simulate_choices is available. Shell, file, web and unrelated tools
are disabled.

The shared live budget spans main, shadow and native SDK calls for the same
session/team/game/board turn: three combined actual calculator invocations and
one simulated trajectory. Reissued requests and replacements in the same turn do
not reset it. Nested range/filter calculations count. Dispatch failures or
uncertainty spend reservations; schema failures before dispatch remain correctable.
Completed identical checks reuse exact results only after source/facts validation.
Changed questions cannot obtain another trajectory. Budget status describes a
limit and must not be called a mechanics failure.

Live current/frozen simulation makes zero new automatic spread-inference
calculator calls. It can reuse compatible branded cache; otherwise candidates
remain labeled unfiltered/history-unchecked. The model retains its allowance for
direct questions. A compact outcome retains end board, consequential ordered
turn events, uncertainty, pending actions and any replacement boundary. A paused
trajectory is not a complete turn. One sample is neither an exhaustive range nor
a probability or guaranteed KO. Full native diagnostics remain private. Explicit
offline analysis can still use detailed multi-world simulation.

## Pondering and recovery

The approved scope permits a separate read-only shadow provider after known local
submission while waiting for the opponent. Local submission does not establish
server acceptance. Fresh action, execution proof, uncertainty, readiness, game
end or main authoring immediately preempts it. The shadow cannot send choices or
delay the main author. Bounded speculative notes require fresh fact revalidation
and material checks; frozen receipts carry no current action authority.

Attention retains the original owner, uncertain reservations and deadline. The
public stream preserves complete maintained sanitized recovery envelopes and any
prepared manual containment command. Protect/reconcile a useful current pair
through available same-owner operations before diagnosis. A prepared forfeit is
never executed automatically and needs existing permission for that exact parent.
Do not repeat an uncertain send, reset a thread, authenticate again or search
another set as an improvised repair.

## Review and close

Normal completion verifies official parent result and server idle, preserves
replays/metrics/model timing and the bounded ponder journal, releases the idle
lease, and returns `review-required`. The client remains available for the manager's
checkpoint. Finish private decision/batch review, applicable skill validation/sync,
native review save/status and bounded retention, then stop the client normally
and verify descriptor/process shutdown.

Modules: launch.mjs supplies public orchestration; runner.mjs owns the one-set
lifecycle; native-controller.mjs supplies the mechanical turn loop;
model-tool-cycle.mjs relays author/tool calls; codex-session-transport.mjs owns the
CLI protocol. Main/compact/ponder qualification modules retain actual evidence.
`npm run test:isolated` runs offline regressions. Optional private-capture tests use
explicit environment paths and otherwise skip; captured accounts, teams and raw
requests are excluded from public releases. Changed interfaces require fresh
actual selected-model/MCP qualification before their next authorized live adoption.
