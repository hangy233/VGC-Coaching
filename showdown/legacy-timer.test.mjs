import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname, basename} from 'node:path';
import {enableLegacyBattleTimer} from './legacy-timer.mjs';

const {Teams, TeamValidator} = createRequire(import.meta.url)('pokemon-showdown');
const TEAM = `Golisopod @ Golisopite
Ability: Emergency Exit
Level: 50
EVs: 32 HP / 32 Atk / 2 SpD
Brave Nature
- Leech Life

Hydreigon @ Life Orb
Ability: Levitate
Level: 50
EVs: 2 HP / 32 SpA / 32 Spe
Timid Nature
- Dark Pulse

Rillaboom @ Miracle Seed
Ability: Grassy Surge
Level: 50
EVs: 32 HP / 32 Atk / 2 SpD
Adamant Nature
- Wood Hammer

Politoed @ Leftovers
Ability: Drizzle
Level: 50
EVs: 32 HP / 32 SpA / 2 Def
Modest Nature
- Weather Ball

Farigiraf @ Grassy Seed
Ability: Armor Tail
Level: 50
EVs: 32 HP / 16 Def / 18 SpD
Sassy Nature
- Psychic
- Helping Hand
- Trick Room
- Protect

Sylveon @ Fairy Feather
Ability: Pixilate
Level: 50
EVs: 32 HP / 32 SpA / 2 Def
Quiet Nature
- Hyper Voice
`;
const directory = await mkdtemp(join(tmpdir(), 'vgc-legacy-timer-'));
const teamFile = join(directory, 'team.txt');
await writeFile(teamFile, TEAM);
test.after(async () => {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.match(basename(directory), /^vgc-legacy-timer-/);
  await rm(directory, {recursive: true, force: true});
});
const team = Teams.import(TEAM);
assert.equal(new TeamValidator('gen9championsvgc2026regmc').validateTeam(team), null);
const teamId = createHash('sha256').update(Teams.pack(team)).digest('hex');
const parent = 'game-bestof3-gen9championsvgc2026regmcbo3-123456';
const room = 'battle-gen9championsvgc2026regmcbo3-123457';
const lease = 'a'.repeat(64);

