# Agent context and token efficiency

The server is designed for progressive evidence retrieval: start with a team summary, follow a few relevant game references, then inspect decisive turns. This limits repeated protocol and per-game data in the agent's context while keeping the evidence available locally. It does not impose a hard model-token budget.

## Start with a filtered brief

After identifying the exact `teamId` through `team_metrics_list`, call `team_metrics_agent_report` with a focused question:

```json
{
  "teamId": "FULL_TEAM_FINGERPRINT",
  "opponentSpecies": "Archaludon",
  "includeGames": false,
  "maxEvidence": 3
}
```

`FULL_TEAM_FINGERPRINT` is a placeholder for the full returned ID. Add `selectedSpecies`, `outcome`, `from` or `to` only when appropriate to the question. These filters change the sample, so retain their scope and denominators when reporting conclusions. Do not hide unfavorable games to make a revision look better.

Existing response controls:

| Control | What it limits | What it does not limit |
| --- | --- | --- |
| `includeGames: false` (default) | Omits the optional detailed `games` array | The report still includes exact sets when available, aggregate metrics and a game index |
| `maxEvidence: 1`–`20` (default `5`) | Supporting game/parent references per review signal | The measured sample, number of games, or total response size |
| Game index and review-signal caps | At most 20 index entries and 20 review signals, with coverage/truncation metadata | All other report sections; the caps are not a ranking of tactical importance |
| Matchup, selection, date and outcome filters | The population being summarized | A fixed number of bytes or tokens |

Some sections, including matchup aggregates, parent-set records and annotations, can grow with history. `includeGames: true` returns all included per-game observations; it is not paginated. A brief is smaller than its expanded equivalent but is not guaranteed to fit every host's context limit.

## Follow the evidence in stages

Read a cited game's decisive turn range with `team_metrics_game_evidence`:

```json
{
  "teamId": "FULL_TEAM_FINGERPRINT",
  "roomId": "battle-gen9championsvgc2026regmcbo3-1002",
  "fromTurn": 3,
  "toTurn": 5
}
```

The room ID above is illustrative; use one actually returned for your team. The turn bounds focus event and decision history, not every metadata field. Read earlier setup or the full game when the short range cannot establish weather, boosts, preserved reserves or the opponent's available options. Exact sets, quality exclusions, source refresh warnings and missing information remain part of the assessment.

Use the JSON brief or Markdown brief appropriate to the host, rather than loading both renderings of the same report. Keep large HTML/CSV exports for human review or local processing. Reference evidence by exact team/game/turn IDs in a compact working note instead of repeatedly copying entire logs. The [synthetic report example](examples/TEAM-REPORT-EXAMPLE.md) demonstrates these fields and their interpretation.

## Protect live decisions and required guidance

During authorized live play, the [CLI runner](../isolated/README.md) supplies the current board, legal choices and move-order evidence directly. A retained CLI session belongs to one game: its first decision receives complete guidance and sheets, and later decisions reference verified unchanged material while supplying current facts. A new game starts a fresh session. The manager does not relay every turn through chat.

The battle model requests actual MCP research and returns a complete legal pair within the original deadline. A turn shares at most three numerical calculator calls and one compact simulated outcome, including replacement calls. Automatic historical-spread inference uses compatible cached evidence only; it cannot silently spend the model's calculator budget. Full reviews happen between BO3s. A result for another form, boost or field state is not interchangeable.

Keep required guidance in active context. Avoid repeatedly loading unchanged content unnecessarily within that context, but refresh it after a source change, MCP restart, expired read receipt or handoff that loses the complete instructions. Do not trim required guidance to a summary or skip evidence, calculations or the per-BO3 review just to reduce tokens. See the [startup guide](AGENT-STARTUP.md) and [required cycle](../skills/champions-mc-matchups/references/headless-battle-cycle.md).

## What is measured

The MCP server performs calculations and evidence work; the CLI is the model host. The runner records decision boundaries, tool durations, prompt sizes and CLI-reported usage when available. Optional local telemetry captures allowlisted timing and usage fields. Missing provider measurements remain unknown. Protocol action tokens are request identifiers, not language-model tokens.

Serialized bytes are useful payload measurements, not exact model-token counts. The configurable input-byte cap and transport-output allowance protect local handling; neither enlarges the model's token window. Stream headroom must cover returned tool results as well as the prompt. One compact simulator trajectory limits output growth without claiming to cover every plausible branch.

Compare the same saved positions, model settings, required checks and evidence coverage when assessing latency or context changes. Report model-host time separately from local assembly and actual MCP execution; unexplained time is not automatically reasoning time. Include deadline failures and decision quality. A smaller response, one fast turn or a winning set does not establish a general speed or cost improvement.
