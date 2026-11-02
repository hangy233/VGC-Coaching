import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createOwnedSimulationFixture,room,parent} from '../simulation/owned-choice-fixture.mjs';
import {AgentSession} from './agent-session.mjs';
import {ShowdownClient} from './client.mjs';
import {registerBattleTools} from './mcp-tools.mjs';
import {serveLocalSession,callLocalSession} from './local-bridge.mjs';

const requestSha256='a'.repeat(64),otherSha256='b'.repeat(64),thirdSha256='c'.repeat(64);
const binding=(f,category='simulation',extra={})=>({source:f.source(),analysis:'current',category,requestSha256,...extra});
const fromAction=(f,kind)=>{const a=f.session.actions().find(row=>row.kind===kind);assert(a);return{sessionId:f.session.id,teamId:f.client.expectedTeamHash,room:a.room,rqid:a.rqid,token:a.token};};
const result={kind:'compact-native-outcome',samples:[{conditional:true}],calculationRef:{id:'saved-ledger-reference',sha256:'d'.repeat(64)}};
const {Battle,Teams}=createRequire(import.meta.url)('pokemon-showdown');
const {extractChannelMessages}=createRequire(import.meta.url)('pokemon-showdown/dist/sim/battle.js');
async function previewFixture(){
  const original=await createOwnedSimulationFixture(),packed=original.session.packed,teamId=original.client.expectedTeamHash;original.close();
  let at=200000,rqid=0,lastLine=0;const client=new ShowdownClient({expectedTeamHash:teamId,now:()=>at});
  client.connected=true;client.authenticated=true;client.epoch=1;client.formats='[Gen 9] Champions VGC 2026 Reg M-C (Bo3),e';
  client.ws={send:()=>{},close:()=>{client.connected=false;client.authenticated=false;client.emit('disconnected');}};
  const session=new AgentSession(client,{username:'Owner',packed,authorizedSets:1,autoReady:false,now:()=>at,controllerRequired:false});
  assert.equal((await session.execute({id:'synthetic-preview-start',op:'start',confirmed:true})).ok,true);
  client.receive(`|updatesearch|${JSON.stringify({searching:[],games:{[parent]:'Owner vs Foe'}})}`);
  client.receive(`>${parent}\n|uhtml|game|<a href="/${room}">Game 1</a>`);client.receive(`>${room}\n|showteam|p2|${packed}`);
  const team=Teams.unpack(packed),battle=new Battle({formatid:'gen9championsvgc2026regmc',seed:[1,2,3,4],p1:{name:'Owner',team},p2:{name:'Foe',team:structuredClone(team)}});
  const receive=()=>{const lines=extractChannelMessages(battle.log.join('\n'),[1])[1];for(const line of lines.slice(lastLine)){at++;client.receive(`>${room}\n${line}`);}lastLine=lines.length;at++;client.receive(`>${room}\n|request|${JSON.stringify({...battle.p1.activeRequest,rqid:++rqid})}`);};
  receive();return {client,session,source:kind=>{const action=session.actions().find(a=>a.kind===kind);assert(action);return{sessionId:session.id,teamId,room,rqid:action.rqid,token:action.token};},startTurn(){assert.equal(battle.choose('p1','team 1234'),true);assert.equal(battle.choose('p2','team 1234'),true);receive();},close(){session.dispose();battle.destroy();}};
}

test('actual native source validation reserves once synchronously and shares pending/completed work with frozen analysis',async()=>{
  const f=await createOwnedSimulationFixture();try{
    const args=binding(f),context=f.session.simulationContext({source:args.source});
    const frozen=f.session.freezeSimulationContext(f.session.actions().find(a=>a.kind==='turn'));
    assert(frozen);const frozenArgs={...args,analysis:'frozen',freezeId:frozen.freezeId};
    const first=f.session.researchReserve(args),pending=f.session.researchReserve(args),shadow=f.session.researchReserve(frozenArgs);
    assert.equal(first.status,'reserved');assert.equal(first.backendAllowed,true);
    assert.equal(pending.status,'pending');assert.equal(shadow.status,'pending');assert.equal(shadow.reservationId,first.reservationId);
    assert.equal(pending.reservationId,first.reservationId);assert.equal(pending.backendAllowed,false);
    assert.equal(first.source.semanticSha256,context.semanticSha256);assert.equal(first.choiceAuthority,false);
    assert(!JSON.stringify(first).includes(args.source.token));assert(!JSON.stringify(first).includes(args.source.sessionId));
    assert.throws(()=>f.session.researchSettle({...frozenArgs,reservationId:first.reservationId,result}),/differs/,'a pending join cannot settle another source/mode ticket');
    const settled=f.session.researchSettle({...args,reservationId:first.reservationId,result});assert.equal(settled.status,'completed');
    const reused=f.session.researchReserve(frozenArgs);assert.equal(reused.status,'reused');assert.deepEqual(reused.result,result);assert.deepEqual(reused.calculationRef,result.calculationRef);
    reused.result.samples[0].conditional=false;assert.deepEqual(f.session.researchReserve(args).result,result,'returned results cannot mutate the cached exact outcome');
    assert.equal(f.session.researchReserve({...args,requestSha256:otherSha256}).status,'budget-used');
    assert.equal(f.session.researchStatus(frozenArgs).budget.simulationsUsed,1);
  }finally{f.close();}
});

