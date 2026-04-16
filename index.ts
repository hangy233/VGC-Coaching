import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { calculate, Pokemon, Move, Field, SPECIES, MOVES, ITEMS, ABILITIES, NATURES } from "@smogon/calc";
import { z } from "zod";
// @ts-ignore
import PS from 'pokemon-showdown';
import { Dex } from '@pkmn/dex';
import { Generations } from '@pkmn/data';
import { Classifier, Parser } from '@pkmn/stats';

const { Teams, TeamValidator } = (PS as any).default || PS;
const gens = new Generations(Dex as any);

const server = new McpServer({ name: "smogon-vgc", version: "1.0.0" });

// Classify a team's playstyle and attributes
server.tool(
  "classify_team",
  {
    team: z.string().describe("Team in Showdown text format"),
    gen: z.number().optional().default(9).describe("Generation (default: 9)"),
    format: z.string().optional().default("gen9vgc2025regg").describe("Format ID (e.g., gen9vgc2025regg)"),
  },
  async ({ team, gen, format }) => {
    try {
      const importedTeam = Teams.import(team);
      if (!importedTeam) {
        return { content: [{ type: "text", text: "Invalid team format." }] };
      }
      const generation = gens.get(gen as any);
      const canonicalTeam = Parser.canonicalizeTeam(generation as any, format as any, importedTeam as any);
      const result = Classifier.classifyTeam(generation as any, canonicalTeam as any);
      
      return {
        content: [{ type: "text", text: JSON.stringify({
          bias: result.bias,
          stalliness: result.stalliness,
          tags: Array.from(result.tags),
        }, null, 2) }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: "Error: " + e.message }] };
    }
  }
);

