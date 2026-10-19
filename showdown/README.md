# Direct Pokémon Showdown transport

This is a Node 24 WebSocket transport and structured action API. The core transport uses Node built-ins; the MCP/session integration uses the repository dependencies. Strategy comes from the controlling agent. Use MCP `calculate_damage` and `calculate_speed` for numerical analysis.

For the complete headless-agent loop, see [Agent workflow](AGENT-WORKFLOW.md).

## Verified status (2026-10-15)

- Anonymous official socket connection and server challenge received successfully; socket then closed.
- Offline fixture tests cover doubles, forced switches, preview, OTS, BO3 readiness, replay verification, request revisions, deadlines, explicit grants, authentication boundary, and reconnect deduplication.
- Fixed team G imports as six Pokémon with existing official `pokemon-showdown` Teams utility. Packing is not a legality check.
- The original transport completed one authorized live M-C BO3 with user-operated terminal login, paired actions, server-confirmed results and clean shutdown. Replays were not published.
- New MCP controls, native Speed calculations, state reconstruction, readiness handling and readable log streaming are tested through isolated fixtures/public MCP calls. No additional live queue was used to test these changes.

## Recommended local MCP session

From the installed repository, build/restart the MCP server and run this in the terminal you personally control:

```powershell
npm.cmd run battle:session -- YOUR_USERNAME --team YOUR_TEAM.txt --sets 1
```

The session validates and locks the exact six, asks for the hidden password by default, and then starts an OS-local control bridge. A readable battle log streams in this same terminal by default. It prints an official watch URL for the BO3 and each game when the server announces them, once per room, including when the active room count stays unchanged. Links retain the full server room ID; private links stay in the user's terminal. There are no password arguments or saved login assertions. Login alone never searches. Ctrl-C closes the session; `--manual-ready` disables automatic between-game readiness.

### Optional Windows saved login

Saved login is opt-in and available only on Windows. For an account such as `YourPlayer`,
personally open **Credential Manager → Windows Credentials → Add a generic
credential** and enter:

- Internet or network address: `VGC-Coaching/PokemonShowdown/yourplayer`
- User name: `YourPlayer`
- Password: type the Showdown password directly into Credential Manager.

Then start a visible terminal session with the explicit flag:

```powershell
npm.cmd run battle:session -- YourPlayer --team YOUR_TEAM.txt --sets 1 --saved-login
```

This invocation reads only that exact generic credential and verifies its stored
account. For another explicitly approved account, the target is
`VGC-Coaching/PokemonShowdown/` followed by its lowercase account ID with
non-alphanumeric characters removed. The helper never lists vault entries.

The Windows helper reads the password and submits the fresh challenge to the
fixed official Showdown login endpoint. Only the resulting challenge-bound
assertion returns privately to the client; neither the agent nor MCP receives
the password. Passwords are not copied to repository/cache files, environment
variables, command arguments or battle logs. Assertions are not saved. The
local bridge descriptor remains a separate non-Showdown control capability.

Both login modes require a visible user-operated terminal. A missing credential,
wrong stored account or failed login ends the attempt without a retry or fallback
prompt. Omit `--saved-login` to choose the ordinary hidden terminal prompt. To
remove saved access, delete the exact generic credential yourself in Credential
Manager. Saved login does not authorize matchmaking, extend the set allowance,
or enable background reconnects. After a disconnect, a new explicitly started
session may use `--saved-login` again within the user's authorized battle scope.

MCP tools `battle_status` and `battle_wait` return compact observed state, open sheets, current action tokens, legal actions and observed countdowns. `battle_turn_status` returns the current board, fresh legal request, choice, controller and recovery deadlines in one bounded response; the full published opposing sheet appears only during actionable preview. `battle_start` uploads the locked team and sends one search. `battle_choose` consumes a fresh token plus complete doubles actions. `battle_ready`, `battle_cancel_search`, `battle_forfeit` and `battle_stop` handle the remaining controls. Production control mutations require an exclusive lease from `battle_control_claim`; see below. Each action remains subject to the user's actual scope; the default hard limit is one matchmaking search. The session only acquires its expected-format BO3 parent and server-linked children, not unrelated battles on the account.

### Exclusive controller and deadline watchdog

Claim an idle/new session with `battle_control_claim({confirmed:true,
commandId:"claim-once",controllerId:"batch-operator"})`. Its private opaque
`controllerLease` is required on every socket-mutating tool, including safety
configuration, replay saving and shutdown. State, trace and decision notes do not
need it. To transfer control, first read `controller.generation`, then claim with
`takeover:true,expectedGeneration:CURRENT_GENERATION`. This revokes the old lease
and clears its fallback. A claim label is not ownership. Reuse the original
command ID after an uncertain reply; concurrent takeovers cannot both match the
same generation. `battle_control_release` explicitly relinquishes the lease and
clears its fallback without closing or forfeiting the set.

