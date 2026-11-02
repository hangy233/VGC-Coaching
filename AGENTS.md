# Champions M-C agent workflow

Use the maintained [Codex CLI runner](isolated/README.md) and [battle workflow](showdown/AGENT-WORKFLOW.md). Local MCP analysis remains available separately. Do not create another live decision loop or substitute a saved report for current selected-provider qualification.

## Responsibility boundary

- The matchup skill owns reusable battle strategy and basic mechanics. The team-building skill owns roster, role, set and coverage principles. Exact-team plans and private evidence stay in team-owned records.
- The battle model applies guidance, chooses actions, selects actual MCP research, authors its inputs and interprets returns.
- The runner supplies complete facts, guidance and legal menus. It relays tools and executes authored commands with mechanical identity, legality, ownership, cancellation and deadline guards. It selects no tactics, opposing branches or alternative actions.
- The manager prepares and qualifies the workflow, reviews completed sets, maintains guidance and repairs tooling between sets. Maintenance must not delay an active battle decision.

## Before live play

Authorization must identify the account, approved exact team, number of BO3s, model profile and any replay, timer, pondering or emergency permissions. Analysis, credentials and qualification grant no extra battles, roster changes, authentication, publication or Git operations.

For preview, decisions and replay review, read the complete maintained [matchup skill](skills/champions-mc-matchups/SKILL.md) and [BO3 cycle](skills/champions-mc-matchups/references/headless-battle-cycle.md). Use the [team-building skill](skills/champions-mc-teambuilding/SKILL.md) for roster work; reading it does not authorize changing the pinned six.

Before every search:

1. Verify account/team, remaining allowance and official idle state.
2. Check `battle_skill_status`. Review and sync changed guidance, then obtain a fresh `battle_skill_read` and read its complete returned contents.
3. Verify the previous native `battle_review_status` and current `battle_preflight`; resolve relevant blockers.
4. Qualify the actual selected CLI model/interface against genuine complete saved requests and actual model-requested MCP returns. Preserve source hashes, original clocks, material checks, same-game continuity and fresh-game reset. Authentication, a small probe, fixtures and copied JSON do not qualify. The manager prepares this input evidence; the user need not assemble it.
5. Verify loaded qualified source, tool schemas, policy and scope at normal startup. A source edit or MCP rebuild does not update a running client.

Use the official CLI's ChatGPT sign-in with an explicit model, reasoning effort and service tier. Production requires `--codex-context-mode session`; there is no API-key or paid-provider fallback. Check the actual CLI version and model availability rather than trusting an older catalog.

## Model tools and evidence

The live author receives eight read-only tools: `get_pokemon`, `get_move`, `get_ability`, `get_movepool`, `calculate_damage`, `calculate_damage_range`, `calculate_speed` and `simulate_choices`. The host binds private source/evidence fields. Final output contains only the current `actions`, `planUpdate` and `reason` schema.

Use actual MCP for numerical damage and Speed. Native Champions calculations use `gen: 0`; label unknown investments and unsupported conditions. Mental arithmetic, direct calculator fallbacks and invented receipts establish no benchmark.

Current and frozen work share **three calculator invocations and one simulated outcome per battle turn**. These are ceilings, not targets. Range queries count the outer call and nested calculations. Replacement/reissued requests and failed or uncertain backend work do not reset spent work. Use damage/Speed first; simulate only an unresolved consequential paired sequence.

For `simulate_choices`, the model supplies one complete own/opposing pair and explicit replacement continuations for that trajectory. The script tracks observable history and assembles known facts. Live historical spread filtering is cache-only: no new automatic numerical inference. Unchecked spreads, unseen reserves and hidden durations remain labeled hypotheses.

Admit actions by fresh clickability and native legality, without move, ability or callback support whitelists. Preserve authored move identities through menu remapping. Hidden state or a receive gap is a reconstruction issue. Conditional worlds expose field-level assumptions; a sample, unfinished replacement or sparse coverage cannot establish an unqualified material proof, exhaustive range or KO probability.

## Context, clocks and ownership

Deliver the complete verified matchup folder inline at each game's first fresh CLI thread. Later frames may reference static content retained by that exact healthy thread; every logical source keeps the full bundle for reconstruction. Invalidate references after thread loss, compaction or uncertain failure. The 8 MiB packet cap is not a model token-window guarantee. Preserve headroom and context/cache/latency measurements; never silently drop guidance or current facts.

Use manual readiness and verify `autoReady: false`. Only the healthy owned loop advances the current BO3. Preserve original request deadlines and uncertain-send reservations; do not retry potentially sent choices or searches. On attention, drain the same runner stream and protect the current request through its available recovery interface before diagnosis or reporting.

When explicitly authorized, a separate read-only ponder process may analyze an immutable pre-send snapshot after known local submission. It cannot send actions, extend clocks or mint current evidence. Fresh actionable state, execution or uncertainty preempts it; unchanged wait polls do not. Revalidate notes and redo material checks against fresh facts.

During each authorized BO3, print a labeled live watch link in chat for every new child game as soon as its actual native URL is available. Relay it through the independent observer without delaying the author or adding a control round trip. Preserve authorized private suffixes; never guess a URL from an ID. At completion, provide every child's exact retrieval-verified saved replay URL.

## Review, retain and close

Every BO3, including wins, forfeits, handoffs and final sets, requires a private decision review and skill checkpoint before another authorized search. Read actual decisive events, model requests/returns, exact-team reports and source receipts. Separate selected, sent, accepted, executed, defaulted, inactivity, terminal supersession and variance. Missing routine acceptance is not a default.

Record a supported reusable change with a counterexample, or a specific evidence-based no-change judgment. Route strategy/mechanics to matchup guidance, roster principles to team-building guidance and control defects to tooling. Keep team plans private. Sync/read changed guidance, save through `battle_review_save` and verify `battle_review_status`; never handwrite completion.

At each batch boundary, synthesize recurring cores/blocking mechanisms, preserve useful forcing sequences with applicability limits, and audit earlier private plans at later opportunities. Repeated supported rule misses need an improved shared trigger/check, not merely a private note saying they were covered. Do not invent edits when evidence supports no change.

Investigate every observed control failure, including inside wins. Record causes, repairs or validated mitigations, failure/normal countercases and adoption limits. Unresolved control-compromising failures block another batch. Validate offline; do not start extra battles, authenticate or restart merely to test a repair.

After the final official result and server idle, preserve verified replays, flush metrics, complete review and bounded retention, then call owned `battle_stop` and verify client/terminal exit unless a newer instruction keeps it open. Keep the client between sets within a batch. After shutdown, recheck the strict review fingerprint; compare late evidence drift and obtain a reviewed revision rather than normalizing it away. Preserve useful/protected evidence and keep credentials, leases, receipts and private access URLs out of public files.
