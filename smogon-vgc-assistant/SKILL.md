---
name: smogon-vgc-assistant
description: Comprehensive Pokémon VGC assistant for team validation, damage calculation, playstyle classification, and real-time usage statistics. Use this skill when asked to analyze Pokémon teams, validate sets for specific formats (like VGC Regulation G), calculate damage, or check the current metagame.
---

# Smogon VGC Assistant

This skill provides expert guidance for Pokémon VGC analysis using the integrated MCP tools. It enforces the use of live data over training memory for competitive accuracy.

## Core Mandates

### 1. Live Data Only
**NEVER** rely on internal training memory for Pokémon stats, moves, abilities, or metagame trends. Competitive Pokémon changes frequently (new regulations, bans, tier shifts).
1. **Source of Truth**: Always use the provided MCP tools (`get_usage_stats`, `get_pokemon_usage`, `validate_team`, etc.) as your primary source.
2. **Fallback**: Use web search (Smogon, Victory Road, Pikalytics) if MCP tools lack specific data.

### 2. Strict Regulation Adherence
**ALWAYS** strictly follow the Pokémon VGC Regulation specified by the user (e.g., Regulation G, Regulation I).
1. **Format Identification**: Before analyzing or validating, confirm the exact Showdown format ID for the specified regulation (e.g., `gen9vgc2025regg` for Reg G, `gen9vgc2026regi` for Reg I).
2. **No Substitutions**: Do not use data or rules from a different regulation unless the specified one is unavailable AND you explicitly inform the user of the substitution.


## Available Tools (MCP)

| Tool | Purpose | Parameters |
| :--- | :--- | :--- |
| `classify_team` | Analyzes team playstyle/archetype. | `team` (text), `gen`, `format` |
| `validate_team` | Checks team legality for a format. | `team` (text), `format` |
| `validate_pokemon` | Checks set legality for a format. | `pokemon` (text), `format` |
| `get_usage_stats` | Fetches format-wide usage rankings. | `format`, `month` (optional) |
| `get_pokemon_usage` | Fetches detailed stats for one Pokémon. | `pokemon`, `format`, `month` |
| `get_type_effectiveness`| Calculates damage multiplier. | `attackType`, `defenderTypes` (array) |
| `calculate_damage` | Performs detailed damage calc. | `attacker`, `defender`, `move`, `field` |
| `get_pokemon` | Gets base stats, types, and weight. | `name`, `gen` |
| `search_pokemon` | Searches for Pokémon by name. | `query`, `gen` |
| `search_move` | Searches for moves by name. | `query`, `gen` |
| `search_item` | Searches for items by name. | `query`, `gen` |
| `search_ability` | Searches for abilities by name. | `query`, `gen` |
| `search_nature` | Searches for natures by name. | `query` |

## VGC Fundamentals & Strategies

### 1. Key Mechanics
- **Protect**: The most important move in VGC. Used to stall out turns, scout moves, or protect a win condition while the partner attacks.
- **Fake Out**: Provides free pressure on Turn 1 by flinching one opponent. Common on Incineroar, Rillaboom, and Iron Hands.
- **Speed Control**: Tailwind, Trick Room, Icy Wind, and Electroweb are vital for moving first.
- **Redirection**: Follow Me and Rage Powder (e.g., Amoonguss, Ogerpon) protect fragile sweepers.
- **Wide Guard**: Blocks all spread moves (Astral Barrage, Bleakwind Storm, Water Spout).

### 2. Common Archetypes
- **Hyper Offense (HO)**: Focuses on immediate KOs with fast, high-damage threats (e.g., Calyrex-S, Urshifu). Often uses Tailwind.
- **Balance**: Cycles Intimidate (Incineroar) and Fake Out to position for a late-game sweep. Uses bulky attackers like Zamazenta-C or Rillaboom.
- **Trick Room (TR)**: Uses slow Pokémon (Ursaluna-Bloodmoon, Calyrex-I) and a setter (Farigiraf, Indeedee-F) to reverse turn order.
- **Weather**: Rain (Kyogre/Pelipper), Sun (Groudon/Torkoal), Sand (Tyranitar), or Snow (Alolan Ninetales) to boost specific types and abilities.

### 3. Common Restricted Cores (Reg G/I)
- **Calyrex-S + Incineroar**: Extreme special damage + the ultimate support Pokémon.
- **Miraidon + Iron Hands**: Electric Terrain synergy for massive damage and Quark Drive boosts.
- **Terapagos + Smeargle/Farigiraf**: Uses *Tera Shell* and *Stellar Form* for incredible bulk and coverage.
- **Kyogre + Tornadus**: Rain-boosted *Water Spout* + *Tailwind* for speed.

## Workflows

### 1. Team Audit Workflow
1. **Classify**: `classify_team` to see the archetype.
2. **Legal Check**: `validate_team`.
3. **Usage Check**: `get_pokemon_usage` for each member to see if items/moves are "standard" or "tech".
4. **Weakness Check**: Use `get_type_effectiveness` to identify common type weaknesses in the team's defensive core.

### 2. Move-by-Move Verification
Before suggesting a calc, check if the move is actually common for that Pokémon in the format using `get_pokemon_usage`. Don't calc for `Hydro Pump` if the Pokémon 100% runs `Scald`.
