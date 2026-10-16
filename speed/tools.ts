import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { calculateSpeed, speedInputSchema } from './calculator.js';
import {z} from 'zod';

export function registerSpeedTools(server: McpServer,{recordEvidence}:{recordEvidence?:(entry:any)=>Promise<any>}={}) {
  server.registerTool(
    'calculate_speed',
    {
      description: 'Calculate Champions level-50 raw stats, effective Speed and equal-priority Speed order with the installed native Showdown M-C engine. Accepts 1–6 explicit current-form snapshots; supports native stat points, boosts, paralysis, items, abilities, weather, terrain, Tailwind, suppression and Trick Room. Reports ties and unsupported move-order effects. No manual Pokémon stat/modifier formulas.',
      inputSchema: speedInputSchema.extend({evidenceContext:z.strictObject({teamId:z.string().regex(/^[a-f0-9]{64}$/),roomId:z.string().regex(/^battle-gen9championsvgc2026regmc(?:bo3)?-[1-9]\d*$/),turn:z.number().int().min(0).max(10000).optional()}).optional().describe('Optional exact team/game context: retain the actual MCP result and return a calculationRef for decision notes.')}),
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      try {
        const {evidenceContext,...calculationInput}=input;
        const result=calculateSpeed(calculationInput);
        if(evidenceContext){
          if(!recordEvidence)throw new Error('Calculation evidence recording is unavailable in this server.');
          const calculationRef=await recordEvidence({tool:'calculate_speed',input:calculationInput,result,context:evidenceContext});
          return {content:[{type:'text' as const,text:JSON.stringify({...result,calculationRef},null,2)}]};
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Error calculating Speed: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    },
  );
}