test('three distinct calculator invocations are reserved before backend work and share current/frozen turn quota',async()=>{
  const f=await createOwnedSimulationFixture();try{
    const args=binding(f,'calculator'),ids=[],frozen=f.session.freezeSimulationContext(f.session.actions().find(a=>a.kind==='turn'));
    const shadow={...args,analysis:'frozen',freezeId:frozen.freezeId};
    for(const input of [args,{...shadow,requestSha256:otherSha256},{...args,requestSha256:thirdSha256}]){const reserved=f.session.researchReserve(input);assert.equal(reserved.status,'reserved');ids.push(reserved.reservationId);}
    assert.equal(new Set(ids).size,3);assert.equal(f.session.researchReserve({...shadow,requestSha256:'d'.repeat(64)}).status,'budget-used');
    assert.equal(f.session.researchReserve(binding(f)).status,'reserved');
    const status=f.session.researchStatus(args);assert.equal(status.budget.calculatorsUsed,3);assert.equal(status.budget.calculatorsRemaining,0);
    assert.equal(status.budget.simulationsUsed,1);assert.deepEqual(status.budget.limits,{calculator:3,simulation:1});
  }finally{f.close();}
});

test('identical calculators join pending work and reuse exact completed results across independently validated current/frozen sources',async()=>{
  const f=await createOwnedSimulationFixture();try{
    const args=binding(f,'calculator'),frozen=f.session.freezeSimulationContext(f.session.actions().find(a=>a.kind==='turn'));
    const shadow={...args,analysis:'frozen',freezeId:frozen.freezeId},first=f.session.researchReserve(args);
    const pending=f.session.researchReserve(shadow);assert.equal(pending.status,'pending');assert.equal(pending.reservationId,first.reservationId);assert.equal(pending.backendAllowed,false);
    assert.equal(f.session.researchStatus(args).budget.calculatorsUsed,1);
    f.session.researchSettle({...args,reservationId:first.reservationId,result});
    const reused=f.session.researchReserve(shadow);assert.equal(reused.status,'reused');assert.deepEqual(reused.result,result);assert.deepEqual(reused.calculationRef,result.calculationRef);assert.equal(reused.backendAllowed,false);
    reused.result.samples[0].conditional=false;assert.deepEqual(f.session.researchReserve(args).result,result);
    for(const nextSha of [otherSha256,thirdSha256])assert.equal(f.session.researchReserve({...args,requestSha256:nextSha}).status,'reserved');
    assert.equal(f.session.researchReserve(args).status,'reused','cached work remains available after all actual invocation slots are spent');
    assert.equal(f.session.researchStatus(args).budget.calculatorsUsed,3);
    assert.throws(()=>f.session.researchReserve({...args,source:{...args.source,token:'0'.repeat(64)}}),/stale/);
    assert(!JSON.stringify(reused).includes(args.source.token));assert(!JSON.stringify(reused).includes(args.source.sessionId));
  }finally{f.close();}
});

