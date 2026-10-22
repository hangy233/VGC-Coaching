import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {ShowdownClient} from './client.mjs';
import {AgentSession} from './agent-session.mjs';
import {registerBattleTools} from './mcp-tools.mjs';
import {createOperator} from './operator-client.mjs';
import {readResponse} from './operator-response.mjs';

// The standard MCP SDK runs at both ends. Its tool schemas, content blocks and
// isError metadata are real; the Showdown socket and server events are fixtures.
// No production descriptor, login broker, network transport or search is used.
const cache=fileURLToPath(new URL('../cache/',import.meta.url));
const parent='game-bestof3-gen9championsvgc2026regmcbo3-9900',room='battle-gen9championsvgc2026regmcbo3-9901';
const pair=[{type:'move',slot:1},{type:'move',slot:1}];
const round=value=>Math.round(value*100)/100;

async function fixture(){
  await mkdir(cache,{recursive:true});
  const directory=await mkdtemp(join(cache,'operator-sdk-test-')),file=join(directory,'response.json');
  const packed='Species|item|ability|move',wire=[],requests=[],sdkCalls=[];
  const live=new ShowdownClient({expectedTeamHash:createHash('sha256').update(packed).digest('hex')});
  live.connected=true;live.authenticated=true;live.epoch=1;
  live.searchState={searching:[],games:{[parent]:'Fixture vs Opponent'}};
  live.ws={send:line=>wire.push(line),close:()=>{live.connected=false;live.authenticated=false;live.emit('disconnected');}};
  const session=new AgentSession(live,{username:'Fixture',packed,autoReady:false,
    controlTimers:{setTimer:()=>({unref(){}}),clearTimer:()=>{}}});
  session.supervisor.configure({enabled:true,forfeitIfStuck:false});
  // Seed only this in-memory fixture's existing authorized ownership. Rehearsal
  // setup does not invoke battle_start, authenticate, or grant an allowance.
  session.ownedParents.add(parent);session.ownedRooms.add(parent);session.ownedRooms.add(room);
  session.roomParents.set(parent,parent);session.roomParents.set(room,parent);
  live.receive(`>${parent}\n|uhtml|game|<a href="/${room}">Game 1</a>`);
  const request=(rqid,{replacement=false,advanced=false}={})=>{
    const pokemon=[
      {ident:'p2: A',details:'Politoed, L50',active:!advanced,condition:replacement||advanced?'0 fnt':'100/100'},
      {ident:'p2: B',details:'Kommo-o, L50',active:true,condition:'100/100'},
      {ident:'p2: C',details:'Rillaboom, L50',active:advanced,condition:'100/100'},
      {ident:'p2: D',details:'Hydreigon, L50',active:false,condition:'100/100'},
    ];
    const q={rqid,side:{id:'p2',name:'Fixture',pokemon},...(replacement?{forceSwitch:[true,false]}:
      {active:[{moves:[{move:'Protect',pp:10,target:'self'}]},{moves:[{move:'Protect',pp:10,target:'self'}]}]})};
    live.receive(`>${room}\n|request|${JSON.stringify(q)}`);
  };
  request(9);
  const server=new McpServer({name:'offline-operator-rehearsal',version:'1'});
  registerBattleTools(server,{workspace:directory,call:async(_descriptor,command)=>{requests.push(command);return session.execute(command);}});
  const client=new Client({name:'offline-operator-rehearsal-client',version:'1'}),[clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);await client.connect(clientTransport);
  const callTool=client.callTool.bind(client);
  client.callTool=async(...args)=>{
    const began=performance.now(),entry={name:args[0].name,args:args[0].arguments};sdkCalls.push(entry);
    try{const value=await callTool(...args);entry.raw=value;return value;}finally{entry.elapsedMs=performance.now()-began;}
  };
  const operator=createOperator({client,responseFile:file,maxSearches:0,budgetMs:2000,mutationTimeoutMs:500});
  const arm=await operator.dispatch({id:'arm',op:'arm',confirmed:true,expectedSessionId:session.id,expectedTeamId:live.expectedTeamHash,expectedAccount:'Fixture'});
  assert.equal(arm.result.armed,true);
  const claim=await operator.dispatch({id:'claim',op:'call',name:'battle_control_claim',args:{confirmed:true,commandId:'fixture-claim',controllerId:'offline-fixture'}});
  assert.equal(claim.result.ok,true);
  return {operator,client,server,live,session,wire,requests,sdkCalls,request,file,directory,async close(){
    await client.close();await server.close();session.dispose();
    assert.equal(dirname(resolve(directory)),resolve(cache));assert.match(basename(directory),/^operator-sdk-test-/);
    await rm(directory,{recursive:true,force:true});
  }};
}

