---
name: champions-mc-teambuilding
description: Build, refine, or audit Pokemon Champions Regulation M-C doubles teams, including roles, sets, stat-point spreads, and matchup coverage. Use for team construction and roster changes; use matchup analysis for choosing four or reviewing an individual battle.
---

# Champions M-C team building

Create a legal team whose members support an executable plan. Preserve the user's
chosen Pokemon, originality preference, and desired playstyle unless they ask to
reconsider them. Explain the cost when a preference makes the team less reliable.
Do not turn one replay or one successful team into a mandatory roster template.

## Establish the format and evidence

Read [M-C rules and tool usage](references/mc-rules-and-tools.md) before validating
sets or calculating benchmarks. The format is `gen9championsvgc2026regmc`.
Use [the source notes](references/sources.md) when explaining the methodology or
following an online guide. Older guides supply decision-making methods, not
Champions rosters, items, mechanics, or stat spreads.

Read the user's latest paste and, where present, the project's `cache/TEAM.txt`
and `cache/REG.txt`. Explicit user instructions take precedence over cached
choices. A request for another regulation must not silently receive M-C data.
Identify important constraints from context; ask only for missing preferences
that materially change the build. Establish singles versus doubles, ladder
versus a tournament, and open versus closed sheets when they affect the task.

Use the connected VGC MCP for current data and checks. Discover its actual
schemas; the reference documents this project's known limitations and fallback.
Verify candidates and moves before recommending them. Search results establish
existence, not regulation eligibility. Validate complete sets and the final six.

For metagame evidence, record the format, period, and source of usage or tournament
results. If M-C statistics are unavailable, say so; use explicitly labelled M-C
reports or a provisional threat list, not another regulation's usage rankings.

## Build around a reason

- Describe the intended way to win and the partner interaction that enables it.
  Choose a coherent starting core rather than filling six type-chart slots.
- Assign each addition a concrete job: creating an attack opportunity, controlling
  speed, preserving a key attacker, improving a matchup, or enabling another mode.
  Explain what it contributes in actual pairs and groups of four.
- Check offensive pressure and defensive switch options together. A resistance
  alone is not a counter if the Pokemon loses to coverage, boosts, or the partner.
- Count setup actions. If the plan needs weather, a screen, redirection, and a
  boost before dealing damage, identify which are optional and how it attacks
  when the opponent denies setup.
- Construct a usable lead and back pair before calling a mode complete. Evaluate
  whether two modes compete for the same support, item, terrain, or Mega action.
  Two Mega Stones may provide preview options, but only one Mega can be used
  in a battle.

## Choose sets and stat points

Choose moves and items for their intended jobs, checking Champions learnsets and
the full team's item allocation. Protect, priority, redirection, pivoting, and
speed control have opportunity costs; none is a universal per-slot requirement.
Explain a consequential omission when it changes how the Pokemon must be played.

Start with a simple stat-point spread. Make it more complex only to meet named
benchmarks. Specify the target's form, nature, investment, item, relevant ability,
and field conditions. Distinguish an assumed test target from a revealed or
well-supported current set. Check:

- Exact Speed before and after the relevant boosts, drops, Tailwind, or Trick Room.
- A needed knockout or combined attack range, accounting for accuracy and both
  opposing Pokemon; do not equate a favorable damage roll with a guaranteed turn.
- Survival of a relevant hit, with the actual item consumption and current HP.
- What the remaining points accomplish. Do not invent a precise threshold to
  justify a convenient split; a mixed-bulk baseline may be stated honestly.

Use native Champions calculation as documented in the reference. Pass the actual
Mega form and its post-Mega ability; include pre-Mega ability effects separately
when they matter. A one-use berry does not repeat across a multi-hit-KO estimate.
Use actual MCP damage-tool results for calculated damage, KO probabilities, and
survival benchmarks. If the MCP cannot model the required state, mark that
benchmark unverified; do not substitute a direct calculator or invent a threshold.

## Check matchup coverage and iterate

Build a small matchup map from verified M-C opponents relevant to the user, not
an exhaustive list of every Pokemon. Include the main opposing mode, your lead
and reserves, required speed or damage benchmark, setup denial, and fallback.
Test combined threats such as terrain offense plus a Fighting attacker or a
weather attacker plus Helping Hand. A coverage move against one species does
not establish a workable matchup against its team.

