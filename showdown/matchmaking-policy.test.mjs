import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ShowdownClient} from './client.mjs';
import {AgentSession} from './agent-session.mjs';
import {registerBattleTools} from './mcp-tools.mjs';

const USER='FixturePlayer',packed='Species|item|ability|move';
async function fixture({excludeBots=false}={}){
  const sent=[],client=new ShowdownClient({expectedTeamHash:createHash('sha256').update(packed).digest('hex')});
  client.connected=true;client.authenticated=true;client.epoch=1;client.expectedUser='fixtureplayer';
  client.formats='[Gen 9] Champions VGC 2026 Reg M-C (Bo3),e';
  client.ws={send:line=>sent.push(line),close:()=>{client.connected=false;client.authenticated=false;client.emit('disconnected');}};
  client.receive('|updatesearch|{"searching":[],"games":null}');
  const session=new AgentSession(client,{username:USER,packed,authorizedSets:3,autoReady:false,excludeBots});
  const claim=await session.execute({id:'claim',op:'control-claim',confirmed:true,controllerId:'fixture-controller'});
  assert.equal(claim.ok,true);const controllerLease=claim.result.controllerLease;
  const command=(id,op,extra={})=>session.execute({id,op,confirmed:true,controllerLease,...extra});
  assert.equal((await command('control-policy','set-control-policy',{enabled:true,forfeitIfStuck:false})).ok,true);
  const settings=(value,{name=USER,named=1,room=''}={})=>client.receive(`${room?`>${room}\n`:''}|updateuser|${name}|${named}|1|${typeof value==='string'?value:JSON.stringify(value)}`);
  return {client,session,sent,command,settings,controllerLease};
}

test('owned bot policy sends once, waits for server preference, then admits a normal search',async()=>{
  const f=await fixture();try{
    const pending=await f.command('exclude','set-matchmaking-policy',{excludeBots:true});
    assert.equal(pending.ok,true);assert.equal(pending.result.excludeBots,true);assert.equal(pending.result.confirmed,false);
    assert.equal(pending.result.serverAllowLadderBots,null);assert.equal(pending.result.requestStatus,'sent-not-acknowledged');
    assert.deepEqual(f.sent,['|/blockbots']);
    assert.equal((await f.command('blocked-start','start')).ok,false);assert.equal(f.session.searchesSent,0);
    assert.equal((await f.command('another-exclude','set-matchmaking-policy',{excludeBots:true})).ok,false);
    await f.command('exclude','set-matchmaking-policy',{excludeBots:true});assert.deepEqual(f.sent,['|/blockbots'],'same command returns its original pending receipt');
    const revision=f.session.revision;
    f.settings({allowLadderBots:false,unrelatedPrivatePreference:'not retained'});
    const policy=f.session.snapshot().matchmakingPolicy;
    assert.equal(policy.confirmed,true);assert.equal(policy.serverAllowLadderBots,false);assert(f.session.revision>revision);
    assert(!JSON.stringify(policy).includes('unrelatedPrivatePreference'));assert(!JSON.stringify(policy).includes('not retained'));
    assert.deepEqual(f.session.turnSnapshot().matchmakingPolicy,policy);
    const already=await f.command('already-confirmed','set-matchmaking-policy',{excludeBots:true});assert.equal(already.result.sent,false);
    const start=await f.command('normal-start','start');assert.equal(start.ok,true,start.error);
    assert.equal(f.sent.filter(line=>line.includes('/search ')).length,1);assert.equal(f.session.searchesSent,1);assert.equal(f.session.authorizedSets,3);
    assert.equal(f.sent.filter(line=>line.includes('/blockbots')).length,1);assert(!f.sent.some(line=>line.includes('/allowbots')));
    assert.equal(f.session.capabilities().features.ownedMatchmakingPolicy,true);assert(f.session.capabilities().operations.includes('set-matchmaking-policy'));
  }finally{f.session.dispose();}
});

for(const [name,invalidate]of [
  ['unknown setting',f=>f.settings({})],
  ['missing settings JSON',f=>f.settings('')],
  ['malformed settings JSON',f=>f.settings('{')],
  ['nonboolean setting',f=>f.settings({allowLadderBots:'false'})],
  ['array settings',f=>f.settings([{allowLadderBots:false}])],
  ['wrong account',f=>f.settings({allowLadderBots:false},{name:'OtherFixture'})],
  ['unnamed identity',f=>f.settings({allowLadderBots:false},{named:0})],
  ['room-scoped identity',f=>f.settings({allowLadderBots:false},{room:'lobby'})],
  ['connection epoch change',f=>{f.client.epoch++;}],
  ['disconnection',f=>f.client.close()],
  ['preference reenabled before search',f=>f.settings({allowLadderBots:true})],
])test(`required exclusion refuses search after ${name}`,async()=>{
  const f=await fixture({excludeBots:true});try{
    f.settings({allowLadderBots:false});assert.equal(f.session.snapshot().matchmakingPolicy.confirmed,true);
    invalidate(f);assert.equal(f.session.snapshot().matchmakingPolicy.confirmed,false);
    const result=await f.command('refused-start','start');assert.equal(result.ok,false);
    assert.equal(f.session.searchesSent,0);assert(!f.sent.some(line=>line.includes('/search ')||line.includes('/utm ')));
  }finally{f.session.dispose();}
});

