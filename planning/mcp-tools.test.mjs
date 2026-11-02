import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {registerPlanningTools} from './mcp-tools.mjs';
import {planningFixture} from './fixtures.mjs';
const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
function fixture(){const data=planningFixture();data.ownTeam[2].item='Miracle Seed';data.ownTeam[3].item='Grassy Seed';data.opponentSheet[2].item='Grassy Seed';return {data,input:{request:{kind:'explicit',label:'Registration-owned cache fixture',board:data.board,legalActions:data.legalActions,ownTeam:Teams.export(data.ownTeam),opponentSheet:data.opponentSheet},maxCalls:1,view:'full'}};}
function registered(options){const handlers=new Map();registerPlanningTools({registerTool:(name,config,handler)=>handlers.set(name,{config,handler})},options);return async input=>{const {config,handler}=handlers.get('battle_turn_brief'),reply=await handler(config.inputSchema.parse(input));assert(!reply.isError,reply.content?.[0]?.text);return reply.structuredContent;};}
function tool(){const calls=[];return {calls,callTool:Object.assign(async(name,args)=>{calls.push({name,args});return {structuredContent:{gen:0,pokemon:[],order:[],...(args.evidenceContext?{calculationRef:{id:`retained-${calls.length}`,context:args.evidenceContext}}:{})}};},{runtimeVersion:'registered-runtime-1'})};}

test('one actual planning registration reuses its bounded ephemeral cache; another registration and changed inputs/runtime remain fresh',async()=>{
  const {input,data}=fixture(),{calls,callTool}=tool(),call=registered({callTool});
  const first=await call(input);assert.equal(calls.length,1);assert.equal(first.coverage.numerics.attemptedCalls,1);
  const same=await call(input);assert.equal(calls.length,1);assert.equal(same.coverage.numerics.cachedCalls,1);assert.equal(same.numericChecks.checks[0].receipt.reused,true);
  await registered({callTool})(input);assert.equal(calls.length,2,'A new registration has a new cache');
  data.board.sides[0].pokemon[0].boosts.spe=1;await call(input);assert.equal(calls.length,3);
  callTool.runtimeVersion='registered-runtime-2';await call(input);assert.equal(calls.length,4);
});

test('provided cache injection is preserved and entries carry internal ownership without claiming a saved explicit team',async()=>{
  const {input}=fixture(),{callTool,calls}=tool(),numericCache=new Map(),call=registered({callTool,numericCache});
  const first=await call(input);assert.equal(numericCache.size,1);const entry=[...numericCache.values()][0];assert.match(entry.ownerTeamId,/^[a-f0-9]{64}$/u);assert.equal(first.source.teamId,undefined);
  const second=await call(input);assert.equal(calls.length,1);assert.equal(second.coverage.numerics.cachedCalls,1);
});

test('registration reuse respects retained receipt context and never skips a newly requested evidence write',async()=>{
  const {input,data}=fixture(),{calls,callTool}=tool(),teamId='a'.repeat(64),token='b'.repeat(64);
  const request={kind:'observed',sessionId:'registered-cache-session',teamId,room:'battle-gen9championsvgc2026regmcbo3-901',rqid:2,token};
  const board={...data.board,room:request.room,request:{rqid:2},opponentSheets:{p2:data.opponentSheet}},state={sessionId:request.sessionId,teamSha256:teamId,actions:[{room:request.room,rqid:2,token,legalActions:data.legalActions}],boards:[board],controlPolicy:{pending:[]}};
  const numericCache=new Map(),options={workspace:process.cwd(),callTool,numericCache,loadTeam:async()=>({teamId,team:data.ownTeam}),call:async(_path,{op})=>({ok:true,result:op==='status'?{sessionId:request.sessionId,teamSha256:teamId,rooms:[]}:structuredClone(state)})};
  const call=registered(options);
  await call({...input,request});assert.equal(calls.length,1);
  const retained=await call({...input,request,retainEvidence:true});assert.equal(calls.length,2);assert.equal(retained.numericChecks.checks[0].receipt.calculationRef.context.turn,2);
  await call({...input,request,retainEvidence:true});assert.equal(calls.length,2);
  board.turn=3;await call({...input,request,retainEvidence:true});assert.equal(calls.length,3);
  request.room='battle-gen9championsvgc2026regmcbo3-902';board.room=request.room;state.actions[0].room=request.room;
  const other=await call({...input,request,retainEvidence:true});assert.equal(calls.length,4);assert.equal(other.numericChecks.checks[0].receipt.calculationRef.context.roomId,request.room);
  const otherWorkspace=await registered({...options,workspace:process.cwd()+'/cache/other-hypothetical-workspace'})({...input,request,retainEvidence:true});assert.equal(calls.length,5,'The same injected Map cannot relabel a different workspace receipt');assert.notDeepEqual(otherWorkspace.numericChecks.checks[0].receipt.calculationRef,other.numericChecks.checks[0].receipt.calculationRef);
});
