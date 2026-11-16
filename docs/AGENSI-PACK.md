# VGC Coaching Skill Pack

Package version **3.0.0** contains three coaching skills: setup and evidence
handling, Champions M-C battle planning, and Champions M-C team building.
The pack delivers the coaching instructions directly. The local MCP server and
live-battle runner are downloaded separately from
[VGC-Coaching on GitHub](https://github.com/hangy233/VGC-Coaching).

## Included in the pack

| Component | Included content | Purpose |
| --- | --- | --- |
| `skills/vgc-coaching/` | Companion skill, setup guide, evidence workflow | Connect a local MCP host and interpret team reports, calculations and retained battle evidence. |
| `skills/champions-mc-matchups/` | Full battle skill and all references | Choose four, plan leads and paired actions, review replays, and follow the authorized BO3 preparation, review and closure workflow. |
| `skills/champions-mc-teambuilding/` | Full team-building skill and all references | Assess roles, sets, stat-point spreads, coverage and tradeoffs for Champions Regulation M-C. |
| Skill metadata and helper source | Existing `agents/openai.yaml` files and the matchup folder's `scripts/sync-skill.mjs` | Preserve complete source folders. Metadata is host-specific; the helper requires the local checkout workflow described below. |
| Shared operator documentation | Agent startup, architecture, simulation, Showdown client/workflow, CLI runner and metrics guides | Explain the local runtime, ownership, qualification and evidence contracts referenced by the skills. These are documentation, not the runtime implementation. |
| Pack guide and manifest | This guide and the generated source/file manifest | State installation boundaries and identify the exact source revision, bundled files and hashes. |

The shared operator documents are `docs/AGENT-STARTUP.md`,
`docs/ARCHITECTURE.md`, `docs/SIMULATOR.md`, `showdown/AGENT-WORKFLOW.md`,
`showdown/README.md`, `isolated/README.md`, and `metrics/README.md`.
The generated manifest is the exact file inventory for a particular release.

The skill folders come from the same maintained source as the GitHub checkout;
they are not separately edited marketplace copies. Each release is a snapshot.
The manifest records its Git source revision, per-file hashes and complete skill
folder hashes. It identifies shipped content, not a live-readiness qualification
or a server acceptance receipt.

## Download separately

| Needed component | Obtain it from | When required |
| --- | --- | --- |
| MCP server, tool implementations, data loaders, runner, validation and qualification code | Clone the complete GitHub repository and build it locally. | MCP legality checks, usage research, numerical damage/Speed calculations, saved-history tools and live control. |
| Runtime dependencies, including the pinned Pokemon Showdown dependency | Run `npm ci` in that checkout, followed by `npm run build`. | Building and running the MCP server. The pack contains no `node_modules/`, Showdown engine or built `dist/` runtime. |
| Git, Node.js and npm | Their maintained installers or your existing installation. Use Node.js 24+ for the full live workflow; the package minimum is 22.18.0. | Local installation and build. |
| An MCP-capable agent host and its local stdio configuration | The selected host's supported setup. | Calling local tools. Loading an Agensi skill does not configure a local MCP connection. |
| Official Codex CLI and a supported ChatGPT sign-in | Official Codex installation and sign-in instructions. | Automated live decisions only. Analysis does not require a Codex sign-in or model-provider API key. |
| Your team, retained history, saved qualification positions and any authorized login | User-owned local records and the separately authorized setup workflow. | Tasks that actually require those records or live play. None is supplied by this pack or a public clone. |

The pack contains no credentials, private team plans, battle logs, replay access
links, account sessions or ready-made battle authorization. Remote usage and
replay data are requested from their providers when the relevant tools run;
the pack does not mirror those datasets.

You can read the packaged guidance for qualitative coaching before installing
the runtime. Numerical benchmarks, legality checks and claims about recorded
results still need their actual tools and evidence. If a required tool is
unavailable, state what remains unverified rather than treating instructions as
an executed check.

## Load the relevant skill

Agensi supports multiple skills in one pack. Its delivery includes the selected
skill's folder and shared files outside the skill folders; it does not make
every sibling skill part of the current context. Load `vgc-coaching` for setup
and evidence handling, `champions-mc-teambuilding` for roster work, or
`champions-mc-matchups` for existing-team battle decisions and review.

When guidance routes to a sibling skill, explicitly load that skill from the
pack, read it from a local checkout, or use the connected MCP's
`battle_skill_read`. Read its required references as well. A relative link to a
sibling is a dependency, not proof that the sibling's content was delivered.
See [Agensi's packaging rules](https://www.agensi.io/docs/packaging).

The packaged `sync-skill.mjs` is included as source for complete-folder fidelity.
Its defaults depend on its file location and the local repository layout. Do
not execute it through Agensi's temporary-script mechanism or use the pack as
an installation source over newer local guidance. Use the current checkout's
reviewed `battle_skill_status`, `battle_skill_sync` and `battle_skill_read`
workflow for installed skills. Host metadata does not install itself either.

## Install the local tools

In your chosen parent directory:

```bash
git clone https://github.com/hangy233/VGC-Coaching.git
cd VGC-Coaching
npm ci
npm run build
```

Configure your host to run `node /absolute/path/to/VGC-Coaching/dist/index.js`
as a local stdio MCP server. Keep the entire checkout: the entry point depends
on source modules, maintained skills and installed dependencies. Follow the
[agent startup guide](https://github.com/hangy233/VGC-Coaching/blob/main/docs/AGENT-STARTUP.md)
for the exact host configuration, separate installed-skill directory and
reviewed synchronization procedure. Reload the MCP connection and inspect the
actual tool schemas before reporting that setup succeeded.

Setup and saved-replay analysis need no Showdown login. Live play additionally
needs explicit account/team/battle-count/model permissions, the complete
current matchup cycle, genuine selected-model qualification and the normal
preflight checks. Installing this pack starts no battle and grants no such
permission.

Downloads alone do not make a new installation ready for automated BO3s. The
manager must also prepare genuine complete saved decision requests and their
actual model-requested MCP returns for the selected model's qualification. A
public clone includes none of that private evidence. If suitable evidence is
unavailable, live startup remains blocked; do not substitute fixtures, a small
probe or an extra battle without its own authorization.

## Update tools and guidance

First inspect the checkout for local changes. With a clean checkout, update
from its configured GitHub branch:

```bash
git pull --ff-only
npm ci
npm run build
```

Preserve and resolve local changes rather than overwriting them to update.
Reload the MCP connection and restart affected runtime processes at the normal
authorized startup; rebuilding files does not update an already running
process. No extra Showdown login or test battle is needed to update the tools.

Compare the pack's manifest revision with the checkout you intend to use.
Reconcile differences against the maintained GitHub source instead of silently
mixing snapshots. Before live play, check `battle_skill_status`, review and sync
changed guidance, obtain a fresh complete `battle_skill_read`, and verify loaded
runtime adoption under the full cycle. An old marketplace snapshot must not
replace newer reviewed guidance. Marketplace updates and local checkout updates
are separate operations.

## Build and maintain the pack

From the maintained repository:

```bash
npm run pack:agensi
```

The builder writes these generated artifacts under `dist/agensi/`:

- `vgc-coaching-pack-v3.0.0.zip`: the uploadable three-skill pack.
- `vgc-coaching-pack-v3.0.0.manifest.json`: source revision, file inventory and
  hashes for review.
- `vgc-coaching-pack-v3.0.0.files.json`: the same packaged text files as
  path/content records for an authenticated agent upload.

Build from the reviewed release checkout. The builder copies canonical skill
folders, includes allowlisted public operator documents, validates packaged
links and source fidelity, and enforces the text-package limits. Keep private
data out of source guidance; an archive allowlist cannot make private text safe
after it has been added to an allowed public source file.

Publish a new version when a bundled skill or its references change. Generate
the archive again from that release's source rather than editing ZIP contents
or maintaining a second copy. Uploading and Agensi review are separate from
building: a local archive is not proof of a published or approved update.
Preserve the existing free price and review the listing's included/downloaded
component descriptions alongside the archive.
