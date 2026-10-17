# Lessons from building an agent-operated battle interface

Engineering and coaching-workflow notes collected on 2026-10-17. These explain the problems we encountered, the changes that addressed them, and the limits that remain. They are reusable design lessons rather than a substitute for the maintained [battle workflow](../../showdown/AGENT-WORKFLOW.md) or [required BO3 cycle](../../skills/champions-mc-matchups/references/headless-battle-cycle.md).

The central lesson: **slow reasoning, ordinary server waiting, stale control state and a real connection loss need different responses.** Treating all four as a stuck battle caused avoidable retries, restarts and forfeits.

| Topic | Lessons |
| --- | --- |
| [Live decisions and watchdogs](LIVE-BATTLE-CONTROL.md) | Keep the critical path short; stage a complete agent-chosen fallback; distinguish local planning targets from server deadlines and a send from execution. |
| [Sessions, identity and recovery](SESSION-RECOVERY.md) | Separate the authenticated client from MCP helpers; handle room renames and stale requests; recover genuine disconnects without replaying uncertain actions. |
| [Agent context, evidence and reflection](AGENT-CONTEXT-AND-REFLECTION.md) | Retrieve relevant history progressively, preserve evidence boundaries, validate lessons, adopt updated guidance and support different agent hosts. |

## What improved, and what remains

The latest retained six-set audit at the time of writing covered 15 games and 182 observed requests. It recorded zero observed own forfeits, server defaults or inactivity losses, alongside 20 planning recoveries and 21 fallback sends. Nine child games were operationally flagged. These are aggregate observations from one local batch, not a controlled performance benchmark or evidence that all timing problems are solved.

The changes improved failure containment and removed known false-forfeit causes. They do not make model reasoning instantaneous, guarantee a good staged plan, eliminate network failures or establish that a team revision improves results. Missed planning targets remain operational failures even when recovery saves the set.

Useful next measurements are request-to-choice latency, planning recoveries, fallback sends, actual server defaults, disconnections and decision quality under comparable tasks. Read these alongside sample sizes and exclusions; a lower token count or faster submission alone does not establish better play.

## Related documentation

- [Agent startup guide](../AGENT-STARTUP.md): model-neutral setup and copyable startup instructions.
- [Token efficiency](../TOKEN-EFFICIENCY.md): current retrieval controls and their limits.
- [Synthetic report example](../examples/TEAM-REPORT-EXAMPLE.md): measured observations and evidence-linked questions.
- [Showdown client](../../showdown/README.md): supported controls and failure behavior.
- [Team metrics](../../metrics/README.md): reports, imports, quality exclusions and retention.
- [Maintained matchup lessons](../../skills/champions-mc-matchups/references/live-battle-lessons.md) and [regression scenarios](../../skills/champions-mc-matchups/references/battle-regression-cases.md): tactical guidance and its applicability checks.

Keep future entries focused on the trigger, mistaken assumption, implemented response, supporting evidence and remaining limits. Use anonymous examples and aggregate observations; keep private replay access links, account details and raw battle records in the private report store.