Deadline protection is off by default. While the server confirms idle, configure
`battle_set_control_policy` with `confirmed:true`, a unique `commandId`, the lease,
`enabled:true` and `forfeitIfStuck` matching the user's explicit permission.
Defaults are `emergencyDefaultChoice:false`, `planningMs:20000`, `safetyMarginMs:5000`, and
`unknownClockMs:20000`; the observed server clock can shorten the deadline.
The unknown-clock cap is a conservative local limit, not an invented server clock.
Enabling protection never starts matchmaking or extends the authorized allowance.
Production `battle_start` requires this protection enabled and not halted.

On every fresh request, the agent stages a complete legal choice using
`battle_stage_fallback({confirmed:true,commandId:UNIQUE_ID,controllerLease:LEASE,
token:CURRENT_TOKEN,actions:COMPLETE_PAIR})` before optional research. The enabled
watchdog can send that agent-selected pair when the operator stalls. Staging is
not a send or acceptance; ordinary `battle_choose` remains the prompt preferred
submission. A changed request, disconnect, release or takeover invalidates the
fallback. The watchdog performs no damage or Speed calculations.

With the user's explicit authorization, set `emergencyDefaultChoice:true` in that
idle policy call to permit a deterministic complete legal choice when the agent
provides no usable pair by the planning cutoff. The staged agent pair always has
priority. Emergency choices use the fresh request's legality for preview, moves
or forced replacements, make no strategic judgment and never automatically Mega
Evolve. They retain distinct `emergency-default` control evidence and mark the
game operational even if it is won. This is a local emergency choice; do not call
it a server default or an accepted/executed action without corresponding evidence.
The option remains off unless enabled, and never retries a sent or uncertain
choice, authenticates, queues or adds battle allowance.

When a fresh unsubmitted request has no usable fallback at its planning cutoff
and emergency default selection is disabled or cannot produce a legal choice,
the client enters recovery attention and halts future searches. Current-set legal
staging remains available; an overdue staged pair can send promptly. Automatic
stuck-forfeit requires verified current server turn/bank emergency evidence and
`forfeitIfStuck`; an unknown clock never invents an expiry. Fresh timer-off evidence
revokes the cancelled timer's deadline. Preserve a missed planning target as a
control failure even if recovered, and finish the eventual official result review.
Only deliberate idle policy configuration clears the halt. Read
`battle_control_trace({room:OPTIONAL_OWNED_ROOM,limit:50})` for bounded request,
stage, send, rejection, acknowledgement and advancement evidence. Separate agent
intent, sent, accepted, executed, server-defaulted and inactivity outcomes.

Successful local sends remain reserved while the opponent plans. Ordinary server
choices emit no live `sentchoice` acknowledgment; connection restoration may
include one for an existing choice. Preview, moves and forced replacements can
wait beyond five seconds with acceptance unknown. Missing acknowledgment alone
causes no automatic resend, halt or forfeit. An uncertain socket write instead
gets bounded reconciliation; if still unresolved, mark attention and halt future searches, without
blind resubmission or automatic forfeiture solely from missing acknowledgment.
Fresh unsubmitted requests still require protected prompt choices during that
halt. This separates actual missed planning from normal waiting for the opponent.

Forced replacements expose named options, stable `pokemonId` values and complete
switch/pass combinations. Supply exactly one of `{type:'switch',pokemonId:ID}` or
`{type:'switch',slot:N}`; prefer identity to a guessed index. It is resolved and
revalidated against the latest request before sending. These features require the
newly loaded client at its next authorized startup; rebuilding MCP does not update
an existing terminal session. The [agent workflow](AGENT-WORKFLOW.md) gives the
full guarded sequence.

### MCP workflow and loaded capabilities

Use `battle_capabilities` and `battle_status.capabilities` to inspect the actual
running client. They expose its schema, advertised operations, optional feature
flags, load time and a SHA-256 fingerprint of the AgentSession source loaded by
that process. The fingerprint covers that module; it does not attest every
dependency. `battle_status` also exposes `awaitingSet`, `searchPending` and
`switchingTeam`, so a transient idle server update is not proof that a pending
match has settled. Updating source or restarting MCP never hot-reloads an open
signed-in terminal. Keep its current login; use advertised features and preserve
logs until its next normal start can adopt new features.

