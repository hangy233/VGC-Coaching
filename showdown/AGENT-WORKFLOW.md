# CLI battle workflow: play → conclude → update

The supported automated live author is the [Codex CLI runner](../isolated/README.md), using the official CLI's ChatGPT sign-in. This guide describes its native ownership and review contract. [Architecture](../docs/ARCHITECTURE.md) explains the component boundaries; [client setup](README.md) covers authentication and local transport.

## Establish the session

The manager establishes explicit user authorization, unchanged approved team, account, one-set allowance and selected model/effort/tier. Replay publication, timer requests, emergency selection and pondering need their own permission. A credential, idle session, qualification pass or old scope grants no additional battle.

The manager prepares a compatible bundle of genuine complete saved native requests. Qualify the selected model and current interface with actual model-requested MCP returns, material paired/range work, same-game continuity and fresh-game reset under the original clocks. Do not fabricate missing menus, fill tactical inputs or substitute a saved JSON report for the provider's in-process proof.

Use the public CLI launch workflow. It retains the actual qualified provider for live use, rather than qualifying one process and silently replacing it. A new checkout supports MCP analysis immediately; live startup still needs compatible evidence, an explicitly authorized manual-ready client and exact session/scope files. Missing prerequisites fail closed.

Historical qualification sources keep their original team identity. When an
approved new roster lacks captures, the public runner accepts a separately
verified `scope.qualificationReference` binding as documented in the
[CLI guide](../isolated/README.md). It binds the genuine reference bundle to the
exact approved live export, account/session, authorization, source, guidance and
profile. This is model/interface qualification only: it supplies no new-team
battle evidence or prior team memory. Missing, stale or mismatched bindings
refuse; all native live identity and ownership checks still use the live team.

Before search, verify:

- The same authenticated account, exact team and fresh client session; remaining search allowance and official idle state.
- The loaded source hashes and actual model-facing schemas match the qualified implementation. Rebuilding MCP does not update a running client.
- Full current guidance was delivered, previous native review is complete and `battle_preflight` is ready.
- One exclusive owner, explicit deadline policy, `manualReady: true`/`autoReady: false`, and authorized timer/replay settings.

The healthy owned loop alone confirms intergame readiness. A readiness token is not a preview menu or a new authorization.

## Required skill and review checkpoint

Read the complete maintained [matchup skill](../skills/champions-mc-matchups/SKILL.md) and [BO3 cycle](../skills/champions-mc-matchups/references/headless-battle-cycle.md). Read the [team-building skill](../skills/champions-mc-teambuilding/SKILL.md) when evaluating roster construction; this does not authorize a change to the pinned six.

`battle_skill_status` checks source/installed agreement. Inspect the default `battle_skill_sync` dry run, apply only reviewed differences, then use `battle_skill_read` and read all required returned contents. Keep its content-bound receipt private. A new MCP process or changed guidance requires a new receipt; a host read alone does not prove delivery to the battle model.

Every fresh game thread receives the full verified matchup bundle inline. Subsequent frames can reference only identical static content already retained by that exact healthy thread. Logical source records preserve the full bundle. Thread loss, compaction or uncertain failure invalidates retained references. Complete facts/guidance must fit the8MiB packet bound and separate model-token headroom; never silently truncate them.

## Read, calculate, submit

The runner supplies the actual current board, known history, legal menus, open sheet and compact carried plan. Move metadata includes base priority and target class; own reported Speed and observed ordering are facts, not an effective-Speed ranking. The model still checks field, item, ability, status and priority changes and chooses any necessary numerical work.

The author receives eight read-only research tools:

| Purpose | Tools |
| --- | --- |
| Mechanics | `get_pokemon`, `get_move`, `get_ability`, `get_movepool` |
| Numerical questions | `calculate_damage`, `calculate_damage_range`, `calculate_speed` |
| Consequential paired sequence | `simulate_choices` |

The model supplies research inputs and one complete own/opposing pair when simulation is needed. The host binds private source/evidence fields. Final output is only the current `actions`, `planUpdate`, `reason` schema. No filesystem, shell, web, login, matchmaking, roster or unrelated tools are available to the battle model.

Current and frozen work share at most3calculator invocations and1simulation trajectory per native battle turn. A range call counts its outer invocation plus actual nested calculations. Failed or uncertain backend work stays spent. A replacement or reissued request does not renew the allowance. These limits are ceilings, not a request to fill them.

Use scalar checks first when they answer the question. Live historical spread inference is cache-only, reserving new numerical capacity for model-selected tactical questions. Unchecked hidden investments remain hypotheses. Simulator state comes from the native source/history plus explicit field-level assumptions, not model-copied live facts or host-authored strategy.

Choice admission uses fresh clickability and native legality, with no move/ability/callback whitelist. Preserve the authored move identity through native menu remapping. Read actual outcomes, action denial and pending replacements. A conditional single sample, critical hit or miss establishes no guaranteed removal, exhaustive range or KO probability. A paused turn is not completed material work.

For a pivot continuation, supply exactly the requesting sides; omit the other side. Prefer a named entrant or stable identity. Numeric switch slots refer to that future native replacement menu. Never force a replacement after a blocked pivot or completed turn. See [simulation](../docs/SIMULATOR.md).

## Exclusive control and deadline protection