test('offline real SDK rehearsal returns rq11 from stale rq9 and accepts only a new authored replacement before rq13',async t=>{
  const began=performance.now(),f=await fixture();
  try{
    const listed=await f.client.listTools();assert(listed.tools.some(value=>value.name==='battle_wait'));
    const initial=await f.operator.dispatch({id:'rq9',op:'turn'}),old=initial.result.result.actions[0];
    assert.equal(old.rqid,9);
    f.request(11,{replacement:true});
    const before=f.sdkCalls.length,rejectionBegan=performance.now();
    const stale=await f.operator.dispatch({id:'stale9',op:'play-next',room,rqid:9,token:old.token,actions:pair});
    const rejectionMs=performance.now()-rejectionBegan,recovery=stale.result.recovery;
    assert.equal(recovery.retry,false);assert.equal(recovery.rebind,false);
    const current=recovery.state.actions[0];assert.equal(current.rqid,11);assert.equal(current.kind,'switch');
    assert.notEqual(current.token,old.token);assert(Array.isArray(recovery.state.boards));
    assert.equal(recovery.state.rooms.find(value=>value.id===room).state,undefined);
    assert.equal(f.sdkCalls.at(-1).raw.isError,true);
    assert.deepEqual(f.sdkCalls.slice(before).map(value=>value.name),['battle_stage_fallback']);
    assert.equal(f.wire.filter(value=>value.includes('/choose ')).length,0);
    const receipt=await readResponse({file:f.file,id:'stale9'});
    assert.equal(receipt.payload.result.recovery.state.actions[0].rqid,11);
    for(const key of ['inputReceivedAt','mcpDispatchedAt','mcpSettledAt','boardCapturedAt','preparedAt','readerMatchedAt'])assert(Number.isSafeInteger(receipt.timing[key]),key);
    assert.equal(receipt.timing.boardCapturedAt,recovery.state.observedAt);
    assert.equal(receipt.timing.modelDeliveredAt,undefined);
    assert(!JSON.stringify(receipt).includes(f.session.controller.current.token));
    const staleCallCount=f.sdkCalls.length;
    const oldAgain=await f.operator.dispatch({id:'oldagain',op:'play-next',room,rqid:9,token:old.token,actions:pair});
    assert.match(oldAgain.error,/do not match/);assert.equal(f.sdkCalls.length,staleCallCount);
    const reserve=current.legalActions.replacements.find(value=>value.slot===3);assert(reserve?.pokemonId);
    const authored=[{type:'switch',pokemonId:reserve.pokemonId},{type:'pass'}];
    const write=f.live.ws.send;
    f.live.ws.send=line=>{write(line);if(line.includes('/choose '))queueMicrotask(()=>f.request(13,{advanced:true}));};
    const nextBegan=performance.now(),next=await f.operator.dispatch({id:'replace11',op:'play-next',room,rqid:11,token:current.token,actions:authored});
    const replacementMs=performance.now()-nextBegan;
    assert.equal(next.result.next.reason,'fresh-action');assert.equal(next.result.next.state.result.actions[0].rqid,13);
    const chosen=f.sdkCalls.filter(value=>value.name==='battle_choose');assert.equal(chosen.length,1);
    assert.deepEqual(chosen[0].args.actions,authored);assert.equal(chosen[0].args.token,current.token);
    assert.deepEqual(f.wire.filter(value=>value.includes('/choose ')),[`${room}|/choose switch 3, pass|11`]);
    assert.equal(f.session.searchesSent,0);assert(!f.wire.some(value=>/\/search|\/trn|\/forfeit|\/join/.test(value)));
    const finalReceipt=await readResponse({file:f.file,id:'replace11'});
    assert.equal(finalReceipt.payload.result.next.state.result.actions[0].rqid,13);
    assert(!JSON.stringify(finalReceipt).includes(f.session.controller.current.token));
    t.diagnostic(JSON.stringify({kind:'offline-sdk-rehearsal-latency',staleRecoveryThroughFileMs:round(rejectionMs),authoredReplacementThroughFileMs:round(replacementMs),sdkCalls:f.sdkCalls.length,maxSdkRoundTripMs:round(Math.max(...f.sdkCalls.map(value=>value.elapsedMs))),totalFixtureMs:round(performance.now()-began),limitation:'In-process SDK and local fixture filesystem only; no model delivery, deliberation, network or live battle timing is measured.'}));
  }finally{await f.close();}
});

