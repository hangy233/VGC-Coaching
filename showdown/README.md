# Local Showdown client

The Node.js client owns one authenticated Showdown socket and exposes a structured OS-local MCP bridge. The model supplies strategy; the client supplies current requests, native command construction, exclusive controls and evidence. The supported automated author is the [subscription Codex CLI runner](../isolated/README.md).

See [agent workflow](AGENT-WORKFLOW.md) for admission/recovery/review and [architecture](../docs/ARCHITECTURE.md) for component boundaries.

## Start a local session

Use Node.js24 or newer, build the project, and open a visible terminal within the explicitly authorized scope:

```bash
npm run battle:session -- YOUR_USERNAME --team teams/YOUR_TEAM.txt --sets 1 --manual-ready
```

Use `npm.cmd` on Windows when your shell requires it. The session validates and locks the exact six, then asks the user for a hidden password. Type it in the terminal, never through chat, arguments, environment variables or an assistant stdin tool. Login alone sends no search.

The CLI decision workflow requires `--manual-ready` and verifies `autoReady: false`; a healthy owned loop advances the current BO3. A stopped author must not automatically open another preview. One set is the default search allowance, not permission to play it.

Replay saving and timer policy are separate explicit permissions. When authorized, add `--save-replays --battle-timer`. Saving publishes according to existing room privacy; retain full private access links only within the user's sharing scope.

### Optional Windows saved login

The user may personally add a generic credential in **Credential Manager → Windows Credentials**:

- Address: `VGC-Coaching/PokemonShowdown/ACCOUNT_ID`
- User name: the approved Showdown account
- Password: entered directly in Credential Manager

`ACCOUNT_ID` is the lowercase account name with non-alphanumeric characters removed. Start the same command with `--saved-login`. The broker reads only that exact credential, checks its account and submits a fresh challenge to the official endpoint. The password and assertion do not enter model context or repository files. A missing/mismatched credential or failed login ends the attempt without automatic retry.

Saved credentials grant no search, reconnect or additional battle allowance. Without `--saved-login`, the normal hidden terminal prompt remains available.

## Exclusive controller and deadline watchdog

Read `battle_status`/`battle_capabilities`, verify identity and claim one controller with `battle_control_claim`. Its opaque lease stays private and accompanies every socket mutation. Another owner blocks normal claims; takeover is explicit, generation-checked recovery, never automatic. Releasing clears the owner's fallback but does not stop the client.

Configure deadline protection only while idle and within existing authorization. The runner verifies its explicit policy and native preflight before searching. Observed server turn/bank time may shorten local caps; timer-on text alone establishes no numerical deadline.

The current CLI model-tool path returns a final complete pair directly; it exposes no separate staging command to the battle model. A low-level staged authored pair is control protection, not tactical approval or acceptance. Separately authorized emergency selection uses only fresh legality, never numerical prediction or automatic Mega Evolution, and records operational provenance. It cannot replace a reserved or uncertain send.

Normal local send, server acceptance and observed execution are distinct. Ordinary live choices do not receive a routine acceptance acknowledgment. Keep a sent choice reserved while the opponent plans; missing acknowledgment alone warrants no retry or forfeit.

## Enable the current battle timer

`battle_set_timer` explicitly requests the current owned child's timer. `battle_set_timer_policy` or startup `--battle-timer` enables the opt-in per-child hook. The hook publishes the actionable preview before requesting its timer; it preserves existing and uncertain requests.

Only actual numerical server observations can replace provisional unknown-clock limits. A timer request neither submits a choice nor changes the server clock, local authorization or current planning deadline.

## Failure and reconnect behavior

Choice binding includes session, exact team, room, request identity, legal menu and original deadline. Disabled moves, invalid targets, trapping, stale requests and mismatched ownership fail closed. A legal selection can still miss, fail or be denied during native execution.

The send is reserved before socket I/O. Reconcile uncertain writes without blind retry. A typed known-not-sent error may permit a fresh corrected request; an official child result can supersede a generated but unsent final. Preserve both evidence and temporal limits.

On runner attention, keep its existing process/owner and drain its recovery output before diagnosis. No automatic reconnect, alternate provider or extra search repairs a failure. A new login or interrupted-set recovery needs explicit authorization and the maintained recovery guards; never replay an outbound queue.

## Evidence, review and shutdown

The client records exact-team battle observations and bounded control traces privately. The runner retains model context, actual research returns and final decisions separately. Replay URLs alone do not recover private selections or prove a planned action executed.

After the official parent result and idle state, preserve each authorized replay and verify retrieval, flush metrics, complete the private decision/skill checkpoint and inspect bounded retention. The runner's review handoff may release its idle lease while leaving the client open. If so, the manager verifies that exact idle session and claims normal ownership without takeover before finalization/stop.

Use `battle_review_save`/`battle_review_status`; never write a completed status manually. Apply only explicitly reviewed retention with complete coverage, then call owned `battle_stop` and verify the client/terminal actually exited. Stop disconnects; it does not forfeit. Recheck the review fingerprint after shutdown for late evidence drift.

Full contracts: [BO3 cycle](../skills/champions-mc-matchups/references/headless-battle-cycle.md), [metrics and retention](../metrics/README.md), [simulator](../docs/SIMULATOR.md). The pinned Champions engine revision is recorded in `package.json`; changing installed source does not update an already running client.
