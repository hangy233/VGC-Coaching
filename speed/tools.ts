import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { calculateSpeed, speedInputSchema } from './calculator.js';

export function registerSpeedTools(server: McpServer) {
  server.registerTool(
    'calculate_speed',
    {
      description: 'Calculate Champions level-50 raw stats, effective Speed and equal-priority Speed order with the installed native Showdown M-C engine. Accepts 1–6 explicit current-form snapshots; supports native stat points, boosts, paralysis, items, abilities, weather, terrain, Tailwind, suppression and Trick Room. Reports ties and unsupported move-order effects. No manual Pokémon stat/modifier formulas.',
      inputSchema: speedInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return { content: [{ type: 'text' as const, text: JSON.stringify(calculateSpeed(input), null, 2) }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Error calculating Speed: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    },
  );
}
