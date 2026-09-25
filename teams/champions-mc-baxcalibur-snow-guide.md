# Mega Baxcalibur snow balance — Champions Regulation M-C

A custom composition for this coaching session: Mega Baxcalibur / Alolan
Ninetales / Pawmot / Milotic / Gholdengo / Sinistcha. The aim is to give Baxcalibur
several practical ways to attack safely, with Gholdengo as a separate win
condition. This is an independently assembled team, not a claim of a previously
undiscovered combination.

Import `champions-mc-baxcalibur-snow.txt` into
`gen9championsvgc2026regmc`. The complete export passes the local MCP legality
check. The `EVs:` lines use Champions stat points: 66 total, maximum 32 in one
stat. All IVs default to 31. Moves were checked through the MCP, supplemented
with the installed Champions learnsets: Champions gives Pawmot Fake Out and
Baxcalibur High Horsepower, which the generic Gen 9 movepool tool omits.

Legality, speed and damage were checked; this team has not been ladder-tested.
The spreads are a starting point for playtesting, not tournament-proven spreads.

## Why these six

| Pokémon | Purpose |
| --- | --- |
| Mega Baxcalibur | Main physical attacker. Dragon Dance raises Attack and Speed; Icicle Crash and High Horsepower provide its attacks. Jolly maximum Speed reaches an important post-boost benchmark. |
| Alolan Ninetales | Snow increases Baxcalibur's Defense by 50%. Light Clay extends Aurora Veil to eight turns, reducing ordinary incoming damage to roughly two thirds in doubles. Encore can punish a slower opponent's setup or Protect. |
| Pawmot | Fake Out can buy a turn for Veil or Dragon Dance. Coaching raises Baxcalibur's Attack and Defense, and Pawmot can also attack. Focus Sash supports its survival; carrying both attacks means giving up Protect. |
| Milotic | Competitive raises its Special Attack by two stages when an opponent lowers its stats, discouraging Intimidate cycling while Milotic is active. Icy Wind offers speed control without requiring Baxcalibur to set up. Recover and Sitrus Berry support longer games. |
| Gholdengo | Special attacker and alternative win condition. Make It Rain pressures Fairy Pokémon. Use Nasty Plot when the board gives it an opening, particularly when opponents invest heavily in stopping Baxcalibur. |
| Sinistcha | Hospitality heals its ally by a quarter of maximum HP on entry. Rage Powder can create an attacking or setup opportunity. Trick Room is primarily here to reverse opposing Trick Room. |

Choose the support action that the current board rewards. Veil, Dragon Dance,
Coaching and Nasty Plot are options; trying to establish every boost can give
the opponent too many free attacks.

## Leads and choosing four

**Starting selection:** Baxcalibur, Ninetales, Pawmot and Gholdengo. Lead
Ninetales + Pawmot when Fake Out can safely open a Veil turn. Bring Baxcalibur in
when a switch is safe, then attack with Coaching support or use Dragon Dance
if the opponent cannot punish it. Fake Out only stops one target and can be
blocked, so this is not an automatic turn-one sequence.

**Immediate Baxcalibur pressure:** Baxcalibur + Pawmot, with Ninetales and
Gholdengo behind. Fake Out + Dragon Dance is an option if the other opponent
cannot threaten a knockout or disable Baxcalibur. Otherwise, attack immediately.
Ninetales can enter later to establish snow.

**Against repeated Intimidate:** prioritize Milotic, often replacing Gholdengo
in the starting four. Milotic must already be on the field when Intimidate
activates to receive Competitive. It does not prevent Baxcalibur's Attack drop.

**When Gholdengo is the better win condition:** Gholdengo + Sinistcha can apply
immediate pressure or use Rage Powder + Nasty Plot when safe. Bring Baxcalibur
and Milotic or Ninetales behind, depending on whether you need Water pressure
and Icy Wind or snow and Veil.

**Against Trick Room:** preserve Sinistcha to reverse an established room and
use Protect to manage turns. Trick Room is a field move, so opposing Protect
does not block reversal. Clicking Trick Room while room is absent can instead
activate the opponent's preferred speed control if their setter attacks or
Protects. Imprison can prevent its use; an opposing second Trick Room activation
can also undo your reversal.

