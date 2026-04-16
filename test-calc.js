import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
});

const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

try {
  await client.connect(transport);

  const result = await client.callTool({
    name: "calculate_damage",
    arguments: {
      attacker: "Calyrex-Shadow",
      attackerOptions: {
        item: "Choice Specs",
        nature: "Timid",
        evs: { spa: 252 },
        level: 50,
        teraType: "Ghost"
      },
      defender: "Lunala",
      defenderOptions: {
        ability: "Shadow Shield",
        evs: { hp: 252 },
        level: 50
      },
      move: "Tera Blast",
      field: {
        gameType: "Doubles"
      },
      gen: 9
    }
  });

  console.log("\n--- Calculation Result ---");
  console.log(result.content[0].text);
  console.log("--------------------------\n");

} catch (error) {
  console.error("Error calling tool:", error);
} finally {
  process.exit(0);
}
