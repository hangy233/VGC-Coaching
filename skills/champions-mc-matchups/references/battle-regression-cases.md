# Battle decision regression cases

Anonymized review scenarios, not reconstructed battle logs or win guarantees.
Use the actual team version, open sheets, HP, field state and clock. Check
mechanics and all damage through [M-C rules and tools](mc-rules-and-tools.md).
Do not publish private replay access URLs, player identifiers or session logs.
For the evidence and counterexamples behind the live-play cases, read
[live battle lessons](live-battle-lessons.md). These are behavioral review
scenarios; passing means a justified legal decision and honest attribution,
not matching a prescribed move or a string in the skill.

| Scenario | Expected checks | Regression failure |
| --- | --- | --- |
| Priority into a possible terrain switch | Grounded target at execution, revealed Psychic Surge, first-turn eligibility, useful alternative | Checking only current terrain or assuming every target is protected |
| Trading the sole endgame answer | Map remaining threats, survival and speed; compare immediate-loss alternatives | A locally good trade leaves no credible route against the last threat |
| Chip before a finishing attack | Current form/ability, actual move order, full-HP ability, recovery, Protect and misses | Summing isolated full-HP ranges as guaranteed combined damage |
| Speed-control transition | Preserve the useful slow attacker, plan the fast reserve's entry and first turn after expiry, and check opposing reversal/priority | Resetting Room without a surviving beneficiary, exposing the cleaner by habit, or ignoring the transition |
| Item or set comparison after a failed game | Compare complete plausible plans from preview, changed moves, entry/lock costs, operational failures and actual opportunities | Declaring superiority from bench/Protect/already-attacked/Room counts or requiring the alternative to repeat the failed sequence |
| Secondary stat-drop trigger | Include possible Competitive/Defiant switch-in and branch on the drop | Treating a secondary effect as guaranteed or ignoring its ability trigger |
| Special hit beside a later physical attack into Stamina | Include the Defense raise after the damaging special hit, then assess the physical partner's delivery; distinguish the defense each move uses | Claiming Moonblast or Earth Power does not trigger Stamina, or banning useful special pressure because it triggers a physical Defense raise |
| Opponent adapts between games | Reassess four, leads, observed Protect and counter-adjustment | Repeating a winning lead automatically or treating one Protect as certainty |
| A temporary advantage is established | Name the obstacle, useful attack or entry, and surviving pair after control expires | Spending the advantage on repeated passive turns or rushing an attack that cannot be delivered |
| Safe-looking play leaves no winning route | Compare the resulting endgame with a plausible forcing read and its failure branch | Choosing survival by habit, or taking a risky prediction when ordinary pressure already covers the finish |
| Timer default versus intended choice | Record complete paired submission, server acknowledgement when available and actual execution separately | Crediting a default setup as a deliberate safe setup opportunity |
| Perish escape | Active trapping holder, remaining reserves, legal switch/pivot, countdown and partner survival | Assuming an unverified pivot or unavailable reserve saves the position |
| Conditional attack | Count selections, executions, conditional failures, flinches and KOs separately | Calling a denied action an executed failure or inferring unconditional value |
| Sucker Punch after blocked Fake Out | Check whether the target still has a pending damaging action after earlier priority resolves; compare ordinary pressure or another pending attacker | Assuming Armor Tail blocking Fake Out makes its user eligible for a later Sucker Punch |
| Recovery under pressure | Effective HP gained, overheal, entry damage, move order and subsequent survival | Counting full-HP hits as healing or calling recovery proof of safe entry |
| Paired progress | Both opponents, partner KO route, Protect/redirection, current ability holder | Judging one failed move without its partner's progress, or assuming a departed holder protects priority |
| Helper faints before its ally attacks | Whether support already resolved, effect recipient and duration, receiver's attack delivery, both our slots | Treating the helper's KO as cancellation of already-applied Helping Hand, or counting a helped attack that never executes |
| Delivery before payoff | Incoming joint damage, speed and denial before outgoing range | Calling a high damage roll a usable plan when the attacker cannot act |
| Psychic Noise beside a draining attacker | Whether Noise can reach the user before its attack, current immunity/protection/ability, existing Heal Block, non-draining alternative and partner progress | Counting Leech Life damage while treating Heal Block as only lost healing, or banning drain when Noise hits the partner or cannot apply first |
| Revealed Encore / Disable support beside King's Shield | Last executed moves, actual lock timing, current priority protection, partner target and legal switch route | Repeating a damage-only answer while both actions can be denied; claiming Armor Tail blocks every use of those moves |
| Protection beside a setup threat | Model both the protected target and its partner's boost, including Disguise or other progress already made | Calling a spread hit free progress while ignoring Swords Dance, or declaring setup decisive without checking the next turn |
| Threatened target has preservation value or a safer recipient | Identify its answer role, credible knockout pressure, plausible selected reserves, both attacks into the recipient and partner progress; compare split pressure | Doubling by damage alone, assuming a switch is certain, or treating a registered reserve as selected |
| Current form and weather pivot | Rebuild the execution board after switches, weather moves and Mega Evolution; identify any forced replacement | Using rain or a Mega ability because its provider is on the roster, or treating an Emergency Exit replacement as optional analysis time |
| Mega Sol beside actual rain | Verify current Mega Meganium ability and its move's effective weather; include Fire Weather Ball and immediate Solar Beam while checking the partner's actual weather separately | Calling its Weather Ball Water from the rain icon, assuming a charging turn, or treating Mega Sol as a global sun setter that disables rain Electro Shot |
| Our favorable weather can be overwritten | Prioritize the incentive-supported opposing overwrite branch, actual setter availability and activation order; recheck Weather Ball type, immunity, Speed and both slots; compare a type-stable attack or preservation line | Treating current weather as secure, assuming every registered setter was selected, or automatically counter-switching without checking partner progress |
| Weather setter reenters the same active weather | Track the original activation and expiry; distinguish setter entry from a new weather activation | Restarting the rain count merely because Drizzle reentered during existing rain |
| Setup with a support partner | Delivery of the boost, joint incoming pressure, HP cost, disruption and next-turn payoff | Calling default-selected or Encore-forced Soul an intentional setup line; inferring an uncritical KO from a critical one |
| Recharge turn | Include the recharge board, partner's useful action, opposing switches and loss of control | Recommending a finishing Hyper Beam using only this turn's range or treating one miss as proof the move is always wrong |
| Low total bank during a handoff | One control owner, fresh request and clock, legal paired fallback, verified send and conditional acceptance evidence | Repeating stale choices until expiry or crediting a server-default action to the intended policy |
| Optional research consumes the turn | Identify the complete legal pair first, use the early-commit buffers and total bank, verify send, refresh after a new request | Finishing every calculation before choosing, treating an observer alert as submission, or sending the old pair after a forced replacement |
| Preview advances while a large status response is rendering | Immediately extract the fresh current board/token/legality, count request age and tool latency, stage/send before optional URLs or history; retain full observations internally | Reprinting sheets/history until the unsubmitted first turn times out, or treating rendering completion as a new planning window |
| Operator pauses after staging, or before any fallback exists | Inspect enabled policy; stage the exact current legal pair before optional work; independently reconcile watchdog send or authorized stuck-forfeit and halt | Treating staging as acceptance, inventing a generic move, retrying an uncertain send, or queuing again after containment |
| Local planning target passes while server time remains | Enter recovery attention, preserve legal current-set staging, halt future searches, and use verified turn/bank emergency evidence for automatic forfeiture | Forfeiting merely because 20 or 30 local seconds passed, or treating an unavailable clock as a server expiry |
| Timer observation arrives late or the timer is explicitly disabled | Replace only provisional unknown bounds with fresh real evidence; revoke cancelled timer eligibility; retain provenance and reject stale observations | Latching an early unknown bound as a server deadline or forfeiting at a timer deadline that was cancelled |
| Valid preview, move or replacement sent while the opponent waits beyond five seconds | Preserve its send reservation; ordinary live acknowledgment is absent; wait for observed progress without automatic halt, resend or forfeit | Treating no acknowledgment as a missed own turn or forfeiting an otherwise waiting set |
| Socket write is uncertain, then a fresh request arrives | Bounded reconciliation and attention, future-search halt, no blind resend or automatic forfeit from missing acknowledgment; still stage/submit fresh requests | Treating uncertainty as acceptance, treating a halt as permission to abandon current turns, or forfeiting solely from an acknowledgment timeout |
| Party order changes after a server default | Fresh forced request, named replacement identity, complete switch/pass combinations and final legality validation | Reusing an earlier index or counting a rejected switch as sent |
| Two operators attempt recovery | One current lease; generation-checked takeover; old lease revoked and old fallback discarded; receiver stages anew | Concurrent control, repeated stale takeovers or assuming the same controller label retains ownership |
| Authorized emergency defaults with no staged pair | Verify loaded opt-in policy; revalidate one complete current pair, no automatic Mega, distinct emergency provenance and operational exclusion; staged or reserved sends retain priority | Generating without authorization, claiming strategic judgment, duplicate sends, or hiding defaults in clean team results |
| A receiving MCP process starts but cannot reach the signed-in client | Verify its actual read-only status access to the same session/team before transfer or a new queue; retain one responsible operator until acknowledgment | Treating process startup as working controls or leaving the live board unattended during pipe-access setup |
| Batch boundary with saved login available | Keep the client through intermediate BO3 checkpoints; after the final durable preservation/review and bounded retention, stop and verify it; carry remaining authorization into the next approved batch | Disconnecting mid-batch or before preservation, closing only an MCP helper, or treating a saved credential/new client as extra battle allowance |
| Winning batch avoids the previously blocking core | Compare exact versions, roster/selection/opportunity counts, control and variance; carry the unencountered weakness forward and retain evidenced winning plans | Declaring the matchup fixed from the overall score or discarding earlier failed batches |
| A carried plan meets a later opportunity | Read the trigger and branches, distinguish intentional application/execution/conversion, and retain valid deviations or unknowns | Claiming adoption from a matching hash, forcing the card into its counterexample, or inventing an opportunity from roster presence |

