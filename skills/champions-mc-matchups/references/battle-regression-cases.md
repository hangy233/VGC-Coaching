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
| Speed-control transition | Count remaining turns and model the first turn after expiry | Reversing Trick Room by habit or ignoring the transition |
| Secondary stat-drop trigger | Include possible Competitive/Defiant switch-in and branch on the drop | Treating a secondary effect as guaranteed or ignoring its ability trigger |
| Opponent adapts between games | Reassess four, leads, observed Protect and counter-adjustment | Repeating a winning lead automatically or treating one Protect as certainty |
| Timer default versus intended choice | Record complete paired submission, server acknowledgement and actual execution separately | Crediting a default setup as a deliberate safe setup opportunity |
| Perish escape | Active trapping holder, remaining reserves, legal switch/pivot, countdown and partner survival | Assuming an unverified pivot or unavailable reserve saves the position |
| Conditional attack | Count selections, executions, conditional failures, flinches and KOs separately | Calling a denied action an executed failure or inferring unconditional value |
| Recovery under pressure | Effective HP gained, overheal, entry damage, move order and subsequent survival | Counting full-HP hits as healing or calling recovery proof of safe entry |
| Paired progress | Both opponents, partner KO route, Protect/redirection, current ability holder | Judging one failed move without its partner's progress, or assuming a departed holder protects priority |
| Delivery before payoff | Incoming joint damage, speed and denial before outgoing range | Calling a high damage roll a usable plan when the attacker cannot act |
| Revealed Encore / Disable support beside King's Shield | Last executed moves, actual lock timing, current priority protection, partner target and legal switch route | Repeating a damage-only answer while both actions can be denied; claiming Armor Tail blocks every use of those moves |
| Protection beside a setup threat | Model both the protected target and its partner's boost, including Disguise or other progress already made | Calling a spread hit free progress while ignoring Swords Dance, or declaring setup decisive without checking the next turn |
| Current form and weather pivot | Rebuild the execution board after switches, weather moves and Mega Evolution; identify any forced replacement | Using rain or a Mega ability because its provider is on the roster, or treating an Emergency Exit replacement as optional analysis time |
| Setup with a support partner | Delivery of the boost, joint incoming pressure, HP cost, disruption and next-turn payoff | Calling default-selected or Encore-forced Soul an intentional setup line; inferring an uncritical KO from a critical one |
| Recharge turn | Include the recharge board, partner's useful action, opposing switches and loss of control | Recommending a finishing Hyper Beam using only this turn's range or treating one miss as proof the move is always wrong |
| Low total bank during a handoff | One control owner, fresh request and clock, legal paired fallback, acknowledgement before further analysis | Repeating stale choices until expiry or crediting a server-default action to the intended policy |

## Counterexample exercises

- **Conditional attack:** Give the reviewer a Sucker Punch user facing a revealed
  King's Shield or Rage Powder, then a second board where an attacking target
  must be removed before its hit. A passing review evaluates paired responses
  and remaining routes in both boards. It can retain Sucker Punch when justified;
  it must not turn one failed read into a universal ban or promise an alternative
  wins without checking its delivery.
- **Protection and progress:** Compare our Protect + partner KO route with a
  support-plus-attack aimed into Protect while the other foe can boost. A passing
  review credits the first partner's progress, models the boosted next board in
  the second, and also credits a broken Disguise when that actually happened.
  It does not score every protected attack or defensive turn as a misplay.
- **Support preservation:** Supply a board with Farigiraf active, relevant
  priority denial on the open sheet and a possible switch, then a board where
  keeping Farigiraf loses immediately to direct attacks. A passing review checks
  whether priority protection still exists at resolution and whether a Room
  reset can execute. It preserves the setter only when that retains a feasible
  route, rather than treating preservation as an unconditional rule.
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
