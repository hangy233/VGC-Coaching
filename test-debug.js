import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
});

const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const result = await client.callTool({
  name: "debug_fetch",
  arguments: { url: "https://www.smogon.com/stats/2024-05/moveset/gen9vgc2024regg-1760.txt" }
});

console.log(result.content[0].text);
process.exit(0);
