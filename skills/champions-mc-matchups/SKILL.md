---
name: champions-mc-matchups
description: Plan previews, leads, reserves and battle decisions, review replays, and run authorized Pokemon Champions Regulation M-C doubles BO3 cycles with a review and skill-sync checkpoint after each set. Use with an existing team; roster construction is a separate task.
---

# Champions M-C matchups

Explain how the existing six reach a favorable position. Distinguish better play
from changing the roster.

## Roles and research

This skill owns reusable battle strategy and basic mechanics. The battle model
applies it, chooses actions and actual MCP research, authors inputs and interprets
returns. The runner supplies current state/guidance and executes authored commands
with identity, legality, ownership and deadline guards. It selects no tactics.
The root manager prepares authorized scopes, reviews between sets, maintains
guidance and repairs tooling. Route roster/role/set/coverage work to the
[team-building skill](../champions-mc-teambuilding/SKILL.md); keep exact-team plans
private and the approved roster fixed.

The supported live author is Codex CLI with subscription ChatGPT login, explicit
model/reasoning/tier and retained per-game session context. It has eight declared
battle tools and outputs only `actions`, `planUpdate` and `reason`. No API-key
fallback, host strategy screen, preauthored research branches or separate staging
tool belongs to this path. See the [CLI cycle](references/headless-battle-cycle.md)
for genuine saved-position qualification and loaded-source verification.

Use actual MCP `calculate_damage` and `calculate_speed` for numerical questions,
not mental arithmetic or a direct calculator. Live research shares at most
**three calculator calls and one simulated outcome per battle turn**, including
frozen waiting-time work. A range request also charges actual nested numerical
dispatches. Replacements/reissued requests do not reset capacity; a failed or
uncertain reserved call does not refund it. These are ceilings, not goals.

Prefer the smallest useful check. Use `simulate_choices` when known facts and
scalar results leave a consequential paired sequence unresolved. Author one
complete own/opposing pair; the tool assembles source-bound history and labels
hidden spreads, reserves, counters and native initialization assumptions. Live
historical spread inference is cache-only and starts no new automatic numerical
work. An unchecked profile remains conditional. One outcome proves neither a
range, probability, guaranteed knockout nor tactical approval. Broader offline
analysis does not expand the live budget.

## Required cycle