test('uncertain preference write remains reserved and never creates a search or an automatic retry',async()=>{
  const f=await fixture();let writes=0;try{
    f.client.ws.send=()=>{writes++;throw Error('Synthetic uncertain transport');};
    assert.equal((await f.command('uncertain','set-matchmaking-policy',{excludeBots:true})).ok,false);
    assert.equal(f.session.snapshot().matchmakingPolicy.requestStatus,'uncertain');assert.equal(f.session.excludeBots,true);
    await f.command('uncertain','set-matchmaking-policy',{excludeBots:true});
    assert.equal((await f.command('different-retry','set-matchmaking-policy',{excludeBots:true})).ok,false);
    assert.equal((await f.command('no-search','start')).ok,false);assert.equal(writes,1);assert.equal(f.session.searchesSent,0);
  }finally{f.session.dispose();}
});

test('policy requires lease and idle state, cannot enable bots, and has no username heuristics',async()=>{
  const f=await fixture();try{
    assert.equal((await f.session.execute({id:'no-lease',op:'set-matchmaking-policy',confirmed:true,excludeBots:true})).ok,false);
    assert.equal((await f.command('enable-bots','set-matchmaking-policy',{excludeBots:false})).ok,false);
    f.client.searchState={searching:['gen9championsvgc2026regmcbo3'],games:null};
    assert.equal((await f.command('busy','set-matchmaking-policy',{excludeBots:true})).ok,false);assert.deepEqual(f.sent,[]);
    assert.equal(f.session.excludeBots,false);
  }finally{f.session.dispose();}
});

test('already confirmed exclusion is adopted without sending any preference command',async()=>{
  const f=await fixture();try{
    f.settings({allowLadderBots:false});
    const result=await f.command('already-blocked','set-matchmaking-policy',{excludeBots:true});
    assert.equal(result.result.confirmed,true);assert.equal(result.result.sent,false);assert.deepEqual(f.sent,[]);
  }finally{f.session.dispose();}
});

test('typed MCP exposes exclusion only and forwards one owned native operation',async()=>{
  const tools=new Map(),calls=[];
  registerBattleTools({registerTool:(name,config,handler)=>tools.set(name,{config,handler})},{workspace:'offline-fixture',call:async(_path,command)=>{calls.push(command);return {ok:true,result:{excludeBots:true,confirmed:false,serverAllowLadderBots:null}};}});
  const tool=tools.get('battle_set_matchmaking_policy'),args={confirmed:true,commandId:'exclude',controllerLease:'b'.repeat(64),excludeBots:true};
  assert(tool);assert.equal(tool.config.inputSchema.safeParse(args).success,true);
  assert.equal(tool.config.inputSchema.safeParse({...args,excludeBots:false}).success,false);
  assert.equal(tool.config.inputSchema.safeParse({...args,settings:{allowLadderBots:true}}).success,false);
  await tool.handler(args);assert.equal(calls.length,1);assert.equal(calls[0].op,'set-matchmaking-policy');assert.equal(calls[0].excludeBots,true);
});

test('a previous socket cannot confirm settings or close a newly authenticated connection',async()=>{
  const sockets=[];
  class Socket{
    constructor(){this.readyState=0;this.listeners=new Map();sockets.push(this);}
    addEventListener(name,fn){const rows=this.listeners.get(name)??[];rows.push(fn);this.listeners.set(name,rows);}
    emit(name,event={}){for(const fn of this.listeners.get(name)??[])fn(event);}
    close(){this.readyState=3;this.emit('close',{code:1000,wasClean:true});}
  }
  const c=new ShowdownClient({WebSocketImpl:Socket});
  const first=c.connect();sockets[0].readyState=1;sockets[0].emit('open');await first;
  c.expectedUser='fixtureplayer';sockets[0].emit('message',{data:'|updateuser|FixturePlayer|1|1|{"allowLadderBots":false}'});
  assert.equal(c.matchmakingStatus().confirmed,true);c.blockBotsAttempt={epoch:c.epoch,status:'sent-not-acknowledged'};
  sockets[0].readyState=3;
  const second=c.connect();sockets[1].readyState=1;sockets[1].emit('open');await second;
  assert.equal(c.matchmakingStatus().serverAllowLadderBots,null);assert.equal(c.blockBotsAttempt,null);
  c.expectedUser='fixtureplayer';sockets[1].emit('message',{data:'|updateuser|FixturePlayer|1|1|{"allowLadderBots":true}'});
  sockets[0].emit('message',{data:'|updateuser|FixturePlayer|1|1|{"allowLadderBots":false}'});
  sockets[0].emit('close',{code:1000,wasClean:true});
  assert.equal(c.connected,true);assert.equal(c.authenticated,true);assert.equal(c.matchmakingStatus().serverAllowLadderBots,true);assert.equal(c.matchmakingStatus().confirmed,false);
  c.close();assert.equal(c.matchmakingStatus().serverAllowLadderBots,null);
});