The same MCP exposes the remaining private BO3 workflow:

| Tool | Purpose |
| --- | --- |
| `battle_preflight` | Check the existing session, approved team, pending work, allowance, loaded capabilities, previous review, skill sync and report health. `ready` is informational and grants no permission to search. |
| `battle_skill_status` | Compare the complete maintained and installed skill folders and return exact hashes and differences. |
| `battle_skill_read` | Read the complete current skill folder and return a short-lived `readReceipt` tied to its source digest and this MCP process. Delivery does not prove the agent followed it. |
| `battle_skill_sync` | Preview installation by default; `dryRun:false, confirmed:true` installs reviewed source guidance with private backups and verification. It does not edit source. Read the updated folder afterward. |
| `battle_review_get` / `battle_review_status` | Retrieve an exact team's BO3 checkpoint or inspect completeness blockers, official results, evidence revision and skill adoption. |
| `battle_review_save` | Save the structured private decision review after an official parent result. It validates stored identity/evidence and current skill adoption; tactical judgments and validation descriptions remain agent assertions. |
| `battle_note_decision` / `battle_decision_notes` | Save optional intent against an observed action token, then query private notes by exact team, canonical child room and optional turn range. |
| `battle_calculation_evidence` | Retrieve the recorded inputs and outputs of an actual MCP calculation by exact team and receipt `id`. Performs no new calculation. |
| `battle_switch_team` | Apply an explicitly approved full legal team while idle, prepare its report and preserve the signed-in account and remaining allowance. |
| `battle_set_replay_policy` | Explicitly enable saved-replay capture for future owned sets, or disable it for future acquisitions; inspect preservation status before another search. |
| `battle_set_timer` | Explicitly request the server timer on for the current owned live child; inspect separate server observations before claiming it is active. |

Every BO3 still requires the private review and skill checkpoint before another
authorized search, including wins, forfeits and the final set. Prefer these MCP
workflow tools to manually writing review JSON or copying installed skills; also
follow the repository's required `sync-skill.mjs --check` check. Preflight and
review saves validate their stated contracts; `battle_start` does not implement a
runtime review guard, and no tool can establish tactical correctness from prose.
Do not search, authenticate, change the roster, publish replays or commit merely
to validate a skill or these APIs.

### Enable the current battle timer

When the user requests the timer, use the owned live child from fresh state:

```text
battle_set_timer({confirmed:true, controllerLease:LEASE, commandId:"timer-current-child", room:CHILD_ROOM, enabled:true})
```

`enabled` defaults to `true`; `false` is rejected because this operation only
enables the timer. It accepts the current canonical child room or its trusted
privacy alias and requires the exclusive controller lease. The client verifies
the live parent, current connection and linked child before sending exactly
`CHILD_ROOM|/timer on`. It does not choose moves, change deadline policy, search,
extend the allowance or authenticate. Reuse the command ID after an uncertain
reply. A per-child reservation prevents another send through a different ID or
alias, including after an uncertain write.

The result reports `sent-not-acknowledged`, not confirmed timer activation.
Each child's status and compact board expose `timer.request` separately from
`timer.serverObservation`, which records the latest `inactive` or `inactiveoff`
server event. Its `afterRequest` flag establishes event order only; it does not
prove that the event acknowledges this request. Observe the actual clock before
using it for deadline decisions. Enabling the timer does not extend a turn or
replace prompt legal choices.

Check the loaded `set-timer` operation and `ownedBattleTimer` feature first.
An older signed-in client does not gain this feature from a source build or MCP
restart. Do not restart or authenticate merely to test timer support; keep the
existing set and login until a separately authorized lifecycle transition.

For the single reviewed legacy build, `enableLegacyBattleTimer(options)` in
`showdown/legacy-timer.mjs` provides an explicit, bounded terminal remediation
when the user has authorized both timer activation and saved login. It has no
public CLI and is never an automatic MCP authentication fallback. The current
operator's TTY helper passes its private lease in memory, verifies the unchanged
owned submitted preview and the exact legacy refusal, then opens one same-account
broker login while the primary stays connected. Before its sole timer-on send,
it requires the server-restored preview choice and matching registered species,
items, moves and abilities; investments remain bound to the primary approved
team fingerprint. Unknown builds, uncertain probes or mismatches stop recovery;
authentication and uncertain writes are not retried. Only the auxiliary socket
closes. A timer event is observation evidence, not a final game or BO3 result.

### Authorized replay preservation policy

