import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { calculateSpeed, speedInputSchema } from './calculator.js';
import {z} from 'zod';
const {timingSpan}=await import(new URL('../../observability/timing.mjs',import.meta.url).href);
const {wrapTimedTool}=await import(new URL('../../simulation/mcp-tools.mjs',import.meta.url).href);

export function registerSpeedTools(server: McpServer,{recordEvidence,timingRecorder}:{recordEvidence?:(entry:any)=>Promise<any>,timingRecorder?:any}={}) {
  const inputSchema=speedInputSchema.extend({evidenceContext:z.strictObject({teamId:z.string().regex(/^[a-f0-9]{64}$/),roomId:z.string().regex(/^battle-gen9championsvgc2026regmc(?:bo3)?-[1-9]\d*$/),turn:z.number().int().min(0).max(10000).optional()}).optional().describe('Optional exact team/game context: retain the actual MCP result and return a calculationRef for decision notes.')});
  server.registerTool(
    'calculate_speed',
    {
      description: 'Calculate Champions level-50 raw stats, effective Speed and equal-priority Speed order with the installed native Showdown M-C engine. Accepts 1–6 explicit current-form snapshots; supports native stat points, boosts, paralysis, items, abilities, weather, terrain, Tailwind, suppression and Trick Room. Reports ties and unsupported move-order effects. No manual Pokémon stat/modifier formulas.',
      inputSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    wrapTimedTool(timingRecorder,'calculate_speed',async (input:z.infer<typeof inputSchema>) => {
      try {
        const {evidenceContext,...calculationInput}=input;
        const result=timingSpan('calculator.execution',{tool:'calculate_speed'}).run(()=>calculateSpeed(calculationInput));
        if(evidenceContext){
          if(!recordEvidence)throw new Error('Calculation evidence recording is unavailable in this server.');
          const calculationRef=await recordEvidence({tool:'calculate_speed',input:calculationInput,result,context:evidenceContext});
          return timingSpan('calculator.serialization',{tool:'calculate_speed'}).run(()=>({content:[{type:'text' as const,text:JSON.stringify({...result,calculationRef},null,2)}]}));
        }
        return timingSpan('calculator.serialization',{tool:'calculate_speed'}).run(()=>({ content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }));
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Error calculating Speed: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }),
  );
}
