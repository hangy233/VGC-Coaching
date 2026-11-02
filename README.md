# Pokémon VGC Coaching MCP

An interface made for agents to analyze Pokémon VGC and Champions teams, check
adjustments against battle history, and improve through battle reflection. This
local MCP server provides native damage and Speed checks, private team reports,
and authorized Pokémon Showdown BO3s through Codex CLI. The agent chooses the plan;
tools supply rules, calculations and retained evidence.

The default validation format is **Champions Regulation M-C**
(`gen9championsvgc2026regmc`). Other supported formats can be selected explicitly
for analysis. The live client and exact-team workflow target M-C doubles BO3.

## Install and connect

Use Node.js 24 or newer for the full battle workflow (package minimum 22.18.0),
npm and an MCP-capable agent host.

```bash
git clone https://github.com/hangy233/VGC-Coaching.git
cd VGC-Coaching
npm ci
npm run build
```

The build compiles the pinned Pokémon Showdown source and TypeScript server.
Configure your MCP host to launch the built stdio entry point:

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

Use your checkout's absolute path; Windows JSON paths can use forward slashes.
Reconnect MCP after rebuilding. Analysis and reports require no model API key,
Showdown login or battle. The server does not choose a model for an ordinary MCP
host; load the [coaching skills](#coaching-skills) in that host separately.

## What it does

| Area | Tools and evidence |
| --- | --- |
| Team analysis | Pokémon, move, item and ability data; learnsets, types, team classification and format-specific legality. |
| Metagame research | Smogon format/month/rating usage and Champions community rankings/set distributions, retaining source and period. |
| Numerical checks | `calculate_damage`, `calculate_damage_range` and `calculate_speed`, including native Champions points and explicit uncertainty coverage. |
| Paired mechanics | `simulate_choices` reconstructs one authored paired outcome; explicit `simulate_turn` and `simulate_turn_batch` support broader offline scenarios. |
| Private reports | Exact team versions, selections/leads, observed moves, denials, misses, KOs, item removals, matchup results and sample-quality warnings. |
| Evidence and review | Saved replay/log import, focused turns, calculator receipts, annotations, comparisons, HTML/CSV/JSON exports and versioned BO3 checkpoints. |
| Authorized play | A subscription-backed Codex CLI author, owned manual-ready local client, bounded research, replay preservation and mandatory review between sets. |

Ask an agent to audit a team, examine a recurring matchup, compare a proposed
nature or move against recorded opportunities, or explain what coverage a change
would lose. A calculated local improvement does not prove an alternate game
would have been won. Roster changes and live battles need separate authorization.

For Champions numerical work use **`gen: 0`**. Training allows at most 66 points
total and 32 per stat, level 50 and IVs 31. Damage inputs use `evs`; Speed uses
`statPoints`. Supply current form, ability, item, HP, boosts, status and field;
do not manually adjust an engine result. Unknown investment is a labeled domain
or hypothesis. Damage-range results distinguish complete evaluation from partial
sampling and include legal extrema witnesses. See [simulator inputs and limits](docs/SIMULATOR.md).

Native simulation uses the pinned Champions engine rather than another damage
formula. Clickable actions are not restricted by a mechanics whitelist. Missing
history or hidden state can require explicit conditional initialization; a
returned outcome is neither a guarantee nor a probability. Inspect assumptions,
ordered events and any pending replacement boundary before interpreting it.

## Create a private report

Register a complete legal team with `team_metrics_register_team`:

```json
{"teamFile":"teams/YOUR_TEAM.txt","name":"My M-C team"}
```

Keep the returned full `teamId`. Import an already saved replay with
`team_metrics_import_replays`:

```json
{
  "teamId": "FULL_TEAM_FINGERPRINT",
  "username": "REPLAY_OWNER",
  "urls": ["https://replay.pokemonshowdown.com/REPLAY_ID"]
}
```

This reads an existing replay; it does not publish a battle. Append more games
under the same immutable version. A changed move, item, nature or spread belongs
to a different version. Replay observations cannot establish unrevealed sets or
selected reserves.

Read `team_metrics_agent_report` with `includeGames:true` for review, then
`team_metrics_game_evidence` for decisive turns. For a quick overview start with
filtered `includeGames:false`, preserving cutoff, warnings, exclusions and
coverage. Use `team_metrics_compare` for matching-filter version comparisons.
See [metrics schemas and definitions](metrics/README.md) and the
[synthetic report example](docs/examples/TEAM-REPORT-EXAMPLE.md).

Observed move executions, submitted choices, failures, item removals and KOs are
different measurements. Incomplete, operationally affected and manually excluded
games are omitted from default performance, with reasons visible; an excluded
child also excludes its parent from default set results. Inclusive review keeps
official outcomes and operational evidence without treating them as clean team tests.

For the local dashboard and report CLI:

```bash
npm run metrics:view
npm run metrics -- list
npm run metrics -- review --team FULL_TEAM_FINGERPRINT --include-games
```

The viewer binds to loopback; `team_metrics_open_viewer` returns its verified
address. `team_metrics_export` creates standalone HTML, CSV or JSON snapshots.
Reports can contain private teams, player names and replay access links: inspect
them before sharing.

## Codex CLI battles

Automated battle authoring uses the official Codex CLI and its existing ChatGPT
sign-in. No API credential or paid-provider fallback is used. Install/sign in
through the official [CLI authentication guide](https://learn.chatgpt.com/docs/auth?surface=cli);
see [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
for the underlying CLI workflow. The launcher discovers `codex` on PATH, or accepts
`--codex-executable ABSOLUTE_PATH`.

A fresh checkout can analyze immediately. Live play also needs a manager-prepared
compatible bundle of genuine complete saved requests, an explicitly authorized
one-set scope, and the matching owned manual-ready client. The manager prepares
these inputs; a saved report or fabricated menu is not qualification evidence.
See the [CLI guide](isolated/README.md) for their contracts.

Run offline selected-model/MCP qualification without a battle client or login:

```bash
node isolated/launch.mjs --qualify-only --model-tool-qualification manager/saved-requests.json --output cache/manager-qualification
```

For an authorized set, run the interactive launcher:

```bash
node isolated/launch.mjs --run --model-tool-qualification manager/saved-requests.json --session manager/session.json --scope manager/scope.json --output cache/manager-run
```

The default profile is GPT-6.1 Sol / low reasoning / Fast / retained session
context. The launcher first performs genuine main and frozen-shadow qualification
in the same process. After successful qualification it waits for literal
`START_LIVE`; the manager starts the authorized matching client and supplies its
exact session/scope before releasing that gate. It then holds `START_SEARCH`
until loaded-source/tool-catalog, skill, review and native preflight checks pass.
Neither gate grants authorization. JSON output cannot recreate the opaque
in-process qualification receipts.

The local client uses `--manual-ready` with `manualReady:true` in scope and
verified `autoReady:false`; see [native client setup](showdown/README.md).
The battle model gets eight tools: four static lookups, three numerical tools and
`simulate_choices`. It chooses research, inputs, interpretation and final actions;
the runner supplies facts, full guidance and mechanical guards.

Live research shares **three calculator units and one simulated outcome per
battle turn**, including frozen waiting-time work. Range requests also charge
their actual nested numerical calls. The simulator uses cached historical spread
checks only, reserving numerical capacity for the model's explicit questions.
A replacement/retry does not reset limits. One paired outcome can continue through
its explicit replacement boundaries; it cannot branch into another pair.

Every game starts a fresh author thread with the complete verified skill folder,
fresh facts and legal menus. Later turns retain verified static references,
not silently shortened guidance. Required content and model token headroom are
checked separately from the 8MiB transport cap. An optional qualified shadow
can ponder while awaiting the opponent but has no action authority and shares
the same research budget.

The manager posts each actual child watch link promptly, reviews every completed
BO3, verifies saved replay links, syncs supported guidance and retains evidence
before another search. At the batch end, it normally stops the client, verifies
exit and rechecks the review fingerprint. A win or idle server is not a completed
review. See the [operator workflow](showdown/AGENT-WORKFLOW.md) and
[mandatory cycle](skills/champions-mc-matchups/references/headless-battle-cycle.md).

## Coaching skills

| Maintained source | Purpose |
| --- | --- |
| [Team building](skills/champions-mc-teambuilding/SKILL.md) | Roster, roles, sets, coverage and evidence-based revisions. |
| [Matchups](skills/champions-mc-matchups/SKILL.md) | Preview, paired decisions, mechanics, replay review and BO3 checkpoints. |

Install complete folders including references/metadata into the host's skill
directory, normally `$CODEX_HOME/skills` for Codex. The repository is the maintained
source. `battle_skill_status`, reviewed `battle_skill_sync` and
`battle_skill_read` compare, install and deliver current guidance. A trusted
`VGC_COACHING_SKILLS_ROOT` startup setting supports another installed-skill root.
See [agent startup](docs/AGENT-STARTUP.md).

Reflection is agent work, not model retraining. Supported reusable lessons get
scenarios and counterexamples; exact-team plans remain private. A specific
evidence-based no-change is valid. Control failures require runtime/operator
investigation and validation, not just skill wording.

## Data, privacy and development

Private evidence, exact sets, reports, receipts and reviews use ignored local
storage. New personal team exports are ignored; tracked examples remain public.
The catalog keeps ten most recently used exact versions. Eviction/deletion is
permanent local cleanup, with active/shared/unsafe sources retained as blockers.
Per-BO3 finalization instead retains useful compact evidence and removes only
verified closed disposable files. Remote replays are outside local deletion.

Use explicit format/period/rating for Smogon data. Champions community rankings
are a different population, not verified Showdown usage percentages or a
regulation mapping. Attribute [Pokémon Champions Battle Data](https://championsbattledata.com/api_guide)
and follow its [usage rules](https://championsbattledata.com/api-rules/); do not
permanently mirror restricted source data.

```bash
npm test
npm run test:metrics
npm run test:showdown
npm run test:isolated
```

Tests cover contracts and mechanics; they do not establish live ladder quality.
Rules use a deliberately pinned [Showdown snapshot](https://github.com/smogon/pokemon-showdown/tree/a5df8274e85b0889bf2a9b3422a08b39732374fc).
Review dependency/rule updates and both package files together.

Read [architecture](docs/ARCHITECTURE.md) for current responsibilities and data
flow, [engineering history](docs/learnings/WHY-THE-CLI.md) for the problems behind
the design, and [context efficiency](docs/TOKEN-EFFICIENCY.md) for measurement
limits. Team analytics draw inspiration from
[PASRS](https://devoncorp.press/resources/the-release-of-pasrs-7-0). This independent
community project uses Pokémon Showdown, `@pkmn` packages and `@smogon/calc`.

License: ISC.