Replay publication defaults off. Within the user's explicit replay-saving scope,
call `battle_set_replay_policy({enabled:true, confirmed:true, controllerLease:LEASE, commandId:"replay-policy"})`
while the server confirms idle. A personally started terminal can opt in with
`--save-replays` instead. The choice remains active throughout this signed-in
session, including later explicitly authorized allowance extensions. Enabling it
does not upload historical sets, change room privacy, authenticate or search.

For each subsequently acquired owned BO3, the session waits for the official
parent result, finished trusted children and server idle, then makes one bounded
save/verify/preserve attempt. It flushes the recorder and independently checks
the exact team/parent child manifest, report replay links, compressed replay
hashes and complete canonical game evidence. `battle_status.replayPolicy` exposes
safe per-set progress and failures; private URLs remain in manual save results
and ignored reports. The next search or team switch is blocked while a set
acquired under this policy lacks confirmed preservation. A successful save never
starts another match or completes the required private decision review.

After an uncertain send, wait for existing server evidence and retry
`battle_save_replays` for the same parent using a new command ID only when a new
verification attempt is intended. Reuse the original command ID to recover its
original result. Requests already reserved by the client are never uploaded
again; a late returned URL can be verified without repeating publication. A
failed report write returns available verified URLs with `complete:false` and
`requiresReplayImport:true`; keep local evidence, repair/import that exact team,
and verify again. Disabling the policy affects future sets and does not erase
an existing required preservation obligation.

An explicitly requested manual save outside the policy remains nonrequired
status and does not create a permanent next-search guard. In particular, a
historical parent saved after a team switch returns its original team ID and
available URLs. Import those URLs into that old report when needed; a later save
verification can confirm its durable evidence without flushing the new team's
recorder. Automatic policy status never authorizes historical publication.

Loaded capability feature fields `recordingSchemaVersion` and
`previewDecisionEvidence` come from the attached recorder's actual status, and
`authorizedReplayPolicy` identifies the preservation helper. An AgentSession
source fingerprint alone does not establish adoption of these dependencies.

### Optional decision notes and retained calculations

`battle_note_decision` takes a unique `commandId`, an observed `token`, optional
`predictedOpposingActions` (up to two), `ourPlan`, `alternatives`, `reason` and
`calculationRefs` (receipt UUIDs). Supply a plan or reason. The session binds the
note to the exact team, session, room, request ID and observed turn. Annotation is
optional and does not serialize `battle_choose`: submit urgent complete paired
choices first, then annotate the observed token if needed. Predictions and intent
stay separate from selected, sent, accepted, executed and server-defaulted facts.

When making an actual `calculate_damage` or `calculate_speed` MCP call, pass
`evidenceContext:{teamId,roomId,turn}` to retain its real input/output and receive
a `calculationRef`. Put its `id` in the note's `calculationRefs`. Notes resolve
the retained receipts and require matching team/room and any recorded turn;
arbitrary reference text is rejected. A verified receipt proves what the tool
returned for those inputs, not other numeric assertions or the prediction.
Unsupported calculations and unknown opposing investments remain explicit.

`battle_decision_notes({teamId,room,fromTurn,toTurn})` reads those saved notes
even after the client closes. Use `team_metrics_game_evidence` separately for
observed protocol and action evidence. Notes and calculation receipts stay in
ignored private team data and are removed with permanent team cleanup, including
capacity eviction; they are not public replay contents or reusable skill text.

### Change an approved team without another login

After completing the previous BO3 review/preservation checkpoint, call
`battle_switch_team` with `confirmed:true`, a unique `commandId`, and exactly one
of a full Showdown `teamText` or a registered exact `teamId`; `name` is optional.
The session requires server-confirmed idle, no unsettled search/match and no
replay operation. It independently validates all six, flushes the old recorder,
prepares the next report, rechecks idle and retains the old team on failure.
Existing games keep their original team attribution. Switching creates/accesses
a report and can permanently evict the oldest report beyond the recent ten;
inspect report cleanup blockers rather than claiming completion.

A successful switch resets upload state. It does not upload, search, extend the
set budget or authenticate; a separately authorized `battle_start` uploads the
new approved team. If the loaded client lacks `switch-team`, retain its login and
wait for its next normal start rather than restarting it merely to test the tool.
For an older owned parent saved after a switch, `battle_save_replays` returns its
original `teamId` and `requiresReplayImport:true`: append its returned URLs with
`team_metrics_import_replays` using that exact old ID and confirm preservation
before cleaning evidence. Saving replays before switching avoids that extra step.

