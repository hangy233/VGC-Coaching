# Agent startup with any MCP host

The tools are model-independent. Your agent host must launch the local MCP stdio server, expose its tool schemas and results to the model, and load the coaching instructions below. A model change alone does not require server changes. Host-specific skill discovery, project rules and UI metadata are separate from MCP.

The server advertises short model-neutral instructions during MCP initialization. Hosts differ in how they present those instructions; use the explicit startup block below when needed, and verify that the agent reads the complete required guidance.

## Copyable startup instructions

Add this block to your host's project instructions or initial agent prompt. It points to the complete workflow rather than replacing it:

```text
Use this checkout's VGC Coaching MCP. Preserve the user's scope; advice, credentials and unused allowance do not authorize battles or roster changes. Read current relevant guidance with battle_skill_read (teambuilding or matchups), including required references in full. Analyze the exact team version through filtered team_metrics_agent_report, then focused team_metrics_game_evidence; verify cached sets, freshness, exclusions and unknowns. Use actual MCP calculate_damage and calculate_speed for numerical checks; label unsupported states. For authorized live play, follow the full BO3 cycle, stage/send legal paired choices before optional analysis, and respect observed deadlines. After every set, preserve evidence, review decisions/control/variance, validate a lesson or justified no-change, sync/read changed guidance, save/verify the review checkpoint, and inspect preflight before another authorized search. These checks do not prove tactical judgment. Read docs/AGENT-STARTUP.md for setup, receipts, editing and shutdown details.
```

## Configure the host

Build the checkout as described in the [README](../README.md#install-and-connect), then adapt this example to your host's MCP configuration:

```json
{
  "mcpServers": {
    "vgc-coaching": {
      "command": "node",
      "args": ["/absolute/path/to/VGC-Coaching/dist/index.js"],
      "env": {
        "VGC_COACHING_SKILLS_ROOT": "/absolute/path/to/installed-agent-skills"
      }
    }
  }
}
```

The optional `VGC_COACHING_SKILLS_ROOT` is an absolute path to the **parent** containing `champions-mc-matchups/` and `champions-mc-teambuilding/`. Set it in the trusted server-start environment, then restart the MCP connection to adopt a change. Without it, the target remains `$CODEX_HOME/skills`, or `~/.codex/skills` when `CODEX_HOME` is unset. The installed folders must be separate from the repository's maintained `skills/` folders. MCP callers cannot choose an arbitrary installation target.

Install or sync the complete reviewed folders, including references and metadata. A host can read guidance through MCP even if it does not natively discover these folders; the configured installation is also the copy checked by the review workflow. Configure the host's project instructions to follow this guide. Do not assume it automatically loads `AGENTS.md`, `agents/openai.yaml`, or another application's skill conventions.

Live controls use an OS-local bridge to the existing terminal-owned battle client. The MCP process needs access to the same checkout and local session; this is not a remotely hosted battle service. Windows saved login is optional and platform-specific. See [client setup](../showdown/README.md); an analysis or replay-review request needs no login.

## Choose the task's scope and read guidance

| Task | Guidance |
| --- | --- |
| Build, audit or revise a team | `battle_skill_read({"skill":"champions-mc-teambuilding"})` |
| Preview, paired decisions or replay review with an existing team | `battle_skill_read({"skill":"champions-mc-matchups"})` |
| Authorized live M-C BO3s | The matchup skill, its full required BO3 cycle, and the [agent battle workflow](../showdown/AGENT-WORKFLOW.md) |

Read the returned current instructions and their required references in full, including rules/calculator guidance and the live cycle where applicable. A skill name, old summary or truncated result is not complete guidance. If the host truncates delivery, obtain the complete required files through its file-reading facilities and retain the actual tool receipt for live review.

Before live play, use `battle_skill_status` to check repository/installed hashes. Resolve reviewed differences through `battle_skill_sync` (inspect its default dry run before applying), then call `battle_skill_read` again. Its read receipt is bound to the current content and MCP process and expires after 60 minutes. Use a fresh receipt after restarting MCP or changing guidance.

Advice, report access and saved credentials grant no additional permission to change a roster, publish replays or start battles. Carry forward the user's actual scope and remaining battle allowance.

## Analyze the exact team and relevant evidence

1. Use `team_metrics_list` to identify the exact team version. Read `team_metrics_agent_report`, verify its cached full sets, filters, cutoff, refresh warnings and included/excluded counts. Keep changed versions separate.
2. Follow supporting game IDs with `team_metrics_game_evidence`, preferably for the relevant turn range. Read available open sheets, selections and decision observations. Missing reserves or opposing investments remain unknown; agent notes describe intent rather than proving execution.
3. Use actual MCP `calculate_damage` and `calculate_speed` for numerical claims. In Champions mode use `gen: 0`, native points in damage `evs` and Speed `statPoints`, and explicit current forms/abilities and supported field state. Do not substitute mental arithmetic or a direct calculator. Leave unsupported conditions unverified.
4. Cite observed opportunities, plausible paired responses and lost coverage when assessing a revision. A local calculated improvement does not establish that an alternate team would win the game. Propose or save changes within the user's scope; register accepted variants separately for later comparison.

Optional `evidenceContext` on calculator calls retains actual inputs/results for notes and reviews. See [metrics definitions and agent reports](../metrics/README.md#reading-reports-as-an-agent) and the maintained skill's rules reference for schemas and limitations.

## Run authorized battles and preserve lessons

Start or reuse the terminal client only within the user's authorization. Inspect its loaded capabilities, claim exclusive control, configure deadline protection while idle and run `battle_preflight` before a separate `battle_start`. Stage and submit complete legal paired choices promptly; do optional research and notes after protecting the current action deadline. No strategy is generated by the client.

After **every official BO3**, including the last set or a forfeit:

1. Verify the official parent and expected children. Preserve authorized replays, sync metrics and read the exact team's new evidence and wider history.
2. Review successful plans and mistakes. Separate team limitations, piloting, control failures and variance; distinguish chosen, sent, accepted, executed and defaulted actions.
3. Validate a reusable lesson against relevant scenarios and a counterexample, or record a supported no-change reason. Edit maintained source guidance only when warranted, then sync and read changed guidance.
4. Save the structured review with `battle_review_save` and verify `battle_review_status`, using the current process's read receipt and actual calculator references where relevant. Complete bounded retention and inspect preflight before the next authorized search.
5. At the batch boundary, finish preservation/review/retention, call `battle_stop` and verify shutdown unless the user has requested keeping the client open.

The tools check recorded evidence and readiness; they do not prove tactical judgment or enforce the complete review workflow inside `battle_start`. A source update does not update a running client.

Reflection that changes the skill needs ordinary file-edit access to the maintained repository folders; the MCP sync tool installs reviewed content but does not edit source. An MCP-only host can read evidence and save a justified no-change review, but cannot claim an unwritten lesson was installed. Keep private match details, credentials and replay access links out of shared guidance. Follow the [required BO3 cycle](../skills/champions-mc-matchups/references/headless-battle-cycle.md) for complete review, adoption and cleanup requirements.