Cycle revision: **2026-11-03.126**. Before live play and after a handoff read the
complete [BO3 cycle](references/headless-battle-cycle.md), including its
[search gate](references/headless-battle-cycle.md#before-a-new-search).
Verify complete-folder status, reviewed sync and content read; previous private
review; genuine selected-model/MCP qualification of the current interface; loaded
adoption; and `battle_preflight`. Credentials or unused allowance grant no play.

Every set, including wins, forfeits and the final set, needs the
[checkpoint](references/headless-battle-cycle.md#conclude-every-bo3) and
[validation/adoption](references/headless-battle-cycle.md#update-validate-and-adopt-before-continuing).
Report **review complete / lesson or no change / sync verified**, replay coverage
and cleanup blockers. Use native save/get/status; never handwrite completion.

Every user-defined batch also needs private
[pattern synthesis](references/headless-battle-cycle.md#synthesize-each-completed-batch),
[shared-guidance review](references/headless-battle-cycle.md#update-shared-guidance-before-the-next-batch)
and [control repair](references/headless-battle-cycle.md#repair-every-batch-control-failure).
Repeated rule misses require a supported trigger/order/check correction; specific
evidence-based no-change is valid. Per-set no-change alone is not a batch review.
Finish durable preservation/review/retention and
[normal shutdown](references/headless-battle-cycle.md#end-the-batch); pending
offline repair does not keep an otherwise completed client signed in.

Read [rules/tools](references/mc-rules-and-tools.md) before mechanics/numbers and
[source notes](references/sources.md) for evidence limits. Use the exact supplied
team/version and `gen9championsvgc2026regmc`; a newer paste cannot overwrite the
battle's sets. Fill only nonconflicting gaps, and disclose missing registration.

## Start from what is known

Separate preview, open sheet, current board and replay. Distinguish facts,
supported inferences and unknowns; name uncertainties that could change the pair.
Lead live advice with the actionable pair and key alternative, not a metagame survey.

Establish actives, HP, boosts/status, consumed items, actual form/Mega use, selected
reserves and field/control age. Missing details are not zeros. Moving first
proves no item; Seed consumption alone proves no ability. A pre-action faint
alone reveals no selected move. Use the retained private authored command when
available, separating selection from its unexecuted outcome; a preview plan,
earlier request or previous game cannot replace that command. Open sheets reveal
registered six/moves/items/abilities
and nature/level only when supplied, not selected four, investments or next
actions. Empty observed reserves does not mean only two opponents remain.

The script tracks observable history. Gaps or hidden counters can require
explicit conditional native worlds, not a ban on a clickable move. Preserve known
HP, boosts, items, PP and current identities; never relabel a default as observed.
No support whitelist decides choice admission. Inspect assumptions and coverage
before treating a returned sample as material evidence.

Carry observed move order with actors, moves, priority, field/abilities/items and
possible tie, separate from compatible Speed/spread hypotheses. Follow
[order inference](references/mc-rules-and-tools.md#infer-speed-from-observed-move-order)
before reuse on a changed board. Unknown investment does not erase a useful
constraint. At a later preview also read the actual early denial/pre-action KO
sequence and failed cover. A terminal plan or order note is not that history;
if absent, state the limit rather than claim learning or resolution.

On Perish/trap reveal, annotate counters, current trap holder/form/ability,
usable reserves and latest eligible escape. Before repeated chip/Protect, name
the escape or finish left when counters expire. Include pivots and item-triggered
reentry restoring a trap. Removal does not clear Perish counters; an offered
switch or `maybeTrapped` is no proof of escape. Check a removal-dependent escape
sequence before relying on it. Purposeful Perish trades remain valid with a
concrete remaining finish; species alone proves no trapping ability.

## Team preview and game plan

Read [proactive win plans](references/proactive-win-plans.md). Choose a forcing
pair and next-board conversion. Protect, preservation and switches should earn
an attack window or retain an answer, not merely delay defeat. Aggression does
not waive delivery checks or mean doubling every target.

Choose **front two with a shared opening task and back two with named jobs**
against a plausible lead and materially different opening. Identify obstacle,
closer, each reserve's entry/first useful window, forgone role and second-turn
pair against both foes' responses. Opening damage alone supplies no four-Pokémon
plan. Mega is optional; its weather partner is not compulsory. Compare immediate
and delayed evolution when defensive typing or ability changes incoming pressure.
A named fast reserve supplies no attack window against available opposing control;
apply the [control-response comparison](references/proactive-win-plans.md#choose-the-route-then-create-pressure).

Against screens/setup/drain, use the
[conversion plan](references/proactive-win-plans.md#break-screens-and-recovery-backed-setup):
commit to setter or attacker removal, turn denial into attacks/entries, and stall
only while opposing progress is contained. If one foe repeatedly denies the
route, name what the next pair changes about its attack before spending another
action on its partner. Reassess after board changes.

Compact preview intent: opposing plan → front-two task → back-two jobs/entry
windows → next pair/endgame → plausible alternative and change condition.
Keep this in the authored reason/plan, not an invented tool field or delayed note.

## Evaluate the turn

Use [bounded planning and delivery](references/turn-planning.md). Start from fresh
facts and carried objective. Any selected switch, form/field change or entry
ability triggers the same scan: **resulting recipients/field/forms → reactive
effects and priority → each needed actor's delivery → useful delivered progress
and remaining answer**. A reset alone earns no attack window. Setter entry is not
necessarily a new field activation; retain observed field age until a setting
event changes it.

When immediate damage spends a resource, leaves the blocker or loses an entry/
control window, compare an attack-plus-positioning line's next useful pair.
Positioning must earn progress. Before submission bind each named move to that
actor's **fresh clickable menu**, slot, target and Mega choice; registered order
or a previous request is not the runtime command map.

Resolve current recipients and plausible switches, redirection, entry effects and
Mega forms before crediting an action. An immune target requires revision or an
explicit expected recipient, stay-in failure and useful partner payoff; a possible
prediction proves no opposing choice. Missing recipient metadata is no all-clear.
See [recipient reads](references/turn-planning.md#read-current-recipients).

Apply the [required-actor contract](references/turn-planning.md#resolve-required-actor-delivery-and-recovery)
to setup, required attacks, entries, stopping setters and preserving answers.
For each necessary actor/resource: if denied or lost, what delivered partner
progress and remaining answer survive? A risk disclaimer, partner Protect,
renamed chip or unprovided reserve alone supplies no continuation. Ordinary useful
chip, purposeful trades and unavoidable finishing gambles remain legitimate with
their actual payoff and limits.

After denial/pre-action KO, start the next decision with its cause. After Protect
erases progress or recovery restores the target while spending an answer, ask
what changes the next heal, boost or attack. A changed target alone is no
conversion. Compare concrete pressure, disruption, control or entry against both
replies before repeating the failed sequence.

### Before committing

- **Switch-aware eligibility:** Resolve both actions' targets, entry forms, field,
  current trap and escape timing. A plausible opposing setter switch precedes
  field-dependent priority and can change ordinary attack order too. Preserve
  both stay-in and entry branches as uncertainty; do not infer selection.
- **Reactions before chip:** Check recipients on both sides, including opposing
  ally-targeted stat support. Resulting ability/boost and support order precede
  the actor-delivery check. A damaging secondary drop is possible, not certain;
  compare the no-drop branch and a useful alternative when the boost breaks the
  payoff. Retain necessary pressure or a purposeful trade without a blanket ban.
- **Needed actor after those changes:** Check both foes' eligible hits/denial into
  each actor and later answer. A simulated action attempt is not successful
  delivery; acting before fainting is not surviving. If partner disruption covers
  the attack, verify its eligibility after recipient/field changes.
- **Preserve the actual answer:** Name primary answer, usable backup and HP/field/
  entry needs. A setter can remain needed for a later reset despite current
  weather. Compare Protect or checked replacement before spending it on chip.
  When waiting for opposing Speed control to expire, count the complete
  [stall and entry sequence](references/proactive-win-plans.md#stall-opposing-speed-control-without-spending-the-finisher).
  Prioritize the attacker denying that window over support whose effect already
  resolved, unless immediate partner threat changes the trade. Preservation is
  not absolute; a delivered trade or checked backup can justify spending it.
- **Expect contested fields:** Available beneficial overwrite is a leading
  plausible reply, not a measured probability. Verify setter availability,
  actual activation and form before reusing order/weather. Keep attack/Protect
  alternatives. See [weather lessons](references/live-battle-lessons.md).
- **Read preservation incentives:** A credible KO, needed answer or better
  recipient strengthens Protect/switch plausibility. Compare double versus split/
  support and the partner's progress, while retaining attack/sacrifice. Double
  remains useful for required removal, recipient pressure or limited partner
  progress; state payoff/failure rather than intent.
- **Order the damage:** Scalar checks establish benchmarks; an unresolved required
  removal before retaliation needs the one actual paired outcome. Name the
  target and action/deadline it must prevent. Inspect ordered damage/denial,
  surviving foes and next board, not summed ranges. Choose the most consequential
  plausible opposing pair; other responses stay untested. Include control expiry,
  actual beneficiaries and any required later reset. Support or Protect can allow
  opposing setup/recovery; compare its payoff with pressure and a checked answer.
- **Adapt from evidence:** Carry observed response → adjustment → plausible
  counter-adjustment. One lead/Protect proves no fixed habit, and a win alone
  justifies no automatic repetition.
- **Protect the clock:** No routine acknowledgment or optional explanation should
  delay a useful final pair. Respect source/deadline/reservations and actual
  tool limits. When a needed check is unavailable, prefer a viable nondependent
  plan; otherwise name the necessary gamble. Never invent numerical evidence or
  another outcome after capacity is spent.

Read full mechanics for consequential exceptions: contact, typing, targeting,
ability, field and order. Priority brackets precede Speed; Trick Room reverses
Speed within a bracket, not priority. Protection follows the holder at resolution:
withdrawing Armor Tail differs from a persistent field. Weather and terrain,
physical and special survival, redirection and spread protection are separate.
Use [live lessons](references/live-battle-lessons.md) and
[regression cases](references/battle-regression-cases.md) for affected failures and
counterexamples.

## Review without hindsight

Follow the cycle's [exact-team metrics procedure](references/headless-battle-cycle.md#read-the-exact-teams-metrics).
Inspect actual sheet/version, games, cutoff, warnings, filters and child coverage,
including exclusions. Counts, health and annotations cannot invent evidence or
causes. Team/roster advice needs actual opportunities, not bench rate alone.

Reconstruct decisive changes and opening knowledge. Each correction needs a
feasible exact-position alternative and limitation. A switch entrant cannot attack
that turn; an earlier setup requires a labeled whole counterfactual sequence.
Compare item/set plans from preview through control, preservation, entry and first
attack, including moves, locks, reset costs and lost coverage. Transplanting an
item onto a failed final board proves no superior plan.

Separate tactical judgment, execution, structure and variance. A win, loss or
favorable roll establishes none alone. Check an unused teammate's practical
answer before recommending a revision. Give one concrete next test, not a
speculative misplay list. For terminal Perish use actual-format residual faint
order, Speed/reserves and win resolution; Room attack order is not residual order,
and slowest does not automatically win.

## Deliver and keep scope

Preview: four, lead, plan and alternative. Turn: pair, reason and key risk.
Replay: supported lesson, positive choice, correction and next test. Label
hypotheses and quote only actual calculations/validation. Keep roster unchanged
without explicit approval. Shared guidance and simulation guarantee no victory
against unknown actions/sets.

After every set and batch complete the required cycle, replay coverage, private
review, supported shared update or specific no-change, control repair, retention
and normal shutdown. Guidance work grants no extra sets, publication, roster
change, authentication or Git operations. Keep private room access and detailed
team evidence out of shared sources.
