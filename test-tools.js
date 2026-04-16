import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
});

const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

async function runTests() {
  try {
    await client.connect(transport);
    console.log("Connected to MCP server.\n");

    const tests = [
      {
        name: "classify_team",
        args: { team: "Calyrex-Shadow @ Choice Specs\nAbility: As One (Spectrier)\n- Astral Barrage", gen: 9, format: "gen9vgc2025regg" }
      },
      {
        name: "get_usage_stats",
        args: { format: "gen9vgc2024regg", month: "2024-05" }
      },
      {
        name: "get_pokemon_usage",
        args: { pokemon: "Calyrex-Shadow", format: "gen9vgc2024regg", month: "2024-05" }
      },
      {
        name: "get_type_effectiveness",
        args: { attackType: "Water", defenderTypes: ["Fire", "Ground"] }
      },
      {
        name: "validate_pokemon",
        args: { pokemon: "Calyrex-Shadow @ Choice Specs\nAbility: As One (Spectrier)\n- Astral Barrage", format: "gen9vgc2025regg" }
      },
      {
        name: "validate_team",
        args: { team: "Calyrex-Shadow @ Choice Specs\nAbility: As One (Spectrier)\n- Astral Barrage", format: "gen9vgc2025regg" }
      },
      {
        name: "calculate_damage",
        args: {
          attacker: "Calyrex-Shadow",
          attackerOptions: { item: "Choice Specs", nature: "Timid", evs: { spa: 252 }, level: 50 },
          defender: "Amoonguss",
          defenderOptions: { nature: "Sassy", evs: { hp: 252, spd: 92 }, level: 50 },
          move: "Expanding Force",
          field: { gameType: "Doubles", terrain: "Psychic" },
          gen: 9
        }
      },
      {
        name: "search_pokemon",
        args: { query: "Pikachu", gen: 9 }
      },
      {
        name: "search_move",
        args: { query: "Thunderbolt", gen: 9 }
      },
      {
        name: "search_item",
        args: { query: "Leftovers", gen: 9 }
      },
      {
        name: "search_ability",
        args: { query: "Intimidate", gen: 9 }
      },
      {
        name: "search_nature",
        args: { query: "Adamant" }
      },
      {
        name: "get_pokemon",
        args: { name: "Calyrex-Shadow", gen: 9 }
      }
    ];

    for (const test of tests) {
      console.log(`Running test: ${test.name}...`);
      try {
        const result = await client.callTool({
          name: test.name,
          arguments: test.args
        });
        console.log(`Result: ${JSON.stringify(result.content[0].text).substring(0, 100)}...`);
        console.log("✅ Success\n");
      } catch (e) {
        console.error(`❌ Error in ${test.name}:`, e.message);
      }
    }

  } catch (error) {
    console.error("Connection error:", error);
  } finally {
    process.exit(0);
  }
}

runTests();
