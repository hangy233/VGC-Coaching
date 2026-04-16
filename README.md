# Pokémon VGC Coaching MCP Server

A specialized Model Context Protocol (MCP) server designed for competitive Pokémon VGC analysis. It integrates with Smogon's data layer and Pokémon Showdown's logic to provide real-time validation, classification, and usage statistics.

## Features

- **Validation**: Check Pokémon and teams for legality in specific VGC formats.
- **Classification**: Analyze team archetypes (Offense, Balance, Stall) and identify synergies.
- **Usage Statistics**: Fetch format-wide rankings and detailed Pokémon-specific moveset reports from Smogon.
- **Type Effectiveness**: Instant multiplier calculations for any type combination.
- **Damage Calculation**: Integrated Smogon-calc for precise battle scenario modeling.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [npm](https://www.npmjs.com/)

### Installation & Build

1. Clone the repository:
   ```bash
   git clone https://github.com/hangy233/VGC-Coaching.git
   cd VGC-Coaching
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

## Usage

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

### Using the Skill

I have bundled a specialized skill file (`smogon-vgc-assistant.skill`) to guide the AI on how to use these tools effectively.

1. **Install the skill**:
   ```bash
   gemini skills install smogon-vgc-assistant.skill --scope workspace
   ```

2. **Reload in Gemini CLI**:
   Run `/skills reload` in your interactive session.

3. **Expert Guidance**: Once loaded, the AI will automatically prioritize the MCP tools as the source of truth, ignoring outdated training memory.

## Example Usage

### User Request
> "Analyze this Reg I team:
> 
> Calyrex-Shadow @ Focus Sash  
> Ability: As One (Spectrier)  
> EVs: 4 HP / 252 SpA / 252 Spe  
> Timid Nature  
> - Astral Barrage  
> - Nasty Plot  
> - Psyshock  
> - Protect  
>
> Zamazenta-Crowned @ Rusted Shield  
> ... (full team list) ..."

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

### Updating Logic & Data
The core Pokémon logic (new species, moves, and format rules like Regulation I) is provided by `pokemon-showdown` and `@pkmn/dex`.

To update everything at once and rebuild the project:
```bash
npm run update-data
```

Alternatively, you can update packages manually:
```bash
# Update core logic packages
npm install pokemon-showdown@latest @pkmn/dex@latest @pkmn/data@latest @smogon/calc@latest
# Rebuild the project
npm run build
```

### Updating Metagame Usage
The usage stats tools (`get_usage_stats` and `get_pokemon_usage`) fetch data live from `smogon.com/stats`. They will automatically retrieve the most recent month's data as it becomes available online, with no code changes required.

## Available Tools

| Tool | Description |
| :--- | :--- |
| `validate_team` | Checks if a team is legal for a specific format (e.g., `gen9vgc2025regg`). |
| `classify_team` | Returns tags like 'weatherless', 'offense', and stalliness scores. |
| `get_usage_stats` | Gets the top 20 Pokémon used in a format. |
| `get_pokemon_usage` | Detailed report on moves, items, and common teammates. |
| `get_type_effectiveness` | Calculates multiplier for an attack vs defender types. |
| `calculate_damage` | Advanced damage calculation using Smogon-calc. |

## License

ISC