## Counterexample exercises

- **Batch patterns and follow-through:** Supply a prior batch with a repeatedly
  selected setup core and a later winning batch with that species only registered
  once but never selected. A passing review keeps the weakness untested, separates
  control failures from tactical evidence, and preserves actual winning sequences
  with their conditions. Then provide a batch with an eligible answer-preservation
  opportunity, one documented application, a recurring missed application, and a
  board matching the card's counterexample. The reviewer records each separately,
  improves the application trigger rather than duplicating the old rule, and does
  not count a reasonable deviation as failure. Cross-set citations belong in the
  final checkpoint's validation text, not another parent's decision evidence.
- **Reinforce a winning sequence:** Supply successful split pressure through one
  foe's Protect, a critical final KO and a concession before a proposed finish.
  A passing batch review retains the observed partner progress, leaves normal-hit
  necessity and the unplayed finish unresolved, and carries a concrete forcing
  plan into the next preparation. Contrast a necessary double target and a board
  where preserving the setter is essential: the plan must allow those branches.
  A source/installed hash match alone cannot establish later tactical application.
- **Convert initiative:** Give a healthy Trick Room board with one opposing
  obstacle to the reserve attacker, then a board where Room is about to end and
  the fast reserve holds a Choice item. A passing operator preserves the
  slow attacker when useful, names the obstacle and closing pair, and compares
  a covered switch or spent-support trade with continued pressure through
  expiration. It checks the cleaner's first attack, switch recipients, opposing
  Room reversal and priority; no extra attack is credited on its entry turn.
  Contrast a necessary second Room window with a surviving slow beneficiary and
  a board where the cleaner must enter early to avoid immediate loss. The operator
  can take either branch when justified, rather than always resetting Room or
  always keeping the cleaner back. A defensive turn that earns partner removal
  differs from two passive actions that only spend useful control.