test('offline real SDK uncertain choose preserves its reservation, response timing and no-retry result',async t=>{
  const f=await fixture();
  try{
    const first=await f.operator.dispatch({id:'rq9',op:'turn'}),action=first.result.result.actions[0],write=f.live.ws.send;
    f.live.ws.send=line=>{write(line);if(line.includes('/choose '))throw Error('Synthetic offline socket write uncertainty');};
    const began=performance.now(),result=await f.operator.dispatch({id:'uncertain9',op:'play-next',room,rqid:9,token:action.token,actions:pair});
    const elapsedMs=performance.now()-began;
    assert.equal(result.result.recovery.outcome,'send-uncertain');assert.equal(result.result.recovery.retry,false);
    assert.equal(result.result.recovery.attempted.reservation,true);assert.equal(result.result.recovery.state.actions.length,0);
    const choose=f.sdkCalls.find(value=>value.name==='battle_choose');assert.equal(choose.raw.isError,true);
    assert.equal(f.session.actions({includePending:true})[0].submissionStatus,'uncertain');
    const before=f.sdkCalls.length;
    const retry=await f.operator.dispatch({id:'noretry9',op:'play-next',room,rqid:9,token:action.token,actions:pair});
    assert.match(retry.error,/do not match|reservation/);assert.equal(f.sdkCalls.length,before);
    assert.equal(f.wire.filter(value=>value.includes('/choose ')).length,1);
    assert(!f.wire.some(value=>/\/search|\/trn|\/forfeit/.test(value)));
    const receipt=await readResponse({file:f.file,id:'uncertain9'});
    assert.equal(receipt.payload.result.recovery.outcome,'send-uncertain');assert(Number.isSafeInteger(receipt.timing.readerMatchedAt));
    assert.equal(receipt.timing.modelDeliveredAt,undefined);
    assert(!(await readFile(f.file,'utf8')).includes(f.session.controller.current.token));
    t.diagnostic(JSON.stringify({kind:'offline-sdk-uncertain-rehearsal-latency',uncertainResultThroughFileMs:round(elapsedMs),chooseSdkRoundTripMs:round(choose.elapsedMs),limitation:'Synthetic throwing fixture socket only; it does not prove live acceptance, execution or model response timing.'}));
  }finally{await f.close();}
});

test('offline real SDK unchanged wait leaves response headroom within its original transport budget',async t=>{
  // Pure read fixture: no Showdown client, authentication, claim or socket.
  // Returning the unchanged snapshot includes real async response overhead
  // after the requested server wait, exposing equal server/SDK timeout races.
  const budgetMs=300,replyDelayMs=20,requests=[],sdkCalls=[];
  const state={sessionId:'offline-wait-headroom',connected:true,authenticated:true,revision:7,
    actions:[],boards:[],rooms:[],search:{searching:['fixture'],games:null}};
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const server=new McpServer({name:'offline-wait-headroom-server',version:'1'});
  registerBattleTools(server,{workspace:cache,call:async(_descriptor,command)=>{
    requests.push(command);assert(['turn-status','wait'].includes(command.op));
    if(command.op==='wait'){await delay(command.timeoutMs);await delay(replyDelayMs);}
    return {ok:true,result:state};
  }});
  const client=new Client({name:'offline-wait-headroom-client',version:'1'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);await client.connect(clientTransport);
  const callTool=client.callTool.bind(client);
  client.callTool=async(...args)=>{
    sdkCalls.push({name:args[0].name,args:args[0].arguments,options:args[2]});return callTool(...args);
  };
  const operator=createOperator({client,responseFile:'unused-memory-publication',budgetMs,maxSearches:0,publish:async()=>{}});
  try{
    const began=performance.now(),result=await operator.dispatch({id:'unchanged-wait',op:'wait-next'});
    assert.equal(result.result.reason,'bounded-wait-ended');assert.equal(result.result.state.result.revision,7);
    assert(Array.isArray(result.result.state.result.boards));assert.equal(result.searchesAttempted,0);
    assert.deepEqual(requests.map(value=>value.op),['turn-status','wait']);
    assert.deepEqual(sdkCalls.map(value=>value.name),['battle_turn_status','battle_wait']);
    const wait=sdkCalls[1];assert.equal(wait.args.timeoutMs,wait.options.timeout-100);
    assert(wait.options.timeout<=budgetMs);assert(wait.options.timeout>100);assert.equal(wait.options.signal.aborted,false);
    t.diagnostic(JSON.stringify({kind:'offline-sdk-wait-headroom',budgetMs,replyDelayMs,
      serverWaitMs:wait.args.timeoutMs,sdkTimeoutMs:wait.options.timeout,elapsedMs:round(performance.now()-began),
      limitation:'In-memory SDK fixture only; no actual IPC, live battle or model latency is measured.'}));
  }finally{await client.close();await server.close();}
});
