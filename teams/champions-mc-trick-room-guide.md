# Champions M-C: Camerupt Trick Room balance

Format: `gen9championsvgc2026regmc`.

The complete team passed the local MCP server's `validate_team` check. Its
classifier identified it as weatherless balance. Import the adjacent
`champions-mc-trick-room.txt` into the Champions M-C format on Pokémon Showdown.

This uses the six-Pokémon core from
[Vinnamon's 11–0 Tartan Takedown #39 team](https://play.limitlesstcg.com/tournament/6aa9276138886b36383c0b0d/player/vinnamon/teamlist).
The public sheet does not include investment. The spreads here are my starting
spreads, with a more defensive Farigiraf, faster Garchomp-Z, slower Incineroar,
and Moonblast/Protect on Sylveon. This adaptation has been legality-checked and
damage-checked but has not been battle-tested.

The MCP's M-C usage and individual moveset-statistics requests returned no data.
The tournament sheet supplies current-format evidence; no earlier regulation's
usage data was substituted.

## The six

| Pokémon | Item | Purpose |
| --- | --- | --- |
| Farigiraf | Grassy Seed | Sets Trick Room; Armor Tail blocks opposing priority; Helping Hand supports attacks. |
| Camerupt → Mega Camerupt | Cameruptite | Main slow attacker, with Heat Wave for spread damage and Earth Power for a single target. |
| Rillaboom | Life Orb | Activates Farigiraf's Grassy Seed, supplies Fake Out, and attacks with Grassy Glide outside Trick Room. |
| Sylveon | Fairy Feather | Second slow attacker; Pixilate Hyper Voice pressures both opponents, while Moonblast gets around Wide Guard. |
| Garchomp → Mega Garchomp Z | Garchompite Z | Fast special-attacking alternative when Trick Room is difficult or undesirable. |
| Incineroar | Sitrus Berry | Intimidate, Fake Out and Parting Shot support setup and repositioning. |

## Investment and speed

The export's `EVs:` numbers are **Champions stat points**. Each set spends 66,
with no more than 32 in one stat. Leave IVs at their default 31; do not apply
older-format 0-Speed-IV spreads. Quiet, Relaxed and Sassy provide the reduced
Speed used here.

| Pokémon | Nature | Stat points | Level-50 Speed |
| --- | --- | --- | ---: |
| Farigiraf | Relaxed | 32 HP / 32 Def / 2 SpD | 72 |
| Mega Camerupt | Quiet | 32 HP / 32 SpA / 2 SpD | 36 |
| Rillaboom | Adamant | 32 HP / 32 Atk / 2 SpD | 105 |
| Sylveon | Quiet | 32 HP / 2 Def / 32 SpA | 72 |
| Mega Garchomp Z | Timid | 2 HP / 32 SpA / 32 Spe | 223 |
| Incineroar | Sassy | 32 HP / 16 Def / 18 SpD | 72 |

Camerupt and Garchomp speeds above are after Mega Evolution. The other three
72-Speed Pokémon can speed-tie; avoid plans that depend on their exact order.

## First games

**Default four:** lead Farigiraf + Rillaboom, with Camerupt + Sylveon in back.
Grassy Surge activates Farigiraf's Defense boost. When the opposing board permits
it, use Fake Out into the most important eligible target while setting Trick
Room. Then position Camerupt to attack, preserving Farigiraf if another setup
will be needed. Switching consumes valuable turns: Trick Room gives four full
turns after its setup turn, so avoid unnecessary repositioning.

**More support:** lead Farigiraf + Incineroar, with Camerupt + Rillaboom in back.
Intimidate and Fake Out support setup. Farigiraf's Grassy Seed will need
Rillaboom's terrain to activate. Use Parting Shot thoughtfully: under Trick Room,
Incineroar can move before a fast opponent, exposing its replacement to an attack.

**Fast mode:** lead Garchomp + Rillaboom, with Incineroar + Sylveon in back.
Mega Evolve Garchomp into its Z form and play through direct attacks, Fake Out
and pivots. This is the starting alternative against Imprison or when the
opponent benefits more from Trick Room than you do.

These are opening plans, not automatic turn-one commands. Adapt to Protect,
double-targeting, redirection and the opponent's available disruption.

## Important matchups and decisions

- Usually bring **one** of Camerupt and Garchomp. Only one Pokémon may Mega
  Evolve per battle under the
  [official M-C rules](https://champions-news.pokemon-home.com/en/page/816.html).
  Garchomp's special set is designed for its Mega Z form.
- Preserve Farigiraf: it is the only Trick Room setter. Armor Tail protects
  against opposing priority; it does not stop ordinary Taunt or Imprison.
- Against rain, preserve Rillaboom and avoid exposing Camerupt to Water attacks.
  The MCP type-effectiveness tool confirms Camerupt's Fire/Ground typing takes
  4× Water damage. The fast mode is often the easier starting plan.
- Against Psychic Terrain, check the active terrain before using Fake Out,
  Quick Attack or Grassy Glide. Rillaboom can replace it when switching in;
  opposing Armor Tail can still block your priority attacks.
- Against Wide Guard, choose Earth Power, Ancient Power, Moonblast or another
  single-target attack instead of Heat Wave or Hyper Voice.
- Rillaboom takes both Life Orb recoil and Wood Hammer recoil. Preserve enough
  health to reset terrain or use Fake Out later.
- Mega Garchomp Z is pure Dragon with Levitate. Earth Power does not get a
  same-type bonus in that form, and Grassy Terrain does not heal it.

## Checked damage examples

Calculated through the MCP's `calculate_damage` tool at level 50, using the
exported investment, neutral stat stages, Grassy Terrain, no weather and doubles.
Spread attacks assume two opposing targets. Defender items, screens and other
unlisted modifiers are absent. These examples describe specified spreads,
not every opposing build. Accuracy is separate from the damage roll.

| Attack | Defender investment and nature | Damage |
| --- | --- | --- |
| Mega Camerupt Earth Power | Incineroar: 32 HP / 18 SpD, Sassy | 100.9–119.8% |
| Mega Camerupt Heat Wave | Mega Golisopod: 32 HP / 2 SpD, Brave | 173.6–206.5% |
| Sylveon Hyper Voice | Mega Salamence: 2 HP / 0 SpD, Timid | 102.3–122.0% |
| Rillaboom Grassy Glide | Basculegion: 2 HP / 0 Def, Adamant | 122.8–146.7% |

The generic calculator uses conventional EV inputs. To reproduce Champions'
level-50 stats, each positive stat-point value `p` was converted to `8p - 4` EVs,
with zero mapped to zero and all IVs 31. The export remains in Champions points.
