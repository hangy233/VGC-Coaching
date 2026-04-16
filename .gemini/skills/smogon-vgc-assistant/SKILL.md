---
name: smogon-vgc-assistant
description: Comprehensive Pokémon VGC assistant for team validation, damage calculation, playstyle classification, and real-time usage statistics. Use this skill when asked to analyze Pokémon teams, validate sets for specific formats (like VGC Regulation G), calculate damage, or check the current metagame.
---

# Smogon VGC Assistant

This skill provides expert guidance for Pokémon VGC analysis using the integrated MCP tools. It enforces the use of live data and strict adherence to session-specific parameters.

## Core Mandates

### 1. Live Data Only
**NEVER** rely on internal training memory for Pokémon stats, moves, abilities, or metagame trends.
1. **Source of Truth**: Always use the provided MCP tools (`get_usage_stats`, `get_pokemon_usage`, `validate_team`, etc.) as your primary source.
2. **Fallback**: Use web search (Smogon, Victory Road, Pikalytics) if MCP tools lack specific data.

### 2. Strict Regulation & Type Adherence
1. **Format Identification**: Before analyzing, confirm the exact Showdown format ID (e.g., `gen9vgc2025regg` for Reg G, `gen9vgc2026regi` for Reg I). Check `cache/REG.txt` if it exists.
2. **No Substitutions**: Do not use data or rules from a different regulation unless the specified one is unavailable AND you explicitly inform the user.
3. **Never Estimate Damage**: **ALWAYS** use the `calculate_damage` tool for every assessment. Do not rely on "estimates" or internal memory for damage ranges.
4. **Type Effectiveness**: **ALWAYS** verify damage multipliers using `get_type_effectiveness` or a verified type chart. Do not assume effectiveness.

### 3. Session Caching & Team Adherence
To ensure consistency throughout the coaching session, use the `cache/` folder.
1. **Refer to Cache**: **ALWAYS** check `cache/TEAM.txt` and `cache/REG.txt` before making suggestions or running tools.
2. **Ask Before Update**: If you identify a necessary change to the team or regulation, **ASK THE USER** before updating the files in the `cache/` folder.
3. **Sync**: Keep the cache updated with the user's latest decisions after receiving approval.
4. **Cleanup**: Explicitly delete the `cache/` folder at the end of the session or when the user requests a reset.

## Workflows

### 1. Team Audit Workflow
1. **Identify**: Check `cache/TEAM.txt`. If missing, ask for the team list.
2. **Regulation**: Check `cache/REG.txt`. If missing, ask for the Regulation.
3. **Classify**: Use `classify_team` to see the archetype.
4. **Legal Check**: Use `validate_team` with the cached regulation.
5. **Audit**: Run `get_pokemon_usage` for members to verify meta viability.
6. **Suggest**: Provide improvements based ONLY on the current cached state.

### 2. Move-by-Move Verification
Before suggesting a calc or swap, ensure the move isn't already on the cached set. Check move popularity in the specific format via `get_pokemon_usage`.

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

## Competitive Strategic Thinking (Aaron Zheng Methodology)

### 1. Team Preview Analysis
- **Identify High-Impact Threats**: Look for "Megas" or central Restricted Pokémon. Ask: "Which 1-2 Pokémon carry their game plan?"
- **The "Easy Cut"**: Identify Pokémon the opponent is unlikely to bring based on your weather or type advantage.
- **Structural Vulnerabilities**: Check for missing resistances (e.g., "No Fairy resistance"). Identify Pokémon that are liabilities in the matchup (e.g., a slow Pokémon against a faster offensive threat).
- **Define Win Conditions**: Identify which of your Pokémon needs to be on the field and healthy to win the endgame (e.g., "Baskilegion cleans if Kingambit is gone").

### 2. Lead Selection
- **Pressure vs. Setup**: Decide if you need an immediate lead to apply pressure (Fake Out + Offense) or if you need to set up speed control (Tailwind) immediately.
- **Speed Tiers**: Leads should ideally outpace the opponent's likely leads to get knockouts before taking damage ("Positive Trades").
- **Bluffing**: Use your team composition to force the opponent into defensive play (e.g., bluffing a weather lead to force a specific switch).

### 3. Move Selection & Positioning (Risk-Reward Analysis)
- **Predict Opponent's Best Move**: For every move you suggest, identify the opponent's likely "Best Move" (e.g., Terastallization, Wide Guard, or a specific KO threat).
- **Multi-Scenario Strategy**: Provide options based on different opponent responses (e.g., "If they lead X, do Y; If they lead A, do B").
- **Risk-Reward Evaluation**: For every option, explicitly state the **Risk** (e.g., "Locked into a Ghost move against a Normal type") and the **Reward** (e.g., "Guaranteed OHKO on their Restricted").
- **Double-Up Strategy**: When moving before the opponent, double-up on a single slot to guarantee a KO and deny their turn completely.
- **Resource Management**: Stall out your own turns of Weather, Terrain, or Tailwind if it allows you to reset them at a more advantageous time later in the game.

### 4. Pivoting & Switching
- **Free Switches**: Prefer sacrificing a low-HP, high-utility Pokémon to get a "free switch" for a healthy threat, rather than hard-switching and taking damage.
- **Defensive Switches**: Bring in resistances to "catch" expected attacks, especially if your current field is frail.
- **Weather/Terrain Wars**: Switch your setter (Peliper, Indeedee) in and out specifically to reset the battlefield after the opponent overrides it.

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
