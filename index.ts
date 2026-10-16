import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { calculate, Pokemon, Move, Field, SPECIES, MOVES, ITEMS, ABILITIES, NATURES } from "@smogon/calc";
import { z } from "zod";
// @ts-ignore
import PS from 'pokemon-showdown';
import { Dex } from '@pkmn/dex';
import { Generations } from '@pkmn/data';
import { Classifier, Parser } from '@pkmn/stats';
import { getSmogonUsage, getSmogonPokemonUsage } from './usage/smogon.js';
import { getChampionsUsage, getChampionsPokemonUsage } from './usage/champions.js';
import { registerSpeedTools } from './speed/tools.js';
// @ts-ignore -- this project does not enable global Node type declarations.
import { fileURLToPath } from 'node:url';

const { Teams, TeamValidator } = (PS as any).default || PS;
const gens = new Generations(Dex as any);
const CURRENT_FORMAT = "gen9championsvgc2026regmc";
const formatSchema = z.string().default(CURRENT_FORMAT)
  .describe("Showdown format ID (default: Champions VGC 2026 Regulation M-C)");

const server = new McpServer({ name: "smogon-vgc", version: "1.0.0" });
registerSpeedTools(server);
// The terminal-owned transport remains source .mjs; it shares the same local workspace.
const { registerBattleTools } = await import(new URL('../showdown/mcp-tools.mjs', import.meta.url).href);
registerBattleTools(server, {workspace:fileURLToPath(new URL('..', import.meta.url))});
const { registerMetricsTools } = await import(new URL('../metrics/mcp-tools.mjs', import.meta.url).href);
registerMetricsTools(server, {workspace:fileURLToPath(new URL('..', import.meta.url))});

// Classify a team's playstyle and attributes
server.tool(
  "classify_team",
  {
    team: z.string().describe("Team in Showdown text format"),
    gen: z.number().optional().default(9).describe("Generation (default: 9)"),
    format: formatSchema,
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

// Usage sources retain their own populations, periods, and units.
const usageFormatSchema = formatSchema.refine(value => /^[a-z0-9]+$/.test(value),
  'Use a Showdown format ID containing lowercase letters and digits');
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .optional().describe("Smogon month YYYY-MM (default: latest published for this format)");
const ratingSchema = z.union([z.literal(0), z.literal(1500), z.literal(1630), z.literal(1760)])
  .optional().describe("Exact Smogon rating cutoff; omitted prefers 1760 with a labeled 0 fallback");
const limitSchema = z.number().int().min(1).max(100).default(20)
  .describe("Number of ranked Pokémon to return (1–100, default: 20)");
const battleTypeSchema = z.enum(["Doubles", "Singles"]).default("Doubles")
  .describe("Champions ranked ladder battle type (default: Doubles)");
const seasonSchema = z.string().regex(/^M[1-9]\d*$/).optional()
  .describe("Champions provider season, e.g. M6 (default: latest available snapshot)");
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(value => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
  }, "Use a real calendar date in YYYY-MM-DD format")
  .optional().describe("Exact Champions snapshot date YYYY-MM-DD; omitted selects latest in season");

async function usageResult(action: () => Promise<unknown>) {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await action(), null, 2) }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: "Error fetching usage: " + (error instanceof Error ? error.message : String(error)) }],
    };
  }
}

server.tool(
  "get_usage_stats",
  "Smogon Pokémon Showdown monthly usage percentages. Returns source URL, month and actual rating cutoff. Use get_champions_usage_stats for the in-game ladder.",
  { format: usageFormatSchema, month: monthSchema, rating: ratingSchema, limit: limitSchema },
  async ({ format, month, rating, limit }) => usageResult(() => getSmogonUsage({
    format, limit, ...(month !== undefined ? { month } : {}), ...(rating !== undefined ? { rating } : {}),
  }))
);

