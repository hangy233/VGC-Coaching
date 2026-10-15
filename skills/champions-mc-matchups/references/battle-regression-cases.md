# Battle decision regression cases

Anonymized review scenarios, not reconstructed battle logs or win guarantees.
Use the actual team version, open sheets, HP, field state and clock. Check
mechanics and all damage through [M-C rules and tools](mc-rules-and-tools.md).
Do not publish private replay access URLs, player identifiers or session logs.

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

For each case, distinguish facts from hypotheses; one result cannot validate a
roster replacement or prove a different move would have won. Preserve useful
adaptation even after a loss. Test revised rules on counterexamples before the
next authorized queue. Follow the skill's play → conclude → update cycle.