Against opponents with materially different modes, such as sun and rain in one
six, test the proposed four against both plausible openings and transitions.
Identify which answers overlap and which depend on selection or weather control;
do not call the matchup covered because separate specialists exist among all six.
If different selections are needed, state the preview evidence guiding the choice.
Include plausible alternate opposing Mega choices in this test. Track our own
Mega allocation too: a teammate left in base form retains that form's properties,
including abilities that can force a switch and expose a reserve mid-turn.
Test entry before Mega Evolution separately from competition for the Mega slot:
having only one Mega candidate does not remove its base-form switch-in vulnerability.
For mixed-speed selections, identify which members benefit from each speed-control
state and how the selected four transition between them. A slow support Pokemon
does not by itself justify Trick Room beside a fast attacker or fast reserves.

When Perish/trapping is relevant, stress-test a complete selected four against
the trapper and its support. Identify which members can escape, which need the
trapper removed, the reserves required, and the partner that enables each route.
Test a blocked or disrupted pivot and depleted reserves: Fake Out, Protect,
Encore, or a knockout may prevent an apparent escape. Verify actual trapping
abilities and deadlines; the presence of a pivot move alone is not coverage.
Assess support such as priority protection for what it actually enables. Distinguish
a structural lack of escape routes from a piloting or submission failure before
changing a role, move, or slot; no anti-trap option is mandatory on every team.

Prioritize weaknesses by frequency, severity, and whether better selection or
positioning already addresses them. Change a role or slot when a problem repeats
or the structure lacks a reasonable plan; do not prescribe a Dark type, a weather
setter, or a stock support Pokemon after every isolated loss. When proposing a
replacement, identify the role gained, the role lost, and a matchup that worsens.

Separate building from testing: a legal, calculated team is a starting build,
not a ladder-tested or tournament-proven team. Use replay evidence to compare
each member's intended role with its actual contribution and revise the weakest
assumption first. Novel choices should have a useful job beyond surprise value.
Unused reserves in a short win do not establish a wasted slot; assess their
contingency role and evidence across relevant matchups before removing them.
Treat execution complexity as a roster cost: required setup, narrow entry windows,
repeated precise reads, and competing preservation needs affect practical reliability.
Separate a missed available line from a plan that repeatedly offers no robust line.
For comparison builds, record observed opportunities, selections, and successful
executions separately; an offered action with a boosted foe is not automatically
a safe Haze opportunity. Check what a reset removes from both sides before valuing it.
For recovery moves, record effective HP restored, not just successful hits; for
conditional attacks, distinguish condition failure from sleep, flinch, KO-before-action,
or unsubmitted intent. Compare lost coverage and the partner burden alongside benefits.
Measure threatened coverage alongside delivered damage: record opposing Protect,
target choices, and simultaneous partner progress, but do not infer why the
opponent protected or claim the same progress was impossible without that threat.
When adding protection, classify the observed denial first: spread attacks,
single-target attacks, priority, or action/submission failure. Evaluate Wide Guard
against spread pressure and redirection against eligible single-target pressure;
neither covers every category. Count the support action and lost moveslot, and
do not assume a setter can protect the team and set Trick Room on the same turn.

## Deliver the result

For a complete build, provide a pasteable Showdown export using Champions stat
points, a short role explanation, usable lead/back selections, the important
benchmarks, and the largest unresolved matchup. For a single-set request, keep
the answer focused on that set and its interaction with the existing six.
Report the format and actual validation outcome, source dates, and testing limits.

An advice or review request does not itself authorize replacing a saved team.
When the user requests or accepts a revision, save it in the established project
location and synchronize the current-team cache as appropriate; preserve a useful
prior variant. Do not require a second approval for an already authorized change.

## Evaluate through controlled play

Use the matchup skill’s [play → conclude → update cycle](../champions-mc-matchups/SKILL.md#play--conclude--update) and [headless agent workflow](../../showdown/AGENT-WORKFLOW.md).
Keep each approved team version fixed for its bounded evaluation. Separate
selection, execution, timing and variance before attributing results to the
roster. Propose evidence-backed changes, obtain approval, validate legality,
and pin the next team version before a new authorized cycle.