## Speed benchmarks

| Pokémon | Level-50 Speed |
| --- | ---: |
| Mega Baxcalibur | 152; 228 after one Dragon Dance |
| Alolan Ninetales | 177 |
| Pawmot | 172 |
| Milotic | 103 |
| Gholdengo | 136 |
| Sinistcha | 90 |

Maximum-Speed positive-nature Mega Garchomp-Z reaches 223, so +1 Baxcalibur
outspeeds it without other modifiers. One Icy Wind lowers it to 148, below
unboosted Baxcalibur. Maximum-Speed positive-nature Sneasler and Mega Salamence
reach 189; one Icy Wind lowers them to 126, below Gholdengo. These comparisons
assume no Tailwind, Choice Scarf, additional boosts or other speed changes.

Pawmot moves before unboosted Baxcalibur, allowing Coaching to improve that
turn's attack. After Dragon Dance, Baxcalibur moves before Pawmot, so Coaching's
Attack boost normally benefits the following turn instead.

## Damage checks

All calculations are level 50, 31 IVs, doubles, and non-critical hits. Attacks
are assumed to connect. Champions stat points were converted into equivalent
ordinary EVs for the calculator: positive points become `8 × points − 4`.
The exact inputs and outputs are saved in `cache/baxcalibur-snow-calculations.json`.

| Attack and conditions | Result |
| --- | --- |
| +1 Jolly 32 Atk Mega Baxcalibur Icicle Crash into 32 HP / 0 Def Rillaboom | 142.9–169.0%; guaranteed knockout if it connects. |
| +1 Jolly 32 Atk Mega Baxcalibur High Horsepower into 2 HP / 0 Def Gholdengo | 129.2–152.4%; guaranteed knockout if it connects. |
| +1 Mega Baxcalibur High Horsepower into 32 HP / 16 Def Careful Incineroar | 95.0–112.8%; 75% knockout roll if it connects. |
| The same Incineroar target with Baxcalibur at neutral Attack after Intimidate cancels its boost | 64.3–76.2%; does not knock out from full health. |
| Jolly 32 Atk Sneasler Close Combat into this Mega Baxcalibur, snow only | 62.5–75.0%. |
| The same Close Combat, snow plus Aurora Veil | 41.6–50.0%. |

The Sneasler benchmark assumes no damage-boosting item and no Attack boost.
The MCP supplied the core damage calculations; its field schema cannot accept
Aurora Veil, so that comparison used the same installed damage library directly
with the defender's Aurora Veil flag. No Coaching Defense boost is included.

## Matchups and move limitations

- **Weather competition:** Ninetales needs snow active when Aurora Veil resolves.
  An opposing weather switch can prevent it. Established Veil remains when snow
  ends, but Baxcalibur loses snow's Defense boost. Preserve Ninetales when resets
  are important.
- **Mega Golisopod:** it resists Ice and takes neutral Ground and Fighting damage.
  Preserve Gholdengo and Milotic for special pressure; Baxcalibur is not the
  only route to winning this matchup.
- **Accuracy:** Icicle Crash is 90% accurate and High Horsepower is 95% accurate.
  A guaranteed damage roll is not a guaranteed hit. Baxcalibur does not learn
  Ice Spinner in this Champions data.
- **Thermal Exchange:** prevents burns and raises Attack after damage from a
  Fire move. It does not make Baxcalibur immune to Fire damage.
- **Double Shock:** removes Pawmot's Electric typing after a successful use.
  It normally cannot use Double Shock again until it switches out and returns.
- **Redirection:** Rage Powder does not stop spread attacks; Grass Pokémon and
  powder-immune attackers can ignore it. Volt Absorb only protects Pawmot from
  Electric moves; it does not redirect attacks away from Milotic.
- **Fast pressure:** if the board does not give you a setup turn, attack, use
  Icy Wind, or reposition. Do not insist on Dragon Dance against every lead.