test('changed native facts within one board turn require a new calculator invocation and cannot reuse an older result',async()=>{
  const f=await createOwnedSimulationFixture();try{
    const args=binding(f,'calculator'),ticket=f.session.researchReserve(args);f.session.researchSettle({...args,reservationId:ticket.reservationId,result});
    const frozen=f.session.freezeSimulationContext(f.session.actions().find(a=>a.kind==='turn'));
    f.client.receive(`>${room}\n|-damage|p1a: Politoed|100/197`);
    const request=structuredClone(f.client.rooms.get(room).request);request.rqid++;request.side.pokemon[0].condition='100/197';
    f.client.receive(`>${room}\n|request|${JSON.stringify(request)}`);const changed=binding(f,'calculator'),next=f.session.researchReserve(changed);
    assert.equal(next.status,'reserved');assert.notEqual(next.reservationId,ticket.reservationId);assert.equal(next.budget.calculatorsUsed,2);assert.equal(next.result,undefined);
    f.session.researchSettle({...changed,reservationId:next.reservationId,result:{changed:true}});
    assert.deepEqual(f.session.researchReserve(changed).result,{changed:true});
    assert.deepEqual(f.session.researchReserve({...args,analysis:'frozen',freezeId:frozen.freezeId}).result,result,'the independently validated frozen facts retain their own exact cached result');
    assert.equal(f.session.researchStatus(changed).budget.calculatorsUsed,2);
  }finally{f.close();}
});

test('known MCP error envelopes cannot become a positive cache and an explicitly partial range remains a real result',async()=>{
  const f=await createOwnedSimulationFixture();try{
    const args=binding(f,'calculator');
    for(const error of [{isError:true},{ok:false},{structuredContent:{ok:false}}]){
      const ticket=f.session.researchReserve(args);assert.equal(ticket.status,'reserved');
      assert.throws(()=>f.session.researchSettle({...args,reservationId:ticket.reservationId,result:error}),/explicit failed/);
      assert.equal(f.session.researchReserve(args).status,'pending','rejected successful settlement keeps the spent pending reservation');
      assert.equal(f.session.researchSettle({...args,reservationId:ticket.reservationId,failed:true}).status,'failed');
    }
    assert.equal(f.session.researchStatus(args).budget.calculatorsUsed,3);assert.equal(f.session.researchResultClaims.size,0);
  }finally{f.close();}
  const partial=await createOwnedSimulationFixture();try{
    const args=binding(partial,'calculator'),ticket=partial.session.researchReserve(args),value={structuredContent:{status:'partial-candidate-envelope',coverage:{exhaustive:false}}};
    assert.equal(partial.session.researchSettle({...args,reservationId:ticket.reservationId,result:value}).status,'completed');
    assert.deepEqual(partial.session.researchReserve(args).result,value);
  }finally{partial.close();}
});

test('fresh native preview numeric work uses turn zero quota and the true first turn starts a new quota without allowing preview simulation',async()=>{
  const f=await previewFixture();try{
    const source=f.source('preview'),args={source,analysis:'current',category:'calculator',requestSha256};
    const first=f.session.researchReserve(args);assert.equal(first.status,'reserved');assert.equal(first.source.turn,0);
    f.session.researchSettle({...args,reservationId:first.reservationId,result:{known:true}});assert.equal(f.session.researchReserve(args).status,'reused');
    for(const nextSha of [otherSha256,thirdSha256])assert.equal(f.session.researchReserve({...args,requestSha256:nextSha}).status,'reserved');
    assert.equal(f.session.researchReserve({...args,requestSha256:'d'.repeat(64)}).status,'budget-used');
    assert.throws(()=>f.session.researchReserve({...args,category:'simulation'}),/does not accept team preview/);
    assert.throws(()=>f.session.simulationContext({source}),/stale/,'preview does not broaden the simulator source contract');
    f.startTurn();const current={...args,source:f.source('turn')},status=f.session.researchStatus(current);
    assert.equal(status.source.turn,1);assert.equal(status.budget.calculatorsUsed,0);assert.equal(f.session.researchReserve(current).status,'reserved');
  }finally{f.close();}
});

test('failed, pending and oversized work remain spent; settlements cannot change category, request or completed result',async()=>{
  const f=await createOwnedSimulationFixture();try{
    const args=binding(f),reserved=f.session.researchReserve(args);
    for(const bad of [{category:'calculator'},{requestSha256:otherSha256},{reservationId:'another-ticket'}])assert.throws(()=>f.session.researchSettle({...args,reservationId:reserved.reservationId,result,...bad}),/differs/);
    assert.equal(f.session.researchSettle({...args,reservationId:reserved.reservationId,failed:true}).status,'failed');
    assert.equal(f.session.researchReserve(args).status,'budget-used');assert.equal(f.session.researchCacheClaims.size,0);
    const calculator=binding(f,'calculator'),calc=f.session.researchReserve(calculator);
    assert.equal(f.session.researchSettle({...calculator,reservationId:calc.reservationId,result:{text:'x'.repeat(1024*1024)}}).reason,'research-result-cache-limit');
    assert.equal(f.session.researchStatus(args).budget.calculatorsUsed,1);
    const next=f.session.researchReserve(calculator);f.session.researchSettle({...calculator,reservationId:next.reservationId,result:{known:true}});
    assert.equal(f.session.researchSettle({...calculator,reservationId:next.reservationId,result:{known:true}}).alreadySettled,true);
    assert.throws(()=>f.session.researchSettle({...calculator,reservationId:next.reservationId,result:{known:false}}),/different outcome/);
    const uncertainArgs={...calculator,requestSha256:otherSha256},uncertain=f.session.researchReserve(uncertainArgs);assert.equal(uncertain.status,'reserved');assert.equal(f.session.researchReserve(uncertainArgs).status,'pending');
    assert.equal(f.session.researchReserve({...calculator,requestSha256:thirdSha256}).status,'budget-used');
  }finally{f.close();}
});

