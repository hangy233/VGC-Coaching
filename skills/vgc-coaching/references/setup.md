# Local MCP setup

This skill contains agent instructions. The MCP server is a separate local
Node.js project; bring an MCP-capable agent host and Node/npm separately.
Use Node.js 24 or newer for the full battle workflow. The package minimum is
Node.js 22.18.0.

## Build the server

Run in the chosen parent directory:

```bash
git clone https://github.com/hangy233/VGC-Coaching.git
cd VGC-Coaching
npm ci
npm run build
```

The build compiles the pinned Pokemon Showdown dependency and the TypeScript
server. Keep the checkout: the built entry point also uses source modules,
maintained skills, dependencies, and local data. Copying `dist/index.js` alone
is insufficient. Do not update dependencies merely to answer an analysis request.

Configure the host to launch the built stdio entry point. Adapt this example to
the host's configuration format and replace the path:

```json
{
  "mcpServers": {
    "vgc-coaching": {
      "command": "node",
      "args": ["/absolute/path/to/VGC-Coaching/dist/index.js"]
    }
  }
}
```

On Windows, forward slashes work in JSON paths. Reload the MCP connection after
building or changing startup configuration. Confirm the host exposes tools such
as `validate_team`, `calculate_damage`, `calculate_speed`,
`team_metrics_agent_report`, and `battle_skill_read`. Inspect tool errors and
schemas rather than inferring a successful connection from the config file.

## Load the coaching instructions

Install this complete `vgc-coaching/` folder in the host's supported skill
directory, or have the host read its `SKILL.md` and relevant references through
its instruction-loading mechanism. Hosts differ in skill discovery and MCP
configuration. A model supporting tool calls does not itself configure a local
MCP process, load `AGENTS.md`, or interpret Codex `agents/openai.yaml` metadata.
Verify the selected host's behavior; do not promise one-click compatibility.

The cloned repository supplies the specialized `champions-mc-teambuilding/` and
`champions-mc-matchups/` folders under `skills/`. `battle_skill_read` delivers
their maintained guidance without requiring native host skill discovery. For
specialized skill installation or live review synchronization, install complete
folders, including references and metadata, into a separate host skill directory.
The default target is `$CODEX_HOME/skills`, or `~/.codex/skills` when unset.

Other hosts can set this optional startup environment value:

```json
"env": {
  "VGC_COACHING_SKILLS_ROOT": "/absolute/path/to/installed-agent-skills"
}
```

Place `env` alongside `command` and `args`. The path is the absolute parent
containing both specialized skill folders, separate from the repository's
maintained `skills/` directory. It is not the path to this companion skill.
Restart MCP to adopt a change. Read the repository's
[agent startup guide](https://github.com/hangy233/VGC-Coaching/blob/main/docs/AGENT-STARTUP.md)
for the complete host setup and reviewed skill-sync workflow.

## Scope and local data

Team audits and saved replay analysis need no Showdown login. Reports and battle
controls share one MCP server. Live control needs the same local checkout and
terminal-owned client; this is not a hosted battle service. Authentication and
battle setup belong to a separately authorized live-play request using the full
specialized workflow. Do not ask for credentials to validate this installation.

## Optional live-play login modes

Automated live play uses the repository's
[Codex CLI runner](https://github.com/hangy233/VGC-Coaching/blob/main/isolated/README.md).
Install/update the official Codex CLI from its maintained vendor instructions,
sign in through its normal ChatGPT flow, and verify the actual available model
catalog. The user needs a plan/account that supports Codex; usage limits apply.
This workflow has no model-API-key fallback. Analysis does not require Codex login.

Read the [architecture](https://github.com/hangy233/VGC-Coaching/blob/main/docs/ARCHITECTURE.md)
and complete matchup cycle before preparing live play. The public launcher
qualifies the explicitly selected model/settings against manager-prepared genuine
saved positions, including actual MCP research, then admits one explicitly scoped
BO3. A new checkout can analyze immediately; it does not contain private saved
positions, login credentials or ready-made live authorization. Do not replace
qualification with synthetic fixtures or an old JSON success report.

The runner is a script. It supplies initial preview, team/sheets and current
turn facts to one retained CLI session per game; the model decides actions and
calls MCP. The manager reviews between sets. Three combined numerical calls and
one compact simulated outcome are shared per live turn. Automatic historical
spread inference may reuse compatible cached evidence but cannot spend hidden
calculator calls. A model context window and the runner's byte caps are different.

Start the client with manual readiness so a stopped model loop cannot open the
next preview. The launch commands below only start the authenticated client;
they do not start the decision runner or authorize a search.

The default is manual login in a visible terminal the user personally controls:

```powershell
npm run battle:session -- YourPlayer --team YOUR_TEAM.txt --sets 1 --manual-ready
```

The user enters the password directly into its hidden prompt. Never put a
password in chat, command arguments, environment variables, or repository files.
Analysis and saved-replay work need neither login mode.

Windows Credential Manager is an opt-in alternative. The user personally opens
**Credential Manager > Windows Credentials > Add a generic credential**, sets
the address to `VGC-Coaching/PokemonShowdown/yourplayer`, enters user name
`YourPlayer`, and types the password directly there. For another approved
account, append its lowercase account ID with non-alphanumeric characters
removed to `VGC-Coaching/PokemonShowdown/`. Then use the explicit flag:

```powershell
npm run battle:session -- YourPlayer --team YOUR_TEAM.txt --sets 1 --saved-login --manual-ready
```

Both modes use a visible user-operated terminal. Saved login reads only the
exact credential and verifies its stored account; a missing credential, wrong
account, or login failure ends the attempt without retry or fallback. Omit the
flag to choose manual entry. The user removes saved access by deleting that
exact generic credential in Credential Manager. Login grants no matchmaking
permission or extra battle allowance. Follow the full
[saved-login and client setup](https://github.com/hangy233/VGC-Coaching/blob/main/showdown/README.md#optional-windows-saved-login)
and the maintained battle workflow before live play.

## Retain local data

Private data lives primarily under ignored `cache/` paths. Use the repository's
report/export and bounded-retention tools for their intended purpose. Installing
or uninstalling this instruction folder does not authorize deleting team data.
