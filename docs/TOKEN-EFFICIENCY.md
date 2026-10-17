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

During authorized live play, prefer `battle_turn_status` for the current board and legal choices. It includes opposing open sheets at preview and omits full sheets and long history during normal turns. Use `battle_wait` with the last observed revision when waiting for progress; use full status or bounded control traces when a concrete issue needs diagnosis.

Stage or submit the complete legal paired choice before optional research and notes. Perform long historical analyses and full reviews between BO3s. Reuse applicable retained calculator evidence during review, but make a fresh MCP calculation when the battle inputs change; a result for another form, boost or field state is not interchangeable.

Keep required guidance in active context. Avoid repeatedly loading unchanged content unnecessarily within that context, but refresh it after a source change, MCP restart, expired read receipt or handoff that loses the complete instructions. Do not trim required guidance to a summary or skip evidence, calculations or the per-BO3 review just to reduce tokens. See the [startup guide](AGENT-STARTUP.md) and [required cycle](../skills/champions-mc-matchups/references/headless-battle-cycle.md).

## What is measured

The MCP server does not call a language model, and it currently records neither provider input/output tokens nor model cost. Protocol action tokens are request identifiers, not language-model tokens. Token accounting belongs to the agent host or provider response and can include instructions, tool schemas, repeated context, outputs and cached-token rules that this server cannot observe.

No end-to-end token-saving percentage or cost reduction has been measured for this project. Serialized response bytes are a useful payload-size measurement, but they are not an exact token count across models. To assess an optimization, compare equivalent questions and evidence coverage using the same model and host; record tool calls, response sizes, latency and actual host-reported usage when available. Quality and deadline outcomes should be compared alongside usage.

Possible future improvements include pagination for growing report sections and optional host-supplied usage telemetry. These are not implemented features.
