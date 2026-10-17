# Pokémon VGC Coaching MCP

An interface made for agents to **analyze Pokémon VGC and Pokémon Champions teams, check proposed adjustments against battle history, and give evidence-based team advice**. This local [Model Context Protocol](https://modelcontextprotocol.io/) server provides tools for team legality, usage data, damage and Speed calculations, replay analysis, private team reports, and Pokémon Showdown best-of-three coaching.

Use it to investigate a proposed team adjustment against previous battles, explain recurring matchup problems, or evaluate an approved team through a bounded battle session. Agents can also improve their play through battle reflection, carrying validated lessons into future decisions through maintained coaching skills. The tools supply data and evidence; the agent supplies the game plan and judgment.

The default validation format is **Champions Regulation M-C** (`gen9championsvgc2026regmc`). Live battle control targets its Showdown BO3 format. Pass an explicit supported format for other validation or Smogon usage requests; the live client and private team-registration workflow are built for M-C.

## What you can ask an agent

> Would changing Golisopod from Brave to Adamant have helped in this team's previous games? Find the relevant turns, check Speed with the MCP, and compare the benefits and costs under and outside Trick Room.

> Review this team's Archaludon matchups. Separate positioning mistakes, timing failures and variance from coverage problems. Recommend the smallest useful adjustment and explain what coverage it loses.

> Create a report for this team and append these saved Showdown replay URLs. Show each Pokémon's move usage, knockouts and successful item removals.

> Audit this team paste for M-C: legality, roles, speed control, likely leads, important damage benchmarks and unresolved matchups.

### Assessing an adjustment against battle history

The existing tools support this workflow:

1. **Find the exact version.** Use `team_metrics_list`, then read `team_metrics_agent_report` and its cached full sets. A move, item, nature or spread revision belongs to a separate team version.
2. **Find relevant opportunities.** Filter by opposing species, your selected Pokémon, outcome or date. Read sample sizes, refresh warnings and exclusions before interpreting rates.
3. **Reconstruct the position.** Read the cited turns with `team_metrics_game_evidence`, plus available open sheets, submitted choices and decision notes. Check actual selected reserves, current forms, status, boosts, weather and move order.
4. **Test the proposed change.** Use actual `calculate_damage` and `calculate_speed` calls with explicit inputs. State unknown opposing investments and unsupported conditions. Check both opponents' plausible actions, including Protect, switches and setup.
5. **Explain the tradeoff.** Identify positions the revision could improve, coverage or ordering it loses, and whether a better line already existed with the original team. Cite supporting games and distinguish a local improvement from a different game result.
6. **Evaluate an accepted revision separately.** Validate and register the revised six, then compare later samples through `team_metrics_compare` under matching filters. Changing the live team or starting battles requires the user's authorization.

This is **retrospective scenario analysis**. It can establish a calculated Speed-order change or a damage benchmark in a recorded position. It does not automatically replay an alternate battle, predict every opposing response, or prove that a revised team would have won. Legality, calculated feasibility and results from played games are separate kinds of evidence.

## Self-improvement through battle reflection

The battle workflow requires an agent-led review after every BO3 and before the next search. The agent uses retained battle evidence, decision notes, team reports and MCP calculations to examine both successful plans and mistakes, separating tactical decisions, team limitations, control failures and variance.

Supported reusable lessons are checked against relevant scenarios, written into the maintained coaching skills, then synced and read before further play. A review can also record a justified **no change** when the evidence does not support a new rule. Future decisions can draw on these lessons, and later reports can help assess whether they worked. See the [required review and skill-adoption cycle](skills/champions-mc-matchups/references/headless-battle-cycle.md).

The agent performs the reflection and guidance edits; the MCP provides evidence and checkpoint tools. This improvement loop persists knowledge in skills, reviews and reports. It does not retrain the underlying model or guarantee better battle results.

## Capabilities

| Area | Tools and behavior |
| --- | --- |
| Team legality and data | `validate_pokemon`, `validate_team`, Pokémon/move/item/ability lookups, type effectiveness and `classify_team`, using the installed data and pinned Showdown rules. |
| Metagame research | Smogon format/month/rating usage and movesets; Champions ladder rankings and set distributions, with source and period metadata. |
| Numerical checks | `calculate_damage` and `calculate_speed`, including native Champions points, current status and supported field effects. Optional calculator receipts retain actual inputs/results for reviews. |
| Private team analytics | Exact team versions, selections/leads, Mega use, executed moves, failures, misses, blocks, direct and attributed indirect KOs, observed item removals, matchup results and sample-quality flags. |
| Replay and report input | Automatic observation from the local battle client, saved log imports and saved replay URL imports. New games update the same team's report; reimporting the same game updates it without adding a duplicate. |
| Human and agent reports | Local HTML dashboard, CSV/JSON exports, agent JSON/Markdown briefs, focused retained turn evidence, annotations, cross-version comparisons and report-health checks. |
| Agent-operated BO3s | Terminal battle-log streaming and watch URLs, open sheets, structured legal choices, exclusive controls, staged fallback choices, bounded set allowances, replay preservation and versioned review checkpoints. |

Move usage counts **observed executions**, not every intended or submitted choice. Knock Off usage, successful item removal and a knockout are distinct measurements. Unknown selections and uncertain KO sources stay explicit.

Incomplete, operationally affected and manually excluded games are omitted by default. Their counts and reasons remain visible. An operationally affected or manually excluded child also excludes its whole parent BO3 from default set performance. Opt into those records when reviewing execution failures rather than silently treating them as clean team tests.

## Install and connect

Use **Node.js 24 or newer** for the full local battle workflow. The package's minimum supported version is Node.js 22.18.0; npm is required. Bring an MCP-capable agent/client separately.

```bash
git clone https://github.com/hangy233/VGC-Coaching.git
cd VGC-Coaching
npm ci
npm run build
```

The build compiles the pinned Pokémon Showdown source before the TypeScript server. Configure your MCP client to launch the built stdio entry point:

```json
{
  "mcpServers": {
    "vgc-coaching": {
      "command": "node",
      "args": ["/absolute/path/to/VGC-Coaching/dist/index.js"]
    }
  }
}
```

Replace the path with your checkout's absolute path. On Windows, a JSON path can use forward slashes, such as `C:/projects/VGC-Coaching/dist/index.js`. Reload the MCP connection after rebuilding to load server changes.

### Other models and MCP hosts

The server does not call a model API or require a particular model provider. Use an agent host that can launch a local MCP stdio server and follow its tool schemas. A different host may need its own MCP configuration and project-instruction setup; Codex skill discovery and UI metadata are not a portable instruction loader.

Follow the [model-neutral agent startup guide](docs/AGENT-STARTUP.md) to load current coaching guidance and choose analysis or authorized battle scope. If your host uses another installed-skill directory, set `VGC_COACHING_SKILLS_ROOT` in the server's startup environment to the absolute parent of the two installed skill folders. Without it, the existing Codex directory remains the default. This is trusted startup configuration, not an MCP tool argument. Live control also needs access to the same local workspace and terminal-owned client.

## Create a report and add games

Battle control and report tools are exposed by the **same MCP server**. A report can be used without signing into Showdown or starting a live battle.

Register a complete legal team from a workspace-local file, or supply the pasted export as `teamText`:

```json
{"teamFile":"teams/YOUR_TEAM.txt","name":"My M-C team"}
```

Call `team_metrics_register_team` with those arguments and retain the returned `teamId`. In the following examples, replace `FULL_TEAM_FINGERPRINT` with that full ID and `YOUR_USERNAME` with the owner shown in the replay.

To read existing saved replay URLs, call `team_metrics_import_replays`:

```json
{
  "teamId": "FULL_TEAM_FINGERPRINT",
  "username": "YOUR_USERNAME",
  "urls": ["https://replay.pokemonshowdown.com/REPLAY_ID"]
}
```

This fetches an already saved replay; it does not publish a battle. Append another game by importing its URL with the same team ID. Use the correct immutable version: a replay does not establish every unrevealed move, item, spread or reserve choice.

To get an agent-readable matchup brief, call `team_metrics_agent_report`:

```json
{
  "teamId": "FULL_TEAM_FINGERPRINT",
  "opponentSpecies": "Archaludon",
  "includeGames": true
}
```

Use `team_metrics_game_evidence` to inspect a supporting game's retained turns. `team_metrics_report` returns detailed measured observations; `team_metrics_compare` compares two version IDs. The complete schemas and import options are documented in [team metrics](metrics/README.md).

See the [synthetic team-report example](docs/examples/TEAM-REPORT-EXAMPLE.md) for actual report fields, sample-quality exclusions, move counts, item removals and evidence-linked review questions. Its observations are illustrative rather than results from a real team.

For a capable live client, `team_metrics_sync_battles` flushes and appends its observations outside action deadlines. Check recorder readiness and errors before treating the report as durable. Existing saved logs can instead be appended through `team_metrics_import`.

### Token usage and context efficiency

Start with a filtered agent brief using `includeGames: false`, then read cited games and relevant turn ranges. The game index and review signals are capped, and `maxEvidence` bounds supporting references. During live play, compact turn status and revision-based waits avoid repeatedly reading full state. Preserve complete required guidance, quality warnings and decisive evidence.

These controls reduce unnecessary context; they are not a hard token budget. The server does not measure model tokens or cost, and `includeGames: true` can still return a large report. See [token-efficiency guidance and limits](docs/TOKEN-EFFICIENCY.md) for request examples, measurement advice and remaining improvements.

### View or export

Call `team_metrics_open_viewer` to start or reuse the verified local viewer and receive its URL. You can also run it from the repository:

```bash
npm run metrics:view
```

The default address is `http://127.0.0.1:52615/`. The viewer binds to loopback and checks for updates. Each exact team has a stable HTML profile plus `.agent.json` and `.agent.md` briefs under `cache/team-metrics/reports/teams/`.

`team_metrics_export` produces standalone HTML, CSV or JSON snapshots. The CLI offers the same report/import workflow:

```bash
npm run metrics -- list
npm run metrics -- review --team FULL_TEAM_FINGERPRINT --include-games
```

## Champions calculations and usage sources

For native Champions numerical checks, pass **`gen: 0`** explicitly to `calculate_damage` and `calculate_speed`. Damage inputs use native points in `evs`; Speed inputs use `statPoints`. Stat keys are `hp`, `atk`, `def`, `spa`, `spd` and `spe`.

M-C uses at most 66 total points and 32 per stat, with level 50 and IVs of 31. Do not substitute ordinary 252-EV spreads, zero-Speed IV sets or Terastallization assumptions. Validation uses the string format ID `gen9championsvgc2026regmc`, independently of the calculator's numeric mode.

Supply the current form, ability, item, boosts and status. For example, `status: "brn"` lets the damage calculator apply burn; do not manually halve the result. The current damage schema exposes game type, weather, terrain and gravity, but not every simulator condition: Helping Hand, screens and current HP are not exposed. Mark a benchmark requiring unsupported state as unverified.

Generic move/movepool lookups can differ from Champions-specific rules. Validate complete sets and use the Champions rules data when the mechanics depend on an exception. See the [calculation and rules reference](skills/champions-mc-matchups/references/mc-rules-and-tools.md).

| Data source | Tools | Interpretation |
| --- | --- | --- |
| Smogon / Showdown ladder | `get_usage_stats`, `get_pokemon_usage` | Select `format`, optional `month` and `rating`. Omitted month discovers the latest published report; rating fallback is labelled. Missing M-C data is not replaced with another regulation. |
| Pokémon Champions Battle Data | `get_champions_usage_stats`, `get_champions_pokemon_usage` | Select `battleType`, optional `season` and `date`. The community provider supplies species ranks and species-specific set percentages, not overall species usage percentages or a verified Showdown regulation mapping. |

Keep the populations and resolved periods separate. Champions battle data is provided by [Pokémon Champions Battle Data](https://championsbattledata.com/api_guide), an unofficial community source. Follow its [usage rules](https://championsbattledata.com/api-rules/), including linked attribution in public output and limits on redistribution or permanent mirroring.

## Optional Showdown BO3 client

The lightweight client keeps one authenticated Showdown connection in a visible local terminal. The agent controls that same object through OS-local IPC; no browser battle UI is required. Strategy comes from the agent, and the client does not generate a battle policy.

After building, start a terminal session with an approved team and a bounded allowance:

```bash
npm run battle:session -- YOUR_USERNAME --team teams/YOUR_TEAM.txt --sets 1
```

On Windows PowerShell, use `npm.cmd` if required by your shell configuration. Enter the password directly into the hidden terminal prompt. Optional Windows Credential Manager login is documented in [saved-login setup](showdown/README.md#optional-windows-saved-login); the broker supplies authentication without exposing the password to the agent.

Login does not queue a battle. The controlling agent must claim exclusive control, configure deadline protection while idle, check guidance/review readiness with `battle_preflight`, and call `battle_start` within the user's authorized scope. Every fresh request needs a prompt complete legal paired choice; `battle_stage_fallback` can protect an agent-selected pair before optional analysis.

The terminal streams readable events and prints watch URLs for the set and each game. Automatic readiness advances games within the current BO3; another set requires a separate search. Replay publication is opt-in through `battle_set_replay_policy` or `--save-replays`, within the user's sharing authorization and the room's existing privacy.

After **every BO3**, including the final one, the agent must:

1. Verify the official parent result and all expected child games.
2. Preserve authorized replays, sync metrics and read the exact team's evidence.
3. Review decisions, useful counterexamples, control failures and variance separately.
4. Record a supported skill lesson or justified no-change result; verify skill sync and the actual `battle_review_save` / `battle_review_status` checkpoint.
5. Inspect and apply bounded retention. At the end of the authorized batch, stop the client and verify shutdown.

Preflight and review tools validate stored evidence and readiness; they do not prove tactical judgment or enforce the entire agent workflow inside `battle_start`. A successful local send, server acceptance and observed execution are separate facts. Missing routine acknowledgment alone is not a reason to resend or forfeit, and a local planning timeout is not proof of server expiry.

Rebuilding or restarting MCP does not update an already running battle client. Inspect `battle_capabilities` and use the loaded process's advertised features. See the [client setup/API](showdown/README.md) and [agent workflow](showdown/AGENT-WORKFLOW.md) for controls, recovery and lifecycle details.

## Coaching skills

| Maintained source | Purpose |
| --- | --- |
| [champions-mc-teambuilding](skills/champions-mc-teambuilding/SKILL.md) | Build/refine a six, assess roles and coverage, and evaluate proposed revisions against exact-team history. |
| [champions-mc-matchups](skills/champions-mc-matchups/SKILL.md) | Choose four, plan paired actions, review replays and run authorized BO3 cycles with a per-set review checkpoint. |

Install complete skill folders, including references and metadata, into your agent host's skill directory. For Codex this is normally `$CODEX_HOME/skills` or `~/.codex/skills`. The repository folders are the maintained source.

Agents can use `battle_skill_status`, `battle_skill_sync` and `battle_skill_read` to compare, install reviewed guidance and read the complete current files. Installation has a dry run and private backups; source editing and tactical validation remain deliberate review work. The matchup skill also provides a [manual sync helper](skills/champions-mc-matchups/scripts/sync-skill.mjs).

## Local data and retention

The private database, team snapshots, replay caches, calculator receipts, decision journals, BO3 reviews and generated reports live under ignored `cache/` paths. New personal exports under `teams/` are ignored too; previously tracked example teams remain versioned. Keep private replay access URLs out of commits and shared skills. Sharing a report can share its contained team, opponent names and replay links.

The catalog retains the **10 most recently used exact team versions**. Adding an eleventh permanently cleans the evicted version's report and owned data; explicit deletion uses the same cascade. Active writers, shared files and uncertain ownership remain visible blockers rather than being deleted unsafely. Deleted history is not a recoverable archive.

Per-BO3 cleanup is different: it retains useful compact battle evidence, results, reviews and calculations while removing only eligible closed disposable run files after verification. A replay URL alone cannot replace private selection and decision evidence. See [retention and deletion details](metrics/README.md).

## Development and documentation

```bash
npm test
npm run test:metrics
npm run test:showdown
```

`npm test` builds the project and runs the core, transport and metrics tests. Fixture tests do not establish live ladder performance. The build pins [this Showdown source snapshot](https://github.com/smogon/pokemon-showdown/tree/a5df8274e85b0889bf2a9b3422a08b39732374fc); update the rules deliberately and commit both package files when changing that dependency. `npm run update-data` updates the published Pokémon data/calculator packages and rebuilds, while preserving that Showdown pin.

| Documentation | Contents |
| --- | --- |
| [Team metrics](metrics/README.md) | Inputs, metrics definitions, filters, dashboard, agent reports, storage and cleanup. |
| [Showdown client](showdown/README.md) | Terminal login, saved login, local control and API. |
| [Agent battle workflow](showdown/AGENT-WORKFLOW.md) | Session setup, deadlines, evidence, review and batch shutdown. |
| [Required BO3 cycle](skills/champions-mc-matchups/references/headless-battle-cycle.md) | Per-set review, skill adoption and retention checkpoint. |
| [Repository agent instructions](AGENTS.md) | Expectations for agents working in this checkout. |

Team analytics are inspired by [PASRS](https://devoncorp.press/resources/the-release-of-pasrs-7-0), using this project's own parser and local reports. The server uses Pokémon Showdown, `@pkmn` packages and `@smogon/calc`; it is an independent community project.

## License

ISC.
