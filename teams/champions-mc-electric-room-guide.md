# Electric Room — an original Champions M-C team

An independently assembled hard Trick Room team built around Mega Ampharos,
Pincurchin's Electric Terrain, Oranguru's Instruct, and Araquanid's Soak. This is
an original composition for this coaching session, not a claim that nobody has
ever used these Pokémon or interactions before.

Import `champions-mc-electric-room.txt` into `gen9championsvgc2026regmc`. The
complete team passes the local MCP's legality check. Its classification is
weatherless Trick Room balance. The sets use Champions stat points: 66 per
Pokémon, maximum 32 in a stat, with default 31 IVs. It has not been ladder-tested.

## Why these six fit

| Pokémon | Job |
| --- | --- |
| Mega Ampharos | Slow special attacker. Rising Voltage gains power against grounded targets in Electric Terrain; Dragon Pulse and Power Gem supply coverage. |
| Pincurchin | Establishes Electric Terrain and can attack while Trick Room is up. Terrain Extender supports longer positioning sequences and a second setup. Recover preserves it for terrain resets. |
| Oranguru | Trick Room setter and Instruct support. Inner Focus prevents flinching, and Mental Herb answers one Taunt. Foul Play provides an attack that does not depend on investment in its own Attack. |
| Sinistcha | Second setter, Rage Powder support and Hospitality healing. It provides an alternative setup route when Oranguru cannot safely set Trick Room. |
| Araquanid | Physical Water damage, Wide Guard and the optional Soak combination. Its Ground resistance helps cover the two Electric Pokémon and Kingambit. |
| Kingambit | Physical attacker, a priority option for the endgame, and Defiant pressure against opposing stat drops. It gives team selection an alternative to bringing both Electric Pokémon. |

## Two different attacking boards

**Ampharos + Oranguru:** in Trick Room, Mega Ampharos attacks before Oranguru.
Instruct then repeats its last attack toward its previous target position.
This works with Rising Voltage, Dragon Pulse or Power Gem. Do not select
Instruct expecting an attack if Ampharos's last action was Protect.

**Ampharos + Araquanid:** Araquanid uses Soak first under Trick Room, changing
the chosen target to Water. Mega Ampharos can then target it with Rising Voltage.
This can remove a Ground-type immunity or an Electric resistance. Treat it as a
situational option: direct Liquidation is often the better use of Araquanid's
turn. These two boards are separate; doubles does not let you use Soak and
Instruct alongside Ampharos in the same turn.

At level 50, the relevant unmodified Speed stats are:

| Pokémon | Speed |
| --- | ---: |
| Pincurchin | 31 |
| Araquanid | 55 |
| Mega Ampharos | 58 |
| Kingambit | 63 |
| Oranguru | 72 |
| Sinistcha | 81 |

Under Trick Room, the lower number acts first within the same priority bracket.
The Araquanid → Ampharos → Oranguru ordering was verified in the installed
Champions battle simulator. The check also confirmed that Ampharos can be
Instructed after Mega Evolving and attacking on that same turn.

## Choosing four and getting started

**Direct Electric mode:** Oranguru + Pincurchin lead, with Ampharos + Araquanid
or Kingambit behind them. Pincurchin establishes terrain immediately. If Oranguru
can withstand the opposing board, set Trick Room while Pincurchin attacks or
Protects. Position Ampharos on the next turn, then use attack + Instruct. This
usually spends one Trick Room turn switching, leaving three full turns to attack.
Inner Focus handles flinching, not double-target damage: this is not an automatic
lead into every opponent.

**Protected Electric setup:** Oranguru + Sinistcha lead, with Ampharos +
Pincurchin behind them. Rage Powder can support Trick Room. Terrain and Ampharos
still need to enter, so this route spends more turns positioning. Use it when
the safer setup is worth that cost. Do not set Trick Room with both setters on
the same turn; the second use reverses the first.

**Physical mode:** Oranguru + Sinistcha lead, with Araquanid + Kingambit behind
them. This gives up the Electric plan to focus on Liquidation, Kowtow Cleave and
Iron Head, with Instruct where useful. Consider it when the opponent makes
maintaining terrain especially difficult. Do not bring Pincurchin automatically
when Ampharos is not part of your selected four.

Against heavy spread pressure, Araquanid + a Trick Room setter can lead with
Wide Guard support. Adjust the back two to the opponent rather than trying to
bring every interaction into one game.

## Things that can break the plan

- Rillaboom switching in replaces Electric Terrain. Preserve Pincurchin for a
  reset instead of expecting Terrain Extender to prevent terrain replacement.
- Trick Room and terrain setup consume turns. This team has no fast attacker;
  if both setters are denied, Sucker Punch alone is not a full backup mode.
- Rage Powder does not redirect attacks from Grass Pokémon or other
  powder-immune attackers, and it does not stop spread attacks. Protect and
  Wide Guard require reading the opponent's move choices.
- Soak can be stopped by Protect, Substitute and relevant abilities, or diverted
  by redirection. Switching removes the type change. Ampharos's Mold Breaker
  applies to its own moves; it does not help Araquanid's Soak bypass Good as Gold,
  Magic Bounce, Water Absorb or Storm Drain.
- Rising Voltage doubles its base power only against a grounded target in
  Electric Terrain. Flying targets need separate consideration; do not assume
  every Electric attack has 140 base power.
- Araquanid's physical damage drops after Intimidate. Kingambit's Defiant can
  discourage stat drops, but it does not protect Araquanid from them.
- There is no Discharge on Ampharos: Mold Breaker can bypass an ally's Telepathy.
  Oranguru instead uses Inner Focus because the team's attacks do not need
  Telepathy protection.

## Damage checks

These are MCP calculator outputs for the listed spreads at level 50. No screens,
weather, defensive held items or additional stat stages are included unless
specified. Electric Terrain is present for Rising Voltage. These are example
matchups, not universal guarantees against every opposing build.

| Attack | Opponent's stat points and nature | Damage |
| --- | --- | --- |
| Mega Ampharos Rising Voltage | Incineroar: 32 HP / 18 SpD, Sassy | 86.6–102.4% |
| Mega Ampharos Rising Voltage | Mega Golisopod: 32 HP / 2 SpD, Brave | 94.5–112.0% |
| Mega Ampharos Dragon Pulse | Mega Salamence: 2 HP / 0 SpD, Timid | 119.7–143.0% |
| Araquanid Liquidation at neutral Attack | Incineroar: 32 HP / 16 Def, Sassy | 121.7–143.5% |
| Araquanid Liquidation at −1 Attack | Same Incineroar | 81.1–96.0% |
| Kingambit Iron Head | Mega Gardevoir: 32 HP / 2 Def, Quiet | 157.7–187.4% |

The generic damage tool takes conventional EVs. Positive Champions stat points
`p` were converted to `8p − 4` EVs at level 50, with zero mapped to zero and IVs
31, to reproduce the actual stats. The import file uses Champions points.

The MCP did not find current M-C monthly usage reports. No older regulation's
usage was substituted, and no tournament result is claimed for this new team.
