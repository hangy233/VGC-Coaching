# Why live battles moved to a CLI runner

This project began as an MCP server for Pokémon data and team advice. Live BO3
battles added a harder requirement: understand a changing board, check important
numbers, and submit paired actions before a real deadline. A reliable calculator
alone could not make that whole workflow reliable.

The supported design now uses a local script to drive Codex CLI, with one retained
model session per game. The model owns tactics and MCP research, the script owns
state delivery and execution, and a manager reviews sets and maintains guidance.
See [the architecture](../ARCHITECTURE.md) for the current components. The API and
conversation-driven prototypes have been removed.

## What went wrong and what changed

### Slow decisions were mistaken for broken connections

Early workflows fetched state repeatedly, relayed it through chat, requested
research, wrote notes, then submitted. Delays caused avoidable restarts and
forfeits. A quiet server could simply be waiting for the opponent; missing
acknowledgment did not prove a disconnect.

We separated request arrival, model invocation, tool start/end, choice arrival,
local send, server progress, and official result. Sends reserve the request
before socket I/O. Uncertain sends remain reserved until reconciled rather than
being retried blindly. Controller leases and request identities prevent competing
operators and stale actions. Re-reading a request never resets its age.

Local planning targets are distinct from observed server clocks. The watchdog can
send a previously authored pair; an explicitly enabled emergency default is
containment, recorded as a control failure. It is not tactical intelligence. An
inactive opponent needs the server timer, not repeated move submissions.

### Login, reconnection and readiness needed a separate lifecycle

Short-lived helpers made authentication fragile. Terminal prompt failures and
Windows process-cleanup errors were hard to diagnose. Room privacy suffix changes
could also look like a lost battle while the connection remained healthy.

One terminal process now owns the authenticated connection; local tools use a
named pipe or Unix socket. Authoritative room renames migrate owned state and
invalidate stale tokens. Genuine reconnection requires fresh observed state and
reconciliation of submissions and remaining allowance, never automatic replay of
an uncertain command. Errors are bounded and redacted by stage.

The hidden password prompt remains available. An optional Windows credential
broker performs the fixed login exchange without exposing the password to the
model. Credentials grant no extra battles. Manual readiness prevents a stopped
decision loop from opening another game. The client stays open within a batch
and normally closes after durable preservation and review.

### Chat delivery stayed slow even when tools were fast

Some traced turns spent tens of seconds before requesting context that was already
prepared. Polling, host wake-up, scheduling, transport, reasoning and retries were
initially mixed together. Local assembly took milliseconds; ordinary native
calculations were much faster than the complete decision path. That did not prove
every unexplained second was model reasoning.

We tried direct submit-and-receive tools, waiting receivers, lower reasoning,
longer safe local windows, compact context, and Work Cloud event delivery. Push
removed some polling, but HTTP 200 established webhook receipt, not model delivery.
Scheduled tasks could remain bound to an older conversation. Clipped source parts
and targeted recovery added round trips. Offline first-choice timings still
varied, including late refusals. A synthetic wake-up could not qualify a live
research turn.

An isolated OpenAI API loop made invocation boundaries clearer and worked without
the conversation handoff, but required separate credits and key setup. Codex CLI
offered explicit local invocation using supported ChatGPT sign-in. We updated the
CLI, discovered its actual model catalog, pinned model/reasoning/service-tier
settings, and retained saved-position qualification. CLI use still has provider
latency and usage limits.

### Context growth involved schemas, results and transport limits

Repeated guidance, sheets, schemas, board descriptions, candidate plans and
research results made context large. Splitting it into many parts preserved bytes
but introduced completeness and recovery problems. Resending everything wasted
time; retaining an unlimited session risked growing model context.

The current session begins with complete maintained guidance and team/sheet data.
Later turns supply current metadata and verified references to unchanged material.
Each game starts a new session with compact useful set memory. Lost or changed
material must actually be delivered again. A receipt does not prove comprehension.

