# Evidence-based team analysis

Use the connected server's schemas as the call contract. The examples below
describe the repository's current interface; tool availability and returned
limitations determine what is actually verified.

## Audit a team and research usage

Read the user's supplied paste and requested format first. For Champions M-C,
read `battle_skill_read({"skill":"champions-mc-teambuilding"})` and its required
rules reference. Call `validate_team` with `team` containing the complete
Showdown export and `format: "gen9championsvgc2026regmc"`. For another supported
format, pass its explicit ID and identify guidance or calculation limitations.
Live control and private team registration are M-C workflows.

For a pasted-team audit with no recorded history, work from the supplied sets
and skip the history section. Do not register a report merely to audit a paste;
save one when the user's task requests it. State that battle-performance claims
are unavailable without supporting games.

Use Pokemon, move, item, ability, movepool, and type tools to investigate actual
roles and proposed changes. Search results alone do not establish legality.
Generic `get_move` and `get_movepool` data can differ from Champions-specific
rules; check the specialized rules reference and validate the complete set before
recommending it. Do not apply `gen: 0` to every generic lookup. A playstyle tag
from `classify_team` is a starting point, not evidence that six Pokemon have a
workable lead, back pair, or matchup plan.

Keep these metagame sources separate:

| Source | Tools and inputs | Interpretation |
| --- | --- | --- |
| Smogon / Pokemon Showdown | `get_usage_stats`, `get_pokemon_usage`; explicit `format`, optional `month` (`YYYY-MM`) and `rating`; species detail requires `pokemon` | Retain the resolved month, actual rating cutoff, source URL, and any fallback. An omitted month discovers published data; missing M-C data is not another regulation's usage. |
| Pokemon Champions ranked ladder | `get_champions_usage_stats`, `get_champions_pokemon_usage`; `battleType`, optional `season` and ISO `date`; species detail requires `pokemon` | Preserve resolved snapshot metadata. Species ranks are not overall usage percentages; set percentages are within the species. The provider supplies no verified Showdown-regulation mapping. |