For report diagnostics and review support, use `team_metrics_health`, audited
`team_metrics_annotate_game` / `team_metrics_game_annotations`, and
`team_metrics_compare` with identical filters. They preserve measured outcomes
and separate manual exclusions from observed operational flags. A comparison is
descriptive, not evidence that a roster change caused a result. Use
`team_metrics_viewer_status` or `team_metrics_open_viewer` for the private local
report URL. See [metrics](../metrics/README.md) and the
[agent workflow](AGENT-WORKFLOW.md) for report, review and cleanup sequencing.

When the user authorizes forfeiting a stuck set, call
`battle_forfeit({confirmed:true,controllerLease:LEASE,commandId:"forfeit-set-once",room:BO3_PARENT_ID})`.
The command ID is required. This sends `/forfeit` to the owned live BO3 parent,
forfeiting the whole series while keeping the signed-in connection open. It does
not require a turn token, expand room ownership, reconnect, or queue. Only the
current parent or an already-trusted privacy alias is accepted. After a send or
uncertain write, choices and readiness inside that parent remain blocked.
The reply is only `sent-not-acknowledged`; `rooms[].forfeit` records that pending
send. Observe the official parent result and then server idle before considering
the set finished. Reuse the command ID to reconcile an uncertain reply rather
than submitting a new forfeit. An already-running older terminal cannot load this
operation merely by rebuilding or restarting its MCP server.