A stream bug separately sized output headroom from a small prompt while returned
tool results were much larger. Transport allowances now account for admitted
source and tool output. Byte caps protect local handling; they do not enlarge a
model's token window. Bytes, tokens and latency are separate measurements.

### Host tactics created a second decision maker

Automatic threat screens, candidate pairs and preauthored result branches were
intended to reduce thinking. They duplicated skill rules, obscured who chose a
tactic, and could favor damage while ignoring positioning and preservation.
Neither legality nor a completed calculation made the plan sound.

The skill now teaches generic mechanics and strategy. The battle model selects
leads, reserves, actions, research questions and MCP inputs. The runner supplies
facts and executes mechanically; the manager reviews between sets. Preview needs
an opening and a route for the back two. Turn reasoning must consider both
opposing actions, delivery, Protect/switches, weather resets, setup, and which
resource must survive for the endgame. A damage number cannot replace this plan.

### Most simulator refusals were wrapper and reconstruction gaps

The native Showdown engine already supported effects the wrapper refused. Missing
state included consumed items, Unburden, Mega transitions, targeting, trapping,
switching and secondary effects. A spread move given an invalid target was also
different from an unsupported move. Requiring exact hidden spreads was unrealistic.

Scripts now track observed events and initialize the native engine; the model
provides moves or switches rather than rebuilding the board. Selectable choices
follow request legality instead of a second move-effect whitelist. Unknown
investments use explicit hypotheses/ranges. A representative trajectory is not a
guarantee across every spread, roll or opponent reply.

Simulation output initially repeated full worlds and assumptions across several
samples. Live output now contains one compact end-of-turn trajectory. Damage and
Speed questions use cheaper calculators; simulation is for material paired
sequences. A turn shares three numeric calls and one simulation, including
replacements. Automatic history-based spread inference consults compatible cached
evidence only: it previously spent the numeric allowance before the model could
ask its decisive question. Unavailable checks never become mental estimates.

### Records had to distinguish evidence from intent

Raw logs accumulated, watch links expired, and operational losses distorted team
results. Selected moves, observed uses, blocked execution, item removal and
knockout attribution needed separate counters.

Reports identify exact team versions, retain useful turns and verified saved
replay references, and distinguish control-affected games from the default
performance sample. Changed sets create new reports. The recent-team catalog is
bounded; deletion or eviction cleans team-owned data. Disposable logs are removed
only after durable evidence exists. Public source and release packages exclude
credentials, private teams and battle archives.

History supports focused counterfactual checks, not certainty that a changed move
would have won. Review earlier setup, preserved reserves and the later cleanup
route before blaming one turn or a roster slot.

### Reflection needed verified adoption

Some repeated mistakes already had a written rule. Another paragraph did not
prove the live model received or applied it. Exact-team plans also made shared
strategy noisy.

Every BO3 now has an evidence-backed private review before another search. Batches
add recurring-pattern analysis, shared-guidance review and investigation of every
observed control failure. Transferable lessons update the relevant skill;
team-specific answers stay private. Validate a correction and a counterexample,
sync the complete folder, and verify loaded adoption. Source edits never update a
running process. A justified no-change conclusion is valid; repeated misses need
a clearer trigger or decision check rather than “already covered.”

## What the evidence establishes

The current design removes conversation relay and redundant host tactics, keeps
actual MCP research, and makes invocation/execution boundaries measurable.
Qualification checks complete source, legal choices, material research, original
deadlines, retained sessions and interruption behavior. Fixtures, authentication,
a models list or an old report cannot substitute for actual selected-model
qualification after a changed live path.

Clean recent sets are encouraging observations, not proof that latency, network
or tactical failures are solved. Compare equivalent saved positions, include late
and failed turns, and assess judgment separately from speed and score. The system
improves retained instructions and tooling; it does not train model weights or
guarantee better results.