test('rqid reissues and fresh switch requests keep the spent native board-turn quota; new native turns get a new quota',async()=>{
  const f=await createOwnedSimulationFixture();try{
    const first=binding(f);f.session.researchReserve(first);
    const original=structuredClone(f.client.rooms.get(room).request),sameTurn=f.client.rooms.get(room).battle.turn;
    f.client.receive(`>${room}\n|request|${JSON.stringify({...original,rqid:original.rqid+1})}`);
    const reissued=binding(f);assert.notEqual(reissued.source.rqid,first.source.rqid);
    assert.equal(f.client.rooms.get(room).battle.turn,sameTurn);assert.equal(f.session.researchStatus(reissued).budget.simulationsUsed,1);
    assert.equal(f.session.researchReserve(reissued).status,'budget-used');
    f.client.receive(`>${room}\n|request|${JSON.stringify({...original,rqid:original.rqid+2,forceSwitch:[true,false]})}`);
    const replacement={...first,source:fromAction(f,'switch')};
    assert.throws(()=>f.session.simulationContext({source:replacement.source}),/stale/,'simulation endpoint still requires its ordinary move source');
    assert.equal(f.session.researchStatus(replacement).budget.simulationsUsed,1);
    assert.equal(f.session.researchReserve({...replacement,category:'calculator'}).status,'reserved','fresh replacement permits source-bound numeric admission');
    assert.equal(f.session.researchReserve(replacement).status,'budget-used');
  }finally{f.close();}
  const next=await createOwnedSimulationFixture();try{
    const before=binding(next);next.session.researchReserve(before);
    const frozen=next.session.freezeSimulationContext(next.session.actions().find(a=>a.kind==='turn'));
    next.choose('move 4, move 4','move 4, move 4');
    assert.equal(next.session.researchStatus(binding(next)).budget.simulationsUsed,0);
    assert.equal(next.session.researchReserve(binding(next)).status,'reserved');
    assert.equal(next.session.researchStatus({...before,analysis:'frozen',freezeId:frozen.freezeId}).budget.simulationsUsed,1);
  }finally{next.close();}
});

test('cached access revalidates freshness and changed semantic facts cannot settle or reuse old work',async()=>{
  const f=await createOwnedSimulationFixture();try{
    const args=binding(f),first=f.session.researchReserve(args);f.session.researchSettle({...args,reservationId:first.reservationId,result});
    assert.throws(()=>f.session.researchReserve({...args,source:{...args.source,token:'0'.repeat(64)}}),/stale/);
    f.client.receive(`>${room}\n|-damage|p1a: Politoed|100/197`);
    assert.throws(()=>f.session.researchReserve(args),/material events/,'an incomplete fresh source cannot read a cached result');
    const request=structuredClone(f.client.rooms.get(room).request);request.rqid++;request.side.pokemon[0].condition='100/197';
    f.client.receive(`>${room}\n|request|${JSON.stringify(request)}`);const changed=binding(f);
    assert.equal(f.session.researchReserve(changed).status,'budget-used','same input with changed facts cannot replay cached material');
    assert.throws(()=>f.session.researchSettle({...changed,reservationId:first.reservationId,result}),/differs/);
  }finally{f.close();}
});

