# Live decisions, deadlines and watchdogs

## Keep the decision path short

Early operation spent too much of the live turn on full-state reads, repeated history, optional research and narrative notes. Making each component correct did not make the combined workflow timely.

The current interface puts the board, legal choices, named replacement options and deadline state into `battle_turn_status`. It retains current HP, status, boosts, items, field conditions and a bounded critical-event window. Full opposing open sheets appear at actionable preview; ordinary turns omit the repeated sheets and long history. Current own party information comes from the request, while unseen opposing selections remain unknown.

The useful order is:

1. Read the fresh request and current board.
2. Make an initial tactical judgment and stage or submit a complete legal choice.
3. If the choice is still staged and unsubmitted, refine it within the remaining time using actual MCP calculations when a numerical check is needed. Once sent, preserve its reservation and wait for or reconcile server progress instead of revising or resending it.
4. Write optional notes after protecting the deadline. Do long historical analyses and full reviews between BO3s.

Use revision-based `battle_wait` for progress instead of repeatedly fetching raw logs. Compact output reduces repeated context and round trips; it does not remove the time required for model reasoning. Numerical claims still require actual MCP damage and Speed results.

Implementation: [turn board](../../showdown/turn-board.mjs), [agent session](../../showdown/agent-session.mjs), [live action workflow](../../showdown/AGENT-WORKFLOW.md#read-calculate-submit).

## Staged plans take priority over emergency defaults

The agent makes the initial judgment and stages the complete actions required by the current request: a preview order, ordinary doubles pair or legal replacement combination. By default the watchdog only submits that plan. The separately authorized `emergencyDefaultChoice:true` option can now produce a deterministic legal default if no usable pair exists at the cutoff; it uses move metadata and request legality, with no damage heuristic, Speed calculation or tactical model.

While the request remains fresh and unsubmitted, the agent can replace its provisional pair or submit the final decision. With deadline protection explicitly enabled, the watchdog can send the staged pair at its cutoff. It rechecks freshness and legality immediately before sending, with a final check to avoid racing a manual submission.

Legality is not tactical quality. The emergency selector prefers ordinary attacks over conditional attacks, handles preview and replacements, and never activates Mega Evolution. It cannot predict protection or identify a winning move. Its `emergency-default` provenance is retained as an operational control failure, and future searches halt for review. A changed request, controller handoff, release or disconnect invalidates the old plan. Without the opt-in or a valid default, the existing bounded recovery applies. Sent or uncertain choices are never replaced merely because acknowledgment is missing.

Implementation and fixtures: [deadline supervisor](../../showdown/deadline-supervisor.mjs), [watchdog tests](../../showdown/deadline-supervisor.test.mjs), [control safety tests](../../showdown/control-safety.test.mjs).

## A local planning target is not a server deadline

Our initial containment was too aggressive: a missed local target could be treated as proof that the battle was stuck. That could turn a recoverable delay into an unnecessary forfeit.

The supervisor now distinguishes the configured planning budget from fresh observed server turn and total-bank clocks. Request age begins when the request arrives, not when the agent finally reads it. Repeated reads and controller handoffs do not grant more server time. A fresh timer-off observation revokes the cancelled timer's bounds; stale or different-request observations cannot establish a current emergency.

A planning overrun without a usable fallback halts future searches and raises attention, but the current set remains recoverable. The agent can still stage or submit a legal choice. Automatic stuck-forfeiture requires existing permission, a still-actionable unsubmitted request and verified current-request server-clock emergency evidence. An unknown clock or a local timeout alone is insufficient. A recovered overrun remains recorded as a control failure.

The fix separates recovery from abandonment. It does not excuse late planning or prove there will always be time to recover. See the [deadline policy](../../showdown/README.md#exclusive-controller-and-deadline-watchdog).

## A successful send may have no immediate acknowledgment

Another mistaken assumption was that every successful Showdown choice should promptly receive a live `sentchoice` acknowledgment. Ordinary choices can remain silent while the opponent is deciding. A missing acknowledgment therefore does not establish a disconnect, rejection, default or inactivity loss.

The client reserves a send before socket I/O. A returned send waits for actual server progress; an ambiguous write retains its reservation and requires reconciliation. Neither is blindly retried under a new command ID. Explicit rejection and a fresh corrected request are different evidence and can permit a deliberate new choice.

Keep these stages separate:

| Stage | What it establishes |
| --- | --- |
| Agent-selected or staged | The agent's intended plan; staging alone does not send it. |
| Sent | A local submission attempt; server acceptance may remain unknown. |
| Accepted | Matching server evidence when available. |
| Executed | Observed resolution attributable to the chosen action. |
| Could not act, default or inactivity | Separate observed outcomes, with uncertainty retained where evidence is missing. |

Implementation and fixtures: [client send reservation](../../showdown/client.mjs), [client tests](../../showdown/client.test.mjs), [control safety tests](../../showdown/control-safety.test.mjs).

## Make control ownership and outcomes observable

An exclusive controller lease prevents two helpers or agents from issuing conflicting mutations. A deliberate takeover checks the observed generation, revokes the old owner and invalidates its staged plan. Request tokens also bind the current session, connection, room, request and revision, so an old choice cannot become valid merely because another agent reads it.

Bounded control traces record request arrival, staging, sends, rejections and observed advancement. Use them to distinguish model/tool delay from server waiting and to measure request-to-send latency. A trace records control events, not the quality of the agent's prediction. Fixture tests cover races and failure branches; they do not establish end-to-end latency guarantees.

Implementation: [controller lease](../../showdown/controller-lease.mjs), [agent session](../../showdown/agent-session.mjs), [MCP controls](../../showdown/mcp-tools.mjs). Continue with [session recovery](SESSION-RECOVERY.md) or return to the [learning index](README.md).
