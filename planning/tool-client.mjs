// Composition of the actual registered MCP handlers, not a second calculator.
// The facade registers normally and retains only bounded calculation tools.
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const ALLOWED=new Set(['calculate_damage','calculate_damage_range','calculate_speed','simulate_turn','simulate_turn_batch','simulate_choices']);
export const PLANNING_RUNTIME_FILES=Object.freeze([
  '../planning/research-budget.mjs',
  '../dist/index.js','../dist/speed/calculator.js','../simulation/turn-simulator.mjs','../simulation/move-support.mjs','../simulation/native-state.mjs','../simulation/approximate-position.mjs','../simulation/history-state.mjs',
  '../simulation/turn-worker.mjs','../simulation/mcp-tools.mjs','../simulation/schemas.mjs','../simulation/observed-position.mjs','../simulation/choice-schemas.mjs','../simulation/choice-simulation.mjs','../simulation/choice-presentation.mjs','../simulation/choice-state.mjs','../simulation/spread-candidates.mjs','../simulation/spread-observations.mjs','../simulation/spread-range.mjs','../simulation/choice-ranges.mjs','../package-lock.json',
]);
export function loadedPlanningRuntimeVersion(){
  try{return createHash('sha256').update(JSON.stringify(PLANNING_RUNTIME_FILES.map(file=>[file,createHash('sha256').update(readFileSync(new URL(file,import.meta.url))).digest('hex')]))).digest('hex');}
  catch{return null;}
}
export function createPlanningToolClient(server){
  const handlers=new Map();
  const remember=(name,schema,handler)=>{if(ALLOWED.has(name))handlers.set(name,{schema,handler});};
  return {
    runtimeVersion:loadedPlanningRuntimeVersion(),
    registerTool(name,options,handler){
      remember(name,options.inputSchema,handler);
      return server.registerTool(name,options,handler);
    },
    tool(name,shape,handler){
      remember(name,z.strictObject(shape),handler);
      return server.tool(name,shape,handler);
    },
    async callTool(name,args,options={}){
      if(options.signal?.aborted)throw new Error('Planning calculation cancelled before dispatch');
      if(!ALLOWED.has(name)||!handlers.has(name))throw new Error('Planning supports only registered damage, Speed and isolated simulation tools');
      if(!['simulate_turn','simulate_turn_batch','simulate_choices'].includes(name)&&args?.gen!==0)throw new Error('Planning numerical requests require explicit native gen:0');
      const {schema,handler}=handlers.get(name);
      return handler(schema.parse(args),{...(options.signal?{signal:options.signal}:{})});
    },
    capabilities(){return [...handlers.keys()];},
  };
}
