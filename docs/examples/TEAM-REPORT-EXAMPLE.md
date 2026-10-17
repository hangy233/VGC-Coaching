# Example team report for agents

**Synthetic, abridged demonstration.** All outcomes, counts, identifiers and opponent labels below are invented. The zero-filled team ID is a placeholder; the synthetic game IDs cannot be fetched. This is not a legal team recommendation, a real battle record or a report to import.

The excerpts were produced by the current [`buildAgentReport`](../../metrics/agent-report.mjs) generator using synthetic observations, then reduced to selected fields. The real tool returns the complete schema, all six Pokémon rows, definitions, limitations, a bounded game index and review signals. It can also include per-game observations.

## Scope, sample and exclusions

```json
{
  "kind": "vgc-team-agent-report",
  "schemaVersion": 1,
  "team": {
    "name": "Synthetic demonstration",
    "format": "gen9championsvgc2026regmc",
    "teamId": "0000000000000000000000000000000000000000000000000000000000000000",
    "teamSheet": {
      "status": "missing-snapshot",
      "pokemon": [],
      "note": "The roster names are known, but exact sets were not supplied. Do not infer moves, investments, items, abilities, or nature."
    }
  },
  "scope": {
    "includedGames": 3,
    "filters": {
      "teamId": "0000000000000000000000000000000000000000000000000000000000000000",
      "opponentSpecies": null,
      "selectedSpecies": null,
      "outcome": null,
      "includeIncomplete": false,
      "includeOperational": false,
      "includeManuallyExcluded": false,
      "from": null,
      "to": null
    }
  },
  "totals": {
    "games": 3,
    "wins": 2,
    "losses": 1,
    "winRate": {
      "numerator": 2,
      "denominator": 3,
      "percent": 66.66666666666666
    },
    "sets": {
      "played": 1,
      "wins": 1,
      "winRate": {
        "numerator": 1,
        "denominator": 1,
        "percent": 100
      }
    }
  },
  "quality": {
    "storedGames": 4,
    "includedGames": 3,
    "excludedOperational": 1,
    "excludedTotal": 1
  }
}
```

This example deliberately has no registered set snapshot. The report says so instead of guessing moves, training, items or nature. Normal registered-team reports include the verified complete snapshot. Numerical team-change advice must wait until the exact sets and relevant battle states are known.

## Move execution and item removal

```json
{
  "species": "Golisopod",
  "selectedGames": 3,
  "rates": {
    "selection": {
      "numerator": 3,
      "denominator": 3,
      "percent": 100
    }
  },
  "couldNotAct": 1,
  "moves": [
    {
      "move": "Knock Off",
      "uses": 5,
      "calledUses": 0,
      "itemRemovals": 2,
      "rates": {
        "usage": {
          "numerator": 5,
          "denominator": 10,
          "percent": 50
        },
        "itemRemovalsPerUse": {
          "numerator": 2,
          "denominator": 5,
          "value": 0.4,
          "unit": "confirmed-item-removals/use"
        }
      }
    }
  ]
}
```

Here Golisopod has five executed Knock Off uses and two confirmed item removals. Those are different metrics: a move use need not remove an item. Its 50% usage share means five of Golisopod’s ten observed move announcements, not five of all team actions or five of all games. A could-not-act event does not reconstruct which move was intended.

## Evidence-linked review question

```json
{
  "id": "losses-with-archaludon",
  "kind": "review-question",
  "observation": "1 losses were observed among 2 included games with Archaludon present on the opposing roster or positively observed. Presence is not proof of selection or a cause of the loss.",
  "question": "Review lead plans, known opposing selections, and paired actions in these losses before proposing matchup guidance or team changes.",
  "evidence": {
    "scope": "included-games",
    "matchedGames": 1,
    "gameIds": [
      "synthetic-game-2"
    ],
    "parentIds": [
      "synthetic-bo3-1"
    ],
    "matchedParents": 1,
    "truncated": false
  }
}
```

This is a question to investigate, not an automatic diagnosis that Archaludon caused the loss. Opposing roster presence does not establish selection. In a real report, use the cited game IDs with `team_metrics_game_evidence` to retrieve the relevant turns and inspect sheets, private decisions when available, field state and plausible paired actions. Verified saved replay URLs appear in game rows; this fixture intentionally supplies none.

## What an agent should conclude

- The included sample is three games from one played set: two game wins, one loss and one set win. Four stored games do not mean four usable performance observations. The operational game and its affected parent remain excluded.
- Five Knock Off uses and two removals warrant an opportunity review; they do not establish that another move would be better.
- One win and one loss with Archaludon on the opposing roster is too little evidence for a causal matchup claim. Inspect the turns before choosing a proposed adjustment.
- A proposed nature, move or roster change needs the exact registered sets plus actual MCP damage and Speed calculations. The report does not simulate alternate battle outcomes.

## Read only the detail needed

Start with `team_metrics_agent_report` using `includeGames: false` and a small `maxEvidence` (default 5). Apply opponent, selected-species, outcome or date filters when the question permits. Fetch focused turn ranges with `team_metrics_game_evidence` for the cited games, then request only the calculations needed to test the hypothesis.

The default brief omits full per-game Pokémon rows, caps the game index at 20 and caps review signals at 20. Coverage fields disclose truncation; `maxEvidence` limits references per signal, not the sample used for aggregate metrics. `includeGames: true` returns the included per-game observations and can be much larger. These controls reduce repeated context, but they are not a token counter, a hard model-token budget or proof that every response is small. Keep a short handoff linking exact team/game IDs and fetch detail when needed.

See the [report workflow](../../metrics/README.md#reading-reports-as-an-agent) and [main README](../../README.md).
