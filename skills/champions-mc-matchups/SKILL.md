---
name: champions-mc-matchups
description: Plan previews, leads, reserves and battle decisions, review replays, and run authorized Pokemon Champions Regulation M-C doubles BO3 cycles with a review and skill-sync checkpoint after each set. Use with an existing team; roster construction is a separate task.
---

# Champions M-C matchups

Explain how the user's existing six can reach a favorable position against the
opposing team. Distinguish playing the team better from changing its composition.

## Required cycle for live BO3 play

Cycle revision: **2026-10-16.17**. Read the bundled
[BO3 cycle and checkpoint](references/headless-battle-cycle.md) before live play,
including when resuming another agent's session. Before each new search, verify
the active installed skill matches this repository's complete skill folder and
the previous BO3's private review checkpoint is complete. Authorization and an
idle server alone do not complete this checkpoint. Prefer `battle_skill_status`,
`battle_skill_sync` and `battle_skill_read` for complete guidance adoption;
`battle_review_save` and `battle_review_status` for the private checkpoint; and
`battle_preflight` before the next authorized search. Readiness and content
delivery do not prove tactical judgment, and neither grants battle authorization.

After **every BO3**, including a win, forfeit, or final set in a batch: verify the
official parent result; save and verify each completed child's replay within the
user's sharing authorization; read the exact locked team's `team_metrics_agent_report`
and the new set's evidence as specified in the cycle; review decisions separately
from execution and variance; update supported reusable guidance or record why no
rule change is warranted;
check relevant regressions; sync changed files and read them into the active
context. Complete the cycle's durable-evidence and bounded cleanup checkpoint
before another authorized queue. Report a brief **review complete / lesson or no
change / sync verified**, plus replay coverage and any retained cleanup blockers.
Never invent a new rule merely to show activity.
This is an agent workflow requirement, not a review check enforced by `battle_start`.

Keep the client open between BO3s within an authorized batch. At the batch's
stopping condition, complete preservation, the final review and bounded retention,
then explicitly stop and verify the client, unless the user requests otherwise.
The cycle's [batch-end procedure](references/headless-battle-cycle.md#end-the-batch)
covers saved-login startup for the next authorized batch and preservation blockers.

Read [M-C rules and tool usage](references/mc-rules-and-tools.md) before mechanics
or calculation work. Read [source notes](references/sources.md) for the expert
frameworks and the limits of the current M-C report used as an example.
Read the team specified for the supplied battle or preview. That team takes
precedence over a newer saved team or the project's `cache/TEAM.txt`; a replay
may show an older variant. Use the latest paste and cache only to fill gaps that
do not conflict with the battle evidence. Also check `cache/REG.txt` if present.
Use `gen9championsvgc2026regmc` for M-C; never substitute another format silently.

## Start from what is known

Identify whether the user supplied a preview, an open team sheet, a live position,
or a completed replay. Separate revealed facts, justified inferences, and unknown
sets. List only the uncertainties that could change the decision. If the user
needs a live-turn answer, lead with an actionable play and its main alternative;
avoid delaying the answer for a broad metagame survey.

For a live position, establish active Pokemon, HP, boosts, status, consumed items,
Mega use, reserves, and weather/terrain/speed-control turns from the supplied
evidence. Do not infer an item solely from moving first, an ability solely from a
Seed activating, or a chosen move that never appears because its user fainted.
A single observed move order can be a speed tie. Missing details are not zeros.
Open sheets reveal the registered six and their published moves/items/abilities;
use nature and level only when supplied. They do not reveal the selected four,
unrevealed reserves, investments, or the next action. An empty observed-reserves
list does not establish that only the two active opponents remain.

For Perish or trapping positions, track each Pokemon's counter, the current trap
source and ability, switching eligibility, usable reserves, and latest safe
escape turn. Removing a trapper does not clear existing Perish counters, and a
switch route needs an available reserve. Do not infer Shadow Tag from Gengar's
species alone; verify its current form and ability.

## Team preview and a game plan

Identify the opponent's likely attacking combinations, speed control, support
that enables them, and alternate plans. Treat these as hypotheses unless revealed.
Consider their strongest plausible lead and a materially different opening.

Choose four with a reason for both the lead and the reserves:

- State the intended endgame and what must be removed, weakened, or preserved.
- Check whether the pair can act immediately, needs setup, or can safely switch.
- Account for the partner's best response: spread damage, a double target,
  protection, redirection, terrain, weather, or opposing setup.
- Explain an opening branch and a recovery route. A game plan is an objective
  with contingencies, not a script assuming the opponent cooperates.
- Mega Evolution is a battle resource; an eligible Mega need not be among the
  selected four, and carrying its weather/support partner is not compulsory.
  Compare immediate and delayed Mega Evolution when defensive typing or ability
  changes alter the incoming turn; greater offensive power alone does not settle timing.

A compact matchup entry can use:

