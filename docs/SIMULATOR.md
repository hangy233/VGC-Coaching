# Simulation and uncertain spreads

Use actual MCP `calculate_damage` and `calculate_speed` for numerical questions. Use a paired simulation when a consequential sequence remains unresolved: action denial, interacting attacks/support, entry effects, redirection or removal before retaliation. The model chooses the question and actions; the engine supplies mechanics.

## Live compact choices

The live author calls `simulate_choices` with one `ourActions` pair and one `opposingActions` pair. It does not supply a current-state snapshot, private source fields, tactical gates, seeds or alternative pairs. The host binds the fresh native source and assembles the locked team, published sheet and tracked history.

```json
{
  "ourActions": [
    {"type": "move", "slot": 1, "target": 1},
    {"type": "move", "slot": 4}
  ],
  "opposingActions": [
    {"type": "move", "slot": 1, "target": 2},
    {"type": "move", "slot": 4}
  ]
}
```

This is syntax, not a recommended pair: move slots and targets must match the actual current menus. Base move target metadata helps check an opposing hypothesis but is not its current legal menu. Spread, self and field moves generally omit a chosen target; conditional targeting still belongs to native validation.

The `native-choice-outcome-v1` result contains one conditional outcome: end board, consequential ordered events, action outcomes, stochastic events, assumptions and any pending replacement/actions. Read `turnComplete` and the replacement boundary before treating it as a finished turn. A returned sample is neither tactical approval nor a probability, exhaustive range or guaranteed KO.

Live current and frozen work share **three calculator invocations and one simulation trajectory per battle turn**. Replacement/reissued requests do not reset that allowance. Range queries count the outer call plus actual nested calculations. Failed or uncertain backend work remains spent; invalid arguments rejected before backend dispatch do not establish a calculation.

Historical spread filtering is **cache-only in live single-outcome mode**. Compatible source/runtime-bound checks can be reused; uncached inference is deferred without spending the model's calculator capacity. Deferred profiles remain assumptions, not validated opposing investments. The model uses available numerical calls for explicit questions that can change its pair.

## Known facts and conditional state

The script incrementally tracks observable effects, item loss, PP, field age and provable native history counters. Fresh own HP, moves and PP cannot be overwritten by hypotheses. Published nature remains fixed when known; hidden investments and unrevealed selected reserves remain labeled.

Choice admission follows fresh clickability and native legality. There is no move, ability or callback whitelist. A current copied move/ability can differ from registration; registration validation is a separate check. Native disabled moves, PP, traps and targets still apply. Binding preserves the authored move identity through remapped or forced singleton menus.

Exact reconstruction and legal action admission are separate. Hidden counters or receive gaps can require a conditional native world. Its `stateCoverage.assumptions` identifies every assumed or omitted field and selected initialized value. The engine's own effect initializers handle conditions; staging events remain distinct from executed-turn events, and known facts are restored. No separate damage formula or host tactical policy fills the gap.

Branch coverage, complete state reconstruction and turn completion are independent. A conditional sample cannot establish an unqualified material-proof pass. Invalid source/team identity, conflicting exact facts, cancellation and expired deadlines remain errors. Broader offline tools may return supported branches alongside explicit unavailable branches; they never silently change an authored pair.

## Pivots and continuations

Native pivots can interrupt a turn for a replacement. The result lists requesting sides, forced slots, legal entrants and remaining actions. A pause is a valid native result with `turnComplete: false`, not a finished attack sequence.

Up to four ordered `continuations` may be supplied in the original call for that same trajectory. Cover exactly the sides requesting replacement; omit a nonrequesting side instead of filling it with passes. Prefer a species name or stable identity. A numeric switch slot refers to the native replacement menu at that boundary, whose party order may have changed.

```json
{
  "continuations": [
    {"ourActions": [{"type": "switch", "species": "Politoed"}, {"type": "pass"}]}
  ]
}
```

Missing continuations leave a visible pause. Blocked/missed pivots create no replacement to force. The tool neither chooses an entrant nor offers a later resume call that creates another live outcome.

Confusion and other effects execute through native callbacks. Existing confusion uses the native action counter, not an invented turn duration; hidden counter ranges remain hypotheses. Unburden activation comes from audited item/ability/reset history, never an empty item slot alone. Unknown copied or suppressed state remains explicit. A sampled self-hit, critical hit, miss or secondary effect establishes no reliable favorable branch.

## Damage ranges

`calculate_damage_range` calls the registered native damage handler over labeled legal spread domains. Use `gen: 0`. A domain contains explicit candidate nature/point allocations, or nature choices and ranges for all six stats. Each point is 0–32 and the total is at most66; optional total bounds further constrain the domain. Hidden allocations are hypotheses.

```json
{
  "gen": 0,
  "attacker": "Torkoal",
  "attackerOptions": {"ability": "Drought", "item": "Charcoal"},
  "defender": "Blastoise",
  "defenderOptions": {"ability": "Torrent", "item": ""},
  "move": "Eruption",
  "attackerDomain": {
    "kind": "ranges",
    "label": "Unknown SpA; other points fixed",
    "natures": ["Modest"],
    "statPoints": {"hp": 0, "atk": 0, "def": 0, "spa": {"min": 0, "max": 32}, "spd": 0, "spe": 0}
  },
  "defenderDomain": {
    "kind": "candidates",
    "label": "One defensive hypothesis",
    "candidates": [{"nature": "Calm", "statPoints": {"hp": 32, "atk": 0, "def": 2, "spa": 0, "spd": 32, "spe": 0}}]
  },
  "field": {"gameType": "Doubles", "weather": "Sun"},
  "work": {"maxCalculations": 64, "requireExhaustive": true}
}
```

This example describes the broader offline range contract; it exceeds the live three-call allowance. Current HP is a separate `attackerHP`/`defenderHP` hypothesis: full, explicit values or an actual-HP range. The native engine keeps HP and complete allocations together; impossible HP is not clamped. HP-dependent moves require that distinction.

The result reports actual-HP `damageRange.min/max`, complete extrema witnesses and evaluated/unevaluated coverage. `coverage.exhaustive: true` means every assignment in the declared finite domain completed. A partial candidate envelope covers only evaluated witnesses and does not bound untested spreads. `requireExhaustive` refuses an oversized domain before work; unavailable candidates, the shared deadline and cancellation can still prevent complete coverage. Zero completed calculations produce an unavailable result.

## Offline evidence

`simulate_turn` and `simulate_turn_batch` expose broader explicitly authored native analysis; their schemas do not enlarge the live authoring contract or budget. Actual damage rolls remain the job of the numerical calculators.

Calculation receipts retain exact actual inputs/results privately, including source and assumptions. Compact archives may use lossless compressed storage with digest and byte-count checks. A refusal establishes no numeric sample. The maintained saved-capture replay helper verifies retained source/team/ledger bindings before actual MCP replay; missing historical sources cannot be reconstructed exactly.

Offline replay grants no live freshness, control, model qualification or battle allowance. See [architecture](ARCHITECTURE.md), [CLI workflow](../isolated/README.md) and [private metrics](../metrics/README.md).