test('bridge execute reservations cannot race into two trajectories and status does not allocate turn markers',async()=>{
  const f=await createOwnedSimulationFixture();try{
    const args=binding(f);assert.equal(f.session.researchStatus(args).budget.simulationsUsed,0);assert.equal(f.session.researchBudgets.size,0);
    const [a,b]=await Promise.all([f.session.execute({id:'reserve-one',op:'research-reserve',...args}),f.session.execute({id:'reserve-two',op:'research-reserve',...args})]);
    assert.equal(a.ok,true);assert.equal(b.ok,true);assert.equal(a.result.status,'reserved');assert.equal(b.result.status,'pending');assert.equal(a.result.reservationId,b.result.reservationId);
    assert(f.session.capabilities().operations.includes('research-status'));assert.equal(f.session.capabilities().features.nativeResearchBudget,true);
    for(const dependency of ['planning/research-budget.mjs','simulation/choice-presentation.mjs'])assert.equal(f.session.capabilities().modules[dependency],createHash('sha256').update(await readFile(new URL('../'+dependency,import.meta.url))).digest('hex'),'loaded manifest pins '+dependency);
  }finally{f.close();}
});

test('bounded storage fails closed without evicting spent markers or completed results and disconnect clears the owned state',async()=>{
  const f=await createOwnedSimulationFixture();try{
    const args=binding(f);for(let i=0;i<512;i++)f.session.researchBudgets.set('synthetic-old-turn-'+i,{calculators:[],simulation:null});
    assert.equal(f.session.researchReserve(args).reason,'research-turn-storage-full');assert.equal(f.session.researchBudgets.size,512);
    f.session.clearResearchBudgets();for(let i=0;i<32;i++)f.session.researchCacheClaims.add('synthetic-completed-cache-'+i);
    assert.equal(f.session.researchReserve(args).reason,'simulation-result-storage-full');assert.equal(f.session.researchCacheClaims.size,32);
    f.session.clearResearchBudgets();for(let i=0;i<96;i++)f.session.researchResultClaims.add('synthetic-result-cache-'+i);
    assert.equal(f.session.researchReserve({...args,category:'calculator'}).reason,'research-result-storage-full');assert.equal(f.session.researchBudgets.size,0);
    f.session.clearResearchBudgets();f.session.researchReserve(args);f.client.close();
    assert.equal(f.session.researchBudgets.size,0);assert.equal(f.session.researchReservations.size,0);assert.equal(f.session.researchCacheClaims.size,0);assert.equal(f.session.researchResultClaims.size,0);
    assert.throws(()=>f.session.researchStatus(args),/connected/);
  }finally{f.close();}
});

test('frozen cache access still checks game lifetime and identity changes or explicit stop clear old reservations',async()=>{
  const f=await createOwnedSimulationFixture();try{
    const args=binding(f),ticket=f.session.researchReserve(args);f.session.researchSettle({...args,reservationId:ticket.reservationId,result});
    const frozen=f.session.freezeSimulationContext(f.session.actions().find(a=>a.kind==='turn'));
    f.client.receive(`>${room}\n|win|Owner`);
    assert.throws(()=>f.session.researchReserve({...args,analysis:'frozen',freezeId:frozen.freezeId}),/ended/);
    f.client.expectedTeamHash='9'.repeat(64);assert.throws(()=>f.session.researchStatus(args),/differs/);
    assert.equal(f.session.researchReservations.size,0);assert.equal(f.session.researchCacheClaims.size,0);
  }finally{f.close();}
  const stopped=await createOwnedSimulationFixture();try{
    stopped.session.researchReserve(binding(stopped));
    const reply=await stopped.session.execute({id:'stop-research-fixture',op:'stop',confirmed:true});assert.equal(reply.ok,true);
    assert.equal(stopped.session.researchBudgets.size,0);assert.equal(stopped.session.researchReservations.size,0);
  }finally{stopped.close();}
});

test('only official ended children release completed payload claims while spent markers and pending uncertainty remain',async()=>{
  const f=await createOwnedSimulationFixture();try{
    const sim=binding(f),simTicket=f.session.researchReserve(sim);f.session.researchSettle({...sim,reservationId:simTicket.reservationId,result});
    const calc=binding(f,'calculator'),calcTicket=f.session.researchReserve(calc);f.session.researchSettle({...calc,reservationId:calcTicket.reservationId,result:{known:true}});
    const pending=f.session.researchReserve({...calc,requestSha256:otherSha256});assert.equal(pending.status,'reserved');
    assert.equal(f.session.researchResultClaims.size,3);f.session.releaseEndedResearchResults();assert.equal(f.session.researchResultClaims.size,3,'an active child keeps every claim');
    const state=f.client.rooms.get(room);state.ended=true;f.session.releaseEndedResearchResults();assert.equal(f.session.researchResultClaims.size,3,'an unconfirmed terminal state cannot evict results');state.ended=false;
    f.client.receive(`>${room}\n|win|Owner`);
    assert.equal(f.session.researchResultClaims.size,1);assert.equal(f.session.researchCacheClaims.size,0);
    assert.equal(f.session.researchBudgets.size,1);assert.equal(f.session.researchReservations.size,3);
    for(const ticket of [simTicket,calcTicket]){const row=f.session.researchReservations.get(ticket.reservationId);assert.equal(row.status,'completed');assert.equal(row.resultText,undefined);assert.equal(row.resultReleased,true);assert(row.resultSha256);}
    assert.equal(f.session.researchReservations.get(pending.reservationId).status,'pending');assert(f.session.researchResultClaims.has(pending.reservationId));
  }finally{f.close();}
});