- **Compare complete item plans:** Supply a loss where a fast attacker entered
  during its own Room, used Protect and later attacked before being KOed; another
  game contains a generated choice, and another leaves it benched. Compare a
  stronger unlocked set with a faster Choice set that also changes moves. A passing
  review reconstructs an earlier slow-attacker/fast-reserve plan as well as the
  actual sequence, checks reachable entry and lock resets, and separates piloting,
  operations and structural limits. Contrast a board where the fast set cannot
  cover recovery or a necessary target without the lost power/move: the reviewer
  retains that cost and may favor the unlocked set there. Neither isolated counts
  nor the proposed alternative proves overall superiority or a flipped result;
  numerical feasibility still requires actual MCP evidence.
- **Force a response:** Give a threatened foe likely to Protect beside a setup
  partner, then a sole remaining foe with Protect, and then an obstacle whose
  removal requires both attacks while its partner has little progress. A passing
  operator compares partner pressure, useful positioning and a double target;
  it can double in the latter cases when justified, and keeps an attacking or
  sacrificing response possible. It does not call a failed double inherently
  bad or assume a defensive read is certain.
- **Purposeful trade and risk:** Give a spent setter whose sacrifice creates a
  useful attacker entry, then the same setter as the only feasible route to a
  necessary second control window. Add a losing passive line with one plausible
  forcing read, then an advantageous board covered by ordinary paired pressure.
  A passing operator can accept the purposeful trade or supported read, preserves
  the necessary answer in the counterexample, and avoids needless prediction
  when ahead. It names what the trade buys and what a wrong read loses without
  promising an alternate win or treating aggression as permission to ignore
  known immunities, denial, deadlines or actual MCP requirements.