| Opposing plan | Lead / back | Win condition | Opening branch | What changes the plan |
| --- | --- | --- | --- | --- |
| Verified or explicitly assumed mode | Two / two | Concrete endgame | Action plus opponent response | Reveal, HP, field turn, or speed change |

## Evaluate the turn

### Before committing a turn

Run these checks before finalizing a live recommendation; report only the checks
that change the play. Prepare the threat-to-answer map at preview and update it
after consequential reveals. Use the [battle regression cases](references/battle-regression-cases.md)
when reviewing these failure modes or testing changes to the skill. Read the
[live-battle lessons](references/live-battle-lessons.md) when preparing a live
cycle or reviewing the documented denial, weather, protection, and clock failures.

Make the read explicit: **plausible opposing paired action -> our paired response
-> main risk and alternative**. Use the open sheet and observed responses to form
these branches; use MCP damage and Speed to check their feasibility. A damage
maximum does not select the plan. Keep the note short, and submit first when the
clock cannot support optional explanation or additional calculations. When time
permits, `battle_note_decision` retains this reasoning against the observed action
token without submitting a move. Use optional calculator `evidenceContext` to
link actual MCP results; never invent a receipt or turn a prediction into a fact.

- **Switch-aware legality:** Evaluate the field when moves resolve, including
  plausible opposing switch-ins. Recheck priority, target eligibility, terrain,
  weather, and immunity changes; give a usable alternative if a switch disables
  the intended move. A selectable move is not necessarily an effective action.
  For our switch-ins, check both opponents' plausible attacks and their combined
  pressure; immunity to one move does not make the destination safe from its partner.
  If an opponent can pivot before our attack, evaluate the replacement occupying
  the targeted slot, not only the Pokemon present when the move was selected.
  Check move denial as well as survival: an earlier Throat Chop can disable a
  selected sound move even when its damage is resisted and Fake Out is blocked.
  Apply the same check to forced mid-turn replacements: identify which attacks
  remain pending and whether they can hit the incoming Pokemon after the trigger.
  For an escape pivot, check that it can resolve before the deadline: Fake Out,
  Protect, Encore, a knockout, or an invalid target can defeat the intended route.
  Verify the resulting switch and counter clearance rather than assuming success.
- **Preserve the answer:** Map each remaining opposing win condition to a primary
  answer, a practical backup, and required HP or field conditions. Before trading
  one away, check whether the remaining team still has a feasible endgame.
- **Order the damage:** State the required attack order and chip threshold when
  they matter. Check Protect, misses, redirection, and the first attacker fainting;
  do not count a second hit without a route to deliver it. Include speed-control
  expiration and the next board, not just this turn's damage total.
  Before setting or reversing speed control, name its beneficiaries among the
  actual active Pokemon and reserves, and the route through expiration. If a
  later reversal is essential, check whether the setter can survive and act then.
  If either side Protects, identify the progress still available to the other
  active Pokemon: a knockout, setup, recovery, or field control can decide the turn.
  Before a double target or support-plus-attack, name the active setup threat:
  if its partner Protects, can it boost or remove our key answer unopposed?
  Compare a pressure/disruption branch; accept that exposure only with a stated
  immediate payoff or a checked response to the resulting boosted board.
- **Check side effects:** Inspect incidental stat drops and other ability/item
  triggers on every affected target, including spread attacks and switch-ins.
  Compare the boosted opponent's next turn with the value of the immediate hit.
- **Adapt from evidence:** Between games, record observed response -> our
  adjustment -> their plausible counter-adjustment. Carry this into the current
  branch; one Protect or lead choice does not establish a fixed opponent habit.
- **Keep a legal fallback:** From the fresh request, identify a complete legal
  pair and stage it with `battle_stage_fallback` before optional research when
  the loaded client supports the enabled deadline policy. Hold the exclusive
  controller lease; a handoff requires an explicit generation-checked takeover.
  Follow the cycle's early-commit procedure and inspect `battle_turn_status`;
  immediately after preview, extract the current board and legal request in
  compact form and stage/send the pair before optional watch-URL messages,
  history reads or full-state output. Read full open sheets at preview; while
  live, render only the needed current board, legality and short new events.
  Preserve full observations internally and bound any newly essential mechanics
  read. Tool/output latency consumes the deadline from request arrival.
  An unverified numerical benchmark does not require delaying every legal play.
  Revalidate the pair after state changes. Check both the current-turn deadline
  and the total game bank: repeated animation reads, calculations, and context restoration consume
  the latter even when earlier turns were submitted. Keep a compact current-board
  note and stop optional analysis early enough to submit and verify the fallback.
  A successful local send can remain acceptance-unknown while the opponent
  plans: ordinary choices do not normally receive a live acknowledgment.
  Missing acknowledgment alone warrants neither a resend nor a forfeit.
  Missing the local planning target triggers attention and recovery; it is not
  proof that the server deadline expired. A repaired client allows a fresh legal
  pair during recovery and reserves automatic stuck-forfeit for a verified
  current server turn or bank emergency. Unknown clocks remain unknown.
  Reconcile an uncertain write separately and keep fresh requests protected;
  the cycle distinguishes that attention state from an unsubmitted request.
  After a context lapse or timeout, repair this workflow before another queue.
  If authorized to operate the battle UI, verify both
  selections and submission before the deadline; only claim acceptance when
  observed. UI submission is an execution responsibility, not something a chat
  recommendation accomplishes. In advice-only mode, leave submission to the user.

