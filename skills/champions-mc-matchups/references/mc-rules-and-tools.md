# Champions M-C: rules and evidence contract

Verified 2026-10-02 against the official announcement, the project's pinned
Pokemon Showdown snapshot, and actual MCP calls. These are a versioned baseline;
check for corrections when using the skills later. Named M-C analysis can remain
historical after its season ends, but do not call it the current regulation then.

## Rules and sources

The [official M-C announcement](https://champions-news.pokemon-home.com/en/page/816.html)
sets its period to September 9, 2026, 02:00 UTC through December 2, 2026, 01:59 UTC.
It permits one Mega Evolution per battle with the appropriate stone and forbids
duplicate held items. Its ranked timers are 20 minutes total, 7 minutes per player,
45 seconds per turn, and 90 seconds for preview. Use event-specific rules when
the user is preparing for a tournament instead of assuming every event's clocks.

The [official eligible-Pokemon list](https://web-view.app.pokemonchampions.jp/battle/pages/events/rs178713870219xeaaio/en/pokemon.html)
is linked from that announcement. It is dynamically rendered; an empty text
extraction is not an empty roster. For executable checks use the format
`gen9championsvgc2026regmc` in current compatible Showdown.

This project pins [Showdown commit a5df8274e85b0889bf2a9b3422a08b39732374fc](https://github.com/smogon/pokemon-showdown/tree/a5df8274e85b0889bf2a9b3422a08b39732374fc).
Its M-C rule table and Champions mod establish:

| Constraint | Required handling |
| --- | --- |
| Doubles, six registered, four selected, battles at level 50 | Do not import singles roles or plan to use all six in one battle. |
| Species Clause | No repeated National Pokedex number, including alternate forms. |
| Item Clause | No repeated held item; inspect the other five sets before assigning one. |
| Training | At most 66 stat points total and 32 per stat; export points on the `EVs:` line. |
| IVs | All six IVs are 31; omit the line or explicitly use 31. No zero-Speed IV Trick Room sets. |
| Mechanics | Mega Evolution is available; Terastallization, Dynamax and Z-Moves are not M-C battle resources. A Mega-Z form does not imply Z-Moves. |
| Form changes | A Mega Stone does not prove the post-Mega ability or stats; inspect the correct form. |

Useful source locations in the pinned repository: `data/mods/champions/`,
`sim/team-validator.ts`, `sim/dex-formats.ts`, `sim/teams.ts`, and
`data/rulesets.ts`. The latter uses a 55-second simulator turn limit in this
snapshot; do not confuse that with the official 45-second ranked limit.

## Use actual tool capabilities

| Task | Tool and check |
| --- | --- |
| Find a candidate | `search_pokemon`, `get_pokemon`; existence is not M-C eligibility. |
| Verify a set or six | `validate_pokemon`, `validate_team`, explicitly passing the M-C format. |
| Learnset and mechanics | `get_movepool`, `get_move`; supplement with Champions Dex when generic data differs. |
| Item or ability lookup | `search_item`, `search_ability`, then inspect its full Champions effect and validate the set. |
| Type interaction | `get_type_effectiveness` for the actual defending types; verify ability-based exceptions separately. |
| Showdown ladder usage | `get_usage_stats`, `get_pokemon_usage`, with explicit M-C, period, and rating. Missing data is not zero usage. |
| Champions ladder data | `get_champions_usage_stats`, `get_champions_pokemon_usage`, with battle type, season, and snapshot date. Species ranks are not usage percentages. |
| Damage | `calculate_damage`, with the native Champions mode below. |
| Stats and effective Speed | `calculate_speed`, native Champions current-state snapshots; ties and unsupported order effects remain explicit. |

### Usage sources and provenance

All four usage tools return structured JSON containing source provenance and
resolved period metadata. Preserve this metadata when reporting or comparing
results: Showdown and Champions ladder data describe different populations.

For **Smogon**, `get_usage_stats` and `get_pokemon_usage` accept `format`
(M-C default), optional `month` in `YYYY-MM`, and optional `rating` of
`0`, `1500`, `1630`, or `1760`. An explicit cutoff is exact; omitted
ratings try `1760`, then `0`, and label any fallback. An omitted month
discovers the latest actually published reports. `get_usage_stats` accepts
`limit` (default `20`, maximum `100`); `get_pokemon_usage` requires
`pokemon`. Do not silently substitute another regulation for missing M-C data.

On 2026-10-02, September 2026 M-C reports were verified at
[Smogon's monthly statistics](https://www.smogon.com/stats/2026-09/).
Do not preserve an earlier session's "statistics unavailable" result as a
permanent fact. Record the resolved rating cutoff alongside format and month.

For **Champions**, `get_champions_usage_stats` accepts `battleType`
(`Doubles` default or `Singles`), optional `season` such as `M6`,
optional ISO `date` such as `2026-10-02`, and `limit` (default `20`,
maximum `100`). `get_champions_pokemon_usage` requires `pokemon` and
accepts the same battle type, season, and date selection. Omitted season/date
resolve the latest available snapshot through the provider's
[metadata index](https://championsbattledata.com/data/meta/index.json).

The verified latest snapshot on 2026-10-02 was season `M6`, dated
`2026-10-02`. The provider reports species ranks without overall species
usage percentages or a battle count. Pokémon detail data includes move, item,
ability, nature, and stat-point percentages, plus teammate ranks. Set
percentages do not measure the species' share of all teams. The provider
supplies no verified Showdown regulation mapping: do not infer M-C merely
from the season label `M6` or treat the feed as official Pokémon data.

Battle data provided by
[Pokémon Champions Battle Data](https://championsbattledata.com/api_guide), an
unofficial community source. Follow its
[API usage rules](https://championsbattledata.com/api-rules/): retain linked
attribution in public output, use reasonable caching, and avoid a standalone
raw-data service or permanent mirror without permission.

The existing `get_move` and `get_movepool` tools use generic `@pkmn/data`
generation data. Keep their supported generation setting; do not blindly pass
zero to every tool. Generic pools can omit inherited or Champions-specific moves.
For example, Incineroar's Parting Shot is present in the Champions learnset even
when that generic pool omits it. Use Pokemon Showdown's
`Dex.mod('champions').species.getLearnsetData(speciesId)` and move/ability/item
Dex records as the supplement, then validate the complete set for M-C.

If tools are not exposed in the current client, inspect the user's VGC project
and its README. Where its installed dependencies and `dist/index.js` exist,
the MCP SDK's `Client` and `StdioClientTransport` can call the same tools through
`node dist/index.js`. Resolve paths from the active project, not a hard-coded
user directory. A verified Champions Showdown validator may be used directly for
legality, identifying that fallback. Damage calculations must use actual MCP
`calculate_damage` calls, including calls through the MCP SDK above; do not call
the calculator library directly or substitute another damage engine. If the MCP
is unavailable, leave damage, KO probability, and survival benchmarks unverified.
Never report a check as performed because a tool name or documentation was found.
Do not update packages merely
to answer a matchup question unless that work is requested or actually necessary.

## Native Champions calculations

For numerical Speed comparisons use actual MCP `calculate_speed` calls, never
mental arithmetic or a direct local stat helper. It accepts 1–6 `pokemon` entries
with explicit `species` (current form), `nature`, `ability`, `statPoints`, held
`item`, `boosts`, `status`, `tailwind` and conditional ability state. Its `field`
models weather/terrain, suppression, Magic Room and Trick Room; numeric `gen:0`
is native Champions. The installed native Champions engine owns stat/modifier
calculations and rounding. Results include raw stats, effective Speed, ordering
groups and unresolved ties. Omitted points/stages mean zero, not an unknown set;
label assumed opposing spreads. It compares within one priority bracket only
and does not settle Quick Claw, Quash or other non-Speed ordering effects. If the
MCP cannot model the relevant state, leave the comparison unverified.

Live control can use `battle_status`, `battle_wait`, `battle_start`,
`battle_authorize_sets`, `battle_choose`, `battle_ready`, `battle_cancel_search`,
`battle_forfeit` and `battle_stop` against
the user's signed-in local terminal session. Follow `showdown/AGENT-WORKFLOW.md`
in the active project and the bundled [BO3 cycle](headless-battle-cycle.md).
Before a new search, complete the previous BO3's review/update checkpoint and
verify the installed skill is synchronized; the transport does not enforce that
review step. `battle_forfeit` acts on the owned whole-BO3 parent only within the
user's authorization and preserves the login; verify the official result and idle
state. `battle_stop` disconnects and does not forfeit.
Request stats are server observations, not effective-Speed
calculations. Use current action tokens and distinguish sent/accepted/resolved
actions. No automatic extra queue follows a result. Replay publication defaults
off; an explicitly authorized session replay policy can preserve future completed
sets. Inspect its verification status and follow the required cycle.

Verified with installed `@smogon/calc` 0.12.0: **numeric `gen: 0` means Champions**
for `calculate_damage`. The validation format remains the string
`gen9championsvgc2026regmc`. Pass points directly in `evs` with keys
`hp`, `atk`, `def`, `spa`, `spd`, `spe`; use those names for `boosts` too.
The MCP schema's older examples using `at` or `sp` do not invest the intended
stats. Native Champions mode fixes level 50 and IVs 31.

For Electro Shot, supply the attacker's **pre-move** Special Attack stage. Actual
MCP checks on October 15, 2026 returned a +1 attack description from `spa: 0`
and +2 from `spa: 1`: the calculator applies the move's own boost. Do not add it
again in the input. Verify returned descriptions against the intended state and
inspect move-specific automatic effects before interpreting other benchmarks.

Do not send 252 to mean maximum investment in native Champions mode, and do not
convert points using `8p - 4` there. Those conversions were only a compatibility
workaround for ordinary level-50 Gen 9 calculation, not an authorized fallback
for this workflow. Use the MCP's native Champions mode. The calculator itself
does not enforce the 66/32 caps: validate legal spreads first.

Example actual MCP request:

```json
{
  "gen": 0,
  "attacker": "Lucario-Mega-Z",
  "attackerOptions": {
    "ability": "Aura Guard",
    "item": "Lucarionite Z",
    "nature": "Modest",
    "evs": {"spa": 32},
    "boosts": {"spa": 2}
  },
  "defender": "Incineroar",
  "defenderOptions": {
    "ability": "Intimidate",
    "item": "Chople Berry",
    "nature": "Careful",
    "evs": {"hp": 32, "def": 14, "spd": 20}
  },
  "move": "Aura Sphere",
  "field": {"gameType": "Doubles"}
}
```

Verified individual-hit result: 150-177 damage, 74.2-87.6%. Incineroar's native
stats are 202 HP, 124 Defense, 143 Special Defense. This is an assumed test case,
not an assertion about common spreads. Chople must be intact; its reduction
cannot be applied anew on every hit in a multi-turn knockout estimate.

The current MCP field schema accepts game type, weather, terrain, and gravity.
It does not expose all calculator options such as screens, Helping Hand, or
current HP. Unknown fields may be stripped. Inspect the current MCP schema;
if a necessary condition remains unsupported, mark that benchmark unverified.
The project's October 14, 2026 status extension accepts `attackerOptions.status`
and `defenderOptions.status`: `brn`, `par`, `psn`, `tox`, `slp`, or `frz`; omit the
field or use `""` for healthy. Pass burn as `status: "brn"` on the affected actor
and let the MCP model physical damage and exceptions such as Guts or Facade; do
not manually halve damage or add a second burn adjustment. Defender status also
matters for moves such as Hex. Verify the connected server's advertised schema
before relying on this extension: a source update does not update an already
running server or an older build. If status is absent there, leave the benchmark
unverified until a supported build is connected. Check form, ability, and other
required inputs as well.
Do not silently omit it, claim it was included, or bypass the MCP with a direct
calculator. Record the actual MCP inputs and results for numerical claims.
Account for the actual number of targets, Eruption's current-HP power, consumed
items, accuracy, critical hits, and pre-existing chip where the MCP supports them.
Report replay HP changes as observed evidence, not as calculated damage ranges
or proof of a guaranteed KO. Reconcile raw damage and KO labels with intact
Focus Sash, Sturdy, and other survival mechanics; a raw OHKO label does not
establish those effects were applied even when the item or ability was supplied.
A critical-hit KO does not establish that a normal hit would have KOed, or that
the critical hit was necessary to win.

## Legality and mechanics traps

### Sucker Punch needs a pending attack

Sucker Punch fails after its target has already acted, even when that earlier
attack was blocked. In particular, Fake Out acts in an earlier priority bracket;
Armor Tail blocking its effect does not restore the user's pending action.
Helping Hand plus Sucker Punch into that Pokemon can therefore spend both our
actions without damage. Compare an ordinary attack or another target whose
damaging action is still pending, including its Protect and redirection branches.
An ordinary attack that remains pending can still justify Sucker Punch; this is
not a reason to discard the move on every Fake Out turn.

Actual MCP `get_move` describes both the attacking-action and already-moved
failure conditions. The pinned `data/moves.ts` Sucker Punch handler checks
`queue.willMove(target)`; the Champions Fake Out override preserves its earlier
priority. This verifies timing, not numerical damage or a guaranteed alternative.

### Mega Sol can differ from the field weather

Verify Mega Meganium's current **Mega Sol** rather than carrying over its base
ability. In the pinned Champions engine, its relevant move effects use effective
sun even while the field shows rain. Its Weather Ball is therefore Fire, and
Solar Beam can attack without a charging turn. A rain pivot does not make either
move safe for a Fire-weak or Water-type recipient. Check the complete incoming
pair before bringing in Rillaboom, Politoed or Mega Golisopod.

This does not replace the shared weather with Drought. The override follows
the acting Mega Sol user, including weather queries made on its target during
that move; a target merely having Mega Sol does not give incoming moves sun.
Ordinary Politoed Weather Ball can still use rain, and Archaludon's Electro Shot
still checks actual rain. The pinned
`sim/pokemon.ts` effective-weather override explicitly excludes Electro Shot;
`data/abilities.ts` defines Mega Sol, and `data/moves.ts` uses effective weather
for Weather Ball and Solar Beam. These are mechanics checks, not damage or
survival benchmarks. For numerical advice use actual MCP results, verify whether
the supplied ability is modeled, and disclose unsupported states without manual
weather or damage adjustments.

Actual MCP checks on 2026-10-02 rejected Safety Goggles, Assault Vest, Incineroar
with Knock Off, a 67-point total, a 33-point stat, and zero-Speed IVs in M-C.
They accepted the legal Chople Incineroar set used above. These are regression
examples, not an exhaustive banned list or permission to assume other items.

Adding `Tera Type: Fire` was accepted and stripped by Showdown, not rejected.
Therefore omit Tera fields from exports and calculations yourself. Validation
success does not establish the availability of every pasted mechanic.

When relevant, verify these interactions from Champions move and ability data:

- Weather and terrain occupy different systems. Snow boosts Ice-type physical
  Defense; it does not reduce special damage. Aurora Veil is a separate effect.
- Psychic Terrain protects grounded targets from opposing priority. It does not
  ban all status moves, and a Dark attacker does not bypass that protection.
- Spread attacks such as terrain-enabled Expanding Force bypass Rage Powder
  redirection. A Dark Pokemon's immunity protects that Pokemon, not its partner.
- Psychic Fangs can remove screens before damage on a successful eligible hit;
  Protect or immunity can invalidate a proposed screen-breaking line.
- Aura Guard reduces contact damage, including physical attacks whose type is
  favorable. Thermal Exchange prevents burns but does not grant Fire immunity.
- Competitive and Defiant can punish stat drops. Recheck the target's current
  ability after Mega Evolution instead of carrying over the base-form ability.

Reverify an interaction when the rules snapshot changes or the recommendation
depends on it; this reference is not a substitute for the current tool result.