A normal `battle_control_claim` acquires an idle session only when no other owner exists. The opaque lease remains private and accompanies mutations. A takeover is explicit and generation-bound; it clears the previous fallback. Do not acquire a competing owner to observe or diagnose an active loop.

The runner validates and reserves the complete final pair before native send. Selected, staged, locally sent, accepted and executed are different facts. Ordinary live sends have no routine acceptance acknowledgment; preserve the reservation while waiting for the opponent. A missing acknowledgment alone is neither a default nor a reason to resend.

### Deadline policy

All tool calls, model generation, evidence writes and final validation share the original request deadline. Observed server turn/bank time may shorten local caps. A timer-on message supplies no numerical clock. The configured unknown-clock bound is not a claim about server time, and no retry or replacement packet automatically restarts it.

Production policy is explicit in the authorized scope and checked against the loaded client. Separately authorized emergency selection uses fresh legality only, performs no strategic/numerical analysis and records operational provenance. A staged authored pair takes priority; reserved or uncertain sends cannot be replaced. Automatic forfeiture is not implied by a stopped model or a local target time.

### User-requested timer activation

With authorization, use the idle timer policy or startup `--battle-timer`. The native hook publishes an owned preview before requesting its timer and deduplicates existing/uncertain requests. Subsequent numerical server observations can refine the deadline; the request itself extends nothing.

### Maintained SDK operator and immediate recovery

On attention, keep draining the same runner's result stream. It retains the owner, source, original cutoff, send disposition and bounded recovery context. The next useful action protects that exact request through the available qualified recovery path or performs already-authorized containment; diagnosis and long reporting wait.

A typed known-not-sent failure can permit an explicitly corrected request within its original deadline. Uncertain stage/send/search operations are reconciled without blind retry. Do not construct a new helper, switch provider, authenticate or launch a competing controller during the clock. A successful outer wrapper is not proof its nested operation submitted anything.

An official child result can arrive during research or generation. The old response then has no choice authority. Retain it as superseded/unexecuted, distinguish it from unexpected staleness or deadline failure, and advance only through a healthy same-parent readiness/preview boundary. Never rebind its actions to a new child.

## Within and between batches

When explicitly authorized, pondering runs separately after known local submission against an immutable pre-send snapshot. It is read-only, shares the source-turn budget and cannot delay live work. Fresh requests/execution/uncertainty preempt it; unchanged wait polls preserve it. Revalidate factual dependencies and redo material checks before using speculative notes.

An independent observer relays each actual native child-game watch URL promptly in chat without delaying the author or adding a control round trip. Do not infer a URL from a canonical ID. Preserve authorized private suffixes. Official completion requires the exact parent result and all expected children, not a terminal-looking old room or intended finishing attack.

The runner handles one BO3 and pauses for review. A larger user-authorized batch still requires the full checkpoint between every search. Keep the client open between sets within that batch; do not queue automatically from a win or unused allowance.

## Conclude and improve

After official parent completion and server idle:

1. Finish authorized replay preservation and verify retrieval for each expected child. Provide the exact saved URLs within the user's sharing scope.
2. Flush metrics. Read the exact-team report with filters/quality/exclusions and each new child's evidence. Keep changed team versions separate.
3. Review decisive pre-action facts, plausible reads, chosen/sent/accepted/executed actions, useful partner progress, positive choices, variance and limits. Include failed generation/research and control issues, not just successful finals.
4. Record a supported reusable change with a counterexample, or a specific no-change judgment. Route strategy/basic mechanics to matchup guidance, roster principles to team building, control defects to tooling, and exact-team plans to private records.
5. Validate affected scenarios and countercases, sync/read reviewed guidance changes, save `battle_review_save` with the current receipt and actual citations, then verify `battle_review_status`.
6. Run exact-scope `team_metrics_finalize_bo3` dry run. Apply only reviewed covered retention; useful/protected traces may remain explicitly retained. Never delete evidence to clear a blocker.
7. Complete normal owned `battle_stop` at batch end and verify actual client/terminal exit. If the runner released its idle lease, the manager verifies the same exact session/result and claims normal ownership without takeover. An existing owner is not displaced.
8. After shutdown, use a fresh static native review-status check. Compare any late evidence append and obtain a reviewed revision; do not weaken the fingerprint or silently rewrite evidence.

At a batch boundary, synthesize recurring opposing cores and mechanisms, retain successful forcing sequences with limits, and audit their application at later opportunities. Repeated supported rule misses need a better shared trigger/check. Specific no-change is valid; a score or matching skill hash alone proves neither learning nor application.

Investigate every control failure, including recovered turns and failures inside wins. Record cause, repair/validated mitigation, failure/normal tests and runtime adoption. Unresolved control-compromising causes block another batch. Pending offline repair does not keep an otherwise completed client signed in; verify new qualified source at the next normal authorized startup, not through extra battles or authentication.

### Reports and privacy

Retain exact-team snapshots, source/seed hypotheses, actual calculation receipts, model journals, verified canonical/replay evidence, native reviews and current reports. Keep passwords, assertions, controller leases, skill receipts, opponent identities and private replay URLs out of public docs/skills/commits. Sharing a report can share its team and access links.

Use [metrics definitions and retention](../metrics/README.md) and the [required cycle](../skills/champions-mc-matchups/references/headless-battle-cycle.md) for complete checkpoint fields. These tools validate recorded evidence and adoption, not tactical correctness or battle authorization.