The bridge does not automatically disconnect when its set allowance is consumed.
The agent's batch policy is to keep it open between BO3s, then close it after the
batch's final verified replay, metrics, review and bounded-retention checkpoint,
unless the user requests otherwise. Call `battle_stop` and verify shutdown;
closing an MCP helper alone leaves the battle client open. See the
[batch-end procedure](../skills/champions-mc-matchups/references/headless-battle-cycle.md#end-the-batch).
To reuse an open session for another authorized set, verify with `battle_status` that the server
reports no searching formats or active games. Call
`battle_authorize_sets({confirmed:true,controllerLease:LEASE,additionalSets:1,commandId:"authorize-next-set"})`,
then separately call `battle_start({confirmed:true,controllerLease:LEASE,commandId:"start-next-set"})`.
Authorization requires a live, idle session with no pending match and changes
only its remaining allowance; it never queues or changes the account/team.
`additionalSets` is an integer from 1 to 100, with a cumulative maximum of 100.
Repeating the same command ID retrieves the original result without extending
the allowance twice. A closed session requires a new visible session: hidden
terminal login by default, or the authorized Windows saved-login broker. Use that
broker for the next already-authorized batch, preserving overall progress and
remaining limits. Stored credentials do not authorize extra battles, automatic
login retries or authentication merely to test the workflow.

The bridge uses a Windows named pipe or Unix domain socket, not TCP. `cache/showdown-session.json` contains a random local control capability, address, PID and session ID. It contains no password or Showdown assertion and is removed on orderly shutdown. Keep the cache private. An existing descriptor blocks replacement; after a hard crash, verify the recorded process has stopped before removing that exact descriptor. The bridge never reconnects, reauthenticates or replays queued actions.

State includes HP precision, statuses, stat stages, known items/consumption, Mega forms, observed field conditions and bounded duration estimates. Missing upkeep evidence makes remaining duration unknown. Server request stats are labeled unmodified stats, not calculated effective Speed. Use `calculate_speed` with explicit current-form snapshots and native stat points; its engine returns raw stats, effective Speed and same-priority order with unresolved ties. It does not resolve priority, Quick Claw, Quash or other non-Speed order changes.

`battle_wait` accepts `afterRevision` and a timeout up to 30 seconds. Ready prompts are handled promptly within the already authorized set by default. Countdown estimates derive only from recognized own-player server observations; unavailable clocks stay unknown. Tokens bind room/request/revision/connection, so a completed battle or changed request invalidates a late choice. A choice being sent, server-accepted, or observed resolving are separate facts; blocked actions are not marked executed.

## Run in your own terminal

Use Node.js 24 or newer from the installed repository for the recommended MCP session. The low-level client/login/control modules use Node built-ins and can be copied together; packing, the recommended session and the full test suite require repository dependencies.

    node --version
    node showdown/cli.mjs login YOUR_USERNAME

Replace YOUR_USERNAME with your Showdown account name. Type the password yourself into the hidden prompt and press Enter. It must be your interactive terminal; do not put the password in the command, a file, chat, or a pipe. This signs in only. It does not upload a team, search, or make battle choices. After login, the same process accepts JSON-line controls, such as:

    {"id":"status-1","op":"status"}
    {"id":"quit-1","op":"quit"}

Supply your own approved `TEAM.txt`. The optional `pack-team FILE` command uses the repository’s official `pokemon-showdown` dependency and is not standalone. Run `node showdown/cli.mjs pack-team TEAM.txt > approved-team.json` in the installed repository, then use that nonsecret packed value and hash with the standalone controller. The historical fixed G team is not included with this client. The core CLI works standalone; the new session, MCP and full test suite require the installed repository dependencies.

This bundle is a transport/controller, not an autonomous battling program. The dot-cloud coaching MCP and agent are not bundled, and a local terminal process is not automatically connected to dot. Do not assume dot can access or play through this process. Damage calculations remain exclusively the coaching MCP's responsibility. No live search is authorized merely by running login.

## Run in the existing repository

From the repository root:

    node --test showdown/*.test.mjs
    node --use-env-proxy showdown/cli.mjs smoke
    node --use-env-proxy showdown/cli.mjs observe
    node --use-env-proxy showdown/cli.mjs control
    node showdown/cli.mjs pack-team TEAM.txt

`smoke` connects anonymously and exits after receiving a challenge. `observe` remains connected and accepts only `status` and `quit` on stdin. It does not log the challenge, authenticate, or send live actions. The `control` mode accepts JSON-line commands and returns tagged JSON results on the same persistent process, alongside protocol events. No generic raw-command or credential CLI is exposed. The environment proxy flag uses the configured route; a failed connection is not retried through another route.

The six-member fixed G packed team has SHA-256:

    e80b1aaaf56dff7456904ca7fe54ff5e8048fe541031b76ad50cbe96e34f68b2

This hash is enforced by default before upload. For another explicitly approved and MCP-validated team, pass `--team-sha256 HASH` as the final CLI option or `expectedTeamHash` to the constructor. The hash must be 64 lowercase hex characters. The standalone JSON-lines controller cannot change its configured hash; approved idle replacement is exposed separately through AgentSession/MCP `battle_switch_team`. The historical team preserves Leech Life and Sucker Punch. Local test fixtures explicitly substitute their fixture hash. No dependencies were installed.

## User-operated hidden CLI login

The official protocol requires a fresh challenge-bound assertion from `https://play.pokemonshowdown.com/api/login` (username/password login), or `/api/upkeep` (existing browser session). The assertion is sent to the socket using `/trn` and identity must be acknowledged by the server.

The default terminal broker and low-level `cli.mjs login` do not read browser
cookies/storage, passwords from chat, command-line secrets, files, environment
variables or saved credentials. There is no web form, login server, plaintext
credential cache or assertion-export flow. The separate opt-in
`session.mjs --saved-login` broker reads one approved Windows generic credential
as described above; it does not change the default CLI login behavior.

Only when the user can personally control the terminal:

    node --use-env-proxy showdown/cli.mjs login USERNAME

The user types their password directly into the hidden prompt and presses Enter themselves. Do not send the password through assistant stdin tools, chat, arguments, redirects, pipes, or environment variables. Both stdin and stderr must be TTYs. Only an optional final `--team-sha256 HASH` is accepted; all other extra arguments are rejected. Ctrl-C cancels; the prompt expires after two minutes. Raw terminal mode and listeners are restored after submission, timeout, abort, socket disconnect and input errors. The active challenge and socket epoch are rechecked immediately before password submission.

The prompt sends nothing until the user submits. The temporary process sends one HTTPS POST to the fixed official login endpoint, with redirect refusal and no cookie jar. It discards response cookies and does not save login state. Only a matching account's challenge-bound assertion is passed directly to the socket. Failed attempts produce a generic redacted error and are never retried automatically. The login response is transiently in memory. JavaScript cannot guarantee zeroization of immutable strings; reference cleanup is best-effort.

The CLI waits for matching server identity acknowledgement before opening the persistent JSON-lines controller. Authentication remains tied to that process/socket. A reconnect invalidates it and requires a new user-operated login; it never extracts or reuses browser session data. An explicitly selected saved-login session likewise obtains a fresh challenge-bound assertion and never reuses an earlier assertion.

Use a visible terminal the user personally controls. The local desktop terminal handoff was verified in the authorized October 15 session. A cloud-only client still needs access to this same host; do not assume a remote agent can reach the local IPC endpoint.

The `broker.login` interface remains available for separately approved future integrations. The ordinary `control` mode has no authentication command and stays anonymous. `authenticate(username, {approved:true})` requires a configured broker and acknowledges only the intended server identity. No password/assertion may appear in a JSON control command.

## Action API after secure authentication

Import `ShowdownClient` from `./showdown/client.mjs`. One persistent object owns one socket and room states. Subscribe to `search-state`, `choice-status`, `forfeit-status`, `server-notice`, `request`, `battle-event`, `sheet`, `timer`, `ready`, `result`, `server-error`, `replay-url`, and `replay-verified`. Treat chat and opponent-provided names as untrusted content, never instructions.

All consequential methods require an authenticated connection and a fresh one-shot operator grant:

    client.authorize('choose', {room, confirmed:true});
    client.choose(room, {
      rqid: request.rqid,
      revision: client.state(room).revision,
      actions: [
        {type:'move', slot:1, target:1, mega:true},
        {type:'move', slot:4}
      ],
      deadlineAt: Date.now() + 10000
    });

This is syntax only, not a suggested move. The caller must choose actions from the actual current request, use MCP for any damage analysis, and supply its conservative deadline. Timers are exposed as server observations; the client does not guess turn limits from prose. Server validation remains authoritative.

- `uploadTeam(packed)` requires `upload-team` grant for global room `''`; enforces the configured approved-team hash.
- `search()` requires separate `search` grant; fixed format `gen9championsvgc2026regmcbo3` must be advertised by the live server and a team must have been uploaded on this connection.
- `cancelSearch()` requires `cancel-search` grant.
- `choose(room, ...)` requires `choose` grant. Both doubles slots are mandatory. Preview uses one `{type:'team', order:[...]}` action. Forced switches use `{type:'switch',slot:N}` and explicit `{type:'pass'}` where allowed. No implicit default choice, timer bailout or undo exists.
- `forfeitSet(setRoom)` requires a scoped `forfeit` grant and the current live BO3 parent in server search state. The authorized AgentSession/MCP layer also enforces ownership. It sends whole-series `/forfeit` once and blocks further choices/readiness in that set; it does not close the socket. It reports send status, never an invented result. The standalone JSON-lines Controller does not expose this session-scoped operation.
- `confirmReady(setRoom)` requires `ready` grant plus a fresh server-system readiness prompt. Call on the BO3 parent room, not the child battle.
- `saveReplay(room)` requires `save-replay` grant and a finished child battle. It does not silently change replay privacy. Saving publishes according to the room's current server privacy; obtain appropriate user authorization first.
- `verifyReplay()` only accepts a matching URL returned by the server's replay popup, then fetches its JSON and checks ID and completed battle log. A guessed URL or a successful `/savereplay` send is not upload confirmation.

For an owned, officially ended BO3, MCP `battle_save_replays` performs those
save/verify operations for its completed children and reports per-child coverage.
Use it within the user's existing replay-saving authorization; it preserves room
privacy and never queues another set. The returned full private links belong only
in ignored local reports/checkpoints. An older running client does not gain this
operation from a source update; preserve its login and state until a deliberate
reload is appropriate.
- `joinRoom(room)` explicitly joins a known room for observation/resynchronization. It never queues a battle. Joining does not restore authentication.
- `snapshot()` gives structured requests, full packed OTS, bounded battle protocol events, child-room links, results and timer observations. Store snapshots privately if needed; they may contain private team information.

Grants are local safety checks, not a replacement for actual user authorization and not a tamper-proof security boundary against arbitrary imported code. Confirm each intended action in the agent's authorized scope. Grants expire after 30 seconds by default, at most two minutes, and are consumed once. Do not authorize live play merely to test the transport.

## Persistent JSON-lines controls

Keep `node --use-env-proxy showdown/cli.mjs control` running in one shell session. Send additional lines to the same process using the session's stdin. Each command has a unique `id`; resending the same ID returns the original result without executing again. Errors are cached too: after correcting an error, use a new ID.

    {"id":"status-1","op":"status"}
    {"id":"join-1","op":"join","room":"battle-known-room-123"}
    {"id":"choice-1","op":"choose","room":"battle-known-room-123","confirmed":true,"rqid":7,"revision":1,"deadlineAt":1792087000000,"actions":[{"type":"move","slot":1,"target":1},{"type":"move","slot":4}]}
    {"id":"quit-1","op":"quit"}

The example choice is deliberately illustrative; use the real request and a current deadline. It cannot run in anonymous `control` mode. It becomes available after the user-operated `login USERNAME` flow succeeds, subject to each action’s authorization. Supported operations: `status`, `reconnect`, `join`, `upload-team` (packed field), `search`, `cancel-search`, `choose`, `ready`, `save-replay`, `verify-replay`, `quit`. Consequential operations require `confirmed:true` and still enforce authentication and all state guards. There is no operation that grants broad lasting permission. Authentication is unavailable as a JSON command; only the separate user-operated login entry point can authenticate. Arbitrary commands are unavailable. Explicit `reconnect` uses the same official socket endpoint and retains deduplication keys; it invalidates auth and does not rejoin or retry any live action.

For an approved future broker integration, instantiate and authenticate the same client object securely, then pass it to exported `runControl(client)`. Never transmit passwords/assertions as control commands. Protocol events and command replies are separate JSON records; command replies carry the supplied `id`, while events carry `event`.

## Private team metrics

New `runSession` instances attach an observation-only metrics recorder after
sign-in. It saves compact per-game statistics at turn boundaries and official
results under `cache/team-metrics`, using the same validated team fingerprint.
Metrics persistence cannot issue battle commands and a write failure does not
close the connection or interrupt battle controls. No raw private requests,
authentication data or chat are saved in the metrics store.

An already open older client can keep its connection. Import its existing local
event log with `team_metrics_import` and `remember: true`; subsequent metric
queries refresh that log. See [metrics tools and definitions](../metrics/README.md).

The authorized after-BO3 workflow saves verified replay links, completes the
decision review and skill checkpoint, then uses `team_metrics_finalize_bo3` to
retain compact per-game evidence and inspect a cleanup dry run. Confirmed cleanup
removes only explicit closed artifacts with complete replay/evidence/review
coverage under `cache/bo3-runs/CANONICAL_PARENT_ID/`. Opaque JSON files remain
protected. While a client is open, `closedFiles` attests only candidates whose
writer closure was observed; it cannot override active/shared-source protection.
Registered shared sources need a separate all-set audit; use `remember: false`
for new closed per-set imports intended for cleanup. Active writers, IPC and
current control files remain protected. The metrics database, exact teams,
official results, compressed review evidence and current reports remain local;
agents can read focused archived turns with `team_metrics_game_evidence`.
See the [required BO3 cycle](../skills/champions-mc-matchups/references/headless-battle-cycle.md).

## Failure and reconnect behavior

A choice is identified by room, rqid and request revision. Older rqids, expired decisions, missing paired actions, disabled moves, invalid bench slots, duplicate actions, and stale reconnect state fail closed. Identical repeated requests do not clear deduplication. A changed request (for example unavailable move) gets a new revision. A server `sentchoice` acknowledgement blocks acting on a restored, already-submitted request; it is not a routine live acknowledgment after every choice. Explicit invalid-choice errors permit deliberate corrected decisions at the new revision; stale-rqid/too-late errors require a fresh request.

Sending marks the action before socket I/O; an ambiguous send is never automatically retried. A sent action is not an acknowledgement. Fresh server requests, errors and battle events establish progress. Reconnect clears identity, grants and request freshness while preserving sent-action keys. Authenticate securely, explicitly rejoin known rooms, inspect fresh state, and decide manually; never replay an outbound queue. Process restart loses in-memory deduplication, so restarting during a live battle requires manual state reconciliation and must not replay prior commands.

BO3 readiness only comes from trusted server/system protocol output, not opponent chat. OTS is retained as packed server-provided sets. Replay operations are serialized. Successful verification archives the result and clears the pending slot for the next child replay. Failed or uncertain verification remains pending and is not silently retried.

Logs contain metadata (event/action/room/time/hash), not raw socket traffic, assertions, passwords, or teams. Battle state is available separately to the controlling agent. Strategy remains with the agent; the optional emergency selector supplies only a deterministic legal choice.

## Official sources checked

- https://github.com/smogon/pokemon-showdown/blob/master/PROTOCOL.md
- https://github.com/smogon/pokemon-showdown/blob/master/sim/SIM-PROTOCOL.md
- https://github.com/smogon/pokemon-showdown/blob/master/server/room-battle-bestof.ts
- https://github.com/smogon/pokemon-showdown/blob/master/server/chat-commands/core.ts
- https://github.com/smogon/pokemon-showdown/blob/master/server/rooms.ts
- https://github.com/smogon/pokemon-showdown/blob/master/config/formats.ts

The existing installed official source revision is pinned in package.json to a5df8274e85b0889bf2a9b3422a08b39732374fc. Protocol and BO3 files were also checked against official upstream. Installed sources confirm `/choose CHOICE|RQID`, `/utm`, `/search`, `/confirmready`, `|showteam|`, and the server-generated replay popup path. Live transport play was verified once; the new integration has fixture/MCP verification and replay publication remains untested live.

Forfeit behavior was checked in that pinned revision: the core `/forfeit`
handler calls the addressed room's game; `BestOfGame.forfeitPlayer` ends the
parent series and forfeits its active child. The new forfeit tool has offline
fixture and public MCP validation; no live forfeit was used to test it.