test('private MCP endpoints flatten exact researchContext and perform no backend or control action themselves',async()=>{
  const handlers=new Map(),calls=[];registerBattleTools({registerTool:(name,options,handler)=>handlers.set(name,{options,handler})},{workspace:resolve('.'),call:async(path,command)=>{calls.push(command);return{ok:true,result:{status:'reserved',choiceAuthority:false}};}});
  const source={sessionId:'synthetic-session',teamId:'a'.repeat(64),room,rqid:7,token:'b'.repeat(64)},researchContext={source,analysis:'current'};
  for(const[name,args,op]of [['battle_research_reserve',{researchContext,category:'calculator',requestSha256},'research-reserve'],['battle_research_status',{researchContext},'research-status'],['battle_research_settle',{researchContext,reservationId:'00000000-0000-4000-8000-000000000001',category:'calculator',requestSha256,failed:true},'research-settle']]){
    const tool=handlers.get(name);assert(tool);assert.equal(tool.options.inputSchema.safeParse(args).success,true);const reply=await tool.handler(args);assert.equal(reply.isError,false);
    const call=calls.at(-1);assert.equal(call.op,op);assert.deepEqual(call.source,source);assert.equal(call.analysis,'current');assert.equal(call.researchContext,undefined);assert.equal(call.confirmed,undefined);assert.equal(call.controllerLease,undefined);
  }
  assert.equal(calls.length,3);assert.equal(handlers.get('battle_research_reserve').options.inputSchema.safeParse({source,category:'calculator',requestSha256}).success,false);
  assert.equal(handlers.get('battle_research_status').options.annotations.readOnlyHint,true);
  assert.equal(handlers.get('battle_research_status').options.annotations.openWorldHint,false);
});

test('only research-settle may cross the ordinary local request cap and its result remains bounded',async t=>{
  const cache=resolve('cache'),directory=await mkdtemp(join(cache,'research-budget-bridge-')),descriptorPath=join(directory,'session.json'),commands=[];
  const session={id:'synthetic-research-bridge',stopped:false,execute:async command=>{commands.push(command);return{ok:true,result:{accepted:true}};}};
  const server=await serveLocalSession(session,{descriptorPath});
  t.after(async()=>{await server.close();assert.equal(resolve(dirname(directory)),cache);await rm(directory,{recursive:true,force:true});});
  const command={id:'bounded-settlement',op:'research-settle',result:{text:'🌊'.repeat(40000)}};
  assert.equal((await callLocalSession(descriptorPath,command)).ok,true);assert.equal(commands.length,1);assert.deepEqual(commands[0].result,command.result);
  await assert.rejects(callLocalSession(descriptorPath,{...command,id:'ordinary-stays-small',op:'choose'}),/command bound/);assert.equal(commands.length,1);
  const descriptor=JSON.parse(await readFile(descriptorPath,'utf8'));
  const rejected=await new Promise((resolveReply,reject)=>{
    const socket=net.createConnection(descriptor.address);let text='';
    socket.on('error',reject);socket.setTimeout(2000,()=>{socket.destroy();reject(Error('Synthetic local bound check timed out'));});
    socket.on('connect',()=>socket.write(JSON.stringify({capability:descriptor.capability,command:{...command,id:'direct-ordinary-bound',op:'choose'}})+'\n'));
    socket.on('data',chunk=>{text+=chunk.toString();if(text.includes('\n')){socket.destroy();resolveReply(JSON.parse(text));}});
  });
  assert.equal(rejected.ok,false);assert.match(rejected.error,/command bound/);assert.equal(commands.length,1,'server independently retains the ordinary request limit');
  await assert.rejects(callLocalSession(descriptorPath,{...command,id:'oversized-settlement',result:{text:'x'.repeat(1024*1024)}}),/command bound/);assert.equal(commands.length,1);
});
