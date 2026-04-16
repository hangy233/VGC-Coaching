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
The AI uses `classify_team`, `validate_team`, and `get_pokemon_usage` to provide a professional audit:

- **Archetype**: Dual Restricted Balance/Offense.
- **Set Audit**:
  - **Zamazenta-C**: Suggests swapping *Close Combat* for **Body Press** to utilize its massive defense and avoid stat drops.
  - **Calyrex-S**: Recommends **Tera Ghost** for maximum damage or **Tera Fairy** for defensive utility against *Sucker Punch*.
  - **Chien-Pao**: Recommends carrying **Focus Sash** if Calyrex-S moves to a damage item like *Life Orb*.
- **Strategy**: Identifies core synergies (Calyrex-S + Chien-Pao pressure) and potential weaknesses (lack of manual Tailwind).

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
