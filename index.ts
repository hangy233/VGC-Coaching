import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { calculate, Pokemon, Move, SPECIES, MOVES, ITEMS, ABILITIES, NATURES } from "@smogon/calc";
import { z } from "zod";
// @ts-ignore
import PS from 'pokemon-showdown';

const { Teams, TeamValidator } = (PS as any).default || PS;

const server = new McpServer({ name: "smogon-calc", version: "1.0.0" });

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
      evs: z.any().optional().describe("Attacker EVs (e.g., { at: 252, sp: 252 })"),
      ivs: z.any().optional().describe("Attacker IVs"),
      boosts: z.any().optional().describe("Attacker boosts (e.g., { at: 1 })"),
    }).optional(),
    defender: z.string().describe("Defender species name (e.g., Froslass-Mega)"),
    defenderOptions: z.object({
      level: z.number().optional().describe("Defender level (default: 100)"),
      ability: z.string().optional().describe("Defender ability"),
      item: z.string().optional().describe("Defender item"),
      nature: z.string().optional().describe("Defender nature"),
      evs: z.any().optional().describe("Defender EVs"),
      ivs: z.any().optional().describe("Defender IVs"),
      boosts: z.any().optional().describe("Defender boosts"),
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
      field ? new (await import("@smogon/calc")).Field(field as any) : undefined
    );
    return {
      content: [{ type: "text", text: result.fullDesc() }],
    };
  }
);

// Search Pokemon
server.tool(
    "search_pokemon",
    {
        query: z.string().describe("Search query for Pokemon"),
        gen: z.number().optional().default(9).describe("Generation (default: 9)"),
    },
    async ({ query, gen }) => {
        const genData = SPECIES[gen as number];
        if (!genData) {
            return {
                content: [{ type: "text", text: `Invalid generation: ${gen}` }],
            };
        }
        const matches = Object.keys(genData).filter(name => name.toLowerCase().includes(query.toLowerCase()));
        return {
            content: [{ type: "text", text: matches.join(", ") }],
        };
    }
);

// Search Moves
server.tool(
    "search_move",
    {
        query: z.string().describe("Search query for Move"),
        gen: z.number().optional().default(9).describe("Generation (default: 9)"),
    },
    async ({ query, gen }) => {
        const genData = MOVES[gen as number];
        if (!genData) {
            return {
                content: [{ type: "text", text: `Invalid generation: ${gen}` }],
            };
        }
        const matches = Object.keys(genData).filter(name => name.toLowerCase().includes(query.toLowerCase()));
        return {
            content: [{ type: "text", text: matches.join(", ") }],
        };
    }
);

// Search Items
server.tool(
    "search_item",
    {
        query: z.string().describe("Search query for Item"),
        gen: z.number().optional().default(9).describe("Generation (default: 9)"),
    },
    async ({ query, gen }) => {
        const genData = ITEMS[gen as number];
        if (!genData) {
            return {
                content: [{ type: "text", text: `Invalid generation: ${gen}` }],
            };
        }
        const matches = Object.keys(genData).filter(name => name.toLowerCase().includes(query.toLowerCase()));
        return {
            content: [{ type: "text", text: matches.join(", ") }],
        };
    }
);

// Search Abilities
server.tool(
    "search_ability",
    {
        query: z.string().describe("Search query for Ability"),
        gen: z.number().optional().default(9).describe("Generation (default: 9)"),
    },
    async ({ query, gen }) => {
        const genData = ABILITIES[gen as number];
        if (!genData) {
            return {
                content: [{ type: "text", text: `Invalid generation: ${gen}` }],
            };
        }
        const matches = Object.keys(genData).filter(name => name.toLowerCase().includes(query.toLowerCase()));
        return {
            content: [{ type: "text", text: matches.join(", ") }],
        };
    }
);

// Search Natures
server.tool(
    "search_nature",
    {
        query: z.string().describe("Search query for Nature"),
    },
    async ({ query }) => {
        const matches = Object.keys(NATURES).filter(name => name.toLowerCase().includes(query.toLowerCase()));
        return {
            content: [{ type: "text", text: matches.join(", ") }],
        };
    }
);

// Get Pokemon Info
server.tool(
    "get_pokemon",
    {
        name: z.string().describe("Pokemon name"),
        gen: z.number().optional().default(9).describe("Generation (default: 9)"),
    },
    async ({ name, gen }) => {
        const pokemon = new Pokemon(gen as any, name);
        return {
            content: [{ type: "text", text: JSON.stringify({
                name: pokemon.name,
                types: pokemon.types,
                baseStats: pokemon.stats,
                ability: pokemon.ability,
                weight: pokemon.weightkg,
            }, null, 2) }],
        };
    }
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
