---
name: champions-mc-matchups
description: Plan team preview, leads, reserves, and battle decisions or review replays for Pokemon Champions Regulation M-C doubles. Use for opposing-team matchups and counterplay with an existing team; roster construction is a separate task.
---

# Champions M-C matchups

Explain how the user's existing six can reach a favorable position against the
opposing team. Distinguish playing the team better from changing its composition.

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

A compact matchup entry can use:

| Opposing plan | Lead / back | Win condition | Opening branch | What changes the plan |
| --- | --- | --- | --- | --- |
| Verified or explicitly assumed mode | Two / two | Concrete endgame | Action plus opponent response | Reveal, HP, field turn, or speed change |

## Evaluate the turn

Compare a few plausible joint actions for both sides. Prefer a line that retains
useful options across reasonable responses when the position permits it. State
when a risky prediction is needed because safer lines do not leave a winning
route. Do not assign numerical probabilities to reads without evidence.

Verify the relevant moves, abilities, typing, target rules, and Speed. Calculate
damage on explicit sets before stating survival, a knockout, or a double target's
combined range. Consider Protect, accuracy, redirection, immunity, spread modifiers,
and whether the second attacker actually gets to move. Use the reference for
native Champions points and unsupported MCP field options.

Separate weather from terrain, physical Defense from special survival, and
single-target redirection from spread protection. Read a move's full mechanics
when the line depends on an exception; a short description is not sufficient.
Check both Pokemon when priority, an immunity, or a screen is involved. Removing
a field setter does not automatically remove an already established field.

In open sheets, use revealed sets without inventing their unrevealed investments.
In closed sheets, offer branches for consequential coverage or items. Between
games, update those branches using new information rather than repeating a lead
solely because the previous game was won.

## Review a replay without hindsight

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
