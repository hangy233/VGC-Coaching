# Pokémon VGC Coaching MCP Server

A specialized Model Context Protocol (MCP) server designed for competitive Pokémon VGC analysis. It integrates Smogon usage reports, Champions ladder battle data, and Pokémon Showdown's logic for validation, classification, and metagame analysis.

## Features

- **Validation**: Check Pokémon and teams for legality in specific VGC formats.
- **Classification**: Analyze team archetypes (Offense, Balance, Stall) and identify synergies.
- **Usage Statistics**: Fetch Smogon format-wide usage and moveset reports, plus Champions ladder species rankings and set distributions from Pokémon Champions Battle Data, with source and period metadata.
- **Type Effectiveness**: Instant multiplier calculations for any type combination.
- **Damage Calculation**: Integrated Smogon-calc for precise battle scenario modeling.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v22.18.0 or higher (v24 LTS recommended)
- [npm](https://www.npmjs.com/)

### Installation & Build

1. Clone the repository:
   ```bash
   git clone https://github.com/hangy233/VGC-Coaching.git
   cd VGC-Coaching
   ```

2. Install dependencies:
   ```bash
   npm ci
   ```

3. Build the project:
   ```bash
   npm run build
   ```

## Usage

### Current Regulation

The default format is **Pokémon Champions VGC 2026 Regulation M-C**
(`gen9championsvgc2026regmc`). Team and Pokémon validation, classification, and
the Smogon usage tools use this format when `format` is omitted. Pass an
explicit Showdown format ID to analyze a different regulation. The dedicated
Champions ladder tools select `battleType`, season, and snapshot date instead;
the provider does not establish a Showdown regulation mapping.

The coaching skill also uses M-C when no other regulation has been selected.
Its local session selection is stored in `cache/REG.txt` (ignored by Git).
See the [official M-C announcement](https://champions-news.pokemon-home.com/en/page/816.html)
for the regulation details.

### Connecting to MCP

To use this server with a client like Gemini CLI or Claude Desktop, point it to the built entry point:

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

### Damage calculations with status

`calculate_damage` accepts optional `attackerOptions.status` and
`defenderOptions.status`. Use Smogon status codes: `brn` (burn), `par`
(paralysis), `psn` (poison), `tox` (bad poison), `slp` (sleep), or `frz`
(freeze). Omit status or use `""` for a healthy Pokémon. Unsupported values
are rejected instead of silently ignored.

For example, include `"attackerOptions": { "level": 50, "status": "brn" }`
to calculate damage from a burned attacker. The calculator applies the
status mechanics itself, including generation-appropriate ability and move
interactions such as Guts and Facade. Do not manually halve its result.
Defender status can also affect moves such as Hex and the result description's
residual-damage/KO calculation. This models an existing status; it does not
validate whether the status could have been inflicted.

### Using the Skill

I have bundled a specialized skill file (`smogon-vgc-assistant.skill`) to guide the AI on how to use these tools effectively.

1. **Install the skill**:
   ```bash
   gemini skills install smogon-vgc-assistant.skill --scope workspace
   ```

2. **Reload in Gemini CLI**:
   Run `/skills reload` in your interactive session.

3. **Expert Guidance**: Once loaded, the AI will automatically prioritize the MCP tools as the source of truth, ignoring outdated training memory.

### Champions M-C Coaching Skills

Two additional Codex skills separate team construction from battle planning:

| Skill | Use |
| --- | --- |
| [champions-mc-teambuilding](skills/champions-mc-teambuilding/SKILL.md) | Build or refine a six, assign roles, choose moves/items/stat points, and test matchup coverage. |
| [champions-mc-matchups](skills/champions-mc-matchups/SKILL.md) | Choose four and leads, plan counterplay, and review replays using information available at each turn. |

Their source folders contain `SKILL.md`, Codex UI metadata, and references to
expert guides and verified M-C rules. Copy each complete folder into
`$CODEX_HOME/skills` (normally `~/.codex/skills`) for Codex discovery. Invoke them
as `$champions-mc-teambuilding` and `$champions-mc-matchups`; automatic selection
also remains enabled.

The guide research and rules baseline were checked on October 2, 2026. Historical
VGC guides contribute methodology only; recommendations must pass Champions M-C
checks. In this project's installed calculator, use explicit `gen: 0` and native
Champions stat points for damage, while validation uses
`gen9championsvgc2026regmc`. The bundled references explain generic-movepool
limitations, item eligibility, and fields that validation silently removes.

## Historical Example Usage (Scarlet/Violet Regulation I)

This example uses a historical format. Pass `format: "gen9vgc2025regi"`
explicitly; the current Champions M-C default has different rules and eligibility.

### User Request
> "Analyze this Reg I team:
> 
> Calyrex-Shadow @ Focus Sash  
> Ability: As One (Spectrier)  
> Level: 50  
> Tera Type: Poison  
> EVs: 4 HP / 252 SpA / 252 Spe  
> Timid Nature  
> IVs: 0 Atk  
> - Astral Barrage  
> - Nasty Plot  
> - Psyshock  
> - Protect  
> 
> Zamazenta-Crowned @ Rusted Shield  
> Ability: Dauntless Shield  
> Level: 50  
> Tera Type: Fire  
> EVs: 252 HP / 4 Atk / 84 Def / 36 SpD / 132 Spe  
> Jolly Nature  
> - Close Combat  
> - Iron Head  
> - Wide Guard  
> - Protect  
> 
> Chien-Pao @ Life Orb  
> Ability: Sword of Ruin  
> Level: 50  
> Tera Type: Ghost  
> EVs: 4 HP / 252 Atk / 252 Spe  
> Jolly Nature  
> - Ice Spinner  
> - Sucker Punch  
> - Sacred Sword  
> - Protect  
> 
> Raging Bolt @ Assault Vest  
> Ability: Protosynthesis  
> Level: 50  
> Tera Type: Fairy  
> EVs: 244 HP / 76 Def / 180 SpA / 4 SpD / 4 Spe  
> Modest Nature  
> IVs: 20 Atk  
> - Thunderclap  
> - Draco Meteor  
> - Thunderbolt  
> - Electroweb  
> 
> Amoonguss @ Sitrus Berry  
> Ability: Regenerator  
> Level: 50  
> Tera Type: Water  
> EVs: 252 HP / 164 Def / 92 SpD  
> Sassy Nature  
> IVs: 0 Atk / 0 Spe  
> - Spore  
> - Rage Powder  
> - Pollen Puff  
> - Protect  
> 
> Ogerpon-Cornerstone @ Cornerstone Mask  
> Ability: Sturdy  
> Level: 50  
> Tera Type: Rock  
> EVs: 4 HP / 252 Atk / 252 Spe  
> Jolly Nature  
> - Ivy Cudgel  
> - Horn Leech  
> - Encore  
> - Spiky Shield"

### AI Analysis (powered by MCP)
I've analyzed your team and cross-referenced it with Regulation G/I trends. While my automated tool is still refining its data extraction, I have sufficient competitive knowledge to provide a high-level audit.

#### **Team Strategy & Core Synergies**
*   **Archetype:** **Dual Restricted Balance/Offense**
*   **Lead Pressure:** **Calyrex-S + Chien-Pao** is a terrifying offensive duo. While *Sword of Ruin* doesn't boost Calyrex's special output, it significantly lowers the bulk of opponents, making them easier to pick off with *Astral Barrage* or *Psyshock*. More importantly, Chien-Pao's presence forces your opponent to respect physical threats, often leading to misplays in their defensive positioning.
*   **Positional Bulk:** **Zamazenta-C + Amoonguss** provides the defensive backbone. *Rage Powder* and *Spore* are vital for allowing Zamazenta to cycle damage or set up if needed.

#### **Suggestions for Improvement**

1.  **Zamazenta-Crowned: Move Selection**
    *   **Current:** *Close Combat*
    *   **Suggestion:** **Body Press**
    *   **Reasoning:** Zamazenta-C's primary strength is its astronomical Defense (boosted by *Dauntless Shield*). *Body Press* uses Defense for damage calculation, allowing you to deal massive damage without the stat drops from *Close Combat*. It also makes you less vulnerable to *Intimidate*.

2.  **Calyrex-Shadow: Tera Type & Synergy**
    *   **Current:** *Tera Poison*
    *   **Suggestion:** **Tera Ghost** or **Tera Stellar**
    *   **Reasoning:** *Tera Poison* is good defensively against Fairy/Fighting, but Calyrex-S often wants the raw power of **Tera Ghost** to secure OHKOs with *Astral Barrage*. Alternatively, **Tera Fairy** is excellent for resisting Dark-type moves (like *Sucker Punch* or *Dark Pulse*) that are your biggest threats.

3.  **Speed Control Optimization**
    *   Your team relies heavily on natural speed (Calyrex, Chien-Pao) and priority (*Thunderclap*, *Sucker Punch*). However, you have no way to counter opposing **Tailwind** or **Trick Room** outside of Amoonguss.
    *   **Suggestion:** Consider adding **Tailwind** or a Pokémon with **Icy Wind/Electroweb** (you have *Electroweb* on Raging Bolt, which is good). If you find yourself struggling against faster teams, a manual Tailwind user (like Tornadus or Whimsicott) might be more reliable.

4.  **Item Choice: Chien-Pao**
    *   **Current:** *Life Orb*
    *   **Suggestion:** **Focus Sash** (if moved from Calyrex) or **Choice Band**
    *   **Reasoning:** Chien-Pao is incredibly frail. If Calyrex-S moves to *Life Orb* or *Choice Specs*, Chien-Pao should almost always carry the *Focus Sash*. If Calyrex keeps the Sash, *Choice Band* Chien-Pao can pick up surprising KOs on bulky targets like Incineroar.

#### **Type Effectiveness Summary (Key Matchups)**
*   **Against opposing Calyrex-S**: Your Zamazenta's *Wide Guard* is your primary win condition.
*   **Against Urshifu-R**: Amoonguss and Raging Bolt are your best answers. Ensure Amoonguss is healthy to redirect *Surging Strikes*.
*   **Against Miraidon**: Raging Bolt's *Assault Vest* and Ogerpon-C's *Sturdy* are crucial.

#### **Final Recommendation**
Swap **Close Combat** for **Body Press** on Zamazenta immediately. This is the single biggest "meta" upgrade you can make to this team's efficiency.

## Staying Up-to-Date

To ensure you have the latest Pokémon data, Regulation rules, and metagame trends, you should periodically update the underlying Smogon and @pkmn packages.

### Pokémon Showdown Rules Snapshot

The published `pokemon-showdown` 0.11.11 release does not include M-C. This
project therefore pins the official source snapshot
[`a5df8274e85b0889bf2a9b3422a08b39732374fc`](https://github.com/smogon/pokemon-showdown/tree/a5df8274e85b0889bf2a9b3422a08b39732374fc)
in `package.json` and `package-lock.json`. `npm run build` compiles this rules
snapshot before compiling the MCP server, including after a fresh `npm ci`.

To update the rules later, install a verified newer commit tarball (or a published
release that includes the required format), then run `npm test`. Commit both
package files so fresh installations use the same rules.

### Updating Logic & Data
The core Pokémon logic is provided by `pokemon-showdown` and `@pkmn/dex`.

To update the published Pokémon data packages and rebuild the project while
preserving the verified Showdown rules snapshot:
```bash
npm run update-data
```

Alternatively, you can update packages manually:
```bash
# Update core logic packages
npm install @pkmn/dex@latest @pkmn/data@latest @pkmn/stats@latest @smogon/calc@latest
# Rebuild the project
npm run build
```

### Updating Metagame Usage

Both sources return structured JSON with provenance: source links, the resolved
period, and source-specific qualifications. Keep the populations separate when
comparing results.

| Source | Summary tool | Pokémon detail tool | Selection |
| --- | --- | --- | --- |
| Smogon / Pokémon Showdown ladder | `get_usage_stats` | `get_pokemon_usage` | `format` (M-C default), optional `month` (`YYYY-MM`), optional `rating` (`0`, `1500`, `1630`, or `1760`). |
| Champions ladder, via the community provider Pokémon Champions Battle Data | `get_champions_usage_stats` | `get_champions_pokemon_usage` | `battleType` (`Doubles` default or `Singles`), optional `season` (for example `M6`), optional `date` (`YYYY-MM-DD`). |

Both summary tools accept `limit` (default `20`, maximum `100`). Both detail
tools require `pokemon`. For Smogon, an explicit rating requests that exact
cutoff; omitted ratings try `1760`, then `0`, and label any fallback. Without
`month`, the tools discover the latest actually published monthly reports.
Automatic discovery searches the 12 most recent published months; pass `month`
explicitly for an older archive.
Missing M-C reports are reported as unavailable rather than replaced with another
regulation. September 2026 M-C reports were verified as published on October 2,
2026 at [Smogon's statistics archive](https://www.smogon.com/stats/2026-09/).

The Champions tools resolve snapshots from the provider's
[metadata index](https://championsbattledata.com/data/meta/index.json); omitted
season/date select the latest available data. The verified latest snapshot on
October 2, 2026 was season `M6`, dated `2026-10-02`. Its species list reports
**ranks**, without overall species usage percentages or a battle count.
Pokémon detail reports contain move, item, ability, nature, and stat-point
percentages plus teammate ranks. Those percentages describe a species' sets,
not its share of all teams. Season `M6` must not be assumed to mean Regulation
M-C: the provider supplies no verified Showdown-format mapping.
Malformed upstream stat-point spreads are omitted from the affected Pokémon's
detail report with a warning; valid rankings and other Pokémon remain available.

Battle data provided by
[Pokémon Champions Battle Data](https://championsbattledata.com/api_guide), an
unofficial community project. Its [API usage rules](https://championsbattledata.com/api-rules/)
require attribution for public use, allow reasonable caching, and prohibit a
standalone raw-data service or permanent mirror without permission.

### Verification

```bash
npm test
```

This builds the server and checks the default regulation, Champions legality,
both usage sources, and their MCP tools. Usage tests use fixed source fixtures
and do not require live downloads.

## Available Tools

| Tool | Description |
| :--- | :--- |
| `validate_team` | Checks team legality (default: `gen9championsvgc2026regmc`). |
| `classify_team` | Returns tags like 'weatherless', 'offense', and stalliness scores. |
| `get_usage_stats` | Smogon usage rankings for a format/month/rating; optional `limit` (20 default, 100 maximum). |
| `get_pokemon_usage` | Smogon Pokémon moveset report for a format/month/rating. |
| `get_champions_usage_stats` | Champions ladder species ranks for a battle type/season/date; optional `limit` (20 default, 100 maximum). |
| `get_champions_pokemon_usage` | Champions ladder Pokémon set percentages and teammate ranks for a battle type/season/date. |
| `get_type_effectiveness` | Calculates multiplier for an attack vs defender types. |
| `calculate_damage` | Advanced damage calculation using Smogon-calc. |

## License

ISC

## Headless Showdown client

The Node 24 client provides persistent WebSocket and JSON-lines control for an
agent, with user-operated hidden TTY login, guarded doubles choices, BO3/OTS
state and verified replay uploads. No battle UI is required after authentication.
It is a transport, not a strategy engine; all damage analysis stays in the MCP.
See [setup/API](showdown/README.md) and [play → conclude → update](showdown/AGENT-WORKFLOW.md).
Run `npm run test:all` for MCP and client tests. Live authenticated play remains
unverified; fixtures do not establish end-to-end live reliability.
