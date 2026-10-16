# Champions M-C battle work

For team preview, live decisions, replay review, or an authorized M-C BO3 batch,
read `skills/champions-mc-matchups/SKILL.md` and its required cycle reference.
The repository skill folder is the maintained source. Before a new battle search,
use `battle_skill_status` (or `scripts/sync-skill.mjs --check`) and resolve a stale
installed copy. Prefer `battle_skill_sync` for reviewed installation, then
`battle_skill_read` to deliver the complete updated guidance and obtain the current
read receipt. Read the files into active context rather than relying on an old summary.

**Every BO3 must conclude with a private decision review and skill checkpoint
before the next authorized search.** Record a supported reusable change or an
explicit reason for no change, validate relevant scenarios, and sync changed
guidance. This also applies after wins, forfeits, a context handoff, and the final
set in a batch. Report `review complete / lesson or no change / sync verified`.
An idle server or unused battle allowance does not prove this review occurred.
See `skills/champions-mc-matchups/references/headless-battle-cycle.md` for the
checkpoint fields. Prefer `battle_review_save` and verify `battle_review_status`;
do not handwrite a completed status to bypass evidence checks. Run
`battle_preflight` before the next search. These tools validate stored evidence
and readiness; tactical judgment and this instruction are not a runtime review
guard in `battle_start`.

Use open sheets and plausible opposing paired actions to choose a plan; use actual
MCP `calculate_damage` and `calculate_speed` for all numerical damage and Speed
checks. Do not use mental arithmetic or a direct calculator fallback. Label
unknown opposing investments and unsupported calculations explicitly.
Use optional `evidenceContext` to retain actual calculator inputs/results for
`battle_note_decision` and review references. Decision notes record agent claims;
they do not establish server acceptance, execution or the opponent's intent.

Protect the active turn deadline: submit complete legal paired choices promptly,
keep a compact handoff, and do long reviews only between BO3s. Separate selected,
accepted, executed, server-defaulted, and inactivity outcomes. A source update does
not update an already running client. Do not start battles, change the roster,
publish replays, authenticate again, or commit/push merely to validate a skill.