- **Draining-attack denial:** Supply a Leech Life user facing an opposing Psychic
  Noise that can act first and affect it, with an ally able to Protect or attack.
  A passing operator compares a non-draining attack or protected positioning and
  preserves the partner's useful action; a resisted Noise is still a denial risk.
  Contrast Noise targeting the partner, being blocked, or acting after the drain:
  the operator can retain Leech Life when its delivery is justified. It checks
  existing Heal Block and later expiry rather than treating the move as globally
  unusable, and uses actual MCP for any numerical damage or Speed claim.
- **Early commitment:** Compare a short clock with a useful but unavailable
  numerical check, a new forced-switch request that invalidates the old pair,
  and a healthy clock with a known priority blocker. A passing operator commits
  a current legal pair without inventing the missing benchmark in the first,
  rebuilds the replacement in the second, and respects the known blocker in the
  third. It treats the buffers as operational cutoffs, not a reason to send a
  knowingly ineffective first move or assume the server will choose for it.
- **Conditional attack:** Give the reviewer a Sucker Punch user facing a revealed
  King's Shield or Rage Powder, then a second board where an attacking target
  must be removed before its hit. A passing review evaluates paired responses
  and remaining routes in both boards. It can retain Sucker Punch when justified;
  it must not turn one failed read into a universal ban or promise an alternative
  wins without checking its delivery.
- **Pending attack:** Supply an opposing Fake Out that Armor Tail blocks before
  our helped Sucker Punch, then a different foe with an ordinary damaging move
  still pending. A passing review rejects Sucker Punch into the already-acted
  Fake Out user, compares an ordinary attack or the other target, and checks
  Protect, redirection and partner progress. It can retain Sucker Punch into the
  pending attacker without inventing a knockout or banning it for the whole turn.
- **Deadline containment:** Supply a staged pair followed by a shortened clock,
  a new request that invalidates it, and an operator pause before any pair exists.
  A passing operator distinguishes the configured runtime behavior from assumed
  protection, preserves sent/accepted/executed uncertainty, and stops searches
  after stuck containment. Without stuck-forfeit permission it does not enable
  forfeiture or assume the client will invent a legal move. In all cases numerical
  claims still require actual MCP calculator results.
- **Large-output transition:** Supply a completed preview followed by a fresh
  first-turn request inside a large snapshot with old events and already-read
  sheets. A passing operator renders the needed current board, legal actions,
  clock/age and short new events, then stages/submits before optional watch-URL
  messages or history. Its deadline still runs from request arrival. Contrast a
  preview whose full open sheet has not been read and a turn with a new critical
  mechanic: the operator reads the needed sheet or bounded mechanic detail rather
  than hiding consequential information to make the output small. It preserves
  MCP-only numerical checks, the existing cutoff and the distinction between a
  successful sent choice waiting for the opponent and a fresh unsubmitted turn.
- **Planning and emergency:** Supply a 90-second preview, a missed 30-second
  planning target and a legal pair staged at 40 seconds. A passing controller
  rescues the current request, records the planning failure and keeps future
  searches halted for review. Contrast a genuinely verified short turn/bank
  emergency, an unknown clock, a timer explicitly disabled after recovery began,
  and an observation failure: only the verified current emergency permits the
  authorized automatic forfeit. Unknown or failed reads need bounded attention,
  without a hot retry loop or invented deadline. A sent choice waiting for the
  opponent remains reserved throughout.
- **Replacement and takeover:** Supply a forced request with one live reserve in
  party slot four, then a later reordered request and two claimants using the
  same observed generation. A passing operator selects a fresh named legal
  identity and a complete switch/pass pair, respects the winning lease, and
  rebuilds the discarded fallback after transfer. It does not guess slot three,
  resend a rejected action unchanged, or claim ownership from its label alone.
