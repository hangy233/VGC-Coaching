# Lessons from live M-C BO3 play

Reviewed 2026-10-15 from all ten completed played sets in the local
`cache/ten-cycles-results.json` ledger, with battle events used to check sheets
and decisive sequences. The fixed six were Golisopod / Kommo-o / Rillaboom /
Politoed / Farigiraf / Sylveon. These are conditional decision rules, not a team
ranking or matchup win-rate estimate. The batch finished 5–5; concessions,
variance, and operational failures limit what that record establishes.

Use the [M-C evidence contract](mc-rules-and-tools.md) for mechanics, current
forms, native points, and actual MCP damage and Speed calls. No new numerical
benchmark is established here. A supported-looking calculation does not replace
planning, and an unsupported field condition remains unverified; never use a
direct calculator or mental damage/Speed arithmetic as a fallback.

## Rules to carry into the next set

**Choose the fallback before optional research.** In a reviewed game, a late
intended pair was never sent, the server supplied different moves, and later
deliberate submissions still ended in total-bank inactivity. Identify a complete
legal pair from the fresh board first, then use the cycle's early-commit buffers
to bound only the checks that could change it. An unavailable damage benchmark
stays unverified; it does not prevent every qualitative legal choice. Recheck the
pair after a forced replacement or other request change. An external deadline
alert helps the operator notice urgency but never submits that pair for it.

**Read denial and coverage before choosing four.** Convert the full open sheet
into plausible paired actions: attacks, Protect, setup, switches, weather,
Encore, Disable, redirection and other relevant disruption. State the expected
opposing play, our response, its main risk, and an alternative if the read is
wrong. An attack's damage matters only if it can execute against the intended
target. In this batch one Archaludon sheet had Dragon Pulse, while another had
Aura Sphere; both associated Charizard sheets had Hurricane. A species-level
claim that Kommo-o answers Archaludon misses those different joint boards.
Unknown investments and the selected four remain unknown even with open sheets.

**Plan the lock sequence, not just the next attack.** When Encore and Disable
are revealed, track each active Pokemon's last executed move, current locks,
available alternatives, switch route, and protection at resolution. Preserve
Armor Tail when its priority protection is necessary and feasible; it does not
block every possible Encore or Disable. Set 6 included an actual blocked Encore
while Farigiraf was active. Set 9 later reached Disable plus Encore and Struggle
after Farigiraf was gone. These events support planning the support interaction
early, not a claim that preserving Farigiraf would necessarily have won.

**Judge both sides' progress through protection.** Compare paired outcomes when
the intended target Protects: can our partner remove the other foe, set control,
recover, or position safely, and can their partner set up? In set 9, King's Shield
covered Mimikyu using Swords Dance while Muddy Water broke Disguise; Mimikyu was
then removed on the next turn. Count both the boost and the broken Disguise.
Conversely, our Protect plus an attacking partner produced actual KOs in sets
7–9. Neither a protected attack nor a Protect selection alone proves a bad turn.

**Read why the opponent would preserve a target.** When our revealed attacks
credibly threaten a knockout, ask whether the target is needed to answer one of
our remaining Pokemon and whether a plausible available reserve takes the intended
attacks better. Those incentives strengthen a Protect or switch hypothesis. Open
sheets do not confirm an unrevealed reserve was selected, and an opponent may
attack or sacrifice the target to gain damage, position, or a free entry. Compare
doubling the slot with split pressure or attack plus support. Include the switch-in's
effect on both attacks, their partner's progress, and the next board. Two attacks
that share one resisted or immune switch-in may spend both actions for little
return; Sucker Punch also needs an attacking target when it resolves. A double
target can remain worthwhile when needed to remove a threat, when it pressures
the plausible recipient too, or when denying the target's attack outweighs the
alternative. Record the read as a hypothesis before the outcome when the clock
permits; a retrospective explanation does not establish prediction accuracy.

