# Agent startup

The local MCP server supports analysis, calculations and reports. Automated live decisions use the supported Codex CLI workflow, with the official CLI's ChatGPT sign-in and no API-key fallback. See [installation](../README.md#install-and-connect), [CLI setup](../isolated/README.md) and [architecture](ARCHITECTURE.md).

## Connect MCP

Build the checkout and configure your MCP host to launch its stdio server:

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

Replace the path with this checkout. Analysis needs no Showdown login. Host project rules and skill discovery are separate from MCP; do not assume a host automatically reads repository instructions or skill metadata.

The optional trusted startup environment setting `VGC_COACHING_SKILLS_ROOT` selects the absolute parent of installed `champions-mc-matchups/` and `champions-mc-teambuilding/` folders. Otherwise the standard Codex skill location is used. Keep installed copies separate from maintained repository sources. Reload MCP after rebuilding or changing its environment.

## Read guidance and establish scope

| Task | Maintained guidance |
| --- | --- |
| Build, audit or revise a roster | [Team building](../skills/champions-mc-teambuilding/SKILL.md) |
| Preview, paired decisions or replay review | [Matchups](../skills/champions-mc-matchups/SKILL.md) |
| Authorized BO3 play | Matchups, its complete [BO3 cycle](../skills/champions-mc-matchups/references/headless-battle-cycle.md), and the [battle workflow](../showdown/AGENT-WORKFLOW.md) |

Use `battle_skill_status`, inspect reviewed sync differences, apply `battle_skill_sync` only when authorized, then call `battle_skill_read`. Read every required returned file completely. A file list, old summary or truncated display is insufficient. Receipts are private, content-bound and process-bound; use a fresh read after source changes, MCP restart or expiry.

The manager prepares the fixed team, battle allowance and compatible genuine saved-position qualification input. The battle model owns tactics and actual MCP research; the runner owns mechanical delivery and execution. Advice, stored credentials and successful qualification grant no extra search, roster change or replay publication.

## Analysis and replay review

1. Identify the exact immutable version with `team_metrics_list` and `team_metrics_agent_report`. Check cached sets, filters, cutoff, warnings and included/excluded counts.
2. Read relevant `team_metrics_game_evidence` and available open sheets, submitted choices and observed execution. Missing reserves and investments remain unknown.
3. Use actual MCP damage/Speed tools. Native Champions uses `gen: 0`, damage `evs` and Speed `statPoints`, each with `hp`, `atk`, `def`, `spa`, `spd`, `spe`. Validate the 66-point total and 32-point per-stat limits. No mental or direct-engine substitute establishes a numerical result.
4. Use [simulation](SIMULATOR.md) for a material unresolved paired sequence. Retain assumptions and source receipts; a finite conditional sample is not a guarantee.
5. Separate a local hypothetical improvement from a different game result. An approved roster revision is a new version, not an edit to past evidence.

Optional `evidenceContext` retains calculator inputs/results for later review. The live host binds it automatically. Report details and definitions are in [metrics](../metrics/README.md).

## Live admission

Use the public [CLI workflow](../isolated/README.md), not a separate chat-authored turn loop. Live mode requires:

- Explicit account/team/one-set authorization and an owned manual-ready client.
- A manager-prepared compatible bundle of complete genuine saved requests. A new checkout is immediately useful for analysis; it does not fabricate live qualification fixtures.
- Actual selected-model generation, model-requested MCP and material simulation/range checks, retained-session continuity and fresh-game reset under original clocks.
- Same-process qualified provider receipts. A saved JSON report, authentication check or small generation probe is not admission.
- Loaded source/schema/policy verification, synchronized guidance, prior native review and current `battle_preflight` before search.

Each game begins a fresh CLI thread with the full verified matchup folder. The model receives eight read-only battle research tools; host-only state/control fields stay private. Current and frozen work share three calculator invocations and one simulation trajectory per turn. Live spread inference is cache-only, preserving capacity for model-selected numerical questions.

Keep complete current facts and guidance within the 8 MiB packet bound while respecting the model's separate token window. On attention, drain the same owner's stream and use its prepared recovery contract; never retry an uncertain send or invent a clock extension.

## Complete the cycle

After every official BO3, including a win, forfeit and final set:

1. Verify the exact parent/children and idle state; preserve retrieval-verified replays and flush metrics.
2. Review actual decisions, positive plans, control failures and variance. Separate selected, sent, accepted, executed and defaulted actions.
3. Validate a supported reusable change with a counterexample, or record a specific no-change result. Keep team plans private; sync/read reviewed guidance changes.
4. Save with `battle_review_save`, verify `battle_review_status`, and complete bounded retention. Native checks validate evidence/adoption, not tactical correctness.
5. At batch end, stop the owned client normally and verify exit. Recheck review status after shutdown for late evidence drift before another authorized search.

The manager handles skill/source edits outside the live decision path. Unresolved control-compromising failures block another batch until repaired or covered by a validated mitigation. Offline fixes require fresh qualification and loaded adoption at a normal authorized startup; they do not justify an extra battle or login.
