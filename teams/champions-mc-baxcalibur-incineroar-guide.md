# Mega Baxcalibur snow balance: Incineroar revision

This revision replaces Pawmot with Incineroar in the original Baxcalibur snow
team. Import `champions-mc-baxcalibur-incineroar.txt` into
`gen9championsvgc2026regmc`. The original Pawmot variant remains available in
`champions-mc-baxcalibur-snow.txt`.

The six are Baxcalibur, Alolan Ninetales, Incineroar, Milotic, Gholdengo and
Sinistcha. All other sets retain their original moves, stat points and items.
The revised complete team passes the local MCP's M-C legality check. This is a
custom starting spread for playtesting; it has not been ladder-tested. September
2026 M-C usage is now available through the MCP's Smogon tools, and dedicated
Champions ladder tools provide community-sourced species ranks and set data.
This build still rests on verified mechanics and explicit damage benchmarks;
the availability of those reports does not establish that it was usage-tested.

## Incineroar set

```text
Incineroar @ Chople Berry
Ability: Intimidate
Level: 50
EVs: 32 HP / 14 Def / 20 SpD
Careful Nature
- Fake Out
- Darkest Lariat
- Flare Blitz
- Parting Shot
```

These are Champions stat points, totaling 66, with default 31 IVs. Its level-50
stats are 202 HP / 135 Atk / 124 Def / 90 SpA / 143 SpD / 80 Spe.

- **32 HP:** maximum HP supports both physical and special survival.
- **20 SpD, Careful:** reaches 143 Special Defense; at this allocation, the
  beneficial nature raises the pre-nature stat from 130 to 143. This helps
  against Lucario Z and spread special attacks.
- **14 Def:** retains physical bulk alongside Intimidate. This is a balanced
  allocation, not a claim that 14 points meet a unique universal threshold.
- **No Attack investment:** Darkest Lariat already achieves the Indeedee-M
  benchmark below. Keep these points in bulk for the support role.
- **No Speed investment:** 80 Speed often lets Incineroar absorb attacks before
  using Parting Shot to bring in a teammate. This does not guarantee it moves
  last against every opponent, and changes under Trick Room.

## Item and moves

**Chople Berry** halves the first super-effective Fighting attack that hits
Incineroar, whether physical or special. It provides a one-time buffer against
Sneasler and Mega Lucario Z while preserving Milotic's Sitrus Berry. Leftovers
is a legal alternative for longer games, but Incineroar receives no end-of-turn
recovery on turns when Parting Shot switches it out. Sinistcha's Hospitality
can heal Incineroar when Sinistcha enters the other slot and Incineroar stays
on the field.

**Fake Out** creates a turn for a partner when priority is allowed.
**Darkest Lariat** threatens Indeedee-M and works under Psychic Terrain.
**Flare Blitz** supplies Fire damage, including against Metagross, at the cost
of recoil. **Parting Shot** lowers the target's Attack and Special Attack and
switches Incineroar out, helping position Baxcalibur or another attacker.

The set gives up Protect to retain both attacks and the two support moves.
Keep track of opposing double targets and your remaining switch options.
Champions-specific learnsets were verified: these four moves are legal, while
Knock Off is not available to Incineroar in the installed Champions rules.

## Verified damage benchmarks

All are level 50 with 31 IVs and ordinary, non-critical hits. Chople is intact
where stated. No screens, Helping Hand or damage-boosting items are included
on the attackers. Opposing offensive investment is 32 points in the relevant
attacking stat. These are individual-hit ranges: the berry cannot activate
again on subsequent hits.

| Scenario | Damage |
| --- | --- |
| Timid Mega Lucario Z Aura Sphere, Chople intact | 69–82 HP; 34.1–40.5% |
| +2 Modest Mega Lucario Z Aura Sphere, Chople intact | 150–177 HP; 74.2–87.6% |
| Jolly Sneasler Close Combat at -1 Attack after Intimidate, Chople intact | 67–79 HP; 33.1–39.1% |
| Jolly Sneasler Close Combat at neutral Attack, Chople intact | 100–118 HP; 49.5–58.4% |
| Timid Mega Lucario Z Aura Sphere after Chople has been consumed | 138–164 HP; 68.3–81.1% |
| Incineroar Darkest Lariat into 32 HP / 0 Def Timid Indeedee-M | 174–206 HP; 104.1–123.3% |
| Incineroar Flare Blitz into 2 HP / 0 Def Adamant Mega Metagross | 108–128 HP; 68.7–81.5% |

Surviving +2 Aura Sphere requires enough remaining HP and an intact berry. It
does not make Incineroar a repeatable switch-in to a boosted Lucario. Defense
investment or a damage-reducing item can change the Indeedee knockout benchmark.

## How to use the revised team

Against the Psychic Terrain opening in the supplied replay, consider
**Incineroar + Gholdengo**, with **Milotic + Baxcalibur** behind. Incineroar is
immune to Psychic attacks and resists Fire; Gholdengo supplies additional
offensive pressure. Preserve Milotic when Hisuian Typhlosion is present.
Adjust the lead when the opponent's other threats make it unsafe.

Under Psychic Terrain, do not select Fake Out into a grounded opponent.
Darkest Lariat, Flare Blitz and Parting Shot remain options. Gholdengo should
use Make It Rain to pressure Indeedee-M: Indeedee's Normal typing makes it
immune to Shadow Ball.

The revision loses Pawmot's Coaching and fast Electric/Fighting attacks but
keeps Sinistcha's healing, redirection and Trick Room control. Its Psychic
immunity gives team selection more flexibility than the original six.

Watch opposing Competitive Milotic before sending Incineroar in: Intimidate
can boost it. Intimidate does not weaken special attacks. Base Metagross's
Clear Body blocks its stat drops; Mega Metagross's Tough Claws does not.