// Get Smogon usage statistics for a format
server.tool(
  "get_usage_stats",
  {
    format: z.string().describe("Format ID (e.g., gen9vgc2025regg)"),
    month: z.string().optional().describe("Month in YYYY-MM format (default: latest available)"),
  },
  async ({ format, month }) => {
    try {
      const now = new Date();
      const monthsToTry = month ? [month] : [];
      if (!month) {
        for (let i = 0; i < 3; i++) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          monthsToTry.push(d.toISOString().slice(0, 7));
        }
      }

      for (const m of monthsToTry) {
        const url = `https://www.smogon.com/stats/${m}/${format}-1760.txt`;
        const response = await fetch(url);
        if (response.ok) {
          const text = await response.text();
          const lines = text.split('\n').slice(0, 25).join('\n');
          return { content: [{ type: "text", text: `Usage stats for ${format} in ${m}:\n\n${lines}` }] };
        }
        
        const urlAlt = `https://www.smogon.com/stats/${m}/${format}-0.txt`;
        const responseAlt = await fetch(urlAlt);
        if (responseAlt.ok) {
           const text = await responseAlt.text();
           const lines = text.split('\n').slice(0, 25).join('\n');
           return { content: [{ type: "text", text: `Usage stats for ${format} in ${m}:\n\n${lines}` }] };
        }
      }

      return { content: [{ type: "text", text: `Could not find usage stats for ${format} in recent months.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: "Error fetching stats: " + e.message }] };
    }
  }
);

// Get detailed moveset and usage statistics for a specific Pokémon
server.tool(
  "get_pokemon_usage",
  {
    pokemon: z.string().describe("Pokémon name (e.g., Iron Hands)"),
    format: z.string().optional().default("gen9vgc2025regg").describe("Format ID (e.g., gen9vgc2025regg)"),
    month: z.string().optional().describe("Month in YYYY-MM format (default: latest available)"),
  },
  async ({ pokemon, format, month }) => {
    try {
      const now = new Date();
      const monthsToTry = month ? [month] : [];
      if (!month) {
        for (let i = 0; i < 3; i++) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          monthsToTry.push(d.toISOString().slice(0, 7));
        }
      }

      for (const m of monthsToTry) {
        const url = `https://www.smogon.com/stats/${m}/moveset/${format}-1760.txt`;
        const response = await fetch(url);
        if (response.ok) {
          const text = await response.text();
          const lines = text.split('\n');
          
          let startIdx = -1;
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] || '';
            if (line.includes('| ' + pokemon + ' ') && !line.includes('%')) {
               if (lines[i-1]?.includes('+---')) {
                  let head = i - 1;
                  while (head > 0 && lines[head-1]?.includes('+---')) {
                     head--;
                  }
                  startIdx = head;
                  break;
               }
            }
          }

          if (startIdx !== -1) {
            let endIdx = -1;
            for (let j = startIdx + 5; j < lines.length; j++) {
               const line = lines[j] || '';
               if (line.includes('| ') && !line.includes('%')) {
                  if (lines[j-1]?.includes('+---') && lines[j+1]?.includes('+---')) {
                     const isNext = lines.slice(j, j + 5).some(l => l.includes('Raw count') || l.includes('Avg. weight'));
                     if (isNext) {
                        let nextStart = j - 1;
                        while (nextStart > startIdx && lines[nextStart-1]?.includes('+---')) {
                           nextStart--;
                        }
                        endIdx = nextStart;
                        break;
                     }
                  }
               }
            }
            const blockText = lines.slice(startIdx, endIdx !== -1 ? endIdx : lines.length).join('\n');
            return { content: [{ type: "text", text: `Detailed stats for ${pokemon} in ${format} (${m}):\n${blockText}` }] };
          }
        }

        const urlAlt = `https://www.smogon.com/stats/${m}/moveset/${format}-0.txt`;
        const responseAlt = await fetch(urlAlt);
        if (responseAlt.ok) {
           const text = await responseAlt.text();
           const lines = text.split('\n');
           
           let startIdx = -1;
           for (let i = 0; i < lines.length; i++) {
             const line = lines[i] || '';
             if (line.includes('| ' + pokemon + ' ') && !line.includes('%')) {
                if (lines[i-1]?.includes('+---')) {
                   let head = i - 1;
                   while (head > 0 && lines[head-1]?.includes('+---')) {
                      head--;
                   }
                   startIdx = head;
                   break;
                }
             }
           }

           if (startIdx !== -1) {
             let endIdx = -1;
             for (let j = startIdx + 5; j < lines.length; j++) {
                const line = lines[j] || '';
                if (line.includes('| ') && !line.includes('%')) {
                   if (lines[j-1]?.includes('+---') && lines[j+1]?.includes('+---')) {
                      const isNext = lines.slice(j, j + 5).some(l => l.includes('Raw count') || l.includes('Avg. weight'));
                      if (isNext) {
                         let nextStart = j - 1;
                         while (nextStart > startIdx && lines[nextStart-1]?.includes('+---')) {
                            nextStart--;
                         }
                         endIdx = nextStart;
                         break;
                      }
                   }
                }
             }
             const blockText = lines.slice(startIdx, endIdx !== -1 ? endIdx : lines.length).join('\n');
             return { content: [{ type: "text", text: `Detailed stats for ${pokemon} in ${format} (${m}):\n${blockText}` }] };
           }
        }
      }

      return { content: [{ type: "text", text: `Could not find detailed stats for ${pokemon} in ${format} in recent months.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: "Error fetching Pokémon stats: " + e.message }] };
    }
  }
);

// Get type effectiveness multiplier
server.tool(
  "get_type_effectiveness",
  {
    attackType: z.string().describe("The type of the move being used (e.g., Fire)"),
    defenderTypes: z.array(z.string()).describe("The type(s) of the defending Pokémon (e.g., ['Water', 'Ground'])"),
    gen: z.number().optional().default(9).describe("Generation (default: 9)"),
  },
  async ({ attackType, defenderTypes, gen }) => {
    try {
      const generation = gens.get(gen as any);
      const moveType = generation.types.get(attackType);
      if (!moveType) return { content: [{ type: "text", text: `Invalid attack type: ${attackType}` }] };

      let multiplier = 1;
      for (const defTypeStr of defenderTypes) {
        const defType = generation.types.get(defTypeStr);
        if (!defType) return { content: [{ type: "text", text: `Invalid defender type: ${defTypeStr}` }] };
        const eff = (moveType.effectiveness as any)[defType.name];
        multiplier *= (eff === undefined ? 1 : eff);
      }

      return {
        content: [{ type: "text", text: `Effectiveness of ${attackType} against ${defenderTypes.join('/')}: ${multiplier}x` }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: "Error calculating effectiveness: " + e.message }] };
    }
  }
);

// Validate a single Pokémon set
server.tool(
  "validate_pokemon",
  {
    pokemon: z.string().describe("Pokémon set in Showdown text format"),
    format: z.string().optional().default("gen9vgc2025regg").describe("Format to validate against (e.g., gen9vgc2025regg)"),
  },
  async ({ pokemon, format }) => {
    try {
      const team = Teams.import(pokemon);
      if (!team || team.length === 0) {
        return { content: [{ type: "text", text: "Invalid Pokémon format." }] };
      }
      const validator = new TeamValidator(format);
      const problems = validator.validateSet(team[0], {});
      if (!problems || problems.length === 0) {
        return { content: [{ type: "text", text: "Pokémon is valid for " + format }] };
      }
      return { content: [{ type: "text", text: "Validation problems:\n" + problems.join("\n") }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: "Error: " + e.message }] };
    }
  }
);

// Validate a full team
server.tool(
  "validate_team",
  {
    team: z.string().describe("Team in Showdown text format"),
    format: z.string().optional().default("gen9vgc2025regg").describe("Format to validate against (e.g., gen9vgc2025regg)"),
  },
  async ({ team, format }) => {
    try {
      const importedTeam = Teams.import(team);
      if (!importedTeam) {
        return { content: [{ type: "text", text: "Invalid team format." }] };
      }
      const validator = new TeamValidator(format);
      const problems = validator.validateTeam(importedTeam);
      if (!problems || problems.length === 0) {
        return { content: [{ type: "text", text: "Team is valid for " + format }] };
      }
      return { content: [{ type: "text", text: "Validation problems:\n" + problems.join("\n") }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: "Error: " + e.message }] };
    }
  }
);

// Define the damage calculation tool
server.tool(
  "calculate_damage",
  {
    attacker: z.string().describe("Attacker species name (e.g., Zoroark-Hisui)"),
    attackerOptions: z.object({
      level: z.number().optional().describe("Attacker level (default: 100)"),
      ability: z.string().optional().describe("Attacker ability"),
      item: z.string().optional().describe("Attacker item"),
      nature: z.string().optional().describe("Attacker nature"),
      ivs: z.any().optional().describe("Attacker IVs"),
      evs: z.any().optional().describe("Attacker EVs (e.g., { at: 252, sp: 252 })"),
      boosts: z.any().optional().describe("Attacker boosts (e.g., { at: 1 })"),
      teraType: z.string().optional().describe("Attacker Tera Type"),
    }).optional(),
    defender: z.string().describe("Defender species name (e.g., Froslass-Mega)"),
    defenderOptions: z.object({
      level: z.number().optional().describe("Defender level (default: 100)"),
      ability: z.string().optional().describe("Defender ability"),
      item: z.string().optional().describe("Defender item"),
      nature: z.string().optional().describe("Defender nature"),
      ivs: z.any().optional().describe("Defender IVs"),
      evs: z.any().optional().describe("Defender EVs"),
      boosts: z.any().optional().describe("Defender boosts"),
      teraType: z.string().optional().describe("Defender Tera Type"),
    }).optional(),
    move: z.string().describe("Move name (e.g., Shadow Claw)"),
    field: z.object({
      gameType: z.enum(["Singles", "Doubles"]).optional(),
      weather: z.string().optional(),
      terrain: z.string().optional(),
      isGravity: z.boolean().optional(),
    }).optional(),
    gen: z.number().optional().default(9).describe("Generation (default: 9)"),
  },
  async ({ attacker, attackerOptions, defender, defenderOptions, move, field, gen }) => {
    const result = calculate(
      gen as any,
      new Pokemon(gen as any, attacker, attackerOptions as any),
      new Pokemon(gen as any, defender, defenderOptions as any),
      new Move(gen as any, move),
      new Field(field as any)
    );

    return {
      content: [{ type: "text", text: result.fullDesc() }],
    };
  }
);

// Define search tools
server.tool(
  "search_pokemon",
  {
    query: z.string().describe("Search query for Pokemon"),
    gen: z.number().optional().default(9).describe("Generation (default: 9)"),
  },
  async ({ query, gen }) => {
    const results = Object.keys(SPECIES[gen as any] || {})
      .filter((name: string) => name.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 10);
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  }
);

server.tool(
  "search_move",
  {
    query: z.string().describe("Search query for Move"),
    gen: z.number().optional().default(9).describe("Generation (default: 9)"),
  },
  async ({ query, gen }) => {
    const results = Object.keys(MOVES[gen as any] || {})
      .filter((name: string) => name.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 10);
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  }
);

server.tool(
  "search_item",
  {
    query: z.string().describe("Search query for Item"),
    gen: z.number().optional().default(9).describe("Generation (default: 9)"),
  },
  async ({ query, gen }) => {
    const items = ITEMS[gen as any] || [];
    const results = items
      .filter((name: string) => name.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 10);
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  }
);

server.tool(
  "search_ability",
  {
    query: z.string().describe("Search query for Ability"),
    gen: z.number().optional().default(9).describe("Generation (default: 9)"),
  },
  async ({ query, gen }) => {
    const abilities = ABILITIES[gen as any] || [];
    const results = abilities
      .filter((name: string) => name.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 10);
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  }
);

server.tool(
  "search_nature",
  {
    query: z.string().describe("Search query for Nature"),
  },
  async ({ query }) => {
    const results = Object.keys(NATURES)
      .filter((name: string) => name.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 10);
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  }
);

// Get Pokémon details
server.tool(
  "get_pokemon",
  {
    name: z.string().describe("Pokemon name"),
    gen: z.number().optional().default(9).describe("Generation (default: 9)"),
  },
  async ({ name, gen }) => {
    const pokemon = (SPECIES[gen as any] as any)?.[name];
    if (!pokemon) {
        return { content: [{ type: "text", text: "Pokemon not found." }] };
    }
    return {
        content: [{ type: "text", text: JSON.stringify({
            name: pokemon.name,
            types: pokemon.types,
            bs: pokemon.bs,
            ability: pokemon.ability,
            weight: pokemon.weightkg,
        }, null, 2) }],
    };
  }
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
