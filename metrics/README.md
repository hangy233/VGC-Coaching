# Private team metrics

A local battle notebook inspired by [PASRS 7.0](https://devoncorp.press/resources/the-release-of-pasrs-7-0). This implementation records descriptive metrics from saved Showdown protocol events. It does not reproduce every PASRS feature or upload your records.

The reference workbook has 27 tabs and uses the `REPLAYTODATA` Apps Script function to bring replay data into Google Sheets. That script is not included in its XLSX export. This tool provides its own local protocol parser and report workflow, including direct knockout and item-removal attribution. Dashboard filters recompute the summary, Pokémon and move tables together.

## What is counted

- Exact team versions have separate fingerprints, so move, item or spread changes do not silently mix samples.
- Save a team before its first game, then add results to that exact version. The 10 most recently used versions stay active. Capacity eviction permanently cleans the oldest team's report and owned data. Active writers, shared files and uncertain ownership block unsafe removal and remain visible as pending cleanup. Listing teams does not change their order.
- Games and sets: wins, losses, ties, unknown results and sample sizes. Win rates use wins divided by wins plus losses; ties and unknown results remain separate.
- Each Pokémon: selections, leads, win rate when selected, switch-ins, faints, inability to act, direct knockouts, attributed indirect knockouts and observed item removals.
- Mega use counts only an observed Mega Evolution; having a stone or registering a Mega form does not count. Mega games and win rates appear separately from team selection.
- Unordered lead pairs: games, outcomes and win rate, using only games with two distinct observed leads.
- Each move on each Pokémon: executed uses, called uses (such as a move invoked by another move), failed, missed and blocked outcomes, direct knockouts and observed item removals. For example, distinguish Golisopod's Knock Off uses from successful item removals and from its knockouts.
- Opponent species matchups, with game-level filters for opponent roster, your selection, result and date.

An executed use is a protocol move announcement. A submitted choice, a rejected choice, a forced default or a Pokémon unable to act is not automatically a move use. Failed, missed and blocked outcomes can overlap uses and each other; do not sum them as independent turns. A spread move is one use even when it hits two targets.

Selection and leads come from the private team-selection evidence when available. Unknown reserve choices stay unknown; a fainted or switched Pokémon is not sufficient evidence of the entire selected four. Uncertain KO attribution remains unassigned rather than being guessed. Weather, recoil and other indirect damage do not become direct move KOs.

Incomplete and operationally compromised games are excluded by default. Their exclusion counts remain visible; opt in explicitly when investigating client behavior. If any stored child game is flagged operational, its whole parent set is excluded from the default set win rate, including when another child was played cleanly. These are observations from your games, not controlled estimates of a team's strength.

## MCP tools

After rebuilding and reloading the MCP server, use:

| Tool | Purpose |
| --- | --- |
| `team_metrics_list` | List stored team versions and sample sizes. |
| `team_metrics_register_team` | Create a report from inline `teamText` or a local `teamFile`, returning its exact version ID. |
| `team_metrics_delete_team` | Preview or permanently delete an exact team's report and owned data, with explicit retained files and blockers. |
| `team_metrics_sync_battles` | Append/update the existing client's observed games, await local recording, and return its report and recording status. |
| `team_metrics_import` | Import saved local logs using owner username, a saved team ID or team export, and optional result ledger. |
| `team_metrics_import_replays` | Read existing Showdown replay URLs and add their metrics to a saved team ID or supplied team export. |
| `team_metrics_report` | Return the team's aggregate metrics and included game summaries. |
| `team_metrics_agent_report` | Return a compact AI review brief with the exact team snapshot, denominators, exclusions, descriptive signals and supporting game references. |
| `team_metrics_game_evidence` | Read focused turns from a game's retained compressed evidence, including available choice/selection observations. |
| `team_metrics_finalize_bo3` | Retain a completed set's useful evidence, attach verified replay links, and dry-run or apply bounded cleanup after its review checkpoint. |
| `team_metrics_export` | Save a standalone HTML dashboard, CSV or JSON report. |

Report filters are `teamId`, `opponentSpecies`, `selectedSpecies`, `outcome`, `from`, `to`, `includeIncomplete` and `includeOperational`. Omit `teamId` only when exactly one active team exists. Filters recompute the report, including its sample sizes. List results expose active status, last-used order, capacity and profile links. `pendingCleanupTeams` lists deletions already in progress; `includeArchived: true` also exposes capacity evictions whose cleanup could not begin because of blockers. Purged teams are not recoverable archives. Imports require exactly one of `teamId` or `teamFile`; registration requires exactly one of inline `teamText` or local `teamFile`. Imported files must resolve inside the workspace. No metrics tool authenticates, queues a battle or reads saved credentials. Confirmed BO3 finalization can request replay saving through the existing signed-in battle client when `saveReplays: true`; it preserves the room's current privacy.

Battle control, report creation, append/import and report queries are registered together in this repository's MCP. For a new team, call `team_metrics_register_team` with its pasted Showdown export as `teamText`; keep the returned `teamId`. Registration never changes the terminal client's locked team. After a game or BO3 on an updated client, call `team_metrics_sync_battles({teamId: LOCKED_TEAM_ID})` outside action deadlines. This flushes the observer's buffered games and official results, then returns the current report and stable human/agent paths. Repeating it updates the same game identities. A different requested ID is rejected before syncing.

`battle_status.metrics` exposes recorder readiness, pending work, last successful save and safe persistence errors. Sync waits at most 25 seconds; failure or timeout does not confirm durable recording, and logs must be retained. It retries failed replay attachments by reading their previously verified official saved URLs; it performs no replay upload or battle action. After authorized `battle_save_replays`, sync and check each report row's verified replay link; a save response alone does not confirm report attachment. If the recorder is disabled, unavailable or from an older running client, use the existing local-log or replay-URL import tools instead. Source changes never reload a signed-in process.

Register or import your legal team export once. A validated immutable snapshot is saved under `cache/team-metrics/teams/<teamId>.txt`. Later imports can use that saved ID with a replay URL or local log; you do not need to paste or export the team again. Editing the original file does not change the cached version. A changed move, item or spread belongs to another exact team ID.

Imports remember their local source paths by default. List/report/agent-report/export refresh those logs before reading metrics, so an already open client that appends its event log can contribute new games without a login or client restart. Refresh failures appear as warnings; they do not silently erase existing records. Use `remember: false` in MCP or `--no-remember` in CLI to avoid registering a source.

Sessions started with the updated lightweight client's `runSession` record private summaries automatically and expose recording status/sync through MCP. An older open client's source is unchanged; its remembered logs still refresh when queried. Automatic recording is observation-only and never starts or extends a battle batch.

## Reading reports as an agent

Use `team_metrics_list` to identify the exact team version, then call `team_metrics_agent_report` with its full `teamId`. It returns structured JSON suitable for an agent's context, with the immutable registered sets where available, provenance and data-quality limits, explicit metric definitions and denominators, and descriptive review signals linked to supporting games. `includeGames: true` adds per-game observations; `maxEvidence` limits the references per signal to 1–20 (default 5). The normal report filters apply, so an agent can request a second brief for an opponent species or a selected Pokémon without mixing team versions.

For example:

```json
{"teamId":"FULL_64_CHARACTER_TEAM_FINGERPRINT","opponentSpecies":"Archaludon","includeGames":true,"maxEvidence":5}
```

The stable profile also maintains `cache/team-metrics/reports/teams/<teamId>.agent.json` and `<teamId>.agent.md`. These files are refreshed with the full default report as games arrive. The JSON is the structured interface; the Markdown is a compact review that can be read directly alongside a skill. A filtered tool response describes that filtered sample; the stable paths continue to describe the full default sample.

With the local viewer running, `/api/agent-report?team=<teamId>` serves the structured report with current source-refresh results; `/agent-report.md?team=<teamId>` serves readable notes. Both are linked from the dashboard. Saved-file timestamps identify the stored data cutoff; they do not prove a successful current refresh. The report states when raw turns, decision evidence or the verified full team snapshot are absent.

Agent review workflow:

1. Confirm the exact team, sample size, filters and source-refresh warnings. Compare clean games with operational exclusions when diagnosing the client; avoid treating excluded games as team-performance evidence.
2. Treat low move use, matchup results and other signals as questions to investigate. Consult the cited game IDs, saved protocol turns, decision records and open sheets before explaining why a play succeeded or failed. Use `team_metrics_game_evidence` for focused turns after original logs have been retired. A move announcement measures an executed use, not a selected or accepted choice; missing observations stay unknown.
3. Use actual MCP `calculate_damage` and `calculate_speed` for numerical checks. The metrics report calculates descriptive rates and counts, not battle damage, speed benchmarks or alternative-play outcomes.
4. Update the matchup skill only after its required evidence review and scenario validation. Propose roster changes through the team-building workflow using the registered sets and relevant matchups. Reading a brief never edits a skill, changes the live team, starts a battle or authorizes any of those actions.

Reports describe the recorded sample and do not prove that a move, lead or team member caused a result. Skill checkpoints should cite the supporting game IDs and distinguish observed facts from a proposed explanation.

## Replay links and cleanup after each BO3

With the user's replay-saving authorization, `battle_save_replays` requests each completed owned child's saved replay from Showdown and verifies the returned URL and completed log. Supply the ended parent as `room`, `confirmed: true` and a unique `commandId`; reuse the ID after an uncertain reply. This preserves the rooms' existing privacy and does not start another set. BO3 finalization attaches confirmed links to the Games table and machine-readable records; missing or failed replay states remain explicit rather than using guessed URLs. A live battle watch URL is separate from a saved replay. The currently open older client receives the transport operation on its next normal deliberate start; its present connection and authentication stay unchanged.

After reading the new set's exact-team report, complete its private decision review and skill-sync checkpoint, including `expectedChildIds`. Then call `team_metrics_finalize_bo3` with `teamId`, `parentId` and `checkpointFile`. Explicit `sourceFiles` identify source logs to archive; `cleanupFiles` identify disposable closed run artifacts. While a client remains open, `closedFiles` must list only candidates whose short-lived writer closure the operator observed. That attestation cannot override active-path or shared-source protection. The default `dryRun: true` never uploads, writes evidence or deletes. With `confirmed: true` and `dryRun: false`, it may save replays when `saveReplays: true` and apply only verified cleanup candidates. Existing user authorization covers this workflow; the dry run is a reviewable plan, not another password or battle prompt.

Useful data remains local: the metrics database and per-game observations, immutable team sets, official results, the private decision/skill checkpoint, compressed canonical per-game evidence under `cache/team-metrics/evidence`, verified compressed replay logs, and current dashboard/agent reports. `team_metrics_game_evidence` reads a retained game's observations by `teamId` and `roomId`, optionally restricted with `fromTurn` and `toTurn`. Private selection and choice evidence can therefore survive source-log cleanup. Public replay logs alone do not contain everything needed for a decision review and are not the only backup.

Cleanup preserves originals when a replay is unavailable, durable evidence fails verification, a review is incomplete, or a room in the source lacks retained reviewed evidence. Same-room additional turns, choices or open sheets also block deletion unless covered by the canonical archive. Active client logs, current controls, IPC descriptors, teams, database files and their sidecars, calculations, reviews, backups, opaque JSON files and manual report exports remain protected. Never stop a signed-in client merely to make an open log deletable. Candidates are explicit regular generated `.jsonl`, `.log` and temporary files under `cache/bo3-runs/CANONICAL_PARENT_ID/`, not arbitrary cache contents. There is no recursive cache wipe or wildcard deletion.

Registered shared sources always remain protected by this cleanup tool and require a separate all-set audit. Do not remove their registrations to bypass protection. New per-set source imports intended for cleanup should use `remember: false`; the direct recorder is another input path. Cleanup results record retained/removed paths and blockers. The existing active shared logs are therefore retained rather than deleted as part of one set's cleanup.

Full private replay URLs can grant access to a private battle. They stay in ignored local records and private reports; sharing an export also shares those contained links. Shared skills retain anonymized lessons and game references without access suffixes.

## Deleting a team report

Team deletion is a permanent cascade, distinct from the per-BO3 cleanup that keeps useful review evidence. `team_metrics_delete_team({teamId: TEAM_ID})` returns a dry-run plan without deleting files. Apply the inspected plan with the same ID, `dryRun: false` and `confirmed: true`. Capacity eviction uses the same cascade for the least recently used team when an eleventh active version is added.

The cascade includes the team's catalog and import signatures, game summaries, compressed state and replay evidence, cached team export, HTML and agent reports, generated manual exports, remembered-source registrations, and exclusively owned closed source logs and review checkpoints. A replay cache shared with another team version remains for that other report. The original user-maintained team export and unrelated workspace files are preserved.

An active signed-in session using the team blocks deletion; the tool never closes that client. Shared logs, unsafe paths, unknown ownership and files that change during cleanup remain listed with their reasons. `complete: false` means related data remains; do not treat the report as fully cleaned. Resolve those specific blockers and retry. `team_metrics_list` and CLI `list` expose started deletions in `pendingCleanupTeams`; `includeArchived: true` or CLI `--include-archived` also includes capacity evictions whose cleanup has not started. These states remain visible instead of silently accumulating recoverable archives.

A deleted team cannot be recreated by background imports, old remembered sources or an ordinary report query. Supplying the complete legal team again through explicit registration creates a new empty report; it does not recover deleted battle history. All deletion is local: previously published Showdown replays and copies shared outside this workspace are unaffected.

## Supported imports

- Client `.jsonl` event streams: protocol events, private requests used to establish your own selected four, and observed team sheets.
- Saved raw `.log` or `.txt` Showdown protocol: `|player|`, `|move|`, damage and result lines. `>battle-room-id` headers identify rooms; otherwise the filename must supply the room ID.
- Saved replay `.json` files containing an `id` and protocol `log` string. Import an already saved file; no replay is fetched or published.
- Existing URLs on `https://replay.pokemonshowdown.com/`, supplied to the replay import tool or CLI `--url`. Only the supported replay data endpoint is fetched. This reads an already saved replay and never publishes one. Verified completed replay links and compressed evidence are saved in private game metadata and reports; this includes private access suffixes. Source-cache protocol and evidence omit those suffixes. No URL polling source is registered.

Every import requires the owner's username and exactly one of a saved team ID or a complete legal six-Pokémon M-C team export. The saved ID resolves the full validated snapshot, including moves, items and training; catalog names and rosters alone are not used to reconstruct a team. Supply a result ledger when available for official parent-set outcomes and operational flags. One import accepts 1–20 files or URLs. Reimporting the same room/team updates its summary without adding another game. A partial import cannot replace stronger complete observations.

Replay imports require the correct team version; an unknown spread or item is not filled in by assuming that the only saved team was used. Public replays may lack private selection evidence, so unseen reserves remain unknown.

## New games and current reports

Each version has a stable HTML profile under `cache/team-metrics/reports/teams/<teamId>.html`. Registration creates it with zero games. New saved games and imports rebuild that same profile; opening a report also refreshes it. Updates use the room/team identity to change an existing game rather than append a duplicate. An actual newly recorded game marks its team recently used; routine background refreshes do not rotate the active 10.

The local viewer offers team selection and checks for updated metrics every 10 seconds:

```powershell
node metrics/viewer.mjs --port 52615
```

Open `http://127.0.0.1:52615/` while that viewer is running. Each team's `viewerPath` selects its version. It binds to loopback for this computer. A standalone exported HTML/CSV/JSON file is a snapshot; create another manual export when you want a new shareable snapshot. Stable profiles and the viewer show additions without creating a new report filename each time.

## Command line

Run from the repository:

```powershell
node metrics/cli.mjs import --file cache/saved-battle-events.jsonl --username YOUR_USERNAME --team-file teams/YOUR_TEAM.txt --ledger cache/results.json --name "My team"
node metrics/cli.mjs register --team-file teams/YOUR_TEAM.txt --name "My team"
node metrics/cli.mjs list
node metrics/cli.mjs import --url https://replay.pokemonshowdown.com/REPLAY_ID --username YOUR_USERNAME --team FULL_TEAM_FINGERPRINT
node metrics/cli.mjs import --file cache/another-game.jsonl --username YOUR_USERNAME --team FULL_TEAM_FINGERPRINT
node metrics/cli.mjs list --include-archived
node metrics/cli.mjs report --team FULL_TEAM_FINGERPRINT
node metrics/cli.mjs report --team FULL_TEAM_FINGERPRINT --opponent-species Archaludon
node metrics/cli.mjs review --team FULL_TEAM_FINGERPRINT
node metrics/cli.mjs review --team FULL_TEAM_FINGERPRINT --opponent-species Archaludon --include-games --max-evidence 10
node metrics/cli.mjs export --team FULL_TEAM_FINGERPRINT --format html --output rain-review.html
node metrics/cli.mjs export --team FULL_TEAM_FINGERPRINT --format csv --output rain-review.csv
node metrics/cli.mjs delete --team FULL_TEAM_FINGERPRINT
node metrics/cli.mjs delete --team FULL_TEAM_FINGERPRINT --confirm
```

Use `--file` repeatedly for several logs or `--url` repeatedly for several replay URLs; these inputs cannot be mixed in one import. Replay imports do not remember URL sources. `--workspace` defaults to this repository. `--from` and `--to` accept ISO dates or timestamps. Reports include exclusions and unknown information rather than silently treating it as a loss or zero selection.

The HTML dashboard works offline. It shows overview, Pokémon, Mega use, lead pairs, moves, matchups and games. Its opponent/outcome controls recompute every displayed aggregate and table from the included per-game metrics. Base export exclusions remain visible; use the MCP/CLI to change inclusion rules or date/selection filters. Older exports without per-game metrics explicitly fall back to game-table filtering. CSV uses one header and a `section` column for summary, set, quality, Pokémon, move, lead-pair, matchup and game rows, preserving the metric and denominator explicitly.

## Storage and safety

Metrics live in `cache/team-metrics`. Manual exports are new files directly under `cache/team-metrics/reports`; an existing manual export is never overwritten. Automatically maintained per-team profiles use the separate `reports/teams` directory and update in place. Export paths reject traversal and symbolic links/junctions. HTML embeds escaped data and loads no remote scripts or assets. CSV cells neutralize formula-like strings. Share exports only when you intend to share the contained teams, opponent names and battle results.

The SQLite catalog, `cache/team-metrics/catalog.sqlite`, maintains team identities, the ten-team LRU and import signatures across restarts. Per-game JSON summaries retain the measured observations until the team's report is deleted or evicted. Concurrent writers serialize updates to the same game; unchanged imports and background polling do not change the team's recency. Capacity cleanup removes owned files and catalog data rather than retaining an archive; active/shared-file blockers remain explicit. Deletion markers prevent old observations from silently rebuilding a deleted report.

The metrics tool does not calculate damage or Speed and does not replace the matchup skill's per-set decision review. Agent briefs support that review through measured observations and traceable references; they never apply skill or roster changes automatically. Existing signed-in clients require a deliberate reload to adopt changed source; building this tool does not itself change a live session.