server.tool(
  "get_pokemon_usage",
  "Smogon Pokémon Showdown monthly moveset report for one species, with source URL, month and rating cutoff. Use get_champions_pokemon_usage for in-game sets.",
  { pokemon: z.string().trim().min(1), format: usageFormatSchema, month: monthSchema, rating: ratingSchema },
  async ({ pokemon, format, month, rating }) => usageResult(() => getSmogonPokemonUsage({
    pokemon, format, ...(month !== undefined ? { month } : {}), ...(rating !== undefined ? { rating } : {}),
  }))
);

server.tool(
  "get_champions_usage_stats",
  "In-game Pokémon Champions ladder usage ranks from the community Pokémon Champions Battle Data provider. Overall species usage percentages are unavailable. Returns exact season/date; a ladder season is not a verified Showdown regulation mapping.",
  { battleType: battleTypeSchema, season: seasonSchema, date: dateSchema, limit: limitSchema },
  async ({ battleType, season, date, limit }) => usageResult(() => getChampionsUsage({
    battleType, limit, ...(season !== undefined ? { season } : {}), ...(date !== undefined ? { date } : {}),
  }))
);

server.tool(
  "get_champions_pokemon_usage",
  "In-game Pokémon Champions move, item, ability, nature and stat-point percentages plus teammate ranks for one species. Community provider; exact season/date and attribution included. Mega forms are not silently mapped to base forms.",
  { pokemon: z.string().trim().min(1), battleType: battleTypeSchema, season: seasonSchema, date: dateSchema },
  async ({ pokemon, battleType, season, date }) => usageResult(() => getChampionsPokemonUsage({
    pokemon, battleType, ...(season !== undefined ? { season } : {}), ...(date !== undefined ? { date } : {}),
  }))
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
    format: formatSchema,
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
    format: formatSchema,
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

// Match @smogon/calc status codes; omit (or use "") for a healthy Pokémon.
const statusSchema = z.enum(["", "brn", "par", "psn", "tox", "slp", "frz"]).optional()
  .describe("Status: brn (burn), par (paralysis), psn (poison), tox (bad poison), slp (sleep), frz (freeze); omit or empty string for healthy");

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
      status: statusSchema,
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
      status: statusSchema,
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

// Get Pokémon movepool
server.tool(
  "get_movepool",
  {
    pokemon: z.string().describe("Pokémon name"),
    gen: z.number().optional().default(9).describe("Generation (default: 9)"),
  },
  async ({ pokemon, gen }) => {
    try {
      const generation = gens.get(gen as any);
      const species = generation.species.get(pokemon);
      if (!species) {
        return { content: [{ type: "text", text: "Pokemon not found." }] };
      }
      
      const learnset = await generation.learnsets.get(species.id);
      if (!learnset || !learnset.learnset) {
        return { content: [{ type: "text", text: "Movepool not found for " + pokemon }] };
      }

      const moves = Object.keys(learnset.learnset).map(id => {
        const move = generation.moves.get(id);
        return move ? move.name : id;
      }).sort();

      return {
        content: [{ type: "text", text: `Movepool for ${species.name} (Gen ${gen}):\n${moves.join(", ")}` }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: "Error: " + e.message }] };
    }
  }
);

// Get move details
server.tool(
  "get_move",
  {
    name: z.string().describe("Move name"),
    gen: z.number().optional().default(9).describe("Generation (default: 9)"),
  },
  async ({ name, gen }) => {
    try {
      const generation = gens.get(gen as any);
      const move = generation.moves.get(name);
      if (!move) {
        return { content: [{ type: "text", text: "Move not found." }] };
      }
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            name: move.name,
            type: move.type,
            category: move.category,
            basePower: move.basePower,
            accuracy: move.accuracy === true ? "Always hits" : move.accuracy,
            priority: move.priority,
            target: move.target,
            shortDesc: move.shortDesc,
            desc: move.desc,
            makesContact: !!move.flags.contact,
          }, null, 2)
        }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: "Error: " + e.message }] };
    }
  }
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