**Carry early support into the receiver's action.** Helping Hand places a
one-turn effect on its ally; knocking out the helper afterward does not cancel
it. The [pinned move handler](https://github.com/smogon/pokemon-showdown/blob/a5df8274e85b0889bf2a9b3422a08b39732374fc/data/moves.ts#L8573-L8604)
stores that effect on the recipient. Before trading an endgame answer for a
support knockout, still check the helped attack against both our slots. Our own
Helping Hand can also deliver value before its user faints, provided its ally
can attack successfully. A protected target, a recipient fainting first, or
other action denial can prevent that payoff. The current MCP cannot model
Helping Hand damage numerically; keep that benchmark unverified instead of
applying a manual multiplier.

**Treat Sucker Punch as a read with an escape branch.** Include revealed
King's Shield, Protect, Rage Powder and other nonattacks when testing its value,
as well as move denial and the partner's pressure. Repeated Sucker Punch into
King's Shield with the partner also targeting that slot can concede both actions
to one defense. Compare a legal alternative target, move or switch from the
actual board; a risky Sucker Punch can still be justified when alternatives do
not retain a route. Successful finishing Sucker Punches in sets 1, 6 and 9 are
counterexamples to banning it after the failures in sets 7 and 9. Distinguish
conditional failure from Disable, flinch, fainting first, and a turn never sent.

**Preserve the resources that deliver the endgame.** Name the remaining threat
and its answer before trading rain, Armor Tail or the speed-control setter for
chip. Schedule the Trick Room transition while the setter can still survive and
act; a selected reset that is KOed before execution provides no control. Sets 1,
3, 7 and 10 contain that failure to deliver a selected reset. Successful rain
pivots and Rillaboom / Politoed finishes in sets 5 and 6 remain useful options.
Recheck weather when attacks resolve, including opposing switches, Mega
Evolution and revealed weather moves. Weather Ball is not permanently a rain
attack, and rain can benefit opposing threats too. Check current forms and
abilities: base Golisopod's Emergency Exit caused replacement requests in this
batch; carrying a stone did not make it already Mega Evolved.

Track weather activations and expiry separately from setter entries. In this
Gen 9 format, Drizzle reentry during existing rain does not refresh its duration;
the [pinned weather handler](https://github.com/smogon/pokemon-showdown/blob/a5df8274e85b0889bf2a9b3422a08b39732374fc/sim/field.ts#L39-L52)
rejects the same-weather ability activation. A later controlled game confirmed
no new rain activation on that entry, followed by rain expiring that turn.
Reentry after expiry did establish new rain while the partner delivered Trick
Room, so this is not a reason to discard weather pivots. Check the actual new
activation and opposing responses before relying on the next weather window.

The same duration check applies to terrain. The pinned `sim/field.ts`
`setTerrain` returns before reinitializing an already identical terrain.
Reentering Grassy Surge during existing Grassy Terrain therefore does not renew
it. Track the actual new activation or expiry before relying on Grassy Glide's
priority; a later activation after removal or replacement is a different board.

**Weight the opponent's incentive to overwrite our weather.** When our weather
suppresses their attacks or enables our plan, an available setter or other usable
override that reverses that advantage is a leading high-likelihood response to
test first. This is a planning read, not a measured probability or certain switch.
Distinguish a confirmed selected reserve from a setter merely registered on the
sheet, and verify the usable activation, including an unspent Mega weather change.
Rebuild both slots at resolution: Weather Ball can change type into an immunity,
while weather-dependent Speed or survival can change before either attack.
Compare a type-stable attack, pressure on the setter, or a protected positioning
turn that preserves our weather setter for a later entry. Account for their
partner's progress and the cost of our pivot; do not automatically counter-switch
or discard Weather Ball. If the setter is unavailable or overwriting weather
does not help their current plan, reduce that branch's weight and retain their
attack, Protect or setup alternatives. Use actual MCP checks for numerical claims.

**Require a protected route to setup and payoff.** Check incoming paired damage,
denial, setup cost, and the next attacking turn before choosing Clangorous Soul
or another boost. Protection can come from a checked defensive turn, partner
pressure or disruption; do not assume the foe cooperates. Set 5's Soul executed
alongside Leech Life and was followed by a successful attacking turn, but the
Incineroar KO was critical. That supports considering the setup line, not a
guaranteed uncritical KO. Set 10's default-selected Soul and later Encore-forced
Soul are operational and lock evidence, not proof the pilot chose safe setup.
Likewise, budget Hyper Beam's observed recharge turn and its partner's task;
one critical-hit KO or a missed Hyper Beam does not settle the move's general
value.

## Evidence map and limits

Numbers identify the anonymized completed-set order in the local ledger. Keep
player identities, private room URLs and session material out of the skill.
Use this map to audit a rule rather than importing a fixed lead script.

| Set | Useful evidence to retain | Correction or limit |
| --- | --- | --- |
| 1 | Switching to Politoed while Farigiraf protected enabled an executed Helping Hand + Weather Ball KO; Sucker Punch also finished a different game. | Psychic Terrain blocked Fake Out after a switch-in; a selected Room reset never executed. Hyper Beam's Incineroar KO was critical and incurred recharge; the final game ended by forfeit after the Gholdengo KO. |
| 2 | Sylveon actually absorbed Draco Meteor on a switch; spread attacks made progress through one target's Protect, and Rillaboom finished the last foe. | Psychic was also selected into immune Kingambit. A sound paired turn can contain one ineffective action; inspect both actions instead of judging by the set win. |
| 3 | Sucker Punch actually removed Basculegion in the last game. | Golisopod then fell to Arcanine. Critical hits, missed attacks, two server-default incidents and a corrected target error limit tactical conclusions; the automatic Emergency Exit replacement was not a read. |
| 4 | Helping Hand + Weather Ball removed Gholdengo; Muddy Water later removed Kleavor while Farigiraf actually set Room. | Psychic Terrain again invalidated Fake Out. A critical Leech Life and an opponent forfeit limit the conclusion; the remaining Cinderace was never KOed and no second child game was observed. |
| 5 | Changed selections, a rain pivot, Ice Beam into Gliscor and paired pressure produced actual progress; Kommo-o's setup line executed. | Disable and flinches denied selected actions. Competitive was a pre-turn risk, but Empoleon switched out before Muddy Water hit; do not claim a boost occurred. The closing selected attacks never executed before a series concession. |
| 6 | Emergency Exit replacement was handled; Armor Tail blocked Encore; Golisopod and Farigiraf removed Whimsicott, then Rillaboom / Politoed finished Charizard. | Several attacks met Protect and one Sucker Punch failed, yet games 2 and 3 were won. Preserve the successful alternate branches; earlier critical hits do not establish normal-hit benchmarks. |
| 7 | Golisopod Protect let Weather Ball remove Volcarona; Iron Head then removed Meganium. | Later contact into switched-in Volcarona caused burns, Sucker Punch failed into Rage Powder, and a Room reset was KOed before execution. These are tactical/mechanical outcomes, not defaults; the first game's last Corviknight was not KOed before forfeit. |
| 8 | A revised four won game 2; Kommo-o Protect paired with Ice Beam removed Archaludon, and paired spread attacks finished Charizard. | Other games included a missed Helping Hand + High Horsepower, repeated Muddy Water misses, sleep, flinch and critical hits. Do not promise that one connecting attack or another selection would have won. |
| 9 | Golisopod attacks finished Mimikyu, Delphox and Aegislash in the won game; the same Helping Hand + Leech Life pair failed into Protect one turn and KOed Delphox the next in game 3. | King's Shield, Encore, Disable and burn constrained the later endgame. Failed Sucker Punches coexist with successful ones; support denial was observed, with no operational defaults. |
| 10 | Opening Hyper Voice + Room executed in game 1; game 2 contained executed paired attacks and a Leech Life KO on Sableye. | Game 1 had three automatic turns and an inactivity loss. In game 2 Muddy Water and Hyper Beam explicitly missed; recharge, a later failed Sucker Punch and KOs before execution also mattered. Do not collapse these into one tactical cause. |

## What the batch does not prove

Keep three review tracks separate: tactical choices made from the known board;
uncertainty and variance such as critical hits, sleep and misses; and operation
failures such as stale submissions, missing choices and server defaults. This
batch had operational deadline incidents in sets 3 and 10, plus three excluded
acquisition attempts without controlled play. They support repairing control
and timing, not changing the roster on that evidence. An opponent concession
establishes the official result, not execution of our intended finishing move.

Before another authorized queue, apply the skill's play → conclude → update
cycle and exercise the relevant [behavioral cases](battle-regression-cases.md).
Preserve useful decisions alongside supported corrections; do not manufacture a
new rule when the evidence adds none. Mark an unresolved question explicitly;
neither a loss nor a favorable roll identifies a guaranteed winning alternative.