Champions data comes from the unofficial
[Pokemon Champions Battle Data](https://championsbattledata.com/api_guide).
Retain linked attribution in public output and follow its
[API usage rules](https://championsbattledata.com/api-rules/), including limits
on raw-data redistribution and permanent mirroring.

## Find the exact history

1. Use `team_metrics_list` to identify the complete `teamId` fingerprint.
   Different moves, items, natures, or spreads belong to different versions.
2. Call `team_metrics_agent_report` with that `teamId`. Start with
   `includeGames: false` and a focused filter such as `opponentSpecies`,
   `selectedSpecies`, `outcome`, `from`, or `to`; use `maxEvidence` to bound
   supporting references. Read the immutable full-set snapshot, sample sizes,
   filters, freshness/refresh warnings, and exclusions before interpreting rates.
3. Follow cited game IDs with `team_metrics_game_evidence`, passing `teamId`,
   `roomId`, and relevant `fromTurn`/`toTurn` when useful. Inspect open sheets,
   chosen four when known, current forms, boosts, status, weather, and move order.
   A public replay does not recover every reserve, hidden spread, or agent intent.
4. Use `includeGames: true` or `team_metrics_report` when detailed observations
   are needed. Executed move counts, successful item removals, failed/missed/
   blocked uses, and knockouts are distinct observations. Unknown selections
   and uncertain KO attribution remain unknown.

Incomplete, operationally affected, and manually excluded games are omitted by
default. Their counts and reasons matter; an affected child also excludes its
parent BO3 from default set performance. Opt into such games deliberately when
reviewing execution failures. Decision notes record agent claims, not proof of
server acceptance or an opponent's intent.

To create a private report within the user's task, `team_metrics_register_team`
accepts exactly one of `teamText` or a workspace-local `teamFile`, plus optional
`name`. Preserve its returned full fingerprint. The catalog keeps ten active
versions; creating an eleventh can permanently clean the least recently used
version and owned history. Inspect existing capacity and preserve needed
exports before an import or registration that would trigger that effect.

Import already saved replay URLs with `team_metrics_import_replays`, using
`urls`, the owner's `username`, and exactly one of saved `teamId` or complete
local `teamFile`. Local logs use `team_metrics_import`. Importing a saved URL
does not publish a replay. Private access suffixes remain in the saved report,
so sharing it also shares those links. Do not import against an assumed version
when the original complete team is unknown.

## Retain opposing Speed evidence

Carry a compact Speed ledger in private decision notes and the BO3 review or
handoff. For each observation, retain the opponent's individual identity,
game/turn evidence, actual executed order, move-priority bracket, current forms,
known or assumed boosts, status, items, abilities, and field/control state.
Separate the raw observation, its inferred ordering constraint, and confidence.
Reuse supported constraints in later turns and games of the same set; do not
reset to a generic spread or silently treat one species as a known individual.

Infer relative effective Speed only after checking priority, Trick Room,
Tailwind, order-altering effects, switches, and relevant mid-turn state changes.
A within-bracket order may still be a Speed tie. Repeated same order alone does
not eliminate a tie, and opposite orders can be tie outcomes. An action prevented
or not executed gives no observed move order. Retain tie-compatible bounds when
appropriate. When state changes, preserve the original observation and conditions
and re-evaluate current applicability. Correct an unsupported inference if its
premise is disproven while retaining its evidence and correction history. Do not
infer intent from an ordering result.

Use actual MCP `calculate_speed` calls for numerical candidate spreads and
comparisons, retaining assumptions and receipts where available. Unknown
investments remain ranges or hypotheses; one observed ordering does not identify
exact stat points. Keep the ledger tied to its source games and current state
instead of generalizing a private opponent's spread to future opponents. The
complete matchup skill governs live tracking and its review checkpoint.

## Test a proposed adjustment

Reconstruct relevant opportunities before calculating. Compare the original and
proposed sets under plausible paired opposing actions: attacks, Protect,
switches, setup, and speed control. Check whether a better line already existed
with the original team. Separate positioning, timing, roster limitations,
execution failures, and variance.

For every numerical damage, survival, or Speed benchmark, make actual MCP
`calculate_damage` or `calculate_speed` calls. If unavailable, leave the claim
unverified; do not substitute mental arithmetic, a direct library call, or an
unperformed example.

For native Champions:

- Pass numeric `gen: 0`. Validation still uses the string M-C format ID.
  The native mode uses level 50 and IVs 31. Legal spreads have at most 66 total
  points and 32 per stat; validate before calculating.
- Damage takes current species/forms in `attacker` and `defender`, the `move`,
  and `attackerOptions`/`defenderOptions`. Put native points directly in `evs`
  with `hp`, `atk`, `def`, `spa`, `spd`, `spe`; use those keys for boosts too.
  Do not use 252-EV spreads or convert points to ordinary EVs.
- Speed takes a `pokemon` array of one to six current-state snapshots. Supply
  explicit `species`, `nature`, `ability`, native `statPoints`, and relevant
  `item`, `boosts`, `status`, `tailwind`, and conditional ability state.
  `field` supports effects including `trickRoom`, weather, and terrain.
  Omitted points and boosts mean zero, not unknown. The tool compares within
  one move-priority bracket; ties and unresolved ordering effects remain explicit.
- State opposing investments as revealed or assumed. Supply current forms,
  abilities, items, status, and boosts; a held Mega Stone does not select the
  post-Mega form automatically. Inspect returned descriptions for automatic
  move effects and use pre-move stages where required by the engine.
- Inspect the actual damage schema for supported state. It includes `curHP` in
  actual HP units, conditional ability activation, move state and side conditions
  such as screens and Helping Hand. Current HP is not a percentage. Not every
  full-turn effect belongs in a damage calculation; leave unsupported benchmarks
  unverified rather than manually adjusting a result. Use paired simulation only
  for a material unresolved sequence.

Optional `evidenceContext` with exact `teamId`, supported `roomId`, and optional
`turn` retains the actual calculator input/result and returns `calculationRef`.
Use real receipts when documenting a numerical review, not fabricated IDs.

Explain the improvement, conditions, supporting games, and coverage or ordering
lost. A calculated local benefit is retrospective scenario evidence; it does not
simulate every alternate response or prove an alternate match result. Register
an accepted revision separately, then use `team_metrics_compare` with `teamA`,
`teamB`, and matching filters for descriptive comparisons, not causal claims.

## Tactical work and retention

Automated live turns use the CLI workflow from [setup](setup.md#optional-live-play-login-modes).
The battle model receives generic matchup guidance and actual tool results;
manager chat stays outside the timed turn loop. Use damage/Speed calculators for
numeric questions and `simulate_choices` only when a consequential paired sequence
remains unresolved. Its single representative end board is conditional evidence,
not exhaustive branch coverage or a guarantee. Preserve state and spread
uncertainties. A fast legal submission is not proof of sound positioning.

For individual previews, paired choices, or replay review, read
`battle_skill_read({"skill":"champions-mc-matchups"})` and required references.
Before any authorized live search, the full maintained BO3 cycle additionally
requires skill status/synchronization, current complete guidance, and
`battle_preflight`. Every BO3, including the final one, requires evidence
preservation, a private decision review, a validated lesson or justified no
change, verified skill adoption, and the saved review checkpoint. Follow the
complete cycle for deadlines, retained evidence, cleanup, and batch shutdown;
this companion does not supply a replacement live-control procedure.

The [batch checkpoint](../SKILL.md#complete-each-authorized-batch) is additional
to each set's review. Use the full cycle's batch synthesis, shared-guidance, and
control-repair checkpoints; persist supported findings and every control-failure
cause in the final BO3's team-owned checkpoint. Prefer `battle_review_save` and
verify `battle_review_status`; use `battle_preflight` before another authorized
search. These checks validate stored evidence and readiness, not tactical
application, server acceptance, or unobserved future reliability. Pending offline
repair or loaded-runtime adoption does not require keeping an otherwise completed
batch signed in; complete normal closure and verify adoption at the next normal
authorized startup without an extra login or battle for testing.

Preserve the user's battle allowance and sharing choices. Starting battles,
changing the live team, publishing replays, authentication, and destructive
cleanup need their own applicable authorization. Keep durable metrics,
calculator receipts, reviews, and useful replay/selection evidence. Use bounded
retention tools after their prerequisites; do not erase `cache/` at session end.
Shared examples should use synthetic data or explicitly authorized material.