Compare a few plausible joint actions for both sides. Prefer a line that retains
useful options across reasonable responses when the position permits it. State
when a risky prediction is needed because safer lines do not leave a winning
route. Do not assign numerical probabilities to reads without evidence.

Verify the relevant moves, abilities, typing, target rules, and Speed. Calculate
damage on explicit sets before stating survival, a knockout, or a double target's
combined range. Consider Protect, accuracy, redirection, immunity, spread modifiers,
and whether the second attacker actually gets to move. Use the reference for
native Champions points and unsupported MCP field options.
Use actual MCP damage-tool results for calculated damage, KO probabilities, and
survival benchmarks. If the MCP cannot model the required state, mark that
benchmark unverified; do not substitute a direct calculator. Observed replay HP
changes remain observations, not calculated ranges.

Separate weather from terrain, physical Defense from special survival, and
single-target redirection from spread protection. Read a move's full mechanics
when the line depends on an exception; a short description is not sufficient.
Check both Pokemon when priority, an immunity, or a screen is involved. Removing
a field setter does not automatically remove an already established field.
For move order, compare priority brackets first, then Speed and applicable Trick
Room effects within the bracket. Recheck whether ability-based protection is
actually on the field when the move resolves; pivoting out Armor Tail removes
that protection. Do not treat a priority move as faster than every other priority
move or assume that a field effect and a holder-dependent ability persist alike.

In open sheets, use revealed sets without inventing their unrevealed investments.
In closed sheets, offer branches for consequential coverage or items. Between
games, update those branches using new information rather than repeating a lead
solely because the previous game was won.

## Review a replay without hindsight

For a saved team's history, use `team_metrics_agent_report` with its exact team
ID before drawing cross-game conclusions. The compact report includes the cached
team sheet, sample sizes, exclusions, descriptive observations and evidence links;
the cycle explains its freshness checks and private saved-file fallback. Use
`includeGames: true` or `team_metrics_report` when the relevant game evidence is
needed. Use `team_metrics_health` for missing replay/evidence/source diagnostics,
`team_metrics_game_annotations` for the append-only review audit, and
`team_metrics_compare` for descriptive comparisons of exact immutable versions.
Manual exclusions need a reason; disclose the resulting filters and sample sizes,
and inspect excluded games before drawing conclusions. Do not combine changed
team versions or treat review questions as findings.

Reconstruct decisive changes first, then assess selection and the opening. For
each important turn, record what was knowable before the action, the observed
result, and a feasible alternative from that exact position. A Pokemon switching
in cannot also use its move that turn. If changing an earlier turn enables a
later action, label the entire sequence as a counterfactual branch.

Do not infer poor decision-making solely from a loss, or sound decision-making
solely from a favorable roll. Distinguish execution, team structure, information
gaps, and unavoidable variance. Check whether an unused teammate provided a
practical answer before recommending a roster change. Include one concrete
adjustment to test rather than a list of speculative misplays.

For Encore, priority, weather changes, or a speed-control reversal, verify the
timing and what move or field state exists when the action resolves. Do not
promise a salvage line wins without checking the next board and remaining threats.
For a terminal Perish sequence, verify residual faint order, relevant Speed,
reserves, and win resolution in the actual format. Do not substitute Trick Room's
attack order for end-of-turn order or assume that the slowest Pokemon always wins.

## Deliver and keep scope

For preview: give the preferred four, lead, game plan, and the main alternative.
For a turn: give the recommended pair of actions, reason, and key risk.
For a replay: lead with the most consequential lesson, then a few supported
turn corrections and one next-game adjustment. Label hypothetical damage targets
and quote actual validation/calculation results only when they were obtained.

Keep the user's roster unchanged during analysis. If a repeated structural gap
warrants a change, explain the smallest useful revision and its opportunity cost;
do not update saved teams merely because advice was requested. Preserve prior
authorization when the user explicitly accepts a change. Never claim the skills
or the simulator establish a guaranteed win against unknown opposing sets.

## Play → conclude → update

Follow the bundled [BO3 cycle and checkpoint](references/headless-battle-cycle.md).
Locate the active VGC project's `showdown/AGENT-WORKFLOW.md` for its client API;
that project file is not relative to a globally installed skill. The agent supplies
strategy; an explicitly enabled watchdog can submit the agent's staged legal pair,
but generates no generic move choice. Review does not authorize
another set, a roster change, replay publication, or a new authentication attempt.
Honor an existing user request to save replays and clean completed BO3 artifacts;
do not ask again for that already authorized scope. Preserve room privacy and
keep private replay access URLs in ignored reports and checkpoints.