function fixture(mode = '') {
  let brokerCalls = 0, client;
  const wires = [], probes = [];
  const status = {sessionId:randomUUID(),connected:true,authenticated:true,stopped:false,username:'TestPlayer',teamSha256:teamId,
    capabilities:{buildRevision:'becaa885d5d272146a72a847fa6babb835d10442f608499f034411ce6ead615b',features:{controllerLease:true},operations:['choose']},
    controller:{owner:'one-operator',generation:2},search:{games:{[parent]:'M-C BO3'}},actions:[],
    rooms:[{id:parent,ended:false,children:[room]},{id:room,ended:false,state:{request:{teamPreview:true,rqid:2}},choice:{status:'sent',rqid:2,revision:1,actions:[{type:'team',order:[2,5,4,6]}]}}]};
  class Auxiliary extends EventEmitter {
    constructor(options) { super(); this.options=options;this.expectedTeamHash=options.expectedTeamHash;this.epoch=1;this.rooms=new Map();this.connected=false;this.authenticated=false;this.closed=false;this.searchState=null; }
    async connect() { this.connected=true;this.challenge='1|synthetic'; }
    async authenticate(username) {
      wires.push('authentication');
      await this.options.broker.login({username});
      if(this.closed)throw new Error('Auxiliary closed during login');
      this.authenticated=true;this.searchState={games:{[parent]:'M-C BO3'}};
    }
    joinRoom(id) {
      wires.push(`join:${id}`);
      if(id===parent)this.rooms.set(id,{children:mode==='unlinked'?[]:[room]});
      else {
        this.rooms.set(id,{epoch:1,ended:false,request:{teamPreview:true,rqid:mode==='wrong-rqid'?3:2,side:{name:mode==='wrong-user'?'OtherPlayer':'TestPlayer',pokemon:team.map(set=>({details:`${set.species}, L50`,item:mode==='wrong-team'?'wrong':set.item,baseAbility:set.ability,moves:set.moves}))}},
          confirmedChoice:mode==='missing-choice'?'':mode==='wrong-choice'?'team 1234':'team 2546'});
        if(mode==='takeover')status.controller.generation++;
      }
    }
    authorize(action, args) { assert.equal(action,'set-timer');assert.deepEqual(args,{room,confirmed:true}); }
    setTimer(id, args) {
      assert.equal(id,room);assert.deepEqual(args,{enabled:true});wires.push('timer-on');
      if(mode==='uncertain')throw new Error('synthetic write failure');
      if(mode!=='no-observation')queueMicrotask(()=>{this.observation={afterRequest:true,type:mode==='off'?'inactiveoff':'inactive',at:1,text:'synthetic timer activity'};});
      return {status:'sent-not-acknowledged'};
    }
    timerStatus() { return {serverObservation:this.observation}; }
    close() { if(this.closed)return;this.closed=true;this.connected=false;this.emit('disconnected'); }
  }
  const primaryCall = async (_path, command) => {
    if(command.op==='status')return {ok:true,result:structuredClone(status)};
    assert.equal(command.op,'set-timer');probes.push(command);
    if(command.controllerLease!==lease)return {ok:false,error:'Controller lease invalid'};
    if(mode==='probe-success')return {ok:true,result:{status:'sent-not-acknowledged'}};
    if(mode==='probe-uncertain')throw new Error('synthetic primary uncertainty');
    return {ok:false,error:'Unsupported operation'};
  };
  const options={confirmed:true,savedLogin:true,commandId:`timer-${randomUUID()}`,descriptorPath:'synthetic-only',controllerLease:lease,
    sessionId:status.sessionId,generation:2,username:'TestPlayer',parentId:parent,roomId:room,teamFile,input:{isTTY:true},output:{isTTY:true,write(){}},timeoutMs:180,pollMs:10,primaryCall,
    clientFactory:args=>(client=new Auxiliary(args)),brokerFactory:()=>({login:async()=>{brokerCalls++;if(mode==='fresh-action'){status.actions=[{room}];await new Promise(resolve=>setTimeout(resolve,35));}}})};
  return {options,status,wires,probes,get brokerCalls(){return brokerCalls;},get client(){return client;}};
}

test('legacy adapter enables only after server-restored preview; closes only auxiliary and preserves primary', async () => {
  const f=fixture(), before=structuredClone(f.status);
  const result=await enableLegacyBattleTimer(f.options);
  assert.equal(result.status,'timer-activity-observed');assert.equal(result.serverRestoredPreviewVerified,true);
  assert.equal(result.sentStatus,'sent-not-acknowledged');assert.equal(f.brokerCalls,1);assert.equal(f.client.closed,true);
  assert.deepEqual(f.status,before);assert.deepEqual(f.wires,['authentication',`join:${parent}`,`join:${room}`,'timer-on']);
  assert.equal(f.probes.length,2);
  assert.deepEqual(await enableLegacyBattleTimer(f.options),result);
  assert.equal(f.brokerCalls,1);assert.equal(f.wires.filter(line=>line==='timer-on').length,1);
});

test('off observation is retained without claiming enabled confirmation', async () => {
  const f=fixture('off');const result=await enableLegacyBattleTimer(f.options);
  assert.equal(result.status,'timer-off-observed');assert.equal(result.serverObservation.type,'inactiveoff');
});

for(const mode of ['missing-choice','wrong-choice','wrong-rqid','wrong-user','wrong-team','unlinked','takeover','fresh-action']) {
  test(`legacy adapter refuses ${mode} without a timer write`, async () => {
    const f=fixture(mode);await assert.rejects(enableLegacyBattleTimer(f.options));
    assert.equal(f.wires.includes('timer-on'),false);assert.equal(f.client.closed,true);
  });
}

for(const mode of ['probe-success','probe-uncertain']) {
  test(`legacy adapter never authenticates after ${mode}`, async () => {
    const f=fixture(mode);await assert.rejects(enableLegacyBattleTimer(f.options));
    assert.equal(f.brokerCalls,0);assert.deepEqual(f.wires,[]);
  });
}