- **Opponent still planning:** Supply separately a valid preview, paired moves
  and a forced replacement whose local send succeeds, with no live acknowledgment
  or advancement for longer than five seconds. A passing operator reserves each
  send, leaves acceptance unknown and waits without resending, halting or
  forfeiting. Contrast an uncertain write, which needs bounded reconciliation,
  attention and a future-search halt without an automatic forfeit, with a genuinely
  unsubmitted request lacking a legal fallback. After the uncertain write, supply
  a fresh actionable request: it still needs prompt protected submission.
- **Protection and progress:** Compare our Protect + partner KO route with a
  support-plus-attack aimed into Protect while the other foe can boost. A passing
  review credits the first partner's progress, models the boosted next board in
  the second, and also credits a broken Disguise when that actually happened.
  It does not score every protected attack or defensive turn as a misplay.
- **Preservation incentives:** Supply a threatened target that is the opponent's
  remaining answer to our attacker, a revealed healthy reserve that takes both
  intended attacks better, and an active partner that can set up. Compare a board
  where that reserve is merely registered, then one with no legal switch or
  Protect and a necessary removal that needs both hits. A passing operator weighs
  Protect/switch against attacking or sacrificing, evaluates both actions into
  the recipient, and compares split pressure or useful support. It can still
  double when the resulting branch justifies it; it neither predicts defense
  with certainty nor invents a numerical KO. The retained read must be separate
  from the observed result and any later explanation.
- **Support preservation:** Supply a board with Farigiraf active, relevant
  priority denial on the open sheet and a possible switch, then a board where
  keeping Farigiraf loses immediately to direct attacks. A passing review checks
  whether priority protection still exists at resolution and whether a Room
  reset can execute. It preserves the setter only when that retains a feasible
  route, rather than treating preservation as an unconditional rule.
- **Early support:** Compare an opposing Helping Hand user fainting after it
  helps its ally, our helper fainting while its recipient can still attack,
  and a helped recipient that Protects or faints before acting. A passing review
  tracks the recipient's effect and actual attack delivery independently from
  the helper's survival. It checks the resulting paired pressure without
  inventing an unsupported numerical Helping Hand benchmark.
- **Weather incentives:** Supply our rain attacker facing Flash Fire beside an
  opposing confirmed reserve Torkoal, then an unspent Mega Charizard weather
  change, then a setter only registered on the sheet. A passing operator treats
  the useful override as a leading response, reconstructs Weather Ball's type
  and both opponents' progress, and compares a type-stable attack or setter
  preservation without inventing a numerical payoff. Contrast a confirmed
  unavailable setter and a weather pivot that gives our partner decisive free
  progress: the operator can retain Weather Ball or attack when justified. It
  neither assumes an override is certain nor always answers with its own pivot.
- **Weather duration:** Compare Politoed reentry while rain is already active
  with reentry after rain has ended or been replaced. A passing review retains
  the existing rain window in the first board and checks a new Drizzle activation
  in the second. It models the partner's action and the expiry transition rather
  than assuming every entry refreshes rain or that a weather pivot guarantees
  survival.
- **Actor-specific weather:** Supply Mega Meganium with Mega Sol using Weather
  Ball or Solar Beam during actual rain, alongside an ordinary rain attacker.
  A passing review checks its effective sun before selecting a Grass-, Water-
  or Fire-weak switch-in, while retaining actual rain for Politoed Weather Ball
  and Archaludon Electro Shot. Contrast ordinary Incineroar Fire pressure that
  rain really can reduce. Do not invent numerical survival or silently apply
  Mega Sol to other actors; unsupported MCP states stay unverified.
- **Attribution and uncertainty:** Supply an accepted selection whose user
  faints first, a defaulted Soul, an Encore-forced Soul, an explicit miss, a
  critical-hit KO and a concession before the finishing move. A passing review
  classifies each correctly and leaves unsupported numerical benchmarks open.
  Actual MCP damage and Speed calls remain mandatory for numerical alternatives;
  a missing supported state never authorizes direct-calculator fallback.

For each case, distinguish facts from hypotheses; one result cannot validate a
roster replacement or prove a different move would have won. Preserve useful
adaptation even after a loss. Test revised rules on counterexamples before the
next authorized queue. Follow the skill's play → conclude → update cycle.
