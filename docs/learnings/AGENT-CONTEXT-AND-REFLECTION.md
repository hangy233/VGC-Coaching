# Agent context and reflection

These lessons describe the implemented interface and its review workflow. They concern how an agent obtains evidence, tests an explanation and carries useful guidance forward. They do not establish that a particular model or team performs better.

## Start with the exact question and team version

A large battle archive is useful when an agent can retrieve the relevant part. The working sequence is: identify the exact team version, read a filtered agent report, follow supporting game references, inspect decisive turns, then make the numerical checks needed for the question. Verify the cached sets, sample sizes, exclusions, freshness warnings and unknown information before drawing conclusions. Changed moves, items, natures or investments belong to separate versions.

The [report workflow](../../metrics/README.md#reading-reports-as-an-agent) and [synthetic example](../examples/TEAM-REPORT-EXAMPLE.md) make this sequence concrete. A short turn range is a starting point: expand it when earlier setup, weather changes or reserve preservation affect the position.

## Preserve distinctions that change the interpretation

Observed execution, chosen action, local send, server acceptance and inability to act are different facts. A protocol move announcement counts as an executed use; an unexecuted choice does not. An inability-to-act event cannot reconstruct the intended move. Failed, missed and blocked outcomes can overlap uses, and called uses are a subset rather than extra attempts. Item removal and knockout attribution need their own observations.

Reports exclude incomplete, operationally affected and manually excluded games by default. Operational or manual exclusion of a child also excludes its parent from default set performance. Inspect excluded records when diagnosing control behavior, and disclose the filters. Unknown reserves remain unknown. These definitions in the [report generator](../../metrics/agent-report.mjs) prevent descriptive counters from becoming invented intent or performance evidence.

## Test a hypothesis without claiming an alternate history

Low move usage and matchup losses identify questions, not automatic replacements. Inspect whether the move had a useful opportunity, what its threat enabled for the partner, and what coverage a replacement loses. A better available line with the existing team differs from a structural gap.

Use actual MCP damage and Speed calculations with explicit current forms, abilities, status and supported field conditions. Label unknown opposing investments and unsupported inputs. [Retained calculator evidence](../../workflow/calculations.mjs) records actual inputs/results; it does not prove the reconstructed state was correct. A calculated ordering change or survival benchmark is a local finding, not proof the revised team would win after both players adjusted.

## Reflect after every BO3 without forcing a new rule

The [required cycle](../../skills/champions-mc-matchups/references/headless-battle-cycle.md) reviews successes and mistakes after every completed set, including the last one. Separate piloting, team limitations, control failures and variance. Preserve useful decisions from losses and examine poor trades from wins.

A reusable lesson needs supporting evidence, relevant scenario validation and a counterexample or applicability limit. If existing guidance already covers the issue, or the evidence is inconclusive, record a justified no-change outcome. Repeatedly adding rules to demonstrate activity creates noise.

When guidance changes, edit the maintained source, validate, sync and read the changed instructions before continuing. Save and verify the [review checkpoint](../../workflow/reviews.mjs), complete retention and inspect preflight before another authorized search. The tools check recorded evidence and adoption; tactical judgment remains the agent's responsibility. This persists guidance and evidence, not model weights, and guarantees no performance gain.

## Make startup explicit across hosts

Standard MCP tools do not guarantee that every host discovers skills or displays instructions identically. The [startup guide](../AGENT-STARTUP.md) supplies copyable instructions, while server initialization advertises a shorter reminder. A trusted startup setting selects the installed-skill parent; complete guidance still needs to be read. File-edit access is needed to change source instructions: sync installs reviewed content rather than writing lessons.

Plain-language requests are sufficient. Named MCP prompt templates are a possible discoverability improvement, not an implemented feature; slash-command presentation would depend on the host. Neither instructions, credentials nor templates grant additional battle authorization.

## Reduce repeated context and measure honestly

Existing controls include filtered briefs, optional detailed games, bounded evidence references, capped game indexes/review signals, focused turn reads and compact live boards. They reduce unnecessary repetition without replacing complete required guidance or protecting a deadline by skipping evidence.

The [token-efficiency guide](../TOKEN-EFFICIENCY.md) documents remaining limits: some sections grow with history, expanded games are not paginated, and this server measures neither provider tokens nor model cost. Payload bytes are not model-independent token counts. Pagination and optional host-supplied usage telemetry remain design directions. Evaluate future changes with comparable questions, evidence coverage, latency, host-reported usage and decision quality rather than an unmeasured savings percentage.