test('unknown build, stale lease, changed team, active request, missing confirmation or nonTTY fail before auth', async () => {
  const changes=[f=>f.status.capabilities.buildRevision='unknown',f=>f.options.controllerLease='b'.repeat(64),f=>f.status.teamSha256='b'.repeat(64),
    f=>f.status.actions=[{room}],f=>f.options.confirmed=false,f=>f.options.input.isTTY=false];
  for(const change of changes){const f=fixture();change(f);await assert.rejects(enableLegacyBattleTimer(f.options));assert.equal(f.brokerCalls,0);assert.deepEqual(f.wires,[]);}
});

for(const mode of ['uncertain','no-observation']) {
  test(`legacy adapter reserves ${mode} and does not retry`, async () => {
    const f=fixture(mode);await assert.rejects(enableLegacyBattleTimer(f.options));
    await assert.rejects(enableLegacyBattleTimer(f.options));
    assert.equal(f.brokerCalls,1);assert.equal(f.wires.filter(line=>line==='timer-on').length,1);assert.equal(f.client.closed,true);
  });
}

test('cached timer result still requires unchanged current lease and generation', async () => {
  const f=fixture();await enableLegacyBattleTimer(f.options);f.status.controller.generation++;
  await assert.rejects(enableLegacyBattleTimer(f.options),/Primary controller changed/);
  assert.equal(f.wires.filter(line=>line==='timer-on').length,1);
});

test('overall deadline also bounds initial uncooperative IPC before authentication', async () => {
  const f=fixture();f.options.primaryCall=()=>new Promise(()=>{});f.options.timeoutMs=100;
  const started=performance.now();await assert.rejects(enableLegacyBattleTimer(f.options),/budget expired/);
  assert.ok(performance.now()-started<1000);assert.equal(f.brokerCalls,0);
});

test('overall deadline closes auxiliary during uncooperative authentication', async () => {
  const f=fixture();let brokerSignal;
  f.options.brokerFactory=()=>({login:context=>{brokerSignal=context.signal;return new Promise(()=>{});}});f.options.timeoutMs=100;
  const started=performance.now();await assert.rejects(enableLegacyBattleTimer(f.options),/budget expired/);
  assert.ok(performance.now()-started<1000);assert.equal(f.client.closed,true);assert.equal(f.wires.includes('timer-on'),false);
  assert.equal(brokerSignal.aborted,true);
});

test('new primary readiness on another room and mismatched primary rqid refuse authentication', async () => {
  for(const mutate of [f=>f.status.actions=[{room:parent,kind:'ready'}],f=>f.status.rooms[1].state.request.rqid=3]){
    const f=fixture();mutate(f);await assert.rejects(enableLegacyBattleTimer(f.options));assert.equal(f.brokerCalls,0);
  }
});

test('cached-result verification also has a bounded IPC deadline without another login or timer', async () => {
  const f=fixture();let unavailable=false;
  const original=f.options.primaryCall;
  f.options.primaryCall=(...args)=>unavailable?new Promise(()=>{}):original(...args);
  f.options.timeoutMs=100;
  await enableLegacyBattleTimer(f.options);unavailable=true;
  const started=performance.now();
  await assert.rejects(enableLegacyBattleTimer(f.options),/budget expired/);
  assert.ok(performance.now()-started<1000);
  assert.equal(f.brokerCalls,1);assert.equal(f.wires.filter(line=>line==='timer-on').length,1);
});

test('a concurrent duplicate includes waiting for the first result in its overall deadline', async () => {
  const f=fixture();f.options.timeoutMs=500;
  f.options.brokerFactory=()=>({login:()=>new Promise(resolve=>setTimeout(resolve,300))});
  const original=f.options.primaryCall;
  f.options.primaryCall=(...args)=>f.client?.closed?new Promise(()=>{}):original(...args);
  const started=performance.now();
  const first=enableLegacyBattleTimer(f.options);
  const duplicate=enableLegacyBattleTimer(f.options);
  await first;
  await assert.rejects(duplicate,/budget expired/);
  assert.ok(performance.now()-started<700);
  assert.equal(f.wires.filter(line=>line==='authentication').length,1);
  assert.equal(f.wires.filter(line=>line==='timer-on').length,1);
});
